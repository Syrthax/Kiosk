import { StorageManager } from '../lib/storage.js';
import { showToast } from '../lib/utils.js';

const storage = new StorageManager();

// DOM Elements
let onboardingModal, mainPopup, settingsPanel;
let dropZone, filePicker, historyList, emptyState;
let settingsBtn, backBtn, clearHistoryBtn, chooseFolderBtn, changeFolderBtn;
let autosaveCheckbox, autosaveInterval, themeSelect, storageInfo, clearAllDataBtn;
let filePickerBtn, enableFileAccessBtn, skipOnboardingBtn, openSettingsBtn;

// State
let currentTheme = 'auto';
let autosaveEnabled = true;

// Initialize
document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Get DOM elements
  onboardingModal = document.getElementById('onboarding-modal');
  mainPopup = document.getElementById('main-popup');
  settingsPanel = document.getElementById('settings-panel');
  dropZone = document.getElementById('drop-zone');
  filePicker = document.getElementById('file-picker');
  historyList = document.getElementById('history-list');
  emptyState = document.getElementById('empty-state');
  settingsBtn = document.getElementById('settings-btn');
  backBtn = document.getElementById('back-btn');
  clearHistoryBtn = document.getElementById('clear-history-btn');
  chooseFolderBtn = document.getElementById('choose-folder-btn');
  changeFolderBtn = document.getElementById('change-folder-btn');
  autosaveCheckbox = document.getElementById('autosave-checkbox');
  autosaveInterval = document.getElementById('autosave-interval');
  themeSelect = document.getElementById('theme-select');
  storageInfo = document.getElementById('storage-info');
  clearAllDataBtn = document.getElementById('clear-all-data-btn');
  filePickerBtn = document.getElementById('file-picker-btn');
  enableFileAccessBtn = document.getElementById('enable-file-access');
  skipOnboardingBtn = document.getElementById('skip-onboarding');
  openSettingsBtn = document.getElementById('open-settings');

  // Load settings
  await loadSettings();

  // Check if first run
  const hasSeenOnboarding = await storage.getSetting('hasSeenOnboarding');
  if (!hasSeenOnboarding) {
    showOnboarding();
  } else {
    showMainPopup();
  }

  // Event listeners
  setupEventListeners();

  // Load history
  await loadHistory();

  // Apply theme
  applyTheme(currentTheme);

  // Update storage info
  updateStorageInfo();
}

function setupEventListeners() {
  // Onboarding
  enableFileAccessBtn?.addEventListener('click', completeOnboarding);
  skipOnboardingBtn?.addEventListener('click', completeOnboarding);
  openSettingsBtn?.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://settings/content/pdfDocuments' });
  });

  // Navigation
  settingsBtn?.addEventListener('click', showSettings);
  backBtn?.addEventListener('click', showMainPopup);

  // File handling
  dropZone?.addEventListener('click', () => filePicker?.click());
  filePickerBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    filePicker?.click();
  });
  filePicker?.addEventListener('change', handleFileSelect);
  dropZone?.addEventListener('dragover', handleDragOver);
  dropZone?.addEventListener('dragleave', handleDragLeave);
  dropZone?.addEventListener('drop', handleDrop);

  // Settings
  chooseFolderBtn?.addEventListener('click', chooseSaveFolder);
  changeFolderBtn?.addEventListener('click', chooseSaveFolder);
  clearHistoryBtn?.addEventListener('click', clearHistory);
  clearAllDataBtn?.addEventListener('click', clearAllData);

  autosaveCheckbox?.addEventListener('change', (e) => {
    autosaveEnabled = e.target.checked;
    storage.setSetting('autosaveEnabled', autosaveEnabled);
    showToast(autosaveEnabled ? 'Autosave enabled' : 'Autosave disabled', 'info');
  });

  autosaveInterval?.addEventListener('change', (e) => {
    storage.setSetting('autosaveInterval', parseInt(e.target.value));
    showToast('Autosave interval updated', 'success');
  });

  themeSelect?.addEventListener('change', (e) => {
    currentTheme = e.target.value;
    storage.setSetting('theme', currentTheme);
    applyTheme(currentTheme);
    showToast('Theme updated', 'success');
  });
}

