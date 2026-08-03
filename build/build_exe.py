#!/usr/bin/env python3
"""
Quorum standalone executable builder.

Builds a single-file executable using PyInstaller that bundles:
- Python interpreter
- quorum_core package (all modules)
- llama-server binary (for LLM inference)

Usage:
    python build/build_exe.py                    # Build for current platform
    python build/build_exe.py --no-llama         # Build without llama-server
    python build/build_exe.py --sign             # Build and code-sign (Windows)
    python build/build_exe.py --compress         # Build with UPX compression
    QUORUM_CODESIGN_CERT=/path/to/cert.pfx python build/build_exe.py --sign

Output:
    dist/Quorum.exe       (Windows)
    dist/Quorum            (Linux)
    dist/Quorum.app        (macOS app bundle)

The resulting executable requires NO external Python installation.
"""

from __future__ import annotations

import os
import sys
import shutil
import argparse
import subprocess
from pathlib import Path


# ---------------------------------------------------------------------------
# Paths relative to repository root
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parent.parent
BUILD_DIR = REPO_ROOT / "build"
DIST_DIR = REPO_ROOT / "dist"
WORK_DIR = REPO_ROOT / "build" / "pyinstaller_work"
SPEC_FILE = BUILD_DIR / "Quorum.spec"

# Platform-specific output
if sys.platform == "win32":
    OUTPUT_NAME = "Quorum.exe"
elif sys.platform == "darwin":
    OUTPUT_NAME = "Quorum.app"
else:
    OUTPUT_NAME = "Quorum"


# ---------------------------------------------------------------------------
# Version info
# ---------------------------------------------------------------------------
def _get_version() -> str:
    """Get version string from build/version.py."""
    version_file = BUILD_DIR / "version.py"
    if version_file.exists():
        scope = {}
        exec(version_file.read_text(), scope)
        return scope.get("FULL_VERSION", "0.1.0")
    return "0.1.0"


# ---------------------------------------------------------------------------
# PyInstaller spec generation
# ---------------------------------------------------------------------------
def generate_spec(bundle_llama: bool, llama_path: Path | None) -> str:
    """Generate a PyInstaller .spec file for the Quorum build.

    The spec file gives us fine-grained control over:
    - Hidden imports for quorum_core submodules
    - Data files bundling (llama-server binary)
    - Output naming
    - UPX and strip settings
    """
    version = _get_version()

    # Build the datas list
    datas_entries = []
    if bundle_llama and llama_path and llama_path.exists():
        if sys.platform == "win32":
            dest_name = "llama-server.exe"
        else:
            dest_name = "llama-server"
        datas_entries.append(f"        ('{llama_path.as_posix()}', '.'),")

    datas_block = "\n".join(datas_entries) if datas_entries else "        # No additional binaries"

    spec = f'''# -*- mode: python ; coding: utf-8 -*-
# Auto-generated PyInstaller spec for Quorum
# Version: {version}

import sys

a = Analysis(
    ['{BUILD_DIR.as_posix()}/launcher.py'],
    pathex=[],
    binaries=[],
    datas=[
{datas_block}
    ],
    hiddenimports=[
        'quorum_core',
        'quorum_core.config',
        'quorum_core.model',
        'quorum_core.policy',
        'quorum_core.execution',
        'quorum_core.discovery',
        'quorum_core.security',
        'desktop',
        'desktop.config_bridge',
        'desktop.config_migration',
        'desktop.config_ui',
        'installer',
        'installer.checksums',
        'hashlib',
        'json',
        'argparse',
        'threading',
        'queue',
        'enum',
        'dataclasses',
        'pathlib',
        'typing',
        'time',
    ],
    hookspath=[],
    hooksconfig={{}},
    runtime_hooks=[],
    excludes=[
        'tkinter',
        'unittest',
        'test',
        'pydoc',
        'distutils',
        'setuptools',
        'pip',
        'wheel',
    ],
    noarchive=False,
    optimize=2,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='{OUTPUT_NAME.replace(".exe", "").replace(".app", "")}',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)

# On macOS, create .app bundle if specified
if sys.platform == 'darwin':
    app = BUNDLE(
        exe,
        name='Quorum.app',
        icon=None,
        bundle_identifier='com.quorum.app',
        info_plist={{
            'CFBundleName': 'Quorum',
            'CFBundleDisplayName': 'Quorum',
            'CFBundleIdentifier': 'com.quorum.app',
            'CFBundleVersion': '{version}',
            'CFBundleShortVersionString': '{version}',
            'NSHighResolutionCapable': True,
        }},
    )
'''
    return spec


