"""
Quorum Desktop Plugin — Main Entry Point.

This is the plugin that the Hermes desktop shell loads. It bridges the
Quorum policy-core runtime with the Electron desktop app via:

  1. A REST namespace at ``/api/plugins/quorum/`` for config CRUD,
     tray action dispatch, health checks, and lifecycle management.
  2. A WebSocket at ``/api/plugins/quorum/events`` for live Quorum
     state changes (process start/stop, model status changes).
  3. Plugin-scoped storage for persisting configuration and state.

Architecture:
  - The Electron shell keeps its React/TS plugin surface (per
    hermes-desktop-plugins conventions).
  - This Python module is the backend the shell's plugin.js talks to
    via ``ctx.rest()`` and ``ctx.socket()``.
  - The Quorum server process is managed as a subprocess (start/stop
    from the tray menu).
  - Health checks use ``/api/health`` which is exempt from auth
    (the desktop runs on loopback).
  - Auto-update is handled by the Hermes updater — no separate
    update mechanism.

Forbidden: forking Hermes desktop (use plugin API only per ADR 0003).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from . import config_ui
from . import tray_menu

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# FastAPI router — mounted at /api/plugins/quorum/ by the dashboard layer
# ---------------------------------------------------------------------------

router = APIRouter()

# Active WebSocket connections for live state push
_active_ws: List[WebSocket] = []


# ---------------------------------------------------------------------------
# Health endpoint — exempt from auth
# ---------------------------------------------------------------------------

@router.get("/health")
async def health_check():
    """Health check endpoint.

    Exempt from dashboard auth (declared in plugin_manifest.json).
    The desktop shell polls this to determine Quorum readiness.
    """
    quorum_state = tray_menu.get_quorum_state()
    running = quorum_state == tray_menu.QuorumState.RUNNING

    # Build endpoint connectivity check
    endpoint_connected = False
    if running:
        endpoint_connected = tray_menu._check_health_endpoint(None)

    return {
        "plugin": "quorum-desktop",
        "status": "ok",
        "quorum": {
            "state": quorum_state.value,
            "running": running,
            "pid": tray_menu._quorum_process.pid,
            "endpoint_connected": endpoint_connected,
        },
    }


# ---------------------------------------------------------------------------
# Config endpoints
# ---------------------------------------------------------------------------

@router.get("/config")
async def get_config():
    """Return the full configuration panel schema and current values."""
    schema = config_ui.get_config_schema()
    current = config_ui.get_current_config()
    return {
        "schema": schema,
        "config": current,
    }


@router.put("/config")
async def update_config(body: Dict[str, Any]):
    """Update configuration (partial merge)."""
    result = config_ui.update_config(body)
    if result.get("status") == "validation_error":
        # Notify tray about config change
        await _broadcast_state({"type": "config_error", "issues": result.get("issues", [])})
        return JSONResponse(status_code=400, content=result)
    # Broadcast config change to connected desktops
    await _broadcast_state({"type": "config_updated", "config": result.get("config")})
    return result


@router.post("/config/reset")
async def reset_config():
    """Reset configuration to defaults."""
    result = config_ui.reset_config()
    await _broadcast_state({"type": "config_reset", "config": result.get("config")})
    return result


@router.get("/config/schema")
async def get_schema():
    """Return the config panel schema only (for initial form rendering)."""
    return config_ui.get_config_schema()


# ---------------------------------------------------------------------------
# Tray menu endpoints
# ---------------------------------------------------------------------------

@router.get("/tray")
async def get_tray_menu():
    """Return the tray menu definition."""
    return {
        "items": tray_menu.get_tray_menu_definition(),
        "quorum_state": tray_menu.get_quorum_state().value,
    }


@router.post("/tray/{action}")
async def dispatch_tray(action: str):
    """Dispatch a tray menu action."""
    config = config_ui.load_quorum_config()
    config_dict = config_ui._serialize_config(config)
    result = tray_menu.dispatch_tray_action(action, config_dict)

    # Broadcast state changes
    await _broadcast_state({
        "type": "quorum_state_changed",
        "state": tray_menu.get_quorum_state().value,
        "action": action,
        "result": result,
    })

    return result


@router.get("/status")
async def get_status():
    """Get current Quorum runtime status."""
    config = config_ui.load_quorum_config()
    config_dict = config_ui._serialize_config(config)
    health = tray_menu.handle_model_status(config_dict)
    return tray_menu._model_status_to_dict(health)


# ---------------------------------------------------------------------------
# WebSocket — live state push
# ---------------------------------------------------------------------------

@router.websocket("/events")
async def events_ws(websocket: WebSocket):
    """Live state WebSocket for the desktop shell.

    Pushes Quorum state changes in real time: process start/stop,
    model availability changes, config updates, errors.
    """
    await websocket.accept()
    _active_ws.append(websocket)

    try:
        # Send current state immediately
        state = tray_menu.get_quorum_state().value
        await websocket.send_json({"type": "quorum_state", "state": state})

        # Keep alive — wait for client messages (heartbeat / close)
        while True:
            try:
                data = await asyncio.wait_for(websocket.receive_text(), timeout=30)
                # Client can request current state explicitly
                if data == "ping":
                    await websocket.send_json({"type": "pong"})
                elif data == "status":
                    config = config_ui.load_quorum_config()
                    config_dict = config_ui._serialize_config(config)
                    health = tray_menu.handle_model_status(config_dict)
                    await websocket.send_json({
                        "type": "model_status",
                        "health": tray_menu._model_status_to_dict(health),
                    })
            except asyncio.TimeoutError:
                # Send heartbeat
                try:
                    await websocket.send_json({
                        "type": "heartbeat",
                        "state": tray_menu.get_quorum_state().value,
                    })
                except Exception:
                    break
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("WebSocket error: %s", exc)
    finally:
        if websocket in _active_ws:
            _active_ws.remove(websocket)


async def _broadcast_state(message: Dict[str, Any]) -> None:
    """Push a state update to all connected WebSocket clients."""
    dead: List[WebSocket] = []
    for ws in _active_ws:
        try:
            await ws.send_json(message)
        except Exception:
            dead.append(ws)
    for ws in dead:
        if ws in _active_ws:
            _active_ws.remove(ws)


# ---------------------------------------------------------------------------
# Plugin lifecycle hooks
# ---------------------------------------------------------------------------

def _on_shutdown() -> None:
    """Cleanup handler called when the Hermes process exits.

    Gracefully stops the Quorum server if it's still running.
    """
    state = tray_menu.get_quorum_state()
    if state in (tray_menu.QuorumState.RUNNING, tray_menu.QuorumState.STARTING):
        logger.info("Shutting down Quorum server (Hermes process exiting)")
        tray_menu.handle_stop_quorum()


def _on_startup() -> None:
    """Initialize plugin state on Hermes startup.

    Does NOT auto-start the Quorum server — the user must explicitly
    start it from the tray menu. We only load persisted config.
    """
    config = config_ui.load_quorum_config()
    logger.info(
        "Quorum desktop plugin loaded (host=%s:%d, transport=%s)",
        config.host, config.port, config.local.transport,
    )


# ---------------------------------------------------------------------------
# Hermes plugin register entry point
# ---------------------------------------------------------------------------

def register(ctx) -> None:
    """Register the Quorum desktop plugin with the Hermes agent.

    Called by the hermes-agent plugin loader. ``ctx`` is the
    ``PluginContext`` providing hook registration, storage, and
    lifecycle callbacks.

    The plugin hooks into:
      - ``on_startup``: load persisted config, register signal handlers
      - ``on_shutdown``: gracefully stop the Quorum server
      - ``dashboard_plugin``: expose the FastAPI router + manifest

    The desktop shell's plugin.js file communicates with this backend
    via ``ctx.rest(path)`` (which maps to the router above).
    """
    logger.info("Quorum desktop plugin: register(ctx) called")

    # Register lifecycle hooks
    ctx.register_hook("on_startup", lambda **kw: _on_startup())
    ctx.register_hook("on_shutdown", lambda **kw: _on_shutdown())

    # Register signal handlers for graceful shutdown
    def _handle_signal(signum, frame):
        logger.info("Received signal %d, stopping Quorum", signum)
        tray_menu.handle_stop_quorum()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _handle_signal)
        except (ValueError, OSError):
            pass  # Not available in this context (e.g., threads)

    # Register the dashboard plugin — this exposes the router at
    # /api/plugins/quorum/ and the tray/config panel to the desktop shell.
    ctx.register_dashboard_plugin(
        manifest=json.loads(
            (Path(__file__).parent / "plugin_manifest.json").read_text(encoding="utf-8")
        ),
        router=router,
    )

    logger.info("Quorum desktop plugin registered successfully")


# ---------------------------------------------------------------------------
# Module-level exports for direct import by the plugin loader
# ---------------------------------------------------------------------------

__all__ = [
    "register",
    "router",
    "config_ui",
    "tray_menu",
]
