"""
desktop/config_bridge.py — Bridge between QuorumConfig and Hermes settings panel.

The Hermes desktop settings panel uses this bridge to read and write Quorum
configuration. The bridge reads the SAME config file that quorum_core.config
uses, ensuring the settings panel and core runtime are always in sync.

Uses the ACTUAL quorum_core.config.QuorumConfig API (base_url, quorum_size,
timeout_seconds, etc.) and maps to the richer desktop config_ui format.

Key contract:
  - get_config() → dict[section][key]  (panel reads current config)
  - update_config(patch: dict) → dict  (panel writes partial update)
  - get_schema() → dict               (panel renders form fields)
  - validate_config_dict(data) → dict  (live validation)
  - reset_to_defaults() → dict         (reset to factory defaults)
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional

from quorum_core.config import QuorumConfig as CoreConfig

logger = logging.getLogger(__name__)

# Unified canonical config path: all components (config_bridge, config_migration,
# config_ui) use $HERMES_HOME/desktop-plugins/quorum/config.json.
# Falls back to ~/.hermes/desktop-plugins/quorum/config.json if HERMES_HOME is unset.
def _get_canonical_config_path() -> Path:
    """Resolve the single canonical config path shared by all desktop components."""
    home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    plugins_dir = home / "desktop-plugins" / "quorum"
    return plugins_dir / "config.json"

DEFAULT_CONFIG_PATH = _get_canonical_config_path()

# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class QuorumConfigError(ValueError):
    """Raised when Quorum configuration is invalid."""


def _sanitize_patch(patch: Dict[str, Any]) -> Dict[str, Any]:
    """Remove internal / _-prefixed keys from user-supplied patch data.

    These keys are internal markers (e.g. _core) that must never be
    controllable by user input — they enable injection bypass of
    validation (C10-SEC-03).
    """
    return {k: v for k, v in patch.items() if not k.startswith("_")}


def _deep_merge(base: Dict[str, Any], patch: Dict[str, Any]) -> Dict[str, Any]:
    """Deep-merge patch into base, returning a new dict.

    Nested dicts are merged recursively. All other values are overwritten.
    None values in patch delete keys from base (unless they're nested).

    Args:
        base: The base dictionary.
        patch: The patch to apply.

    Returns:
        A new merged dictionary.
    """
    result = {k: v for k, v in base.items()}
    for key, value in patch.items():
        if value is None:
            result.pop(key, None)
        elif isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


# ---------------------------------------------------------------------------
# Config path resolution
# ---------------------------------------------------------------------------


def _resolve_path(config_path: Optional[Path]) -> Path:
    """Resolve the config file path, ensuring the parent directory exists."""
    path = config_path if config_path is not None else DEFAULT_CONFIG_PATH
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


# ---------------------------------------------------------------------------
# Core ↔ Desktop format mapping
# ---------------------------------------------------------------------------


def _core_to_desktop(core_dict: Dict[str, Any]) -> Dict[str, Any]:
    """Map simple quorum_core config dict to desktop config_ui format.

    The desktop format matches config_ui.DesktopQuorumConfig serialized shape:
    host, port, log_level, data_directory, local, cloud, network,
    managed_llama, web_search, orchestration_mode.
    """
    base_url = core_dict.get("base_url", "http://localhost:8080")
    is_local = "localhost" in base_url or "127.0.0.1" in base_url

    desktop = {
        "host": core_dict.get("host", "127.0.0.1"),
        "port": core_dict.get("port", 8787),
        "log_level": core_dict.get("log_level", "info"),
        "data_directory": core_dict.get("data_directory", "./var"),
        "orchestration_mode": core_dict.get("orchestration_mode", "route"),
        "local": {
            "base_url": base_url if is_local else "http://127.0.0.1:11434/v1",
            "api_key": core_dict.get("local_api_key", "ollama"),
            "transport": core_dict.get("local_transport", "ollama"),
            "models": core_dict.get("local_models", [
                {
                    "role": "general",
                    "name": "qwen3.5:9b",
                    "capabilities": ["chat", "reasoning", "coding", "documents"],
                    "specialties": [],
                    "context_window": 16384,
                    "quality_rating": 75,
                }
            ]),
            "warm_on_startup": core_dict.get("local_warm_on_startup", True),
        },
        "cloud": {
            "base_url": base_url if not is_local else "https://api.openai.com/v1",
            "model": core_dict.get("cloud_model", "gpt-4.1-mini"),
            "api_key": core_dict.get("cloud_api_key", ""),
            "context_window": core_dict.get("cloud_context_window", 128000),
            "quality_rating": core_dict.get("cloud_quality_rating", 80),
        },
        "network": None,
        "managed_llama": None,
        "web_search": None,
        "_quorum_core": {
            "base_url": base_url,
            "quorum_size": core_dict.get("quorum_size", 3),
            "timeout_seconds": core_dict.get("timeout_seconds", 30.0),
            "discovery_interval_seconds": core_dict.get("discovery_interval_seconds", 60.0),
            "max_retries": core_dict.get("max_retries", 3),
            "verify_ssl": core_dict.get("verify_ssl", True),
        },
    }
    return desktop


def _desktop_to_core(desktop_dict: Dict[str, Any]) -> Dict[str, Any]:
    """Map desktop config_ui format back to simple quorum_core format.

    If the desktop dict has a _quorum_core key, use it to extract core fields
    (round-trip preservation). Otherwise, extract core fields from the desktop sections.

    Also handles direct quorum_core format (flat keys) as pass-through.
    """
    # If it has the _quorum_core metadata block, extract from it
    if "_quorum_core" in desktop_dict:
        return desktop_dict["_quorum_core"]

    # Legacy _core marker support
    if "_core" in desktop_dict:
        return desktop_dict["_core"]

    # If it looks like flat quorum_core format (has base_url but no sections)
    if "base_url" in desktop_dict and "local" not in desktop_dict and "server" not in desktop_dict:
        return {
            "base_url": desktop_dict.get("base_url", "http://localhost:8080"),
            "quorum_size": desktop_dict.get("quorum_size", 3),
            "timeout_seconds": desktop_dict.get("timeout_seconds", 30.0),
            "discovery_interval_seconds": desktop_dict.get("discovery_interval_seconds", 60.0),
            "max_retries": desktop_dict.get("max_retries", 3),
            "verify_ssl": desktop_dict.get("verify_ssl", True),
        }

    # Extract from desktop config_ui / DesktopQuorumConfig format
    local = desktop_dict.get("local", {})
    cloud = desktop_dict.get("cloud", {}) or {}
    qcore = desktop_dict.get("_quorum_core", {})

    return {
        "base_url": (
            qcore.get("base_url")
            or local.get("base_url", local.get("baseUrl", "http://localhost:8080"))
        ),
        "quorum_size": qcore.get("quorum_size", 3),
        "timeout_seconds": qcore.get("timeout_seconds", 30.0),
        "discovery_interval_seconds": qcore.get("discovery_interval_seconds", 60.0),
        "max_retries": qcore.get("max_retries", 3),
        "verify_ssl": qcore.get("verify_ssl", True),
    }


# ---------------------------------------------------------------------------
# Public API (called by Hermes settings panel)
# ---------------------------------------------------------------------------


def get_config(config_path: Optional[Path] = None) -> Dict[str, Any]:
    """Return the full, current Quorum configuration as a nested dict.

    This is what the Hermes settings panel calls to populate its form fields.
    Reads from the same file as quorum_core.config.QuorumConfig.load().

    Args:
        config_path: Override config file path (default: ~/.quorum/config.json)

    Returns:
        Fully resolved config dict as section[field] structure for the panel.
    """
    resolved = _resolve_path(config_path)

    if resolved.exists():
        try:
            cfg = CoreConfig.load(str(resolved))
        except Exception as exc:
            logger.warning("Failed to load config from %s: %s", resolved, exc)
            cfg = CoreConfig()
    else:
        cfg = CoreConfig()

    return _core_to_desktop(cfg.to_dict())


def update_config(
    patch: Dict[str, Any],
    config_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """Apply a partial config update from the settings panel.

    The panel sends a partial dict (e.g. {"server": {"base_url": "..."}}).
    This function:
      1. Loads the current on-disk config
      2. Deep-merges the patch into it
      3. Validates the result via quorum_core.config.QuorumConfig
      4. Saves the validated result back to disk
      5. Returns the new full config dict

    Args:
        patch: Partial config dict with changes to apply.
        config_path: Override config file path.

    Returns:
        The new validated full config dict.

    Raises:
        QuorumConfigError: If the patched config fails validation.
    """
    resolved = _resolve_path(config_path)

    # 1. Read current on-disk state
    current: Dict[str, Any] = {}
    if resolved.exists():
        try:
            current = json.loads(resolved.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Could not read config from %s: %s", resolved, exc)
            current = CoreConfig().to_dict()

    if not current:
        current = CoreConfig().to_dict()

    # 2. Sanitize user patch — strip internal _-prefixed keys (C10-SEC-03)
    clean_patch = _sanitize_patch(patch)

    # 3. Merge patch
    merged = _deep_merge(current, clean_patch)

    # 3. Extract core fields and validate
    core_data = _desktop_to_core(merged)
    try:
        validated = CoreConfig.from_dict(core_data)
    except (TypeError, ValueError) as exc:
        raise QuorumConfigError(f"Configuration validation failed: {exc}") from exc

    # 4. Save config to disk — preserve desktop-format sections alongside
    #    quorum_core fields for config_ui round-trip compatibility
    save_data = validated.to_dict()
    # Preserve desktop-specific sections that were in the merge
    for key in ("local", "cloud", "network", "managed_llama", "web_search",
                "_quorum_core", "_core"):
        if key in merged and isinstance(merged[key], dict):
            save_data[key] = merged[key]

    # Also preserve top-level desktop fields (host, port, log_level, etc.)
    for key in ("host", "port", "log_level", "data_directory",
                "orchestration_mode", "quorum_local_api_key"):
        if key in merged:
            save_data[key] = merged[key]

    resolved.write_text(json.dumps(save_data, indent=2, default=str), encoding="utf-8")
    logger.info("Config saved to %s", resolved)

    # 5. Return panel-format view
    return _core_to_desktop(validated.to_dict())


def get_schema() -> Dict[str, Any]:
    """Return config schema metadata for rendering the settings panel.

    The panel uses this to render labeled, typed form fields with
    constraints (min/max, choices, etc.).

    Returns:
        Schema dict with sections and fields metadata.
    """
    return {
        "sections": [
            {
                "id": "local_model",
                "title": "Local Model",
                "icon": "server",
                "description": "Models running on your machine via Ollama or an OpenAI-compatible endpoint.",
                "fields": [
                    {
                        "id": "local.base_url",
                        "label": "Base URL",
                        "type": "string",
                        "default": "http://127.0.0.1:11434/v1",
                        "placeholder": "http://127.0.0.1:11434/v1",
                        "help": "Ollama or OpenAI-compatible endpoint URL.",
                    },
                    {
                        "id": "local.api_key",
                        "label": "API Key",
                        "type": "password",
                        "default": "ollama",
                        "help": "API key for the local endpoint.",
                    },
                    {
                        "id": "local.transport",
                        "label": "Transport",
                        "type": "select",
                        "default": "ollama",
                        "options": [
                            {"value": "ollama", "label": "Ollama"},
                            {"value": "openai-compatible", "label": "OpenAI Compatible"},
                        ],
                    },
                ],
            },
            {
                "id": "cloud_model",
                "title": "Cloud Model",
                "icon": "cloud",
                "description": "Vendor-hosted inference API (OpenAI, Anthropic, etc.).",
                "fields": [
                    {
                        "id": "cloud.base_url",
                        "label": "Base URL",
                        "type": "string",
                        "default": "https://api.openai.com/v1",
                        "placeholder": "https://api.openai.com/v1",
                        "help": "Cloud API endpoint URL.",
                    },
                    {
                        "id": "cloud.model",
                        "label": "Model",
                        "type": "string",
                        "default": "gpt-4.1-mini",
                        "placeholder": "gpt-4.1-mini",
                        "help": "Cloud model name.",
                    },
                    {
                        "id": "cloud.api_key",
                        "label": "API Key",
                        "type": "password",
                        "default": "",
                        "help": "Leave empty to disable cloud tier.",
                    },
                ],
            },
            {
                "id": "quorum_core",
                "title": "Quorum Core",
                "icon": "check-circle",
                "description": "Quorum consensus and operational configuration.",
                "fields": [
                    {
                        "id": "quorum.quorum_size",
                        "label": "Quorum Size",
                        "type": "integer",
                        "default": 3,
                        "min": 1,
                        "max": 100,
                        "help": "Minimum number of nodes required for quorum.",
                    },
                    {
                        "id": "operations.timeout_seconds",
                        "label": "Timeout (seconds)",
                        "type": "number",
                        "default": 30.0,
                        "min": 1,
                        "max": 3600,
                        "help": "Timeout for operations in seconds.",
                    },
                    {
                        "id": "operations.max_retries",
                        "label": "Max Retries",
                        "type": "integer",
                        "default": 3,
                        "min": 0,
                        "max": 100,
                        "help": "Maximum retry attempts for failed operations.",
                    },
                ],
            },
        ],
    }


def validate_config_dict(data: Dict[str, Any]) -> Dict[str, Any]:
    """Validate a full config dict without saving.

    Used by the settings panel for live validation before the user submits.

    Args:
        data: Full config dict to validate (panel format or core format).

    Returns:
        The validated dict in core format.

    Raises:
        QuorumConfigError: With actionable error details.
    """
    core_data = _desktop_to_core(data)
    try:
        cfg = CoreConfig.from_dict(core_data)
    except (TypeError, ValueError) as exc:
        raise QuorumConfigError(
            f"Configuration validation failed: {exc}"
        ) from exc
    return cfg.to_dict()


def reset_to_defaults(config_path: Optional[Path] = None) -> Dict[str, Any]:
    """Reset config file to factory defaults.

    Args:
        config_path: Override config file path.

    Returns:
        The default config dict in panel format.
    """
    cfg = CoreConfig()  # all defaults
    resolved = _resolve_path(config_path)
    resolved.write_text(
        json.dumps(cfg.to_dict(), indent=2, default=str),
        encoding="utf-8",
    )
    logger.info("Config reset to defaults at %s", resolved)
    return _core_to_desktop(cfg.to_dict())