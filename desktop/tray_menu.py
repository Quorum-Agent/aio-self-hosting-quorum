"""
Quorum Desktop Plugin — Tray Menu Implementation.

Provides the system tray menu items for the Quorum Hermes desktop plugin:
  - Start Quorum — launches the Quorum policy server process
  - Stop Quorum — gracefully terminates the Quorum policy server
  - Model Status — reports available models and their readiness
  - Open Config — opens the Quorum configuration panel
  - View Logs — opens the Quorum log viewer

All actions communicate with the Hermes desktop shell via the plugin's
REST namespace (/api/plugins/quorum/) and the plugin-scoped WebSocket
for live status updates.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tray command identifiers — stable ids the desktop shell uses to wire
# menu items to handlers.
# ---------------------------------------------------------------------------

class TrayAction(str, Enum):
    START_QUORUM = "quorum.start"
    STOP_QUORUM = "quorum.stop"
    MODEL_STATUS = "quorum.model_status"
    OPEN_CONFIG = "quorum.open_config"
    VIEW_LOGS = "quorum.view_logs"


# ---------------------------------------------------------------------------
# Quorum server lifecycle state
# ---------------------------------------------------------------------------

class QuorumState(str, Enum):
    STOPPED = "stopped"
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"
    ERROR = "error"


@dataclass
class QuorumProcess:
    """Track the managed Quorum server subprocess."""
    process: Optional[subprocess.Popen] = None
    state: QuorumState = QuorumState.STOPPED
    pid: Optional[int] = None
    started_at: Optional[float] = None
    last_error: Optional[str] = None


# ---------------------------------------------------------------------------
# Model status types (mirrors packages/core/src/types.ts)
# ---------------------------------------------------------------------------

@dataclass
class ModelStatus:
    """Status of a single model slot."""
    role: str                      # "general" | "coding" | "reasoning"
    configured_model: str          # The model name from config
    model_id: Optional[str] = None
    required: bool = True
    available: bool = False


@dataclass
class QuorumHealth:
    """Overall Quorum runtime health."""
    state: str                     # "ready" | "degraded" | "unavailable"
    quorum_running: bool
    endpoint_connected: bool
    models: List[ModelStatus] = field(default_factory=list)
    problem_summary: Optional[str] = None
    problem_detail: Optional[str] = None


# ---------------------------------------------------------------------------
# Tray menu item definitions — returned as a dict to the desktop shell.
# Each item maps to a command the shell dispatches back through the plugin
# REST namespace.
# ---------------------------------------------------------------------------

TRAY_MENU_ITEMS: List[Dict[str, Any]] = [
    {
        "id": TrayAction.START_QUORUM,
        "label": "Start Quorum",
        "icon": "play",
        "enabled_when": "quorum.stopped",
        "command": TrayAction.START_QUORUM,
    },
    {
        "id": TrayAction.STOP_QUORUM,
        "label": "Stop Quorum",
        "icon": "stop",
        "enabled_when": "quorum.running",
        "command": TrayAction.STOP_QUORUM,
    },
    {
        "id": "quorum.separator_1",
        "label": "-",
        "kind": "separator",
    },
    {
        "id": TrayAction.MODEL_STATUS,
        "label": "Model Status",
        "icon": "pulse",
        "command": TrayAction.MODEL_STATUS,
    },
    {
        "id": TrayAction.OPEN_CONFIG,
        "label": "Open Config",
        "icon": "gear",
        "command": TrayAction.OPEN_CONFIG,
    },
    {
        "id": TrayAction.VIEW_LOGS,
        "label": "View Logs",
        "icon": "output",
        "command": TrayAction.VIEW_LOGS,
    },
]


# ---------------------------------------------------------------------------
# Process management
# ---------------------------------------------------------------------------

def _find_quorum_dir() -> Path:
    """Resolve the quorum_core package directory relative to the repo root."""
    # In the worktree, packages/core contains the TS quorum_core source.
    # The Python quorum_core port (PKG-1) lands alongside it.
    this_dir = Path(__file__).resolve().parent
    repo_root = this_dir.parent
    quorum_dir = repo_root / "quorum_core"
    if quorum_dir.is_dir():
        return quorum_dir
    # Fallback: look in the packages directory for local dev
    packages_core = repo_root / "packages" / "core"
    if packages_core.is_dir():
        return packages_core
    return repo_root


def _find_quorum_executable() -> Optional[str]:
    """Locate the Quorum server entry point."""
    quorum_dir = _find_quorum_dir()
    # Prefer the Python quorum_core module
    main_py = quorum_dir / "main.py"
    if main_py.exists():
        return str(main_py)
    # Fallback to the TS server (for hybrid setups)
    server_ts = quorum_dir / "src" / "index.ts"
    if server_ts.exists():
        return str(server_ts)
    return None


# ---------------------------------------------------------------------------
# Tray menu handlers
# ---------------------------------------------------------------------------

_quorum_process = QuorumProcess()


def get_quorum_state() -> QuorumState:
    """Return the current state of the managed Quorum process."""
    return _quorum_process.state


def handle_start_quorum(
    config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Start the Quorum policy server as a managed subprocess.

    Reads configuration from the plugin config (Local/Cloud/Network model
    settings) and launches the appropriate server process. The process is
    monitored via health checks against /api/health.
    """
    if _quorum_process.state in (QuorumState.RUNNING, QuorumState.STARTING):
        return {
            "status": "already_running",
            "state": _quorum_process.state,
            "pid": _quorum_process.pid,
        }

    executable = _find_quorum_executable()
    if executable is None:
        _quorum_process.state = QuorumState.ERROR
        _quorum_process.last_error = "Quorum server entry point not found"
        logger.error("Cannot start Quorum: no executable found at %s", _find_quorum_dir())
        return {
            "status": "error",
            "state": QuorumState.ERROR,
            "error": _quorum_process.last_error,
        }

    _quorum_process.state = QuorumState.STARTING
    _quorum_process.last_error = None

    try:
        env = os.environ.copy()
        # Pass config as environment variables (mirrors config.ts)
        if config:
            _apply_config_env(config, env)

        if executable.endswith(".py"):
            proc = subprocess.Popen(
                [sys.executable, executable],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=str(_find_quorum_dir()),
            )
        elif executable.endswith(".ts"):
            proc = subprocess.Popen(
                ["npx", "tsx", executable],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=str(_find_quorum_dir()),
            )
        else:
            raise ValueError(f"Unknown executable type: {executable}")

        _quorum_process.process = proc
        _quorum_process.pid = proc.pid
        _quorum_process.started_at = time.time()

        # Brief wait to detect immediate crash
        time.sleep(0.5)
        if proc.poll() is not None:
            stderr_data = proc.stderr.read().decode("utf-8", errors="replace") if proc.stderr else ""
            _quorum_process.state = QuorumState.ERROR
            _quorum_process.last_error = f"Process exited immediately (code {proc.returncode}): {stderr_data[:500]}"
            logger.error("Quorum start failed: %s", _quorum_process.last_error)
            return {
                "status": "error",
                "state": QuorumState.ERROR,
                "error": _quorum_process.last_error,
            }

        _quorum_process.state = QuorumState.RUNNING
        logger.info("Quorum started (pid=%d)", proc.pid)
        return {
            "status": "started",
            "state": QuorumState.RUNNING,
            "pid": proc.pid,
        }

    except Exception as exc:
        _quorum_process.state = QuorumState.ERROR
        _quorum_process.last_error = str(exc)
        logger.exception("Failed to start Quorum")
        return {
            "status": "error",
            "state": QuorumState.ERROR,
            "error": str(exc),
        }