# ---------------------------------------------------------------------------
# Build steps
# ---------------------------------------------------------------------------
def clean_build_artifacts() -> None:
    """Remove previous build artifacts."""
    for path in [DIST_DIR, WORK_DIR, SPEC_FILE]:
        if path.exists():
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
    # Also remove PyInstaller cache
    pycache = BUILD_DIR / "__pycache__"
    if pycache.exists():
        shutil.rmtree(pycache)


def ensure_launcher() -> Path:
    """Ensure the launcher.py entry point exists."""
    launcher = BUILD_DIR / "launcher.py"
    if not launcher.exists():
        raise RuntimeError(
            f"Launcher not found: {launcher}\n"
            "The build/launcher.py file is required as the PyInstaller entry point."
        )
    return launcher


def run_pyinstaller(spec_path: Path) -> int:
    """Run PyInstaller with the generated spec file.

    Returns the exit code.
    """
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--distpath", str(DIST_DIR),
        "--workpath", str(WORK_DIR),
        "--noconfirm",
        "--clean",
        str(spec_path),
    ]

    print(f"\n  Running: {' '.join(cmd)}")
    print(f"  Output dir: {DIST_DIR}")
    print()

    result = subprocess.run(cmd, cwd=str(REPO_ROOT))
    return result.returncode


def verify_output() -> dict:
    """Verify the build output meets acceptance criteria.

    Returns a dict with verification results.
    """
    exe_path = DIST_DIR / OUTPUT_NAME
    results = {
        "exists": exe_path.exists(),
        "path": str(exe_path),
        "size_bytes": 0,
        "size_mb": 0.0,
        "under_150mb": False,
    }

    if results["exists"]:
        size = exe_path.stat().st_size
        results["size_bytes"] = size
        results["size_mb"] = size / (1024 * 1024)
        results["under_150mb"] = results["size_mb"] < 150

    return results


