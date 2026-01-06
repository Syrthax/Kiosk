/**
 * Kiosk PDF Reader - Service Worker (Background Script)
 * Manifest V3 compliant
 */

'use strict';

const VIEWER_PATH = 'viewer/viewer.html';
const MAX_RECENT_PDFS = 20;

function getViewerURL() {
  return chrome.runtime.getURL(VIEWER_PATH);
}

// ==========================================
// INSTALLATION
// ==========================================

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Kiosk] Extension installed:', details.reason);
  
  // Initialize storage
  const existing = await chrome.storage.local.get(['settings', 'recentPDFs']);
  
  if (!existing.settings) {
    await chrome.storage.local.set({
      settings: {
        theme: 'light',
        defaultZoom: 1.0,
        interceptEnabled: true
      }
    });
  }
  
  if (!existing.recentPDFs) {
    await chrome.storage.local.set({ recentPDFs: [] });
  }
  
  // Create context menu
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'open-pdf-in-kiosk',
        title: 'Open PDF in Kiosk',
        contexts: ['link'],
        targetUrlPatterns: ['*://*/*.pdf', '*://*/*.pdf?*', '*://*/*.PDF', '*://*/*.PDF?*']
      });
    });
  } catch (e) {
    console.error('[Kiosk] Context menu error:', e);
  }
});

// ==========================================
// CONTEXT MENU
// ==========================================

if (chrome.contextMenus && chrome.contextMenus.onClicked) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'open-pdf-in-kiosk') {
      openPDFInViewer(info.linkUrl);
    }
  });
}

// ==========================================
// PDF INTERCEPTION
// ==========================================

if (chrome.webNavigation && chrome.webNavigation.onBeforeNavigate) {
  chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
    if (details.frameId !== 0) return;
    if (details.url.includes(chrome.runtime.id)) return;
    
    try {
      const { settings } = await chrome.storage.local.get('settings');
      if (!settings || !settings.interceptEnabled) return;
    } catch (e) {
      return;
    }
    
    if (isPDFUrl(details.url)) {
      console.log('[Kiosk] Intercepting PDF:', details.url);
      const viewerUrl = `${getViewerURL()}?url=${encodeURIComponent(details.url)}`;
      chrome.tabs.update(details.tabId, { url: viewerUrl });
    }
  });
}

function isPDFUrl(url) {
  if (!url) return false;
  try {
    const urlLower = url.toLowerCase();
    if (urlLower.startsWith('data:') || urlLower.startsWith('blob:')) return false;
    if (urlLower.startsWith('chrome://') || urlLower.startsWith('chrome-extension://')) return false;
    
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.toLowerCase();
    if (pathname.endsWith('.pdf')) return true;
    if (urlObj.search.toLowerCase().includes('.pdf')) return true;
    return false;
  } catch {
    return url.toLowerCase().includes('.pdf');
  }
}

// ==========================================
// MESSAGE HANDLING
// ==========================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(response => sendResponse(response))
    .catch(error => sendResponse({ success: false, error: error.message }));
  return true;
});

async function handleMessage(message, sender) {
  const { type, payload } = message;
  
  switch (type) {
    case 'OPEN_PDF_URL':
      return await openPDFInViewer(payload.url, payload.filename);
    
    case 'GET_RECENT_PDFS':
      return await getRecentPDFs();
    
    case 'ADD_RECENT_PDF':
      return await addRecentPDF(payload);
    
    case 'GET_SETTINGS':
      return await getSettings();
    
    case 'UPDATE_SETTINGS':
      return await updateSettings(payload);
    
    case 'PDF_DETECTED':
      return await handlePDFDetection(sender.tab, payload);
    
    case 'SAVE_PDF':
      return await savePDFToFile(payload);
    
    default:
      return { success: false, error: 'Unknown message type' };
  }
}

// ==========================================
// PDF OPERATIONS
// ==========================================

async function openPDFInViewer(url, filename) {
  try {
    let viewerUrl = `${getViewerURL()}?url=${encodeURIComponent(url)}`;
    if (filename) {
      viewerUrl += `&name=${encodeURIComponent(filename)}`;
    }
    
    const tab = await chrome.tabs.create({ url: viewerUrl });
    
    await addRecentPDF({
      url: url,
      name: filename || extractFilename(url),
      timestamp: Date.now()
    });
    
    return { success: true, tabId: tab.id };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handlePDFDetection(tab, payload) {
  if (!tab) return { success: false, error: 'No tab' };
  
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings?.interceptEnabled) return { success: false };
  
  const viewerUrl = `${getViewerURL()}?url=${encodeURIComponent(payload.url)}`;
  
  try {
    await chrome.tabs.update(tab.id, { url: viewerUrl });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function savePDFToFile(payload) {
  try {
    const { data, filename } = payload;
    const blob = base64ToBlob(data, 'application/pdf');
    const url = URL.createObjectURL(blob);
    
    await chrome.downloads.download({
      url: url,
      filename: filename || 'annotated.pdf',
      saveAs: true
    });
    
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==========================================
// RECENT PDFS
// ==========================================

async function getRecentPDFs() {
  const { recentPDFs } = await chrome.storage.local.get('recentPDFs');
  return { success: true, data: recentPDFs || [] };
}

async function addRecentPDF(pdfInfo) {
  const { recentPDFs } = await chrome.storage.local.get('recentPDFs');
  let pdfs = recentPDFs || [];
  
  const id = `pdf_${Date.now()}`;
  pdfs = pdfs.filter(p => p.url !== pdfInfo.url);
  pdfs.unshift({ id, ...pdfInfo });
  pdfs = pdfs.slice(0, MAX_RECENT_PDFS);
  
  await chrome.storage.local.set({ recentPDFs: pdfs });
  return { success: true };
}

// ==========================================
// SETTINGS
// ==========================================

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { success: true, data: settings || { theme: 'light', interceptEnabled: true } };
}

async function updateSettings(newSettings) {
  const { settings } = await chrome.storage.local.get('settings');
  const updated = { ...settings, ...newSettings };
  await chrome.storage.local.set({ settings: updated });
  return { success: true, data: updated };
}

// ==========================================
// UTILITIES
// ==========================================

function extractFilename(url) {
  try {
    const pathname = new URL(url).pathname;
    return decodeURIComponent(pathname.split('/').pop() || 'document.pdf');
  } catch {
    return 'document.pdf';
  }
}

function base64ToBlob(base64, mimeType) {
  const byteChars = atob(base64);
  const byteArrays = [];
  for (let offset = 0; offset < byteChars.length; offset += 512) {
    const slice = byteChars.slice(offset, offset + 512);
    const byteNumbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }
    byteArrays.push(new Uint8Array(byteNumbers));
  }
  return new Blob(byteArrays, { type: mimeType });
}

console.log('[Kiosk] Service worker loaded');
