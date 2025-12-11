// Background Service Worker for Kiosk Extension
// Handles file operations, downloads, keyboard shortcuts, and messaging

// Note: FileHandler uses window/document APIs and cannot run in service worker context
// File operations are delegated to content scripts via messaging
import { StorageManager } from '../lib/storage.js';
import { MessageHandler } from '../lib/messaging.js';

const storage = new StorageManager();
const messageHandler = new MessageHandler();

// Track active file handles and autosave state
const activeFiles = new Map(); // fileId -> { handle, content, lastSaved }
let autosaveInterval = null;

// Installation and updates
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('Kiosk Extension installed');
    // TODO: Create options page and uncomment this
    // chrome.runtime.openOptionsPage();
  } else if (details.reason === 'update') {
    console.log('Kiosk Extension updated to', chrome.runtime.getManifest().version);
  }
});

// Keyboard shortcuts
chrome.commands.onCommand.addListener((command) => {
  console.log('Command received:', command);
  
  switch (command) {
    case 'save-file':
      handleSaveCommand(false);
      break;
    case 'save-file-as':
      handleSaveCommand(true);
      break;
  }
});

async function handleSaveCommand(saveAs = false) {
  try {
    // Get active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab) {
      console.error('No active tab');
      return;
    }

    // Check if tab is Kiosk viewer
    if (!isKioskViewer(tab.url)) {
      console.log('Not a Kiosk viewer tab');
      return;
    }

    // Send save request to content script
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'SAVE_REQUEST',
      saveAs: saveAs
    });

    if (response?.success) {
      await handleFileSave(response.data, saveAs);
    }
  } catch (error) {
    console.error('Error handling save command:', error);
    showNotification('Save Error', 'Failed to save file');
  }
}

async function handleFileSave(data, saveAs = false) {
  try {
    const { fileId, filename, content, annotations } = data;

    // Delegate file saving to content script (which has window API access)
    // The content script will handle the actual File System Access API calls
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) {
      throw new Error('No active tab found');
    }

    // Send message to content script to handle file save
    const response = await chrome.tabs.sendMessage(tabs[0].id, {
      type: 'FILE_SAVE',
      data: {
        fileId,
        filename,
        content,
        annotations,
        saveAs,
        hasHandle: activeFiles.has(fileId)
      }
    });

    if (response?.success) {
      // Update active files tracking
      activeFiles.set(fileId, {
        content,
        lastSaved: Date.now()
      });
    }

    // Update history
    await storage.addToHistory({
      id: fileId,
      name: filename,
      lastOpened: Date.now(),
      size: content.byteLength || content.length,
      annotations: annotations?.length || 0
    });

    // Show success notification
    showNotification('File Saved', `${filename} saved successfully`);

    // Notify popup
    chrome.runtime.sendMessage({ type: 'FILE_SAVED', fileId });

    return true;
  } catch (error) {
    console.error('Error saving file:', error);
    showNotification('Save Error', error.message || 'Failed to save file');
    chrome.runtime.sendMessage({ type: 'FILE_SAVE_ERROR', error: error.message });
    return false;
  }
}

// Message handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Message received:', message.type);

  (async () => {
    try {
      switch (message.type) {
        case 'OPEN_FILE':
          await handleOpenFile(message);
          sendResponse({ success: true });
          break;

        case 'SAVE_FILE':
          const saved = await handleFileSave(message.data, message.saveAs || false);
          sendResponse({ success: saved });
          break;

        case 'GET_FILE_CONTENT':
          // Delegate to content script
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabs[0]) {
            const response = await chrome.tabs.sendMessage(tabs[0].id, {
              type: 'READ_FILE',
              fileId: message.fileId
            });
            sendResponse({ success: response?.success, content: response?.content });
          } else {
            sendResponse({ success: false, error: 'No active tab' });
          }
          break;

        case 'SET_DEFAULT_FOLDER':
          await storage.setSetting('defaultFolderName', message.folderName);
          sendResponse({ success: true });
          break;

        case 'ENABLE_AUTOSAVE':
          startAutosave(message.interval || 10000);
          sendResponse({ success: true });
          break;

        case 'DISABLE_AUTOSAVE':
          stopAutosave();
          sendResponse({ success: true });
          break;

        case 'FILE_MODIFIED':
          handleFileModified(message.fileId, message.content);
          sendResponse({ success: true });
          break;

        default:
          console.warn('Unknown message type:', message.type);
          sendResponse({ success: false, error: 'Unknown message type' });
      }
    } catch (error) {
      console.error('Error handling message:', error);
      sendResponse({ success: false, error: error.message });
    }
  })();

  // Return true to indicate async response
  return true;
});

