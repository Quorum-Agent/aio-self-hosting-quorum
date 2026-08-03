# Red-Team Report: SURFACE 5 — Fixtures

**Date:** 2026-08-02 · **Cycle:** 10 · **Repo:** Quorum (monorepo)
**Scope:** Config migration edge cases, uninstall residue, version skew, cleanup correctness, temp dir isolation
**Prior Art:** No prior REDTEAM-FINDINGS.md existed; clean baseline.

---

## Summary

| Area | Findings | HIGH | MEDIUM | LOW |
|---|---|---|---|---|
| Config Migration Edge Cases | 6 | 1 | 3 | 2 |
| Uninstall Residue | 6 | 2 | 3 | 1 |
| Version Skew | 5 | 2 | 2 | 1 |
| Cleanup Correctness | 6 | 1 | 3 | 2 |
| Temp Dir Isolation | 5 | 1 | 3 | 1 |
| **Total** | **28** | **7** | **14** | **7** |

---

## 1. Config Migration Edge Cases

### 1.1 [HIGH] F5-CM-001 — No backup before destructive migration write

**File:** `desktop/config_migration.py:269-271`
**Root cause:** `migrate()` calls `_target_config_path().write_text(...)` directly, overwriting the target without a `.bak` or backup file. If the write fails halfway (disk full, crash), both the old and new config are lost.
```python
target = _target_config_path()
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(result, indent=2, default=str), encoding="utf-8")  # <-- no atomic write, no backup
```
**Impact:** User config is corrupted with no recovery. The old TS config file still exists but the desktop target is gone/corrupt. Hermes desktop may fail to start.
**Recommendation:** Write to a `.tmp` file, then `os.replace()` (atomic on POSIX) or `shutil.move()`. Optionally keep a `.bak`.

### 1.2 [MEDIUM] F5-CM-002 — Format detection false-positives in `_is_quorum_core_format`

**File:** `desktop/config_migration.py:64-73`
**Root cause:** Detection uses a set-membership count heuristic. A minimal desktop format config that coincidentally has `base_url`, `quorum_size`, etc. can be classified as "core format" and fed through `_migrate_core_to_desktop()`, producing a heavily restructured (wrong) config.
```python
core_count = sum(1 for k in core_fields if k in data)  # base_url, quorum_size, etc.
desktop_count = sum(1 for k in desktop_fields if k in data)  # local, cloud, network, host, port
return core_count >= desktop_count and core_count > 0
```
**Impact:** Migration path misdetected → wrong output. A valid desktop config gets overwritten with a synthetic one.
**Recommendation:** Use a more specific/required marker (e.g. require ALL three of `local`, `cloud`, `network` for desktop format, or require the presence of `_quorum_core` metadata).

### 1.3 [MEDIUM] F5-CM-003 — YAML import is conditional; silent fallback to empty dict or crash

**File:** `desktop/config_migration.py:86-110`
**Root cause:** `PyYAML` is imported via try/except inside `_load_source()`. If it's absent and the file is `.yaml`, loading falls through to JSON (which fails on YAML), then tries yaml again (lines 104-106) — which also fails. The returned empty dict `{}` produces garbage migration.
```python
if path.suffix in (".yaml", ".yml"):
    try:
        import yaml
        return yaml.safe_load(raw) or {}
    except ImportError:
        pass  # falls through to JSON, which fails on YAML content
```
**Impact:** Silent data loss — YAML config silently migrates to an empty desktop config.
**Recommendation:** Add PyYAML as a build/install dependency or bundle `yaml` support. At minimum, fail loudly ("yaml not available") instead of returning `{}`.

### 1.4 [MEDIUM] F5-CM-004 — `_validate_core_fields` silently swallows non-TypeError/ValueError exceptions

**File:** `desktop/config_migration.py:318-331`
**Root cause:** The try/except catches only `(TypeError, ValueError)`. Any other exception from `CoreConfig()` (e.g., `AttributeError` from a missing attribute, `KeyError` from bad dict access) passes silently.
```python
try:
    CoreConfig(base_url=..., quorum_size=int(quorum_size), ...)
except (TypeError, ValueError) as exc:  # <-- narrow catch
    issues.append({...})
```
**Impact:** Invalid config passes validation with no issues reported, then fails at runtime with a confusing error.
**Recommendation:** Catch `Exception` as a fallback with a generic issue message, or let it propagate.

