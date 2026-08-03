"""
desktop/auto_update.py — Auto-update mechanism using Hermes updater.

Checks GitHub releases for newer Quorum.exe versions, downloads,
verifies checksums via installer/checksums.py, stages updates,
and applies on restart.

Per PKG-3 acceptance: no separate update mechanism — uses Hermes updater.

CLIs:
  python -m desktop.auto_update check
  python -m desktop.auto_update apply [--version <tag>]
  python -m desktop.auto_update rollback
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from installer.checksums import (
    compute_sha256,
    verify_file,
    verify_directory,
    parse_manifest,
    parse_json_manifest,
    write_json_format,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

GITHUB_REPO = "nousresearch/quorum"  # GitHub repository for releases
GITHUB_API = f"https://api.github.com/repos/{GITHUB_REPO}/releases"

# Where updates are staged
# F5-TI-001: Per-instance cache isolation using executable path hash
def _get_instance_id() -> str:
    """Generate a stable instance identifier based on the executable path.

    This ensures two different Quorum installations don't share the same
    update cache, preventing version conflicts.
    """
    import hashlib
    try:
        exe_path = str(Path(sys.executable).resolve())
    except Exception:
        exe_path = str(Path(__file__).resolve())
    return hashlib.sha256(exe_path.encode()).hexdigest()[:8]


UPDATE_CACHE_DIR = Path(
    os.environ.get(
        "QUORUM_UPDATE_CACHE",
        str(Path.home() / ".quorum" / "updates" / _get_instance_id()),
    )
)

# F5-VS-002: Version detection that works in both PyInstaller bundles and repo layout.
# PyInstaller: reads version.txt from the executable directory (bundled at build time).
# Repo layout: imports from build.version (development).
def _get_current_version() -> Tuple[int, int, int]:
    """Get the current installed version as (major, minor, patch).

    For PyInstaller bundles, reads version.txt from the executable directory.
    For development (repo layout), imports from build.version.
    Falls back to (0, 1, 0) if version cannot be determined.
    """
    # PyInstaller bundle: read bundled version info
    if getattr(sys, "frozen", False):
        version_path = Path(sys.executable).parent / "version.txt"
        if version_path.exists():
            try:
                parts = version_path.read_text(encoding="utf-8").strip().split(".")
                if len(parts) >= 3:
                    return (int(parts[0]), int(parts[1]), int(parts[2]))
            except (ValueError, OSError):
                pass

    # Development / repo layout: import from build.version
    try:
        from build.version import VERSION
        parts = VERSION.split(".")
        return (int(parts[0]), int(parts[1]), int(parts[2]))
    except (ImportError, ValueError, IndexError):
        pass

    return (0, 1, 0)


def _parse_version_tag(tag: str) -> Optional[Tuple[int, int, int]]:
    """Parse a version tag like 'v0.2.0' into (major, minor, patch)."""
    tag = tag.lstrip("vV")
    try:
        parts = tag.split(".")
        if len(parts) == 3:
            return (int(parts[0]), int(parts[1]), int(parts[2]))
    except (ValueError, IndexError):
        pass
    return None


# ---------------------------------------------------------------------------
# Update cache paths
# ---------------------------------------------------------------------------

# Staging marker
STAGE_MARKER = UPDATE_CACHE_DIR / ".pending_update"

# Rollback backup directory
ROLLBACK_DIR = UPDATE_CACHE_DIR / "rollback"

# F5-UR-003: Limit rollback backup accumulation
MAX_ROLLBACK_BACKUPS = 5


def _cleanup_rollback_dir() -> None:
    """Remove old rollback backups, keeping only the N most recent.

    Prevents unbounded disk usage from repeated update cycles.
    """
    if not ROLLBACK_DIR.exists():
        return
    backups = sorted(
        ROLLBACK_DIR.glob("*.exe"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for old in backups[MAX_ROLLBACK_BACKUPS:]:
        old.unlink(missing_ok=True)
        logger.debug("Removed old rollback backup: %s", old)


# ---------------------------------------------------------------------------
# GitHub release checking
# ---------------------------------------------------------------------------

def _fetch_releases() -> list[Dict[str, Any]]:
    """Fetch releases from GitHub API.

    Returns:
        List of release dicts from the GitHub API.
    """
    import urllib.request
    import urllib.error

    url = GITHUB_API + "?per_page=20"
    req = urllib.request.Request(url)
    req.add_header("Accept", "application/vnd.github.v3+json")
    req.add_header("User-Agent", "Quorum-Updater/1.0")

    gh_token = os.environ.get("QUORUM_UPDATE_GITHUB_TOKEN", "")
    if gh_token:
        req.add_header("Authorization", f"Bearer {gh_token}")

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 403:
            logger.warning(
                "GitHub API rate limited. Try setting QUORUM_UPDATE_GITHUB_TOKEN."
            )
        logger.error("GitHub API error: %s", e)
        return []
    except Exception as e:
        logger.error("Failed to fetch releases: %s", e)
        return []


def _find_latest_github_release() -> Optional[Dict[str, Any]]:
    """Find the latest non-prerelease GitHub release.

    Returns:
        Latest release dict, or None if unavailable.
    """
    releases = _fetch_releases()
    for release in releases:
        if not release.get("prerelease", False) and not release.get("draft", False):
            return release
    # Fallback to first release of any type
    return releases[0] if releases else None


def check_for_update() -> Dict[str, Any]:
    """Check if a newer version is available on GitHub.

    Returns:
        Dict with 'current', 'latest', 'update_available', 'release' keys.
    """
    current = _get_current_version()
    current_str = f"v{current[0]}.{current[1]}.{current[2]}"

    latest_release = _find_latest_github_release()

    if latest_release is None:
        return {
            "current": current_str,
            "latest": None,
            "update_available": False,
            "error": "Could not fetch releases from GitHub",
        }

    latest_tag = latest_release.get("tag_name", "")
    latest_version = _parse_version_tag(latest_tag)

    update_available = False
    if latest_version:
        update_available = latest_version > current

    return {
        "current": current_str,
        "latest": latest_tag,
        "update_available": update_available,
        "release": {
            "name": latest_release.get("name", ""),
            "tag": latest_tag,
            "url": latest_release.get("html_url", ""),
            "published_at": latest_release.get("published_at", ""),
            "body": latest_release.get("body", ""),
        },
    }


# ---------------------------------------------------------------------------
# Download and apply
# ---------------------------------------------------------------------------

def _find_asset(
    release: Dict[str, Any],
    asset_name: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Find a download asset in a GitHub release.

    On Windows, looks for Quorum.exe or Quorum-Setup.exe.
    """
    assets = release.get("assets", [])

    # If a specific name is requested, try that first
    if asset_name:
        for asset in assets:
            if asset.get("name") == asset_name:
                return asset

    # Auto-detect platform-appropriate asset
    for asset in assets:
        name = asset.get("name", "")
        if name.endswith(".exe") or "windows" in name.lower():
            return asset

    # Fallback to first asset
    return assets[0] if assets else None


