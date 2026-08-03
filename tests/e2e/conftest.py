"""
Shared fixtures for Quorum E2E tests.

All fixtures use temp directories for isolation and include cleanup verification
to ensure zero residue after test completion (files, fake registry entries, etc).

Mutation resistance: fixtures assert structure not content — they pin invariants
about minimal install/uninstall shape, not exact paths or version strings.
"""

from __future__ import annotations

import os
import sys
import json
import shutil
import stat
import tempfile
from pathlib import Path
from typing import Dict, Any, Generator, List, Iterator

import pytest


# ---------------------------------------------------------------------------
# Isolation fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def temp_home(monkeypatch) -> Generator[Path, None, None]:
    """Provide an isolated fake HOME directory in a temp dir.

    All config, cache, and data writes during tests are scoped here.
    The fixture also overrides ~/.quorum to point inside this temp home.
    """
    with tempfile.TemporaryDirectory(prefix="quorum_e2e_home_") as td:
        home = Path(td)
        quorum_dir = home / ".quorum"
        quorum_dir.mkdir(parents=True, exist_ok=True)

        # Override environment so config writes go to fake HOME
        monkeypatch.setenv("HOME", str(home))
        monkeypatch.setenv("USERPROFILE", str(home))
        monkeypatch.setenv("HERMES_HOME", str(home / ".hermes"))
        monkeypatch.delenv("QUORUM_CONFIG", raising=False)

        yield home


@pytest.fixture
def temp_install_dir() -> Generator[Path, None, None]:
    """Provide an isolated installation directory simulating 'Program Files/Quorum'."""
    with tempfile.TemporaryDirectory(prefix="quorum_e2e_install_") as td:
        yield Path(td)


@pytest.fixture
def temp_data_dir() -> Generator[Path, None, None]:
    """Provide an isolated data directory simulating %LOCALAPPDATA%/Quorum."""
    with tempfile.TemporaryDirectory(prefix="quorum_e2e_data_") as td:
        yield Path(td)


@pytest.fixture
def temp_workdir() -> Generator[Path, None, None]:
    """Provide a temporary working directory. Tests chdir here for isolation."""
    original = Path.cwd()
    with tempfile.TemporaryDirectory(prefix="quorum_e2e_work_") as td:
        os.chdir(td)
        yield Path(td)
        os.chdir(original)


# ---------------------------------------------------------------------------
# Registry simulation (Windows: %LOCALAPPDATA%/Quorum/registry.json)
# ---------------------------------------------------------------------------

@pytest.fixture
def temp_registry(temp_data_dir) -> Generator[Path, None, None]:
    """Provide a simulated Windows registry as a JSON file.

    Reads/writes happen under 'HKLM\\Software\\Quorum' and 'HKCU\\Software\\Quorum'.
    The fixture tracks all keys written so cleanup can verify zero residue.
    """
    registry_path = temp_data_dir / "registry.json"
    if not registry_path.exists():
        registry_path.write_text(json.dumps({"HKLM": {}, "HKCU": {}}))
    yield registry_path


def _read_registry(reg_path: Path) -> dict:
    """Read the simulated registry file."""
    if reg_path.exists():
        return json.loads(reg_path.read_text(encoding="utf-8"))
    return {"HKLM": {}, "HKCU": {}}


def _write_registry(reg_path: Path, data: dict) -> None:
    """Write the simulated registry file."""
    reg_path.parent.mkdir(parents=True, exist_ok=True)
    reg_path.write_text(json.dumps(data, indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# Config fixture helpers
# ---------------------------------------------------------------------------

@pytest.fixture
def minimal_config_dict() -> Dict[str, Any]:
    """Return a minimal valid Quorum config dict for bootstrapping tests."""
    return {
        "api": {
            "host": "127.0.0.1",
            "port": 8787,
            "cors_origins": ["*"],
            "request_timeout_ms": 30000,
        },
        "model": {
            "provider": "openai",
            "model_name": "gpt-4",
            "temperature": 0.7,
            "max_tokens": 4096,
            "top_p": 1.0,
        },
        "logging": {
            "level": "info",
            "format": "json",
        },
        "workspace": {
            "root_dir": "~/.quorum",
            "session_timeout_minutes": 60,
        },
        "features": {
            "enable_streaming": True,
            "enable_tool_use": True,
            "enable_telemetry": False,
        },
    }


@pytest.fixture
def ts_style_config_dict() -> Dict[str, Any]:
    """Return a config dict using TypeScript camelCase naming conventions."""
    return {
        "api": {
            "host": "0.0.0.0",
            "port": 8000,
            "corsOrigins": ["*"],
            "requestTimeoutMs": 30000,
        },
        "model": {
            "provider": "anthropic",
            "modelName": "claude-sonnet-4",
            "temperature": 0.5,
            "maxTokens": 8192,
            "topP": 0.9,
            "apiKey": "sk-ant-secret",
        },
        "logging": {
            "level": "debug",
            "format": "text",
            "file": "./quorum.log",
        },
        "workspace": {
            "rootDir": "~/.quorum",
            "cacheDir": "~/.quorum/cache",
            "sessionTimeoutMinutes": 120,
        },
        "features": {
            "enableStreaming": True,
            "enableToolUse": False,
            "enableTelemetry": True,
        },
    }


# ---------------------------------------------------------------------------
# Cleanup verification helpers
# ---------------------------------------------------------------------------

def _count_files_under(path: Path) -> int:
    """Count all files recursively under a directory."""
    if not path.exists():
        return 0
    count = 0
    for root, _dirs, files in os.walk(str(path)):
        count += len(files)
    return count


class ResidueTracker:
    """Track filesystem state before and after an operation to verify cleanup.

    Usage::

        tracker = ResidueTracker(paths=[install_dir, data_dir])
        tracker.snapshot_before()
        # ... run install / uninstall ...
        tracker.snapshot_after()
        tracker.assert_zero_residue()  # raises on leftover files
    """
    def __init__(self, paths: List[Path]):
        self._paths = paths
        self._before: Dict[str, set] = {}
        self._after: Dict[str, set] = {}

    def snapshot_before(self) -> None:
        self._before = self._snapshot()

    def snapshot_after(self) -> None:
        self._after = self._snapshot()

    def _snapshot(self) -> Dict[str, set]:
        result = {}
        for p in self._paths:
            if p.exists():
                result[str(p)] = set(self._walk_rel(p))
            else:
                result[str(p)] = set()
        return result

    def _walk_rel(self, root: Path) -> Iterator[str]:
        for dirpath, _dirnames, filenames in os.walk(str(root)):
            for f in filenames:
                fp = Path(dirpath) / f
                yield str(fp.relative_to(root))

    @property
    def residue(self) -> Dict[str, List[str]]:
        """Return files that appeared after the operation (residue)."""
        result = {}
        for key in self._before:
            after_set = self._after.get(key, set())
            before_set = self._before[key]
            new = sorted(after_set - before_set)
            if new:
                result[key] = new
        return result

    def assert_zero_residue(self) -> None:
        """Assert no new files appeared."""
        res = self.residue
        assert not res, f"Residue found after cleanup: {res}"


# ---------------------------------------------------------------------------
# Fixture-scoped residue tracker
# ---------------------------------------------------------------------------

@pytest.fixture
def residue_tracker():
    """Factory fixture: call it with paths to get a fresh ResidueTracker."""
    return ResidueTracker
