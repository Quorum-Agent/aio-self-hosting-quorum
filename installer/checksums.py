#!/usr/bin/env python3
"""
installer/checksums.py — SHA-256 checksum manifest generator and verifier.

Generates and verifies SHA-256 checksums for Quorum distribution artifacts.
Supports both the standard SHA256SUMS format (used by GitHub Releases) and
a structured JSON format for programmatic use.

Usage:
    # Generate a SHA256SUMS manifest for all files in dist/
    python installer/checksums.py generate dist/
    python installer/checksums.py generate dist/ --output dist/SHA256SUMS
    python installer/checksums.py generate dist/ --format json
    python installer/checksums.py generate dist/ --tag v0.1.0

    # Verify all files in a directory against a manifest
    python installer/checksums.py verify dist/ --manifest dist/SHA256SUMS
    python installer/checksums.py verify dist/

    # Verify a single file
    python installer/checksums.py check dist/Quorum.exe --expected <sha256>

    # Print checksums for specific files
    python installer/checksums.py print dist/Quorum.exe dist/Quorum-Setup.exe

Output format (SHA256SUMS):
    <sha256hex>  <filename>
    <sha256hex>  <filename>

JSON format:
    {
      "release": "v0.1.0",
      "generated": "2025-01-01T00:00:00Z",
      "files": {
        "Quorum-Setup-0.1.0.exe": "abc123...",
        "quorum_0.1.0_amd64.deb": "def456..."
      }
    }
"""

from __future__ import annotations

import sys
import json
import hashlib
import argparse
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


# ---------------------------------------------------------------------------
# Core: SHA-256 computation
# ---------------------------------------------------------------------------

def compute_sha256(file_path: Path) -> str:
    """Compute SHA-256 hash of a file.

    Args:
        file_path: Path to the file to hash.

    Returns:
        Hex-encoded SHA-256 digest (lowercase, 64 chars).

    Raises:
        FileNotFoundError: If the file does not exist.
    """
    if not file_path.is_file():
        raise FileNotFoundError(f"File not found: {file_path}")

    sha = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            sha.update(chunk)
    return sha.hexdigest()


# ---------------------------------------------------------------------------
# Manifest generation
# ---------------------------------------------------------------------------

def generate_sha256sums(
    directory: Path,
    output_path: Optional[Path] = None,
) -> dict[str, str]:
    """Generate checksums for all regular files in a directory.

    Skips hidden files (starting with '.') and the SHA256SUMS file itself.
    Returns a dict mapping filename → SHA-256 hex string.
    """
    checksums: dict[str, str] = {}
    files = sorted(
        f for f in directory.iterdir()
        if f.is_file() and not f.name.startswith(".") and f.name != "SHA256SUMS"
    )

    for file_path in files:
        checksums[file_path.name] = compute_sha256(file_path)

    return checksums


def write_sha256sums_format(checksums: dict[str, str], output: Path) -> None:
    """Write checksums in standard SHA256SUMS format (hash + two spaces + filename)."""
    lines = [f"{h}  {f}" for f, h in sorted(checksums.items())]
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_json_format(
    checksums: dict[str, str],
    output: Path,
    release_tag: str = "",
) -> None:
    """Write checksums in structured JSON format."""
    data = {
        "release": release_tag,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "files": dict(sorted(checksums.items())),
    }
    output.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Manifest parsing
# ---------------------------------------------------------------------------

def _validate_manifest_filename(filename: str) -> str:
    """Validate a filename from a manifest to prevent path traversal (C10-SEC-11).

    Returns the sanitized filename (basename only) or raises ValueError.
    """
    import os.path as _osp
    # Reject empty or whitespace-only filenames
    if not filename or not filename.strip():
        raise ValueError("Manifest entry has empty filename")
    # Resolve and check no traversal
    normalized = _osp.normpath(filename.strip())
    if normalized.startswith("..") or _osp.isabs(normalized):
        raise ValueError(
            f"Manifest filename attempts path traversal: {filename!r}"
        )
    # Only allow the base filename (strip any directory components)
    basename = _osp.basename(normalized)
    if not basename or basename in (".", ".."):
        raise ValueError(f"Manifest filename resolves to empty: {filename!r}")
    return basename