async function loadSettings() {
  currentTheme = (await storage.getSetting('theme')) || 'auto';
  autosaveEnabled = (await storage.getSetting('autosaveEnabled')) !== false;
  const interval = (await storage.getSetting('autosaveInterval')) || 10000;

  if (themeSelect) themeSelect.value = currentTheme;
  if (autosaveCheckbox) autosaveCheckbox.checked = autosaveEnabled;
  if (autosaveInterval) autosaveInterval.value = interval.toString();

  const folder = await storage.getSetting('defaultFolder');
  updateFolderDisplay(folder);
}

function showOnboarding() {
  onboardingModal?.classList.remove('hidden');
  mainPopup?.classList.add('hidden');
  settingsPanel?.classList.add('hidden');
}

async function completeOnboarding() {
  await storage.setSetting('hasSeenOnboarding', true);
  showMainPopup();
}

function showMainPopup() {
  onboardingModal?.classList.add('hidden');
  mainPopup?.classList.remove('hidden');
  settingsPanel?.classList.add('hidden');
}

function showSettings() {
  mainPopup?.classList.add('hidden');
  settingsPanel?.classList.remove('hidden');
  updateStorageInfo();
}

async function loadHistory() {
  const history = await storage.getHistory();
  
  if (!history || history.length === 0) {
    historyList.classList.add('hidden');
    emptyState.classList.remove('hidden');
    return;
  }

  historyList.classList.remove('hidden');
  emptyState.classList.add('hidden');
  historyList.innerHTML = '';

  // Sort by lastOpened, most recent first
  history.sort((a, b) => b.lastOpened - a.lastOpened);

  history.forEach((item) => {
    const element = createHistoryItem(item);
    historyList.appendChild(element);
  });
}

