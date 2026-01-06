/* ==========================================
   KIOSK – HOME PAGE LOGIC
   Handles file selection, floating dock auto-hide, and animations
   ========================================== */

// DOM Elements
const fileInput = document.getElementById('file-input');
const openPDFBtn = document.getElementById('open-pdf-btn');
const dockOpenPDFBtn = document.getElementById('dock-open-pdf');
const floatingDock = document.getElementById('floating-dock');
const themeToggle = document.getElementById('theme-toggle');

// Scroll tracking for floating dock auto-hide
let lastScrollY = window.scrollY;
let scrollVelocity = 0;
let ticking = false;

/* ==========================================
   INITIALIZATION
   ========================================== */

function init() {
  setupEventListeners();
  setupFloatingDockScroll();
  setupTheme();
}

/* ==========================================
   EVENT LISTENERS
   ========================================== */

function setupEventListeners() {
  // Open PDF buttons
  openPDFBtn.addEventListener('click', () => {
    fileInput.click();
  });
  
  dockOpenPDFBtn.addEventListener('click', () => {
    fileInput.click();
  });

  // File input change
  fileInput.addEventListener('change', handleFileSelect);

  // Drag and drop on Open PDF buttons
  [openPDFBtn, dockOpenPDFBtn].forEach(btn => {
    btn.addEventListener('dragover', handleButtonDragOver);
    btn.addEventListener('dragleave', handleButtonDragLeave);
    btn.addEventListener('drop', handleButtonDrop);
  });

  // Prevent default drag behavior on the whole page
  document.body.addEventListener('dragover', (e) => e.preventDefault());
  document.body.addEventListener('drop', (e) => e.preventDefault());
  
  // File drop on the entire page
  document.body.addEventListener('drop', handleFileDrop);
    // Theme Toggle
  themeToggle.addEventListener('click', toggleTheme);
    // Smooth scroll for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      e.preventDefault();
      const target = document.querySelector(this.getAttribute('href'));
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
}

/* ==========================================
   FLOATING DOCK AUTO-HIDE ON SCROLL
   ========================================== */

function setupFloatingDockScroll() {
  window.addEventListener('scroll', () => {
    if (!ticking) {
      window.requestAnimationFrame(() => {
        handleFloatingDockScroll();
        ticking = false;
      });
      ticking = true;
    }
  });
}

function handleFloatingDockScroll() {
  const currentScrollY = window.scrollY;
  
  if (currentScrollY > 300) {
    floatingDock.style.opacity = '1';
    floatingDock.style.transform = 'translateX(-50%) translateY(0)';
  } else {
    floatingDock.style.opacity = '0.9';
  }
  
  // Hide dock when scrolling down, show when scrolling up
  if (currentScrollY > lastScrollY && currentScrollY > 500) {
    floatingDock.style.transform = 'translateX(-50%) translateY(150%)';
  } else {
    floatingDock.style.transform = 'translateX(-50%) translateY(0)';
  }
  
  lastScrollY = currentScrollY;
}

/* ==========================================
   FILE SELECTION HANDLING
   ========================================== */

function handleFileSelect(e) {
  const files = e.target.files;
  if (files && files.length > 0) {
    openPDF(files[0]);
  }
  // Reset input so the same file can be selected again
  e.target.value = '';
}

/* ==========================================
   FILE DROP HANDLING
   ========================================== */

function handleButtonDragOver(e) {
  e.preventDefault();
  e.stopPropagation();
  const btn = e.currentTarget;
  
  // Add drag-over class for animation
  btn.classList.add('drag-over');
  
  // Apply transform based on button type
  if (btn.classList.contains('btn-primary')) {
    btn.style.transform = 'translateY(-5px) scale(1.08)';
  } else if (btn.classList.contains('dock-item-primary')) {
    btn.style.transform = 'translateY(-12px) scale(1.15)';
  }
  btn.style.boxShadow = '0 16px 40px var(--accent-glow)';
}

function handleButtonDragLeave(e) {
  e.preventDefault();
  e.stopPropagation();
  const btn = e.currentTarget;
  
  // Remove drag-over class
  btn.classList.remove('drag-over');
  
  // Reset styles
  btn.style.transform = '';
  btn.style.boxShadow = '';
}

function handleButtonDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  const btn = e.currentTarget;
  
  // Remove drag-over class
  btn.classList.remove('drag-over');
  
  // Reset styles
  btn.style.transform = '';
  btn.style.boxShadow = '';

  const files = e.dataTransfer.files;
  if (files && files.length > 0) {
    const file = files[0];
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      openPDF(file);
    } else {
      alert('Please drop a PDF file.');
    }
  }
}