def download_release(
    release: Optional[Dict[str, Any]] = None,
    version_tag: Optional[str] = None,
) -> Optional[Path]:
    """Download a release binary.

    Args:
        release: A GitHub release dict from _fetch_releases().
        version_tag: Specific version tag to download (e.g. 'v0.2.0').

    Returns:
        Path to the downloaded file, or None on failure.
    """
    import urllib.request
    import urllib.error

    if release is None and version_tag is None:
        release = _find_latest_github_release()

    if release is None and version_tag:
        # Fetch specific release by tag
        url = f"{GITHUB_API}/tags/{version_tag}"
        req = urllib.request.Request(url)
        req.add_header("Accept", "application/vnd.github.v3+json")
        req.add_header("User-Agent", "Quorum-Updater/1.0")

        gh_token = os.environ.get("QUORUM_UPDATE_GITHUB_TOKEN", "")
        if gh_token:
            req.add_header("Authorization", f"Bearer {gh_token}")

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                release = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            logger.error("Failed to fetch release %s: HTTP %d", version_tag, e.code)
            # Try the full release endpoint
            try:
                full_url = f"{GITHUB_API}/tags/{version_tag}"
                req_full = urllib.request.Request(full_url)
                req_full.add_header("Accept", "application/vnd.github.v3+json")
                req_full.add_header("User-Agent", "Quorum-Updater/1.0")
                if gh_token:
                    req_full.add_header("Authorization", f"Bearer {gh_token}")
                with urllib.request.urlopen(req_full, timeout=30) as resp:
                    release = json.loads(resp.read().decode("utf-8"))
            except Exception:
                return None

    if release is None:
        logger.error("No release found to download")
        return None

    asset = _find_asset(release)
    if asset is None:
        logger.error("No downloadable asset found in release")
        return None

    download_url = asset.get("browser_download_url", "")
    if not download_url:
        logger.error("No download URL for asset")
        return None

    filename = asset.get("name", "Quorum.exe")
    dest = UPDATE_CACHE_DIR / filename
    UPDATE_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    logger.info("Downloading %s from %s ...", filename, download_url[:80])

    req = urllib.request.Request(download_url)
    req.add_header("Accept", "application/octet-stream")
    req.add_header("User-Agent", "Quorum-Updater/1.0")

    gh_token = os.environ.get("QUORUM_UPDATE_GITHUB_TOKEN", "")
    if gh_token:
        req.add_header("Authorization", f"Bearer {gh_token}")

    # Download to tempfile first, then atomic rename (C10-SEC-08)
    tmp_fd, tmp_path = tempfile.mkstemp(
        prefix=".download_", dir=str(UPDATE_CACHE_DIR)
    )
    tmp_file = Path(tmp_path)
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            with os.fdopen(tmp_fd, "wb") as f:
                shutil.copyfileobj(resp, f)
    except Exception as e:
        os.close(tmp_fd)
        if tmp_file.exists():
            tmp_file.unlink()
        logger.error("Download failed: %s", e)
        if dest.exists():
            dest.unlink()
        return None

    # Atomic rename
    try:
        tmp_file.replace(dest)
    except OSError:
        shutil.move(str(tmp_file), str(dest))

    logger.info("Downloaded to %s", dest)
    return dest