function createHistoryItem(item) {
  const div = document.createElement('div');
  div.className = 'history-item';
  div.setAttribute('data-id', item.id);

  const thumbnail = document.createElement('div');
  thumbnail.className = 'history-item-thumbnail';
  
  if (item.thumbnail) {
    const img = document.createElement('img');
    img.src = item.thumbnail;
    img.alt = item.name;
    thumbnail.appendChild(img);
  } else {
    thumbnail.innerHTML = `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
      </svg>
    `;
  }

  const info = document.createElement('div');
  info.className = 'history-item-info';
  
  const name = document.createElement('div');
  name.className = 'history-item-name';
  name.textContent = item.name;

  const meta = document.createElement('div');
  meta.className = 'history-item-meta';
  meta.textContent = formatDate(item.lastOpened);

  info.appendChild(name);
  info.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'history-item-actions';
  
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'icon-btn';
  deleteBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="3 6 5 6 21 6"></polyline>
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path>
    </svg>
  `;
  deleteBtn.title = 'Remove from history';
  deleteBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await storage.removeFromHistory(item.id);
    await loadHistory();
    showToast('Removed from history', 'success');
  });

  actions.appendChild(deleteBtn);

  div.appendChild(thumbnail);
  div.appendChild(info);
  div.appendChild(actions);

  div.addEventListener('click', () => openFile(item));

  return div;
}

async function openFile(item) {
  try {
    // Send message to background to open file in Kiosk
    chrome.runtime.sendMessage({
      type: 'OPEN_FILE',
      fileId: item.id,
      url: item.url || null
    });

    // Update last opened
    await storage.updateHistoryItem(item.id, { lastOpened: Date.now() });
    showToast('Opening in Kiosk...', 'info');
  } catch (error) {
    console.error('Error opening file:', error);
    showToast('Error opening file', 'error');
  }
}

function handleDragOver(e) {
  e.preventDefault();
  e.stopPropagation();
  dropZone?.classList.add('drag-over');
}

function handleDragLeave(e) {
  e.preventDefault();
  e.stopPropagation();
  dropZone?.classList.remove('drag-over');
}

async function handleDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  dropZone?.classList.remove('drag-over');

  const files = Array.from(e.dataTransfer.files).filter(
    (file) => file.type === 'application/pdf'
  );

  if (files.length === 0) {
    showToast('Please drop a PDF file', 'error');
    return;
  }

  await processFile(files[0]);
}

async function handleFileSelect(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  await processFile(file);
  filePicker.value = '';
}

async function processFile(file) {
  try {
    showToast('Processing PDF...', 'info');

    // Create object URL
    const url = URL.createObjectURL(file);

    // Add to history
    const historyItem = {
      id: `local_${Date.now()}`,
      name: file.name,
      size: file.size,
      lastOpened: Date.now(),
      url: url,
      type: 'local'
    };

    await storage.addToHistory(historyItem);
    await loadHistory();

    // Open in Kiosk
    chrome.runtime.sendMessage({
      type: 'OPEN_FILE',
      fileId: historyItem.id,
      url: url
    });

    showToast('Opening PDF in Kiosk...', 'success');
  } catch (error) {
    console.error('Error processing file:', error);
    showToast('Error processing file', 'error');
  }
}

async function chooseSaveFolder() {
  try {
    // Check if File System Access API is available
    if (!window.showDirectoryPicker) {
      showToast('File System Access API not supported', 'error');
      return;
    }

    const dirHandle = await window.showDirectoryPicker({
      mode: 'readwrite'
    });

    // Store handle (requires serialization in service worker)
    await storage.setSetting('defaultFolder', dirHandle.name);
    
    // Store handle reference
    chrome.runtime.sendMessage({
      type: 'SET_DEFAULT_FOLDER',
      folderName: dirHandle.name
    });

    updateFolderDisplay(dirHandle.name);
    showToast('Default folder updated', 'success');
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error('Error choosing folder:', error);
      showToast('Error choosing folder', 'error');
    }
  }
}

function updateFolderDisplay(folderName) {
  const currentFolderEl = document.getElementById('current-folder');
  if (currentFolderEl) {
    currentFolderEl.textContent = folderName || 'Not set';
  }
}

async function clearHistory() {
  if (!confirm('Clear all history? This cannot be undone.')) return;

  try {
    await storage.clearHistory();
    await loadHistory();
    showToast('History cleared', 'success');
  } catch (error) {
    console.error('Error clearing history:', error);
    showToast('Error clearing history', 'error');
  }
}

async function clearAllData() {
  if (!confirm('Clear all data including settings? This cannot be undone.')) return;

  try {
    await storage.clearAll();
    showToast('All data cleared', 'success');
    
    // Reset UI
    await loadSettings();
    await loadHistory();
  } catch (error) {
    console.error('Error clearing data:', error);
    showToast('Error clearing data', 'error');
  }
}

async function updateStorageInfo() {
  try {
    const estimate = await navigator.storage?.estimate();
    if (!estimate) {
      storageInfo.textContent = 'Storage info unavailable';
      return;
    }

    const used = (estimate.usage / 1024 / 1024).toFixed(2);
    const quota = (estimate.quota / 1024 / 1024).toFixed(2);
    storageInfo.textContent = `Using ${used} MB of ${quota} MB`;
  } catch (error) {
    console.error('Error getting storage info:', error);
    storageInfo.textContent = 'Unable to calculate storage';
  }
}

function applyTheme(theme) {
  const html = document.documentElement;
  
  if (theme === 'auto') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    html.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    html.setAttribute('data-theme', theme);
  }
}

function formatDate(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  // Less than 1 minute
  if (diff < 60000) {
    return 'Just now';
  }
  
  // Less than 1 hour
  if (diff < 3600000) {
    const minutes = Math.floor(diff / 60000);
    return `${minutes}m ago`;
  }
  
  // Less than 24 hours
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return `${hours}h ago`;
  }
  
  // Less than 7 days
  if (diff < 604800000) {
    const days = Math.floor(diff / 86400000);
    return `${days}d ago`;
  }
  
  // Format as date
  return date.toLocaleDateString();
}

// Listen for messages from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'HISTORY_UPDATED') {
    loadHistory();
  } else if (message.type === 'FILE_SAVED') {
    showToast('File saved successfully', 'success');
  } else if (message.type === 'FILE_SAVE_ERROR') {
    showToast('Error saving file', 'error');
  }
});
