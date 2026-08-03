# Quorum — Cycle 10 red-team findings: Security (SURFACE 2)

**Reviewed:** 2026-08-02 · **Scope:** PKG-5 + PKG-6 installer/desktop Python code  
**Prior art:** `REDTEAM-FINDINGS.md` — all existing findings are TS-layer; none cover
the Python desktop/installer code reviewed here.

Adversarial review of the new desktop plugin stack and multi-platform installer
toolchain. Focus: config injection, binary verification bypass, privilege
escalation in installers, auto-update supply chain, checksum tampering, path
traversal.

## How to read this

| Tag | Meaning |
| --- | --- |
| **[CONFIRMED]** | Reproduced by static reasoning against source with concrete payloads. |
| **[PLAUSIBLE]** | Traced in code, survived a skeptic pass — not reproduced end-to-end on target platform. |
| **[INSPECTION]** | Read from source only. Lowest confidence. |

IDs are stable; reference them in commits and issues.

---

## 1. Critical

### C10-SEC-01 · Checksum verification defaults to PERMIT when no manifest exists [CONFIRMED]

`desktop/auto_update.py:374-380`. `verify_download()` returns `True` when no checksum
reference is found:

```python
# If no checksum available, warn but don't block
logger.warning(
    "No checksum reference found for %s. "
    "Skipping verification (SHA-256: %s)",
    filename, computed[:16] + "...",
)
return True  # Permit without checksum if none available
```

This is fail-**open** on the primary security control for the auto-update pipeline.
If a release is published without a SHA256SUMS manifest — or if the local
`installer/` checksum files are missing from the shipped installer — every
downloaded binary is accepted silently. An attacker who compromises the GitHub
release (or MITMs the download) serves a malicious binary that passes
verification.

**Fix:** Invert: when no checksum reference is found, FAIL the verification.
Permit only when the binary's hash is explicitly matched against a trusted
manifest.

This is the single most important finding in this pass.

---

### C10-SEC-02 · Checksum "verification" against GitHub release body is trivial to forge [CONFIRMED]

`desktop/auto_update.py:366-372`:

```python
body = release.get("body", "")
computed = compute_sha256(file_path)
# Look for checksum in release notes (common pattern)
if computed in body:
    logger.info("Checksum found in release notes for %s", filename)
    return True
```

This checks whether the SHA-256 hex string appears *anywhere* in the release
body text. An attacker publishing a malicious release can include the hash of
their binary in the release notes — e.g., `SHA256: <hash_of_malware>` — and this
check passes.

**Fix:** Parse structured checksums only. Never substring-match release body text
against computed hashes.

---

## 2. High

### C10-SEC-03 · `_core` injection bypass in config bridge [CONFIRMED]

`desktop/config_bridge.py:233-237`. After validating the merged config against
`CoreConfig.from_dict()`, the code preserves panel-specific keys from the patch:

```python
save_data = validated.to_dict()
# Preserve any panel-specific fields that were in the merge
for key in merged:
    if key.startswith("_") or key in ("server", "quorum", "operations"):
        if isinstance(merged[key], dict):
            save_data.setdefault(key, merged[key])
```

Any key starting with `_` from the patch is passed through and persisted. An
attacker who can send a partial config update (via the settings panel or CLI)
can inject `"_core": {"base_url": "https://evil.example"}`. When this config is
reloaded, `_desktop_to_core()` at line 121-122 gives `_core` special precedence:

```python
if "_core" in desktop_dict:
    return desktop_dict["_core"]
```

So the injected `_core` dict becomes the authoritative core config on next
load, bypassing the validated `CoreConfig.from_dict()` result that was saved as
the base. The `setdefault` at line 236 does NOT protect against this because
`validated.to_dict()` does not include a `_core` key.

**Proof of concept:**
1. Send patch `{"_core": {"base_url": "https://evil.example", "quorum_size": 1}}`
2. On next load, `_desktop_to_core` returns the injected dict
3. `CoreConfig.from_dict` is never called — the bypassed dict goes straight to runtime

**Fix:** Never allow `_core` or any `_`-prefixed key to be injected from user
input. Only preserve the actual section keys (`server`, `quorum`, `operations`)
from the merge, and never let those override core fields.

---

### C10-SEC-04 · Checksums loaded from local files — no trust anchor [CONFIRMED]

