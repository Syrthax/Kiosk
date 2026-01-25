# Kiosk Android

A minimal, dark-mode focused PDF reader for Android.

## Features

- **Native PDF rendering** using Android's PdfRenderer
- **Smooth scrolling** with continuous page view
- **Pinch-to-zoom** and double-tap zoom
- **Night mode** with color inversion for comfortable reading
- **Dark mode** that follows system settings
- **Default PDF opener** support - works with file managers

## Requirements

- Android 5.0 (API 21) or higher
- Android Studio Hedgehog (2023.1.1) or later
- JDK 17

## Building

### From Android Studio

1. Open the `Android` folder in Android Studio
2. Wait for Gradle sync to complete
3. Click Run or press `Shift+F10`

### From Command Line

```bash
cd Android

# Debug build
./gradlew assembleDebug

# Install on connected device
./gradlew installDebug
```

## Project Structure

```
app/
├── src/main/
│   ├── java/com/kiosk/reader/
│   │   ├── KioskApplication.kt     # App initialization
│   │   ├── pdf/
│   │   │   ├── PdfDocument.kt      # PDF rendering wrapper
│   │   │   └── PageCache.kt        # LRU page cache
│   │   └── ui/
│   │       ├── MainActivity.kt     # Home screen
│   │       ├── PdfViewerActivity.kt # PDF viewer
│   │       └── viewer/
│   │           └── ContinuousPdfView.kt # Custom PDF view
│   ├── res/
│   │   ├── layout/                 # XML layouts
│   │   ├── values/                 # Colors, strings, themes
│   │   └── drawable/               # Vector icons
│   └── AndroidManifest.xml
└── build.gradle.kts
```

## Usage

### Opening PDFs

- **From Kiosk app**: Tap "Open PDF" and select a file
- **From file manager**: Tap any PDF and select "Kiosk" 
- **As default app**: Set Kiosk as default PDF handler in Settings

### Viewer Controls

- **Scroll**: Swipe up/down to navigate pages
- **Zoom**: Pinch to zoom, double-tap for quick zoom
- **Night mode**: Tap moon icon to toggle color inversion
- **Hide UI**: Tap the PDF to toggle toolbar visibility

## License

Copyright © 2025 Kiosk. All rights reserved.
