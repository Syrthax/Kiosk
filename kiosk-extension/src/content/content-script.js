// Content Script for Kiosk Extension
// Injects into Kiosk viewer pages to enable file operations and shortcuts

(function() {
  'use strict';

  console.log('Kiosk Extension content script loaded');

  // Check if we're on the viewer page
  if (!window.location.pathname.includes('viewer.html')) {
    console.log('Not on viewer page, content script inactive');
    return;
  }

  // Track current file state
  let currentFileId = null;
  let currentFilename = null;
  let hasUnsavedChanges = false;
  let lastModified = Date.now();

  // Initialize
  init();

  function init() {
    // Listen for messages from background
    chrome.runtime.onMessage.addListener(handleMessage);

    // Inject integration script into page context
    injectPageScript();

    // Set up communication with page
    window.addEventListener('message', handlePageMessage);

    // Notify extension that viewer is ready
    notifyReady();
  }

  function injectPageScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('src/content/page-integration.js');
    script.onload = function() {
      this.remove();
    };
    (document.head || document.documentElement).appendChild(script);
  }

  function handleMessage(message, sender, sendResponse) {
    console.log('Content script received message:', message.type);

    switch (message.type) {
      case 'SAVE_REQUEST':
        handleSaveRequest(message.saveAs || false)
          .then(data => sendResponse({ success: true, data }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true; // Async response

      case 'FILE_SAVE':
        handleFileSave(message.data)
          .then(() => sendResponse({ success: true }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true;

      case 'READ_FILE':
        handleReadFile(message.fileId)
          .then(content => sendResponse({ success: true, content }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true;

      case 'AUTOSAVE':
        handleAutosave(message.fileId, message.content)
          .then(() => sendResponse({ success: true }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true;

      case 'LOAD_FILE':
        loadFile(message.url)
          .then(() => sendResponse({ success: true }))
          .catch(error => sendResponse({ success: false, error: error.message }));
        return true;

      case 'GET_STATE':
        sendResponse({
          success: true,
          state: {
            fileId: currentFileId,
            filename: currentFilename,
            hasUnsavedChanges,
            lastModified
          }
        });
        break;

      default:
        console.warn('Unknown message type:', message.type);
        sendResponse({ success: false, error: 'Unknown message type' });
    }
  }

  function handlePageMessage(event) {
    // Only accept messages from same origin
    if (event.origin !== window.location.origin) return;

    const message = event.data;
    if (!message || !message.type || message.source !== 'kiosk-page') return;

    console.log('Content script received page message:', message.type);

    switch (message.type) {
      case 'FILE_LOADED':
        handleFileLoaded(message.data);
        break;

      case 'FILE_MODIFIED':
        handleFileModified();
        break;

      case 'ANNOTATIONS_CHANGED':
        handleAnnotationsChanged(message.data);
        break;

      case 'VIEWER_STATE':
        handleViewerState(message.data);
        break;
    }
  }

  async function handleSaveRequest(saveAs = false) {
    try {
      // Request file data from page
      const response = await sendPageMessage({
        type: 'GET_FILE_DATA',
        includeAnnotations: true
      });

      if (!response || !response.success) {
        throw new Error('Failed to get file data from page');
      }

      return {
        fileId: currentFileId || `file_${Date.now()}`,
        filename: currentFilename || 'document.pdf',
        content: response.content,
        annotations: response.annotations || []
      };
    } catch (error) {
      console.error('Error in handleSaveRequest:', error);
      throw error;
    }
  }

  function handleFileLoaded(data) {
    currentFileId = data.fileId || `file_${Date.now()}`;
    currentFilename = data.filename || 'document.pdf';
    hasUnsavedChanges = false;
    lastModified = Date.now();

    // Notify background
    chrome.runtime.sendMessage({
      type: 'FILE_LOADED',
      fileId: currentFileId,
      filename: currentFilename
    });

    // Show extension badge
    chrome.runtime.sendMessage({
      type: 'UPDATE_BADGE',
      text: ''
    });
  }

  function handleFileModified() {
    hasUnsavedChanges = true;
    lastModified = Date.now();

    // Update badge to show unsaved changes
    chrome.runtime.sendMessage({
      type: 'UPDATE_BADGE',
      text: '•',
      color: '#f44336'
    });

    // Notify background for autosave
    chrome.runtime.sendMessage({
      type: 'FILE_MODIFIED',
      fileId: currentFileId
    });
  }

  function handleAnnotationsChanged(annotations) {
    hasUnsavedChanges = true;
    lastModified = Date.now();

    // Store annotations in extension storage
    chrome.runtime.sendMessage({
      type: 'ANNOTATIONS_UPDATED',
      fileId: currentFileId,
      annotations: annotations,
      timestamp: Date.now()
    });
  }

  // File System Access API handlers (run in page context with window access)
  async function handleFileSave(data) {
    const { fileId, filename, content, saveAs } = data;
    
    try {
      if (!('showSaveFilePicker' in window)) {
        // Fallback to download
        return await saveWithDownload(filename, content);
      }

      const options = {
        suggestedName: filename,
        types: [{
          description: 'PDF Document',
          accept: { 'application/pdf': ['.pdf'] }
        }]
      };

      const handle = await window.showSaveFilePicker(options);
      const writable = await handle.createWritable();
      
      if (content instanceof ArrayBuffer) {
        await writable.write(content);
      } else if (content instanceof Blob) {
        await writable.write(content);
      } else {
        await writable.write(new Blob([content]));
      }
      
      await writable.close();
      hasUnsavedChanges = false;
      
      return true;
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log('Save cancelled by user');
        return false;
      }
      throw error;
    }
  }

  async function handleReadFile(fileId) {
    // Request file content from page
    const response = await sendPageMessage({
      type: 'GET_FILE_CONTENT',
      fileId: fileId
    });

    if (!response || !response.success) {
      throw new Error('Failed to get file content from page');
    }

    return response.content;
  }

  async function handleAutosave(fileId, content) {
    // For autosave, we just save to existing handle without prompting
    // This is a simplified version that would need handle caching
    console.log('Autosave requested for', fileId);
    // Implementation would require maintaining file handles
    return true;
  }

  async function saveWithDownload(filename, content) {
    try {
      const blob = content instanceof Blob 
        ? content 
        : new Blob([content], { type: 'application/pdf' });

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      return true;
    } catch (error) {
      console.error('Error saving with download:', error);
      throw error;
    }
  }

  function handleViewerState(state) {
    // Store viewer state for restoration
    chrome.runtime.sendMessage({
      type: 'VIEWER_STATE_UPDATED',
      fileId: currentFileId,
      state: state
    });
  }

  async function loadFile(url) {
    try {
      const response = await sendPageMessage({
        type: 'LOAD_FILE',
        url: url
      });

      if (!response || !response.success) {
        throw new Error('Failed to load file in page');
      }

      return true;
    } catch (error) {
      console.error('Error loading file:', error);
      throw error;
    }
  }

  function sendPageMessage(message) {
    return new Promise((resolve, reject) => {
      const messageId = Math.random().toString(36).substr(2, 9);
      
      const handler = (event) => {
        if (event.origin !== window.location.origin) return;
        if (!event.data || event.data.messageId !== messageId) return;
        
        window.removeEventListener('message', handler);
        clearTimeout(timeout);
        
        resolve(event.data);
      };

      const timeout = setTimeout(() => {
        window.removeEventListener('message', handler);
        reject(new Error('Page message timeout'));
      }, 5000);

      window.addEventListener('message', handler);
      
      window.postMessage({
        source: 'kiosk-extension',
        messageId: messageId,
        ...message
      }, window.location.origin);
    });
  }

  function notifyReady() {
    window.postMessage({
      source: 'kiosk-extension',
      type: 'EXTENSION_READY'
    }, window.location.origin);

    // Also notify background
    chrome.runtime.sendMessage({
      type: 'CONTENT_READY',
      url: window.location.href
    });
  }

  // Handle page unload
  window.addEventListener('beforeunload', (event) => {
    if (hasUnsavedChanges) {
      const message = 'You have unsaved changes. Are you sure you want to leave?';
      event.returnValue = message;
      return message;
    }
  });

  // Add visual indicator for extension
  function addExtensionIndicator() {
    const indicator = document.createElement('div');
    indicator.id = 'kiosk-extension-indicator';
    indicator.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
        <path d="M9 12l2 2 4-4"></path>
      </svg>
      <span>Extension Active</span>
    `;
    indicator.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: rgba(33, 150, 243, 0.9);
      color: white;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
      z-index: 10000;
      pointer-events: none;
      opacity: 0;
      animation: kiosk-fade-in 0.3s ease-out 1s forwards;
    `;

    const style = document.createElement('style');
    style.textContent = `
      @keyframes kiosk-fade-in {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes kiosk-fade-out {
        from { opacity: 1; transform: translateY(0); }
        to { opacity: 0; transform: translateY(10px); }
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(indicator);

    // Fade out after 3 seconds
    setTimeout(() => {
      indicator.style.animation = 'kiosk-fade-out 0.3s ease-out forwards';
      setTimeout(() => indicator.remove(), 300);
    }, 3000);
  }

  // Show indicator when page is ready
  if (document.readyState === 'complete') {
    addExtensionIndicator();
  } else {
    window.addEventListener('load', addExtensionIndicator);
  }

  console.log('Kiosk Extension content script initialized');
})();
