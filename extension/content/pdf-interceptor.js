/**
 * Kiosk PDF Reader - Content Script (PDF Interceptor)
 * 
 * Responsibilities:
 * 1. Detect when Chrome is about to display a PDF
 * 2. Check Content-Type headers for PDF MIME types
 * 3. Notify background script to redirect to Kiosk viewer
 * 
 * This runs at document_start to intercept as early as possible
 */

(function() {
  'use strict';
  
  // Only run in top frame
  if (window.top !== window.self) return;
  
  // Check if we're already in the Kiosk viewer
  if (window.location.href.includes(chrome.runtime.id)) return;
  
  const PDF_MIME_TYPES = [
    'application/pdf',
    'application/x-pdf',
    'application/acrobat',
    'applications/vnd.pdf',
    'text/pdf',
    'text/x-pdf'
  ];
  
  /**
   * Check if this page is displaying a PDF
   */
  function isPDFPage() {
    // Method 1: Check URL extension
    const url = window.location.href.toLowerCase();
    if (url.endsWith('.pdf') || url.includes('.pdf?') || url.includes('.pdf#')) {
      return true;
    }
    
    // Method 2: Check document content type (if available)
    const contentType = document.contentType;
    if (contentType && PDF_MIME_TYPES.includes(contentType.toLowerCase())) {
      return true;
    }
    
    // Method 3: Check for PDF embed/object in page
    // (Chrome's built-in PDF viewer uses an embed)
    return false;
  }
  
  /**
   * Check for Chrome's built-in PDF viewer
   */
  function isChromePDFViewer() {
    // Chrome's PDF viewer has a specific structure
    const embed = document.querySelector('embed[type="application/pdf"]');
    return !!embed;
  }
  
  /**
   * Notify background script about PDF detection
   */
  async function notifyPDFDetected() {
    try {
      await chrome.runtime.sendMessage({
        type: 'PDF_DETECTED',
        payload: {
          url: window.location.href,
          contentType: document.contentType,
          title: document.title
        }
      });
    } catch (error) {
      console.error('[Kiosk] Error notifying PDF detection:', error);
    }
  }
  
  /**
   * Main detection logic
   */
  function detectAndIntercept() {
    if (isPDFPage()) {
      console.log('[Kiosk] PDF detected, notifying background script');
      notifyPDFDetected();
    }
  }
  
  // Run detection when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      // Small delay to let Chrome's PDF viewer initialize
      setTimeout(detectAndIntercept, 50);
    });
  } else {
    setTimeout(detectAndIntercept, 50);
  }
  
  // Also check after load (for dynamically loaded PDFs)
  window.addEventListener('load', () => {
    if (isChromePDFViewer()) {
      console.log('[Kiosk] Chrome PDF viewer detected');
      notifyPDFDetected();
    }
  });
  
})();
