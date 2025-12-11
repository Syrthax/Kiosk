# Service Worker Architecture Fix

## Problem
The extension was failing to load with the error:
```
Service worker registration failed. Status code: 15
Uncaught ReferenceError: window is not defined
```

## Root Cause
- Service workers run in a separate context without access to `window`, `document`, or DOM APIs
- The `FileHandler` class uses `window.showSaveFilePicker()` and other File System Access APIs
- The service worker had `window.location.hostname` references in helper functions
- Service workers cannot directly call browser-only APIs that require user interaction

## Solution
Refactored the extension to follow proper Manifest V3 architecture:

### 1. Service Worker (`src/background/service-worker.js`)
**REMOVED:**
- `FileHandler` import and instantiation
- Direct file operation calls
- `window.location` references

**CHANGED TO:**
- Delegates file operations to content scripts via `chrome.tabs.sendMessage`
- Only handles coordination, storage (IndexedDB), and notifications
- Uses Chrome APIs exclusively (chrome.runtime, chrome.tabs, chrome.commands, etc.)

### 2. Content Script (`src/content/content-script.js`)
**ADDED:**
- `handleFileSave()` - Calls `window.showSaveFilePicker()` and writes files
- `handleReadFile()` - Retrieves file content from page
- `handleAutosave()` - Handles autosave operations
- `saveWithDownload()` - Fallback for browsers without File System Access API

**WHY:**
- Content scripts run in the page context with access to window APIs
- Can call File System Access API methods directly
- Can interact with the page DOM and communicate with page scripts

### 3. Message Flow
```
User presses Ctrl+S
  ↓
Service Worker receives keyboard command
  ↓
Service Worker queries active tab
  ↓
Service Worker sends FILE_SAVE message to content script
  ↓
Content Script calls window.showSaveFilePicker()
  ↓
Content Script saves file and responds with success
  ↓
Service Worker updates storage and shows notification
```

## Key Architecture Principles

### Service Worker Context
✅ **CAN USE:**
- Chrome Extension APIs (chrome.*)
- IndexedDB
- Fetch API
- WebSockets
- Console API

❌ **CANNOT USE:**
- window object
- document object
- DOM APIs
- localStorage
- Browser APIs requiring user interaction (showSaveFilePicker, etc.)

### Content Script Context
✅ **CAN USE:**
- Everything service workers can use
- window object (limited - extension's isolated world)
- document object and DOM APIs
- File System Access API
- Can inject scripts into page context for full window access

## Files Modified

1. **src/background/service-worker.js**
   - Removed FileHandler import
   - Updated `handleFileSave()` to delegate to content script
   - Updated `handleReadFile()` to delegate to content script
   - Updated `startAutosave()` to delegate to content script
   - Fixed `getKioskViewerUrl()` to remove window.location reference

2. **src/content/content-script.js**
   - Added FILE_SAVE message handler
   - Added READ_FILE message handler
   - Added AUTOSAVE message handler
   - Implemented file save with File System Access API
   - Implemented download fallback

3. **README.md**
   - Updated architecture documentation
   - Added notes about service worker vs content script responsibilities

## Testing Checklist

- [ ] Extension loads without errors in chrome://extensions
- [ ] Service worker shows as "active" (not "inactive (error)")
- [ ] Content script loads on viewer.html pages
- [ ] Ctrl+S / Cmd+S triggers save dialog
- [ ] File can be saved using File System Access API
- [ ] Fallback to download works in unsupported browsers
- [ ] Autosave functionality works
- [ ] Extension popup opens and shows recent files
- [ ] No console errors related to window/document access

## Future Improvements

1. **File Handle Caching**: Implement proper file handle storage for "Save" (not "Save As")
   - Store handles in content script's context
   - Map fileId to FileSystemFileHandle
   - Enable true "save to existing file" without re-prompting

2. **Error Handling**: Add better error messages and user feedback
   - Handle permission denials gracefully
   - Show notifications for common errors
   - Provide clear instructions when features are unavailable

3. **Cross-browser Support**: Add fallback mechanisms
   - Detect File System Access API support
   - Gracefully degrade to downloads when unavailable
   - Consider alternative approaches for Firefox (different API)

4. **Offline Support**: Cache viewer state and files
   - Use IndexedDB for temporary file storage
   - Enable offline editing of previously opened files
   - Sync changes when online

## References

- [Chrome Extension Service Workers](https://developer.chrome.com/docs/extensions/mv3/service_workers/)
- [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API)
- [Content Scripts](https://developer.chrome.com/docs/extensions/mv3/content_scripts/)
- [Message Passing](https://developer.chrome.com/docs/extensions/mv3/messaging/)
