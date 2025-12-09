/* ==========================================
   KIOSK – HOME PAGE LOGIC
   Handles file selection, floating dock auto-hide, and animations
   ========================================== */

// DOM Elements
const fileInput = document.getElementById('file-input');
const openPDFBtn = document.getElementById('open-pdf-btn');
const dockOpenPDFBtn = document.getElementById('dock-open-pdf');
const floatingDock = document.getElementById('floating-dock');

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
  scrollVelocity = currentScrollY - lastScrollY;
  
  // Hide dock when scrolling down fast (reduced threshold for faster response)
  if (scrollVelocity > 3 && currentScrollY > 80) {
    floatingDock.classList.add('hidden');
  }
  
  // Show dock when scrolling up (more sensitive)
  if (scrollVelocity < -1 || currentScrollY < 30) {
    floatingDock.classList.remove('hidden');
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
  e.currentTarget.style.transform = e.currentTarget.classList.contains('btn-primary') 
    ? 'translateY(-3px) scale(1.05)' 
    : 'translateY(-10px) scale(1.15)';
  e.currentTarget.style.boxShadow = '0 16px 40px var(--accent-glow)';
}

function handleButtonDragLeave(e) {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.style.transform = '';
  e.currentTarget.style.boxShadow = '';
}

function handleButtonDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.style.transform = '';
  e.currentTarget.style.boxShadow = '';

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
    
    // Convert ArrayBuffer to base64 string for storage
    const base64 = arrayBufferToBase64(arrayBuffer);
    
    // Store in sessionStorage (will be available in viewer page)
    sessionStorage.setItem(`kiosk_pdf_${id}`, base64);
    sessionStorage.setItem(`kiosk_pdf_name_${id}`, file.name);
    
    // Update history in localStorage
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
    alert('Failed to open PDF. Please try again.');
  }
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
   START THE APP
   ========================================== */

init();
