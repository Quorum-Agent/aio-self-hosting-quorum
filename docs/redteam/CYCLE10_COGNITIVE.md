# CYCLE 10 RED-TEAM FINDINGS — SURFACE 3: Cognitive

> **Date:** 2026-08-02  
> **Scope:** Config precedence logic, migration edge cases, provider fallback loops, model mismatch, version skew  
> **Code reviewed:** `desktop/config_migration.py`, `desktop/config_bridge.py`, `desktop/config_ui.py`, `desktop/auto_update.py`, `desktop/quorum_plugin.py`, `desktop/tray_menu.py`, `quorum_core/config.py`, `quorum_core/execution.py`, `quorum_core/discovery.py`, `quorum_core/model.py`, `quorum_core/policy.py`, `installer/checksums.py`, `tests/e2e/*`, `docs/migration_from_ts_api.md`  
> **Prior art:** REDTEAM-FINDINGS.md (Q-20, Q-57, Q-70 — cognitive-relevant prior findings in TS codebase; none specific to these new Python modules)

---

## Summary

20 cognitive issues found across four categories: **config precedence** (6 issues), **migration edge cases** (4 issues), **provider/model mismatch** (4 issues), and **version skew** (6 issues). The most severe is the three-way config path conflict (COG-1) where the core runtime, desktop settings panel, and config bridge each read from different files with different formats, making it possible for settings changes to have no effect on runtime behavior.

---

## 1. CONFIG PRECEDENCE LOGIC

### COG-1 · Three-way config path conflict (SEVERE)

**Files:** `quorum_core/config.py:94-118`, `desktop/config_ui.py:387-396`, `desktop/config_bridge.py:31`

Three competing config paths with no synchronization:

| Component | Config Path | Format |
|---|---|---|
| `quorum_core.config.QuorumConfig.load()` | `~/.quorum/config.json` (or `$QUORUM_CONFIG`) | Flat snake_case: `base_url`, `quorum_size` |
| `desktop/config_ui.load_quorum_config()` | `$HERMES_HOME/desktop-plugins/quorum/config.json` | Nested camelCase: `host`, `local.baseUrl`, `cloud.model` |
| `desktop/config_bridge.get_config()` | `~/.quorum/config.json` (hardcoded) | Sectioned: `server.base_url`, `quorum.quorum_size` |

**Consequence:** When `HERMES_HOME` is set to a non-default path, the settings panel writes to `$HERMES_HOME/desktop-plugins/quorum/config.json` but `quorum_core` reads from `~/.quorum/config.json`. The user changes settings in the panel, the runtime never sees them. The config bridge claims to "read the SAME config file that quorum_core.config uses" (config_bridge.py line 5-6) but this is only true when `HERMES_HOME` defaults to `~/.hermes` — the bridge actually reads `~/.quorum/config.json`, not the Hermes path.

**Code evidence:**
```python
# config_bridge.py:31 — hardcoded, ignores HERMES_HOME
DEFAULT_CONFIG_PATH = Path.home() / ".quorum" / "config.json"

# config_ui.py:393 — respects HERMES_HOME
home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
plugins_dir = home / "desktop-plugins" / "quorum"
return plugins_dir / "config.json"

# quorum_core/config.py:107-108 — default search path
Path.home() / ".quorum" / "config.json"
```

**Recommendation:** Consolidate to a single config file. If separation is intentional, add a config-bridge sync mechanism and document the precedence clearly.

---

### COG-2 · config_bridge writes quorum_core format, config_ui writes desktop format — silent divergence

**Files:** `desktop/config_bridge.py:229-238`, `desktop/config_ui.py:411-417`

`config_bridge.update_config()` saves using `validated.to_dict()` (flat: `base_url`, `quorum_size`, etc.), while `config_ui.save_quorum_config()` saves using `_serialize_config()` (nested: `host`, `port`, `local.baseUrl`, `cloud.model`).

These are entirely different JSON schemas. If both write to the same file, the last writer wins and the other component silently breaks on next read. If they write to different files (as they currently do), there's no cross-validation.