async function handleOpenFile(message) {
  try {
    const { fileId, url } = message;

    // Get Kiosk viewer URL
    const kioskUrl = getKioskViewerUrl();
    
    if (!kioskUrl) {
      throw new Error('Kiosk viewer URL not found');
    }

    // Create or update tab
    const [existingTab] = await chrome.tabs.query({ url: `${kioskUrl}*` });
    
    if (existingTab) {
      // Update existing tab
      await chrome.tabs.update(existingTab.id, {
        active: true,
        url: url ? `${kioskUrl}?file=${encodeURIComponent(url)}` : kioskUrl
      });
    } else {
      // Create new tab
      await chrome.tabs.create({
        url: url ? `${kioskUrl}?file=${encodeURIComponent(url)}` : kioskUrl,
        active: true
      });
    }

    // Update history
    if (fileId) {
      await storage.updateHistoryItem(fileId, { lastOpened: Date.now() });
    }

    return true;
  } catch (error) {
    console.error('Error opening file:', error);
    throw error;
  }
}

function handleFileModified(fileId, content) {
  const fileData = activeFiles.get(fileId);
  
  if (fileData) {
    fileData.content = content;
    activeFiles.set(fileId, fileData);
  } else {
    activeFiles.set(fileId, {
      handle: null,
      content: content,
      lastSaved: null
    });
  }
}

// Autosave functionality
function startAutosave(interval) {
  stopAutosave();
  
  autosaveInterval = setInterval(async () => {
    for (const [fileId, data] of activeFiles.entries()) {
      try {
        // Delegate autosave to content script
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]) {
          await chrome.tabs.sendMessage(tabs[0].id, {
            type: 'AUTOSAVE',
            fileId,
            content: data.content
          });
          data.lastSaved = Date.now();
          activeFiles.set(fileId, data);
          console.log(`Autosaved: ${fileId}`);
        }
      } catch (error) {
        console.error(`Autosave failed for ${fileId}:`, error);
      }
    }
  }, interval);

  console.log('Autosave enabled with interval:', interval);
}

function stopAutosave() {
  if (autosaveInterval) {
    clearInterval(autosaveInterval);
    autosaveInterval = null;
    console.log('Autosave disabled');
  }
}

// Context menu (optional)
chrome.runtime.onStartup.addListener(() => {
  chrome.contextMenus.create({
    id: 'open-in-kiosk',
    title: 'Open in Kiosk',
    contexts: ['link'],
    targetUrlPatterns: ['*.pdf', '*/*.pdf']
  });
});

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'open-in-kiosk' && info.linkUrl) {
    const kioskUrl = getKioskViewerUrl();
    if (kioskUrl) {
      chrome.tabs.create({
        url: `${kioskUrl}?file=${encodeURIComponent(info.linkUrl)}`,
        active: true
      });
    }
  }
});

// Helper functions
function isKioskViewer(url) {
  if (!url) return false;
  
  const kioskDomains = [
    'localhost:5500',
    'localhost:8000',
    '127.0.0.1',
    'syrthax.github.io/Kiosk'
  ];

  return kioskDomains.some(domain => url.includes(domain) && url.includes('viewer.html'));
}

function getKioskViewerUrl() {
  // Default to production URL
  // Users can set their preferred local URL via extension options
  return 'https://syrthax.github.io/Kiosk/viewer.html';
}

function showNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: '../icons/icon128.png',
    title: title,
    message: message,
    priority: 1
  });
}

// Clean up on extension unload
self.addEventListener('beforeunload', () => {
  stopAutosave();
  activeFiles.clear();
});

console.log('Kiosk Extension service worker loaded');
