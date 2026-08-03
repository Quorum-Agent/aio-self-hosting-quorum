"""
desktop/config_migration.py — Migrate old TS/JSON config to desktop plugin format.

Supports:
  - Old TypeScript config.yaml (camelCase keys) at ~/.quorum/config.yaml
    or apps/api/config.yaml
  - Simple quorum_core.config JSON format (snake_case keys)
  - Desktop config_ui format (already in correct format — just validates)

Migration target: $HERMES_HOME/desktop-plugins/quorum/config.json

CLIs:
  python -m desktop.config_migration migrate --from <path>
  python -m desktop.config_migration validate [--path <path>]
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any, Dict, Optional

from quorum_core.config import QuorumConfig as CoreConfig

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Path resolution
# ---------------------------------------------------------------------------

def _target_config_path() -> Path:
    """Resolve the desktop plugin config path (same as config_ui._config_path)."""
    home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    plugins_dir = home / "desktop-plugins" / "quorum"
    plugins_dir.mkdir(parents=True, exist_ok=True)
    return plugins_dir / "config.json"


# ---------------------------------------------------------------------------
# Old path discovery
# ---------------------------------------------------------------------------

def _discover_old_config_paths() -> list[Path]:
    """Find candidate old config files to migrate."""
    candidates = [
        Path.home() / ".quorum" / "config.yaml",
        Path.home() / ".quorum" / "config.json",
        Path("apps/api/config.yaml"),
        Path("apps/api/config.json"),
        Path("quorum_config.json"),
    ]
    return [p for p in candidates if p.exists()]


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------

def _is_quorum_core_format(data: Dict[str, Any]) -> bool:
    """Detect if data uses the simple quorum_core.config format (snake_case)."""
    core_fields = {"base_url", "quorum_size", "timeout_seconds",
                   "discovery_interval_seconds", "max_retries", "verify_ssl"}
    desktop_fields = {"local", "cloud", "network", "host", "port"}

    core_count = sum(1 for k in core_fields if k in data)
    desktop_count = sum(1 for k in desktop_fields if k in data)

    return core_count >= desktop_count and core_count > 0


def _is_desktop_format(data: Dict[str, Any]) -> bool:
    """Detect if data uses the rich desktop config_ui format."""
    desktop_markers = {"local", "host", "port", "orchestrationMode", "orchestration_mode"}
    return any(k in data for k in desktop_markers)


# ---------------------------------------------------------------------------
# Format detection and loading
# ---------------------------------------------------------------------------

def _load_source(path: Path) -> Dict[str, Any]:
    """Load a config file, detecting YAML or JSON."""
    raw = path.read_text(encoding="utf-8")

    # Try YAML first (since YAML is a superset of JSON in many cases)
    if path.suffix in (".yaml", ".yml"):
        try:
            import yaml
            return yaml.safe_load(raw) or {}
        except ImportError:
            pass

    # Try JSON
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # Try YAML as fallback
        try:
            import yaml
            return yaml.safe_load(raw) or {}
        except (ImportError, Exception):
            raise ValueError(
                f"Unrecognized config format in {path}. "
                f"Expected YAML or JSON."
            )


# ---------------------------------------------------------------------------
# Migration: quorum_core → desktop
# ---------------------------------------------------------------------------

def _migrate_core_to_desktop(core_data: Dict[str, Any]) -> Dict[str, Any]:
    """Migrate simple quorum_core.config format to desktop config_ui format.

    Maps:
      - base_url → local.base_url (if local-looking) or cloud.base_url
      - quorum_size → preserved as metadata
      - timeout_seconds → preserved as metadata
      - discovery_interval_seconds → preserved as metadata
      - max_retries → preserved as metadata
      - verify_ssl → preserved as metadata
    """
    base_url = core_data.get("base_url", "http://localhost:8080")

    # Build desktop config
    desktop = {
        "host": "127.0.0.1",
        "port": 8787,
        "log_level": "info",
        "data_directory": "./var",
        "orchestration_mode": "route",
        "local": {
            "baseUrl": base_url if "localhost" in base_url or "127.0.0.1" in base_url
                      else "http://127.0.0.1:11434/v1",
            "apiKey": "ollama",
            "transport": "ollama",
            "models": [
                {
                    "role": "general",
                    "name": "qwen3.5:9b",
                    "capabilities": ["chat", "reasoning", "coding", "documents"],
                    "specialties": [],
                    "contextWindow": 16384,
                    "qualityRating": 75,
                }
            ],
            "warmOnStartup": True,
        },
        "cloud": {
            "baseUrl": base_url if "localhost" not in base_url and "127.0.0.1" not in base_url
                       else "https://api.openai.com/v1",
            "model": "gpt-4.1-mini",
            "apiKey": "",
            "contextWindow": 128000,
            "qualityRating": 80,
        } if "localhost" not in base_url and "127.0.0.1" not in base_url else None,
        "network": None,
        "_quorum_core": {
            "quorum_size": core_data.get("quorum_size", 3),
            "timeout_seconds": core_data.get("timeout_seconds", 30.0),
            "discovery_interval_seconds": core_data.get("discovery_interval_seconds", 60.0),
            "max_retries": core_data.get("max_retries", 3),
            "verify_ssl": core_data.get("verify_ssl", True),
        },
    }

    return desktop


def _migrate_ts_to_desktop(ts_data: Dict[str, Any]) -> Dict[str, Any]:
    """Convert TypeScript-style camelCase config to desktop format.

    The old TS config uses camelCase keys (e.g. baseUrl, logLevel) across
    five top-level sections: api, model, logging, workspace, features.
    Each section's fields are converted from camelCase to the desktop
    config_ui format (which handles both camelCase and snake_case).
    """
    result: Dict[str, Any] = {}

    # --- Top-level fields ---
    result["host"] = ts_data.get("host", "127.0.0.1")
    result["port"] = ts_data.get("port", 8787)

    # Handle logLevel (camelCase) → log_level
    result["logLevel"] = ts_data.get("logLevel", ts_data.get("log_level", "info"))

    # Handle dataDirectory (camelCase) → data_directory
    result["dataDirectory"] = ts_data.get(
        "dataDirectory", ts_data.get("data_directory", "./var")
    )

    result["orchestrationMode"] = ts_data.get(
        "orchestrationMode", ts_data.get("orchestration_mode", "route")
    )

    # quorum local API key
    result["quorumLocalApiKey"] = ts_data.get(
        "quorumLocalApiKey", ts_data.get("quorum_local_api_key")
    )

    # --- TS config sections: api, model, logging, workspace, features ---
    # These five sections are the canonical TS config format from apps/api/src/config.ts
    _TS_SECTION_MAP = {
        # api section: camelCase → snake_case for the five TS config sections
        "api": {
            "host": "host",
            "port": "port",
            "corsOrigins": "cors_origins",
            "requestTimeoutMs": "request_timeout_ms",
        },
        "model": {
            "provider": "provider",
            "modelName": "model_name",
            "temperature": "temperature",
            "maxTokens": "max_tokens",
            "topP": "top_p",
            "apiKey": "api_key",
        },
        "logging": {
            "level": "level",
            "format": "format",
            "file": "file",
        },
        "workspace": {
            "rootDir": "root_dir",
            "cacheDir": "cache_dir",
            "sessionTimeoutMinutes": "session_timeout_minutes",
        },
        "features": {
            "enableStreaming": "enable_streaming",
            "enableToolUse": "enable_tool_use",
            "enableTelemetry": "enable_telemetry",
        },
    }

    for section_name, field_map in _TS_SECTION_MAP.items():
        if section_name in ts_data:
            section_data = ts_data[section_name]
            if isinstance(section_data, dict):
                converted = {}
                for camel_key, snake_key in field_map.items():
                    if camel_key in section_data:
                        converted[snake_key] = section_data[camel_key]
                # Preserve any unknown keys as-is (non-destructive)
                for key, value in section_data.items():
                    if key not in field_map:
                        converted[key] = value
                if converted:
                    result[section_name] = converted

    # --- Nested desktop sections — pass through as-is (with camelCase keys for config_ui) ---
    for section in ("local", "cloud", "network", "managedLlama", "managed_llama",
                    "webSearch", "web_search"):
        if section in ts_data:
            result[section] = ts_data[section]

    return result


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def migrate(source_path: Optional[Path] = None) -> Dict[str, Any]:
    """Migrate config from an old format to the desktop plugin format.

    Args:
        source_path: Path to the old config file. If None, discovers
                     candidate paths automatically.

    Returns:
        The migrated desktop config dict.

    Raises:
        FileNotFoundError: If no source config is found.
        ValueError: If the format is unrecognized.
    """
    if source_path is None:
        candidates = _discover_old_config_paths()
        if not candidates:
            raise FileNotFoundError(
                "No old config files found. Searched: "
                + ", ".join(str(p) for p in _discover_old_config_paths())
            )
        source_path = candidates[0]
        logger.info("Auto-discovered source config: %s", source_path)

    if not source_path.exists():
        raise FileNotFoundError(f"Source config not found: {source_path}")

    data = _load_source(source_path)

    if _is_desktop_format(data):
        # Already in desktop format — just validate and save
        logger.info("Config is already in desktop format. Validating and saving.")
        result = data
        # Remove any private metadata from migration
        result.pop("_quorum_core", None)
    elif _is_quorum_core_format(data):
        logger.info("Detected quorum_core.config format. Migrating to desktop format.")
        result = _migrate_core_to_desktop(data)
    else:
        # Assume TypeScript-style config
        logger.info("Detected TypeScript-style config. Converting to desktop format.")
        result = _migrate_ts_to_desktop(data)

    # Validate the result by trying to construct core config
    _validate_core_fields(result)

    # Save to target
    # F5-CM-001: Write to temp file then atomic replace to avoid
    #   corrupting the existing config on partial write.
    target = _target_config_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp_target = target.with_suffix(target.suffix + ".migrating")
    try:
        tmp_target.write_text(
            json.dumps(result, indent=2, default=str), encoding="utf-8"
        )
        # Atomic replace (same filesystem — rename is atomic on POSIX)
        tmp_target.replace(target)
    except Exception:
        if tmp_target.exists():
            tmp_target.unlink(missing_ok=True)
        raise
    logger.info("Config migrated and saved to %s", target)

    return result


def validate(config_path: Optional[Path] = None) -> Dict[str, Any]:
    """Validate the current (or specified) desktop config.

    Args:
        config_path: Path to the config file to validate. If None,
                     uses the default desktop config path.

    Returns:
        Dict with 'status', 'issues', 'config' keys.

    Raises:
        FileNotFoundError: If the config file is not found.
    """
    if config_path is None:
        config_path = _target_config_path()

    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    data = _load_source(config_path)
    issues = _validate_core_fields(data)

    return {
        "status": "ok" if not issues else "validation_issues",
        "issues": issues,
        "path": str(config_path),
    }


def _validate_core_fields(data: Dict[str, Any]) -> list[Dict[str, str]]:
    """Validate core quorum fields within a desktop config."""
    issues: list[Dict[str, str]] = []

    # Extract core fields from desktop config or _quorum_core metadata
    core = data.get("_quorum_core", {})

    # Also check top-level fields
    quorum_size = core.get("quorum_size", data.get("quorum_size", 3))
    timeout = core.get("timeout_seconds", data.get("timeout_seconds", 30.0))
    max_retries = core.get("max_retries", data.get("max_retries", 3))

    try:
        CoreConfig(
            base_url=(data.get("local", {}).get("baseUrl", "http://localhost:8080")),
            quorum_size=int(quorum_size),
            timeout_seconds=float(timeout),
            max_retries=int(max_retries),
        )
    except (TypeError, ValueError) as exc:
        issues.append({
            "field": "quorum_core",
            "message": f"Core config validation failed: {exc}",
        })

    return issues


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _main() -> None:
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Quorum config migration tool",
        prog="python -m desktop.config_migration",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # migrate
    migrate_p = sub.add_parser("migrate", help="Migrate old config to desktop format")
    migrate_p.add_argument(
        "--from", dest="source", type=str, default=None,
        help="Path to old config file (auto-discovered if omitted)",
    )
    migrate_p.add_argument(
        "--dry-run", action="store_true",
        help="Show what would be migrated without saving",
    )

    # validate
    validate_p = sub.add_parser("validate", help="Validate desktop config")
    validate_p.add_argument(
        "--path", type=str, default=None,
        help="Path to config file (default: desktop plugin config)",
    )

    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if args.command == "migrate":
        source = Path(args.source) if args.source else None
        if args.dry_run:
            if source is None:
                candidates = _discover_old_config_paths()
                if not candidates:
                    print("No old config files found.")
                    sys.exit(1)
                source = candidates[0]
            data = _load_source(source)
            if _is_quorum_core_format(data):
                result = _migrate_core_to_desktop(data)
            elif _is_desktop_format(data):
                result = data
            else:
                result = _migrate_ts_to_desktop(data)
            print(json.dumps(result, indent=2, default=str))
        else:
            try:
                result = migrate(source)
                print(f"✓ Migrated to {_target_config_path()}")
                print(f"  Sections: {[k for k in result if not k.startswith('_')]}")
            except FileNotFoundError as e:
                print(f"✗ {e}")
                sys.exit(1)
            except ValueError as e:
                print(f"✗ {e}")
                sys.exit(1)

    elif args.command == "validate":
        try:
            result = validate(Path(args.path) if args.path else None)
            if result["status"] == "ok":
                print(f"✓ Config at {result['path']} is valid")
            else:
                print(f"⚠ Config at {result['path']} has issues:")
                for issue in result["issues"]:
                    print(f"  - [{issue['field']}] {issue['message']}")
                sys.exit(1)
        except FileNotFoundError as e:
            print(f"✗ {e}")
            sys.exit(1)
        except ValueError as e:
            print(f"✗ {e}")
            sys.exit(1)


if __name__ == "__main__":
    _main()