**Code evidence:**
```python
# config_bridge.py:231 — saves flat quorum_core format
save_data = validated.to_dict()
# = {"base_url": "...", "quorum_size": 3, "timeout_seconds": 30.0, ...}

# config_ui.py:415 — saves nested desktop format
raw = _serialize_config(config)
# = {"host": "...", "port": 8787, "local": {"baseUrl": "...", "models": [...]}, ...}
```

**Recommendation:** Unify on one format. If two formats must coexist, add a format version marker and fail-fast on mismatch.

---

### COG-3 · config_bridge._core_to_desktop() produces format incompatible with config_ui

**File:** `desktop/config_bridge.py:89-109`

The bridge's `_core_to_desktop()` produces a section-based dict (`{"server": {"base_url": ...}, "quorum": {"quorum_size": ...}, "operations": {...}}`) but `config_ui._deserialize_config()` expects a completely different structure (`{"host": "...", "port": ..., "local": {"baseUrl": ...}}`). The settings panel will never receive bridge-formatted data in a shape it can render.

**Consequence:** If the settings panel calls `config_bridge.get_config()`, it gets a section-based dict that doesn't match the fields in `config_ui.get_config_schema()`. The panel UI renders empty or broken fields.

---

### COG-4 · Env vars override config incorrectly — from_env() bypasses file-based config entirely

**File:** `quorum_core/config.py:121-130`

`QuorumConfig.from_env()` creates a config from env vars only, with no fallback to file-based config. The `load()` method (line 94-118) does NOT merge env vars with the file — it either loads from file OR returns defaults. There's no precedence chain: `env > file > defaults`.

**Consequence:** A user who sets `QUORUM_BASE_URL` in env vars and has a config file with `quorum_size: 5` will silently lose the `quorum_size` setting because `from_env()` never reads the file. Conversely, `load()` never reads env vars.

**Recommendation:** Implement a `load()` that reads from file first, then overlays env vars.

---

### COG-5 · _apply_config_env() only handles camelCase keys — silently drops snake_case

**File:** `desktop/tray_menu.py:429-476`

`_apply_config_env()` accesses `local_cfg.get("baseUrl")`, `cloud_cfg.get("apiKey")`, etc. — all camelCase. If the config dict passed to it uses snake_case (e.g., from `quorum_core.config.to_dict()`), all env var assignments silently fail because the keys don't match.

**Code evidence:**
```python
# tray_menu.py:433 — only checks camelCase
if "baseUrl" in local_cfg:
    env["QUORUM_LOCAL_BASE_URL"] = local_cfg["baseUrl"]
# Snake_case "base_url" from quorum_core.config.to_dict() is silently ignored
```

---

### COG-6 · config_bridge.update_config() preserves panel keys alongside core keys — key collision risk

**File:** `desktop/config_bridge.py:229-236`

```python
save_data = validated.to_dict()  # {"base_url": ..., "quorum_size": ..., ...}
for key in merged:
    if key.startswith("_") or key in ("server", "quorum", "operations"):
        if isinstance(merged[key], dict):
            save_data.setdefault(key, merged[key])
```

This produces a hybrid dict like:
```json
{
  "base_url": "http://localhost:8080",
  "quorum_size": 3,
  "server": {"base_url": "http://localhost:8080", "verify_ssl": true},
  "quorum": {"quorum_size": 3},
  "operations": {...}
}
```

If `quorum_core.config.QuorumConfig.from_dict()` reads this, it silently ignores the panel keys. But if any code later accesses `data["quorum"]["quorum_size"]` vs `data["quorum_size"]`, they'll see the same value from two different keys — a maintenance hazard where one gets updated and the other doesn't.

---

## 2. MIGRATION EDGE CASES

### COG-7 · Migration drops unknown sections silently

**File:** `desktop/config_migration.py:210-213`

`_migrate_ts_to_desktop()` only iterates over a hardcoded list of known sections:
```python
for section in ("local", "cloud", "network", "managedLlama", "managed_llama",
                "webSearch", "web_search"):
    if section in ts_data:
        result[section] = ts_data[section]
```

Any TS config section not in this list (e.g., `api`, `model`, `logging`, `workspace`, `features` — the sections defined in `defaults.yaml` and tested in `test_config_migration.py`) is silently dropped.

**Consequence:** A user migrating from the TS config format described in `migration_from_ts_api.md` would lose their `api`, `model`, `logging`, `workspace`, and `features` settings entirely. The migration code is incompatible with the config format it's documented to migrate from.

