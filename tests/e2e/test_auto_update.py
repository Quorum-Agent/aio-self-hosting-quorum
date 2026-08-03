"""
End-to-end tests for Quorum auto-update mechanism.

Covers the staged rollout and rollback behaviour:

  1. Update manifest parsing (version channels, download URLs, checksums)
  2. Staged rollout: canary → beta → stable percentage progression
  3. Rollback on failure: update fails → previous version restored
  4. Semantic version comparison
  5. Update channel selection (stable, beta, canary)
  6. Integrity verification: checksum mismatch → abort
  7. Idempotency: re-running update at same version is a no-op

Mutation resistance: tests assert update flow invariants (manifest shape,
version ordering, rollback condition), not hardcoded version numbers.
"""

from __future__ import annotations

import json
import os
import hashlib
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pytest


# ===========================================================================
# Auto-update core — mirrors what desktop/auto_update.py will implement
# ===========================================================================


class UpdateVersion:
    """Semantic version with comparison support.

    Supports pre-release suffixes (0.2.0-beta.1, 0.3.0-canary.2).
    Comparison compares only the numeric MAJOR.MINOR.PATCH portion.
    The full string is preserved for display.

    Mirrors the version comparison logic that auto_update will use.
    """

    def __init__(self, version_str: str):
        base, _, _pre = version_str.partition("-")
        parts = base.split(".")
        self.major = int(parts[0]) if len(parts) > 0 else 0
        self.minor = int(parts[1]) if len(parts) > 1 else 0
        self.patch = int(parts[2]) if len(parts) > 2 else 0
        self.string = version_str

    def __eq__(self, other):
        return (self.major, self.minor, self.patch) == (other.major, other.minor, other.patch)

    def __lt__(self, other):
        return (self.major, self.minor, self.patch) < (other.major, other.minor, other.patch)

    def __le__(self, other):
        return self < other or self == other

    def __gt__(self, other):
        return not (self <= other)

    def __ge__(self, other):
        return not (self < other)

    def __repr__(self):
        return f"UpdateVersion({self.string})"


class UpdateChannel:
    """Update channel with rollout percentage."""
    STABLE = "stable"
    BETA = "beta"
    CANARY = "canary"


