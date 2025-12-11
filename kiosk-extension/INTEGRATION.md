# Kiosk Website Integration Guide

This document explains how to integrate the Kiosk Chrome Extension with your website to enable seamless file operations and communication.

## Overview

The extension communicates with your website through:
1. **Content Scripts** - Injected by the extension
2. **PostMessage API** - Cross-context communication
3. **Page Context Scripts** - Injected into your page's JavaScript scope

## Message Protocol

### Extension → Page Messages

Messages from the extension to your page arrive via `window.postMessage()` with `source: 'kiosk-extension'`.

#### 1. EXTENSION_READY
Sent when the extension content script is ready.

```javascript
window.addEventListener('message', (event) => {
  if (event.data.source === 'kiosk-extension' && event.data.type === 'EXTENSION_READY') {
    console.log('Extension is active');
    // Enable extension-specific features in your UI
  }
});
```

#### 2. GET_FILE_DATA
Requests current PDF data and annotations.

```javascript
// Extension sends this message, you respond with file data
window.addEventListener('message', async (event) => {
  if (event.data.source === 'kiosk-extension' && event.data.type === 'GET_FILE_DATA') {
    const { messageId, includeAnnotations } = event.data;
    
    try {
      // Get PDF data (ArrayBuffer or Uint8Array)
      const pdfData = await exportPDF(); // Your export function
      
      // Get annotations if requested
      const annotations = includeAnnotations ? Array.from(window.annotations || []) : null;
      
      // Respond to extension
      window.postMessage({
        source: 'kiosk-page',
        messageId: messageId, // Echo back for request matching
        success: true,
        content: pdfData,
        annotations: annotations,
        filename: currentPDFFile.name || 'document.pdf'
      }, window.location.origin);
      
    } catch (error) {
      // Send error response
      window.postMessage({
        source: 'kiosk-page',
        messageId: messageId,
        success: false,
        error: error.message
      }, window.location.origin);
    }
  }
});
```

#### 3. LOAD_FILE
Requests to load a PDF from a URL.

```javascript
window.addEventListener('message', async (event) => {
  if (event.data.source === 'kiosk-extension' && event.data.type === 'LOAD_FILE') {
    const { messageId, url } = event.data;
    
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      
      // Load PDF in your viewer
      await loadPDFFromFile(blob); // Your load function
      
      // Confirm success
      window.postMessage({
        source: 'kiosk-page',
        messageId: messageId,
        success: true
      }, window.location.origin);
      
    } catch (error) {
      window.postMessage({
        source: 'kiosk-page',
        messageId: messageId,
        success: false,
        error: error.message
      }, window.location.origin);
    }
  }
});
```

#### 4. APPLY_ANNOTATIONS
Requests to apply a set of annotations to the current PDF.

```javascript
window.addEventListener('message', (event) => {
  if (event.data.source === 'kiosk-extension' && event.data.type === 'APPLY_ANNOTATIONS') {
    const { messageId, annotations } = event.data;
    
    try {
      // Clear existing annotations
      clearAllAnnotations(); // Your clear function
      
      // Apply new annotations
      annotations.forEach(annotation => {
        addAnnotation(annotation); // Your add function
      });
      
      window.postMessage({
        source: 'kiosk-page',
        messageId: messageId,
        success: true
      }, window.location.origin);
      
    } catch (error) {
      window.postMessage({
        source: 'kiosk-page',
        messageId: messageId,
        success: false,
        error: error.message
      }, window.location.origin);
    }
  }
});
```

#### 5. GET_VIEWER_STATE
Requests current viewer state (page, zoom, tool, etc.).

```javascript
window.addEventListener('message', (event) => {
  if (event.data.source === 'kiosk-extension' && event.data.type === 'GET_VIEWER_STATE') {
    const { messageId } = event.data;
    
    const state = {
      currentPage: window.currentPage || 1,
      totalPages: window.totalPages || 0,
      scale: window.currentScale || 1.0,
      scrollPosition: { x: window.scrollX, y: window.scrollY },
      selectedTool: window.selectedTool || null,
      theme: document.body.getAttribute('data-theme') || 'light'
    };
    
    window.postMessage({
      source: 'kiosk-page',
      messageId: messageId,
      success: true,
      state: state
    }, window.location.origin);
  }
});
```

### Page → Extension Messages

Notify the extension of events in your page by sending messages with `source: 'kiosk-page'`.

#### 1. FILE_LOADED
Notify when a new PDF is loaded.

