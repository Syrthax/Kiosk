# Quick Test Instructions

## Load the Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top-right)
3. Click "Load unpacked"
4. Select the `kiosk-extension` folder
5. The extension should load successfully ✅

## Verify Service Worker

1. On the extension card, you should see:
   - ✅ Service worker: "active"
   - ❌ NOT: "inactive (error)" or "Service worker registration failed"

2. Click "service worker" link to open DevTools
   - Check console for "Kiosk Extension service worker loaded"
   - Should be NO errors about "window is not defined"

## Test Basic Functionality

### 1. Navigate to Kiosk Viewer
```
https://syrthax.github.io/kiosk/viewer.html
```
Or your local version:
```
http://localhost:5500/viewer.html
```

### 2. Check Content Script
- Open DevTools (F12) on the viewer page
- Console should show: "Kiosk Extension content script loaded"
- Should see blue indicator in bottom-right: "Extension Active"

### 3. Test Keyboard Shortcut
- Load a PDF in the viewer
- Press **Ctrl+S** (Windows/Linux) or **Cmd+S** (Mac)
- Save dialog should appear (File System Access API)
- OR download should start (fallback)

### 4. Test Extension Popup
- Click the Kiosk extension icon in toolbar
- Popup should open (if implemented)
- Should show recent files history

## Expected Console Messages

### Service Worker Console (`chrome://extensions` → service worker link)
```
Kiosk Extension service worker loaded
```

### Viewer Page Console (F12 on viewer.html)
```
Kiosk Extension content script loaded
```

## Troubleshooting

### Service Worker Fails to Load
- Check for syntax errors in service-worker.js
- Verify no window/document references
- Check Chrome DevTools for specific error messages

### Content Script Not Loading
- Verify manifest.json content_scripts matches correct path
- Check that you're on viewer.html (not index.html)
- Inspect page with F12 and check for console errors

### Save Dialog Doesn't Appear
- Verify File System Access API is supported (Chrome 86+)
- Check browser permissions
- Look for errors in content script console
- Try fallback: should trigger download instead

### Cross-Origin Issues
- Extension must be loaded in chrome://extensions (not as a webpage)
- Content script must run on allowed origins (see manifest.json)
- Check Content-Security-Policy headers

## Success Criteria

✅ Extension loads without errors
✅ Service worker shows "active" status
✅ Content script loads on viewer.html
✅ No "window is not defined" errors
✅ Keyboard shortcut triggers save action
✅ File System Access API dialog appears (or download works)

## Next Steps

Once basic loading works:
1. Test file save/open operations
2. Test autosave functionality
3. Test history storage
4. Test annotations persistence
5. Test popup UI interactions
6. Add unit tests
7. Add integration tests
8. Prepare for Chrome Web Store submission