def handle_stop_quorum() -> Dict[str, Any]:
    """Gracefully stop the Quorum policy server."""
    if _quorum_process.state not in (QuorumState.RUNNING, QuorumState.ERROR):
        return {
            "status": "not_running",
            "state": _quorum_process.state,
        }

    _quorum_process.state = QuorumState.STOPPING

    try:
        proc = _quorum_process.process
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
    except Exception as exc:
        logger.warning("Error during Quorum shutdown: %s", exc)

    _quorum_process.process = None
    _quorum_process.pid = None
    _quorum_process.state = QuorumState.STOPPED
    _quorum_process.started_at = None

    logger.info("Quorum stopped")
    return {
        "status": "stopped",
        "state": QuorumState.STOPPED,
    }


def handle_model_status(config: Optional[Dict[str, Any]] = None) -> QuorumHealth:
    """Check Quorum model health.

    Uses the /api/health endpoint (exempt from auth per config) to probe
    the Quorum runtime. Mirrors the TS LocalRuntimeStatus structure from
    packages/core/src/types.ts.
    """
    quorum_running = _quorum_process.state == QuorumState.RUNNING

    # Model slots — one per role configured
    models: List[ModelStatus] = []
    local_cfg = (config or {}).get("local", {})
    local_models = local_cfg.get("models", [])

    for model_cfg in local_models:
        models.append(ModelStatus(
            role=model_cfg.get("role", "general"),
            configured_model=model_cfg.get("name", "unknown"),
            required=True,
            available=quorum_running,  # Simplified: real check hits /api/health
        ))

    if not models:
        models.append(ModelStatus(
            role="general",
            configured_model="unknown",
            required=True,
            available=quorum_running,
        ))

    # Determine overall state
    if not quorum_running:
        return QuorumHealth(
            state="unavailable",
            quorum_running=False,
            endpoint_connected=False,
            models=models,
            problem_summary="Quorum server is not running",
        )

    # Check health endpoint
    endpoint_connected = _check_health_endpoint(config)

    if not endpoint_connected:
        return QuorumHealth(
            state="degraded",
            quorum_running=True,
            endpoint_connected=False,
            models=models,
            problem_summary="Quorum is running but health endpoint unreachable",
        )

    # Mark models as available
    for m in models:
        m.available = True

    return QuorumHealth(
        state="ready",
        quorum_running=True,
        endpoint_connected=True,
        models=models,
    )


