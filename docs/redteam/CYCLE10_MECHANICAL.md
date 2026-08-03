# CYCLE 10 — Red-Team Surface 1: Mechanical

**Date:** 2026-08-02 · **Reviewer:** subagent · **Scope:** installer/, desktop/, tests/e2e/, build/
**Baseline:** 106 core + 76 e2e tests passing, all imports clean

## How to read this

| Tag | Meaning |
| --- | --- |
| **[CONFIRMED]** | Observed in code; traceable to a specific line. |
| **[PLAUSIBLE]** | Reasoned from source structure; not runtime-reproduced. |
| **[INSPECTION]** | Read from source only. Challenge these first. |

IDs are M-01 through M-12 (Mechanical); stable for cross-reference.

---

## M-01 · PyInstaller hiddenimports missing desktop/installer modules [CONFIRMED]

**File:** `build/build_exe.py:104-123`

The generated PyInstaller spec lists hidden imports for `quorum_core.*` modules only:

```python
hiddenimports=[
    'quorum_core',
    'quorum_core.config',
    'quorum_core.model',
    ...
]
```

**Missing from hiddenimports:**
- `desktop.config_bridge` (imported by tray_menu for config ops in the bundled exe)
- `desktop.auto_update` (if update check runs from within the bundled exe)
- `installer.checksums` (imported by `desktop.auto_update`)

PyInstaller's static analysis will not discover these because they're imported dynamically or via cross-package paths (e.g., `desktop.auto_update` doing `from installer.checksums import ...`). The launcher at `build/launcher.py` only chains to `quorum_core.__main__`, so any desktop plugin functionality that relies on these modules will fail with `ModuleNotFoundError` at runtime inside the frozen executable.

**Additionally:** `desktop/quorum_plugin.py` imports `fastapi` (lines 38-39), `asyncio`, and `signal`. Neither `fastapi` nor `asyncio` are in hiddenimports. If the quorum_plugin is intended to run inside the bundled executable, these will cause runtime failures.

**Recommendation:** Add `--hidden-import` flags or extend the spec's `hiddenimports` list with all modules reachable from the launcher, including `desktop.*` and `installer.checksums`. If `quorum_plugin.py` is NOT intended for the bundled exe (only for Hermes desktop plugin use), document this boundary explicitly.

---

## M-02 · config_bridge vs config_migration path divergence [CONFIRMED]

**Files:** `desktop/config_bridge.py:31`, `desktop/config_migration.py:38-41`

Config bridge hardcodes:
```python
DEFAULT_CONFIG_PATH = Path.home() / ".quorum" / "config.json"   # line 31
```

Config migration resolves target via `HERMES_HOME`:
```python
home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))  # line 38
plugins_dir = home / "desktop-plugins" / "quorum"
```

These produce different paths under the Hermes desktop environment:
- Bridge reads/writes: `~/.quorum/config.json`
- Migration writes: `$HERMES_HOME/desktop-plugins/quorum/config.json`

If `HERMES_HOME` is set (which it is under the desktop shell), the bridge reads a file the migration tool may never have written. The bridge's `get_config()` at line 171 calls `CoreConfig.load(str(resolved))`, which tries the bridge's path first and falls back to defaults — silently ignoring any config the migration tool placed at the `HERMES_HOME`-scoped location.

**Additionally:** `desktop/config_ui.py:393` also uses `HERMES_HOME`:
```python
home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
plugins_dir = home / "desktop-plugins" / "quorum"
```
So config_ui and config_migration agree on one path, but config_bridge uses a different one.

**Recommendation:** Unify on one canonical config path. Either: (a) make config_bridge also resolve via `HERMES_HOME`, or (b) make migration write to `~/.quorum/config.json` where bridge reads it. The current split creates a silent config gap when running under the desktop.

---

## M-03 · github_actions.yml NSIS path escaping is likely wrong [CONFIRMED]

**File:** `installer/github_actions.yml:215`

