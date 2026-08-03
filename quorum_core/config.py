"""
quorum_core.config — SINGLE SOURCE OF TRUTH for all Quorum configuration.

DO NOT duplicate config definitions. Every config consumer (API, desktop, CLI, etc.)
MUST import QuorumConfig from this module. No other file shall define or hardcode
config keys, defaults, or validation logic.

Layered resolution (lower wins):
  1. Hardcoded defaults (from QuorumConfig.model_fields)
  2. YAML config file  (~/.quorum/config.yaml)
  3. Environment variables (QUORUM_* prefix)

Env var convention (matching TS schema in apps/api/src/config.ts):
  QUORUM_<SECTION>__<KEY>=value  (double-underscore for nesting)
  e.g. QUORUM_API__PORT=9000, QUORUM_MODEL__TEMPERATURE=0.5

Migration: migrate_from_ts_config() converts an existing TS-style config.yaml
into a QuorumConfig instance (one-way).
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, ClassVar, Dict, List, Literal, Optional, Type, get_args, get_origin

import yaml
from pydantic import (
    BaseModel,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)


# ---------------------------------------------------------------------------
# Helper: env var override
# ---------------------------------------------------------------------------

_ENV_PREFIX = "QUORUM_"

def _apply_env_overrides(config_dict: Dict[str, Any]) -> Dict[str, Any]:
    """Walk QUORUM_* env vars and merge them into config_dict.

    Convention: QUORUM_SECTION__NESTED_KEY=value
    Result:   config_dict["section"]["nested_key"] = value
    """
    for env_key, env_val in os.environ.items():
        if not env_key.startswith(_ENV_PREFIX):
            continue

        raw = env_key[len(_ENV_PREFIX):].lower()
        parts = raw.split("__")

        # Walk into nested dict, creating intermediate levels
        target: Any = config_dict
        for part in parts[:-1]:
            if part not in target or not isinstance(target[part], dict):
                target[part] = {}
            target = target[part]

        leaf = parts[-1]
        # Attempt type coercion: bool, int, float, then fallback to str
        target[leaf] = _coerce_env_value(env_val)

    return config_dict


def _coerce_env_value(raw: str) -> Any:
    """Coerce a raw env string to the most likely type."""
    lowered = raw.strip().lower()
    if lowered in ("true", "yes", "1"):
        return True
    if lowered in ("false", "no", "0"):
        return False
    if lowered in ("null", "none", ""):
        return None
    try:
        return int(raw)
    except ValueError:
        pass
    try:
        return float(raw)
    except ValueError:
        pass
    return raw


# ---------------------------------------------------------------------------
# Helper: merge dictionaries
# ---------------------------------------------------------------------------

def _deep_merge(base: Dict[str, Any], overlay: Dict[str, Any]) -> Dict[str, Any]:
    """Recursively merge overlay into base. Overlay values take precedence."""
    result = dict(base)
    for k, v in overlay.items():
        if k in result and isinstance(result[k], dict) and isinstance(v, dict):
            result[k] = _deep_merge(result[k], v)
        else:
            result[k] = v
    return result


# ---------------------------------------------------------------------------
# Sub-models
# ---------------------------------------------------------------------------

def _reject_unknown(validated: Dict[str, Any], allowed: set, context: str) -> None:
    """Fail fast on unknown keys in a config section."""
    unknown = set(validated.keys()) - allowed
    if unknown:
        raise ValueError(
            f"Unknown keys in {context}: {sorted(unknown)}. "
            f"Allowed: {sorted(allowed)}"
        )


class ApiConfig(BaseModel):
    """API server configuration."""

    host: str = "0.0.0.0"
    port: int = Field(default=8000, ge=1, le=65535)
    cors_origins: List[str] = ["*"]
    request_timeout_ms: int = Field(default=30000, ge=100, le=300_000)

    @model_validator(mode="before")
    @classmethod
    def reject_unknown(cls, values: Any) -> Any:
        if isinstance(values, dict):
            _reject_unknown(
                values,
                {"host", "port", "cors_origins", "request_timeout_ms"},
                "api",
            )
        return values


class ModelConfig(BaseModel):
    """Model / provider configuration."""

    provider: str = "openai"
    model_name: str = "gpt-4"
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int = Field(default=4096, ge=1, le=128_000)
    top_p: float = Field(default=1.0, ge=0.0, le=1.0)
    api_key: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def reject_unknown(cls, values: Any) -> Any:
        if isinstance(values, dict):
            _reject_unknown(
                values,
                {"provider", "model_name", "temperature", "max_tokens", "top_p", "api_key"},
                "model",
            )
        return values


class LoggingConfig(BaseModel):
    """Logging configuration."""

    level: Literal["debug", "info", "warn", "error"] = "info"
    format: Literal["json", "text"] = "json"
    file: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def reject_unknown(cls, values: Any) -> Any:
        if isinstance(values, dict):
            _reject_unknown(values, {"level", "format", "file"}, "logging")
        return values


class WorkspaceConfig(BaseModel):
    """Workspace configuration."""

    root_dir: str = "~/.quorum"
    cache_dir: Optional[str] = None
    session_timeout_minutes: int = Field(default=60, ge=1, le=1440)

    @model_validator(mode="before")
    @classmethod
    def reject_unknown(cls, values: Any) -> Any:
        if isinstance(values, dict):
            _reject_unknown(
                values,
                {"root_dir", "cache_dir", "session_timeout_minutes"},
                "workspace",
            )
        return values

    def resolved_root_dir(self) -> Path:
        """Return root_dir with ~ expanded."""
        return Path(os.path.expanduser(self.root_dir)).resolve()

    def resolved_cache_dir(self) -> Path:
        """Return cache_dir or default, with ~ expanded."""
        if self.cache_dir:
            return Path(os.path.expanduser(self.cache_dir)).resolve()
        return self.resolved_root_dir() / "cache"


class FeaturesConfig(BaseModel):
    """Feature flags."""

    enable_streaming: bool = True
    enable_tool_use: bool = True
    enable_telemetry: bool = False

    @model_validator(mode="before")
    @classmethod
    def reject_unknown(cls, values: Any) -> Any:
        if isinstance(values, dict):
            _reject_unknown(
                values,
                {"enable_streaming", "enable_tool_use", "enable_telemetry"},
                "features",
            )
        return values


# ---------------------------------------------------------------------------
# QuorumConfig — SINGLE SOURCE OF TRUTH
# ---------------------------------------------------------------------------

_KNOWN_SECTIONS = {"api", "model", "logging", "workspace", "features"}
SECTION_CLASSES: Dict[str, Type[BaseModel]] = {
    "api": ApiConfig,
    "model": ModelConfig,
    "logging": LoggingConfig,
    "workspace": WorkspaceConfig,
    "features": FeaturesConfig,
}

# Mapping from section key to its env-var-friendly names (for docs/help)
SECTION_KEYS: Dict[str, set] = {
    section: set(cls.model_fields.keys())
    for section, cls in SECTION_CLASSES.items()
}


class QuorumConfig(BaseModel):
    """Root Quorum configuration — the SINGLE source of truth.

    Do NOT duplicate definitions from this class. All consumers load config
    via:
        cfg = QuorumConfig.load()
    or construct directly:
        cfg = QuorumConfig(api={...}, model={...}, ...)

    On construction, section models silently accept only their known fields.
    Unknown top-level sections cause a validation error.
    """

    api: ApiConfig = Field(default_factory=ApiConfig)
    model: ModelConfig = Field(default_factory=ModelConfig)
    logging: LoggingConfig = Field(default_factory=LoggingConfig)
    workspace: WorkspaceConfig = Field(default_factory=WorkspaceConfig)
    features: FeaturesConfig = Field(default_factory=FeaturesConfig)

    # ------------------------------------------------------------------
    # Construction & loading
    # ------------------------------------------------------------------

    @classmethod
    def load(
        cls,
        config_path: Optional[Path] = None,
        apply_env: bool = True,
    ) -> "QuorumConfig":
        """Load configuration with proper layering.

        Resolution order:
          1. Hardcoded defaults (model fields)
          2. YAML config file (if exists)
          3. Environment variables  (if apply_env=True)

        Args:
            config_path: Path to YAML config file. Default: ~/.quorum/config.yaml
            apply_env: Whether to apply QUORUM_* env var overrides.

        Returns:
            A validated QuorumConfig instance.

        Raises:
            QuorumConfigError: If the final config fails validation, with
                               actionable detail about which keys/values are wrong.
        """
        if config_path is None:
            config_path = Path(os.path.expanduser("~/.quorum/config.yaml"))

        # Step 1: start with defaults
        config_dict: Dict[str, Any] = {}

        # Step 2: merge config file if present
        if config_path.exists():
            try:
                with open(config_path) as f:
                    file_data = yaml.safe_load(f) or {}
                if not isinstance(file_data, dict):
                    raise QuorumConfigError(
                        f"Config file {config_path} must be a YAML mapping, "
                        f"got {type(file_data).__name__}"
                    )
                config_dict = _deep_merge(config_dict, file_data)
            except yaml.YAMLError as e:
                raise QuorumConfigError(
                    f"Failed to parse config file {config_path}: {e}"
                ) from e

        # Step 3: apply env overrides
        if apply_env:
            config_dict = _apply_env_overrides(config_dict)

        # Build and validate
        try:
            return cls(**config_dict)
        except ValidationError as e:
            raise QuorumConfigError(_format_validation_errors(e)) from e

    @model_validator(mode="before")
    @classmethod
    def reject_unknown_top_level(cls, values: Any) -> Any:
        if isinstance(values, dict):
            unknown = set(values.keys()) - _KNOWN_SECTIONS
            if unknown:
                raise ValueError(
                    f"Unknown top-level config sections: {sorted(unknown)}. "
                    f"Allowed: {sorted(_KNOWN_SECTIONS)}"
                )
        return values

    # ------------------------------------------------------------------
    # Serialization
    # ------------------------------------------------------------------

    def to_dict(self) -> Dict[str, Any]:
        """Export the full config as a plain dict (for bridge/panel)."""
        return self.model_dump()

    def save(self, config_path: Optional[Path] = None) -> Path:
        """Save current config to YAML file.

        Args:
            config_path: Target path. Default: ~/.quorum/config.yaml

        Returns:
            The path that was written to.
        """
        if config_path is None:
            config_path = Path(os.path.expanduser("~/.quorum/config.yaml"))
        config_path.parent.mkdir(parents=True, exist_ok=True)
        with open(config_path, "w") as f:
            yaml.safe_dump(self.to_dict(), f, default_flow_style=False, sort_keys=False)
        return config_path

    # ------------------------------------------------------------------
    # Migration
    # ------------------------------------------------------------------

    @classmethod
    def migrate_from_ts_config(cls, ts_config_path: Path) -> "QuorumConfig":
        """One-way migration: existing TS config.yaml → QuorumConfig.

        Reads a YAML file in the format produced by the TypeScript config
        (apps/api/src/config.ts) and returns a validated QuorumConfig.

        This is a ONE-WAY migration — after migration, the config is managed
        exclusively by QuorumConfig.

        Args:
            ts_config_path: Path to the existing TS-style config.yaml

        Returns:
            A validated QuorumConfig instance.

        Raises:
            QuorumConfigError: If the file cannot be read or content is invalid.
        """
        if not ts_config_path.exists():
            raise QuorumConfigError(f"TS config not found at {ts_config_path}")

        try:
            with open(ts_config_path) as f:
                data = yaml.safe_load(f) or {}
        except yaml.YAMLError as e:
            raise QuorumConfigError(
                f"Failed to parse TS config {ts_config_path}: {e}"
            ) from e

        if not isinstance(data, dict):
            raise QuorumConfigError(
                f"TS config {ts_config_path} must be a YAML mapping, "
                f"got {type(data).__name__}"
            )

        # Filter to known sections only (ignore TS-specific keys)
        quorum_data: Dict[str, Any] = {}
        for section in _KNOWN_SECTIONS:
            if section in data:
                quorum_data[section] = data[section]

        try:
            return cls(**quorum_data)
        except ValidationError as e:
            raise QuorumConfigError(
                f"Migration validation failed for {ts_config_path}:\n"
                f"{_format_validation_errors(e)}"
            ) from e

    # ------------------------------------------------------------------
    # Introspection (for settings panel / docs)
    # ------------------------------------------------------------------

    @classmethod
    def schema_info(cls) -> Dict[str, Any]:
        """Return schema metadata for settings panel rendering.

        Returns a dict of section → list of field descriptors with:
          - key: str
          - type: str (python type name)
          - default: Any
          - env_var: str (QUORUM_* name)
          - constraints: dict (optional: ge, le, choices, etc.)
        """
        info: Dict[str, Any] = {}
        for section, model_cls in SECTION_CLASSES.items():
            fields = []
            for field_name, field_info in model_cls.model_fields.items():
                env_var = f"QUORUM_{section.upper()}__{field_name.upper()}"

                field_desc: Dict[str, Any] = {
                    "key": field_name,
                    "type": _describe_type(field_info.annotation),
                    "default": field_info.default
                    if field_info.default is not None
                    else None,
                    "env_var": env_var,
                }

                # Extract Pydantic Field constraints
                for meta in field_info.metadata:
                    constraints: Dict[str, Any] = {}
                    if hasattr(meta, "ge") and meta.ge is not None:
                        constraints["ge"] = meta.ge
                    if hasattr(meta, "le") and meta.le is not None:
                        constraints["le"] = meta.le
                    if hasattr(meta, "gt") and meta.gt is not None:
                        constraints["gt"] = meta.gt
                    if hasattr(meta, "lt") and meta.lt is not None:
                        constraints["lt"] = meta.lt
                    if constraints:
                        field_desc["constraints"] = constraints

                fields.append(field_desc)
            info[section] = fields
        return info


# ---------------------------------------------------------------------------
# Error formatting
# ---------------------------------------------------------------------------

class QuorumConfigError(Exception):
    """Raised when Quorum configuration is invalid — always includes
    actionable error details for fast debugging."""


def _format_validation_errors(exc: ValidationError) -> str:
    """Format Pydantic ValidationError into a user-friendly message."""
    lines = ["Quorum configuration validation failed:"]
    for error in exc.errors():
        loc = " → ".join(str(p) for p in error["loc"]) if error["loc"] else "(root)"
        msg = error["msg"]
        lines.append(f"  • {loc}: {msg}")
    return "\n".join(lines)


def _describe_type(annotation: Any) -> str:
    """Return a human-readable type name for a Pydantic field annotation."""
    # Handle Optional[X]
    origin = get_origin(annotation)
    if origin is not None:
        args = get_args(annotation)
        if origin is type(None) or type(None) in args:  # Optional
            inner = [a for a in args if a is not type(None)][0]
            return f"optional {_describe_type(inner)}"
        if origin is list or origin is List:
            inner = args[0] if args else "Any"
            return f"list of {_describe_type(inner)}"
        if origin is Literal:
            return " | ".join(repr(a) for a in args)
    # Plain type
    if hasattr(annotation, "__name__"):
        return annotation.__name__
    return str(annotation)