def codesign_windows(exe_path: Path) -> bool:
    """Code-sign the Windows executable.

    Certificate can be configured via:
    - QUORUM_CODESIGN_CERT env var (path to .pfx file)
    - QUORUM_CODESIGN_PASSWORD env var (certificate password)
    - QUORUM_CODESIGN_TIMESTAMP env var (timestamp server URL)

    Returns True if signing succeeded.
    """
    cert_path = os.environ.get("QUORUM_CODESIGN_CERT")
    if not cert_path:
        print("  [SKIP] Code signing: QUORUM_CODESIGN_CERT not set")
        return False

    cert_path = Path(cert_path)
    if not cert_path.exists():
        print(f"  [SKIP] Code signing: certificate not found at {cert_path}")
        return False

    password = os.environ.get("QUORUM_CODESIGN_PASSWORD", "")
    timestamp = os.environ.get(
        "QUORUM_CODESIGN_TIMESTAMP",
        "http://timestamp.digicert.com"
    )

    # Find signtool
    signtool = None
    for kit_path in [
        "C:/Program Files (x86)/Windows Kits/10/bin/10.0.22621.0/x64/signtool.exe",
        "C:/Program Files (x86)/Windows Kits/10/bin/10.0.22000.0/x64/signtool.exe",
        "C:/Program Files (x86)/Windows Kits/10/bin/x64/signtool.exe",
    ]:
        if Path(kit_path).exists():
            signtool = kit_path
            break

    if signtool is None:
        # Try PATH
        found = shutil.which("signtool")
        if found:
            signtool = found
        else:
            print("  [SKIP] Code signing: signtool not found in PATH or known locations")
            return False

    cmd = [
        signtool, "sign",
        "/fd", "SHA256",
        "/f", str(cert_path),
        "/t", timestamp,
        str(exe_path),
    ]
    if password:
        cmd.insert(3, "/p")
        cmd.insert(4, password)

    print(f"  Code-signing: {exe_path}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode == 0:
        print("  [OK] Code signing successful")
        return True
    else:
        print(f"  [FAIL] Code signing failed: {result.stderr}")
        return False


# ---------------------------------------------------------------------------
# Main build entry point
# ---------------------------------------------------------------------------
def build(args: argparse.Namespace) -> int:
    """Execute the full build process.

    Returns 0 on success, non-zero on failure.
    """
    print("=" * 60)
    print("  Quorum Standalone Executable Builder")
    print(f"  Platform: {sys.platform}")
    print(f"  Output: {OUTPUT_NAME}")
    print(f"  Version: {_get_version()}")
    print("=" * 60)

    # Step 1: Clean previous build
    if not args.no_clean:
        print("\n[1/5] Cleaning previous build artifacts...")
        clean_build_artifacts()

    # Step 2: Ensure entry point
    print("\n[2/5] Verifying entry point...")
    launcher = ensure_launcher()
    print(f"  Entry point: {launcher}")

    # Step 3: Bundle llama-server
    print("\n[3/5] Bundling llama-server binary...")
    llama_path = None
    if not args.no_llama:
        try:
            from build.bundle_binaries import ensure_llama_server, copy_to_build_dir
            binary = ensure_llama_server(allow_download=not args.offline)
            llama_path = copy_to_build_dir(binary, BUILD_DIR)
        except Exception as e:
            if args.require_llama:
                print(f"  [ERROR] llama-server required but not available: {e}")
                return 1
            print(f"  [WARN] llama-server not available: {e}")
            print("  Building without llama-server. Use --require-llama to fail on this.")
    else:
        print("  Skipped (--no-llama)")

    # Step 4: Generate spec and build
    print("\n[4/5] Building executable with PyInstaller...")
    spec_content = generate_spec(
        bundle_llama=llama_path is not None,
        llama_path=llama_path,
    )
    SPEC_FILE.write_text(spec_content)
    print(f"  Spec file: {SPEC_FILE}")

    exit_code = run_pyinstaller(SPEC_FILE)
    if exit_code != 0:
        print(f"\n  [FAIL] PyInstaller exited with code {exit_code}")
        return exit_code

    # Step 5: Verify and optionally sign
    print("\n[5/5] Verifying output...")
    results = verify_output()
    print(f"  Exists: {results['exists']}")
    print(f"  Path: {results['path']}")
    print(f"  Size: {results['size_mb']:.1f} MB")

    if not results["exists"]:
        print("  [FAIL] Output executable not found!")
        return 1

    if not results["under_150mb"]:
        print(f"  [WARN] Size {results['size_mb']:.1f} MB exceeds 150 MB limit!")

    # Code signing (Windows only)
    if sys.platform == "win32" and args.sign:
        exe_path = DIST_DIR / OUTPUT_NAME
        codesign_windows(exe_path)

    print("\n" + "=" * 60)
    print("  Build complete!")
    print(f"  Output: {results['path']}")
    print(f"  Size: {results['size_mb']:.1f} MB")
    print("=" * 60)

    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build Quorum standalone executable",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python build/build_exe.py                     # Full build
  python build/build_exe.py --no-llama          # Build without llama-server
  python build/build_exe.py --sign              # Build and sign (Windows)
  python build/build_exe.py --offline           # Build without network
  QUORUM_CODESIGN_CERT=cert.pfx python build/build_exe.py --sign
        """,
    )
    parser.add_argument(
        "--no-llama", action="store_true",
        help="Skip bundling llama-server binary",
    )
    parser.add_argument(
        "--require-llama", action="store_true",
        help="Fail if llama-server cannot be bundled",
    )
    parser.add_argument(
        "--offline", action="store_true",
        help="Build without network access (use cached binaries only)",
    )
    parser.add_argument(
        "--no-clean", action="store_true",
        help="Skip cleaning previous build artifacts",
    )
    parser.add_argument(
        "--sign", action="store_true",
        help="Code-sign the executable after building (Windows only)",
    )

    args = parser.parse_args()
    sys.exit(build(args))


if __name__ == "__main__":
    main()
