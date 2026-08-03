"""
Version management for Quorum builds.

Provides version information used during the build process
and embedded into the final executable.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

# Core version (semantic: MAJOR.MINOR.PATCH)
MAJOR = 0
MINOR = 1
PATCH = 0

VERSION = f"{MAJOR}.{MINOR}.{PATCH}"

# Build metadata
BUILD_TIMESTAMP = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")

# Attempt to read git commit hash if available
_commit_hash = os.environ.get("QUORUM_BUILD_COMMIT", "")
if not _commit_hash:
    try:
        import subprocess
        result = subprocess.run(
            ["git", "rev-parse", "--short=8", "HEAD"],
            capture_output=True, text=True,
        )
        if result.returncode == 0:
            _commit_hash = result.stdout.strip()
    except Exception:
        pass

BUILD_COMMIT = _commit_hash
FULL_VERSION = f"{VERSION}+{BUILD_TIMESTAMP}" + (
    f".{BUILD_COMMIT}" if BUILD_COMMIT else ""
)

# Platform-specific naming
APP_NAME = "Quorum"


def get_version_info() -> dict:
    """Return version information as a dictionary for embedding."""
    return {
        "version": VERSION,
        "build_timestamp": BUILD_TIMESTAMP,
        "build_commit": BUILD_COMMIT,
        "full_version": FULL_VERSION,
        "app_name": APP_NAME,
    }