---

### COG-8 · Type coercion in validation allows silent truncation

**File:** `desktop/config_migration.py:318-324`

```python
CoreConfig(
    base_url=(data.get("local", {}).get("baseUrl", "http://localhost:8080")),
    quorum_size=int(quorum_size),
    timeout_seconds=float(timeout),
    max_retries=int(max_retries),
)
```

`int(3.7)` → `3` (silent truncation). `float(30)` → `30.0` (OK). `int(True)` → `1` (silent coercion). `int("3")` → `3` (OK). These are caught by the `try/except` at line 325 if they raise, but truncation (3.7 → 3) doesn't raise — it silently loses precision.

**Recommendation:** Check `isinstance()` before coercion, or use `decimal.Decimal` for precision-sensitive values.

---

### COG-9 · _load_source() uses YAML safe_load which drops custom types

**File:** `desktop/config_migration.py:86-110`

`yaml.safe_load()` is used for YAML parsing. This is secure but drops any custom YAML tags (e.g., `!!python/object`) that might be present in user configs. If the TS config used YAML anchors or aliases, they'd be resolved by `safe_load` but any non-standard tags would be silently stripped.

Additionally, the try/except logic at lines 91-110 tries YAML first for `.yaml`/`.yml` files, then JSON, then YAML as fallback for other extensions. A `.json` file that happens to contain valid YAML (since JSON is a subset of YAML) would be parsed as YAML first if it has a `.yaml` extension, which is correct but could mask the fact that the file is actually malformed JSON saved with a `.yaml` extension.

---

### COG-10 · _migrate_core_to_desktop() hardcodes model defaults incompatible with config_ui schema

**File:** `desktop/config_migration.py:117-172`

The migration hardcodes:
```python
"local": {
    "baseUrl": base_url if "localhost" in base_url ...,
    "apiKey": "ollama",
    "transport": "ollama",
    "models": [{"role": "general", "name": "qwen3.5:9b", ...}],
    ...
}
```

But `config_ui.LocalConfig` has `prompt_analyzer`, `warm_on_startup` fields that are not included. The migrated config will fail `config_ui.validate_config()` if those fields are required.

**Consequence:** A config migrated via `_migrate_core_to_desktop()` passes validation in `config_migration.py` (which only checks `_validate_core_fields`) but fails validation in `config_ui.validate_config()` (which checks model slots, transport, etc.).

---

## 3. PROVIDER FALLBACK & MODEL MISMATCH

### COG-11 · No provider fallback mechanism exists in Python core (SEVERE)

**Files:** `quorum_core/execution.py`, `quorum_core/discovery.py`

The `ExecutionEngine.execute()` method (execution.py:50-83) has a single execution path that "collects votes" to reach quorum but has no concept of:
- Trying a local model first, then falling back to cloud
- Provider-specific error handling
- Model availability checking
- Tier-based routing (local → cloud → network)

The TS codebase had fallback chains (REDTEAM-FINDINGS.md references Q-57, Q-70). The Python core has zero fallback infrastructure.

**Code evidence:** `execution.py:97-98` — the vote collection is a mock:
```python
if "vote_count" in task_data:
    return int(task_data["vote_count"])
return self.config.quorum_size  # Always succeeds
```

---

### COG-12 · Three-tier model architecture is defined in config but has no runtime behavior

**Files:** `desktop/config_ui.py:103-163`, `quorum_core/execution.py`

The `config_ui.py` defines a rich model architecture:
- `LocalConfig` with model slots (general, coding, reasoning), capabilities, quality ratings
- `CloudConfig` with provider-specific settings
- `NetworkConfig` with peer model settings
- `OrchestrationMode` (route vs relay)

But `quorum_core/execution.py` has no code that reads or uses any of these. The execution engine doesn't know about model tiers, capabilities, quality ratings, or routing modes. The entire three-tier config is a dead data structure.

**Consequence:** Users configure models, set quality ratings, and assign capabilities, but none of it affects which model actually handles a request. All requests use the same simulated execution path.

---

### COG-13 · Model role slots are configured but never enforced during execution