def handle_open_config() -> Dict[str, Any]:
    """Signal the desktop shell to open the Quorum configuration panel.

    The desktop shell interprets this as a navigation command to the
    Quorum plugin's config section within Settings.
    """
    return {
        "action": "navigate",
        "target": "settings/plugins/quorum/config",
    }


def handle_view_logs() -> Dict[str, Any]:
    """Return recent Quorum log entries.

    Reads from the Quorum process stdout/stderr buffers and the agent log.
    """
    logs: List[str] = []

    # Read from the managed process stdout/stderr
    proc = _quorum_process.process
    if proc is not None:
        if proc.stdout:
            try:
                stdout_lines = _read_available(proc.stdout)
                if stdout_lines:
                    logs.append("=== Quorum stdout ===")
                    logs.extend(stdout_lines)
            except Exception:
                pass
        if proc.stderr:
            try:
                stderr_lines = _read_available(proc.stderr)
                if stderr_lines:
                    logs.append("=== Quorum stderr ===")
                    logs.extend(stderr_lines)
            except Exception:
                pass

    if not logs:
        logs.append("No Quorum process output available.")
        logs.append(f"Quorum state: {_quorum_process.state}")
        if _quorum_process.last_error:
            logs.append(f"Last error: {_quorum_process.last_error}")

    return {
        "action": "show_logs",
        "logs": "\n".join(logs),
        "state": _quorum_process.state,
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _apply_config_env(config: Dict[str, Any], env: Dict[str, str]) -> None:
    """Apply Quorum configuration to environment variables (mirrors config.ts)."""
    local_cfg = config.get("local", {})
    if local_cfg:
        if "baseUrl" in local_cfg:
            env["QUORUM_LOCAL_BASE_URL"] = local_cfg["baseUrl"]
        if "apiKey" in local_cfg:
            env["QUORUM_LOCAL_MODEL_API_KEY"] = local_cfg["apiKey"]
        if "transport" in local_cfg:
            env["QUORUM_LOCAL_TRANSPORT"] = local_cfg["transport"]
        models = local_cfg.get("models", [])
        for m in models:
            role = m.get("role", "")
            name = m.get("name", "")
            if role == "general" and name:
                env["QUORUM_LOCAL_MODEL"] = name
            elif role == "coding" and name:
                env["QUORUM_LOCAL_CODING_MODEL"] = name
            elif role == "reasoning" and name:
                env["QUORUM_LOCAL_REASONING_MODEL"] = name
        if "contextWindow" in local_cfg:
            env["QUORUM_LOCAL_CONTEXT_WINDOW"] = str(local_cfg["contextWindow"])

    cloud_cfg = config.get("cloud")
    if cloud_cfg:
        if "baseUrl" in cloud_cfg:
            env["QUORUM_CLOUD_BASE_URL"] = cloud_cfg["baseUrl"]
        if "model" in cloud_cfg:
            env["QUORUM_CLOUD_MODEL"] = cloud_cfg["model"]
        if "apiKey" in cloud_cfg:
            env["QUORUM_CLOUD_API_KEY"] = cloud_cfg["apiKey"]
        if "contextWindow" in cloud_cfg:
            env["QUORUM_CLOUD_CONTEXT_WINDOW"] = str(cloud_cfg["contextWindow"])
        if "qualityRating" in cloud_cfg:
            env["QUORUM_CLOUD_QUALITY_RATING"] = str(cloud_cfg["qualityRating"])

    network_cfg = config.get("network")
    if network_cfg:
        if "baseUrl" in network_cfg:
            env["QUORUM_NETWORK_BASE_URL"] = network_cfg["baseUrl"]
        if "model" in network_cfg:
            env["QUORUM_NETWORK_MODEL"] = network_cfg["model"]
        if "apiKey" in network_cfg:
            env["QUORUM_NETWORK_API_KEY"] = network_cfg["apiKey"]
        if "contextWindow" in network_cfg:
            env["QUORUM_NETWORK_CONTEXT_WINDOW"] = str(network_cfg["contextWindow"])
        if "qualityRating" in network_cfg:
            env["QUORUM_NETWORK_QUALITY_RATING"] = str(network_cfg["qualityRating"])


def _check_health_endpoint(config: Optional[Dict[str, Any]] = None) -> bool:
    """Probe the Quorum /api/health endpoint (exempt from auth).

    Returns True if the endpoint responds successfully.
    """
    import urllib.request
    import urllib.error

    host = "127.0.0.1"
    port = 8787  # Default Quorum port (matches config.ts)
    if config:
        host = config.get("host", host)
        port = config.get("port", port)

    url = f"http://{host}:{port}/api/health"
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=3) as resp:
            return resp.status == 200
    except Exception:
        return False


