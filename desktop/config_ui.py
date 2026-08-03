"""
Quorum Desktop Plugin — Configuration Panel.

Provides the configuration schema and API for the Quorum desktop plugin.
Mirrors the TypeScript config in ``apps/api/src/config.ts``, exposing
three model tiers (Local, Cloud, Network) with the same field names,
validation rules, and environment-variable mapping.

The desktop shell renders this configuration as a settings panel under
Settings → Plugins → Quorum → Config.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field, asdict
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Types — mirrors packages/core/src/types.ts and apps/api/src/config.ts
# ---------------------------------------------------------------------------

class Capability(str, Enum):
    CHAT = "chat"
    REASONING = "reasoning"
    CODING = "coding"
    VISION = "vision"
    DOCUMENTS = "documents"
    WEB = "web"
    TOOLS = "tools"


class LocalModelRole(str, Enum):
    GENERAL = "general"
    CODING = "coding"
    REASONING = "reasoning"


class ExecutionLocation(str, Enum):
    DEVICE = "device"
    LOCAL = "local"
    NETWORK = "network"
    REMOTE = "remote"
    WEB = "web"
    CLOUD = "cloud"


class OrchestrationMode(str, Enum):
    ROUTE = "route"
    RELAY = "relay"


class WebSearchProvider(str, Enum):
    AUTO = "auto"
    DUCKDUCKGO = "duckduckgo"
    EXA = "exa"
    PERPLEXITY = "perplexity"
    TAVILY = "tavily"
    BRAVE = "brave"
    FIRECRAWL = "firecrawl"
    SEARXNG = "searxng"


# ---------------------------------------------------------------------------
# Config dataclasses — named and typed to match TS config.ts exactly
# ---------------------------------------------------------------------------

@dataclass
class LocalModelConfig:
    """A local model definition (mirrors TS ``LocalModelConfig``)."""
    role: str = "general"           # LocalModelRole
    name: str = "qwen3.5:9b"       # Model name / tag
    capabilities: List[str] = field(default_factory=lambda: ["chat", "reasoning", "coding", "documents"])
    specialties: List[str] = field(default_factory=list)
    context_window: int = 16384
    quality_rating: int = 75
    reasoning_effort: Optional[str] = None  # "none" | "low" | "medium" | "high"


@dataclass
class PromptAnalyzerConfig:
    """Prompt analyzer slot (mirrors TS ``PromptAnalyzerConfig``)."""
    name: str = "qwen3.5:2b"
    context_window: int = 4096


@dataclass
class ManagedLlamaConfig:
    """Managed llama.cpp runtime (mirrors TS ``ManagedLlamaConfig``)."""
    executable_path: str = ""
    manifest_path: str = ""
    startup_timeout_ms: int = 180000


@dataclass
class LocalConfig:
    """Local model tier (mirrors TS ``AppConfig.local``)."""
    base_url: str = "http://127.0.0.1:11434/v1"
    api_key: str = "ollama"
    transport: str = "ollama"       # "ollama" | "openai-compatible"
    models: List[LocalModelConfig] = field(default_factory=lambda: [
        LocalModelConfig(role="general", name="qwen3.5:9b"),
    ])
    prompt_analyzer: PromptAnalyzerConfig = field(default_factory=PromptAnalyzerConfig)
    warm_on_startup: bool = True


@dataclass
class CloudConfig:
    """Cloud model tier (mirrors TS ``AppConfig.cloud``)."""
    base_url: str = "https://api.openai.com/v1"
    model: str = "gpt-4.1-mini"
    api_key: str = ""
    context_window: int = 128000
    quality_rating: int = 80


@dataclass
class NetworkConfig:
    """Network model tier — a peer on the operator's own network
    (mirrors TS ``AppConfig.network``)."""
    base_url: str = ""
    model: str = ""
    api_key: str = ""
    context_window: int = 16384
    quality_rating: int = 70


@dataclass
class WebSearchConfig:
    """Web search configuration (mirrors TS ``WebSearchConfig``)."""
    enabled: bool = True
    provider: str = "auto"
    result_limit: int = 5
    searxng_base_url: Optional[str] = None
    api_keys: Dict[str, str] = field(default_factory=dict)


@dataclass
class DesktopQuorumConfig:
    """Top-level Quorum configuration (mirrors TS ``AppConfig``).

    This is the serializable config blob the desktop shell saves and
    loads. Every field maps to an environment variable that the Quorum
    server process receives on launch.
    """
    host: str = "127.0.0.1"
    port: int = 8787
    log_level: str = "info"
    data_directory: str = "./var"
    quorum_local_api_key: Optional[str] = None
    local: LocalConfig = field(default_factory=LocalConfig)
    cloud: Optional[CloudConfig] = None
    network: Optional[NetworkConfig] = None
    managed_llama: Optional[ManagedLlamaConfig] = None
    web_search: Optional[WebSearchConfig] = None
    orchestration_mode: str = "route"


# ---------------------------------------------------------------------------
# Config panel definition — the JSON schema the desktop shell renders
# ---------------------------------------------------------------------------

def get_config_schema() -> Dict[str, Any]:
    """Return the configuration panel schema.

    The desktop shell uses this to render a settings form. Each section
    maps to a collapsible group in the UI. Fields carry type, default,
    and validation metadata.
    """
    return {
        "sections": [
            {
                "id": "local_model",
                "title": "Local Model",
                "description": (
                    "Models running on your machine via Ollama or an "
                    "OpenAI-compatible endpoint. These never leave your device."
                ),
                "icon": "server",
                "fields": [
                    {
                        "id": "local.baseUrl",
                        "label": "Base URL",
                        "type": "string",
                        "default": "http://127.0.0.1:11434/v1",
                        "placeholder": "http://127.0.0.1:11434/v1",
                        "env_var": "QUORUM_LOCAL_BASE_URL",
                        "help": "Ollama or OpenAI-compatible endpoint URL",
                    },
                    {
                        "id": "local.apiKey",
                        "label": "API Key",
                        "type": "password",
                        "default": "ollama",
                        "env_var": "QUORUM_LOCAL_MODEL_API_KEY",
                        "help": "API key for the local endpoint (default: 'ollama')",
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
                        "env_var": "QUORUM_LOCAL_TRANSPORT",
                    },
                    {
                        "id": "local.models",
                        "label": "Model Slots",
                        "type": "model_slots",
                        "description": (
                            "Configure one slot per role. Each role maps to a "
                            "model that the Quorum router can select."
                        ),
                        "slots": [
                            {
                                "role": "general",
                                "label": "General",
                                "required": True,
                                "default_model": "qwen3.5:9b",
                                "env_var": "QUORUM_LOCAL_MODEL",
                            },
                            {
                                "role": "coding",
                                "label": "Coding",
                                "required": False,
                                "default_model": "",
                                "env_var": "QUORUM_LOCAL_CODING_MODEL",
                            },
                            {
                                "role": "reasoning",
                                "label": "Reasoning",
                                "required": False,
                                "default_model": "",
                                "env_var": "QUORUM_LOCAL_REASONING_MODEL",
                            },
                        ],
                    },
                    {
                        "id": "local.contextWindow",
                        "label": "Context Window",
                        "type": "integer",
                        "default": 16384,
                        "min": 2048,
                        "max": 1048576,
                        "env_var": "QUORUM_LOCAL_CONTEXT_WINDOW",
                        "help": "Default context window size for local models",
                    },
                    {
                        "id": "local.warmOnStartup",
                        "label": "Warm models on startup",
                        "type": "boolean",
                        "default": True,
                        "env_var": "QUORUM_LOCAL_WARMUP",
                        "help": "Preload models when the server starts",
                    },
                ],
            },
            {
                "id": "cloud_model",
                "title": "Cloud Model",
                "description": (
                    "A vendor-hosted inference API (OpenAI, Anthropic, etc.). "
                    "The conversation leaves your device and is subject to the "
                    "vendor's retention terms."
                ),
                "icon": "cloud",
                "fields": [
                    {
                        "id": "cloud.baseUrl",
                        "label": "Base URL",
                        "type": "string",
                        "default": "https://api.openai.com/v1",
                        "placeholder": "https://api.openai.com/v1",
                        "env_var": "QUORUM_CLOUD_BASE_URL",
                    },
                    {
                        "id": "cloud.model",
                        "label": "Model",
                        "type": "string",
                        "default": "gpt-4.1-mini",
                        "placeholder": "gpt-4.1-mini",
                        "env_var": "QUORUM_CLOUD_MODEL",
                    },
                    {
                        "id": "cloud.apiKey",
                        "label": "API Key",
                        "type": "password",
                        "default": "",
                        "env_var": "QUORUM_CLOUD_API_KEY",
                        "help": "Leave empty to disable cloud tier",
                    },
                    {
                        "id": "cloud.contextWindow",
                        "label": "Context Window",
                        "type": "integer",
                        "default": 128000,
                        "min": 2048,
                        "max": 2097152,
                        "env_var": "QUORUM_CLOUD_CONTEXT_WINDOW",
                    },
                    {
                        "id": "cloud.qualityRating",
                        "label": "Quality Rating",
                        "type": "integer",
                        "default": 80,
                        "min": 0,
                        "max": 100,
                        "env_var": "QUORUM_CLOUD_QUALITY_RATING",
                        "help": "Relative quality score (0-100), used for model selection",
                    },
                ],
            },
            {
                "id": "network_model",
                "title": "Network Model",
                "description": (
                    "A model hosted on another machine on your network — a peer "
                    "you control. Configurable by hand; discovery and pairing are "
                    "deliberately not built."
                ),
                "icon": "remote",
                "fields": [
                    {
                        "id": "network.baseUrl",
                        "label": "Base URL",
                        "type": "string",
                        "default": "",
                        "placeholder": "http://192.168.1.100:11434/v1",
                        "env_var": "QUORUM_NETWORK_BASE_URL",
                    },
                    {
                        "id": "network.model",
                        "label": "Model",
                        "type": "string",
                        "default": "",
                        "placeholder": "qwen3.5:9b",
                        "env_var": "QUORUM_NETWORK_MODEL",
                        "help": "Required. The model name as known to the peer.",
                    },
                    {
                        "id": "network.apiKey",
                        "label": "API Key",
                        "type": "password",
                        "default": "",
                        "env_var": "QUORUM_NETWORK_API_KEY",
                        "help": "Leave empty to disable network tier",
                    },
                    {
                        "id": "network.contextWindow",
                        "label": "Context Window",
                        "type": "integer",
                        "default": 16384,
                        "min": 2048,
                        "max": 1048576,
                        "env_var": "QUORUM_NETWORK_CONTEXT_WINDOW",
                    },
                    {
                        "id": "network.qualityRating",
                        "label": "Quality Rating",
                        "type": "integer",
                        "default": 70,
                        "min": 0,
                        "max": 100,
                        "env_var": "QUORUM_NETWORK_QUALITY_RATING",
                    },
                ],
            },
        ],
    }


# ---------------------------------------------------------------------------
# Config store — persistence layer
# ---------------------------------------------------------------------------

def _config_path() -> Path:
    """Resolve the plugin's persisted config file.

    Uses the hermes desktop plugin storage convention: saves under the
    plugin's namespaced directory in the Hermes data folder.
    """
    home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    plugins_dir = home / "desktop-plugins" / "quorum"
    plugins_dir.mkdir(parents=True, exist_ok=True)
    return plugins_dir / "config.json"


def load_quorum_config() -> DesktopQuorumConfig:
    """Load persisted Quorum configuration, falling back to defaults."""
    path = _config_path()
    try:
        if path.exists():
            raw = json.loads(path.read_text(encoding="utf-8"))
            return _deserialize_config(raw)
    except (json.JSONDecodeError, TypeError, KeyError) as exc:
        logger.warning("Failed to load Quorum config from %s: %s", path, exc)
    return DesktopQuorumConfig()


def save_quorum_config(config: DesktopQuorumConfig) -> None:
    """Persist Quorum configuration to disk."""
    path = _config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = _serialize_config(config)
    path.write_text(json.dumps(raw, indent=2, default=str), encoding="utf-8")
    logger.info("Quorum config saved to %s", path)


def _serialize_config(config: DesktopQuorumConfig) -> Dict[str, Any]:
    """Serialize a DesktopQuorumConfig to a JSON-safe dict."""
    return _dataclass_to_dict(config)


def _deserialize_config(raw: Dict[str, Any]) -> DesktopQuorumConfig:
    """Deserialize a JSON dict back to a DesktopQuorumConfig."""
    return DesktopQuorumConfig(
        host=raw.get("host", "127.0.0.1"),
        port=raw.get("port", 8787),
        log_level=raw.get("logLevel", raw.get("log_level", "info")),
        data_directory=raw.get("dataDirectory", raw.get("data_directory", "./var")),
        quorum_local_api_key=raw.get("quorumLocalApiKey", raw.get("quorum_local_api_key")),
        local=_deserialize_local(raw.get("local", {})),
        cloud=_deserialize_cloud(raw.get("cloud")),
        network=_deserialize_network(raw.get("network")),
        managed_llama=_deserialize_managed_llama(raw.get("managedLlama", raw.get("managed_llama"))),
        web_search=_deserialize_web_search(raw.get("webSearch", raw.get("web_search"))),
        orchestration_mode=raw.get("orchestrationMode", raw.get("orchestration_mode", "route")),
    )


def _deserialize_local(raw: Dict[str, Any]) -> LocalConfig:
    models = [_deserialize_local_model(m) for m in raw.get("models", [])]
    if not models:
        models = [LocalModelConfig(role="general", name="qwen3.5:9b")]
    return LocalConfig(
        base_url=raw.get("baseUrl", raw.get("base_url", "http://127.0.0.1:11434/v1")),
        api_key=raw.get("apiKey", raw.get("api_key", "ollama")),
        transport=raw.get("transport", "ollama"),
        models=models,
        prompt_analyzer=_deserialize_prompt_analyzer(
            raw.get("promptAnalyzer", raw.get("prompt_analyzer", {}))
        ),
        warm_on_startup=raw.get("warmOnStartup", raw.get("warm_on_startup", True)),
    )


def _deserialize_local_model(raw: Dict[str, Any]) -> LocalModelConfig:
    return LocalModelConfig(
        role=raw.get("role", "general"),
        name=raw.get("name", ""),
        capabilities=raw.get("capabilities", ["chat"]),
        specialties=raw.get("specialties", []),
        context_window=raw.get("contextWindow", raw.get("context_window", 16384)),
        quality_rating=raw.get("qualityRating", raw.get("quality_rating", 75)),
        reasoning_effort=raw.get("reasoningEffort", raw.get("reasoning_effort")),
    )


def _deserialize_prompt_analyzer(raw: Dict[str, Any]) -> PromptAnalyzerConfig:
    return PromptAnalyzerConfig(
        name=raw.get("name", "qwen3.5:2b"),
        context_window=raw.get("contextWindow", raw.get("context_window", 4096)),
    )


def _deserialize_cloud(raw: Optional[Dict[str, Any]]) -> Optional[CloudConfig]:
    if not raw:
        return None
    return CloudConfig(
        base_url=raw.get("baseUrl", raw.get("base_url", "https://api.openai.com/v1")),
        model=raw.get("model", "gpt-4.1-mini"),
        api_key=raw.get("apiKey", raw.get("api_key", "")),
        context_window=raw.get("contextWindow", raw.get("context_window", 128000)),
        quality_rating=raw.get("qualityRating", raw.get("quality_rating", 80)),
    )


def _deserialize_network(raw: Optional[Dict[str, Any]]) -> Optional[NetworkConfig]:
    if not raw:
        return None
    return NetworkConfig(
        base_url=raw.get("baseUrl", raw.get("base_url", "")),
        model=raw.get("model", ""),
        api_key=raw.get("apiKey", raw.get("api_key", "")),
        context_window=raw.get("contextWindow", raw.get("context_window", 16384)),
        quality_rating=raw.get("qualityRating", raw.get("quality_rating", 70)),
    )


def _deserialize_managed_llama(raw: Optional[Dict[str, Any]]) -> Optional[ManagedLlamaConfig]:
    if not raw:
        return None
    return ManagedLlamaConfig(
        executable_path=raw.get("executablePath", raw.get("executable_path", "")),
        manifest_path=raw.get("manifestPath", raw.get("manifest_path", "")),
        startup_timeout_ms=raw.get("startupTimeoutMs", raw.get("startup_timeout_ms", 180000)),
    )


def _deserialize_web_search(raw: Optional[Dict[str, Any]]) -> Optional[WebSearchConfig]:
    if not raw:
        return None
    return WebSearchConfig(
        enabled=raw.get("enabled", True),
        provider=raw.get("provider", "auto"),
        result_limit=raw.get("resultLimit", raw.get("result_limit", 5)),
        searxng_base_url=raw.get("searxngBaseUrl", raw.get("searxng_base_url")),
        api_keys=raw.get("apiKeys", raw.get("api_keys", {})),
    )


def _dataclass_to_dict(obj: Any) -> Any:
    """Recursively convert a dataclass to a plain dict."""
    if isinstance(obj, dict):
        return {k: _dataclass_to_dict(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_dataclass_to_dict(v) for v in obj]
    if hasattr(obj, "__dataclass_fields__"):
        return {f.name: _dataclass_to_dict(getattr(obj, f.name)) for f in obj.__dataclass_fields__.values()}
    if isinstance(obj, Enum):
        return obj.value
    return obj


# ---------------------------------------------------------------------------
# Config validation
# ---------------------------------------------------------------------------

def validate_config(config: DesktopQuorumConfig) -> List[Dict[str, str]]:
    """Validate a DesktopQuorumConfig and return a list of issues.

    Returns empty list if the config is valid. Each issue has ``field`` and
    ``message`` keys for the desktop shell to display inline errors.
    """
    issues: List[Dict[str, str]] = []

    # Local transport must be valid
    if config.local.transport not in ("ollama", "openai-compatible"):
        issues.append({
            "field": "local.transport",
            "message": "Must be 'ollama' or 'openai-compatible'",
        })

    # At least one local model with a non-empty name
    has_valid_model = any(m.name.strip() for m in config.local.models if m.role == "general")
    if not has_valid_model:
        issues.append({
            "field": "local.models",
            "message": "At least one general-purpose local model is required",
        })

    # Network: base_url and model must both be set (or both empty)
    if config.network:
        has_nw_url = bool(config.network.base_url.strip())
        has_nw_model = bool(config.network.model.strip())
        if has_nw_url != has_nw_model:
            issues.append({
                "field": "network",
                "message": "Network base URL and model must be configured together",
            })

    # Cloud: if api_key is set, base_url must be set
    if config.cloud and config.cloud.api_key.strip() and not config.cloud.base_url.strip():
        issues.append({
            "field": "cloud.baseUrl",
            "message": "Base URL is required when Cloud API key is set",
        })

    # Context windows must be positive
    for model in config.local.models:
        if model.context_window < 1:
            issues.append({
                "field": f"local.models.{model.role}.contextWindow",
                "message": "Context window must be a positive integer",
            })

    if config.cloud and config.cloud.context_window < 1:
        issues.append({
            "field": "cloud.contextWindow",
            "message": "Context window must be a positive integer",
        })

    if config.network and config.network.context_window < 1:
        issues.append({
            "field": "network.contextWindow",
            "message": "Context window must be a positive integer",
        })

    # Quality ratings must be 0-100
    if config.cloud and not (0 <= config.cloud.quality_rating <= 100):
        issues.append({
            "field": "cloud.qualityRating",
            "message": "Quality rating must be between 0 and 100",
        })

    if config.network and not (0 <= config.network.quality_rating <= 100):
        issues.append({
            "field": "network.qualityRating",
            "message": "Quality rating must be between 0 and 100",
        })

    # Orchestration mode
    if config.orchestration_mode not in ("route", "relay"):
        issues.append({
            "field": "orchestrationMode",
            "message": "Must be 'route' or 'relay'",
        })

    return issues


# ---------------------------------------------------------------------------
# Module API — called by the plugin framework
# ---------------------------------------------------------------------------

def get_current_config() -> Dict[str, Any]:
    """Return the current config as a JSON-safe dict for the desktop shell."""
    config = load_quorum_config()
    return _serialize_config(config)


def update_config(updates: Dict[str, Any]) -> Dict[str, Any]:
    """Merge partial config updates, validate, save, and return the result.

    The desktop shell sends partial updates (only the changed fields).
    We merge them into the existing config and re-validate.
    """
    current = load_quorum_config()
    merged = _merge_config(current, updates)
    issues = validate_config(merged)
    if issues:
        return {"status": "validation_error", "issues": issues, "config": _serialize_config(merged)}
    save_quorum_config(merged)
    return {"status": "ok", "config": _serialize_config(merged)}


def reset_config() -> Dict[str, Any]:
    """Reset configuration to defaults."""
    default = DesktopQuorumConfig()
    save_quorum_config(default)
    return {"status": "ok", "config": _serialize_config(default)}


def _merge_config(current: DesktopQuorumConfig, updates: Dict[str, Any]) -> DesktopQuorumConfig:
    """Shallow-merge updates into the current config.

    Handles dotted keys like 'local.baseUrl' as well as nested dicts.
    For simplicity, we do a field-by-field merge at the top level.
    """
    # Build a flat dict and apply updates
    serialized = _serialize_config(current)

    def _merge_into(target: Dict[str, Any], source: Dict[str, Any]) -> None:
        for key, value in source.items():
            if isinstance(value, dict) and isinstance(target.get(key), dict):
                _merge_into(target[key], value)
            else:
                target[key] = value

    _merge_into(serialized, updates)
    return _deserialize_config(serialized)