### 1.5 [LOW] F5-CM-005 — Redundant `_discover_old_config_paths()` call in error message

**File:** `desktop/config_migration.py:239-243`
**Root cause:** The `FileNotFoundError` calls `_discover_old_config_paths()` a second time (line 241) to build the error message, when `candidates` from line 237 already has the list.
```python
if not candidates:
    raise FileNotFoundError(
        "No old config files found. Searched: "
        + ", ".join(str(p) for p in _discover_old_config_paths())  # <-- redundant
    )
```
**Impact:** Negligible perf overhead, but demonstrates sloppy coding pattern.
**Recommendation:** Use the already-computed `candidates` list.

### 1.6 [LOW] F5-CM-006 — `_migrate_core_to_desktop` hardcodes default model names

**File:** `desktop/config_migration.py:145-146`
**Root cause:** The migration hardcodes `"qwen3.5:9b"` and `"gpt-4.1-mini"` as model names regardless of what the original config used.
**Impact:** User who had configured different models gets silently switched to the defaults.
**Recommendation:** Preserve or map original model names from the source config, or at least log a prominent warning.

---

## 2. Uninstall Residue

### 2.1 [HIGH] F5-UR-001 — NSIS uninstaller `$LOCALAPPDATA` context bug leaves user data behind

**File:** `installer/nsis/quorum.nsi:194-203`
**Root cause:** After `SetShellVarContext current` (line 195) and cleaning user-local paths, line 198 does `SetShellVarContext all`. Lines 202-203 then reference `$LOCALAPPDATA` in the **machine** context, which is a different physical path entirely. The user's actual `%LOCALAPPDATA%\Quorum` may NOT have been cleaned because the `RMDir /r` on line 196-197 used `$LOCALAPPDATA` in user context, but the `Delete` on line 202 uses it in all-user context — and line 203 does `RMDir` on the all-user `$LOCALAPPDATA` which is NOT the user's actual local app data.
```nsis
SetShellVarContext current
RMDir /r "$LOCALAPPDATA\Quorum"      ; correct: user's localappdata
RMDir /r "$APPDATA\Quorum"           ; correct: user's appdata
SetShellVarContext all
; ... nothing between these that uses the user context paths again ...
Delete "$LOCALAPPDATA\Quorum\*.*"    ; WRONG: machine context!
RMDir "$LOCALAPPDATA\Quorum"         ; WRONG: machine context!
```
**Impact:** On multi-user Windows, the current user's `%LOCALAPPDATA%\Quorum` directory may be left behind (the user-context `RMDir /r` on line 196 should catch it, but the duplicate cleanup in the wrong context on line 202-203 is at best no-op and at worst cleans the wrong thing). More critically, the `SetShellVarContext all` on line 198 means any remaining references to `$LOCALAPPDATA` and `$APPDATA` resolve to `C:\ProgramData`, not the user's profile. **The intended per-user cleanup on lines 202-203 is directed at the wrong location.**
**Recommendation:** Remove lines 202-203 entirely — they're redundant duplicates in the wrong context. The per-user cleanup on lines 195-197 is sufficient.

### 2.2 [HIGH] F5-UR-002 — .deb package has no `postrm` script; `apt purge` leaves config residue

**Files:** `installer/deb/prerm`, `installer/deb/postinst`
**Root cause:** The Debian packaging provides `postinst` and `prerm` scripts but NO `postrm`. The `prerm` explicitly states "Configuration in /etc/quorum/ is preserved." (line 33) — which is correct behavior for `apt remove` but NOT for `apt purge`. Without a `postrm` script, `apt purge quorum` cannot clean `/etc/quorum/config.json`.
```
prerm (line 33): echo "Quorum removed. Configuration in /etc/quorum/ is preserved."
# Missing: postrm that cleans /etc/quorum/ on purge
```
**Impact:** `apt purge quorum` leaves `/etc/quorum/config.json` and the directory on disk. This is a violation of `.deb` packaging standards — `purge` must remove all package-owned config.
**Recommendation:** Add a `postrm` script that checks `$1 = "purge"` and removes `/etc/quorum/`.

