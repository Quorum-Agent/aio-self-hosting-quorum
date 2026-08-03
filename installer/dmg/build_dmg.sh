#!/usr/bin/env bash
# build_dmg.sh — Build a macOS .dmg disk image for Quorum
#
# Usage:
#   ./installer/dmg/build_dmg.sh                        # Build from dist/
#   ./installer/dmg/build_dmg.sh --version 0.2.0         # Override version
#   ./installer/dmg/build_dmg.sh --notarize              # Enable notarization
#   ./installer/dmg/build_dmg.sh --sign "Developer ID"   # Code sign with identity
#
# Environment variables:
#   APPLE_DEVELOPER_ID       — Developer ID for code signing (e.g. "Developer ID Application: ...")
#   APPLE_TEAM_ID            — Team ID for notarization
#   APPLE_NOTARIZATION_USER  — Apple ID (email) for notarization
#   APPLE_NOTARIZATION_PASSWORD — App-specific password for notarization
#   APPLE_KEYCHAIN_PROFILE   — altool keychain profile name (if using stored credentials)
#
# Prerequisites:
#   - Python build complete: dist/Quorum.app exists (or dist/Quorum for manual bundling)
#   - macOS with Developer Tools installed
#   - For signing: Apple Developer certificate in keychain
#   - For notarization: Apple Developer account with app-specific password
#
# Output:
#   dist/Quorum-<version>.dmg
#------------------------------------------------------------------------------

set -euo pipefail

# --- Paths ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DIST_DIR="$REPO_ROOT/dist"
DMG_SRC_DIR="$SCRIPT_DIR"

# --- Version ---
VERSION="${QUORUM_VERSION:-}"
if [ -z "$VERSION" ]; then
    if [ -f "$REPO_ROOT/build/version.py" ]; then
        VERSION=$(python3 -c "import sys; sys.path.insert(0, '$REPO_ROOT/build'); from version import VERSION; print(VERSION)" 2>/dev/null || echo "0.1.0")
    else
        VERSION="0.1.0"
    fi
fi

# --- Parse arguments ---
DO_SIGN=false
DO_NOTARIZE=false
SIGN_IDENTITY="${APPLE_DEVELOPER_ID:-}"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --version)  VERSION="$2"; shift 2 ;;
        --sign)     DO_SIGN=true; SIGN_IDENTITY="${2:-$APPLE_DEVELOPER_ID}"; shift 2 ;;
        --notarize) DO_NOTARIZE=true; shift ;;
        -h|--help)
            echo "Usage: $0 [--version X.Y.Z] [--sign IDENTITY] [--notarize]"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

DMG_NAME="Quorum-${VERSION}"
DMG_PATH="$DIST_DIR/${DMG_NAME}.dmg"
APP_NAME="Quorum.app"

echo "============================================"
echo "  Quorum macOS DMG Builder"
echo "  Version: ${VERSION}"
echo "  Output:  ${DMG_NAME}.dmg"
echo "============================================"

# ============================================================================
# Step 1: Locate or create the .app bundle
# ============================================================================
echo ""
echo "[1/5] Locating Quorum.app..."

STAGING="$DIST_DIR/dmg_staging"
rm -rf "$STAGING"
mkdir -p "$STAGING"

# Find the .app bundle
APP_PATH=""
for candidate in \
    "$DIST_DIR/$APP_NAME" \
    "$DIST_DIR/Quorum.app"; do
    if [ -d "$candidate" ]; then
        APP_PATH="$candidate"
        break
    fi
done

if [ -z "$APP_PATH" ]; then
    # No .app bundle — create one manually from the single binary
    echo "  [INFO] No .app bundle found. Creating from dist/Quorum binary..."

    QUORUM_BIN="$DIST_DIR/Quorum"
    if [ ! -f "$QUORUM_BIN" ]; then
        echo "[ERROR] Quorum binary not found at $QUORUM_BIN"
        echo "  Run 'python build/build_exe.py' first to produce dist/Quorum"
        exit 1
    fi

    APP_PATH="$STAGING/$APP_NAME"
    mkdir -p "$APP_PATH/Contents/MacOS"
    mkdir -p "$APP_PATH/Contents/Resources"

    # Copy binary
    cp "$QUORUM_BIN" "$APP_PATH/Contents/MacOS/Quorum"
    chmod 755 "$APP_PATH/Contents/MacOS/Quorum"

    # Create Info.plist
    cat > "$APP_PATH/Contents/Info.plist" << EOFPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>English</string>
    <key>CFBundleDisplayName</key>
    <string>Quorum</string>
    <key>CFBundleExecutable</key>
    <string>Quorum</string>
    <key>CFBundleIdentifier</key>
    <string>com.quorum.app</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>Quorum</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundleVersion</key>
    <string>${VERSION}</string>
    <key>LSMinimumSystemVersion</key>
    <string>11.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSSupportsAutomaticGraphicsSwitching</key>
    <true/>
    <key>LSApplicationCategoryType</key>
    <string>public.app-category.developer-tools</string>
    <key>NSHumanReadableCopyright</key>
    <string>Copyright (c) 2025 Quorum. All rights reserved.</string>