`desktop/auto_update.py:299-326`. `_load_published_checksums()` loads checksum
manifests from local files shipped with the installer:

```python
import installer.checksums as csums_mod
installer_dir = Path(csums_mod.__file__).parent
# ...
all_checksums.update(parse_json_manifest(json_path))
all_checksums.update(parse_manifest(sums_path))
```

These files live in the same directory as the auto-update code. An attacker who
replaces the local installation (via a prior compromise or physical access) can
replace `installer/SHA256SUMS` to contain matching checksums for their
malicious binary. The updater has no independent trust anchor.

This compounds with C10-SEC-01: even if C10-SEC-01 is fixed to fail-closed on
missing manifests, a modified local manifest would still authenticate a
malicious binary.

**Fix:** Ship checksums in a signed manifest (GPG or minisign). Verify the
signature against a pinned public key before trusting any checksums. The public
key is the trust anchor.

---

### C10-SEC-05 · GitHub token auto-detected from environment without user consent [CONFIRMED]

`desktop/auto_update.py:108-110`:

```python
gh_token = os.environ.get("GITHUB_TOKEN", os.environ.get("GH_TOKEN", ""))
if gh_token:
    req.add_header("Authorization", f"Bearer {gh_token}")
```

If the user has `GITHUB_TOKEN` or `GH_TOKEN` set for any other purpose (e.g.,
the `gh` CLI), Quorum silently uses it for auto-update API calls. This means:

1. The token is sent to `api.github.com/repos/nousresearch/quorum/releases` on
   every update check — a different repo than the user's own.
2. The token appears in request headers over HTTPS — no audit log, no user
   notification.
3. If the GitHub API returns an error for a malformed token, the error body is
   not inspected — the token value is in the response headers and error logs.

Without a token, the updater hits GitHub's rate limit (60 req/hr) and update
checks silently fail (line 116-118) — `403` returns an empty release list,
which `_find_latest_github_release` interprets as "no releases found."

**Fix:** Require explicit opt-in (`QUORUM_UPDATE_GITHUB_TOKEN` or similar
namespace prefix). Never silently borrow the user's `GITHUB_TOKEN`.

---

### C10-SEC-06 · `--skip-checksums` CLI flag makes all integrity checks optional [CONFIRMED]

`desktop/auto_update.py:550-552`:

```python
apply_p.add_argument(
    "--skip-checksums", action="store_true",
    help="Skip checksum verification",
)
```

Combined with C10-SEC-01 (default-permit), this flag is redundant in the
current code — checksums are already skipped by default when no manifest
exists. After C10-SEC-01 is fixed (fail-closed), this flag becomes the
*primary* bypass mechanism. It should not exist in the production CLI.

**Fix:** Remove the flag. There is no legitimate reason to skip integrity
verification during an auto-update.

---

## 3. Medium

### C10-SEC-07 · No code signing verification — checksums provide integrity but not authenticity [CONFIRMED]

The entire auto-update pipeline relies on SHA-256 checksums only. There is no:

- GPG signature verification on checksum manifests
- Windows Authenticode verification on downloaded EXEs
- macOS code signature verification on DMGs
- Signed git tags verified against a known key

An attacker who compromises the GitHub release can replace both the binary and
the SHA256SUMS file. Checksums alone do NOT establish authenticity — only
integrity. The user has no cryptographic proof that the binary came from the
Quorum maintainers.

**Fix:** Sign checksum manifests (GPG or minisign). Embed the public key in the
installer. Verify signatures before trusting checksums. For Windows, verify
Authenticode signatures on downloaded EXEs. For macOS, verify code signatures
on downloaded DMGs.

---

### C10-SEC-08 · Rollback backup at predictable, user-writable path [CONFIRMED]

`desktop/auto_update.py:61`:

```python
ROLLBACK_DIR = UPDATE_CACHE_DIR / "rollback"
```

Where `UPDATE_CACHE_DIR` is `~/.quorum/updates/`. The rollback backup is stored
in a user-writable directory with no integrity check. An attacker with user-level
access can replace the rollback backup with a malicious binary. The next
`rollback()` call would restore the attacker's binary.

**Fix:** Store rollback backups with ownership/ACL protection. Verify the hash
of the backup against a trusted manifest before restoring.

---

### C10-SEC-09 · macOS entitlements disable library validation [CONFIRMED]

