# Kiosk Chrome Extension

A powerful Chrome extension that enhances the Kiosk PDF viewer with advanced local file operations, keyboard shortcuts, persistent history, and seamless browser integration.

## Features

### 🔥 Core Features
- **Local File Operations**: Save and open PDFs directly to your filesystem using the File System Access API
- **Keyboard Shortcuts**: 
  - `Ctrl/Cmd + S`: Quick save
  - `Ctrl/Cmd + Shift + S`: Save as (choose new location)
- **History Tracking**: Automatically tracks recently opened files with thumbnails
- **Autosave**: Configurable autosave with debouncing (5s, 10s, 30s, 1min intervals)
- **Annotation Persistence**: Saves annotations with files and restores them on reload
- **Theme Support**: Matches your Kiosk theme (Light, Dark, Night, Auto)

### 🎨 User Experience
- **Glassmorphism UI**: Modern, beautiful popup interface matching Kiosk's design
- **Drag & Drop**: Drop PDFs directly into the extension popup
- **Smart Fallbacks**: Gracefully degrades to downloads API on unsupported browsers
- **Onboarding**: First-run experience explaining features and permissions
- **Privacy First**: All data stays local - nothing uploaded to servers

## Installation

### For Development
1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top-right)
4. Click "Load unpacked"
5. Select the `kiosk-extension` directory