def _load_published_checksums() -> Dict[str, str]:
    """Load checksums from published manifest files.

    Loads from installer/release_checksums.json and installer/SHA256SUMS
    if they exist.
    """
    import installer.checksums as csums_mod
    installer_dir = Path(csums_mod.__file__).parent

    all_checksums: Dict[str, str] = {}

    # Try JSON format first
    json_path = installer_dir / "release_checksums.json"
    if json_path.exists():
        try:
            all_checksums.update(parse_json_manifest(json_path))
        except Exception:
            pass

    # Try SHA256SUMS format
    sums_path = installer_dir / "SHA256SUMS"
    if sums_path.exists():
        try:
            all_checksums.update(parse_manifest(sums_path))
        except Exception:
            pass

    return all_checksums


def verify_download(file_path: Path, release: Dict[str, Any]) -> bool:
    """Verify a downloaded release binary.

    Checks against:
      1. Published checksums (via installer/checksums.py)
      2. GitHub release asset checksum if available
    """
    filename = file_path.name

    # Check against published checksums
    known = _load_published_checksums()
    if filename in known:
        if verify_file(file_path, known[filename]):
            logger.info("Checksum verified for %s", filename)
            return True
        else:
            logger.error("Checksum mismatch for %s", filename)
            return False

    # Check release directory against a manifest if present
    release_dir = file_path.parent
    for manifest_name in ["SHA256SUMS", "checksums.json", "release_checksums.json"]:
        manifest_path = release_dir / manifest_name
        if manifest_path.exists():
            try:
                manifest = parse_manifest(manifest_path)
                if filename in manifest:
                    if verify_file(file_path, manifest[filename]):
                        logger.info("Checksum verified for %s (from %s)", filename, manifest_name)
                        return True
                    else:
                        logger.error("Checksum mismatch for %s (from %s)", filename, manifest_name)
                        return False
            except Exception:
                pass

    # No verification method succeeded — FAIL CLOSED
    # Never rely on substring matching in release notes (C10-SEC-01, C10-SEC-02)
    computed = compute_sha256(file_path)
    logger.error(
        "No trusted checksum reference found for %s. "
        "Verification FAILED (SHA-256: %s). "
        "Add the file checksum to installer/release_checksums.json or "
        "installer/SHA256SUMS to enable verification.",
        filename, computed[:16] + "...",
    )
    return False


