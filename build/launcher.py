"""
Runtime launcher for the bundled Quorum executable.

This is the PyInstaller entry point. When PyInstaller builds a single-file
executable, this script runs first. It:

1. Detects if running as a bundled executable (sys._MEIPASS)
2. Sets up paths for the bundled llama-server binary
3. Creates a runtime directory for extracted binaries
4. Runs the quorum_core CLI

No downloading occurs at runtime - everything is bundled.
"""

from __future__ import annotations

import os
import sys
import shutil
import atexit
from pathlib import Path


# ---------------------------------------------------------------------------
# Detect PyInstaller bundle
# ---------------------------------------------------------------------------
def _is_bundled() -> bool:
    """Return True if running as a PyInstaller single-file executable."""
    return getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS")


def _get_bundle_dir() -> Path:
    """Get the directory containing bundled data files."""
    if _is_bundled():
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent


def _get_runtime_dir() -> Path:
    """Get or create the runtime directory for extracted binaries.

    On Windows, uses %LOCALAPPDATA%/Quorum/runtime/
    On Linux/macOS, uses ~/.local/share/quorum/runtime/
    """
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
        runtime = base / "Quorum" / "runtime"
    elif sys.platform == "darwin":
        runtime = Path.home() / "Library" / "Application Support" / "Quorum" / "runtime"
    else:
        xdg = os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")
        runtime = Path(xdg) / "quorum" / "runtime"

    runtime.mkdir(parents=True, exist_ok=True)
    return runtime


def _setup_bundled_binary(name: str) -> Path:
    """Extract a bundled binary to the runtime directory if needed.

    Checks if the binary already exists (versioned by mtime) and only
    extracts if missing or outdated.

    Args:
        name: Binary filename (e.g., 'llama-server.exe')

    Returns:
        Path to the ready-to-use binary.
    """
    bundle_dir = _get_bundle_dir()
    runtime_dir = _get_runtime_dir()

    bundled_path = bundle_dir / name
    runtime_path = runtime_dir / name

    # Check if extraction is needed
    needs_extract = True
    if runtime_path.exists() and bundled_path.exists():
        # Use modification time as a simple version check
        if runtime_path.stat().st_mtime >= bundled_path.stat().st_mtime:
            needs_extract = False

    if needs_extract and bundled_path.exists():
        shutil.copy2(bundled_path, runtime_path)
        # Make executable on Unix
        if sys.platform != "win32":
            runtime_path.chmod(0o755)

    return runtime_path


def setup_environment() -> None:
    """Set up the runtime environment for the Quorum executable.

    - Extracts bundled binaries (llama-server) to runtime directory
    - Sets environment variables for quorum_core to find binaries
    - Registers cleanup handlers
    """
    if not _is_bundled():
        # Development mode: use binaries from build/ directory
        return

    # Set up llama-server
    if sys.platform == "win32":
        server_name = "llama-server.exe"
    else:
        server_name = "llama-server"

    try:
        server_path = _setup_bundled_binary(server_name)
        os.environ["QUORUM_LLAMA_SERVER_PATH"] = str(server_path)
    except Exception:
        # If llama-server wasn't bundled (e.g., build without it),
        # continue without it - the CLI will handle the missing binary
        pass


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------
def main():
    """Main entry point for the Quorum executable."""
    setup_environment()

    # Import and run quorum_core's CLI
    from quorum_core.__main__ import main as quorum_main
    quorum_main()


if __name__ == "__main__":
    main()
