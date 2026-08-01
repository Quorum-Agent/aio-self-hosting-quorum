"""Recorded catalog payloads for spike 003 — no network.

Shapes match the real endpoints (verified against docs):
- Ollama /api/show (v0.5+: includes capabilities list)
- OpenRouter GET /api/v1/models
"""

OLLAMA_SHOW_QWEN = {
    "modelfile": "...",
    "parameters": "...",
    "template": "...",
    "details": {
        "family": "qwen35",
        "parameter_size": "9.8B",
        "quantization_level": "Q4_K_M",
    },
    "model_info": {
        "general.architecture": "qwen35",
        "qwen35.context_length": 32768,
    },
    "capabilities": ["completion", "tools", "thinking"],
}

OLLAMA_SHOW_GEMMA_VISION = {
    "details": {"family": "gemma3", "parameter_size": "12.2B"},
    "model_info": {
        "general.architecture": "gemma3",
        "gemma3.context_length": 131072,
    },
    "capabilities": ["completion", "vision"],
}

OLLAMA_SHOW_NO_CAPABILITIES_FIELD = {
    # Older servers omit `capabilities` entirely — bridge must degrade to chat-only.
    "details": {"family": "llama"},
    "model_info": {"llama.context_length": 8192},
}

OLLAMA_SHOW_NO_CONTEXT = {
    "details": {"family": "mystery"},
    "model_info": {},
}

OPENROUTER_MODEL_CLAUDE = {
    "id": "anthropic/claude-sonnet-4.5",
    "name": "Anthropic: Claude Sonnet 4.5",
    "context_length": 200000,
    "architecture": {"modality": "text+image->text"},
    "supported_parameters": ["tools", "tool_choice", "reasoning", "max_tokens"],
    "pricing": {"prompt": "0.000003", "completion": "0.000015"},
    "top_provider": {"context_length": 200000},
}

OPENROUTER_MODEL_DEEPSEEK = {
    "id": "deepseek/deepseek-v4-pro",
    "context_length": 128000,
    "architecture": {"modality": "text->text"},
    "supported_parameters": ["tools", "include_reasoning"],
    "pricing": {"prompt": "0.000001", "completion": "0.000002"},
}

OPENROUTER_MODEL_NO_CONTEXT = {
    "id": "vendor/mystery-model",
    "architecture": {"modality": "text->text"},
}
