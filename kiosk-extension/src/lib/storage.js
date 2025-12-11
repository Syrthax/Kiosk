// Storage Manager Library
// Handles IndexedDB operations for history and settings

export class StorageManager {
  constructor() {
    this.dbName = 'KioskExtension';
    this.dbVersion = 1;
    this.db = null;
    this.initPromise = this.initDB();
  }

  /**
   * Initialize IndexedDB
   */
  async initDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => {
        console.error('Failed to open database:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log('Database opened successfully');
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Create object stores
        if (!db.objectStoreNames.contains('history')) {
          const historyStore = db.createObjectStore('history', { keyPath: 'id' });
          historyStore.createIndex('lastOpened', 'lastOpened', { unique: false });
          historyStore.createIndex('name', 'name', { unique: false });
        }

        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }

        if (!db.objectStoreNames.contains('annotations')) {
          const annotationsStore = db.createObjectStore('annotations', { keyPath: 'fileId' });
          annotationsStore.createIndex('timestamp', 'timestamp', { unique: false });
        }

        console.log('Database upgraded successfully');
      };
    });
  }

  /**
   * Ensure database is ready
   */
  async ready() {
    if (!this.db) {
      await this.initPromise;
    }
    return this.db;
  }

  /**
   * Add or update history item
   */
  async addToHistory(item) {
    const db = await this.ready();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['history'], 'readwrite');
      const store = transaction.objectStore('history');
      
      // Ensure required fields
      const historyItem = {
        id: item.id,
        name: item.name || 'Untitled',
        size: item.size || 0,
        lastOpened: item.lastOpened || Date.now(),
        url: item.url || null,
        thumbnail: item.thumbnail || null,
        annotations: item.annotations || 0,
        type: item.type || 'local'
      };

      const request = store.put(historyItem);

      request.onsuccess = () => {
        console.log('Added to history:', historyItem.id);
        resolve(historyItem);
      };

      request.onerror = () => {
        console.error('Failed to add to history:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Get all history items
   */
  async getHistory() {
    const db = await this.ready();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['history'], 'readonly');
      const store = transaction.objectStore('history');
      const request = store.getAll();

      request.onsuccess = () => {
        resolve(request.result || []);
      };

      request.onerror = () => {
        console.error('Failed to get history:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Get history item by ID
   */
  async getHistoryItem(id) {
    const db = await this.ready();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['history'], 'readonly');
      const store = transaction.objectStore('history');
      const request = store.get(id);

      request.onsuccess = () => {
        resolve(request.result || null);
      };

      request.onerror = () => {
        console.error('Failed to get history item:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Update history item
   */
  async updateHistoryItem(id, updates) {
    const db = await this.ready();
    
    return new Promise(async (resolve, reject) => {
      try {
        const item = await this.getHistoryItem(id);
        if (!item) {
          reject(new Error('History item not found'));
          return;
        }

        const updatedItem = { ...item, ...updates };
        
        const transaction = db.transaction(['history'], 'readwrite');
        const store = transaction.objectStore('history');
        const request = store.put(updatedItem);

        request.onsuccess = () => {
          resolve(updatedItem);
        };

        request.onerror = () => {
          console.error('Failed to update history item:', request.error);
          reject(request.error);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Remove history item
   */
  async removeFromHistory(id) {
    const db = await this.ready();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['history'], 'readwrite');
      const store = transaction.objectStore('history');
      const request = store.delete(id);

      request.onsuccess = () => {
        console.log('Removed from history:', id);
        resolve(true);
      };

      request.onerror = () => {
        console.error('Failed to remove from history:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Clear all history
   */
  async clearHistory() {
    const db = await this.ready();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['history'], 'readwrite');
      const store = transaction.objectStore('history');
      const request = store.clear();

      request.onsuccess = () => {
        console.log('History cleared');
        resolve(true);
      };

      request.onerror = () => {
        console.error('Failed to clear history:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Set a setting
   */
  async setSetting(key, value) {
    const db = await this.ready();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['settings'], 'readwrite');
      const store = transaction.objectStore('settings');
      const request = store.put({ key, value });

      request.onsuccess = () => {
        console.log('Setting saved:', key);
        resolve(true);
      };

      request.onerror = () => {
        console.error('Failed to save setting:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Get a setting
   */
  async getSetting(key) {
    const db = await this.ready();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['settings'], 'readonly');
      const store = transaction.objectStore('settings');
      const request = store.get(key);

      request.onsuccess = () => {
        resolve(request.result?.value || null);
      };

      request.onerror = () => {
        console.error('Failed to get setting:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Save annotations for a file
   */
  async saveAnnotations(fileId, annotations) {
    const db = await this.ready();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['annotations'], 'readwrite');
      const store = transaction.objectStore('annotations');
      
      const data = {
        fileId,
        annotations,
        timestamp: Date.now()
      };

      const request = store.put(data);

      request.onsuccess = () => {
        console.log('Annotations saved for:', fileId);
        resolve(true);
      };

      request.onerror = () => {
        console.error('Failed to save annotations:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Get annotations for a file
   */
  async getAnnotations(fileId) {
    const db = await this.ready();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['annotations'], 'readonly');
      const store = transaction.objectStore('annotations');
      const request = store.get(fileId);

      request.onsuccess = () => {
        resolve(request.result?.annotations || null);
      };

      request.onerror = () => {
        console.error('Failed to get annotations:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Clear all data
   */
  async clearAll() {
    const db = await this.ready();
    
    return new Promise((resolve, reject) => {
      const storeNames = ['history', 'settings', 'annotations'];
      const transaction = db.transaction(storeNames, 'readwrite');

      let completed = 0;
      const total = storeNames.length;

      storeNames.forEach(storeName => {
        const store = transaction.objectStore(storeName);
        const request = store.clear();

        request.onsuccess = () => {
          completed++;
          if (completed === total) {
            console.log('All data cleared');
            resolve(true);
          }
        };

        request.onerror = () => {
          console.error(`Failed to clear ${storeName}:`, request.error);
          reject(request.error);
        };
      });
    });
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      console.log('Database closed');
    }
  }
}
