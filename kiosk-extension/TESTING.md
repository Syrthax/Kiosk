# Kiosk Extension Test Plan

## Test Checklist

### Installation & Setup
- [ ] Extension loads without errors in `chrome://extensions`
- [ ] All required permissions are declared
- [ ] Onboarding modal appears on first install
- [ ] Extension icon appears in toolbar
- [ ] Service worker starts successfully

### Popup UI
- [ ] Popup opens when clicking extension icon
- [ ] Theme matches system preference (auto mode)
- [ ] All 4 themes work (Light, Dark, Night, Auto)
- [ ] Settings panel accessible via gear icon
- [ ] Back button returns to main popup
- [ ] Drop zone accepts PDF drag-and-drop
- [ ] Browse button opens file picker
- [ ] Only PDF files are accepted

### History
- [ ] Opened files appear in history list
- [ ] History items show thumbnail (if available)
- [ ] History items show last opened time
- [ ] Clicking history item reopens file
- [ ] Delete button removes from history
- [ ] Clear history button works
- [ ] Empty state shows when no history
- [ ] History persists after browser restart

### File Operations
- [ ] Open PDF from drag-drop
- [ ] Open PDF from file picker
- [ ] Open PDF from history
- [ ] File opens in Kiosk viewer
- [ ] File metadata tracked correctly
- [ ] Multiple files can be tracked

### Save Operations (Chrome 102+)
- [ ] Ctrl/Cmd + S triggers save
- [ ] First save prompts for location
- [ ] Subsequent saves update same file
- [ ] Ctrl/Cmd + Shift + S triggers Save As
- [ ] Save As always prompts for location
- [ ] PDF with annotations saves correctly
- [ ] Save notification appears
- [ ] Error notification on save failure
- [ ] Unsaved changes indicator (badge/icon)

### Save Fallback (Older Browsers)
- [ ] Download dialog appears instead of file picker
- [ ] File downloads with correct name
- [ ] Multiple saves create separate downloads

### Autosave
- [ ] Autosave toggle works in popup footer
- [ ] Autosave interval setting works (5s, 10s, 30s, 1min)
- [ ] Autosave triggers at correct intervals
- [ ] Autosave only works when file handle exists
- [ ] Autosave notification appears (optional)
- [ ] Autosave disabled when toggle is off

### Default Folder
- [ ] "Choose Folder" button opens directory picker
- [ ] Selected folder name displays in settings
- [ ] Permission request appears
- [ ] Permission can be granted
- [ ] Permission can be denied (graceful handling)
- [ ] Default folder persists across sessions

### Keyboard Shortcuts
- [ ] Ctrl/Cmd + S works on Windows/Mac
- [ ] Ctrl/Cmd + Shift + S works
- [ ] Shortcuts only active on Kiosk pages
- [ ] Shortcuts don't conflict with browser defaults
- [ ] Shortcuts configurable in `chrome://extensions/shortcuts`

### Content Script Integration
- [ ] Content script injects into Kiosk viewer
- [ ] Extension indicator appears briefly
- [ ] No console errors on injection
- [ ] Communication with page context works
- [ ] File data retrieval successful
- [ ] Annotations retrieval successful

### Annotation Persistence
- [ ] Annotations save with PDF
- [ ] Annotations restore on file reopen
- [ ] Multiple annotation types supported
- [ ] Annotation count tracked in history
- [ ] Modified annotation triggers save indicator

### Storage & Settings
- [ ] Settings persist across sessions
- [ ] Theme setting works
- [ ] Autosave settings persist
- [ ] Default folder setting persists
- [ ] Storage info displays correctly
- [ ] "Clear All Data" works
- [ ] IndexedDB stores created correctly

### Cross-Domain Support
- [ ] Works on localhost:5500
- [ ] Works on localhost:8000
- [ ] Works on 127.0.0.1
- [ ] Works on GitHub Pages (syrthax.github.io/Kiosk)
- [ ] Doesn't inject on non-Kiosk pages

