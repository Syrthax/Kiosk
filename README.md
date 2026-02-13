# Kiosk – Modern PDF Reader

<p align="center">
  <img src="Desktop%20(Tauri)/Kiosk/src-tauri/icons/icon.png" width="128" height="128" alt="Kiosk Logo">
</p>

<p align="center">
  <strong>A high-performance, privacy-focused PDF reader</strong><br>
  Available as a native macOS app, Windows app, Android app, Chrome extension, and web app
</p>

<p align="center">
  <a href="#-native-macos-app">Desktop App</a> •
  <a href="#-windows-app">Windows App</a> •
  <a href="#-android-app">Android App</a> •
  <a href="#-chrome-extension">Extension</a> •
  <a href="#-web-app">Web App</a> •
  <a href="#-installation">Installation</a>
</p>

---

## 📥 Downloads

| Platform | Latest Release | Link |
|----------|---------------|------|
| 🪟 **Windows** | v0.1.0w | [Download](https://github.com/Syrthax/Kiosk/releases/tag/v0.1.0w) |
| 🍎 **macOS** | v0.1.0m | [Download](https://github.com/Syrthax/Kiosk/releases/tag/v0.1.0m) |
| 🤖 **Android** | v0.1.0a | [Download](https://github.com/Syrthax/Kiosk/releases/tag/v0.1.0a) |
| 🧩 **Chrome Extension** | v1.5e | [Download](https://github.com/Syrthax/Kiosk/releases/tag/v1.5e) |
| 🌐 **Web App** | — | [Launch](https://syrthax.github.io/Kiosk) |

---

## ✨ Features

### Core Features (All Platforms)
- 📄 **High-quality PDF rendering** with native-like clarity
- 🔍 **Full-text search** with highlighted results
- 🖼️ **Thumbnail sidebar** with page navigation
- 🔎 **Smooth zoom** (in/out/fit width/fit page)
- 🌙 **Display modes**: Light, Dark, and Night (inverted)
- ⌨️ **Keyboard shortcuts** for power users
- 🔒 **Privacy-focused**: PDFs never leave your device

### Desktop App (macOS)
- ⚡ **Native performance** via Rust + PDFium engine
- 🎯 **System integration**: Open PDFs directly, file associations
- 🖱️ **Trackpad gestures**: Pinch-to-zoom, smooth scrolling
- 📦 **Standalone**: No browser required

### Desktop App (Windows)
- ⚡ **Native performance** via Rust + PDFium engine
- 🎯 **System integration**: Open PDFs directly, file associations
- 📦 **Standalone**: No browser required
- 🏗️ **Built via CI**: Automated GitHub Actions build pipeline

### Android App
- 📱 **Native Android** experience
- 📄 **PDF viewing** with smooth navigation
- 🔒 **Offline**: No internet required after installation

### Chrome Extension
- 🔄 **Auto-intercept**: Opens all PDFs in Kiosk instead of Chrome's viewer
- ✏️ **Annotations**: Highlight, underline, strikethrough, draw, shapes, text
- 💾 **Persistent storage**: Annotations saved to Chrome storage
- 📎 **Works everywhere**: Web URLs, local files, data URLs

### Web App
- 🌐 **No installation**: Works directly in browser
- 📱 **Responsive**: Works on desktop and tablet
- 🚀 **GitHub Pages ready**: Deploy your own instance

---

## 🖥️ Native macOS App

### System Requirements
| Requirement | Minimum |
|------------|---------|
| **macOS** | 10.15 (Catalina) or later |
| **Architecture** | Apple Silicon (M1/M2/M3) or Intel |
| **Storage** | ~50 MB |

### Installation

#### Option 1: DMG Installer (Recommended)
1. Download `Kiosk_0.1.0_aarch64.dmg` from [Releases](https://github.com/Syrthax/Kiosk/releases)
2. Open the DMG file
3. Drag `Kiosk.app` to the `Applications` folder
4. Eject the DMG

#### Option 2: Direct .app
1. Download `Kiosk.app` from Releases
2. Move to `/Applications`
3. Run: `xattr -cr /Applications/Kiosk.app` (removes quarantine)

### First Launch
Since the app is ad-hoc signed (not notarized with Apple), you may see a Gatekeeper warning:
1. **Right-click** on Kiosk.app
2. Select **Open**
3. Click **Open** in the dialog

Or run in Terminal:
```bash
xattr -cr /Applications/Kiosk.app
open -a Kiosk
```

### Keyboard Shortcuts
| Action | Shortcut |
|--------|----------|
| Open File | `⌘ O` |
| Zoom In | `⌘ +` |
| Zoom Out | `⌘ -` |
| Fit Width | `⌘ W` |
| Fit Page | `⌘ 0` |
| Toggle Sidebar | `⌘ S` |
| Search | `⌘ F` |
| Next Page | `→` or `Page Down` |
| Previous Page | `←` or `Page Up` |

---

## � Windows App

### System Requirements
| Requirement | Minimum |
|------------|---------|
| **Windows** | 10 (1803) or later |
| **Architecture** | x86_64 |
| **Storage** | ~50 MB |

### Installation
1. Download `kiosk-windows-installers.zip` from [Releases](https://github.com/Syrthax/Kiosk/releases/tag/v0.1.0w)
2. Extract the ZIP file
3. Run either the **MSI** or **NSIS** installer

> **Note:** The Windows build is compiled via [GitHub Actions CI](https://github.com/Syrthax/Kiosk/actions) using the Tauri build pipeline with PDFium binaries sourced from [bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries).

---

## 🤖 Android App

### System Requirements
| Requirement | Minimum |
|------------|---------|
| **Android** | 8.0 (Oreo) or later |
| **Storage** | ~30 MB |

### Installation
1. Download the APK from [Releases](https://github.com/Syrthax/Kiosk/releases/tag/v0.1.0a)
2. Enable **Install from unknown sources** in your device settings
3. Open the APK to install

---

## �🧩 Chrome Extension

### Installation
1. Download `kiosk-extension.zip` from [Releases](https://github.com/Syrthax/Kiosk/releases)
2. Unzip the file
3. Open Chrome → `chrome://extensions`
4. Enable **Developer mode** (top right)
5. Click **Load unpacked** → Select the `extension` folder

### For Local File Access
To open PDFs from your filesystem:
1. Go to `chrome://extensions`
2. Find Kiosk PDF Reader
3. Click **Details**
4. Enable **Allow access to file URLs**

---

## 🌐 Web App

### Online Demo
Visit: [https://syrthax.github.io/Kiosk](https://syrthax.github.io/Kiosk)

### Self-Hosting
```bash
# Clone the repository
git clone https://github.com/Syrthax/Kiosk.git
cd Kiosk

# Serve locally
python -m http.server 8000
# or
npx http-server

# Open http://localhost:8000
```

### GitHub Pages Deployment
1. Fork this repository
2. Go to Settings → Pages
3. Select `main` branch, root folder
4. Your app will be at `https://yourusername.github.io/Kiosk`

---

## 🏗️ Project Structure

```
kiosk/
├── index.html                    # Web app home page
├── viewer.html                   # Web app PDF viewer
├── versioning-schema.md          # Release versioning conventions
├── css/                          # Web app styles
├── js/                           # Web app scripts
├── extension/                    # Chrome extension
│   ├── manifest.json
│   ├── background/
│   ├── content/
│   ├── popup/
│   └── viewer/
├── Android/                      # Android app source
│   ├── app/
│   └── build.gradle.kts
└── Desktop (Tauri)/
    ├── Kiosk/                    # Tauri app source
    │   ├── src/                  # TypeScript frontend
    │   ├── src-tauri/            # Rust backend
    │   │   └── src/
    │   │       ├── main.rs
    │   │       ├── commands.rs
    │   │       └── pdf/          # PDFium renderer
    │   └── package.json
    ├── Mac/                      # macOS distribution
    │   ├── Kiosk.app
    │   └── Kiosk_0.1.0_aarch64.dmg
    └── Windows/                  # Windows distribution
```

---

## 🛠️ Building from Source

### Prerequisites
- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) 1.70+
- [PDFium library](https://pdfium.googlesource.com/pdfium/) (for macOS app)

### macOS App
```bash
cd "Desktop (Tauri)/Kiosk"
npm install
npm run tauri build
```

Build output:
- `.app`: `src-tauri/target/release/bundle/macos/Kiosk.app`
- `.dmg`: `src-tauri/target/release/bundle/dmg/Kiosk_*.dmg`

### Chrome Extension
The extension requires no build step. Load the `extension/` folder directly in Chrome.

---

## 🔧 Technology Stack

### Desktop App
| Layer | Technology |
|-------|------------|
| Framework | [Tauri](https://tauri.app/) 2.0 |
| Frontend | TypeScript, Vite |
| Backend | Rust |
| PDF Engine | [PDFium](https://pdfium.googlesource.com/pdfium/) via pdfium-render |
| Rendering | Native PNG with CSS filters for display modes |

### Web App & Extension
| Layer | Technology |
|-------|------------|
| PDF Rendering | [PDF.js](https://mozilla.github.io/pdf.js/) |
| Search | Web Workers (non-blocking) |
| Storage | localStorage, Chrome Storage API |
| Annotations | Canvas-based drawing |

---

## 📋 Compatibility

### macOS App
| macOS Version | Support |
|---------------|---------|
| 15 Sequoia | ✅ Full |
| 14 Sonoma | ✅ Full |
| 13 Ventura | ✅ Full |
| 12 Monterey | ✅ Full |
| 11 Big Sur | ✅ Full |
| 10.15 Catalina | ✅ Full |
| 10.14 and earlier | ❌ Not supported |

| Architecture | Support |
|--------------|---------|
| Apple Silicon (M1/M2/M3/M4) | ✅ Native |
| Intel (x86_64) | ✅ Rosetta 2 |

### Chrome Extension
| Browser | Support |
|---------|---------|
| Chrome 88+ | ✅ Full |
| Edge 88+ | ✅ Full |
| Brave | ✅ Full |
| Firefox | ❌ Not compatible (Manifest V3) |
| Safari | ❌ Not compatible |

### Web App
| Browser | Support |
|---------|---------|
| Chrome | ✅ Full |
| Firefox | ✅ Full |
| Safari | ✅ Full |
| Edge | ✅ Full |

---

## 🔒 Privacy

Kiosk is designed with privacy as a core principle:

- **No telemetry**: Zero data collection or analytics
- **No cloud**: PDFs are processed entirely on your device
- **No accounts**: No sign-up or login required
- **Open source**: Full code transparency

---

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgments

- [PDF.js](https://mozilla.github.io/pdf.js/) - Mozilla's PDF rendering library
- [PDFium](https://pdfium.googlesource.com/pdfium/) - Google's PDF rendering engine
- [Tauri](https://tauri.app/) - Framework for building native apps
- [pdfium-render](https://crates.io/crates/pdfium-render) - Rust bindings for PDFium

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/Syrthax">Sarthak Ghosh</a>
</p>
