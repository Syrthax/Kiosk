#!/bin/bash
# Post-build script to fix libpdfium.dylib install name in the app bundle
# This ensures the dylib can be loaded correctly at runtime

APP_BUNDLE="$1"

if [ -z "$APP_BUNDLE" ]; then
    # Default to the release bundle location
    APP_BUNDLE="src-tauri/target/release/bundle/macos/Kiosk.app"
fi

DYLIB_PATH="$APP_BUNDLE/Contents/Frameworks/libpdfium.dylib"

if [ -f "$DYLIB_PATH" ]; then
    echo "Fixing install name for libpdfium.dylib..."
    install_name_tool -id "@executable_path/../Frameworks/libpdfium.dylib" "$DYLIB_PATH"
    
    echo "Re-signing dylib..."
    codesign --force --sign - "$DYLIB_PATH"
    
    echo "Re-signing app bundle..."
    codesign --force --sign - "$APP_BUNDLE"
    
    echo "Done! libpdfium.dylib install name fixed."
else
    echo "Warning: libpdfium.dylib not found at $DYLIB_PATH"
    exit 1
fi
