# Kiosk – High-Performance PDF Reader

A modern, high-performance PDF reader built with vanilla JavaScript, HTML, and CSS. Designed to work seamlessly on GitHub Pages without any build tools or frameworks.

## Features

- **Two-Page Architecture**
  - Home page for PDF selection and history
  - Dedicated reader page for viewing and annotations
  
- **Home Page (`index.html`)**
  - Drag-and-drop PDF upload
  - Click to select PDF files
  - Recent PDFs history with localStorage
  - Clean, modern UI

- **Reader Page (`viewer.html`)**
  - Full PDF.js integration for rendering
  - Search functionality with web worker (non-blocking)
  - Zoom controls (in, out, fit to width, fit to page)
  - Rotate PDF
  - Download PDF
  - Annotation tools (highlight, underline, strikethrough, draw, shapes, text)
  - Color picker and thickness control
  - Status indicators (saved/unsaved)

- **Performance Optimizations**
  - Web Worker for PDF search (keeps UI responsive)
  - Efficient text indexing
  - Debounced search input
  - Canvas-based rendering

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

## How It Works

### Flow from Home to Viewer

1. **User selects a PDF** on the home page (via click or drag-and-drop)
2. **Home page**:
   - Creates an object URL for the file
   - Stores it in `sessionStorage` with a unique ID
   - Saves metadata to `localStorage` for history
   - Redirects to `viewer.html?id=<uniqueId>`
3. **Viewer page**:
   - Reads the query parameter
   - Retrieves the PDF URL from `sessionStorage`
   - Loads and renders the PDF using PDF.js
   - Indexes the text in a web worker for search

### localStorage Usage

- **Key**: `kiosk_recent_pdfs`
- **Value**: Array of recent PDF metadata
  ```json
  [
    {
      "id": "uniqueId",
      "name": "document.pdf",
      "size": 123456,
      "lastOpened": 1702101000000
    }
  ]
  ```
- Updates when a PDF is opened (updates `lastOpened` if same file)
- Keeps only the 10 most recent PDFs

### Web Worker for Search

The `pdfSearchWorker.js` runs in a separate thread to avoid blocking the UI:

1. **Indexing**: Viewer sends all page text to the worker
   ```javascript
   worker.postMessage({
     type: 'index',
     pages: [{ pageNumber: 1, text: '...' }, ...]
   });
   ```

2. **Searching**: When user types in search bar:
   ```javascript
   worker.postMessage({
     type: 'search',
     query: 'search term'
   });
   ```

3. **Results**: Worker finds matches and returns:
   ```javascript
   {
     type: 'searchResults',
     matches: [
       {
         pageNumber: 1,
         snippet: '...highlighted text...',
         query: 'search term'
       }
     ]
   }
   ```

### Search Implementation

- **Debounced input** (300ms delay)
- **Case-insensitive** search
- **Context snippets** with highlighted matches
- **Page jump** on result click
- **Non-blocking** using web worker
- Results limited to 50 matches to maintain performance

## Technology Stack

- **HTML5**: Semantic markup
- **CSS3**: Modern styling with CSS Grid and Flexbox
- **Vanilla JavaScript**: No frameworks
- **PDF.js**: Mozilla's PDF rendering library (loaded via CDN)
- **Web Workers API**: Background processing
- **localStorage & sessionStorage**: Client-side data persistence

## Browser Compatibility

Works on all modern browsers that support:
- ES6 JavaScript
- Web Workers
- Canvas API
- localStorage/sessionStorage
- PDF.js (Chrome, Firefox, Safari, Edge)

## Getting Started

### Local Development

1. Clone or download the repository
2. Open `index.html` in a web browser
3. Or use a local server:
   ```bash
   # Python 3
   python -m http.server 8000
   
   # Node.js (with http-server)
   npx http-server
   ```
4. Navigate to `http://localhost:8000`

### GitHub Pages Deployment

1. Push the repository to GitHub
2. Go to Settings > Pages
3. Select the branch (usually `main`) and root folder
4. Your app will be available at `https://username.github.io/kiosk`

## Future Enhancements

- **Annotation Persistence**: Save annotations to localStorage or backend
- **IndexedDB**: Store actual PDF files for true "recent PDFs" functionality
- **Thumbnails Sidebar**: Page navigation with thumbnails
- **Google Sign-In**: Real authentication integration
- **PDF Security**: Lock/unlock password-protected PDFs
- **Offline Support**: Service worker for offline access
- **Cloud Sync**: Backend API for cross-device sync
- **Collaborative Annotations**: Share and collaborate on PDFs

## Notes

- **File Access**: The "Recent PDFs" feature currently only stores metadata. To actually reopen a recent PDF, users need to re-select the file. This could be enhanced with IndexedDB for file storage.
- **Annotations**: The annotation tools UI is complete, but the actual annotation implementation (drawing on canvas overlays) is stubbed with TODO comments for future implementation.
- **PDF.js CDN**: Using CDN version for simplicity. For production, consider self-hosting PDF.js for better reliability.

## License

This project is open source and available for educational and personal use.

---

Built with ❤️ for a native app-like PDF reading experience in the browser.
