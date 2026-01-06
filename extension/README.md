# Kiosk Chrome Extension

A modern, privacy-focused PDF reader extension for Chrome. Opens all PDFs in Kiosk instead of Chrome's default viewer, with powerful annotation tools and offline support.

## Features

### 🔥 PDF Handling
- **Auto-intercepts** all PDF URLs and opens them in Kiosk
- **Drag & Drop** or browse files directly from the popup
- **Recent PDFs** tracked locally for quick access
- **Open from URL** - paste any PDF URL to open

### ✏️ Annotation Tools
- **Highlighter** - Multiple colors with adjustable opacity
- **Pen Tool** - Draw freely with customizable colors and stroke width
- **Rectangle & Circle** - Shape annotations with fill and stroke options
- **Text Annotations** - Add text notes anywhere on the PDF
- **Eraser** - Remove annotations precisely
- **Undo/Redo** - Full history support with Ctrl+Z / Ctrl+Shift+Z

### 💾 Save & Export
- **Save** - Saves PDF with annotations to IndexedDB (works offline)
- **Download** - Export PDF with embedded annotations as a new file
- **No re-download flow** - Annotations are applied directly

### 🔍 Search
- **Full-text search** across all pages
- **Search results dropdown** with page navigation
- **Highlighted matches** on the page

### 🎨 User Experience
- **Dark/Light Mode** toggle
- **Zoom** controls (keyboard shortcuts + buttons)
- **Page Navigation** - Go to specific pages
- **Fit Width/Page** zoom presets
- **Responsive** design for all screen sizes

### 🔒 Privacy
- **100% Local** - No data sent anywhere
- **No analytics** or tracking
- **No external dependencies** at runtime
- **IndexedDB storage** for PDFs and annotations

## Installation

### From Source (Developer Mode)

1. **Clone or download** this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right corner)
4. Click **Load unpacked**
5. Select the `extension` folder

### From Chrome Web Store
*(Coming soon)*

## Usage

### Opening PDFs

1. **Click any PDF link** - Kiosk automatically opens it
2. **Drag & drop** a PDF file onto the extension popup
3. **Click "Browse..."** in the popup to select a file
4. **Paste a URL** in the popup's URL input field

### Annotating PDFs

1. Select an annotation tool from the sidebar
2. Choose your color and settings
3. Click/drag on the PDF to annotate
4. Use **Ctrl+Z** to undo, **Ctrl+Shift+Z** to redo

### Saving Your Work

- **Save (💾)** - Saves to browser storage (persistent, works offline)
- **Download (⬇️)** - Exports a new PDF file with annotations embedded

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl + +` / `Cmd + +` | Zoom In |
| `Ctrl + -` / `Cmd + -` | Zoom Out |
| `Ctrl + 0` / `Cmd + 0` | Reset Zoom |
| `Ctrl + F` / `Cmd + F` | Focus Search |
| `Ctrl + S` / `Cmd + S` | Save PDF |
| `Ctrl + Z` / `Cmd + Z` | Undo |
| `Ctrl + Shift + Z` / `Cmd + Shift + Z` | Redo |
| `Escape` | Deselect Tool / Close Panels |

## Architecture

```
extension/
├── manifest.json          # Extension configuration (Manifest V3)
├── background/
│   └── service-worker.js  # PDF interception & message routing
├── content/
│   └── pdf-interceptor.js # Detects PDFs in web pages
├── viewer/
│   ├── viewer.html        # Main PDF viewer UI
│   ├── viewer.css         # Viewer styles
│   └── viewer.js          # Viewer logic & annotation system
├── popup/
│   ├── popup.html         # Extension popup UI
│   ├── popup.css          # Popup styles
│   └── popup.js           # Popup logic
├── lib/
│   ├── pdf.min.js         # PDF.js for rendering
│   ├── pdf.worker.min.js  # PDF.js web worker
│   └── pdf-lib.min.js     # PDF-LIB for annotations
└── icons/
    └── icon-*.png         # Extension icons
```

## Technical Details

- **Manifest Version**: 3 (latest Chrome standard)
- **PDF Rendering**: PDF.js v3.11.174
- **Annotation Export**: pdf-lib v1.17.1
- **Storage**: IndexedDB with ~100MB capacity
- **Lazy Loading**: IntersectionObserver for efficient page rendering
- **Search**: Web Worker-based for non-blocking search

## Permissions Explained

| Permission | Purpose |
|------------|---------|
| `storage` | Save user preferences (theme, intercept settings) |
| `downloads` | Export annotated PDFs |
| `tabs` | Open PDFs in new tabs |
| `activeTab` | Access current tab for PDF detection |
| `<all_urls>` | Intercept PDF URLs from any website |

## Troubleshooting

### PDF not opening in Kiosk?
1. Check that the extension is enabled
2. Verify "PDF Interception" is enabled in the popup
3. Some PDFs with unusual headers may not be detected

### Annotations not saving?
1. Click the Save button (disk icon) in the toolbar
2. Check browser storage isn't full
3. Ensure the PDF was fully loaded before annotating

### Extension not loading?
1. Check Chrome DevTools console for errors
2. Verify all files are present in the extension folder
3. Re-load the extension from `chrome://extensions/`

## Development

### Prerequisites
- Node.js (for any build tools)
- Chrome browser

### Testing
1. Load the extension in developer mode
2. Open any PDF URL
3. Test annotation tools
4. Verify save/download functionality

### Building Icons
```bash
cd extension/icons
node generate-icons.js
```

## License

MIT License - See [LICENSE](../LICENSE) for details.

## Credits

- [PDF.js](https://mozilla.github.io/pdf.js/) - Mozilla's PDF rendering library
- [pdf-lib](https://pdf-lib.js.org/) - PDF manipulation library
