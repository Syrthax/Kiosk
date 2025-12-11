// ==========================================
// KIOSK EXTENSION – POPUP MAIN SCRIPT
// Handles file selection and viewer opening
// ==========================================

document.addEventListener('DOMContentLoaded', init);

function init() {
  // Get DOM elements
  const openPdfBtn = document.getElementById('open-pdf-btn');
  const fileInput = document.getElementById('file-input');
  const loading = document.getElementById('loading');
  const recentSection = document.getElementById('recent-section');
  const recentList = document.getElementById('recent-list');

  // Load recent files from storage
  loadRecentFiles();

  // Event listeners
  openPdfBtn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      handleFile(file);
      e.target.value = ''; // Reset to allow re-selecting same file
    }
  });

  // Drag and drop on button
  openPdfBtn.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPdfBtn.classList.add('dragover');
  });

  openPdfBtn.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPdfBtn.classList.remove('dragover');
  });

  openPdfBtn.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPdfBtn.classList.remove('dragover');
    
    const file = e.dataTransfer.files[0];
    if (file) {
      handleFile(file);
    }
  });

  // Prevent default drag behavior on document
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  // Load recent files from storage
  function loadRecentFiles() {
    chrome.storage.local.get(['recentFiles'], (result) => {
      if (result.recentFiles && result.recentFiles.length > 0) {
        recentSection.classList.add('visible');
        recentList.innerHTML = ''; // Clear existing items
        
        result.recentFiles.slice(0, 5).forEach(file => {
          const item = document.createElement('div');
          item.className = 'recent-item';
          item.innerHTML = `
            <span class="recent-icon">📄</span>
            <span class="recent-name">${escapeHtml(file.name)}</span>
          `;
          item.addEventListener('click', () => {
            openViewer(file.url || file.name);
          });
          recentList.appendChild(item);
        });
      }
    });
  }

  // Handle file selection
  async function handleFile(file) {
    if (!file || file.type !== 'application/pdf') {
      alert('Please select a valid PDF file');
      return;
    }

    loading.classList.add('active');

    // Save to recent files
    saveToRecentFiles(file.name);

    // Read file and store temporarily
    const reader = new FileReader();
    reader.onload = (e) => {
      // Store the PDF data
      const pdfData = Array.from(new Uint8Array(e.target.result));
      chrome.storage.local.set({ 
        tempPDF: pdfData,
        tempPDFName: file.name
      }, () => {
        // Open viewer
        openViewer();
      });
    };
    reader.onerror = () => {
      loading.classList.remove('active');
      alert('Error reading file');
    };
    reader.readAsArrayBuffer(file);
  }

  // Save file to recent files list
  function saveToRecentFiles(fileName) {
    chrome.storage.local.get(['recentFiles'], (result) => {
      const recent = result.recentFiles || [];
      const newFile = {
        name: fileName,
        timestamp: Date.now()
      };
      
      // Add to beginning, remove duplicates, keep last 10
      const updated = [
        newFile,
        ...recent.filter(f => f.name !== fileName)
      ].slice(0, 10);
      
      chrome.storage.local.set({ recentFiles: updated });
    });
  }

  // Open viewer in new tab
  function openViewer(fileUrl = null) {
    loading.classList.add('active');
    
    const viewerUrl = chrome.runtime.getURL('viewer.html') + 
      (fileUrl ? `?file=${encodeURIComponent(fileUrl)}` : '');
    
    chrome.tabs.create({ url: viewerUrl }, () => {
      window.close();
    });
  }

  // Escape HTML to prevent XSS
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
