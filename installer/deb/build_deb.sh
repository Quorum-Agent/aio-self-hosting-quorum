#!/usr/bin/env bash
# build_deb.sh — Build a .deb package for Quorum
#
# Usage:
#   ./installer/deb/build_deb.sh                    # Build from dist/
#   ./installer/deb/build_deb.sh --version 0.2.0    # Override version
#   ./installer/deb/build_deb.sh --no-appimage       # Skip AppImage build
#
# Prerequisites:
#   - Python build already complete: dist/Quorum exists
#   - dpkg-deb (from dpkg) is available
#   - appimagetool (for AppImage, optional)
#
# Output:
#   dist/quorum_<version>_amd64.deb
#   dist/Quorum-<version>-x86_64.AppImage  (if appimagetool available)
#------------------------------------------------------------------------------

set -euo pipefail

# --- Paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DIST_DIR="$REPO_ROOT/dist"
DEB_SRC_DIR="$SCRIPT_DIR"
PACKAGE_NAME="quorum"

# --- Version ---
if [ -f "$REPO_ROOT/build/version.py" ]; then
    VERSION=$(python3 -c "import sys; sys.path.insert(0, '$REPO_ROOT/build'); from version import VERSION; print(VERSION)" 2>/dev/null || echo "0.1.0")
else
    VERSION="0.1.0"
fi

# --- Parse arguments ---
BUILD_APPIMAGE=true
while [[ $# -gt 0 ]]; do
    case "$1" in
        --version) VERSION="$2"; shift 2 ;;
        --no-appimage) BUILD_APPIMAGE=false; shift ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

DEB_NAME="${PACKAGE_NAME}_${VERSION}_amd64"
DEB_BUILD_DIR="$DIST_DIR/${DEB_NAME}"

echo "============================================"
echo "  Quorum .deb Package Builder"
echo "  Version: ${VERSION}"
echo "  Output:  ${DEB_NAME}.deb"
echo "============================================"

# --- Validate input ---
QUORUM_BIN="$DIST_DIR/Quorum"
if [ ! -f "$QUORUM_BIN" ]; then
    echo "[ERROR] Quorum executable not found at $QUORUM_BIN"
    echo "  Run 'python build/build_exe.py' first to produce dist/Quorum"
    exit 1
fi

if ! command -v dpkg-deb &> /dev/null; then
    echo "[ERROR] dpkg-deb not found. Install dpkg (apt install dpkg)."
    echo "  On non-Debian systems, .deb packages can be built in CI only."
    exit 1
fi

# --- Clean and create build directory ---
rm -rf "$DEB_BUILD_DIR"
mkdir -p "$DEB_BUILD_DIR/DEBIAN"
mkdir -p "$DEB_BUILD_DIR/opt/quorum"
mkdir -p "$DEB_BUILD_DIR/usr/bin"
mkdir -p "$DEB_BUILD_DIR/usr/share/applications"
mkdir -p "$DEB_BUILD_DIR/usr/share/icons/hicolor/256x256/apps"
mkdir -p "$DEB_BUILD_DIR/usr/share/doc/quorum"

# --- Copy binary ---
cp "$QUORUM_BIN" "$DEB_BUILD_DIR/opt/quorum/Quorum"
chmod 755 "$DEB_BUILD_DIR/opt/quorum/Quorum"

# --- Copy desktop entry ---
if [ -f "$DEB_SRC_DIR/quorum.desktop" ]; then
    cp "$DEB_SRC_DIR/quorum.desktop" "$DEB_BUILD_DIR/opt/quorum/quorum.desktop"
    cp "$DEB_SRC_DIR/quorum.desktop" "$DEB_BUILD_DIR/usr/share/applications/quorum.desktop"
fi

# --- Copy icon (optional, won't fail if missing) ---
for icon_path in \
    "$DEB_SRC_DIR/quorum.png" \
    "$REPO_ROOT/assets/quorum.png" \
    "$REPO_ROOT/assets/quorum_256.png"; do
    if [ -f "$icon_path" ]; then
        cp "$icon_path" "$DEB_BUILD_DIR/opt/quorum/quorum.png"
        cp "$icon_path" "$DEB_BUILD_DIR/usr/share/icons/hicolor/256x256/apps/quorum.png"
        break
    fi
done

# --- Render control file with version ---
CONTROL_SRC="$DEB_SRC_DIR/control"
CONTROL_DST="$DEB_BUILD_DIR/DEBIAN/control"
if [ -f "$CONTROL_SRC" ]; then
    sed "s/^Version:.*/Version: ${VERSION}/" "$CONTROL_SRC" > "$CONTROL_DST"
    # Compute installed size
    INSTALLED_SIZE=$(du -sk "$DEB_BUILD_DIR" --exclude=DEBIAN | cut -f1)
    echo "Installed-Size: ${INSTALLED_SIZE}" >> "$CONTROL_DST"
