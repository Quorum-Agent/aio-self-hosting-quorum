# Migrating from the TypeScript API to Quorum Python Core

This guide covers the migration path from the existing TypeScript-based Quorum API server (`apps/api/`) to the new standalone Python Quorum core (`quorum_core/`).

## Overview

The TypeScript API has served as the primary runtime, handling HTTP/SSE transport, SQLite conversation storage, and model-provider routing. The Python port (`quorum_core`) extracts the policy and orchestration logic into a stdlib-only embeddable core, with the goal of producing a single `Quorum.exe` — no Python or Node.js required on the target machine.

### What stays in TypeScript

- The frontend (`apps/web/`) — React Chat UI, SSE consumer, execution inspector
- The API server (`apps/api/`) — continues as an HTTP/SSE transport layer, talking to `quorum_core` under the hood
- `packages/core/` — the authoritative TS policy engine (kept as reference; Python is the canonical implementation)

### What moves to Python

| TS Component | Python Equivalent | File |
|---|---|---|
| Policy engine | PolicyEngine | `quorum_core/policy.py` |
| Model descriptors | Node, Policy, ExecutionResult | `quorum_core/model.py` |
| Orchestrator | ExecutionEngine | `quorum_core/execution.py` |
| Provider registration | DiscoveryService | `quorum_core/discovery.py` |
| Security invariants | SecurityVerifier | `quorum_core/security.py` |
| Configuration | QuorumConfig | `quorum_core/config.py` |
| Prompt analyzer | PromptAnalyzerConfig (desktop) | `desktop/config_ui.py` |
| Runtime management | ManagedLlamaRuntime → ManagedLlamaConfig | `desktop/config_ui.py` |

---

## Configuration Migration

### TS Config Format

```typescript
// apps/api/src/config.ts
export interface QuorumConfig {
  api: {
    host: string;              // default: "0.0.0.0"
    port: number;              // default: 8000
    cors_origins: string[];    // default: ["*"]
    request_timeout_ms: number; // default: 30000
  };
  model: {
    provider: string;          // default: "openai"
    model_name: string;        // default: "gpt-4"
    temperature: number;       // default: 0.7
    max_tokens: number;        // default: 4096
    top_p: number;             // default: 1.0
    api_key?: string;          // optional
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    format: 'json' | 'text';
    file?: string;
  };
  workspace: {
    root_dir: string;
    cache_dir?: string;
    session_timeout_minutes: number;
  };
  features: {
    enable_streaming: boolean;
    enable_tool_use: boolean;
    enable_telemetry: boolean;
  };
}
```

**File:** `apps/api/src/config.ts`
**YAML representation:** `desktop/defaults.yaml`

### Quorum Python Config Format

```python
from quorum_core.config import QuorumConfig, QuorumCoreConfig

# Core runtime config
cfg = QuorumConfig(
    base_url="http://localhost:8080",
    quorum_size=3,
    timeout_seconds=30.0,
    discovery_interval_seconds=60.0,
    max_retries=3,
    verify_ssl=True,
)

# Desktop plugin config (mirrors TS sections)
from desktop.config_ui import (
    QuorumConfig as DesktopQuorumConfig,
    LocalConfig, CloudConfig, NetworkConfig,
)
```

**File:** `quorum_core/config.py`

### Key Mapping: TS → Quorum

| TS Field (camelCase) | Quorum Field (snake_case) | Notes |
|---|---|---|
| `api.host` | `base_url` host portion | Bound to loopback for local |
| `api.port` | `base_url` port portion | Configurable via `QUORUM_*` env |
| `api.cors_origins` | desktop/config_ui | Moved to plugin config |
| `api.request_timeout_ms` | `timeout_seconds` | Renamed, now in seconds |
| `model.provider` | `local.transport` | Re-routed to local tier |
| `model.model_name` | `local.models[general].name` | Slot-based routing |
| `model.temperature` | embedding-level config | Model-specific in Quorum |
| `model.max_tokens` | `local.models[].context_window` | Re-mapped |
| `model.api_key` | `local.api_key` | Per-tier API keys |
| `logging.level` | `log_level` | Same semantics |
| `workspace.root_dir` | `data_directory` | Renamed |
| `workspace.session_timeout_minutes` | unchanged | In desktop config |
| `features.enable_streaming` | unchanged | In desktop config |
| `features.enable_tool_use` | unchanged | In desktop config |
| `features.enable_telemetry` | unchanged | In desktop config |

### Field Name Convention

All TS fields use **camelCase** (e.g., `modelName`, `corsOrigins`).
All Quorum Python fields use **snake_case** (e.g., `model_name`, `cors_origins`).

