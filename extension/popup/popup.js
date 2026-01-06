/**
 * Kiosk PDF Reader - Popup Script
 * 
 * Handles:
 * - File selection and drag-drop
 * - URL input and opening
 * - Recent PDFs list
 * - Settings toggle
 */

'use strict';

// ==========================================
// DOM ELEMENTS
// ==========================================

const dom = {
  dropZone: document.getElementById('drop-zone'),
  fileInput: document.getElementById('file-input'),
  urlInput: document.getElementById('url-input'),
  openUrlBtn: document.getElementById('open-url'),
  recentList: document.getElementById('recent-list'),
  emptyState: document.getElementById('empty-state'),
  interceptToggle: document.getElementById('intercept-toggle')
};

// ==========================================
// INITIALIZATION
// ==========================================

async function init() {
  setupEventListeners();
  await loadSettings();
  await loadRecentPDFs();
}

function setupEventListeners() {
  // Drop zone click
  dom.dropZone.addEventListener('click', () => dom.fileInput.click());
  
  // File input change
  dom.fileInput.addEventListener('change', handleFileSelect);
  
  // Drag and drop
  dom.dropZone.addEventListener('dragover', handleDragOver);
  dom.dropZone.addEventListener('dragleave', handleDragLeave);
  dom.dropZone.addEventListener('drop', handleDrop);
  
  // URL input
  dom.urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openPDFFromURL();
  });
  dom.openUrlBtn.addEventListener('click', openPDFFromURL);
  
  // Settings toggle
  dom.interceptToggle.addEventListener('change', handleInterceptToggle);
}

// ==========================================
// FILE HANDLING
// ==========================================

function handleDragOver(e) {
  e.preventDefault();
  e.stopPropagation();
  dom.dropZone.classList.add('drag-over');
}

function handleDragLeave(e) {
  e.preventDefault();
  e.stopPropagation();
  dom.dropZone.classList.remove('drag-over');
}

function handleDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  dom.dropZone.classList.remove('drag-over');
  
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    const file = files[0];
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      openPDFFile(file);
    } else {
      alert('Please drop a PDF file.');
    }
  }
}

function handleFileSelect(e) {
  const files = e.target.files;
  if (files.length > 0) {
    openPDFFile(files[0]);
  }
  e.target.value = ''; // Reset for same file selection
}

async function openPDFFile(file) {
  try {
    // Read file as ArrayBuffer
    const arrayBuffer = await file.arrayBuffer();
    const base64Data = arrayBufferToBase64(arrayBuffer);
    
    // Send to background script to open in viewer
    const response = await chrome.runtime.sendMessage({
      type: 'OPEN_PDF_FILE',
      payload: {
        fileData: base64Data,
        filename: file.name
      }
    });
    
    if (response.success) {
      // Close popup after opening
      window.close();
    } else {
      throw new Error(response.error || 'Failed to open PDF');
    }
  } catch (error) {
    console.error('[Kiosk Popup] Error opening PDF file:', error);
    alert('Failed to open PDF: ' + error.message);
  }
}

// ==========================================
// URL HANDLING
// ==========================================

async function openPDFFromURL() {
  const url = dom.urlInput.value.trim();
  
  if (!url) {
    alert('Please enter a PDF URL');
    return;
  }
  
  // Validate URL
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    alert('Please enter a valid URL (starting with http:// or https://)');
    return;
  }
  
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'OPEN_PDF_URL',
      payload: { url }
    });
    
    if (response.success) {
      window.close();
    } else {
      throw new Error(response.error || 'Failed to open PDF');
    }
  } catch (error) {
    console.error('[Kiosk Popup] Error opening PDF URL:', error);
    alert('Failed to open PDF: ' + error.message);
  }
}

// ==========================================
// RECENT PDFS
// ==========================================

