# Kiosk Development Plan

## Project Overview
Kiosk is a high-performance, privacy-focused PDF reader available across three platforms:
1. **Web App** - Lightweight vanilla JS/HTML/CSS (GitHub Pages deployable)
2. **Chrome Extension** - PDF interception with annotation persistence
3. **Desktop App** - Tauri-based native apps for Mac/Windows (in development)

---

## Current Status

### ✅ Completed Features

#### Web App & Extension (Core)
- PDF rendering via PDF.js
- Search functionality with Web Worker (non-blocking, 50 match limit)
- Zoom controls (in/out, fit width, fit page) with CSS transform + debounced re-render
- Rotate and download PDFs
- Annotation tools:
  - Highlighter (multiple colors, adjustable opacity)
  - Pen/Draw tool (customizable colors & stroke width)
  - Rectangle & Circle shapes (fill/stroke options)
  - Text annotations
  - Eraser tool
  - Undo/Redo with full history
- Thumbnail sidebar with active-page highlighting
- Focus-window rendering (±2 pages for smooth scrolling)
- HiDPI-aware rendering (devicePixelRatio handling)
- Home page with drag-and-drop + file upload
- Recent PDFs history via localStorage

#### Chrome Extension Specific
- PDF auto-interception via background service worker
- PDF interception via content scripts
- Popup UI for file picker and URL input
- Annotation persistence via Chrome local storage
- Save/Download functionality
- Dark/Light mode toggle
- `file://` support (with permission)

#### Desktop App (Tauri)
- Project scaffolding with Tauri + vanilla TypeScript
- Build configuration for Mac and Windows

---

## 🔄 In Progress / Next Phase

### Desktop App Development (Tauri)
- [ ] Migrate web app viewer to Tauri window
- [ ] Set up native file dialogs
- [ ] Implement native menu bar
- [ ] Tauri IPC for file handling and native features
- [ ] Create standalone installer for Mac (DMG)
- [ ] Create standalone installer for Windows (MSI)
- [ ] Code signing for Mac
- [ ] Code signing for Windows
- [ ] Auto-update mechanism via Tauri Updater

### Cross-Platform Improvements
- [ ] IndexedDB for storing PDFs locally (enable true "recent" reopening)
- [ ] Sync annotations across web app and extension
- [ ] Google Sign-In for authenticated workflows (optional, privacy-respecting)
- [ ] Password-protected PDF support
- [ ] Service worker offline support (web app)
- [ ] Cloud sync for cross-device access (optional)

---

## 📋 Backlog / Future Enhancements

### Feature Enhancements
- Collaborative annotations (shared sessions)
- OCR for image-only PDFs
- Batch PDF processing
- PDF form filling support
- Print to PDF annotations
- Page reordering/deletion
- PDF merging/splitting
- Custom keyboard shortcuts configuration
- Theme customization

### Performance & Optimization
- Virtual scrolling for large PDFs (1000+ pages)
- Lazy-load PDF pages
- Compression for stored annotations
- Cache optimization
- Memory profiling & cleanup

### UI/UX Improvements
- Customizable toolbars
- Preset color palettes
- Annotation layers/visibility toggle
- Page thumbnails with annotation previews
- Touch gesture support for tablets
- Accessibility improvements (ARIA, keyboard nav)

### Platform-Specific Features

#### Web App
- PWA support with offline mode
- Service worker caching strategy

#### Chrome Extension
- Context menu integration ("Open in Kiosk")
- Draggable floating toolbar option
- Keyboard shortcut customization

#### Desktop App (Tauri)
- Native file explorer integration
- Right-click "Open with Kiosk" integration
- System tray integration
- Global hotkey for opening files
- Native notifications

---

## 📁 Project Structure

```
/kiosk
├── index.html                          # Home page
├── viewer.html                         # Reader page
├── README.md
├── css/
│   ├── common.css                      # Shared styles
│   ├── home.css                        # Home page styles
│   └── viewer.css                      # Viewer page styles
├── js/
│   ├── home.js                         # Home page logic
│   ├── viewer.js                       # Viewer page logic
│   └── pdfSearchWorker.js              # Web Worker for search
├── Desktop (Tauri)/
│   ├── Kiosk/                          # Main Tauri app
│   │   ├── src/                        # TypeScript source
│   │   ├── src-tauri/                  # Rust backend
│   │   ├── vite.config.ts
│   │   ├── tsconfig.json
│   │   └── package.json
│   ├── Mac/                            # macOS build output
│   └── Windows/                        # Windows build output
└── extension/                          # Chrome Extension
    ├── manifest.json
    ├── background/
    │   └── service-worker.js
    ├── content/
    │   └── pdf-interceptor.js
    ├── popup/
    │   ├── popup.html
    │   ├── popup.css
    │   └── popup.js
    ├── viewer/
    │   ├── viewer.html
    │   ├── viewer.css
    │   └── viewer.js
    └── lib/
        ├── pdf.min.js
        ├── pdf-lib.min.js
        └── pdf.worker.min.js
```

---

## 🎯 Development Priorities

### Phase 1: Desktop App (Current)
1. Set up Tauri environment and build tooling
2. Port web app viewer to Tauri window
3. Implement native file dialogs and menus
4. Test core annotation functionality on Mac/Windows
5. Create installers

### Phase 2: Data Persistence
1. Implement IndexedDB for all platforms
2. Sync annotations between platforms
3. Enable offline-first architecture

### Phase 3: Polish & Distribution
1. Code signing for releases
2. Auto-update mechanism
3. Performance profiling and optimization
4. Comprehensive testing (E2E, unit, cross-platform)

### Phase 4: Advanced Features
1. Collaborative features
2. Cloud sync (optional)
3. Advanced annotation layers
4. Platform-specific integrations

---

## 🏗️ Architecture Considerations

### Shared Code Strategy
- **Vanilla JS core** should be reusable across all platforms
- **Platform adapters** for file I/O, storage, and UI
- Web app and extension share `viewer.js`, `pdfSearchWorker.js`
- Desktop app reuses core logic, adapts for Tauri IPC

### Storage Strategy
- **Web App**: localStorage (metadata), IndexedDB (PDFs + annotations)
- **Extension**: Chrome local storage (metadata + annotations), IndexedDB (PDFs)
- **Desktop App**: IndexedDB + local filesystem via Tauri

### Performance Targets
- Initial PDF load: < 1s
- Search indexing: < 500ms (via Web Worker)
- Zoom re-render: < 100ms (debounced)
- Annotation save: < 50ms (async)

---

## 🔒 Privacy & Security
- No external analytics or tracking
- No cloud dependencies (unless user opts in)
- All data stored locally
- No third-party ads or trackers
- Code signing for desktop releases

---

## 📝 Notes & Constraints
- Vanilla JS only—no framework dependencies for web app
- Tauri for desktop to avoid Electron bloat
- Chrome Extension Manifest V3 compliant
- Must maintain GitHub Pages deployability for web app
- Support modern browsers (ES6+, Web Workers, Canvas)

---

## Recent Updates (Jan 2026)
- Thumbnail navigation with active-page highlighting
- Focus-window rendering (±2 pages) with HiDPI support
- Zoom via CSS transform + debounced high-quality re-render
- Annotation persistence and save/load in extension
- Desktop app scaffolding with Tauri