def stage_update(file_path: Path, release_tag: str) -> Dict[str, Any]:
    """Stage an update for application on next restart.

    Args:
        file_path: Path to the downloaded release binary.
        release_tag: Release tag (e.g. 'v0.2.0').

    Returns:
        Status dict.
    """
    UPDATE_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    # Move the file to a standard staging name
    staged_path = UPDATE_CACHE_DIR / "Quorum.exe"
    shutil.move(str(file_path), str(staged_path))

    # Write staging marker
    marker_data = {
        "release_tag": release_tag,
        "staged_file": str(staged_path),
        "previous_version": f"v{_get_current_version()[0]}.{_get_current_version()[1]}.{_get_current_version()[2]}",
    }
    STAGE_MARKER.write_text(json.dumps(marker_data, indent=2), encoding="utf-8")

    logger.info("Update staged: %s → %s", marker_data["previous_version"], release_tag)

    return {
        "status": "staged",
        "release_tag": release_tag,
        "previous_version": marker_data["previous_version"],
        "staged_file": str(staged_path),
        "message": "Update will be applied on next restart",
    }


def apply_update() -> Dict[str, Any]:
    """Apply a staged update.

    This should be called during the application startup sequence.
    If a staged update exists, it replaces the current binary and
    cleans up the staging area.
    """
    if not STAGE_MARKER.exists():
        return {"status": "no_pending_update"}

    marker_data = json.loads(STAGE_MARKER.read_text(encoding="utf-8"))
    staged_file = Path(marker_data.get("staged_file", ""))

    if not staged_file.exists():
        logger.error("Staged file not found: %s", staged_file)
        STAGE_MARKER.unlink(missing_ok=True)
        return {"status": "error", "message": "Staged file missing"}

    # Determine where the current executable is
    current_exe = Path(sys.executable)
    if not current_exe.name.lower().endswith(".exe"):
        current_exe = Path(sys.argv[0]) if sys.argv else current_exe

    if not current_exe.exists():
        return {"status": "error", "message": "Cannot determine current executable"}

    # Create rollback backup
    ROLLBACK_DIR.mkdir(parents=True, exist_ok=True)
    backup_path = ROLLBACK_DIR / current_exe.name
    shutil.copy2(str(current_exe), str(backup_path))
    logger.info("Rollback backup saved to %s", backup_path)
    # F5-UR-003: Prune old rollback backups
    _cleanup_rollback_dir()

    # Replace the executable (on Windows, this may fail if the exe is locked)
    try:
        shutil.move(str(staged_file), str(current_exe))
    except (PermissionError, OSError) as e:
        logger.error(
            "Cannot replace running executable: %s. "
            "Update will apply on next restart via launcher.",
            e,
        )
        # Keep the staged file — launcher will handle on restart
        return {
            "status": "pending_restart",
            "message": "Update will apply on restart (exe in use)",
        }

    # Clean up staging
    STAGE_MARKER.unlink(missing_ok=True)
    # Clean up old checksums in cache
    for old_file in UPDATE_CACHE_DIR.glob("*.checksums"):
        old_file.unlink(missing_ok=True)

    return {
        "status": "applied",
        "release_tag": marker_data.get("release_tag"),
        "previous_version": marker_data.get("previous_version"),
        "message": "Update applied successfully",
    }