async function loadRecentPDFs() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_RECENT_PDFS' });
    
    if (response.success && response.data.length > 0) {
      renderRecentPDFs(response.data);
    } else {
      dom.emptyState.style.display = 'flex';
    }
  } catch (error) {
    console.error('[Kiosk Popup] Error loading recent PDFs:', error);
    dom.emptyState.style.display = 'flex';
  }
}

function renderRecentPDFs(pdfs) {
  dom.emptyState.style.display = 'none';
  
  // Clear existing items (except empty state)
  const existingItems = dom.recentList.querySelectorAll('.recent-item');
  existingItems.forEach(item => item.remove());
  
  pdfs.forEach(pdf => {
    const item = createRecentItem(pdf);
    dom.recentList.appendChild(item);
  });
}

function createRecentItem(pdf) {
  const item = document.createElement('div');
  item.className = 'recent-item';
  item.dataset.id = pdf.id;
  
  const timeAgo = formatTimeAgo(pdf.lastOpened);
  const hasAnnotations = pdf.hasAnnotations;
  
  item.innerHTML = `
    <div class="recent-item-icon">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
      </svg>
    </div>
    <div class="recent-item-info">
      <div class="recent-item-name">${escapeHtml(pdf.name)}</div>
      <div class="recent-item-meta">
        <span>${timeAgo}</span>
        ${hasAnnotations ? '<span class="recent-item-badge">Annotated</span>' : ''}
      </div>
    </div>
    <button class="recent-item-remove" title="Remove">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  `;
  
  // Click to open
  item.addEventListener('click', (e) => {
    if (!e.target.closest('.recent-item-remove')) {
      openRecentPDF(pdf);
    }
  });
  
  // Remove button
  item.querySelector('.recent-item-remove').addEventListener('click', (e) => {
    e.stopPropagation();
    removeRecentPDF(pdf.id);
  });
  
  return item;
}

async function openRecentPDF(pdf) {
  try {
    let response;
    
    if (pdf.url) {
      response = await chrome.runtime.sendMessage({
        type: 'OPEN_PDF_URL',
        payload: { url: pdf.url, filename: pdf.name }
      });
    } else {
      // Open from storage
      const viewerUrl = chrome.runtime.getURL(`viewer/viewer.html?id=${pdf.id}&name=${encodeURIComponent(pdf.name)}`);
      await chrome.tabs.create({ url: viewerUrl });
      response = { success: true };
    }
    
    if (response.success) {
      window.close();
    }
  } catch (error) {
    console.error('[Kiosk Popup] Error opening recent PDF:', error);
    alert('Failed to open PDF');
  }
}

async function removeRecentPDF(id) {
  try {
    await chrome.runtime.sendMessage({
      type: 'REMOVE_RECENT_PDF',
      payload: { id }
    });
    
    // Remove from UI
    const item = dom.recentList.querySelector(`[data-id="${id}"]`);
    if (item) {
      item.remove();
    }
    
    // Check if list is empty
    const remaining = dom.recentList.querySelectorAll('.recent-item');
    if (remaining.length === 0) {
      dom.emptyState.style.display = 'flex';
    }
  } catch (error) {
    console.error('[Kiosk Popup] Error removing recent PDF:', error);
  }
}

// ==========================================
// SETTINGS
// ==========================================

async function loadSettings() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    
    if (response.success && response.data) {
      dom.interceptToggle.checked = response.data.interceptEnabled !== false;
    }
  } catch (error) {
    console.error('[Kiosk Popup] Error loading settings:', error);
  }
}

async function handleInterceptToggle() {
  try {
    await chrome.runtime.sendMessage({
      type: 'UPDATE_SETTINGS',
      payload: { interceptEnabled: dom.interceptToggle.checked }
    });
  } catch (error) {
    console.error('[Kiosk Popup] Error updating settings:', error);
  }
}

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return 'Unknown';
  
  const now = Date.now();
  const diff = now - timestamp;
  
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  
  const date = new Date(timestamp);
  return date.toLocaleDateString();
}

// ==========================================
// START
// ==========================================

init();