**Files:** `desktop/config_ui.py:76-84`, `desktop/tray_menu.py:309-337`

The `LocalModelConfig` defines `role` (general/coding/reasoning) and `capabilities` (chat/reasoning/coding/...). The tray menu displays model status by role. But there is no code path in the entire Python codebase that says "for a coding task, use the model with role=coding and capabilities containing coding."

The `tray_menu.handle_model_status()` at line 320-337 reads model configs:
```python
for model_cfg in local_models:
    models.append(ModelStatus(
        role=model_cfg.get("role", "general"),
        ...
        available=quorum_running,  # Simplified: real check hits /api/health
    ))
```
But marks all models as simply "available" based on whether the Quorum process is running, not on whether the specific model is actually loaded/available.

---

### COG-14 · No quality-rating-based model selection

**Files:** `desktop/config_ui.py:83,122,133`, `quorum_core/execution.py`

`CloudConfig` and `NetworkConfig` have `quality_rating` fields (default 80 and 70 respectively), and `LocalModelConfig` has `quality_rating` (default 75). The schema help text says "used for model selection" (line 320). But there is no code in the entire codebase that uses `quality_rating` for any routing decision. The field is dead weight.

---

## 4. VERSION SKEW

### COG-15 · Two competing QuorumConfig classes with same name (critical confusion risk)

**Files:** `quorum_core/config.py:28`, `desktop/config_ui.py:147`

Two different `QuorumConfig` classes exist in the same project:
- `quorum_core.config.QuorumConfig` — flat, frozen dataclass: `base_url`, `quorum_size`, `timeout_seconds`
- `desktop.config_ui.QuorumConfig` — nested, mutable dataclass: `host`, `port`, `local`, `cloud`, `network`

If any module imports the wrong one, it will silently work but produce incorrect results. The import in `config_bridge.py` line 27 uses `from quorum_core.config import QuorumConfig as CoreConfig` (renamed, safe), and `config_migration.py` line 27 uses the same pattern. But `config_ui.py` line 147 defines its own `QuorumConfig` without any renaming or import guard.

**Consequence:** A developer writing `from desktop.config_ui import QuorumConfig` and passing it to `config_bridge.update_config()` will get a `TypeError` or silent data loss because the classes are incompatible.

---

### COG-16 · Config format version skew — no version field in either format

**Files:** `quorum_core/config.py:62-72`, `desktop/config_ui.py:420-439`

Neither config format includes a version field. If the config format changes (e.g., new required fields are added), there's no way to detect that an old config file is incompatible with the new code. The deserialization in both modules uses `.get()` with defaults, which silently accepts old configs with missing fields — the old config "works" but with default values that may be wrong.

**Recommendation:** Add a `"version": 1` field to each config format and fail-fast on unrecognized versions.

---

### COG-17 · defaults.yaml format is incompatible with config_ui deserialization

**Files:** `desktop/defaults.yaml`, `desktop/config_ui.py:425-439`

`defaults.yaml` has the TS-style structure:
```yaml
api:
  host: "0.0.0.0"
  port: 8000
model:
  provider: openai
  model_name: gpt-4
```

But `config_ui._deserialize_config()` expects:
```python
host=raw.get("host", "127.0.0.1"),
port=raw.get("port", 8787),
local=_deserialize_local(raw.get("local", {})),
```

The `defaults.yaml` structure is completely incompatible with `config_ui`. The comment in `defaults.yaml` says it's "GENERATED from quorum_core.config.QuorumConfig" but the actual content matches the TS `apps/api/src/config.ts` format, not the `quorum_core.config.QuorumConfig` format.

---

### COG-18 · migration_from_ts_api.md documents APIs that don't exist

**File:** `docs/migration_from_ts_api.md:276-283`

The documentation says:
```python
from desktop.config_migration import migrate_ts_config
migrated = migrate_ts_config("/path/to/ts/config.yaml")
migrated.save("/path/to/quorum/config.json")
```

But `desktop/config_migration.py` has no `migrate_ts_config` function and no `save()` method. The actual API is:
```python
from desktop.config_migration import migrate
result = migrate(source_path=Path("/path/to/ts/config.yaml"))
# Automatically saves to $HERMES_HOME/desktop-plugins/quorum/config.json
```