def parse_sha256sums(manifest_path: Path) -> dict[str, str]:
    """Parse a SHA256SUMS-format manifest file.

    Format: <sha256hex>  <filename>  (two spaces separator)
    Also handles one-space and tab separators for robustness.

    Returns:
        Dict mapping filename → expected SHA-256 hex string.
    """
    checksums: dict[str, str] = {}
    content = manifest_path.read_text(encoding="utf-8")

    for line in content.strip().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # Split on whitespace — first token is hash, rest is filename
        parts = line.split(None, 1)
        if len(parts) == 2:
            hash_hex, filename = parts
            hash_hex = hash_hex.strip().lower()
            if len(hash_hex) == 64 and all(c in "0123456789abcdef" for c in hash_hex):
                checksums[_validate_manifest_filename(filename)] = hash_hex

    return checksums


def parse_json_manifest(manifest_path: Path) -> dict[str, str]:
    """Parse a JSON-format checksum manifest.

    Expected format:
    {
      "files": { "filename": "sha256hex", ... }
    }
    Also supports "checksums" key (legacy format).
    """
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    files = data.get("files") or data.get("checksums") or {}
    return {
        _validate_manifest_filename(str(k)): str(v).strip().lower()
        for k, v in files.items()
    }


def parse_manifest(manifest_path: Path) -> dict[str, str]:
    """Auto-detect and parse a checksum manifest file.

    Supports .json files (JSON format) and .txt / SHA256SUMS (text format).
    """
    if not manifest_path.exists():
        raise FileNotFoundError(f"Manifest not found: {manifest_path}")

    if manifest_path.suffix.lower() == ".json":
        return parse_json_manifest(manifest_path)
    else:
        return parse_sha256sums(manifest_path)


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

def verify_file(file_path: Path, expected_sha256: str) -> bool:
    """Verify a single file's checksum against an expected value.

    Returns True on match, False on mismatch.
    """
    actual = compute_sha256(file_path)
    match = actual == expected_sha256.lower()
    return match


def verify_directory(
    directory: Path,
    manifest: dict[str, str],
) -> tuple[int, int, list[str]]:
    """Verify all files in a directory against a checksum manifest.

    Checks every file listed in the manifest that also exists in the directory.
    Reports files that are in the manifest but missing from the directory.

    Returns:
        Tuple of (passed_count, failed_count, error_messages).
    """
    passed = 0
    failed = 0
    errors: list[str] = []

    for filename, expected_hash in sorted(manifest.items()):
        file_path = directory / filename

        if not file_path.exists():
            # Try case-insensitive match on Windows
            found = None
            for candidate in directory.iterdir():
                if candidate.name.lower() == filename.lower():
                    found = candidate
                    break
            if found:
                file_path = found
            else:
                failed += 1
                errors.append(f"MISSING: {filename} (listed in manifest but not found)")
                continue

        try:
            if verify_file(file_path, expected_hash):
                passed += 1
            else:
                actual = compute_sha256(file_path)
                failed += 1
                errors.append(
                    f"FAIL: {filename}\n"
                    f"  Expected: {expected_hash}\n"
                    f"  Actual:   {actual}"
                )
        except Exception as e:
            failed += 1
            errors.append(f"ERROR: {filename} — {e}")

    return passed, failed, errors


# ---------------------------------------------------------------------------
# CLI Commands
# ---------------------------------------------------------------------------

def cmd_generate(args: argparse.Namespace) -> int:
    """Generate a checksum manifest."""
    directory = Path(args.directory)
    if not directory.is_dir():
        print(f"[ERROR] Directory not found: {directory}", file=sys.stderr)
        return 1

    checksums = generate_sha256sums(directory)

    if not checksums:
        print("[WARN] No files found in directory. Nothing to checksum.", file=sys.stderr)
        return 1

    output_path = args.output
    if output_path is None:
        if args.format == "json":
            output_path = directory / "checksums.json"
        else:
            output_path = directory / "SHA256SUMS"

    if args.format == "json":
        write_json_format(checksums, output_path, release_tag=args.tag or "")
    else:
        write_sha256sums_format(checksums, output_path)

    print(f"[OK] Wrote {len(checksums)} checksums to {output_path}")
    for fname, h in sorted(checksums.items()):
        print(f"  {h[:16]}...  {fname}")

    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    """Verify files against a manifest."""
    directory = Path(args.directory)
    if not directory.is_dir():
        print(f"[ERROR] Directory not found: {directory}", file=sys.stderr)
        return 1

    # Auto-detect manifest
    manifest_path = args.manifest
    if manifest_path is None:
        # Try common manifest names
        for candidate_name in ["SHA256SUMS", "checksums.json", "release_checksums.json"]:
            candidate = directory / candidate_name
            if candidate.exists():
                manifest_path = candidate
                break

    if manifest_path is None:
        print("[ERROR] No manifest found. Specify with --manifest or place SHA256SUMS in the directory.",
              file=sys.stderr)
        return 1

    print(f"Verifying against: {manifest_path}")

    try:
        expected = parse_manifest(manifest_path)
    except Exception as e:
        print(f"[ERROR] Failed to parse manifest: {e}", file=sys.stderr)
        return 1

    print(f"  Manifest contains {len(expected)} file(s)")

    passed, failed, errors = verify_directory(directory, expected)
    total = passed + failed

    # Print results
    for error in errors:
        print(f"  {error}")

    print()
    print(f"{'='*50}")
    print(f"  Results: {passed}/{total} passed, {failed} failed")

    if failed > 0:
        print(f"  [FAIL] Verification incomplete — {failed} failure(s)")
        return 1
    else:
        print(f"  [OK] All {total} files verified successfully")
        return 0