</dict>
</plist>
EOFPLIST

    # Copy icon if available
    for icon_src in \
        "$DMG_SRC_DIR/quorum.icns" \
        "$REPO_ROOT/assets/quorum.icns"; do
        if [ -f "$icon_src" ]; then
            cp "$icon_src" "$APP_PATH/Contents/Resources/Quorum.icns"
            break
        fi
    done

    echo "  [OK] Created $APP_PATH"
else
    echo "  Using: $APP_PATH"
    cp -R "$APP_PATH" "$STAGING/$APP_NAME"
    APP_PATH="$STAGING/$APP_NAME"
fi

# ============================================================================
# Step 2: Code sign the .app bundle
# ============================================================================
echo ""
echo "[2/5] Code signing..."

if [ "$DO_SIGN" = true ] && [ -n "$SIGN_IDENTITY" ]; then
    echo "  Signing with identity: $SIGN_IDENTITY"

    # Sign binary
    codesign --force --options runtime --sign "$SIGN_IDENTITY" \
        --entitlements "$DMG_SRC_DIR/entitlements.plist" \
        "$APP_PATH/Contents/MacOS/Quorum" 2>&1 || {
        echo "  [WARN] Binary signing failed — continuing unsigned"
    }

    # Sign frameworks / dylibs if present
    if [ -d "$APP_PATH/Contents/Frameworks" ]; then
        find "$APP_PATH/Contents/Frameworks" -type f -name "*.dylib" -print0 | while IFS= read -r -d '' dylib; do
            codesign --force --options runtime --sign "$SIGN_IDENTITY" "$dylib" 2>/dev/null || true
        done
    fi

    # Sign the app bundle itself
    codesign --force --options runtime --sign "$SIGN_IDENTITY" \
        "$APP_PATH" 2>&1 || {
        echo "  [WARN] App bundle signing failed — continuing unsigned"
    }

    # Verify signature
    codesign --verify --verbose=4 "$APP_PATH" 2>&1 || {
        echo "  [WARN] Signature verification produced warnings"
    }
else
    if [ "$DO_SIGN" = true ]; then
        echo "  [SKIP] No signing identity provided. Set APPLE_DEVELOPER_ID or use --sign <ID>"
    else
        echo "  [SKIP] Code signing not requested. Use --sign to enable."
    fi
fi

# ============================================================================
# Step 3: Create .dmg
# ============================================================================
echo ""
echo "[3/5] Creating .dmg..."

# Create temporary DMG with capacity for the app + buffer
APP_SIZE_KB=$(du -sk "$APP_PATH" | cut -f1)
DMG_SIZE_KB=$((APP_SIZE_KB + 20480))  # +20MB buffer

TMP_DMG="$STAGING/tmp.dmg"
rm -f "$TMP_DMG" "$DMG_PATH"

# Create the DMG
hdiutil create \
    -volname "Quorum" \
    -fs HFS+ \
    -size "${DMG_SIZE_KB}k" \
    -layout NONE \
    "$TMP_DMG" \
    > /dev/null 2>&1

# Mount it
MOUNT_DIR="$STAGING/mount"
mkdir -p "$MOUNT_DIR"
DEVICE=$(hdiutil attach -readwrite -noverify -noautoopen "$TMP_DMG" -mountpoint "$MOUNT_DIR" 2>&1 | head -1 | awk '{print $1}')

# Copy app into mounted volume
cp -R "$APP_PATH" "$MOUNT_DIR/"

# Create Applications symlink (standard macOS DMG convention)
ln -sf /Applications "$MOUNT_DIR/Applications"

# Set icon positions (optional — makes the window look polished)
echo '
    tell application "Finder"
        tell disk "Quorum"
            open
            set current view of container window to icon view
            set toolbar visible of container window to false
            set statusbar visible of container window to false
            set the bounds of container window to {400, 100, 900, 460}
            set viewOptions to the icon view options of container window
            set arrangement of viewOptions to not arranged
            set icon size of viewOptions to 72
            set position of item "Quorum.app" of container window to {150, 160}
            set position of item "Applications" of container window to {360, 160}
            close
            open
            update without registering applications
            delay 1
        end tell
    end tell