The migration layer (`desktop/config_migration.py`) handles this conversion automatically. It:

1. Reads the existing TS-style YAML
2. Recursively converts camelCase keys to snake_case
3. Validates the result against the Quorum config schema
4. Saves in the new format

### Environment Variables

| TS Pattern | Quorum Pattern |
|---|---|
| `QUORUM_API__HOST` | `QUORUM_BASE_URL` (combined host:port) |
| `QUORUM_API__PORT` | Port extracted from `QUORUM_BASE_URL` |
| `QUORUM_MODEL__MODEL_NAME` | `QUORUM_LOCAL_MODEL` |
| `QUORUM_MODEL__API_KEY` | `QUORUM_LOCAL_MODEL_API_KEY` |
| `QUORUM_MODEL__TEMPERATURE` | Per-model config |
| `QUORUM_LOGGING__LEVEL` | `QUORUM_LOG_LEVEL` |
| `QUORUM_WORKSPACE__ROOT_DIR` | `QUORUM_DATA_DIRECTORY` |

---

## Three-Tier Model Architecture (New)

The TS API had a flat `model` section with one provider. Quorum introduces three tiers:

```yaml
# desktop/config_ui.py schema
local:
  base_url: http://127.0.0.1:11434/v1
  api_key: ollama
  transport: ollama          # or "openai-compatible"
  models:
    - role: general
      name: qwen3.5:9b
      capabilities: [chat, reasoning, coding, documents]
    - role: coding
      name: qwen3.5-coder:7b
      capabilities: [coding]
  prompt_analyzer:
    name: qwen3.5:2b
    context_window: 4096
  warm_on_startup: true

cloud:                        # null = disabled
  base_url: https://api.openai.com/v1
  model: gpt-4.1-mini
  api_key: ""                 # set via env
  context_window: 128000

network:                      # null = disabled
  base_url: http://192.168.1.100:11434/v1
  model: qwen3.5:9b
  api_key: ""
  context_window: 16384
```

### Why the change?

The TS API used a single model slot. Quorum routes requests across multiple models based on intent, capability matching, and policy ceilings. This three-tier architecture enables:

- **Local:** Models on your device (never leave)
- **Cloud:** Vendor-hosted APIs (OpenAI, Anthropic)
- **Network:** Peer machines on your local network

The `orchestration_mode` field (`route` vs `relay`) controls whether Quorum acts as a smart router or a transparent relay.

---

## Type Mapping: TS → Python

### Models

| TS Type | Python Equivalent |
|---|---|
| `ModelProvider` | `quorum_core.model.Node` |
| `Policy` | `quorum_core.model.Policy` |
| `ExecutionResult` | `quorum_core.model.ExecutionResult` |
| `NodeStatus` | `quorum_core.model.NodeStatus` |
| `TaskStatus` | `quorum_core.model.TaskStatus` |
| `Orchestrator` | `quorum_core.execution.ExecutionEngine` |
| `RequestCompiler` | `quorum_core.policy.PolicyEngine` |
| `RoutePlanner` | Router logic in `execution.py` |

### Capabilities

```typescript
// TS (packages/core/src/types.ts)
export type Capability =
  | "chat" | "reasoning" | "coding"
  | "vision" | "documents" | "web" | "tools";
```

```python
# Python (desktop/config_ui.py)
class Capability(str, Enum):
    CHAT = "chat"
    REASONING = "reasoning"
    CODING = "coding"
    VISION = "vision"
    DOCUMENTS = "documents"
    WEB = "web"
    TOOLS = "tools"
```

### Execution Locations

```python
class ExecutionLocation(str, Enum):
    DEVICE = "device"    # This physical machine
    LOCAL = "local"      # Localhost server
    NETWORK = "network"  # LAN peer
    REMOTE = "remote"    # Self-hosted remote GPU
    WEB = "web"          # Vendor cloud API
    CLOUD = "cloud"      # Alias for WEB
```

---

## Breaking Changes

| Change | Impact | Migration |
|---|---|---|
| `api.host` + `api.port` → `base_url` | Config format changes | `desktop/config_migration.py` handles translation |
| Single model → Three-tier models | Config structure changes | Old `model` fields map to `local` tier |
| `api.cors_origins` moved | CORS config is in desktop shell now | No user-facing change |
| `request_timeout_ms` → `timeout_seconds` | Unit change from ms to seconds | Migration divides by 1000 |
| `max_retries` added | New field with sensible default (3) | No action needed |
| `discovery_interval_seconds` added | New field for service discovery | Defaults to 60s |
| `verify_ssl` added | SSL verification toggle | Defaults to `true` |