def _read_available(pipe) -> List[str]:
    """Non-blocking read from a pipe, returning available lines."""
    import select
    lines: List[str] = []
    try:
        if select.select([pipe], [], [], 0)[0]:
            data = pipe.read1(4096) if hasattr(pipe, "read1") else pipe.read(4096)
            if data:
                text = data.decode("utf-8", errors="replace")
                lines = text.rstrip().split("\n")
    except Exception:
        pass
    return lines


# ---------------------------------------------------------------------------
# Module API — called by the plugin framework
# ---------------------------------------------------------------------------

def get_tray_menu_definition() -> List[Dict[str, Any]]:
    """Return the tray menu items the desktop shell should render."""
    return TRAY_MENU_ITEMS


def dispatch_tray_action(
    action: str,
    config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Dispatch a tray menu action to its handler."""
    handlers: Dict[str, Callable] = {
        TrayAction.START_QUORUM: lambda: handle_start_quorum(config),
        TrayAction.STOP_QUORUM: handle_stop_quorum,
        TrayAction.MODEL_STATUS: lambda: _model_status_to_dict(handle_model_status(config)),
        TrayAction.OPEN_CONFIG: handle_open_config,
        TrayAction.VIEW_LOGS: handle_view_logs,
    }

    handler = handlers.get(action)
    if handler is None:
        return {"status": "error", "error": f"Unknown tray action: {action}"}

    try:
        return handler()
    except Exception as exc:
        logger.exception("Tray action %s failed", action)
        return {"status": "error", "error": str(exc)}


def _model_status_to_dict(health: QuorumHealth) -> Dict[str, Any]:
    """Serialize QuorumHealth to a JSON-safe dict."""
    return {
        "status": "ok",
        "health": {
            "state": health.state,
            "quorum_running": health.quorum_running,
            "endpoint_connected": health.endpoint_connected,
            "models": [
                {
                    "role": m.role,
                    "configured_model": m.configured_model,
                    "model_id": m.model_id,
                    "required": m.required,
                    "available": m.available,
                }
                for m in health.models
            ],
            "problem_summary": health.problem_summary,
            "problem_detail": health.problem_detail,
        },
    }