### 2.3 [MEDIUM] F5-UR-003 — ROLLBACK_DIR accumulates unbounded old backups

**File:** `desktop/auto_update.py:61, 445-447`
**Root cause:** Every successful `apply_update()` creates a new rollback backup via `shutil.copy2(current_exe, backup_path)` but NEVER cleans old backups. Old `*.exe` files accumulate in `~/.quorum/updates/rollback/` indefinitely.
```python
ROLLBACK_DIR.mkdir(parents=True, exist_ok=True)
backup_path = ROLLBACK_DIR / current_exe.name   # always the same filename
shutil.copy2(str(current_exe), str(backup_path)) # overwrites previous, but...
```
**Impact:** Disk space is OK (single file overwritten per rollback), but after multiple rollback attempts (line 510-511 in `rollback()` function), multiple staged copies accumulate. Also, if the executable name changes between versions, old versions are never pruned.
**Recommendation:** On successful apply, clean ROLLBACK_DIR of old backups. Keep only the most recent N (e.g., 2-3).

### 2.4 [MEDIUM] F5-UR-004 — macOS DMG has no uninstall mechanism whatsoever

**File:** `installer/dmg/build_dmg.sh`
**Root cause:** DMG installs by user dragging `.app` to `/Applications`. No uninstaller script, no launch agent for cleanup, no package receipt. Uninstall is fully manual (drag to Trash), and any runtime data (`~/Library/Application Support/Quorum/`, `~/.quorum/`) persists.
**Impact:** User must manually locate and delete support files. Caches, configs, and runtime data accumulate after uninstall.
**Recommendation:** Document uninstall path in README. Consider a "Reset Quorum" button in the desktop tray menu that cleans support directories.

### 2.5 [MEDIUM] F5-UR-005 — Staged update file not cleaned on `pending_restart` path

**File:** `desktop/auto_update.py:459-463`
**Root cause:** When the running executable is locked and `apply_update()` returns `"pending_restart"`, the staged file (`UPDATE_CACHE_DIR / "Quorum.exe"`) is LEFT in place (the `shutil.move` on line 452 failed, so the staged file remains). This is correct for restart behavior, but if the user subsequently downloads a different update, `download_release()` writes to the SAME path (line 272: `dest = UPDATE_CACHE_DIR / filename`), potentially overwriting without warning.
```python
except (PermissionError, OSError) as e:
    # Keep the staged file — launcher will handle on restart
    return {"status": "pending_restart", ...}
```
**Impact:** Two conflicting staged updates can exist; one silently overwrites the other. Staging marker may reference a file that was already replaced.
**Recommendation:** Version-stamp staged files (e.g., `Quorum-v0.2.0.exe`), or refuse to download if a pending update exists.

### 2.6 [LOW] F5-UR-006 — NSIS PATH cleanup via EnVar plugin is optional/best-effort

**File:** `installer/nsis/quorum.nsi:167-169`
**Root cause:** The `EnVar::AddValue` call during install adds `$INSTDIR` to the user PATH. The uninstaller's `EnVar::DeleteValue` tries to remove it. But if the EnVar plugin is absent (see line 151-152 which treats error as non-fatal), the PATH is never cleaned.
```nsis
EnVar::DeleteValue "PATH" "$INSTDIR"
Pop $0
; No error check here — $0 could indicate failure
```
**Impact:** Stale PATH entries after uninstall; user gets "command not found" for other tools if dir was in path ordering.
**Recommendation:** At minimum, log a warning during uninstall if PATH cleanup fails.

---

## 3. Version Skew

### 3.1 [HIGH] F5-VS-001 — Checksum verification silently permits unverified downloads (version skew)

