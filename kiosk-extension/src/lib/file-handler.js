// File Handler Library
// Handles File System Access API with fallback to downloads

export class FileHandler {
  constructor() {
    this.supportsFileSystemAccess = 'showSaveFilePicker' in window;
    this.fileHandles = new Map(); // filename -> FileSystemFileHandle
  }

  /**
   * Check if File System Access API is supported
   */
  isSupported() {
    return this.supportsFileSystemAccess;
  }

  /**
   * Save file using File System Access API or fallback to download
   * @param {string} filename - Name of file to save
   * @param {ArrayBuffer|Blob} content - File content
   * @returns {FileSystemFileHandle|null} File handle if supported, null otherwise
   */
  async saveFile(filename, content) {
    if (this.supportsFileSystemAccess) {
      return await this.saveWithFileSystemAccess(filename, content);
    } else {
      await this.saveWithDownload(filename, content);
      return null;
    }
  }

  /**
   * Save using File System Access API
   */
  async saveWithFileSystemAccess(filename, content) {
    try {
      const options = {
        suggestedName: filename,
        types: [{
          description: 'PDF Document',
          accept: { 'application/pdf': ['.pdf'] }
        }]
      };

      const handle = await window.showSaveFilePicker(options);
      await this.saveToHandle(handle, content);
      
      // Cache handle for future saves
      this.fileHandles.set(filename, handle);
      
      return handle;
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log('Save cancelled by user');
        return null;
      }
      throw error;
    }
  }

  /**
   * Save content to an existing file handle
   */
  async saveToHandle(handle, content) {
    try {
      const writable = await handle.createWritable();
      
      if (content instanceof ArrayBuffer) {
        await writable.write(content);
      } else if (content instanceof Blob) {
        await writable.write(content);
      } else {
        await writable.write(new Blob([content]));
      }
      
      await writable.close();
      return true;
    } catch (error) {
      console.error('Error writing to file:', error);
      throw error;
    }
  }

  /**
   * Fallback: Save using download
   */
  async saveWithDownload(filename, content) {
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
      
      // Clean up URL after download
      setTimeout(() => URL.revokeObjectURL(url), 100);
      
      return true;
    } catch (error) {
      console.error('Error downloading file:', error);
      throw error;
    }
  }

  /**
   * Open file using File System Access API or file input
   * @returns {File} Selected file
   */
  async openFile() {
    if (this.supportsFileSystemAccess) {
      return await this.openWithFileSystemAccess();
    } else {
      return await this.openWithFileInput();
    }
  }

  /**
   * Open using File System Access API
   */
  async openWithFileSystemAccess() {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{
          description: 'PDF Documents',
          accept: { 'application/pdf': ['.pdf'] }
        }],
        multiple: false
      });

      const file = await handle.getFile();
      
      // Store handle for future writes
      this.fileHandles.set(file.name, handle);
      
      return file;
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log('Open cancelled by user');
        return null;
      }
      throw error;
    }
  }

  /**
   * Fallback: Open using file input
   */
  async openWithFileInput() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.pdf,application/pdf';
      
      input.addEventListener('change', (event) => {
        const file = event.target.files?.[0];
        if (file) {
          resolve(file);
        } else {
          resolve(null);
        }
      });

      input.addEventListener('cancel', () => {
        resolve(null);
      });

      input.click();
    });
  }

  /**
   * Pick a directory for default save location
   * @returns {FileSystemDirectoryHandle|null}
   */
  async pickDirectory() {
    if (!('showDirectoryPicker' in window)) {
      throw new Error('Directory picker not supported');
    }

    try {
      const handle = await window.showDirectoryPicker({
        mode: 'readwrite'
      });
      
      return handle;
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log('Directory picker cancelled');
        return null;
      }
      throw error;
    }
  }

  /**
   * Get cached file handle by filename
   */
  getHandle(filename) {
    return this.fileHandles.get(filename);
  }

  /**
   * Clear cached file handles
   */
  clearHandles() {
    this.fileHandles.clear();
  }

  /**
   * Read file content
   * @param {File} file - File to read
   * @returns {ArrayBuffer}
   */
  async readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      
      reader.onload = (event) => {
        resolve(event.target.result);
      };
      
      reader.onerror = (error) => {
        reject(error);
      };
      
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * Verify file handle permission
   * @param {FileSystemFileHandle} handle
   * @param {string} mode - 'read' or 'readwrite'
   */
  async verifyPermission(handle, mode = 'readwrite') {
    const options = { mode };
    
    // Check if permission was already granted
    if ((await handle.queryPermission(options)) === 'granted') {
      return true;
    }
    
    // Request permission
    if ((await handle.requestPermission(options)) === 'granted') {
      return true;
    }
    
    return false;
  }
}