### Error Handling
- [ ] Graceful handling of permission denial
- [ ] Error messages clear and helpful
- [ ] No uncaught exceptions in console
- [ ] Invalid file types rejected
- [ ] Network errors handled
- [ ] Storage quota exceeded handled

### Performance
- [ ] Popup opens in < 200ms
- [ ] History loads in < 500ms
- [ ] No memory leaks (check Task Manager)
- [ ] Service worker doesn't consume excessive resources
- [ ] Large PDFs (10MB+) handled smoothly
- [ ] Multiple tabs don't cause issues

### Accessibility
- [ ] All buttons have aria-labels
- [ ] Keyboard navigation works
- [ ] Screen reader compatible
- [ ] High contrast mode works
- [ ] Focus indicators visible
- [ ] Tab order logical

### Browser Compatibility
- [ ] Chrome 102+ (File System Access)
- [ ] Chrome 90-101 (Download fallback)
- [ ] Edge 102+
- [ ] Opera 88+
- [ ] Brave (Chromium-based)

### Edge Cases
- [ ] Opening same file multiple times
- [ ] Switching between multiple files
- [ ] Browser restart with unsaved changes
- [ ] Extension update preserves data
- [ ] Uninstall cleanup
- [ ] Incognito mode (should work with appropriate permissions)

### Security
- [ ] No eval() or unsafe code execution
- [ ] CSP compliant
- [ ] No external network requests
- [ ] Permissions minimal and justified
- [ ] No data leakage to other origins
- [ ] Secure postMessage communication

## Manual Testing Scenarios

### Scenario 1: First-Time User
1. Install extension
2. See onboarding modal
3. Click "Got it"
4. Drop a PDF in popup
5. Annotate in Kiosk
6. Press Ctrl+S
7. Choose save location
8. Reopen from history
9. Verify annotations present

### Scenario 2: Power User Workflow
1. Open extension settings
2. Enable autosave (10s)
3. Choose default folder
4. Open PDF from history
5. Make annotations continuously
6. Verify autosave notifications
7. Close tab
8. Reopen file
9. Verify all changes saved

### Scenario 3: Cross-Device (Same Browser)
1. Use extension on laptop
2. Save files to cloud folder (Dropbox, OneDrive)
3. Open same files on desktop
4. Verify history separate per device
5. Verify annotations in files (not history)

### Scenario 4: Theme Switching
1. Set theme to Light
2. Open popup, verify light theme
3. Switch to Dark
4. Verify immediate update
5. Switch to Auto
6. Change system theme
7. Verify popup follows system

### Scenario 5: Permission Denial
1. Click "Choose Folder"
2. Deny permission
3. Verify graceful error message
4. Verify fallback to download
5. Try again, grant permission
6. Verify save works

## Automated Testing (Future)

```bash
# Install test dependencies
npm install --save-dev jest puppeteer

# Run tests
npm test

# Coverage
npm run test:coverage
```

Test files to create:
- `tests/popup.test.js`
- `tests/storage.test.js`
- `tests/file-handler.test.js`
- `tests/messaging.test.js`
- `tests/integration.test.js`

## Test Environment Setup

```bash
# Local dev server for Kiosk
cd /path/to/kiosk
python -m http.server 5500
# or
npx serve -p 5500

# Load extension
chrome --load-extension=/path/to/kiosk-extension
```

## Bug Report Template

```markdown
**Title**: Clear, concise description

**Steps to Reproduce**:
1. Step one
2. Step two
3. ...

**Expected Behavior**: What should happen

**Actual Behavior**: What actually happened

**Environment**:
- Browser: Chrome 120
- OS: Windows 11 / macOS 14 / Ubuntu 22.04
- Extension Version: 1.0.0

**Console Errors**: (If any)
```
Error message here
```

**Screenshots**: (If applicable)

**Additional Context**: Any other relevant info
```

## Test Results Log

| Test Date | Tester | Chrome Version | Pass Rate | Critical Issues |
|-----------|--------|----------------|-----------|-----------------|
| YYYY-MM-DD | Name | 120.0.6099 | 98/100 | None |

---

**Note**: Mark items as complete ✅ or failed ❌ with notes