**File:** `desktop/auto_update.py:329-380`
**Root cause:** `verify_download()` has a series of fallback checks. If none match (e.g., the installed checksum manifest is from an older version and doesn't list the new artifact filename), the function falls through to line 375-380 and **returns True unconditionally**:
```python
# If no checksum available, warn but don't block
logger.warning("No checksum reference found for %s. Skipping verification...", filename, ...)
return True  # Permit without checksum if none available  <-- SECURITY BYPASS
```
**Impact:** If an attacker compromises the GitHub release and changes the binary, but the installed checksum manifest doesn't have a matching entry (version skew), the binary is installed WITH NO VERIFICATION. The warning in the log is the only indication.
**Recommendation:** Return `False` when no checksum reference is found. Add a `--skip-checksums` flag for emergency recovery. Never default to "trust."

### 3.2 [HIGH] F5-VS-002 — `build/version.py` may not exist in PyInstaller build

**File:** `desktop/auto_update.py:55, 68-75`
**Root cause:** `VERSION_FILE` points to `build/version.py` relative to the source. In a PyInstaller-packaged exe, `build/version.py` does NOT exist as a separate file — it's embedded. `_get_current_version()` falls back to `(0, 1, 0)` silently:
```python
try:
    from build.version import VERSION
    parts = VERSION.split(".")
    return (int(parts[0]), int(parts[1]), int(parts[2]))
except (ImportError, ValueError, IndexError):
    return (0, 1, 0)  # Defaults to 0.1.0 — always "older" than any real version
```
**Impact:** Every PyInstaller-built Quorum.exe reports version `0.1.0`, meaning it ALWAYS tries to update, even if it's already on the latest version. Update check is broken for production builds.
**Recommendation:** Embed version via PyInstaller's `--version-file` or write version to a known path (`quorum_core/__version__.py`) that survives bundling.

### 3.3 [MEDIUM] F5-VS-003 — Config schema has no version marker; old configs loaded by new code silently corrupt

**Files:** `desktop/config_bridge.py`, `desktop/config_migration.py`
**Root cause:** Neither `config_bridge.py` nor `config_migration.py` stores a schema version in the output config. If the config format changes between releases, a config saved by v0.1.0 could be loaded by v1.0.0 with different field expectations, silently producing wrong behavior.
```python
# config_bridge.py saves:
save_data = validated.to_dict()
resolved.write_text(json.dumps(save_data, indent=2, default=str), encoding="utf-8")
# No "schema_version" or "quorum_version" key stored
```
**Impact:** Silent data corruption during upgrade. User's v0.1 config loaded by v1.0 code could map fields incorrectly.
**Recommendation:** Add a `"config_format_version": 1` field to all saved configs. On load, check the version and run migration if needed.

### 3.4 [MEDIUM] F5-VS-004 — `check_for_update` has no GITHUB_TOKEN; all unauthenticated users share same rate limit

**File:** `desktop/auto_update.py:94-122`
**Root cause:** The GitHub API call has no required token. Unauthenticated API requests share a global rate limit of 60/hour. If many users check for updates simultaneously (or if the repo becomes popular), all update checks fail silently:
```python
except urllib.error.HTTPError as e:
    if e.code == 403:
        logger.warning("GitHub API rate limited. Try setting GITHUB_TOKEN.")
    return []  # Silent failure — check_for_update returns "no updates"
```
**Impact:** No update notifications for users during rate limit windows. They remain on old versions indefinitely.
**Recommendation:** Bundle a static update-check URL (e.g., a well-known JSON endpoint) rather than hitting the GitHub API directly. Or use GitHub's `X-RateLimit-Remaining` header to detect throttling and report it to users instead of silently returning empty.

### 3.5 [LOW] F5-VS-005 — `.deb` control file has `Depends: libcuda-12-4 | libcuda-11-8` as a Recommend, but exact versions may drift

**File:** `installer/deb/control:7`
**Root cause:** The CUDA library version in Recommends (`libcuda-12-4 | libcuda-11-8`) is hardcoded. As CUDA updates, this becomes stale.
**Impact:** Users with newer CUDA versions get unnecessary dependency warnings.
**Recommendation:** Use a broader CUDA version range or make it a `Suggests:` instead.

---

## 4. Cleanup Correctness

### 4.1 [HIGH] F5-CC-001 — `rollback()` overwrites any existing staged update silently

**File:** `desktop/auto_update.py:509-516`
**Root cause:** When `rollback()` cannot replace the running exe, it writes a new staging marker:
```python
STAGE_MARKER.write_text(json.dumps({
    "release_tag": "rollback",
    "staged_file": str(staged),
    "previous_version": "unknown",
}, indent=2), encoding="utf-8")
```
This overwrites any previously staged update without merging or warning. If a user had staged an update to v0.3.0 and then triggered rollback, the v0.3.0 staged file is gone and the rollback staged file replaces it. On next restart, the user gets the rollback instead of the expected update.
**Impact:** Data loss in the update pipeline. User intent (apply update) is silently replaced by a different intent (rollback).
**Recommendation:** If STAGE_MARKER already exists, warn and ask for confirmation. Or use separate staging slots.

### 4.2 [MEDIUM] F5-CC-002 — `apply_update` cleanup is asymmetric: cleans old checksums but not old staged binaries

**File:** `desktop/auto_update.py:466-476`
**Root cause:** On successful apply, the code cleans:
```python
STAGE_MARKER.unlink(missing_ok=True)
for old_file in UPDATE_CACHE_DIR.glob("*.checksums"):
    old_file.unlink(missing_ok=True)
```
But it does NOT clean: any partially downloaded files from previous attempts, old version manifests, or orphaned staging artifacts. A failed download (line 291-292) does clean its own partial file, but downloads from earlier failed attempts (different filenames) are not cleaned.
**Impact:** Disk space waste in `~/.quorum/updates/`. Over time, this directory grows unbounded.
**Recommendation:** Add a `cleanup_cache()` function called after successful or failed updates that prunes files older than N days.

### 4.3 [MEDIUM] F5-CC-003 — `download_release` duplicate HTTP request construction

**File:** `desktop/auto_update.py:229-255`
**Root cause:** When `version_tag` is specified without `release`, the code constructs TWO identical HTTP requests (lines 231 and 246-249):
```python
url = f"{GITHUB_API}/tags/{version_tag}"
# ... first request ...
except urllib.error.HTTPError:
    full_url = f"{GITHUB_API}/tags/{version_tag}"  # SAME URL
    # ... identical second request ...
```
The retry uses the identical URL with identical headers — it will fail the same way. This is dead code masquerading as error recovery.
**Impact:** Wasted HTTP request, deceptive error handling. If the first request fails with 404, the second also fails with 404.
**Recommendation:** Remove the duplicate request. If needed, use a different endpoint (e.g., `/releases/tags/` is different from `/releases`).

### 4.4 [MEDIUM] F5-CC-004 — `build_deb.sh` produces broken `changelog.gz`

**File:** `installer/deb/build_deb.sh:132`
**Root cause:** 
```bash
cat > "$DEB_BUILD_DIR/usr/share/doc/quorum/changelog.gz" <<< "" 2>/dev/null || true
```
This writes an empty string to a `.gz` file. The resulting file is NOT valid gzip (empty gzip requires a header). `dpkg` may warn, and `zless /usr/share/doc/quorum/changelog.gz` will fail.
**Also:** The `<<< ""` here-string syntax is bash-specific. If `/bin/sh` is dash (common on Debian), this line is a syntax error (suppressed by `|| true`).
**Impact:** Broken changelog in .deb; potential install warnings.
**Recommendation:** Omit the changelog file entirely if empty, or properly gzip a minimal changelog with `printf "" | gzip -nc > ...`.

### 4.5 [LOW] F5-CC-005 — `verify_download` parses release body for checksums (weak match)

**File:** `desktop/auto_update.py:365-372`
**Root cause:** 
```python
body = release.get("body", "")
computed = compute_sha256(file_path)
if computed in body:  # substring match in arbitrary text
    return True
```
An attacker could insert a fake SHA256 in the release notes (e.g., in a code block or as part of a description) and the verifier would match it. This is a weak form of verification.
**Impact:** If a checksum of the legitimate binary appears anywhere in the release body (e.g., in a changelog snippet, example output), a malicious binary's checksum could be injected nearby.
**Recommendation:** Only match checksums in structured, parseable sections (e.g., a `SHA256SUMS` block delimited by ``` markers).

### 4.6 [LOW] F5-CC-006 — GitHub Actions `upload-artifact` uses inconsistent `if-no-files-found`

**File:** `installer/github_actions.yml:170, 263`
**Root cause:** Build job: `if-no-files-found: error` (fails fast). Package job: `if-no-files-found: warn` (silently continues). If packaging fails, no artifacts are uploaded but CI reports green.
**Impact:** Release may be published without platform packages, undetected.
**Recommendation:** Use `error` for both, or add an explicit verification step after package upload.

---

## 5. Temp Dir Isolation

### 5.1 [HIGH] F5-TI-001 — `UPDATE_CACHE_DIR` is a fixed shared path, not isolated

**File:** `desktop/auto_update.py:46-52`
**Root cause:** 
```python
UPDATE_CACHE_DIR = Path(
    os.environ.get("QUORUM_UPDATE_CACHE", str(Path.home() / ".quorum" / "updates"))
)
```
Multiple Quorum instances on the same machine share ONE update cache. If two users run Quorum simultaneously:
- Staging markers (`STAGE_MARKER`) from one user affect both
- Downloads from one user overwrite the other's
- Rollback backups are shared
**Impact:** Cross-user update interference. User A could trigger a rollback that affects User B's next restart.
**Recommendation:** Use a per-user temp directory (`tempfile.gettempdir()`) for downloads and staging. The cache dir should include the effective UID or a unique instance ID.

### 5.2 [MEDIUM] F5-TI-002 — Download writes directly to cache, not temp-then-rename

**File:** `desktop/auto_update.py:286-288`
**Root cause:**
```python
with urllib.request.urlopen(req, timeout=300) as resp:
    with open(dest, "wb") as f:
        shutil.copyfileobj(resp, f)
```
The file is written directly to its final destination. If the download is interrupted (network failure, process killed), a partial file remains in the cache directory — not a temp file that would be automatically cleaned.
**Impact:** Partial downloads accumulate; next download silently overwrites.
**Recommendation:** Download to a `.tmp` file, then `os.rename()` (atomic on same filesystem) to the final destination.

### 5.3 [MEDIUM] F5-TI-003 — Production code never uses `tempfile` module

**Files:** `desktop/auto_update.py`, `desktop/config_migration.py`, `desktop/config_bridge.py`, `installer/checksums.py`
**Root cause:** While the test suite properly uses `tempfile.TemporaryDirectory` for isolation (see `tests/e2e/conftest.py:36`), **none of the production code uses tempfile**. All file operations happen in shared, permanent locations. This means:
- No automatic cleanup on crash
- No isolation between operations
- Race conditions possible between concurrent processes
**Impact:** Edge-case crashes leave stale state files. Multi-process conflicts possible.
**Recommendation:** Use tempfile + atomic rename for all writes that could fail mid-operation.

### 5.4 [MEDIUM] F5-TI-004 — `config_migration._target_config_path()` and `config_bridge.DEFAULT_CONFIG_PATH` target different locations

**Files:** `desktop/config_migration.py:36-41`, `desktop/config_bridge.py:31`
**Root cause:**
```python
# config_migration.py
home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
# -> $HERMES_HOME/desktop-plugins/quorum/config.json

# config_bridge.py
DEFAULT_CONFIG_PATH = Path.home() / ".quorum" / "config.json"
# -> ~/.quorum/config.json
```
Configuration is split across two files at two different paths. There is no coordination or synchronization between them. Changes via the bridge are invisible to the migration tool and vice versa.
**Impact:** Config inconsistency. The Hermes settings panel writes to one path; migration reads from another. Users see stale or missing config in one tool.
**Recommendation:** Unify on a single canonical config path. If two formats are needed, use symlinks or a bidirectional sync layer.

### 5.5 [LOW] F5-TI-005 — `.deb` build dir cleanup uses rm -rf without safety checks

**File:** `installer/deb/build_deb.sh:69, 212`
**Root cause:**
```bash
rm -rf "$DEB_BUILD_DIR"  # Line 69 — clean before build
rm -rf "$DEB_BUILD_DIR"  # Line 212 — clean after build
```
If `$DIST_DIR` or `$DEB_NAME` are empty strings (e.g., due to failed version resolution), `$DEB_BUILD_DIR` could resolve to `dist/` or worse. No guard against empty variables.
```bash
DEB_BUILD_DIR="$DIST_DIR/${DEB_NAME}"  # What if DEB_NAME is empty?
```
**Impact:** If version extraction fails and `$VERSION` or `$DEB_NAME` is empty, `$DEB_BUILD_DIR` becomes `dist/` and `rm -rf dist/` destroys the dist directory.
**Recommendation:** Add `set -u` (already present) and validate that `$DEB_NAME` is non-empty before using in path construction. Or use `[[ -n "$DEB_BUILD_DIR" ]] && rm -rf "$DEB_BUILD_DIR"`.

---

## Summary of Findings by Sub-Area

### Config Migration Edge Cases
| ID | Severity | Summary |
|---|---|---|
| F5-CM-001 | HIGH | No backup before destructive write |
| F5-CM-002 | MEDIUM | Format detection false-positives |
| F5-CM-003 | MEDIUM | YAML import is conditional; silent corruption |
| F5-CM-004 | MEDIUM | Validation swallows non-TypeError exceptions |
| F5-CM-005 | LOW | Redundant discover_old_config_paths call |
| F5-CM-006 | LOW | Hardcoded default model names |

### Uninstall Residue
| ID | Severity | Summary |
|---|---|---|
| F5-UR-001 | HIGH | NSIS context bug; wrong LOCALAPPDATA after SetShellVarContext all |
| F5-UR-002 | HIGH | .deb has no postrm; apt purge leaves config |
| F5-UR-003 | MEDIUM | ROLLBACK_DIR accumulates old backups |
| F5-UR-004 | MEDIUM | macOS DMG has no uninstall mechanism |
| F5-UR-005 | MEDIUM | Staged update overwritten without warning |
| F5-UR-006 | LOW | PATH cleanup via EnVar is best-effort |

### Version Skew
| ID | Severity | Summary |
|---|---|---|
| F5-VS-001 | HIGH | Checksum verification silently permits unverified downloads |
| F5-VS-002 | HIGH | PyInstaller build reports version 0.1.0 (always thinks it's outdated) |
| F5-VS-003 | MEDIUM | Config files have no schema version marker |
| F5-VS-004 | MEDIUM | GitHub API rate-limit causes silent no-update |
| F5-VS-005 | LOW | CUDA dependency version hardcoded in .deb |

### Cleanup Correctness
| ID | Severity | Summary |
|---|---|---|
| F5-CC-001 | HIGH | rollback() silently overwrites staged updates |
| F5-CC-002 | MEDIUM | Asymmetric cleanup: checksums cleaned, staged binaries not |
| F5-CC-003 | MEDIUM | Dead retry code in download_release |
| F5-CC-004 | MEDIUM | build_deb.sh creates broken changelog.gz |
| F5-CC-005 | LOW | verify_download does substring match on release body |
| F5-CC-006 | LOW | GitHub Actions if-no-files-found inconsistency |

### Temp Dir Isolation
| ID | Severity | Summary |
|---|---|---|
| F5-TI-001 | HIGH | UPDATE_CACHE_DIR is shared across all users/instances |
| F5-TI-002 | MEDIUM | Downloads go directly to cache; no temp-then-rename |
| F5-TI-003 | MEDIUM | Production code never uses tempfile module |
| F5-TI-004 | MEDIUM | Config migration and bridge target different paths |
| F5-TI-005 | LOW | rm -rf without safety checks in build scripts |

---

## Positive Observations

1. **Test suite has robust isolation** — `tests/e2e/conftest.py` uses `tempfile.TemporaryDirectory` and `ResidueTracker` to verify zero-residue cleanup. The production code should learn from these patterns.
2. **Rollback mechanism exists** — The staged update + rollback design is sound in concept; the implementation just needs edge-case hardening.
3. **Checksum support is comprehensive** — SHA256SUMS + JSON format + auto-detection is well-designed. The main gap is the permissive fallback.
4. **NSIS installer structure is clean** — The installer covers registry, start menu, desktop shortcuts, and PATH. The context-switching bug is fixable with a one-line change.
5. **.deb packaging follows conventions** — postinst/prerm are correctly structured; only missing postrm.