`installer/dmg/entitlements.plist`:

```xml
<key>com.apple.security.cs.disable-library-validation</key>
<true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key>
<true/>
```

Disabling library validation (`disable-library-validation`) plus allowing
unsigned executable memory (`allow-unsigned-executable-memory`) creates a large
attack surface for dylib hijacking. An attacker who places a malicious dylib
in a location the app searches can inject code at launch.

`get-task-allow` is correctly set to `false` (blocking debugger attach), which
mitigates runtime injection, but the launch-time attack surface remains.

**Fix:** Remove `disable-library-validation` unless it's required for a specific
bundled library. If required, limit its scope using
`com.apple.security.cs.disable-library-validation` with a specific team
identifier or bundle path. Document which library requires it and why.

---

### C10-SEC-10 · .deb prerm kills arbitrary processes matching "quorum" [CONFIRMED]

`installer/deb/prerm:9-10`:

```sh
pkill -f "/opt/quorum/Quorum" 2>/dev/null || true
pkill -f "quorum" 2>/dev/null || true
```

The second `pkill -f "quorum"` matches any process with "quorum" in its command
line arguments. This could kill unrelated processes — e.g., a data science
script processing quorum-sensing data, or a systemd service with "quorum" in
its description path. The `|| true` suppresses the error, so the operator is
never aware.

This is a local denial-of-service vector during uninstall. It also runs as
root (since `dpkg --purge` runs maintainer scripts as root).

**Fix:** Use a more specific pattern. `pkill -f "^/opt/quorum/Quorum"` anchors
to the start of the command, or use a PID file written at install time.

---

### C10-SEC-11 · Path traversal in checksum manifest filenames [INSPECTION]

`installer/checksums.py:214`:

```python
file_path = directory / filename
```