### For Production
1. Download the latest release from [Releases](#) (when available)
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode"
4. Drag and drop the `.zip` file or click "Load unpacked" and select the extracted folder

## Usage

### Opening PDFs
1. Click the extension icon in your toolbar
2. Drag & drop a PDF or click "browse" to select one
3. The PDF opens in Kiosk with full annotation capabilities

### Saving Files
**Method 1: Keyboard Shortcut**
- Press `Ctrl/Cmd + S` while viewing a PDF in Kiosk
- First save prompts for location, subsequent saves update the same file

**Method 2: Extension Popup**
- Open the popup
- Your current file appears in history
- Click to reopen with annotations intact

### Autosave Setup
1. Open extension popup
2. Toggle "Autosave" at the bottom
3. Go to Settings (gear icon)
4. Choose autosave interval (default: 10 seconds)

### Default Save Folder
1. Open extension popup → Settings
2. Click "Choose Folder"
3. Grant permission when prompted
4. All saves default to this folder (can still override with Save As)

## Permissions Explained

| Permission | Why We Need It |
|------------|----------------|
| `storage` | Save history, settings, and annotations locally |
| `activeTab` | Detect when you're viewing PDFs in Kiosk |
| `scripting` | Inject save functionality into Kiosk pages |
| `downloads` | Fallback save method for unsupported browsers |
| `notifications` | Show save confirmations and errors |

**We do NOT collect, transmit, or store any data on external servers.**

## Browser Compatibility

| Feature | Chrome 102+ | Edge 102+ | Opera 88+ | Safari | Firefox |
|---------|-------------|-----------|-----------|--------|---------|
| File System Access API | ✅ | ✅ | ✅ | ❌ | ❌ |
| Download Fallback | ✅ | ✅ | ✅ | ✅ | ✅ |
| Keyboard Shortcuts | ✅ | ✅ | ✅ | ✅ | ✅ |
| History & Annotations | ✅ | ✅ | ✅ | ✅ | ✅ |

**Note**: Safari and Firefox will use download fallback instead of true file system access.

## Architecture

```
kiosk-extension/
├── manifest.json              # Extension configuration (MV3)
├── icons/                     # Extension icons
├── src/
│   ├── popup/                 # Popup UI (HTML/CSS/JS)
│   ├── background/            # Service worker (coordinates operations, no window access)
│   ├── content/               # Content scripts (handles File System Access API)
│   └── lib/                   # Shared libraries
│       ├── file-handler.js    # File System Access API wrapper (used by content script)
│       ├── storage.js         # IndexedDB manager (used by service worker)
│       ├── messaging.js       # Chrome messaging utilities
│       └── utils.js           # Helper functions
└── docs/                      # Documentation
```

### Architecture Notes
- **Service Worker**: Runs in a separate context without access to window/document/DOM APIs
  - Handles: Storage (IndexedDB), messaging coordination, keyboard shortcuts, notifications
  - Delegates file operations to content scripts via chrome.tabs.sendMessage
- **Content Script**: Runs in page context with full window API access
  - Handles: File System Access API (showSaveFilePicker, etc.), direct page integration
  - Receives file operation requests from service worker

## Integration with Kiosk Website

The extension communicates with the Kiosk viewer using:
1. **Content Scripts**: Injected into viewer pages to access page context
2. **PostMessage API**: Secure cross-context messaging between page and extension
3. **Chrome Runtime API**: Communication between popup, background, and content scripts

### Message Flow
```
User Action (Ctrl+S)
  ↓
Content Script receives keyboard event
  ↓
Content Script → Page Context (via postMessage)
  ↓
Page returns PDF data + annotations
  ↓
Content Script → Background Service Worker
  ↓
Background → File System Access API
  ↓
File saved + History updated
  ↓
Notification shown to user
```

## Development

### Prerequisites
- Chrome 102+ or Chromium-based browser
- Basic knowledge of Chrome Extension APIs
- Node.js (optional, for linting/testing)

### Project Setup
```bash
cd kiosk-extension
# No build step required - pure vanilla JS
```

### Testing
1. Load extension in developer mode
2. Navigate to Kiosk viewer (localhost or GitHub Pages)
3. Test keyboard shortcuts, drag-drop, save operations
4. Check console for errors (F12 → Console)

### Debugging
- **Popup**: Right-click extension icon → Inspect popup
- **Background**: chrome://extensions → Details → Inspect views (service worker)
- **Content Script**: Open Kiosk page → F12 → Console

## Security

### Data Privacy
- All file operations happen locally on your device
- No analytics, telemetry, or external network requests
- IndexedDB stores history metadata only (not full PDFs)
- File handles are ephemeral and not persisted

### Permissions
- File System Access API requires explicit user permission per folder
- Extension only accesses Kiosk domains (no access to other websites)
- Content scripts run only on whitelisted domains

### Code Safety
- No eval() or unsafe innerHTML
- CSP-compliant code
- No external dependencies (pure vanilla JS)

## Troubleshooting

### Extension not appearing
- Ensure Developer Mode is enabled in `chrome://extensions`
- Check that the extension loaded without errors
- Refresh the extensions page

### Save not working
- Verify you granted file system permission when prompted
- Check if File System Access API is supported (Chrome 102+)
- Try Save As instead of Save
- Check console for error messages

### History not updating
- Open DevTools → Application → IndexedDB → KioskExtension
- Verify `history` object store exists
- Clear extension data and reload

### Keyboard shortcuts not working
- Verify shortcuts aren't conflicting in `chrome://extensions/shortcuts`
- Ensure you're focused on the Kiosk viewer page
- Check content script injection in DevTools

## Roadmap

- [ ] Cloud sync for history across devices (optional, opt-in)
- [ ] Batch operations (export multiple PDFs)
- [ ] PDF merge and split tools
- [ ] OCR text extraction
- [ ] Print preview enhancements
- [ ] Collaboration features (shared annotations)

## Contributing

We welcome contributions! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

- **Issues**: [GitHub Issues](https://github.com/sarthakghosh/kiosk/issues)
- **Discussions**: [GitHub Discussions](https://github.com/sarthakghosh/kiosk/discussions)
- **Email**: [Your Email]

## Credits

Built with ❤️ for the Kiosk PDF Viewer project by [Sarthak Ghosh](https://github.com/sarthakghosh)

---

**Version**: 1.0.0  
**Last Updated**: 2024  
**Manifest Version**: 3
