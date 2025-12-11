// Page Integration Script
// Injected into page context to access viewer.js functions and state
// This script bridges the content script with the actual page JavaScript

(function() {
  'use strict';

  console.log('Kiosk page integration script loaded');

  // Wait for viewer to be ready
  if (typeof window.pdfViewerApplication === 'undefined') {
    // PDF.js viewer not ready, wait for it
    document.addEventListener('DOMContentLoaded', initIntegration);
  } else {
    initIntegration();
  }

  function initIntegration() {
    console.log('Initializing Kiosk extension integration');

    // Listen for messages from content script
    window.addEventListener('message', handleExtensionMessage);

    // Monitor file loading
    observeFileLoad();

    // Monitor annotations
    observeAnnotations();

    // Monitor viewer state
    observeViewerState();

    // Notify extension that page is ready
    notifyExtension('PAGE_READY', {});
  }

  function handleExtensionMessage(event) {
    // Only accept messages from same origin
    if (event.origin !== window.location.origin) return;

    const message = event.data;
    if (!message || message.source !== 'kiosk-extension') return;

    console.log('Page received extension message:', message.type);

    switch (message.type) {
      case 'EXTENSION_READY':
        handleExtensionReady();
        break;

      case 'GET_FILE_DATA':
        handleGetFileData(message);
        break;

      case 'LOAD_FILE':
        handleLoadFile(message);
        break;

      case 'APPLY_ANNOTATIONS':
        handleApplyAnnotations(message);
        break;

      case 'GET_VIEWER_STATE':
        handleGetViewerState(message);
        break;
    }
  }

  function handleExtensionReady() {
    console.log('Extension is ready');
    
    // If a file is already loaded, notify extension
    if (window.currentPDFFile) {
      notifyExtension('FILE_LOADED', {
        fileId: window.currentPDFFile.id || null,
        filename: window.currentPDFFile.name || 'document.pdf',
        size: window.currentPDFFile.size || 0
      });
    }
  }

  async function handleGetFileData(message) {
    try {
      // Get PDF data
      let pdfData = null;
      
      if (window.pdfDoc) {
        // Export PDF with annotations using pdf-lib
        if (typeof exportPDF === 'function') {
          pdfData = await exportPDF();
        } else if (window.pdfBytes) {
          pdfData = window.pdfBytes;
        }
      }

      // Get annotations if requested
      let annotations = null;
      if (message.includeAnnotations && window.annotations) {
        annotations = Array.from(window.annotations || []);
      }

      respondToExtension(message.messageId, {
        success: true,
        content: pdfData,
        annotations: annotations,
        filename: window.currentPDFFile?.name || 'document.pdf'
      });
    } catch (error) {
      console.error('Error getting file data:', error);
      respondToExtension(message.messageId, {
        success: false,
        error: error.message
      });
    }
  }

  async function handleLoadFile(message) {
    try {
      // Load file using URL
      if (message.url) {
        const response = await fetch(message.url);
        const blob = await response.blob();
        
        // Trigger file load in viewer
        if (typeof loadPDFFromFile === 'function') {
          await loadPDFFromFile(blob);
          respondToExtension(message.messageId, { success: true });
        } else {
          throw new Error('loadPDFFromFile function not found');
        }
      } else {
        throw new Error('No URL provided');
      }
    } catch (error) {
      console.error('Error loading file:', error);
      respondToExtension(message.messageId, {
        success: false,
        error: error.message
      });
    }
  }

  function handleApplyAnnotations(message) {
    try {
      if (message.annotations && Array.isArray(message.annotations)) {
        // Clear existing annotations
        if (typeof clearAllAnnotations === 'function') {
          clearAllAnnotations();
        }

        // Apply new annotations
        message.annotations.forEach(annotation => {
          if (typeof addAnnotation === 'function') {
            addAnnotation(annotation);
          }
        });

        respondToExtension(message.messageId, { success: true });
      } else {
        throw new Error('Invalid annotations data');
      }
    } catch (error) {
      console.error('Error applying annotations:', error);
      respondToExtension(message.messageId, {
        success: false,
        error: error.message
      });
    }
  }

  function handleGetViewerState(message) {
    try {
      const state = {
        currentPage: window.currentPage || 1,
        totalPages: window.totalPages || 0,
        scale: window.currentScale || 1.0,
        scrollPosition: {
          x: window.scrollX,
          y: window.scrollY
        },
        selectedTool: window.selectedTool || null,
        theme: document.body.getAttribute('data-theme') || 'light'
      };

      respondToExtension(message.messageId, {
        success: true,
        state: state
      });
    } catch (error) {
      console.error('Error getting viewer state:', error);
      respondToExtension(message.messageId, {
        success: false,
        error: error.message
      });
    }
  }

  function observeFileLoad() {
    // Watch for file input changes
    const fileInput = document.getElementById('file-input');
    if (fileInput) {
      fileInput.addEventListener('change', (event) => {
        const file = event.target.files?.[0];
        if (file) {
          notifyExtension('FILE_LOADED', {
            fileId: `local_${Date.now()}`,
            filename: file.name,
            size: file.size
          });
        }
      });
    }

    // Watch for PDF load completion
    let lastLoadedFile = null;
    const checkInterval = setInterval(() => {
      if (window.pdfDoc && window.currentPDFFile !== lastLoadedFile) {
        lastLoadedFile = window.currentPDFFile;
        
        notifyExtension('FILE_LOADED', {
          fileId: window.currentPDFFile?.id || `file_${Date.now()}`,
          filename: window.currentPDFFile?.name || 'document.pdf',
          size: window.currentPDFFile?.size || 0
        });
      }
    }, 1000);

    // Clean up on unload
    window.addEventListener('beforeunload', () => {
      clearInterval(checkInterval);
    });
  }

  function observeAnnotations() {
    // Watch for annotation changes
    let lastAnnotationCount = 0;
    
    setInterval(() => {
      if (window.annotations) {
        const currentCount = window.annotations.size || 0;
        
        if (currentCount !== lastAnnotationCount) {
          lastAnnotationCount = currentCount;
          
          notifyExtension('ANNOTATIONS_CHANGED', {
            count: currentCount,
            annotations: Array.from(window.annotations || [])
          });
          
          notifyExtension('FILE_MODIFIED', {});
        }
      }
    }, 1000);
  }

  function observeViewerState() {
    // Watch for state changes
    let lastState = {
      page: 0,
      scale: 0,
      tool: null
    };

    setInterval(() => {
      const currentState = {
        page: window.currentPage || 0,
        scale: window.currentScale || 0,
        tool: window.selectedTool || null
      };

      if (JSON.stringify(currentState) !== JSON.stringify(lastState)) {
        lastState = currentState;
        
        notifyExtension('VIEWER_STATE', {
          currentPage: currentState.page,
          scale: currentState.scale,
          selectedTool: currentState.tool
        });
      }
    }, 500);
  }

  function notifyExtension(type, data) {
    window.postMessage({
      source: 'kiosk-page',
      type: type,
      data: data
    }, window.location.origin);
  }

  function respondToExtension(messageId, response) {
    window.postMessage({
      source: 'kiosk-page',
      messageId: messageId,
      ...response
    }, window.location.origin);
  }

  // Add keyboard shortcut handlers to complement extension shortcuts
  document.addEventListener('keydown', (event) => {
    // Ctrl/Cmd + S - Save
    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
      event.preventDefault();
      notifyExtension('KEYBOARD_SHORTCUT', { shortcut: 'save' });
    }

    // Ctrl/Cmd + Shift + S - Save As
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 's') {
      event.preventDefault();
      notifyExtension('KEYBOARD_SHORTCUT', { shortcut: 'save-as' });
    }
  });

  console.log('Kiosk page integration initialized');
})();