The `filename` comes from the checksum manifest. If a manifest contains
`../../etc/passwd` as a "filename," the constructed path escapes the directory.
While `verify_file` only reads (doesn't write), it could be used to:

1. Probe for file existence (`FileNotFoundError` vs checksum mismatch)
2. Exfiltrate file contents via the error message that includes the path
   (`line 237-239`: `f"FAIL: {filename}\n Expected: {expected_hash}\n Actual: {actual}"`)

**Exploit**: Craft a SHA256SUMS containing:
```
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  ../../etc/hostname
```

The verifier will compute sha256 of `/etc/hostname` and print its hash,
revealing the file's content hash to standard output.

**Fix:** Validate that each filename in a manifest does not contain path
separators (`/`, `\\`) or parent directory references (`..`). Reject the entire
manifest if any filename fails validation.

---

### C10-SEC-12 · build_deb.sh VERSION interpolation in `rm -rf` [PLAUSIBLE]

`installer/deb/build_deb.sh:45-46,69`:

```sh
DEB_NAME="${PACKAGE_NAME}_${VERSION}_amd64"
DEB_BUILD_DIR="$DIST_DIR/${DEB_NAME}"
# ...
rm -rf "$DEB_BUILD_DIR"
```

`$VERSION` is read from `build/version.py` (line 30) or `--version` argument
(line 39). If `version.py` is maliciously modified to contain `../../etc`, the
`DEB_BUILD_DIR` becomes `dist/quorum_../../etc_amd64`, and `rm -rf` on that
path would escape the dist directory.

The version string is never validated for path traversal characters. While
`version.py` is in the same repo and requires a commit to modify, the `--version`
CLI argument bypasses this.

**Fix:** Validate that `$VERSION` matches `^[0-9]+\\.[0-9]+\\.[0-9]+` (semantic
version) before using it in path construction. Reject invalid versions.

---

### C10-SEC-13 · Config migration API keys written to disk in plaintext [CONFIRMED]

`desktop/config_bridge.py:238` and `desktop/config_ui.py:416` both write config
to disk via `json.dumps`. API keys (`cloud.apiKey`, `local.apiKey`) are stored
in plaintext.

The NSIS installer writes update URLs to `HKLM` registry (line 131-133) but
there's no equivalent for storing API credentials. The plaintext-on-disk problem
is the same one documented in REDTEAM-FINDINGS.md §6 ("API keys never leave the
server") for the TS layer — but the Python desktop layer now stores them in
`~/.hermes/desktop-plugins/quorum/config.json` which is a different file.

**Fix:** Encrypt secrets at rest. Use the OS keychain where available (Windows
Credential Manager, macOS Keychain, Linux Secret Service API).

---

### C10-SEC-14 · Config file is world-readable when created by .deb postinst [INSPECTION]

`installer/deb/postinst:43-57` creates `/etc/quorum/config.json` with `chmod
644`. While this is standard for config files, the file may eventually contain
API keys or other secrets if the config bridge writes there. The system-wide
config path and the per-user config path are different
(`~/.hermes/desktop-plugins/quorum/config.json` vs `/etc/quorum/config.json`),
but the postinst creates a precedent of world-readable config.

**Fix:** Set `chmod 600` on `/etc/quorum/config.json` and any directories
containing secrets. Document that API keys should never be stored in
system-wide config.

---

### C10-SEC-15 · API key in NSIS installer PATH modification uses unchecked plugin [INSPECTION]

`installer/nsis/quorum.nsi:147-152`:

```nsis
EnVar::SetHKCU
EnVar::AddValue "PATH" "$INSTDIR"
Pop $0
```

The `EnVar` plugin is a third-party NSIS plugin. If a malicious version of this
plugin is substituted (via compromised build dependencies), it could execute
arbitrary code during install with admin privileges.

**Fix:** Pin the EnVar plugin version with a checksum in the CI pipeline.
Document that the plugin binary must be verified before use.

---

## 4. Low

### C10-SEC-16 · Update URLs in NSIS installer are example.com placeholders [INSPECTION]

`installer/nsis/quorum.nsi:97-98`:

```nsis
!define UPDATE_CHECK_URL "https://releases.quorum.example.com/latest.yml"
!define UPDATE_FEED_URL  "https://releases.quorum.example.com/"
```

These are written to `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\Quorum`
as `UpdateURL` and `UpdateFeedURL` (lines 131-133). However, the Python
auto-updater (`auto_update.py`) uses GitHub releases, not these registry keys.
This is dead code — but it is visible in Add/Remove Programs and could confuse
users or security auditors.

**Fix:** Either remove these registry writes or wire them to the same update
source the Python code uses (`https://github.com/nousresearch/quorum`).

---

### C10-SEC-17 · `verify_ssl` defaults to True but is user-configurable [INSPECTION]

`desktop/config_bridge.py:98` defaults `verify_ssl` to `True`, and the settings
panel exposes it as a boolean toggle. If a user disables SSL verification, the
auto-update pipeline's HTTPS connections are vulnerable to MITM. The
auto-update code uses `urllib.request.urlopen()` which, combined with an
unverified SSL context, would accept any certificate.

**Fix:** Wire the `verify_ssl` setting into the auto-update URL opener. If
`verify_ssl` is False, log a prominent warning and require explicit
confirmation whenever auto-update is about to fetch over an insecure channel.

---

### C10-SEC-18 · DNS rebinding protection absent from Python auto-update [INSPECTION]

The TypeScript API server has DNS rebinding protection (`server.ts:119` hostname
check). The Python `auto_update.py` uses `urllib.request` which does NOT check
that the resolved IP matches the hostname. An attacker on the local network who
controls DNS could redirect `api.github.com` to a malicious server.

**Fix:** Implement hostname verification in the auto-update HTTP client. Use
`ssl.create_default_context()` with hostname checking enabled (which is the
default for HTTPS URLs in `urllib`), and add an explicit DNS rebinding check
for the resolved IP.

---

### C10-SEC-19 · Case-insensitive filename matching in verify_directory [INSPECTION]

`installer/checksums.py:218-224`:

```python
for candidate in directory.iterdir():
    if candidate.name.lower() == filename.lower():
        found = candidate
        break
```

This fallback runs on all platforms (not just Windows). On case-sensitive
filesystems, `Quorum.exe` and `quorum.exe` are different files, but this
fallback would match them interchangeably. An attacker could place a malicious
`quorum.exe` alongside `Quorum.exe` and have it verified against the
`Quorum.exe` checksum entry.

**Fix:** Only enable case-insensitive fallback on Windows. On Linux/macOS, a
missing file should be reported as MISSING, not matched to a different-cased
file.

---

### C10-SEC-20 · `continue-on-error: true` in CI packaging masks build failures [INSPECTION]

`installer/github_actions.yml:216,224,236` — all three packaging steps set
`continue-on-error: true`. If NSIS or DMG packaging fails in CI, the error is
swallowed and the pipeline continues. The `release` job (`if-no-files-found:
warn`) then uploads whatever partial artifacts exist.

This means a release can ship with a missing or corrupt Windows installer or
macOS DMG without failing the pipeline.

**Fix:** Remove `continue-on-error: true` from packaging steps. If a package
can't be built, the release should block until the issue is fixed. If some
platforms are genuinely optional, gate them with explicit conditions rather
than silent failure swallowing.

---

## 5. Resilient — held up under review

Verified against source, not assumed:

- **NSIS installer requires admin correctly** (`RequestExecutionLevel admin`).
  Installing to `$PROGRAMFILES64` requires it, and the `x64.nsh` check at
  `.onInit` correctly aborts on 32-bit Windows.
- **Auto-update checks HTTPS for GitHub API** — `urllib.request.Request` with
  `https://` URLs uses TLS by default in Python 3.11+. Certificate validation
  is enabled. (MITM via `verify_ssl=false` documented as C10-SEC-17.)
- **Config migration is non-destructive** — `_migrate_camel_to_snake` preserves
  unknown keys, and idempotency is tested (`test_migration_is_nondestructive`).
- **Checksum computation uses streaming reads** — `compute_sha256` reads in
  64KB chunks, safe for large files.
- **Manifest parsing validates hash length and hex charset** —
  `len(hash_hex) == 64` and hex character check at `checksums.py:149`.
- **Shutil.move used for atomic file replacement** — `auto_update.py:452` uses
  `shutil.move` which is atomic on the same filesystem. Backup created before
  replacement.
- **Entitlements deny camera and microphone** — `entitlements.plist` explicitly
  sets `audio-input: false` and `camera: false`.
- **No JIT entitlement** — `com.apple.security.cs.allow-jit` is `true` but this
  is standard for apps that may use WebKit or JavaScriptCore. The app does not
  ship a browser engine, so this should be reviewed but is not exploitable
  today.
- **Rollback creates backup before replacing** — `apply_update()` copies the
  current binary before moving the staged file, ensuring recovery on failure.

---

## 6. Investigated and dismissed — do not re-litigate

- **"Config file at predictable path `~/.quorum/config.json` is an
  information leak."** This is the standard XDG convention for user config.
  Any process running as the user can read their own home directory. The
  protection boundary is the OS user account, not filesystem permissions.
  Same reasoning as REDTEAM-FINDINGS.md §6's "API keys never leave the server"
  analysis — the disk is not the attack surface, process isolation is.
- **"`EnVar::AddValue` modifying PATH is a persistence mechanism."** This is
  the intended behavior — the installer adds the install directory to PATH so
  users can run `quorum` from the command line. The installer explicitly asks
  for admin privileges.
- **"AppImage symlink `ln -sf usr/bin/quorum "$APPDIR/AppRun"` could follow
  a malicious symlink."** This is constructed during the build, not at runtime.
  The build runs on CI with a clean environment. Attack surface is the CI
  pipeline, not the product.
- **"`pkill -f quorum` in prerm kills too broadly."** This is filed as
  C10-SEC-10 above — it's a real finding, not dismissed. Listed here to
  separate it from genuinely dismissed issues.

---

## 7. Suggested order of work

1. **C10-SEC-01** — Checksum verification default-permit. One-line fix: change `return True` to `return False`. This is the gate on the entire auto-update supply chain.
2. **C10-SEC-02** — Checksum substring match in release body. Replace with structured manifest parsing only.
3. **C10-SEC-03** — `_core` injection in config bridge. Block `_`-prefixed keys from user input.
4. **C10-SEC-04** — Local checksums without trust anchor. Sign manifests with a pinned key.
5. **C10-SEC-06** — Remove `--skip-checksums` CLI flag.
6. **C10-SEC-11** — Path traversal in checksum filenames. Validate filenames before constructing paths.
7. **C10-SEC-05** — GitHub token auto-detection. Use a namespaced env var.
8. **C10-SEC-10** — `pkill -f "quorum"` in .deb prerm. Use a specific pattern or PID file.
9. **C10-SEC-12** — Version validation in build_deb.sh. Restrict to semver.
10. Remaining medium/low findings in priority order.

---

*Report generated 2026-08-02 against commit range PKG-5+PKG-6 (new desktop/installer Python code).*