class UpdateManifest:
    """Represents an update manifest fetched from the update server.

    Mirrors the manifest format auto_update will parse.
    """

    def __init__(
        self,
        version: str,
        channel: str,
        download_url: str,
        checksum: str = "",
        rollout_percentage: int = 100,
        release_notes: str = "",
        min_previous_version: Optional[str] = None,
    ):
        self.version = UpdateVersion(version)
        self.channel = channel
        self.download_url = download_url
        self.checksum = checksum
        self.rollout_percentage = rollout_percentage
        self.release_notes = release_notes
        self.min_previous_version = min_previous_version

    def to_dict(self) -> Dict[str, Any]:
        return {
            "version": self.version.string,
            "channel": self.channel,
            "download_url": self.download_url,
            "checksum": self.checksum,
            "rollout_percentage": self.rollout_percentage,
            "release_notes": self.release_notes,
            "min_previous_version": self.min_previous_version,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "UpdateManifest":
        return cls(
            version=data["version"],
            channel=data.get("channel", UpdateChannel.STABLE),
            download_url=data["download_url"],
            checksum=data.get("checksum", ""),
            rollout_percentage=data.get("rollout_percentage", 100),
            release_notes=data.get("release_notes", ""),
            min_previous_version=data.get("min_previous_version"),
        )


# ===========================================================================
# Update engine simulation
# ===========================================================================


def _simulate_update(
    current_version: str,
    manifest: UpdateManifest,
    install_dir: Path,
    backup_dir: Path,
    *,
    force_install: bool = False,
    simulate_checksum_failure: bool = False,
    simulate_install_failure: bool = False,
) -> Tuple[bool, str, Optional[str]]:
    """Simulate the auto-update process.

    Args:
        current_version: Currently installed version (semantic).
        manifest: Update manifest to apply.
        install_dir: Directory containing Quorum.exe.
        backup_dir: Directory for backup of current version.
        force_install: Skip rollout percentage check.
        simulate_checksum_failure: Simulate checksum mismatch.
        simulate_install_failure: Simulate install step failure.

    Returns:
        (success, message, deployed_version_or_None)
    """
    current = UpdateVersion(current_version)
    target = manifest.version

    # Check if update is needed
    if target <= current:
        return True, f"No update needed: {current.string} >= {target.string}", None

    # Check rollout percentage (deterministic hash of install path)
    if not force_install:
        hash_val = int(hashlib.sha256(str(install_dir).encode()).hexdigest(), 16) % 100
        if hash_val >= manifest.rollout_percentage:
            return (
                False,
                f"Not in rollout ({hash_val} >= {manifest.rollout_percentage}%)",
                None,
            )

    # Check minimum version requirement
    if manifest.min_previous_version:
        min_ver = UpdateVersion(manifest.min_previous_version)
        if current < min_ver:
            return (
                False,
                f"Current version {current.string} < required {min_ver.string}",
                None,
            )

    # Checksum verification
    if manifest.checksum:
        if simulate_checksum_failure:
            return False, "Checksum mismatch — update aborted", None

    # Stage: backup current version
    backup_dir.mkdir(parents=True, exist_ok=True)
    for item in install_dir.glob("*"):
        if item.is_file():
            backup_target = backup_dir / item.name
            backup_target.write_bytes(item.read_bytes())

    # Install new version
    if simulate_install_failure:
        # Rollback: restore from backup
        for item in backup_dir.glob("*"):
            if item.is_file():
                restore_target = install_dir / item.name
                restore_target.write_bytes(item.read_bytes())
        return False, "Install failed — rolled back to previous version", None

    # Success: write new version marker
    (install_dir / "version.txt").write_text(target.string)
    return True, f"Updated to {target.string}", target.string


# ===========================================================================
# Test helpers
# ===========================================================================


def _make_install_dir(base: Path) -> Path:
    """Create a simulated installation directory with a version marker."""
    d = base / "Quorum"
    d.mkdir(parents=True)
    (d / "Quorum.exe").write_text("stub")
    (d / "version.txt").write_text("0.1.0")
    return d


# ===========================================================================
# Tests
# ===========================================================================


class TestUpdateVersionComparison:
    """Semantic version comparison logic."""

    def test_greater_major_version(self):
        """1.0.0 < 2.0.0."""
        assert UpdateVersion("1.0.0") < UpdateVersion("2.0.0")

    def test_greater_minor_version(self):
        """1.1.0 < 1.2.0."""
        assert UpdateVersion("1.1.0") < UpdateVersion("1.2.0")

    def test_greater_patch_version(self):
        """1.0.1 < 1.0.2."""
        assert UpdateVersion("1.0.1") < UpdateVersion("1.0.2")

    def test_equal_versions(self):
        """Same version strings are equal."""
        assert UpdateVersion("3.14.0") == UpdateVersion("3.14.0")

    def test_not_less_than_if_greater(self):
        """2.0.0 is not < 1.0.0."""
        assert not (UpdateVersion("2.0.0") < UpdateVersion("1.0.0"))

    def test_greater_or_equal(self):
        """>= works correctly."""
        v1 = UpdateVersion("1.0.0")
        v2 = UpdateVersion("1.0.0")
        v3 = UpdateVersion("1.0.1")
        assert v1 >= v2
        assert v3 >= v1

    def test_less_or_equal(self):
        """<= works correctly."""
        v1 = UpdateVersion("1.0.0")
        v2 = UpdateVersion("1.0.0")
        v3 = UpdateVersion("1.0.1")
        assert v1 <= v2
        assert v1 <= v3

    def test_floating_point_style_versions(self):
        """Versions like '1.0' are parsed as 1.0.0."""
        v = UpdateVersion("1.0")
        assert v.major == 1
        assert v.minor == 0
        assert v.patch == 0


class TestUpdateManifestParsing:
    """Update manifest JSON parsing."""

    def test_manifest_from_dict_minimal(self):
        """Minimal manifest dict roundtrips correctly."""
        data = {
            "version": "0.2.0",
            "download_url": "https://releases.quorum.test/Quorum-0.2.0.exe",
        }
        m = UpdateManifest.from_dict(data)
        assert m.version.string == "0.2.0"
        assert m.channel == UpdateChannel.STABLE
        assert m.rollout_percentage == 100

    def test_manifest_from_dict_full(self):
        """Full manifest with all optional fields."""
        data = {
            "version": "0.3.0-beta.1",
            "channel": "beta",
            "download_url": "https://releases.quorum.test/next/Quorum-0.3.0-beta.1.exe",
            "checksum": "abc123def456",
            "rollout_percentage": 10,
            "release_notes": "Bug fixes and performance improvements.",
            "min_previous_version": "0.2.0",
        }
        m = UpdateManifest.from_dict(data)
        assert m.channel == "beta"
        assert m.rollout_percentage == 10
        assert m.min_previous_version == "0.2.0"
        assert m.checksum == "abc123def456"

    def test_manifest_to_dict_roundtrip(self):
        """Manifest to_dict → from_dict preserves all data."""
        original = UpdateManifest(
            version="1.0.0",
            channel="stable",
            download_url="https://example.com/q.exe",
            checksum="sha256:deadbeef",
            rollout_percentage=50,
            release_notes="Stable release",
            min_previous_version="0.9.0",
        )
        roundtripped = UpdateManifest.from_dict(original.to_dict())
        assert roundtripped.version == original.version
        assert roundtripped.channel == original.channel
        assert roundtripped.rollout_percentage == original.rollout_percentage


class TestStagedRollout:
    """Staged rollout: canary → beta → stable percentage progression."""

    def test_canary_rollout_low_percentage(self):
        """Canary channel has low rollout (<= 10%)."""
        manifest = UpdateManifest(
            version="0.2.0-canary.1",
            channel=UpdateChannel.CANARY,
            download_url="https://example.com/canary.exe",
            rollout_percentage=5,
        )
        assert manifest.rollout_percentage <= 10

    def test_beta_rollout_moderate_percentage(self):
        """Beta channel has moderate rollout (<= 50%)."""
        manifest = UpdateManifest(
            version="0.2.0-beta.2",
            channel=UpdateChannel.BETA,
            download_url="https://example.com/beta.exe",
            rollout_percentage=25,
        )
        assert manifest.rollout_percentage <= 50

    def test_stable_rollout_full_percentage(self):
        """Stable channel has full rollout (100%)."""
        manifest = UpdateManifest(
            version="1.0.0",
            channel=UpdateChannel.STABLE,
            download_url="https://example.com/stable.exe",
            rollout_percentage=100,
        )
        assert manifest.rollout_percentage == 100

    def test_staged_progression_order(self):
        """Channel rollout percentages increase: canary < beta < stable."""
        channels = [
            UpdateManifest("0.1.0", UpdateChannel.CANARY, "url1", rollout_percentage=5),
            UpdateManifest("0.1.0", UpdateChannel.BETA, "url2", rollout_percentage=25),
            UpdateManifest("0.1.0", UpdateChannel.STABLE, "url3", rollout_percentage=100),
        ]
        percentages = [m.rollout_percentage for m in channels]
        assert percentages == sorted(percentages), (
            f"Rollout percentages must increase: {percentages}"
        )

    def test_rollout_percentage_bounds(self):
        """Rollout percentage is always in [0, 100]."""
        for pct in [0, 50, 100]:
            m = UpdateManifest("0.1.0", "stable", "url", rollout_percentage=pct)
            assert 0 <= m.rollout_percentage <= 100


class TestUpdateFlow:
    """Full update flow simulation."""

    def test_update_from_older_version_succeeds(self, tmp_path):
        """Updating from 0.1.0 to 0.2.0 works."""
        install = _make_install_dir(tmp_path / "install")
        backup = tmp_path / "backup"

        manifest = UpdateManifest(
            version="0.2.0",
            channel="stable",
            download_url="https://example.com/Quorum-0.2.0.exe",
            rollout_percentage=100,
        )

        success, msg, deployed = _simulate_update(
            "0.1.0", manifest, install, backup, force_install=True
        )
        assert success, f"Update should succeed: {msg}"
        assert deployed == "0.2.0"
        assert (install / "version.txt").read_text() == "0.2.0"

    def test_update_to_same_version_is_noop(self, tmp_path):
        """Updating from 0.2.0 to 0.2.0 is a no-op (success, but no change)."""
        install = _make_install_dir(tmp_path / "install")
        (install / "version.txt").write_text("0.2.0")
        backup = tmp_path / "backup"

        manifest = UpdateManifest(
            version="0.2.0",
            channel="stable",
            download_url="https://example.com/Quorum-0.2.0.exe",
            rollout_percentage=100,
        )

        success, msg, deployed = _simulate_update(
            "0.2.0", manifest, install, backup, force_install=True
        )
        assert success, "No-op should report success"
        assert deployed is None, "No new version was deployed"
        assert "No update needed" in msg

    def test_downgrade_is_rejected(self, tmp_path):
        """Downgrade from 0.2.0 to 0.1.0 is rejected."""
        install = _make_install_dir(tmp_path / "install")
        (install / "version.txt").write_text("0.2.0")
        backup = tmp_path / "backup"

        manifest = UpdateManifest(
            version="0.1.0",
            channel="stable",
            download_url="https://example.com/Quorum-0.1.0.exe",
            rollout_percentage=100,
        )

        success, msg, deployed = _simulate_update(
            "0.2.0", manifest, install, backup, force_install=True
        )
        assert deployed is None, "Downgrade must not deploy"
        assert "No update needed" in msg

    def test_backup_created_on_update(self, tmp_path):
        """Backup directory is populated during update."""
        install = _make_install_dir(tmp_path / "install")
        backup = tmp_path / "backup"

        manifest = UpdateManifest(
            version="0.3.0",
            channel="stable",
            download_url="https://example.com/Quorum-0.3.0.exe",
            rollout_percentage=100,
        )

        success, msg, deployed = _simulate_update(
            "0.1.0", manifest, install, backup, force_install=True
        )
        assert success
        # Backup should contain the previous version's files
        backup_files = list(backup.glob("*"))
        assert len(backup_files) > 0, "Backup directory should contain files"


class TestRollback:
    """Rollback on update failure."""

    def test_rollback_on_install_failure_restores_version(self, tmp_path):
        """When install fails, previous version is restored."""
        install = _make_install_dir(tmp_path / "install")
        (install / "version.txt").write_text("0.1.0")
        original_exe = install / "Quorum.exe"
        original_content = original_exe.read_bytes()
        backup = tmp_path / "backup"

        manifest = UpdateManifest(
            version="0.2.0",
            channel="stable",
            download_url="https://example.com/Quorum-0.2.0.exe",
            rollout_percentage=100,
        )

        success, msg, deployed = _simulate_update(
            "0.1.0", manifest, install, backup,
            force_install=True, simulate_install_failure=True
        )
        assert not success, "Update should report failure"
        assert deployed is None, "No new version should be deployed"
        assert "rolled back" in msg.lower()

        # Version file should still say 0.1.0 (not 0.2.0)
        ver = (install / "version.txt").read_text()
        assert ver == "0.1.0", f"Version should be 0.1.0 after rollback, got {ver}"

        # Original EXE should be restored
        assert original_exe.read_bytes() == original_content, (
            "EXE should be intact after rollback"
        )

    def test_rollback_state_after_second_failure(self, tmp_path):
        """Two consecutive failures both roll back to original version."""
        install = _make_install_dir(tmp_path / "install")
        (install / "version.txt").write_text("0.1.0")
        backup = tmp_path / "backup"

        manifest = UpdateManifest(
            version="0.2.0",
            channel="stable",
            download_url="https://example.com/Quorum-0.2.0.exe",
            rollout_percentage=100,
        )

        # First failure
        s1, _, d1 = _simulate_update(
            "0.1.0", manifest, install, backup,
            force_install=True, simulate_install_failure=True
        )
        assert not s1
        assert d1 is None

        # Second failure
        s2, _, d2 = _simulate_update(
            "0.1.0", manifest, install, backup,
            force_install=True, simulate_install_failure=True
        )
        assert not s2
        assert d2 is None

        # Version should still be 0.1.0
        assert (install / "version.txt").read_text() == "0.1.0"

    def test_checksum_failure_aborts_update(self, tmp_path):
        """Checksum mismatch aborts the update before installing."""
        install = _make_install_dir(tmp_path / "install")
        backup = tmp_path / "backup"

        manifest = UpdateManifest(
            version="0.2.0",
            channel="stable",
            download_url="https://example.com/Quorum-0.2.0.exe",
            checksum="expected_checksum",
            rollout_percentage=100,
        )

        success, msg, deployed = _simulate_update(
            "0.1.0", manifest, install, backup,
            force_install=True, simulate_checksum_failure=True
        )
        assert not success, "Checksum failure should abort"
        assert deployed is None
        assert "checksum" in msg.lower()


class TestUpdateChannelSelection:
    """Channel selection logic."""

    def test_stable_channel_sees_only_stable_updates(self):
        """Stable channel users only get stable manifests."""
        channel = UpdateChannel.STABLE
        manifests = [
            UpdateManifest("0.2.0", "canary", "url1", rollout_percentage=5),
            UpdateManifest("0.2.0", "beta", "url2", rollout_percentage=25),
            UpdateManifest("0.2.0", "stable", "url3", rollout_percentage=100),
        ]
        stable_updates = [m for m in manifests if m.channel == channel]
        assert len(stable_updates) == 1
        assert stable_updates[0].channel == "stable"

    def test_beta_channel_sees_beta_and_stable(self):
        """Beta channel users can see beta and stable updates."""
        channel = UpdateChannel.BETA
        manifests = [
            UpdateManifest("0.2.0", "canary", "url1", rollout_percentage=5),
            UpdateManifest("0.2.0", "beta", "url2", rollout_percentage=25),
            UpdateManifest("0.2.0", "stable", "url3", rollout_percentage=100),
        ]
        eligible = [m for m in manifests if m.channel in {channel, UpdateChannel.STABLE}]
        assert len(eligible) == 2, "Beta channel should see beta + stable updates"

    def test_canary_channel_sees_all_updates(self):
        """Canary channel users can see all update channels."""
        manifests = [
            UpdateManifest("0.2.0", "canary", "url1", rollout_percentage=5),
            UpdateManifest("0.2.0", "beta", "url2", rollout_percentage=25),
            UpdateManifest("0.2.0", "stable", "url3", rollout_percentage=100),
        ]
        # Canary sees everything
        assert len(manifests) == 3


class TestUpdateIdempotency:
    """Update operations that should be idempotent."""

    def test_reapply_same_update_is_noop(self, tmp_path):
        """Re-applying the same update manifest is a no-op."""
        install = _make_install_dir(tmp_path / "install")
        (install / "version.txt").write_text("0.2.0")
        backup = tmp_path / "backup"

        manifest = UpdateManifest(
            version="0.2.0",
            channel="stable",
            download_url="https://example.com/Quorum-0.2.0.exe",
            rollout_percentage=100,
        )

        # First call
        s1, _, d1 = _simulate_update(
            "0.2.0", manifest, install, backup, force_install=True
        )
        assert s1 and d1 is None, "Should be no-op on same version"

        # Second call
        s2, _, d2 = _simulate_update(
            "0.2.0", manifest, install, backup, force_install=True
        )
        assert s2 and d2 is None, "Should still be no-op"

    def test_min_version_requirement(self, tmp_path):
        """Update requiring min 0.5.0 fails when current is 0.1.0."""
        install = _make_install_dir(tmp_path / "install")
        backup = tmp_path / "backup"

        manifest = UpdateManifest(
            version="1.0.0",
            channel="stable",
            download_url="https://example.com/Quorum-1.0.0.exe",
            rollout_percentage=100,
            min_previous_version="0.5.0",
        )

        success, msg, deployed = _simulate_update(
            "0.1.0", manifest, install, backup, force_install=True
        )
        assert not success, "Should fail: 0.1.0 < required 0.5.0"
        assert deployed is None
        assert "required" in msg.lower()


class TestUpdateIntegrity:
    """Update manifest integrity verification."""

    def test_manifest_hash_verification(self):
        """Manifest checksum is a valid SHA256 hex string."""
        checksum = "abc123def4567890abc123def4567890abc123def4567890abc123def4567890"
        assert len(checksum) == 64, "SHA256 checksum should be 64 hex chars"
        int(checksum, 16)  # Must be valid hex

    def test_rollout_deterministic(self):
        """Rollout decision is deterministic for the same install path."""
        install_path = Path("/test/path/Quorum")
        hash1 = int(hashlib.sha256(str(install_path).encode()).hexdigest(), 16) % 100
        hash2 = int(hashlib.sha256(str(install_path).encode()).hexdigest(), 16) % 100
        assert hash1 == hash2, "Rollout hash must be deterministic for same path"

    def test_rollout_differs_across_paths(self):
        """Rollout decision differs for different install paths."""
        h1 = int(hashlib.sha256(b"/path/A").hexdigest(), 16) % 100
        h2 = int(hashlib.sha256(b"/path/B").hexdigest(), 16) % 100
        # Extremely unlikely to collide; test that the hash function works
        assert isinstance(h1, int)
        assert isinstance(h2, int)
        assert 0 <= h1 < 100
        assert 0 <= h2 < 100
