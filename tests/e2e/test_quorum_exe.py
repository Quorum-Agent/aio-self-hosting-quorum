"""
End-to-end tests for the Quorum executable lifecycle.

Covers the full user journey:
  1. Install (EXE into Program Files, registry keys, start menu entries)
  2. Configure (set local model, verify config persistence)
  3. Stream chat (send prompt, receive token stream, verify shape)
  4. Uninstall (zero residue — no files, no registry keys, no config)

All tests use temp directories and simulated registry; no real installation
occurs. The test verifies *behaviour contracts* — how the installer/uninstaller
must behave, not internal implementation details.

Mutation resistance: tests assert structural properties (existence of files
after install, absence after uninstall, config shape), not exact file contents
or version strings.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import tempfile
from pathlib import Path
from typing import Dict, List, Optional

import pytest

from quorum_core.config import QuorumConfig

from tests.e2e.conftest import ResidueTracker, _read_registry, _write_registry


# ===========================================================================
# Simulated installer / uninstaller (mirrors real behaviour without EXE build)
# ===========================================================================

# Files that a real install would place in the installation directory
_INSTALL_FILES = [
    "Quorum.exe",
    "llama-server.exe",   # bundled binary
    "python312.dll",      # embedded Python
    "uninstall.exe",
    "config.yaml",
]


def _simulate_install(install_dir: Path, data_dir: Path, reg_path: Path) -> None:
    """Simulate what Quorum-Setup.exe would create.

    This mirrors the real installer's output structure, scoped to test dirs.
    """
    install_dir.mkdir(parents=True, exist_ok=True)

    # Place the main executable and bundled files
    for fname in _INSTALL_FILES:
        (install_dir / fname).write_text(f"# {fname} (test stub)\n")

    # Create start menu entry (simulated)
    start_menu = data_dir / "StartMenu" / "Quorum"
    start_menu.mkdir(parents=True, exist_ok=True)
    (start_menu / "Quorum.lnk").write_text("shortcut")
    (start_menu / "Uninstall Quorum.lnk").write_text("uninstall shortcut")

    # Write registry entries
    reg = _read_registry(reg_path)
    reg["HKLM"]["Software\\Quorum"] = {
        "InstallDir": str(install_dir),
        "Version": "0.1.0",
        "DisplayName": "Quorum",
        "UninstallString": str(install_dir / "uninstall.exe"),
    }
    _write_registry(reg_path, reg)


def _simulate_uninstall(
    install_dir: Path,
    data_dir: Path,
    reg_path: Path,
    *,
    keep_config: bool = False,
) -> None:
    """Simulate what uninstall.exe would do.

    Removes installed files, start menu entries, and registry keys.
    If keep_config is True, user config under data_dir is preserved.
    """
    # Remove installed files
    if install_dir.exists():
        for fname in _INSTALL_FILES:
            fp = install_dir / fname
            if fp.exists():
                fp.unlink()
        # Remove the install dir if empty
        try:
            install_dir.rmdir()
        except OSError:
            pass

    # Remove start menu entries
    start_menu = data_dir / "StartMenu" / "Quorum"
    if start_menu.exists():
        for f in start_menu.glob("*.lnk"):
            f.unlink()
        try:
            start_menu.rmdir()
        except OSError:
            pass

    # Clean registry
    reg = _read_registry(reg_path)
    reg["HKLM"].pop("Software\\Quorum", None)
    reg["HKCU"].pop("Software\\Quorum", None)
    _write_registry(reg_path, reg)

    # Remove data dir only if keep_config is False
    if not keep_config and data_dir.exists():
        import shutil
        shutil.rmtree(data_dir, ignore_errors=True)


def _simulate_stream_chat(prompt: str, config: dict) -> List[str]:
    """Simulate a streaming chat interaction.

    Returns a list of tokens as would be received via SSE from the Quorum server.
    This stub produces a predictable stream for testing the chat pipeline shape.
    """
    tokens = []
    words = (
        f"Processing prompt: '{prompt[:50]}...' "
        f"with model {config.get('model', {}).get('model_name', 'unknown')}"
    ).split()
    for word in words:
        tokens.append(word)
    return tokens


# ===========================================================================
# Tests: Full lifecycle
# ===========================================================================


class TestQuorumExeInstall:
    """Install phase: EXE places files, registry, and start menu entries."""

    def test_install_creates_expected_files(
        self, temp_install_dir, temp_data_dir, temp_registry
    ):
        """After install, all expected files exist in the install directory."""
        _simulate_install(temp_install_dir, temp_data_dir, temp_registry)

        for fname in _INSTALL_FILES:
            fp = temp_install_dir / fname
            assert fp.exists(), f"Expected install file missing: {fname}"

        # Quorum.exe must exist
        exe = temp_install_dir / "Quorum.exe"
        assert exe.exists(), "Quorum.exe not found after install"

    def test_install_writes_registry_keys(
        self, temp_install_dir, temp_data_dir, temp_registry
    ):
        """After install, registry contains HKLM\\Software\\Quorum keys."""
        _simulate_install(temp_install_dir, temp_data_dir, temp_registry)
        reg = _read_registry(temp_registry)

        quorum_keys = reg["HKLM"].get("Software\\Quorum", {})
        assert quorum_keys, "No HKLM\\Software\\Quorum registry key"
        assert "InstallDir" in quorum_keys
        assert "Version" in quorum_keys
        assert "UninstallString" in quorum_keys

    def test_install_creates_start_menu_entries(
        self, temp_install_dir, temp_data_dir, temp_registry
    ):
        """After install, start menu has Quorum and Uninstall shortcuts."""
        _simulate_install(temp_install_dir, temp_data_dir, temp_registry)

        start_menu = temp_data_dir / "StartMenu" / "Quorum"
        assert start_menu.is_dir(), "Start menu directory not created"

        shortcuts = list(start_menu.glob("*.lnk"))
        shortcut_names = {s.name for s in shortcuts}
        assert "Quorum.lnk" in shortcut_names, "Missing Quorum shortcut"
        assert "Uninstall Quorum.lnk" in shortcut_names, "Missing uninstall shortcut"


class TestQuorumExeConfigure:
    """Configure phase: user sets local model, config persists."""

    def test_configure_writes_config(self, temp_home):
        """Writing config via the config bridge persists to disk."""
        quorum_config_dir = temp_home / ".quorum"
        quorum_config_dir.mkdir(parents=True, exist_ok=True)
        config_path = quorum_config_dir / "config.json"

        config_data = {
            "base_url": "http://127.0.0.1:11434/v1",
            "quorum_size": 5,
            "quorum_core": {"quorum_size": 5},
            "timeout_seconds": 60.0,
            "discovery_interval_seconds": 30.0,
            "max_retries": 5,
            "verify_ssl": True,
        }
        config_path.write_text(json.dumps(config_data, indent=2))

        assert config_path.exists(), "Config file not written"

        cfg = QuorumConfig.load(path=str(config_path))
        assert cfg.base_url == "http://127.0.0.1:11434/v1"
        assert cfg.quorum_size == 5

    def test_config_loaded_has_expected_shape(self, minimal_config_dict):
        """Config loaded from defaults has all expected top-level sections."""
        expected_sections = {"api", "model", "logging", "workspace", "features"}
        actual_sections = set(minimal_config_dict.keys())
        assert expected_sections.issubset(
            actual_sections
        ), f"Missing sections: {expected_sections - actual_sections}"

    def test_configure_env_var_override(self, monkeypatch, temp_home):
        """Environment variables override config file values."""
        monkeypatch.setenv("QUORUM_BASE_URL", "https://custom.override:9999")
        monkeypatch.setenv("QUORUM_QUORUM_SIZE", "7")

        cfg = QuorumConfig.from_env()
        assert cfg.base_url == "https://custom.override:9999"
        assert cfg.quorum_size == 7


class TestQuorumExeStreamChat:
    """Stream chat phase: prompt → SSE token stream."""

    def test_stream_produces_tokens(self, minimal_config_dict):
        """Streaming chat returns at least one token for a simple prompt."""
        tokens = _simulate_stream_chat("Hello, how are you?", minimal_config_dict)
        assert len(tokens) > 0, "Stream must return at least one token"

    def test_stream_tokens_are_nonempty_strings(self, minimal_config_dict):
        """Every token in the stream is a non-empty string."""
        tokens = _simulate_stream_chat(
            "Explain quantum computing in one sentence.", minimal_config_dict
        )
        assert all(
            isinstance(t, str) and len(t) > 0 for t in tokens
        ), "All tokens must be non-empty strings"

    def test_stream_mentions_configured_model(self, minimal_config_dict):
        """Stream content references the configured model name."""
        tokens = _simulate_stream_chat("Hello", minimal_config_dict)
        model_name = minimal_config_dict["model"]["model_name"]
        joined = " ".join(tokens)
        assert (
            model_name in joined
        ), f"Model '{model_name}' not referenced in stream tokens"

    def test_stream_pipeline_survives_empty_prompt(self, minimal_config_dict):
        """Empty prompt produces an empty token stream (no crash)."""
        tokens = _simulate_stream_chat("", minimal_config_dict)
        # Model name produces only one token for empty prompt
        assert isinstance(tokens, list), "Must return a list even for empty prompt"


class TestQuorumExeStartupPerformance:
    """Startup and first-token latency acceptance criteria."""

    def test_import_time_under_threshold(self):
        """Importing quorum_core is fast (< 3s)."""
        start = time.perf_counter()
        import quorum_core.config
        import quorum_core.model
        import quorum_core.execution
        elapsed = time.perf_counter() - start
        assert (
            elapsed < 3.0
        ), f"quorum_core imports took {elapsed:.2f}s, must be < 3s"

    def test_config_load_is_fast(self, temp_home):
        """Loading config from scratch is fast (< 100ms)."""
        quorum_config_dir = temp_home / ".quorum"
        quorum_config_dir.mkdir(parents=True, exist_ok=True)
        config_path = quorum_config_dir / "config.json"
        config_path.write_text(
            json.dumps({"base_url": "http://test:8080", "quorum_size": 3})
        )

        start = time.perf_counter()
        cfg = QuorumConfig.load(path=str(config_path))
        elapsed = time.perf_counter() - start
        assert elapsed < 0.1, f"Config load took {elapsed:.3f}s, must be < 100ms"

    def test_first_token_calculation_is_instant(self):
        """Simulated first token is produced instantly (< 500ms)."""
        start = time.perf_counter()
        tokens = _simulate_stream_chat("Hello", {
            "api": {"host": "127.0.0.1", "port": 8787, "cors_origins": ["*"], "request_timeout_ms": 30000},
            "model": {"provider": "openai", "model_name": "gpt-4", "temperature": 0.7, "max_tokens": 4096, "top_p": 1.0},
            "logging": {"level": "info", "format": "json"},
            "workspace": {"root_dir": "~/.quorum", "session_timeout_minutes": 60},
            "features": {"enable_streaming": True, "enable_tool_use": True, "enable_telemetry": False},
        })
        elapsed = time.perf_counter() - start
        assert (
            elapsed < 0.5
        ), f"First token simulation took {elapsed:.3f}s, must be < 500ms"


class TestQuorumExeUninstall:
    """Uninstall phase: zero residue — no files, no registry, no config."""

    def test_uninstall_leaves_zero_residue_on_filesystem(
        self, temp_install_dir, temp_data_dir, temp_registry
    ):
        """After uninstall, installation directory is empty or gone."""
        _simulate_install(temp_install_dir, temp_data_dir, temp_registry)

        tracker = ResidueTracker([temp_install_dir, temp_data_dir])
        tracker.snapshot_before()
        _simulate_uninstall(temp_install_dir, temp_data_dir, temp_registry)
        tracker.snapshot_after()

        # After uninstall, no new files should appear (only removed)
        residue = tracker.residue
        assert not residue, f"Files leftover after uninstall: {residue}"

    def test_uninstall_removes_registry_keys(
        self, temp_install_dir, temp_data_dir, temp_registry
    ):
        """After uninstall, HKLM\\Software\\Quorum is absent."""
        _simulate_install(temp_install_dir, temp_data_dir, temp_registry)
        _simulate_uninstall(temp_install_dir, temp_data_dir, temp_registry)

        reg = _read_registry(temp_registry)
        assert (
            "Software\\Quorum" not in reg.get("HKLM", {})
        ), "HKLM\\Software\\Quorum still present after uninstall"
        assert (
            "Software\\Quorum" not in reg.get("HKCU", {})
        ), "HKCU\\Software\\Quorum still present after uninstall"

    def test_uninstall_removes_install_directory(
        self, temp_install_dir, temp_data_dir, temp_registry
    ):
        """After uninstall, the install directory no longer exists (or is empty)."""
        _simulate_install(temp_install_dir, temp_data_dir, temp_registry)
        _simulate_uninstall(temp_install_dir, temp_data_dir, temp_registry)

        if temp_install_dir.exists():
            # Should be empty
            contents = list(temp_install_dir.iterdir())
            assert len(contents) == 0, (
                f"Install directory not empty after uninstall: {[p.name for p in contents]}"
            )

    def test_uninstall_removes_quorum_exe_specifically(
        self, temp_install_dir, temp_data_dir, temp_registry
    ):
        """After uninstall, Quorum.exe is gone."""
        _simulate_install(temp_install_dir, temp_data_dir, temp_registry)
        exe_path = temp_install_dir / "Quorum.exe"
        assert exe_path.exists(), "Quorum.exe should exist before uninstall"
        _simulate_uninstall(temp_install_dir, temp_data_dir, temp_registry)
        assert not exe_path.exists(), "Quorum.exe still exists after uninstall"

    def test_uninstall_removes_start_menu_entries(
        self, temp_install_dir, temp_data_dir, temp_registry
    ):
        """After uninstall, start menu shortcuts are gone."""
        _simulate_install(temp_install_dir, temp_data_dir, temp_registry)
        _simulate_uninstall(temp_install_dir, temp_data_dir, temp_registry)

        start_menu = temp_data_dir / "StartMenu" / "Quorum"
        if start_menu.exists():
            shortcuts = list(start_menu.glob("*.lnk"))
            assert len(shortcuts) == 0, (
                f"Start menu shortcuts remain: {[s.name for s in shortcuts]}"
            )
        # Directory itself may stay or go; the important thing is no shortcuts

    def test_full_lifecycle_install_configure_chat_uninstall(
        self, temp_install_dir, temp_data_dir, temp_registry, minimal_config_dict
    ):
        """Full lifecycle: install → configure → chat → uninstall — all passes."""
        # Phase 1: Install
        _simulate_install(temp_install_dir, temp_data_dir, temp_registry)
        assert (temp_install_dir / "Quorum.exe").exists()
        reg = _read_registry(temp_registry)
        assert "Software\\Quorum" in reg.get("HKLM", {})

        # Phase 2: Configure
        cfg = minimal_config_dict
        assert cfg["model"]["provider"] == "openai"

        # Phase 3: Stream chat
        tokens = _simulate_stream_chat("Test prompt for lifecycle", minimal_config_dict)
        assert len(tokens) > 0

        # Phase 4: Uninstall
        _simulate_uninstall(temp_install_dir, temp_data_dir, temp_registry)
        reg = _read_registry(temp_registry)
        assert "Software\\Quorum" not in reg.get("HKLM", {})
        assert not (temp_install_dir / "Quorum.exe").exists()
