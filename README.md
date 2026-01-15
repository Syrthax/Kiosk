# Kiosk – High-Performance PDF Reader

A modern, high-performance PDF reader built with vanilla JavaScript, HTML, and CSS. Works both as a lightweight web app (GitHub Pages friendly) and as a Chrome extension—no build tools or frameworks required.

## Features (Web App)
- Home page (`index.html`): drag-and-drop or click-to-upload, recent history via localStorage, clean UI
- Reader page (`viewer.html`) powered by PDF.js with:
  - Search via Web Worker (non-blocking)
  - Zoom (in/out/fit width/fit page) using CSS transform + debounced high-quality re-render
  - Rotate, download
  - Annotation tools (highlight, underline, strikethrough, draw, shapes, text) with color & thickness controls
  - Thumbnail sidebar with page navigation and active-page highlighting
  - Focus-window rendering (current ±2 pages) for smooth scrolling
  - HiDPI-aware rendering (devicePixelRatio) for crisp output

## Chrome Extension
- PDF interception and open-in-Kiosk via background service worker
- Drag & drop and popup file picker supported (including `file://` when permitted)
- Thumbnail sidebar, focus-based rendering, and HiDPI handling mirrored from the web app
- Save button persists annotations to Chrome local storage; annotations restore on reopen
- Handles PDFs passed as URLs or data URLs from the popup

## Project Structure
```
/kiosk
├── index.html              # Home page (PDF selection & history)
├── viewer.html             # Reader page (PDF viewer & annotations)
├── README.md               # This file
├── css/
│   ├── common.css          # Shared styles
│   ├── home.css            # Home page styles
│   └── viewer.css          # Viewer page styles
└── js/
    ├── home.js             # Home page logic
    ├── viewer.js           # Viewer page logic
    └── pdfSearchWorker.js  # Web worker for search
```

## How It Works (Web App)
1. User selects a PDF on the home page (click or drag-and-drop)
2. Home page creates an object URL, stores metadata in localStorage (for history), and redirects to `viewer.html?id=<uniqueId>`
3. Viewer reads the ID, fetches the PDF URL from sessionStorage, renders with PDF.js, and indexes text via Web Worker for search

### localStorage Usage
- Key: `kiosk_recent_pdfs`
- Value: Array of recent PDF metadata `{ id, name, size, lastOpened }`, capped to the 10 most recent

### Search Implementation
- Debounced input (300ms), case-insensitive
- Web Worker indexing to avoid UI jank
- Results with highlighted snippets; click to jump to page
- Limited to 50 matches for performance

## Technology Stack
- HTML5, CSS3 (Grid/Flex), Vanilla JavaScript
- PDF.js (CDN or bundled for extension)
- Web Workers API
- localStorage / sessionStorage

## Browser Compatibility
- Modern browsers supporting ES6, Web Workers, Canvas, and PDF.js (Chrome, Firefox, Safari, Edge)

## Getting Started
### Local Development
1. Clone the repo
2. Open `index.html` directly, or run a simple server:
   ```bash
   # Python 3
   python -m http.server 8000
   # Node.js
   npx http-server
   ```
3. Navigate to `http://localhost:8000`

### GitHub Pages
1. Push the repository to GitHub
2. In Settings → Pages, select the branch (usually `main`) and root folder
3. App will be available at `https://username.github.io/kiosk`

## Future Enhancements
- IndexedDB for storing PDFs (true "recent" reopen without reselecting)
- Google Sign-In for authenticated workflows
- PDF security (password-protected files)
- Offline support via service worker (web app)
- Cloud sync for cross-device access
- Collaborative annotations

## Notes
- Web app stores recent metadata only; reopening a PDF requires reselecting the file (until IndexedDB is added)
- Extension supports annotation persistence via Chrome local storage (Save button)
- For `file://` support in extension, enable "Allow access to file URLs" in Chrome extension settings

## Recent Updates (Jan 2026)
- Thumbnail navigation sidebar with active-page highlighting
- Focus-window rendering (current ±2 pages) with HiDPI-aware canvases
- Zoom via CSS transform + debounced high-quality re-render
- Annotation persistence across zoom/reload; save/load backed by Chrome storage in the extension
- Save button with inline notifications (extension)
- File upload handling from popup to viewer via service worker message passing

---
Built with ❤️ for a native app-like PDF reading experience in the browser and Chrome.