def rollback() -> Dict[str, Any]:
    """Rollback to the previously backed-up version.

    Clears any staged update and restores from rollback backup.
    """
    # Clear any staged update
    if STAGE_MARKER.exists():
        STAGE_MARKER.unlink()

    # Find rollback backup
    if not ROLLBACK_DIR.exists():
        return {"status": "error", "message": "No rollback backup available"}

    backups = sorted(ROLLBACK_DIR.glob("*.exe"), key=lambda p: p.stat().st_mtime)
    if not backups:
        return {"status": "error", "message": "No rollback backup files found"}

    backup = backups[-1]

    current_exe = Path(sys.executable)
    if not current_exe.name.lower().endswith(".exe"):
        current_exe = Path(sys.argv[0]) if sys.argv else current_exe

    if not current_exe.exists():
        return {"status": "error", "message": "Cannot determine current executable"}

    try:
        shutil.move(str(backup), str(current_exe))
    except (PermissionError, OSError) as e:
        logger.error("Cannot replace running executable: %s. Will apply on restart.", e)
        # F5-CC-001: Do not silently overwrite an existing staged update.
        # If there's already a pending update, back it up first so the rollback
        # doesn't destroy the staged version.
        staged = UPDATE_CACHE_DIR / current_exe.name
        shutil.copy2(str(backup), str(staged))
        if STAGE_MARKER.exists():
            backup_marker = STAGE_MARKER.with_suffix(
                STAGE_MARKER.suffix + ".rollback.bak"
            )
            shutil.move(str(STAGE_MARKER), str(backup_marker))
            logger.warning(
                "Existing staged update preserved at %s before rollback",
                backup_marker,
            )
        STAGE_MARKER.write_text(json.dumps({
            "release_tag": "rollback",
            "staged_file": str(staged),
            "previous_version": "unknown",
        }, indent=2), encoding="utf-8")
        return {
            "status": "pending_restart",
            "message": "Rollback will apply on restart (exe in use)",
        }

    return {
        "status": "rolled_back",
        "message": f"Restored from {backup.name}",
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _main() -> None:
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Quorum auto-update tool",
        prog="python -m desktop.auto_update",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # check
    sub.add_parser("check", help="Check for available updates")

    # apply
    apply_p = sub.add_parser("apply", help="Download and stage an update")
    apply_p.add_argument(
        "--version", type=str, default=None,
        help="Specific version to install (e.g. v0.2.0)",
    )

    # rollback
    sub.add_parser("rollback", help="Rollback to previous version")

    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if args.command == "check":
        result = check_for_update()
        print(f"Current:  {result['current']}")
        print(f"Latest:   {result.get('latest', 'unknown')}")
        if result.get("error"):
            print(f"Error:    {result['error']}")
            sys.exit(1)
        if result["update_available"]:
            print("✓ Update available!")
            release = result.get("release", {})
            if release.get("name"):
                print(f"  Release: {release['name']}")
            if release.get("published_at"):
                print(f"  Published: {release['published_at']}")
        else:
            print("✓ You are on the latest version.")

    elif args.command == "apply":
        # Fetch release info first
        version_tag = args.version
        if version_tag:
            release = None
        else:
            release = _find_latest_github_release()
            if release:
                version_tag = release.get("tag_name", "")
            else:
                print("✗ No releases found")
                sys.exit(1)

        # Download
        file_path = download_release(release=release, version_tag=version_tag)
        if file_path is None:
            print("✗ Download failed")
            sys.exit(1)

        # Verify (checksum verification is mandatory)
        if release is None:
            release = _find_latest_github_release() or {}
        if not verify_download(file_path, release):
            print("✗ Checksum verification failed")
            file_path.unlink(missing_ok=True)
            sys.exit(1)
        print("✓ Checksum verified")

        # Stage
        result = stage_update(file_path, version_tag)
        print(f"✓ {result['message']}")

    elif args.command == "rollback":
        result = rollback()
        print(f"{'✓' if 'error' not in result.get('status', '') else '✗'} {result['message']}")
        if result.get("status", "").startswith("error"):
            sys.exit(1)


if __name__ == "__main__":
    _main()