else
    echo "[WARN] control file not found, generating minimal control"
    cat > "$CONTROL_DST" << EOF
Package: quorum
Version: ${VERSION}
Section: utils
Priority: optional
Architecture: amd64
Depends: libc6 (>= 2.28), libstdc++6 (>= 8), ca-certificates
Maintainer: Quorum <dev@quorum.example.com>
Homepage: https://github.com/quorum/Quorum
Description: Quorum — AI Model Router & Orchestration Engine
 Quorum is a self-hosted AI orchestration engine.
EOF
fi

# --- Copy maintainer scripts ---
for script in postinst prerm; do
    if [ -f "$DEB_SRC_DIR/$script" ]; then
        cp "$DEB_SRC_DIR/$script" "$DEB_BUILD_DIR/DEBIAN/$script"
        chmod 755 "$DEB_BUILD_DIR/DEBIAN/$script"
    fi
done

# --- Create changelog stub ---
cat > "$DEB_BUILD_DIR/usr/share/doc/quorum/changelog.gz" <<< "" 2>/dev/null || true
cat > "$DEB_BUILD_DIR/usr/share/doc/quorum/copyright" << EOF
Copyright (c) 2025 Quorum
Licensed under the MIT License.
See: https://github.com/quorum/Quorum/blob/main/LICENSE
EOF

# --- Build .deb ---
echo ""
echo "Building ${DEB_NAME}.deb..."
dpkg-deb --build "$DEB_BUILD_DIR" "$DIST_DIR/${DEB_NAME}.deb"

echo ""
echo "[OK] .deb package created: $DIST_DIR/${DEB_NAME}.deb"
du -h "$DIST_DIR/${DEB_NAME}.deb"

# ============================================================================
# OPTIONAL: Build AppImage
# ============================================================================
if [ "$BUILD_APPIMAGE" = true ]; then
    echo ""
    echo "--- AppImage Build ---"

    APPIMAGE_NAME="Quorum-${VERSION}-x86_64"
    APPDIR="$DIST_DIR/${APPIMAGE_NAME}.AppDir"

    if command -v appimagetool &> /dev/null; then
        rm -rf "$APPDIR"
        mkdir -p "$APPDIR/usr/bin"
        mkdir -p "$APPDIR/usr/share/icons/hicolor/256x256/apps"
        mkdir -p "$APPDIR/usr/share/applications"

        # Copy binary
        cp "$QUORUM_BIN" "$APPDIR/usr/bin/quorum"
        chmod 755 "$APPDIR/usr/bin/quorum"

        # Symlink for AppDir root
        mkdir -p "$APPDIR"
        ln -sf usr/bin/quorum "$APPDIR/AppRun"

        # Copy desktop entry
        if [ -f "$DEB_SRC_DIR/quorum.desktop" ]; then
            cp "$DEB_SRC_DIR/quorum.desktop" "$APPDIR/quorum.desktop"
        fi

        # Copy icon
        for icon_path in \
            "$DEB_SRC_DIR/quorum.png" \
            "$REPO_ROOT/assets/quorum.png" \
            "$REPO_ROOT/assets/quorum_256.png"; do
            if [ -f "$icon_path" ]; then
                cp "$icon_path" "$APPDIR/quorum.png"
                break
            fi
        done

        # Build AppImage
        cd "$DIST_DIR"
        appimagetool "$APPDIR" "$APPIMAGE_NAME.AppImage" 2>&1 || {
            echo "[WARN] appimagetool failed — AppImage not created"
        }

        if [ -f "$DIST_DIR/${APPIMAGE_NAME}.AppImage" ]; then
            chmod +x "$DIST_DIR/${APPIMAGE_NAME}.AppImage"
            echo "[OK] AppImage created: $DIST_DIR/${APPIMAGE_NAME}.AppImage"
            du -h "$DIST_DIR/${APPIMAGE_NAME}.AppImage"
        fi

        # Cleanup AppDir
        rm -rf "$APPDIR"
    else
        echo "[SKIP] appimagetool not found. Install from: https://github.com/AppImage/AppImageKit"
        echo "  To build AppImage, run:"
        echo "    wget https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
        echo "    chmod +x appimagetool-x86_64.AppImage"
        echo "    sudo mv appimagetool-x86_64.AppImage /usr/local/bin/appimagetool"
    fi
fi

# --- Cleanup ---
rm -rf "$DEB_BUILD_DIR"

echo ""
echo "============================================"
echo "  .deb build complete!"
echo "  Package: $DIST_DIR/${DEB_NAME}.deb"
echo "============================================"