```javascript
function notifyFileLoaded(file) {
  window.postMessage({
    source: 'kiosk-page',
    type: 'FILE_LOADED',
    data: {
      fileId: file.id || `file_${Date.now()}`,
      filename: file.name || 'document.pdf',
      size: file.size || 0
    }
  }, window.location.origin);
}

// Call after loading PDF
document.getElementById('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  await loadPDFFromFile(file);
  notifyFileLoaded(file);
});
```

#### 2. FILE_MODIFIED
Notify when the PDF or annotations are modified.

```javascript
function notifyFileModified() {
  window.postMessage({
    source: 'kiosk-page',
    type: 'FILE_MODIFIED',
    data: {}
  }, window.location.origin);
}

// Call after any modification
function addAnnotation(annotation) {
  // Your annotation logic
  annotations.add(annotation);
  
  // Notify extension
  notifyFileModified();
}
```

#### 3. ANNOTATIONS_CHANGED
Notify when annotations specifically change.

```javascript
function notifyAnnotationsChanged() {
  window.postMessage({
    source: 'kiosk-page',
    type: 'ANNOTATIONS_CHANGED',
    data: {
      count: annotations.size,
      annotations: Array.from(annotations)
    }
  }, window.location.origin);
}

// Call after annotation operations
function deleteAnnotation(id) {
  annotations.delete(id);
  notifyAnnotationsChanged();
}
```

#### 4. VIEWER_STATE
Notify of viewer state changes (page navigation, zoom, etc.).

```javascript
function notifyViewerState() {
  window.postMessage({
    source: 'kiosk-page',
    type: 'VIEWER_STATE',
    data: {
      currentPage: window.currentPage,
      scale: window.currentScale,
      selectedTool: window.selectedTool
    }
  }, window.location.origin);
}

// Call on state changes
function changePage(newPage) {
  window.currentPage = newPage;
  renderPage(newPage);
  notifyViewerState();
}
```

## Security Best Practices

### 1. Validate Message Origin

Always verify the message origin matches your domain:

```javascript
window.addEventListener('message', (event) => {
  // CRITICAL: Verify origin
  if (event.origin !== window.location.origin) {
    console.warn('Rejected message from untrusted origin:', event.origin);
    return;
  }
  
  // Process message...
});
```

### 2. Validate Message Source

Check the `source` property to distinguish extension messages:

```javascript
const message = event.data;
if (!message || !message.source) return;

if (message.source === 'kiosk-extension') {
  // From extension
} else if (message.source === 'kiosk-page') {
  // From your own page
} else {
  // Unknown source, ignore
  return;
}
```

### 3. Sanitize Data

Never trust message data directly:

```javascript
function sanitizeFilename(filename) {
  return filename.replace(/[^a-z0-9.-]/gi, '_').substring(0, 255);
}

function validateAnnotation(annotation) {
  return (
    annotation &&
    typeof annotation.type === 'string' &&
    typeof annotation.page === 'number' &&
    annotation.page > 0
  );
}
```

## Complete Integration Example

Here's a complete example for `viewer.js`:

