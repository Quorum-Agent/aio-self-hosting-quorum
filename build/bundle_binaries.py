"""
Binary bundling for Quorum standalone executable.

Handles locating, downloading (at build time), and bundling the
llama-server binary for LLM inference. The binary is embedded into
the final PyInstaller executable so no downloads occur at runtime.

Platform support:
- Windows: llama-server.exe
- Linux: llama-server (x86_64)
- macOS: llama-server (arm64 / x86_64 universal)
"""

from __future__ import annotations

import os
import sys
import shutil
import hashlib
import subprocess
from pathlib import Path
from typing import Optional

# Known llama-server release info
LLAMA_CPP_VERSION = "b5002"
LLAMA_SERVER_BASE = f"https://github.com/ggerganov/llama.cpp/releases/download/{LLAMA_CPP_VERSION}"

# Platform-specific binary names and archive patterns
_PLATFORM = sys.platform

if _PLATFORM == "win32":
    LLAMA_SERVER_NAME = "llama-server.exe"
    LLAMA_ARCHIVE_PATTERN = "llama-b5002-bin-win-{arch}.zip"
    _ARCHS = ["cuda-cu12.4-x64", "avx2-x64", "noavx-x64"]
elif _PLATFORM == "darwin":
    LLAMA_SERVER_NAME = "llama-server"
    _ARCHS = ["arm64", "x64"]
    LLAMA_ARCHIVE_PATTERN = "llama-b5002-bin-macos-{arch}.zip"
else:  # linux
    LLAMA_SERVER_NAME = "llama-server"
    _ARCHS = ["cuda-cu12.4-x64", "avx2-x64", "noavx-x64"]
    LLAMA_ARCHIVE_PATTERN = "llama-b5002-bin-linux-{arch}.zip"

CACHE_DIR = Path.home() / ".cache" / "quorum-build" / "binaries"


def _detect_best_arch() -> str:
    """Detect the best architecture variant available for this platform."""
    try:
        import platform
        machine = platform.machine().lower()
        if machine in ("arm64", "aarch64"):
            if "arm64" in _ARCHS:
                return "arm64"
    except Exception:
        pass

    # Default: try CUDA first, then AVX2, then fallback
    for arch in _ARCHS:
        return arch
    return _ARCHS[-1]


def find_llama_server() -> Optional[Path]:
    """Find llama-server binary from various known locations.

    Search order:
    1. QUORUM_LLAMA_SERVER env var (explicit path)
    2. Cached in ~/.cache/quorum-build/binaries/
    3. System PATH
    4. Project build/ directory
    """
    # 1. Explicit path from environment
    env_path = os.environ.get("QUORUM_LLAMA_SERVER")
    if env_path:
        p = Path(env_path)
        if p.exists():
            return p

    # 2. Cached binary
    cached = CACHE_DIR / LLAMA_SERVER_NAME
    if cached.exists():
        return cached

    # 3. System PATH
    system_path = shutil.which(LLAMA_SERVER_NAME)
    if system_path:
        return Path(system_path)

    # 4. Local build directory
    local = Path(__file__).parent / LLAMA_SERVER_NAME
    if local.exists():
        return local

    return None


def download_llama_server(arch: Optional[str] = None) -> Path:
    """Download llama-server binary from GitHub releases.

    This is BUILD-TIME only. The binary is later embedded into the
    PyInstaller executable so target machines never download anything.

    Args:
        arch: Specific architecture variant (e.g. 'cuda-cu12.4-x64').
              If None, auto-detects the best variant.

    Returns:
        Path to the downloaded binary.

    Raises:
        RuntimeError: If download fails.
    """
    import urllib.request
    import zipfile
    import io

    if arch is None:
        arch = _detect_best_arch()

    archive_name = LLAMA_ARCHIVE_PATTERN.format(arch=arch)
    url = f"{LLAMA_SERVER_BASE}/{archive_name}"

    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    print(f"  Downloading llama-server ({arch}) from:")
    print(f"    {url}")

    try:
        with urllib.request.urlopen(url, timeout=300) as response:
            data = response.read()
    except Exception as e:
        raise RuntimeError(
            f"Failed to download llama-server: {e}\n"
            f"URL: {url}\n"
            f"Set QUORUM_LLAMA_SERVER to a local binary path to skip download."
        )

    # Extract from zip
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        # Find the server binary in the archive
        for name in zf.namelist():
            if name.endswith(LLAMA_SERVER_NAME) or LLAMA_SERVER_NAME in name:
                dest = CACHE_DIR / LLAMA_SERVER_NAME
                with zf.open(name) as src:
                    with open(dest, "wb") as dst:
                        dst.write(src.read())
                # Make executable on Unix
                if _PLATFORM != "win32":
                    dest.chmod(0o755)
                print(f"  Extracted: {dest}")
                return dest

    raise RuntimeError(
        f"Could not find {LLAMA_SERVER_NAME} in archive {archive_name}"
    )


def ensure_llama_server(allow_download: bool = True) -> Path:
    """Ensure llama-server binary is available, downloading if needed.

    Args:
        allow_download: If True, download from GitHub if not found locally.

    Returns:
        Path to llama-server binary.

    Raises:
        RuntimeError: If binary not found and download is disabled or fails.
    """
    binary = find_llama_server()
    if binary:
        print(f"  Using llama-server: {binary}")
        return binary

    if not allow_download:
        raise RuntimeError(
            f"llama-server binary not found. Set QUORUM_LLAMA_SERVER env var "
            f"or place {LLAMA_SERVER_NAME} in PATH."
        )

    return download_llama_server()


def compute_sha256(path: Path) -> str:
    """Compute SHA-256 hash of a file."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(8192)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def copy_to_build_dir(binary_path: Path, build_dir: Path) -> Path:
    """Copy llama-server binary to the build directory for bundling.

    Returns the path to the copied binary.
    """
    build_dir.mkdir(parents=True, exist_ok=True)
    dest = build_dir / LLAMA_SERVER_NAME
    shutil.copy2(binary_path, dest)

    # Make executable on Unix
    if _PLATFORM != "win32":
        dest.chmod(0o755)

    sha = compute_sha256(dest)
    print(f"  Bundled llama-server to: {dest}")
    print(f"  SHA-256: {sha[:16]}...")
    return dest


if __name__ == "__main__":
    # CLI for manual testing
    import argparse
    parser = argparse.ArgumentParser(description="Bundle llama-server binary")
    parser.add_argument("--download", action="store_true", help="Force download")
    parser.add_argument("--arch", help="Architecture variant")
    parser.add_argument("--output-dir", default="build", help="Output directory")
    args = parser.parse_args()

    binary = ensure_llama_server(allow_download=args.download or True)
    if args.output_dir:
        copy_to_build_dir(binary, Path(args.output_dir))
