#!/bin/bash

# Kiosk Android - Install and Test Script
# This script builds and installs the Kiosk PDF reader app on Android devices/emulators

set -e  # Exit on error

echo "🔧 Building Kiosk Android..."
./gradlew assembleDebug

echo "📱 Waiting for Android device/emulator..."
adb wait-for-device

echo "📦 Installing Kiosk app..."
adb install -r app/build/outputs/apk/debug/app-debug.apk

echo "🚀 Starting Kiosk app..."
adb shell am start -n com.kiosk.reader/.ui.MainActivity

echo ""
echo "✅ Installation complete!"
echo ""
echo "🧪 Testing Instructions:"
echo "1. The app should open on your device"
echo "2. Tap 'Open PDF' and select a PDF file"
echo "3. Test pinch-to-zoom with two fingers:"
echo "   - Pinch in/out smoothly without white pages"
echo "   - Zoom should be continuous and responsive"
echo "4. Test over-zoom (zoom in very far):"
echo "   - Pages should remain visible (no white screens)"
echo "   - Content should scale smoothly"
echo "5. Try double-tap to zoom fit/2.5x"
echo "6. Scroll through pages to test rendering"
echo ""
echo "📝 Fixed Issues:"
echo "   ✓ Two-finger pinch-to-zoom now works properly"
echo "   ✓ Over-zoom no longer causes white pages"
echo "   ✓ Smooth Matrix-based scaling during zoom gestures"
echo "   ✓ Deferred high-quality re-rendering after zoom"
echo ""
echo "Note: No JavaScript issues exist - this is a native Android app using PdfRenderer"