```javascript
// viewer.js - Extension Integration

class ExtensionBridge {
  constructor() {
    this.extensionActive = false;
    this.messageHandlers = new Map();
    this.init();
  }

  init() {
    window.addEventListener('message', this.handleMessage.bind(this));
    console.log('Extension bridge initialized');
  }

  handleMessage(event) {
    // Validate origin
    if (event.origin !== window.location.origin) return;

    const message = event.data;
    if (!message || !message.source) return;

    // Handle extension messages
    if (message.source === 'kiosk-extension') {
      this.handleExtensionMessage(message);
    }
  }

  async handleExtensionMessage(message) {
    console.log('Extension message:', message.type);

    switch (message.type) {
      case 'EXTENSION_READY':
        this.extensionActive = true;
        this.notifyExtension('PAGE_READY', {});
        break;

      case 'GET_FILE_DATA':
        await this.handleGetFileData(message);
        break;

      case 'LOAD_FILE':
        await this.handleLoadFile(message);
        break;

      case 'APPLY_ANNOTATIONS':
        await this.handleApplyAnnotations(message);
        break;

      case 'GET_VIEWER_STATE':
        this.handleGetViewerState(message);
        break;
    }
  }

  async handleGetFileData(message) {
    try {
      const pdfData = await exportPDF();
      const annotations = message.includeAnnotations 
        ? Array.from(window.annotations || [])
        : null;

      this.respondToExtension(message.messageId, {
        success: true,
        content: pdfData,
        annotations: annotations,
        filename: window.currentPDFFile?.name || 'document.pdf'
      });
    } catch (error) {
      this.respondToExtension(message.messageId, {
        success: false,
        error: error.message
      });
    }
  }

  async handleLoadFile(message) {
    try {
      const response = await fetch(message.url);
      const blob = await response.blob();
      await loadPDFFromFile(blob);

      this.respondToExtension(message.messageId, { success: true });
    } catch (error) {
      this.respondToExtension(message.messageId, {
        success: false,
        error: error.message
      });
    }
  }

  async handleApplyAnnotations(message) {
    try {
      clearAllAnnotations();
      message.annotations.forEach(annotation => {
        addAnnotation(annotation);
      });

      this.respondToExtension(message.messageId, { success: true });
    } catch (error) {
      this.respondToExtension(message.messageId, {
        success: false,
        error: error.message
      });
    }
  }

  handleGetViewerState(message) {
    const state = {
      currentPage: window.currentPage || 1,
      totalPages: window.totalPages || 0,
      scale: window.currentScale || 1.0,
      scrollPosition: { x: window.scrollX, y: window.scrollY },
      selectedTool: window.selectedTool || null,
      theme: document.body.getAttribute('data-theme') || 'light'
    };

    this.respondToExtension(message.messageId, {
      success: true,
      state: state
    });
  }

  notifyExtension(type, data) {
    if (!this.extensionActive) return;

    window.postMessage({
      source: 'kiosk-page',
      type: type,
      data: data
    }, window.location.origin);
  }

  respondToExtension(messageId, response) {
    window.postMessage({
      source: 'kiosk-page',
      messageId: messageId,
      ...response
    }, window.location.origin);
  }

  // Public methods to notify extension of events
  onFileLoaded(file) {
    this.notifyExtension('FILE_LOADED', {
      fileId: file.id || `file_${Date.now()}`,
      filename: file.name || 'document.pdf',
      size: file.size || 0
    });
  }

  onFileModified() {
    this.notifyExtension('FILE_MODIFIED', {});
  }

  onAnnotationsChanged() {
    this.notifyExtension('ANNOTATIONS_CHANGED', {
      count: annotations.size,
      annotations: Array.from(annotations)
    });
  }

  onViewerStateChanged() {
    this.notifyExtension('VIEWER_STATE', {
      currentPage: window.currentPage,
      scale: window.currentScale,
      selectedTool: window.selectedTool
    });
  }
}

// Initialize bridge
const extensionBridge = new ExtensionBridge();

// Hook into existing functions
const originalLoadPDF = loadPDFFromFile;
loadPDFFromFile = async function(file) {
  await originalLoadPDF(file);
  extensionBridge.onFileLoaded(file);
};

const originalAddAnnotation = addAnnotation;
addAnnotation = function(annotation) {
  originalAddAnnotation(annotation);
  extensionBridge.onFileModified();
  extensionBridge.onAnnotationsChanged();
};
```

## Testing Integration

### 1. Check if Extension is Active

```javascript
function isExtensionActive() {
  return window.extensionBridge?.extensionActive === true;
}

if (isExtensionActive()) {
  console.log('Extension features available');
  // Show extension-specific UI elements
}
```

### 2. Test Message Round-Trip

```javascript
async function testExtensionCommunication() {
  const messageId = Math.random().toString(36).substr(2, 9);
  
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Extension response timeout'));
    }, 3000);

    const handler = (event) => {
      if (event.data.messageId === messageId) {
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        resolve(event.data);
      }
    };

    window.addEventListener('message', handler);
    
    window.postMessage({
      source: 'kiosk-page',
      messageId: messageId,
      type: 'GET_VIEWER_STATE'
    }, window.location.origin);
  });
}

// Test communication
testExtensionCommunication()
  .then(response => console.log('Extension communication OK', response))
  .catch(error => console.error('Extension communication failed', error));
```

## FAQ

**Q: Do I need to modify my website for the extension to work?**  
A: Basic features work without modifications. For advanced features (autosave, state sync), integration is recommended.

**Q: What if the extension isn't installed?**  
A: The website functions normally. Extension messages are ignored harmlessly.

**Q: Can I detect if the extension is installed?**  
A: Yes, listen for the `EXTENSION_READY` message on page load. Set a timeout (e.g., 1000ms) - if no message, extension isn't active.

**Q: How do I handle extension updates?**  
A: The extension maintains backward compatibility. Check the `version` field in messages if needed.

**Q: What about privacy concerns?**  
A: All communication is local (same origin). No data leaves your device. The extension doesn't track or transmit anything.

## Support

For integration issues:
1. Check browser console for errors
2. Verify message origins and sources
3. Test with minimal example first
4. Open issue on GitHub with details

---

**Version**: 1.0.0  
**Last Updated**: 2024
