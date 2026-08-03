// apps/api/src/config.ts — AUTHORITATIVE TypeScript schema for Quorum config
// This file defines the canonical config keys, their types, and defaults.
// All config consumers MUST derive from this schema.

export interface QuorumConfig {
  // --- API Settings ---
  api: {
    host: string;           // default: "0.0.0.0"
    port: number;           // default: 8000
    cors_origins: string[]; // default: ["*"]
    request_timeout_ms: number; // default: 30000
  };

  // --- Model Settings ---
  model: {
    provider: string;       // default: "openai"
    model_name: string;     // default: "gpt-4"
    temperature: number;    // default: 0.7, range: [0.0, 2.0]
    max_tokens: number;     // default: 4096, range: [1, 128000]
    top_p: number;          // default: 1.0, range: [0.0, 1.0]
    api_key?: string;       // optional, can be set via env QUORUM_MODEL_API_KEY
  };

  // --- Logging Settings ---
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';  // default: "info"
    format: 'json' | 'text';                      // default: "json"
    file?: string;                                // optional log file path
  };

  // --- Workspace Settings ---
  workspace: {
    root_dir: string;            // default: "~/.quorum"
    cache_dir?: string;          // optional, default: "<root_dir>/cache"
    session_timeout_minutes: number; // default: 60, range: [1, 1440]
  };

  // --- Feature Flags ---
  features: {
    enable_streaming: boolean;    // default: true
    enable_tool_use: boolean;     // default: true
    enable_telemetry: boolean;    // default: false
  };
}

// Default values — must match desktop/defaults.yaml
export const DEFAULT_CONFIG: QuorumConfig = {
  api: {
    host: "0.0.0.0",
    port: 8000,
    cors_origins: ["*"],
    request_timeout_ms: 30000,
  },
  model: {
    provider: "openai",
    model_name: "gpt-4",
    temperature: 0.7,
    max_tokens: 4096,
    top_p: 1.0,
  },
  logging: {
    level: "info",
    format: "json",
  },
  workspace: {
    root_dir: "~/.quorum",
    session_timeout_minutes: 60,
  },
  features: {
    enable_streaming: true,
    enable_tool_use: true,
    enable_telemetry: false,
  },
};

// Env var override pattern: QUORUM_<SECTION>_<KEY> (uppercase, double-underscore nested)
// e.g. QUORUM_API__PORT=9000, QUORUM_MODEL__TEMPERATURE=0.5, QUORUM_LOGGING__LEVEL=debug
// Nested keys use double-underscore for nesting depth > 1 (consistent with Python convention)
// e.g. QUORUM_MODEL__API_KEY overrides model.api_key
