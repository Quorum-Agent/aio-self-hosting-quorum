# hermes_agent/config.py — Hermes Agent config patterns (READ-ONLY reference)
#
# Hermes uses a layered config system:
#   1. Defaults (hardcoded in code)
#   2. Config file (YAML, ~/.hermes/config.yaml)
#   3. Environment variables (HERMES_* prefix)
#
# Environment variable override convention:
#   HERMES_SECTION_KEY=value  (flat, single underscore)
#   e.g. HERMES_LOG_LEVEL=debug, HERMES_SERVER_PORT=8080
#
# Hermes config loading uses Pydantic for validation:
#   - All config values are typed with Pydantic field validators
#   - On startup, load defaults → merge config file → apply env overrides
#   - If validation fails, Quorum exits with a clear error message
#   - Unknown keys in config file are rejected (fail-fast)
#
# The settings panel in the desktop app reads/writes the same config file.
# QuorumConfig should be importable by both the core and the desktop bridge.

from pathlib import Path
from typing import Optional
import os
import yaml

class HermesConfigPattern:
    """Reference pattern showing how Hermes handles config hierarchically."""
    
    @staticmethod
    def load_defaults() -> dict:
        """Load hardcoded defaults — never change these without updating docs."""
        return {
            "log_level": "info",
            "server_port": 8080,
            "cache_dir": "~/.hermes/cache",
        }
    
    @staticmethod
    def load_config_file(path: Path) -> dict:
        """Load YAML config file, returning {} if not found."""
        if path.exists():
            with open(path) as f:
                return yaml.safe_load(f) or {}
        return {}
    
    @staticmethod
    def apply_env_overrides(config: dict, prefix: str = "HERMES_") -> dict:
        """Apply env var overrides.
        
        Convention: HERMES_SECTION_KEY=value
        Example: HERMES_LOG_LEVEL=debug → config["log"]["level"] = "debug"
        
        For nested config, Hermes uses double-underscore:
        HERMES_MODEL__TEMPERATURE=0.5 → config["model"]["temperature"] = 0.5
        
        Type coercion is handled by Pydantic validators.
        """
        for key, value in os.environ.items():
            if not key.startswith(prefix):
                continue
            # Strip prefix and split by double-underscore for nesting
            config_key = key[len(prefix):].lower()
            parts = config_key.split("__")
            
            # Walk into nested dict
            target = config
            for part in parts[:-1]:
                if part not in target:
                    target[part] = {}
                target = target[part]
            target[parts[-1]] = value
        return config