## Non-Breaking Changes

- `logging.level` and `logging.format` semantics are unchanged
- `features.*` flags are unchanged
- `workspace.session_timeout_minutes` is unchanged
- `model.temperature`, `model.max_tokens`, `model.top_p` values are preserved in the migration
- `QUORUM_*` env var pattern is preserved (with updated names)

---

## Migration Steps

### 1. Build the Python executable

```bash
python build/build_exe.py
# Produces: dist/Quorum.exe
```

### 2. Run migration on existing TS config

```bash
python -m quorum_core config migrate --from ts-config.yaml --to quorum-config.json
```

Or programmatically:

```python
from desktop.config_migration import migrate_ts_config

migrated = migrate_ts_config("/path/to/ts/config.yaml")
migrated.save("/path/to/quorum/config.json")
```

### 3. Verify migration

```bash
python -m quorum_core config validate --config quorum-config.json
```

Expected output: `Config validation: PASSED`

### 4. Run E2E tests

```bash
pytest tests/e2e/ -v
```

All tests in `test_config_migration.py` verify the full migration pipeline.

### 5. Clean up TS artifacts (optional)

Once the Quorum Python build is validated:

- `apps/api/` → Keep as HTTP/SSE transport layer, but config is now managed by `quorum_core`
- `packages/core/` → Preserved as reference; Python `quorum_core/` is canonical
- Old `config.yaml` → Migrated; keep as backup

---

## Security Invariants

The security invariants from the TS codebase are preserved and mutation-tested in Python:

| TS Invariant | Python File |
|---|---|
| Snake-case config enforcement | `quorum_core/tests/test_config.py` |
| No external dependencies (stdlib only) | `quorum_core/tests/test_security.py` |
| Execution quorum requirement | `quorum_core/tests/test_execution.py` |
| Policy signature integrity | `quorum_core/tests/test_policy.py` |
| Discovery integrity | `quorum_core/tests/test_discovery.py` |
| No async/await | `quorum_core/tests/test_security.py` |
| No forbidden API patterns | `quorum_core/tests/test_security.py` |

Run: `python -m pytest quorum_core/tests/ -v` (106 tests pass as of PKG-6 baseline)

---

## Architecture Diagram

```
┌──────────────────────────────────────────────┐
│                   Quorum.exe                  │
│  (single executable, Python + llamba bundled) │
├──────────────────────────────────────────────┤
│  desktop/                                     │
│  ├── quorum_plugin.py   (Hermes desktop entry)│
│  ├── tray_menu.py       (system tray UI)      │
│  ├── config_ui.py       (settings panel)      │
│  ├── config_bridge.py   (Hermes ↔ Quorum sync)│
│  ├── config_migration.py(TS → Quorum migration)│
│  └── auto_update.py     (staged rollout)      │
├──────────────────────────────────────────────┤
│  quorum_core/                                 │
│  ├── config.py          (config dataclasses)  │
│  ├── policy.py          (policy engine)       │
│  ├── model.py           (model descriptors)   │
│  ├── execution.py       (execution engine)    │
│  ├── discovery.py       (service discovery)   │
│  └── security.py        (invariant verifier)  │
├──────────────────────────────────────────────┤
│  build/                                       │
│  ├── build_exe.py       (PyInstaller builder) │
│  ├── launcher.py        (runtime entry point) │
│  ├── bundle_binaries.py (llama-server bundler)│
│  └── version.py         (version management)  │
└──────────────────────────────────────────────┘
```

---

## Auto-Update Architecture

The TS API had no built-in auto-update mechanism. Quorum uses Hermes Desktop's updater:

- **Channels:** canary (≤10%), beta (≤50%), stable (100%)
- **Rollout:** deterministic hash of install path → percentage bucket
- **Rollback:** on failure, previous version is restored from backup
- **Integrity:** SHA256 checksum verification before install
- **Idempotent:** re-running update at the same version is a no-op

See `tests/e2e/test_auto_update.py` for the acceptance tests.

---

## Checklist

- [ ] Build `Quorum.exe` via `python build/build_exe.py`
- [ ] Run config migration on existing TS config
- [ ] Validate migrated config
- [ ] Verify 106 core tests pass: `pytest quorum_core/tests/ -v`
- [ ] Verify E2E tests pass: `pytest tests/e2e/ -v`
- [ ] Test install/uninstall lifecycle
- [ ] Test staged auto-update rollout
- [ ] Verify zero residue after uninstall
- [ ] Confirm startup < 3s
- [ ] Confirm first token < 500ms (local models)