def cmd_check(args: argparse.Namespace) -> int:
    """Check a single file against an expected hash."""
    file_path = Path(args.file)
    expected = args.expected.strip().lower()

    if not file_path.is_file():
        print(f"[ERROR] File not found: {file_path}", file=sys.stderr)
        return 1

    actual = compute_sha256(file_path)
    match = actual == expected

    print(f"File:     {file_path.name}")
    print(f"Expected: {expected}")
    print(f"Actual:   {actual}")
    print(f"Match:    {'[OK]' if match else '[FAIL]'}")

    return 0 if match else 1


def cmd_print(args: argparse.Namespace) -> int:
    """Print checksums for specified files."""
    exit_code = 0
    for file_arg in args.files:
        file_path = Path(file_arg)
        try:
            h = compute_sha256(file_path)
            print(f"{h}  {file_path.name}")
        except FileNotFoundError:
            print(f"[ERROR] File not found: {file_path}", file=sys.stderr)
            exit_code = 1
    return exit_code


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Quorum checksum manifest generator and verifier",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python installer/checksums.py generate dist/                    # Generate SHA256SUMS
  python installer/checksums.py generate dist/ --format json       # Generate checksums.json
  python installer/checksums.py verify dist/                       # Verify against SHA256SUMS
  python installer/checksums.py verify dist/ --manifest custom.txt # Verify against custom manifest
  python installer/checksums.py check dist/Quorum.exe --expected abc123...
  python installer/checksums.py print dist/Quorum.exe dist/Quorum-Setup.exe
        """,
    )

    subparsers = parser.add_subparsers(dest="command", help="Command")

    # --- generate ---
    gen_parser = subparsers.add_parser("generate", help="Generate a checksum manifest")
    gen_parser.add_argument("directory", help="Directory containing release files")
    gen_parser.add_argument("--output", "-o", type=Path, help="Output manifest file path")
    gen_parser.add_argument("--format", "-f", choices=["sha256sums", "json"],
                            default="sha256sums", help="Output format (default: sha256sums)")
    gen_parser.add_argument("--tag", help="Release tag for JSON metadata (e.g. v0.1.0)")

    # --- verify ---
    verify_parser = subparsers.add_parser("verify", help="Verify files against a manifest")
    verify_parser.add_argument("directory", help="Directory containing files to verify")
    verify_parser.add_argument("--manifest", "-m", type=Path,
                               help="Path to manifest file (auto-detected if omitted)")

    # --- check ---
    check_parser = subparsers.add_parser("check", help="Check a single file's checksum")
    check_parser.add_argument("file", help="File to check")
    check_parser.add_argument("--expected", "-e", required=True, help="Expected SHA-256 hex digest")

    # --- print ---
    print_parser = subparsers.add_parser("print", help="Print checksums for files")
    print_parser.add_argument("files", nargs="+", help="Files to checksum")

    args = parser.parse_args()
    if args.command is None:
        parser.print_help()
        sys.exit(1)

    if args.command == "generate":
        sys.exit(cmd_generate(args))
    elif args.command == "verify":
        sys.exit(cmd_verify(args))
    elif args.command == "check":
        sys.exit(cmd_check(args))
    elif args.command == "print":
        sys.exit(cmd_print(args))
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
