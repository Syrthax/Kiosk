#!/bin/bash

# Clean build script for Kiosk Android
# Resolves common build and emulator issues

echo "🧹 Cleaning project..."
./gradlew clean

echo "🔨 Building with lint checks..."
./gradlew assembleDebug --warning-mode all

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Build successful!"
    echo "📦 APK location: app/build/outputs/apk/debug/app-debug.apk"
    echo ""
    echo "🚀 To install and test:"
    echo "   ./install-and-test.sh"
    echo ""
    echo "📱 Or manually:"
    echo "   adb install -r app/build/outputs/apk/debug/app-debug.apk"
    echo "   adb shell am start -n com.kiosk.reader/.ui.MainActivity"
else
    echo ""
    echo "❌ Build failed. Check the output above for errors."
    echo ""
    echo "Common issues:"
    echo "• API compatibility errors (fixed in this version)"
    echo "• Missing dependencies (run ./gradlew --refresh-dependencies)"
    echo "• Gradle version conflicts (clean and retry)"
fi