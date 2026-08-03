"""
desktop/config_bridge.py — Bridge between QuorumConfig and Hermes settings panel.

The Hermes desktop settings panel uses this bridge to read and write Quorum
configuration. The bridge reads the SAME config file that quorum_core.config
uses, ensuring the settings panel and core runtime are always in sync.

Key contract:
  - get_config() → dict[section][key]  (panel reads current config)
  - update_config(patch: dict) → dict  (panel writes partial update)
  - get_schema() → dict               (panel renders form fields)
  - These THREE functions are the only API the panel needs.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Optional

from quorum_core.config import (
    QuorumConfig,
    QuorumConfigError,
    SECTION_CLASSES,
    _KNOWN_SECTIONS,
    _deep_merge,
)

# Where the bridge reads/writes config (same as quorum_core default)
DEFAULT_CONFIG_PATH = Path("~/.quorum/config.yaml").expanduser()


# ---------------------------------------------------------------------------
# Public API (called by Hermes settings panel)
# ---------------------------------------------------------------------------

def get_config(config_path: Optional[Path] = None) -> Dict[str, Any]:
    """Return the full, current Quorum configuration as a nested dict.

    This is what the Hermes settings panel calls to populate its form fields.
    Reads from the same file as quorum_core.config.QuorumConfig.load().

    Args:
        config_path: Override config file path (default: ~/.quorum/config.yaml)

    Returns:
        Fully resolved config dict (defaults + file + env overrides).
    """
    cfg = QuorumConfig.load(config_path=config_path)
    return cfg.to_dict()


def update_config(
    patch: Dict[str, Any],
    config_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """Apply a partial config update from the settings panel.

    The panel sends a partial dict (e.g. {"model": {"temperature": 0.9}}).
    This function:
      1. Loads the current on-disk config (file only, no env overrides)
      2. Deep-merges the patch into it
      3. Validates the result via QuorumConfig
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
    if config_path is None:
        config_path = DEFAULT_CONFIG_PATH

    # 1. Read current on-disk state (without env overrides, since env should
    #    not be persisted — env overrides are ephemeral).
    current = {}
    if config_path.exists():
        import yaml
        with open(config_path) as f:
            current = yaml.safe_load(f) or {}

    # 2. Merge patch
    merged = _deep_merge(current, patch)

    # 3. Validate (creates a QuorumConfig; raises on failure)
    QuorumConfig(**merged)

    # 4. Save
    cfg = QuorumConfig(**merged)
    cfg.save(config_path)

    # 5. Return what was saved
    return cfg.to_dict()


def get_schema() -> Dict[str, Any]:
    """Return config schema metadata for rendering the settings panel.

    The panel uses this to render labeled, typed form fields with
    constraints (min/max, choices, etc.).

    Returns:
        Same structure as QuorumConfig.schema_info().
    """
    return QuorumConfig.schema_info()


def validate_config_dict(data: Dict[str, Any]) -> Dict[str, Any]:
    """Validate a full config dict without saving.

    Used by the settings panel for live validation before the user submits.

    Args:
        data: Full config dict to validate.

    Returns:
        The validated dict (normalized by Pydantic).

    Raises:
        QuorumConfigError: With actionable error details.
    """
    cfg = QuorumConfig(**data)
    return cfg.to_dict()


def reset_to_defaults(config_path: Optional[Path] = None) -> Dict[str, Any]:
    """Reset config file to factory defaults.

    Args:
        config_path: Override config file path.

    Returns:
        The default config dict.
    """
    cfg = QuorumConfig()  # all defaults
    if config_path is None:
        config_path = DEFAULT_CONFIG_PATH
    cfg.save(config_path)
    return cfg.to_dict()