' | osascript 2>/dev/null || {
    echo "  [INFO] Finder icon positioning skipped (osascript not available or headless)"
}

# Wait for Finder to settle
sleep 2

# Detach
hdiutil detach "$DEVICE" -force 2>/dev/null || true

# Convert to compressed read-only DMG
rm -f "$DMG_PATH"
hdiutil convert "$TMP_DMG" -format UDZO -imagekey zlib-level=9 -o "$DMG_PATH" 2>&1

echo "  [OK] DMG created: $DMG_PATH"

# ============================================================================
# Step 4: Sign the .dmg (if signing enabled)
# ============================================================================
echo ""
echo "[4/5] Signing DMG..."

if [ "$DO_SIGN" = true ] && [ -n "$SIGN_IDENTITY" ]; then
    codesign --force --sign "$SIGN_IDENTITY" "$DMG_PATH" 2>&1 || {
        echo "  [WARN] DMG signing failed"
    }
    echo "  [OK] DMG signed"
else
    echo "  [SKIP] DMG signing skipped"
fi

# ============================================================================
# Step 5: Notarize (optional, configurable)
# ============================================================================
echo ""
echo "[5/5] Notarization..."

if [ "$DO_NOTARIZE" = true ]; then
    NOTARIZATION_USER="${APPLE_NOTARIZATION_USER:-}"
    NOTARIZATION_PASSWORD="${APPLE_NOTARIZATION_PASSWORD:-}"
    TEAM_ID="${APPLE_TEAM_ID:-}"
    KEYCHAIN_PROFILE="${APPLE_KEYCHAIN_PROFILE:-quorum-notary}"

    # Check prerequisites
    if [ -z "$NOTARIZATION_USER" ] && [ -z "$KEYCHAIN_PROFILE" ]; then
        echo "  [SKIP] Notarization credentials not configured."
        echo "  Set APPLE_NOTARIZATION_USER + APPLE_NOTARIZATION_PASSWORD,"
        echo "  or APPLE_KEYCHAIN_PROFILE in the environment."
    else
        echo "  Submitting for notarization..."

        if [ -n "$KEYCHAIN_PROFILE" ]; then
            # Use stored keychain profile (preferred for CI)
            xcrun notarytool submit "$DMG_PATH" \
                --keychain-profile "$KEYCHAIN_PROFILE" \
                --team-id "$TEAM_ID" \
                --wait \
                2>&1 || {
                echo "  [WARN] Notarization submission failed"
            }
        elif [ -n "$NOTARIZATION_USER" ] && [ -n "$NOTARIZATION_PASSWORD" ]; then
            # Fallback to Apple ID auth (legacy method)
            xcrun altool --notarize-app \
                --primary-bundle-id "com.quorum.app" \
                --username "$NOTARIZATION_USER" \
                --password "$NOTARIZATION_PASSWORD" \
                --team-id "$TEAM_ID" \
                --file "$DMG_PATH" \
                2>&1 || {
                echo "  [WARN] Notarization submission failed"
            }
        fi

        echo "  [OK] Notarization submitted. Check status with:"
        echo "    xcrun notarytool history --keychain-profile $KEYCHAIN_PROFILE"

        # Staple the ticket (if notarization was successful)
        echo "  Stapling notarization ticket..."
        xcrun stapler staple "$DMG_PATH" 2>&1 || {
            echo "  [WARN] Stapling failed (notarization may still be in progress)"
        }
    fi
else
    echo "  [SKIP] Notarization not requested. Use --notarize to enable."
    echo "  Notarization is optional but recommended for distribution."
    echo "  Gatekeeper will warn users about unidentified developer."
fi

# ============================================================================
# Cleanup
# ============================================================================
rm -rf "$STAGING"

echo ""
echo "============================================"
echo "  DMG build complete!"
echo "  Output: $DMG_PATH"
echo "  Size:   $(du -h "$DMG_PATH" | cut -f1)"
echo "============================================"

# --- Show verification command ---
echo ""
echo "To verify the DMG:"
echo "  hdiutil verify $DMG_PATH"
if [ "$DO_SIGN" = true ]; then
    echo "  codesign --verify --verbose=4 $DMG_PATH"
    echo "  spctl --assess --verbose=4 --type execute $DMG_PATH"
fi