function handleFileDrop(e) {
  e.preventDefault();
  e.stopPropagation();

  const files = e.dataTransfer.files;
  if (files && files.length > 0) {
    const file = files[0];
    // Check if it's a PDF
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      openPDF(file);
    } else {
      alert('Please drop a PDF file.');
    }
  }
}

/* ==========================================
   OPEN PDF
   ========================================== */

async function openPDF(file) {
  try {
    // Generate a unique ID for this file
    const id = generateFileId(file);
    
    // Convert file to ArrayBuffer
    const arrayBuffer = await file.arrayBuffer();
    const pdfData = new Uint8Array(arrayBuffer);
    
    // Check file size - warn if very large
    const fileSizeMB = file.size / (1024 * 1024);
    if (fileSizeMB > 100) {
      console.warn(`Large PDF detected: ${fileSizeMB.toFixed(1)}MB`);
    }
    
    // Store PDF data using IndexedDB (handles large files reliably)
    await storePDFInIndexedDB(id, pdfData, file.name);
    
    // Store lightweight metadata in sessionStorage for quick access
    try {
      sessionStorage.setItem(`kiosk_pdf_meta_${id}`, JSON.stringify({
        name: file.name,
        size: file.size,
        timestamp: Date.now()
      }));
    } catch (e) {
      console.warn('Could not store PDF metadata in sessionStorage:', e);
    }
    
    // Update history (metadata only)
    updateRecentPDFs({
      id: id,
      name: file.name,
      size: file.size,
      lastOpened: Date.now()
    });
    
    // Navigate to viewer
    window.location.href = `viewer.html?id=${id}`;
  } catch (error) {
    console.error('Error opening PDF:', error);
    alert('Failed to open PDF: ' + error.message);
  }
}

/* ==========================================
   INDEXEDDB STORAGE FOR LARGE PDFS
   ========================================== */

function openKioskDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('KioskPDFStore', 1);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('pdfs')) {
        db.createObjectStore('pdfs', { keyPath: 'id' });
      }
    };
  });
}

async function storePDFInIndexedDB(id, data, name) {
  const db = await openKioskDB();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['pdfs'], 'readwrite');
    const store = transaction.objectStore('pdfs');
    
    // Clear old PDFs to prevent storage bloat (keep only current)
    const clearRequest = store.clear();
    
    clearRequest.onsuccess = () => {
      const putRequest = store.put({
        id: id,
        data: data,
        name: name,
        timestamp: Date.now()
      });
      
      putRequest.onsuccess = () => resolve();
      putRequest.onerror = () => reject(putRequest.error);
    };
    
    clearRequest.onerror = () => reject(clearRequest.error);
  });
}

function updateRecentPDFs(newPDF) {
  // For now, just log - we'll implement full history later if needed
  console.log('PDF opened:', newPDF.name);
}

/* ==========================================
   UTILITY FUNCTIONS
   ========================================== */

function generateFileId(file) {
  // Generate a simple ID based on file name, size, and current timestamp
  const base = `${file.name}_${file.size}_${Date.now()}`;
  return btoa(base).replace(/[^a-zA-Z0-9]/g, '').substring(0, 16);
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/* ==========================================
   THEME MANAGEMENT
   ========================================== */

function toggleTheme() {
  const currentTheme = localStorage.getItem('kiosk_theme') || 'light';
  let newTheme;
  
  // Cycle through: light -> night -> light
  if (currentTheme === 'light') {
    newTheme = 'night';
  } else {
    newTheme = 'light';
  }
  
  localStorage.setItem('kiosk_theme', newTheme);
  applyTheme(newTheme);
}

function applyTheme(theme) {
  const body = document.body;
  
  // Remove all theme classes
  body.removeAttribute('data-theme');
  body.removeAttribute('data-system-theme');
  
  if (theme === 'auto') {
    // Auto mode: detect system preference
    const systemThemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
    body.setAttribute('data-theme', 'auto');
    const systemTheme = systemThemeMedia.matches ? 'night' : 'light';
    body.setAttribute('data-system-theme', systemTheme);
  } else {
    // Manual theme selection
    body.setAttribute('data-theme', theme);
  }
}

function setupTheme() {
  // Load saved theme or default to 'light'
  const savedTheme = localStorage.getItem('kiosk_theme') || 'light';
  
  // Apply initial theme
  applyTheme(savedTheme);
  
  // Setup system theme detection for auto mode
  const systemThemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
  
  // Listen for system theme changes if in auto mode
  systemThemeMedia.addEventListener('change', (e) => {
    const currentTheme = localStorage.getItem('kiosk_theme');
    if (currentTheme === 'auto') {
      const systemTheme = e.matches ? 'night' : 'light';
      document.body.setAttribute('data-system-theme', systemTheme);
    }
  });
}

/* ==========================================
   START THE APP
   ========================================== */

init();