```yaml
- name: Build NSIS installer (Windows)
  if: matrix.target == 'windows-x86_64'
  shell: bash
  run: |
    makensis /DVERSION="${GITHUB_REF_NAME#v}" /DBUILD_DIR=..\\\\..\\\\dist installer/nsis/quorum.nsi
  continue-on-error: true
```

In a bash shell, `..\\\\..\\\\dist` is **not** `..\\..\\dist` — bash treats `\\` as a literal escaped backslash, producing the string `..\\..\\dist` with single backslashes. But the NSIS `!define BUILD_DIR` expects a path the compiler can locate, and NSIS on Windows uses Windows path separators. If makensis is launched from the repo root (`D:\a\...\repo\`), the relative path `..\..\dist` resolves to `D:\a\...\dist` which might not exist (dist is inside the repo, at `D:\a\...\repo\dist`).

The fallback pwsh step (line 222-223) uses single backslashes:
```powershell
& "makensis.exe" /DVERSION="$version" /DBUILD_DIR="..\..\dist" installer\nsis\quorum.nsi
```

This is also `..\..\dist` (up two from repo root) which goes out of the repo.

**The actual path should be:** relative to the repo root, `dist` is at `./dist`, not `../../dist`. The `..\\..\\dist` appears to be a copy-paste from running makensis from inside `installer/nsis/` but the CI step runs from the repo root (checkout directory).

**Recommendation:** If running from repo root, use `-DBUILD_DIR=dist`. If running from `installer/nsis/`, use `-DBUILD_DIR=..\\..\\dist`. The current path would resolve to the parent of the repo root. This is why `continue-on-error: true` is set — the step is expected to fail.

---

## M-04 · auto_update.py uses exec() for version parsing [PLAUSIBLE]

**File:** `desktop/auto_update.py:71-72`

```python
from build.version import VERSION
parts = VERSION.split(".")
```

And similarly in `build_exe.py:60-62`:
```python
scope = {}
exec(version_file.read_text(), scope)
return scope.get("FULL_VERSION", "0.1.0")
```

`build_exe.py` uses `exec()` on arbitrary file content — a well-known code-injection vector if `build/version.py` is ever modified by an attacker. The `auto_update.py` direct import is safer but will fail if the build directory is not on `sys.path` at runtime (which it won't be in a PyInstaller bundle).

**Risk:** Low in practice (the version file is in the repo and checked at build time). But `exec()` on file content is flagged by static analysis tools and creates a bad pattern precedent.

**Recommendation:** Use `importlib` or a simple regex parse instead of `exec()`. For `auto_update.py`, hardcode a fallback or embed the version at build time via PyInstaller's `--version-file`.

---

## M-05 · auto_update.py verify_download permits unverified binaries [CONFIRMED]

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

The function returns `True` (verification passed) when no checksum is available at all. This means:
1. If the published checksums file is missing from the release
2. If the release notes don't contain the expected hash
3. If local checksum files (`SHA256SUMS`, `checksums.json`) are absent

...the download is accepted with only a warning log. A user running with `--skip-checksums` disabled still gets unverified binaries in this case.

**Recommendation:** Add a `--require-checksums` flag that makes verification mandatory. When no checksum is available, return `False` with a clear error unless the user explicitly opts into unverified downloads. Alternatively, check the checksum from the GitHub release body more aggressively (e.g., parse the markdown block rather than doing `if computed in body`).

---

## M-06 · deb/build_deb.sh hardcodes `python3` binary name [PLAUSIBLE]

**File:** `installer/deb/build_deb.sh:30`

```bash
VERSION=$(python3 -c "import sys; sys.path.insert(0, '$REPO_ROOT/build'); from version import VERSION; print(VERSION)" 2>/dev/null || echo "0.1.0")
```

On systems where Python 3 is only available as `python3.11` or `python3.12` (e.g., some Debian derivatives with alternatives system), this command will fail silently and default to `"0.1.0"`. The same pattern appears in `dmg/build_dmg.sh:39`.

**Recommendation:** Use `python3 -c "..." 2>/dev/null || python -c "..." 2>/dev/null || echo "0.1.0"` to try both common names, or source the version from a text file rather than executing Python.

---

## M-07 · build_dmg.sh uses deprecated `altool` for notarization [CONFIRMED]

**File:** `installer/dmg/build_dmg.sh:324-332`

```bash
xcrun altool --notarize-app \
    --primary-bundle-id "com.quorum.app" \
    --username "$NOTARIZATION_USER" \
    ...
```

Apple deprecated `altool` in fall 2023. New Apple Developer accounts cannot use it; existing accounts may lose access. The script already has a `notarytool` path (line 315), which is the correct modern approach.

**Recommendation:** Remove the `altool` fallback. If keychain profile is not configured, instruct users to set it up rather than falling back to a deprecated tool that will eventually fail.

---

## M-08 · YAML dependency is conditional in source but unconditional in tests [CONFIRMED]

**File:** `desktop/config_migration.py:92-93` vs `tests/e2e/test_config_migration.py:23`

In `config_migration.py`, yaml is imported inside try/except:
```python
if path.suffix in (".yaml", ".yml"):
    try:
        import yaml
        return yaml.safe_load(raw) or {}
    except ImportError:
        pass
```

In `test_config_migration.py`, yaml is imported unconditionally at the top:
```python
import yaml
```

If PyYAML is not installed, `test_config_migration.py` will fail to import entirely — all 16 tests in that file crash before reaching the yaml-using tests. The migration module itself handles missing yaml gracefully (falls through to JSON parsing), but the test file does not.

**Recommendation:** Either make `yaml` a test dependency in `pyproject.toml` or guard the yaml import in tests with a `pytest.importorskip("yaml")` for tests that specifically exercise YAML paths.

---

## M-09 · quorum_plugin.py imports asyncio — forbidden by quorum_core invariants [PLAUSIBLE]

**File:** `desktop/quorum_plugin.py:30` vs `quorum_core/tests/test_security.py`

```python
import asyncio
```

`quorum_core` has a security invariant test (`test_no_forbidden_asyncio`) that explicitly forbids asyncio imports in `quorum_core`. The desktop plugin exists outside `quorum_core` so it's technically compliant. However, this creates a runtime requirement: if `quorum_plugin.py` runs inside a PyInstaller bundle (unlikely, since it's a FastAPI-based web server), asyncio and FastAPI must be bundled. More practically: the plugin expects to run inside the Hermes desktop's Python environment where these are available, but that's an implicit contract.

**Recommendation:** Document explicitly which modules are "desktop-only" (require Hermes desktop runtime, FastAPI, asyncio) vs "bundled" (run inside Quorum.exe, stdlib-only). The current code doesn't make this boundary clear.

---

## M-10 · auto_update VERSION_FILE path assumes repo layout [CONFIRMED]

**File:** `desktop/auto_update.py:55`

```python
VERSION_FILE = Path(__file__).parent.parent / "build" / "version.py"
```

This resolves to `desktop/../build/version.py` = `build/version.py` — correct in the source repo. But in a PyInstaller bundle, `__file__` points into the extracted `_MEIPASS` directory, and there is no `../build/` directory. The `_get_current_version()` function has a try/except around the import, falling back to `(0, 1, 0)`, so it degrades gracefully. However, the fallback silently loses the actual version, meaning `check_for_update()` will always report "update available" (comparing `0.1.0` against something higher).

**Recommendation:** Embed the version string at build time (e.g., via PyInstaller's `--version-file` or a generated `__version__` constant), or read it from a known bundled data file rather than a path relative to `__file__`.

---

## M-11 · checksums.py parse_sha256sums accepts invalid hex [INSPECTION]

**File:** `installer/checksums.py:139-150`

```python
parts = line.split(None, 1)
if len(parts) == 2:
    hash_hex, filename = parts
    hash_hex = hash_hex.strip().lower()
    filename = filename.strip()
    if len(hash_hex) == 64 and all(c in "0123456789abcdef" for c in hash_hex):
        checksums[filename] = hash_hex
```

Lines with 64 hex characters but additional trailing content after the filename would be accepted (e.g., `abc123...def  Quorum.exe extra content` — `filename` becomes `Quorum.exe extra content`). The `split(None, 1)` with maxsplit=1 means the filename captures everything after the first whitespace group.

This is not a security vulnerability since a tampered manifest file is already a supply-chain failure mode, but it means corrupt or malformed manifest lines are silently ingested with unexpected filenames rather than rejected.

**Recommendation:** Validate that the filename portion does not contain whitespace. For the standard `SHA256SUMS` format (`hash  filename`), the split should produce exactly two tokens where the second has no internal whitespace.

---

## M-12 · quorum.nsi EnVar plugin is optional — PATH modification can silently fail [PLAUSIBLE]

**File:** `installer/nsis/quorum.nsi:147-152`

```nsis
EnVar::SetHKCU
EnVar::AddValue "PATH" "$INSTDIR"
Pop $0
${If} $0 != 0
  ; Non-fatal: PATH may already have it or EnVar plugin may be absent
${EndIf}
```

The `EnVar` plugin is not a standard NSIS plugin — it must be installed separately. If missing, the installer will either fail on these lines with an error dialog or silently skip PATH modification. The comment acknowledges this but treats it as non-fatal. Users expecting `quorum` to be on their PATH after installation may be confused when it's not.

**Recommendation:** Either bundle the EnVar plugin with the installer build or use NSIS's built-in registry manipulation to add to PATH. At minimum, warn the user if the plugin is absent rather than silently skipping.

---

## Additional observations (non-findings)

These were investigated and found to be correctly handled:

- **Import cycles**: No cycles exist. Dependency graph is a DAG: `installer/` → stdlib only; `desktop/` → `quorum_core` + `installer/`; `quorum_core/` → stdlib only. No back-references.
- **Shebangs**: All `.sh` scripts use `#!/usr/bin/env bash` or `#!/bin/sh` (postinst/prerm). All `.py` scripts use `#!/usr/bin/env python3`.
- **Path handling**: All Python code uses `pathlib.Path` (not `os.path`). The only `os.path` usage is in test fixtures (`os.walk` in conftest.py:186,186), which is appropriate.
- **Platform detection**: `sys.platform` checks are used consistently for platform-specific binary naming and path resolution.
- **postinst/prerm idempotency**: The prerm kills processes before removing symlinks. Config is preserved (`/etc/quorum`) across reinstalls — correctly documented.
- **checksums.py blocking reads**: `compute_sha256` uses 64KB chunked reads — correct for large files.
- **Error handling in migration**: `_load_source` properly tries YAML first, then JSON, with clear error messages — no silent data loss path.
- **auto_update.py GitHub API auth**: `GITHUB_TOKEN` / `GH_TOKEN` env vars are checked with fallback to unauthenticated requests — correct for both public and private repos.

---

## Summary

| Finding | Severity | Impact |
| --- | --- | --- |
| M-01 | High | Desktop/installer modules absent from PyInstaller bundle → runtime ModuleNotFoundError |
| M-02 | Medium | Config written by migration is invisible to config_bridge under HERMES_HOME |
| M-03 | Medium | NSIS build step in CI uses wrong relative path, masked by continue-on-error |
| M-04 | Low | exec() on version file; auto_update loses version in bundled exe |
| M-05 | High | Unverified binary downloads permitted when checksums are absent |
| M-06 | Low | python3 binary name assumption in deb/dmg build scripts |
| M-07 | Low | Deprecated altool usage in macOS notarization |
| M-08 | Low | YAML import unconditional in tests but conditional in source |
| M-09 | Info | asyncio/FastAPI boundary between bundled-exe and desktop-plugin is undocumented |
| M-10 | Medium | auto_update version detection broken in PyInstaller bundle |
| M-11 | Low | Malformed SHA256SUMS lines silently ingested with unexpected filenames |
| M-12 | Low | Non-standard NSIS EnVar plugin silently skipped |
