// Messaging Library
// Defines message schemas and helper functions

export class MessageHandler {
  constructor() {
    this.messageTypes = {
      // Background -> Content
      SAVE_REQUEST: 'SAVE_REQUEST',
      LOAD_FILE: 'LOAD_FILE',
      GET_STATE: 'GET_STATE',

      // Content -> Background
      FILE_LOADED: 'FILE_LOADED',
      FILE_MODIFIED: 'FILE_MODIFIED',
      FILE_SAVED: 'FILE_SAVED',
      FILE_SAVE_ERROR: 'FILE_SAVE_ERROR',
      ANNOTATIONS_UPDATED: 'ANNOTATIONS_UPDATED',
      VIEWER_STATE_UPDATED: 'VIEWER_STATE_UPDATED',

      // Extension -> Page
      GET_FILE_DATA: 'GET_FILE_DATA',
      APPLY_ANNOTATIONS: 'APPLY_ANNOTATIONS',
      GET_VIEWER_STATE: 'GET_VIEWER_STATE',

      // Page -> Extension
      PAGE_READY: 'PAGE_READY',
      EXTENSION_READY: 'EXTENSION_READY',
      ANNOTATIONS_CHANGED: 'ANNOTATIONS_CHANGED',
      KEYBOARD_SHORTCUT: 'KEYBOARD_SHORTCUT',

      // Popup -> Background
      OPEN_FILE: 'OPEN_FILE',
      SAVE_FILE: 'SAVE_FILE',
      SET_DEFAULT_FOLDER: 'SET_DEFAULT_FOLDER',
      ENABLE_AUTOSAVE: 'ENABLE_AUTOSAVE',
      DISABLE_AUTOSAVE: 'DISABLE_AUTOSAVE',
      GET_FILE_CONTENT: 'GET_FILE_CONTENT',

      // Background -> Popup
      HISTORY_UPDATED: 'HISTORY_UPDATED',
      CONTENT_READY: 'CONTENT_READY',
      UPDATE_BADGE: 'UPDATE_BADGE'
    };
  }

  /**
   * Create a message object
   */
  createMessage(type, data = {}) {
    return {
      type,
      data,
      timestamp: Date.now()
    };
  }

  /**
   * Send message to background script
   */
  async sendToBackground(type, data = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        this.createMessage(type, data),
        (response) => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(response);
          }
        }
      );
    });
  }

  /**
   * Send message to content script
   */
  async sendToContent(tabId, type, data = {}) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(
        tabId,
        this.createMessage(type, data),
        (response) => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(response);
          }
        }
      );
    });
  }

  /**
   * Send message to all tabs
   */
  async broadcast(type, data = {}) {
    const tabs = await chrome.tabs.query({});
    const promises = tabs.map(tab => 
      this.sendToContent(tab.id, type, data).catch(() => null)
    );
    return Promise.all(promises);
  }

  /**
   * Validate message schema
   */
  validateMessage(message, requiredFields = []) {
    if (!message || typeof message !== 'object') {
      return { valid: false, error: 'Invalid message object' };
    }

    if (!message.type || !this.messageTypes[message.type]) {
      return { valid: false, error: 'Invalid message type' };
    }

    for (const field of requiredFields) {
      if (!(field in message.data)) {
        return { valid: false, error: `Missing required field: ${field}` };
      }
    }

    return { valid: true };
  }
}