The documentation also mentions `python -m quorum_core config migrate` and `python -m quorum_core config validate` which don't exist as CLI commands.

---

### COG-19 · auto_update.py retries with the same failed URL

**File:** `desktop/auto_update.py:244-254`

```python
except urllib.error.HTTPError as e:
    logger.error("Failed to fetch release %s: HTTP %d", version_tag, e.code)
    # Try the full release endpoint
    try:
        full_url = f"{GITHUB_API}/tags/{version_tag}"  # Same URL as line 230!
        req_full = urllib.request.Request(full_url)
        ...
```

The `except` handler constructs the exact same URL (`f"{GITHUB_API}/tags/{version_tag}"`) as the main path (line 230). This is a dead-end retry that will produce the same HTTP error. The comment says "Try the full release endpoint" but the code doesn't actually use a different endpoint.

---

### COG-20 · Checksum verification silently skipped when no manifest exists

**File:** `desktop/auto_update.py:374-380`

```python
# If no checksum available, warn but don't block
logger.warning(
    "No checksum reference found for %s. "
    "Skipping verification (SHA-256: %s)",
    filename, computed[:16] + "...",
)
return True  # Permit without checksum if none available
```

If a release has no published checksum manifest (which is the default for new releases), the auto-updater downloads and installs the binary with zero integrity verification. A compromised release or MITM attack would succeed undetected.

This is a **cognitive issue** (not just security) because the code path discards the security invariant without user awareness — the warning is logged but the user sees "✓ Checksum verified" (line 605) in the CLI output, creating a false sense of security.

---

## Cross-Reference to Prior Findings

| Prior Finding | Relevance |
|---|---|
| **Q-20** (TS codebase): `#createProvider` constructor throw escaping candidate loop | Analogous risk here: COG-11 shows no provider loop exists at all — the Python core has no provider selection logic |
| **Q-57** (TS codebase): Fallback costs one full draft per failing spoke | The Python core has no fallback mechanism (COG-11), eliminating this specific cost but also eliminating the capability entirely |
| **Q-70** (TS codebase): Auto search fallback defeated by shared deadline | Not applicable to Python core — no auto search fallback exists |

No prior cognitive findings in REDTEAM-FINDINGS.md address the Python code in this cycle. All findings above are new.

---

## Severity Summary

| Severity | Count | IDs |
|---|---|---|
| **SEVERE** | 3 | COG-1 (three-way config path conflict), COG-11 (no provider fallback), COG-15 (competing QuorumConfig classes) |
| **HIGH** | 6 | COG-2 (silent format divergence), COG-3 (incompatible bridge format), COG-7 (migration drops sections), COG-12 (three-tier config dead), COG-13 (role slots unused), COG-17 (defaults.yaml incompatible) |
| **MEDIUM** | 7 | COG-4 (env var precedence), COG-5 (camelCase-only env apply), COG-8 (type truncation), COG-14 (quality rating unused), COG-16 (no version field), COG-18 (docs mismatch), COG-20 (checksum skip) |
| **LOW** | 4 | COG-6 (key collision), COG-9 (YAML safe_load), COG-10 (hardcoded migration defaults), COG-19 (dead-end retry) |

---

## Recommended Fixes (Priority Order)

1. **COG-1 + COG-2 + COG-3**: Consolidate to a single config file at a single path. Define one canonical config format. Add a `"format_version": 1` field.
2. **COG-11 + COG-12 + COG-13 + COG-14**: Implement actual provider/model routing in `quorum_core/execution.py` that reads the three-tier config and selects models by capability/quality.
3. **COG-15**: Rename `desktop.config_ui.QuorumConfig` to `DesktopQuorumConfig` to avoid namespace collision.
4. **COG-7**: Fix `_migrate_ts_to_desktop()` to handle the documented TS config sections (`api`, `model`, `logging`, `workspace`, `features`).
5. **COG-17**: Align `defaults.yaml` with the actual config_ui schema, or document which format it represents.
6. **COG-4**: Implement `QuorumConfig.load()` with env var overlay on file-based config.
7. **COG-20**: Make checksum verification required by default with `--skip-checksums` as an explicit opt-in.
8. **COG-18**: Update `migration_from_ts_api.md` to match actual APIs.