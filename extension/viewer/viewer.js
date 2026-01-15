/* ==========================================
   KIOSK EXTENSION – VIEWER PAGE LOGIC
   Handles PDF rendering, navigation, search, and annotations
   ========================================== */

// Configure PDF.js worker for extension
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');

// Global state
let pdfDocument = null;
let currentScale = 1.2;
let previousScale = 1.2;
let currentRotation = 0;
let currentPDFName = 'Document.pdf';
let currentPDFUrl = null;
let currentTool = null;
let currentColor = '#ffc107';
let currentThickness = 3;
let currentTheme = 'light';
let systemThemeMedia = null;
let undoStack = [];
let redoStack = [];
let activeAction = null;
let searchMatches = [];
let activeSearchTimeout = null;
let baseContentHeight = 0;

// Focus-based rendering state
let currentPageIndex = 0;  // 0-indexed current page
let focusWindow = new Set();  // Pages in the focus window (high-quality)
let renderedPages = new Set();  // Pages that have been rendered (any quality)
let renderingPages = new Set();  // Pages currently being rendered
let pageViewports = new Map();  // Cached viewports per page

// Thumbnail state
let thumbnailCache = new Map();  // Cached thumbnail canvases
let thumbnailsGenerated = false;
let thumbnailSidebarOpen = true;

// Zoom debounce state
let zoomRenderTimeout = null;
const ZOOM_RENDER_DELAY = 300;  // ms to wait after zoom before re-rendering

// Scroll detection state
let scrollDetectionTimeout = null;
const SCROLL_DETECTION_DELAY = 100;  // ms to wait after scroll before detecting page

// Annotation history
let annotationHistory = new Map();

// DOM Elements
const pdfNameEl = document.getElementById('pdf-name');
const searchBar = document.getElementById('search-bar');
const searchResults = document.getElementById('search-results');
const pdfLoading = document.getElementById('pdf-loading');
const pdfCanvasWrapper = document.getElementById('pdf-canvas-wrapper');
const pdfError = document.getElementById('pdf-error');
const pdfContainer = document.getElementById('pdf-container');
const zoomLevel = document.getElementById('zoom-level');
const annotationDock = document.querySelector('.annotation-dock');
const thumbnailSidebar = document.getElementById('thumbnail-sidebar');
const thumbnailList = document.getElementById('thumbnail-list');
const thumbnailPageCount = document.getElementById('thumbnail-page-count');
const thumbnailToggle = document.getElementById('thumbnail-toggle');

/* ==========================================
   INITIALIZATION
   ========================================== */

function init() {
  setupEventListeners();
  setupPinchZoom();
  setupDockAutoHide();
  setupTheme();
  setupThumbnailSidebar();
  setupScrollDetection();
  loadPDFFromURL();
}

/* ==========================================
   EVENT LISTENERS
   ========================================== */

function setupEventListeners() {
  // Zoom controls
  document.getElementById('zoom-in').addEventListener('click', () => zoomIn());
  document.getElementById('zoom-out').addEventListener('click', () => zoomOut());
  document.getElementById('fit-width').addEventListener('click', () => fitToWidth());
  document.getElementById('fit-page').addEventListener('click', () => fitToPage());
  document.getElementById('rotate').addEventListener('click', () => rotatePDF());
  
  // Save & Download
  document.getElementById('save-pdf').addEventListener('click', () => savePDFWithAnnotations());
  document.getElementById('download').addEventListener('click', () => downloadPDF());
  
  // Go back button
  document.getElementById('go-back')?.addEventListener('click', () => window.close());
  
  // Search
  searchBar.addEventListener('input', handleSearchInput);
  searchBar.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (searchMatches.length > 0) {
        jumpToMatch(0);
        searchResults.classList.add('hidden');
      }
    }
  });
  searchBar.addEventListener('focus', () => {
    if (searchBar.value.trim() && searchMatches.length > 0) {
      searchResults.classList.remove('hidden');
    }
  });
  
  document.addEventListener('click', (e) => {
    if (!searchResults.contains(e.target) && e.target !== searchBar) {
      searchResults.classList.add('hidden');
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', handleKeyShortcuts);
  pdfContainer.addEventListener('scroll', clearSearchHighlights);
  
  // Annotation tools
  document.querySelectorAll('.annotation-tool').forEach(tool => {
    tool.addEventListener('click', () => handleToolSelect(tool.dataset.tool));
  });
  
  // Selection-based annotation
  document.addEventListener('mouseup', handleTextSelection);
  
  // Color picker setup
  setupColorPicker();
  
  // Thickness slider
  const thicknessSlider = document.getElementById('thickness-slider');
  thicknessSlider.addEventListener('input', (e) => {
    currentThickness = parseInt(e.target.value);
  });
  
  // Theme toggle
  const themeToggle = document.getElementById('theme-toggle');
  const themeDropdown = document.getElementById('theme-dropdown');
  
  themeToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    themeDropdown.classList.toggle('hidden');
  });
  
  document.querySelectorAll('.theme-dropdown-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      setTheme(item.dataset.theme);
      themeDropdown.classList.add('hidden');
    });
  });
  
  document.addEventListener('click', (e) => {
    if (!themeDropdown.contains(e.target) && e.target !== themeToggle) {
      themeDropdown.classList.add('hidden');
    }
  });
}

/* ==========================================
   THEME MANAGEMENT
   ========================================== */

function setupTheme() {
  currentTheme = localStorage.getItem('kiosk_theme') || 'light';
  systemThemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
  systemThemeMedia.addEventListener('change', handleSystemThemeChange);
  applyTheme(currentTheme);
}

function setTheme(theme) {
  currentTheme = theme;
  localStorage.setItem('kiosk_theme', theme);
  applyTheme(theme);
}

function applyTheme(theme) {
  const body = document.body;
  body.removeAttribute('data-theme');
  body.removeAttribute('data-system-theme');
  
  document.querySelectorAll('.theme-dropdown-item').forEach(item => {
    item.classList.toggle('active', item.dataset.theme === theme);
  });
  
  if (theme === 'auto') {
    body.setAttribute('data-theme', 'auto');
    body.setAttribute('data-system-theme', systemThemeMedia.matches ? 'night' : 'light');
  } else {
    body.setAttribute('data-theme', theme);
  }
}

function handleSystemThemeChange(e) {
  if (currentTheme === 'auto') {
    document.body.setAttribute('data-system-theme', e.matches ? 'night' : 'light');
  }
}

/* ==========================================
   COLOR PICKER
   ========================================== */

function setupColorPicker() {
  const colorPickerButton = document.getElementById('color-picker-button');
  const colorPicker = document.getElementById('color-picker');
  const colorSpectrum = document.getElementById('color-spectrum');
  const hueSlider = document.getElementById('hue-slider');
  const hexInput = document.getElementById('hex-input');
  
  let currentHue = 45;
  
  colorPickerButton.addEventListener('click', (e) => {
    e.stopPropagation();
    colorPicker.classList.toggle('hidden');
    if (!colorPicker.classList.contains('hidden')) {
      drawColorSpectrum(currentHue);
    }
  });
  
  document.addEventListener('click', (e) => {
    if (!colorPicker.contains(e.target) && e.target !== colorPickerButton) {
      colorPicker.classList.add('hidden');
    }
  });
  
  colorPicker.addEventListener('click', (e) => e.stopPropagation());
  
  document.querySelectorAll('.color-option').forEach(option => {
    option.addEventListener('click', (e) => {
      e.stopPropagation();
      setColor(option.dataset.color);
    });
  });
  
  drawColorSpectrum(currentHue);
  
  hueSlider.addEventListener('input', (e) => {
    currentHue = parseInt(e.target.value);
    drawColorSpectrum(currentHue);
  });
  
  colorSpectrum.addEventListener('click', (e) => {
    const rect = colorSpectrum.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const color = getColorFromSpectrum(x, y, currentHue, colorSpectrum.width, colorSpectrum.height);
    setColor(color);
  });
  
  hexInput.addEventListener('input', (e) => {
    let hex = e.target.value.replace(/[^0-9A-Fa-f]/g, '').substring(0, 6);
    e.target.value = hex;
    if (hex.length === 6) setColor('#' + hex);
  });
}

function drawColorSpectrum(hue) {
  const canvas = document.getElementById('color-spectrum');
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  
  for (let x = 0; x < width; x++) {
    const saturation = (x / width) * 100;
    for (let y = 0; y < height; y++) {
      const brightness = 100 - (y / height) * 100;
      ctx.fillStyle = `hsl(${hue}, ${saturation}%, ${brightness}%)`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

function getColorFromSpectrum(x, y, hue, width, height) {
  const saturation = (x / width) * 100;
  const brightness = 100 - (y / height) * 100;
  return hslToHex(hue, saturation, brightness);
}

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  
  if (h >= 0 && h < 60) { r = c; g = x; b = 0; }
  else if (h >= 60 && h < 120) { r = x; g = c; b = 0; }
  else if (h >= 120 && h < 180) { r = 0; g = c; b = x; }
  else if (h >= 180 && h < 240) { r = 0; g = x; b = c; }
  else if (h >= 240 && h < 300) { r = x; g = 0; b = c; }
  else if (h >= 300 && h < 360) { r = c; g = 0; b = x; }
  
  r = Math.round((r + m) * 255);
  g = Math.round((g + m) * 255);
  b = Math.round((b + m) * 255);
  
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

function setColor(color) {
  currentColor = color;
  document.getElementById('color-picker-button').style.backgroundColor = color;
  document.getElementById('hex-input').value = color.replace('#', '').toUpperCase();
}

/* ==========================================
   THUMBNAIL SIDEBAR
   ========================================== */

function setupThumbnailSidebar() {
  // Toggle sidebar on button click
  thumbnailToggle.addEventListener('click', () => {
    toggleThumbnailSidebar();
  });
  
  // Load saved preference
  const savedState = localStorage.getItem('kiosk_thumbnail_sidebar');
  thumbnailSidebarOpen = savedState !== 'collapsed';
  
  if (!thumbnailSidebarOpen) {
    thumbnailSidebar.classList.add('collapsed');
    thumbnailToggle.classList.add('active');
  }
}

function toggleThumbnailSidebar() {
  thumbnailSidebarOpen = !thumbnailSidebarOpen;
  thumbnailSidebar.classList.toggle('collapsed', !thumbnailSidebarOpen);
  thumbnailToggle.classList.toggle('active', !thumbnailSidebarOpen);
  
  // Save preference
  localStorage.setItem('kiosk_thumbnail_sidebar', thumbnailSidebarOpen ? 'open' : 'collapsed');
}

async function generateThumbnails() {
  if (!pdfDocument || thumbnailsGenerated) return;
  
  thumbnailList.innerHTML = '';
  thumbnailPageCount.textContent = `${pdfDocument.numPages} pages`;
  
  const THUMBNAIL_SCALE = 0.3;  // Low resolution for thumbnails
  
  // Generate thumbnails progressively
  for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
    // Create thumbnail container immediately for layout
    const thumbnailItem = document.createElement('div');
    thumbnailItem.className = 'thumbnail-item';
    thumbnailItem.dataset.pageNumber = pageNum;
    if (pageNum === 1) thumbnailItem.classList.add('active');
    
    // Add loading placeholder
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'thumbnail-loading';
    thumbnailItem.appendChild(loadingDiv);
    
    // Add page number
    const pageLabel = document.createElement('div');
    pageLabel.className = 'thumbnail-page-number';
    pageLabel.textContent = pageNum;
    thumbnailItem.appendChild(pageLabel);
    
    // Click handler
    thumbnailItem.addEventListener('click', () => {
      navigateToPage(pageNum);
    });
    
    thumbnailList.appendChild(thumbnailItem);
  }
  
  // Render thumbnails in batches to keep UI responsive
  const BATCH_SIZE = 5;
  for (let i = 0; i < pdfDocument.numPages; i += BATCH_SIZE) {
    const batch = [];
    for (let j = i; j < Math.min(i + BATCH_SIZE, pdfDocument.numPages); j++) {
      batch.push(renderThumbnail(j + 1, THUMBNAIL_SCALE));
    }
    await Promise.all(batch);
    // Yield to event loop
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  
  thumbnailsGenerated = true;
}

async function renderThumbnail(pageNum, scale) {
  if (thumbnailCache.has(pageNum)) return;
  
  try {
    const page = await pdfDocument.getPage(pageNum);
    const viewport = page.getViewport({ scale: scale, rotation: currentRotation });
    
    const canvas = document.createElement('canvas');
    canvas.className = 'thumbnail-canvas';
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    
    const context = canvas.getContext('2d');
    await page.render({
      canvasContext: context,
      viewport: viewport
    }).promise;
    
    // Cache the thumbnail
    thumbnailCache.set(pageNum, canvas);
    
    // Update the thumbnail item in the sidebar
    const thumbnailItem = thumbnailList.querySelector(`[data-page-number="${pageNum}"]`);
    if (thumbnailItem) {
      const loading = thumbnailItem.querySelector('.thumbnail-loading');
      if (loading) {
        loading.replaceWith(canvas);
      }
    }
    
    page.cleanup();
  } catch (error) {
    console.error(`Error rendering thumbnail ${pageNum}:`, error);
  }
}

function updateActiveThumbnail(pageNum) {
  // Remove active class from all thumbnails
  thumbnailList.querySelectorAll('.thumbnail-item').forEach(item => {
    item.classList.remove('active');
  });
  
  // Add active class to current page
  const activeThumbnail = thumbnailList.querySelector(`[data-page-number="${pageNum}"]`);
  if (activeThumbnail) {
    activeThumbnail.classList.add('active');
    
    // Scroll thumbnail into view if needed
    activeThumbnail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function navigateToPage(pageNum) {
  const pageElement = pdfCanvasWrapper.querySelector(`[data-page-number="${pageNum}"]`);
  if (pageElement) {
    pageElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
    
    // Update current page immediately for responsiveness
    const oldPageIndex = currentPageIndex;
    currentPageIndex = pageNum - 1;
    
    if (oldPageIndex !== currentPageIndex) {
      updateFocusWindow();
      updateActiveThumbnail(pageNum);
    }
  }
}

/* ==========================================
   SCROLL DETECTION & CURRENT PAGE TRACKING
   ========================================== */

function setupScrollDetection() {
  pdfContainer.addEventListener('scroll', handleScroll, { passive: true });
}

function handleScroll() {
  // Debounce scroll detection
  clearTimeout(scrollDetectionTimeout);
  scrollDetectionTimeout = setTimeout(() => {
    detectCurrentPage();
  }, SCROLL_DETECTION_DELAY);
}

function detectCurrentPage() {
  if (!pdfDocument) return;
  
  const containerRect = pdfContainer.getBoundingClientRect();
  const containerCenter = containerRect.top + containerRect.height / 2;
  
  const pages = pdfCanvasWrapper.querySelectorAll('.pdf-page');
  let closestPage = 1;
  let closestDistance = Infinity;
  
  pages.forEach(page => {
    const pageRect = page.getBoundingClientRect();
    const pageCenter = pageRect.top + pageRect.height / 2;
    const distance = Math.abs(pageCenter - containerCenter);
    
    if (distance < closestDistance) {
      closestDistance = distance;
      closestPage = parseInt(page.dataset.pageNumber);
    }
  });
  
  const newPageIndex = closestPage - 1;
  
  if (newPageIndex !== currentPageIndex) {
    currentPageIndex = newPageIndex;
    updateFocusWindow();
    updateActiveThumbnail(closestPage);
  }
}

/* ==========================================
   FOCUS-BASED RENDERING SYSTEM
   ========================================== */

function calculateFocusWindow(centerPage) {
  // Calculate which pages should be in the focus window
  // Center page + 2 before + 2 after = 5 pages max
  const totalPages = pdfDocument.numPages;
  const windowSize = 5;
  
  let start, end;
  
  // Handle edge cases
  if (totalPages <= windowSize) {
    // Small document - render all pages
    start = 1;
    end = totalPages;
  } else if (centerPage <= 2) {
    // Near start - render pages 1-5
    start = 1;
    end = windowSize;
  } else if (centerPage >= totalPages - 1) {
    // Near end - render last 5 pages
    start = totalPages - windowSize + 1;
    end = totalPages;
  } else {
    // Normal case - center the window
    start = centerPage - 2;
    end = centerPage + 2;
  }
  
  const newFocusWindow = new Set();
  for (let i = start; i <= end; i++) {
    newFocusWindow.add(i);
  }
  
  return newFocusWindow;
}

function updateFocusWindow() {
  const currentPage = currentPageIndex + 1;
  const newFocusWindow = calculateFocusWindow(currentPage);
  
  // Find pages that left the focus window (need to downgrade)
  const pagesLeaving = [...focusWindow].filter(p => !newFocusWindow.has(p));
  
  // Find pages that entered the focus window (need to upgrade)
  const pagesEntering = [...newFocusWindow].filter(p => !focusWindow.has(p));
  
  // Update focus window
  focusWindow = newFocusWindow;
  
  // Downgrade pages leaving focus (destroy high-quality render)
  pagesLeaving.forEach(pageNum => {
    downgradePageQuality(pageNum);
  });
  
  // Render pages entering focus at high quality
  pagesEntering.forEach(pageNum => {
    renderPageHighQuality(pageNum);
  });
}

function downgradePageQuality(pageNum) {
  const pageContainer = pdfCanvasWrapper.querySelector(`[data-page-number="${pageNum}"]`);
  if (!pageContainer) return;
  
  // Save annotations before destroying canvas
  const annotationCanvas = pageContainer.querySelector('.annotation-canvas');
  if (annotationCanvas) {
    savePageAnnotations(pageNum, annotationCanvas);
  }
  
  // Replace with placeholder to free memory
  const viewport = pageViewports.get(pageNum);
  if (viewport) {
    pageContainer.innerHTML = '';
    pageContainer.classList.add('pdf-page-placeholder');
    
    const loadingIndicator = document.createElement('div');
    loadingIndicator.className = 'page-loading-indicator';
    loadingIndicator.innerHTML = `<span>Page ${pageNum}</span>`;
    pageContainer.appendChild(loadingIndicator);
  }
  
  renderedPages.delete(pageNum);
}

function savePageAnnotations(pageNum, canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  
  // Check if canvas has any content
  let hasContent = false;
  for (let i = 3; i < imageData.data.length; i += 4) {
    if (imageData.data[i] > 0) {
      hasContent = true;
      break;
    }
  }
  
  if (hasContent) {
    annotationHistory.set(pageNum, {
      imageData: imageData,
      width: canvas.width,
      height: canvas.height,
      scale: currentScale
    });
  }
}

async function renderPageHighQuality(pageNum) {
  if (renderingPages.has(pageNum)) return;
  if (renderedPages.has(pageNum) && focusWindow.has(pageNum)) return;
  
  renderingPages.add(pageNum);
  
  const pageContainer = pdfCanvasWrapper.querySelector(`[data-page-number="${pageNum}"]`);
  if (!pageContainer) {
    renderingPages.delete(pageNum);
    return;
  }
  
  try {
    const page = await pdfDocument.getPage(pageNum);
    
    // Calculate scale with devicePixelRatio for crisp rendering
    const dpr = window.devicePixelRatio || 1;
    const baseScale = 1.2;
    const viewport = page.getViewport({ scale: baseScale, rotation: currentRotation });
    
    // Store viewport for later use
    pageViewports.set(pageNum, viewport);
    
    // Update container size
    pageContainer.style.width = viewport.width + 'px';
    pageContainer.style.height = viewport.height + 'px';
    
    // Create high-resolution canvas
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    
    // Canvas size = viewport size * devicePixelRatio for HiDPI support
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    
    // CSS size = viewport size (CSS will scale the canvas)
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    
    const context = canvas.getContext('2d');
    
    // Scale context to match devicePixelRatio
    context.scale(dpr, dpr);
    
    // Render at high quality
    const renderContext = {
      canvasContext: context,
      viewport: viewport
    };
    
    await page.render(renderContext).promise;
    
    // Create text layer
    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    textLayerDiv.style.width = viewport.width + 'px';
    textLayerDiv.style.height = viewport.height + 'px';
    textLayerDiv.style.pointerEvents = 'auto';
    
    const textContent = await page.getTextContent();
    pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport: viewport,
      textDivs: []
    });
    
    // Create annotation canvas (also at high resolution)
    const annotationCanvas = document.createElement('canvas');
    annotationCanvas.className = 'annotation-canvas';
    annotationCanvas.width = Math.floor(viewport.width * dpr);
    annotationCanvas.height = Math.floor(viewport.height * dpr);
    annotationCanvas.style.width = viewport.width + 'px';
    annotationCanvas.style.height = viewport.height + 'px';
    annotationCanvas.style.position = 'absolute';
    annotationCanvas.style.top = '0';
    annotationCanvas.style.left = '0';
    annotationCanvas.style.pointerEvents = currentTool ? 'auto' : 'none';
    annotationCanvas.dataset.pageNumber = pageNum;
    
    // Scale annotation canvas context for HiDPI
    // Use willReadFrequently for better performance with getImageData
    const annotationCtx = annotationCanvas.getContext('2d', { willReadFrequently: true });
    annotationCtx.scale(dpr, dpr);
    
    // Setup annotation listeners
    setupAnnotationListeners(annotationCanvas);
    
    // Clear placeholder and add content
    pageContainer.innerHTML = '';
    pageContainer.classList.remove('pdf-page-placeholder');
    pageContainer.appendChild(canvas);
    pageContainer.appendChild(textLayerDiv);
    pageContainer.appendChild(annotationCanvas);
    
    // Restore annotations if any
    restorePageAnnotations(pageNum, annotationCanvas);
    
    // Cleanup
    page.cleanup();
    
    renderedPages.add(pageNum);
    renderingPages.delete(pageNum);
    
  } catch (error) {
    console.error(`Error rendering page ${pageNum}:`, error);
    renderingPages.delete(pageNum);
    
    pageContainer.innerHTML = `<div class="page-error">Failed to load page ${pageNum}</div>`;
    pageContainer.classList.add('pdf-page-error');
  }
}

async function rerenderFocusPages() {
  // Re-render all pages in the focus window at current scale
  // Called after zoom settles
  const pagesToRender = [...focusWindow];
  
  // Save annotations from currently rendered pages before re-rendering
  pagesToRender.forEach(pageNum => {
    const pageContainer = pdfCanvasWrapper.querySelector(`[data-page-number="${pageNum}"]`);
    if (pageContainer) {
      const annotationCanvas = pageContainer.querySelector('.annotation-canvas');
      if (annotationCanvas) {
        savePageAnnotations(pageNum, annotationCanvas);
      }
    }
  });
  
  // Mark them as needing re-render
  pagesToRender.forEach(pageNum => {
    renderedPages.delete(pageNum);
  });
  
  // Render them (this will restore annotations)
  for (const pageNum of pagesToRender) {
    await renderPageHighQuality(pageNum);
  }
}

function scheduleZoomRerender() {
  // Debounce re-render after zoom
  clearTimeout(zoomRenderTimeout);
  zoomRenderTimeout = setTimeout(() => {
    rerenderFocusPages();
  }, 300);
}

/* ==========================================
   PINCH TO ZOOM
   ========================================== */

let lastMouseX = 0;
let lastMouseY = 0;

function setupPinchZoom() {
  pdfContainer.addEventListener('wheel', handleWheelZoom, { passive: false });
  pdfContainer.addEventListener('mousemove', (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  });
}

function handleWheelZoom(e) {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const delta = e.deltaY;
    const zoomFactor = delta > 0 ? 0.95 : 1.05;
    const newScale = currentScale * zoomFactor;
    if (newScale >= 0.5 && newScale <= 3.0) {
      currentScale = newScale;
      updateZoomSmooth();
    }
  }
}

/* ==========================================
   DOCK AUTO-HIDE
   ========================================== */

let lastScrollTop = 0;
let scrollTimeout = null;

function setupDockAutoHide() {
  let ticking = false;
  pdfContainer.addEventListener('scroll', () => {
    if (!ticking) {
      window.requestAnimationFrame(() => {
        handleDockScroll();
        ticking = false;
      });
      ticking = true;
    }
  });
}

function handleDockScroll() {
  const scrollTop = pdfContainer.scrollTop;
  const scrollDelta = scrollTop - lastScrollTop;
  const scrollVelocity = Math.abs(scrollDelta);
  
  clearTimeout(scrollTimeout);
  
  if (scrollTop > lastScrollTop && scrollTop > 100 && scrollVelocity > 5) {
    annotationDock.classList.add('hidden');
  } else if (scrollTop < lastScrollTop) {
    annotationDock.classList.remove('hidden');
  }
  
  lastScrollTop = scrollTop;
  
  scrollTimeout = setTimeout(() => {
    annotationDock.classList.remove('hidden');
  }, 1000);
}

/* ==========================================
   LOAD PDF
   ========================================== */

async function loadPDFFromURL() {
  const urlParams = new URLSearchParams(window.location.search);
  const pdfUrl = urlParams.get('url');
  const dataUrl = urlParams.get('dataUrl');
  const pdfName = urlParams.get('name');
  
  if (!pdfUrl && !dataUrl) {
    showError('No PDF URL specified');
    return;
  }
  
  currentPDFUrl = pdfUrl || dataUrl;
  currentPDFName = pdfName || (pdfUrl ? extractFilename(pdfUrl) : 'document.pdf');
  updatePDFName(currentPDFName);
  
  try {
    pdfLoading.classList.remove('hidden');
    pdfError.classList.add('hidden');
    pdfCanvasWrapper.classList.add('hidden');
    
    // Cleanup previous document
    if (pdfDocument) {
      pdfDocument.destroy();
      pdfDocument = null;
    }
    
    // Reset state
    renderedPages.clear();
    renderingPages.clear();
    pageViewports.clear();
    focusWindow.clear();
    thumbnailCache.clear();
    thumbnailsGenerated = false;
    currentPageIndex = 0;
    
    // Load PDF - handle different sources
    let loadingTask;
    
    if (dataUrl) {
      // For data URLs (from popup file selection)
      loadingTask = pdfjsLib.getDocument({
        url: dataUrl,
        disableAutoFetch: false,
        disableStream: false
      });
    } else if (pdfUrl.startsWith('file://')) {
      // For file:// URLs, we need to fetch via XMLHttpRequest
      const pdfData = await fetchFileURL(pdfUrl);
      loadingTask = pdfjsLib.getDocument({
        data: pdfData,
        disableAutoFetch: false,
        disableStream: false
      });
    } else {
      // For http/https URLs, load directly
      loadingTask = pdfjsLib.getDocument({
        url: pdfUrl,
        disableAutoFetch: false,
        disableStream: false
      });
    }
    
    pdfDocument = await loadingTask.promise;
    console.log(`PDF loaded: ${pdfDocument.numPages} pages`);
    
    // Create page placeholders
    await createPagePlaceholders();
    
    // Calculate initial focus window and render focus pages
    focusWindow = calculateFocusWindow(1);
    
    // Render focus pages at high quality
    for (const pageNum of focusWindow) {
      await renderPageHighQuality(pageNum);
    }
    
    // Initialize zoom transform
    updateZoom();
    
    // Generate thumbnails (async, non-blocking)
    generateThumbnails();
    
    // Index PDF for search
    indexPDFForSearch();
    
    pdfLoading.classList.add('hidden');
    pdfCanvasWrapper.classList.remove('hidden');
    
    // Load any saved annotations for this PDF
    await loadSavedAnnotations();
    
    // Add to recent PDFs
    chrome.runtime.sendMessage({
      type: 'ADD_RECENT_PDF',
      payload: {
        url: pdfUrl,
        name: currentPDFName,
        pageCount: pdfDocument.numPages
      }
    });
    
  } catch (error) {
    console.error('Error loading PDF:', error);
    showError('Failed to load PDF: ' + error.message);
  }
}

/**
 * Fetch a file:// URL using XMLHttpRequest
 * Chrome extensions can access file:// URLs if the user has granted permission
 */
function fetchFileURL(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    
    xhr.onload = function() {
      if (xhr.status === 200 || xhr.status === 0) {  // status 0 for file:// URLs
        resolve(new Uint8Array(xhr.response));
      } else {
        reject(new Error(`Failed to load file: ${xhr.status}`));
      }
    };
    
    xhr.onerror = function() {
      reject(new Error('Failed to load local file. To open local PDFs:\n1. Go to chrome://extensions\n2. Find "Kiosk PDF Reader"\n3. Click "Details"\n4. Enable "Allow access to file URLs"'));
    };
    
    xhr.send();
  });
}

function extractFilename(url) {
  try {
    const pathname = new URL(url).pathname;
    return decodeURIComponent(pathname.split('/').pop() || 'document.pdf');
  } catch {
    return 'document.pdf';
  }
}

/* ==========================================
   RENDER PDF PAGES
   ========================================== */

async function renderAllPages() {
  const scrollPos = pdfContainer.scrollTop;
  const scrollPercentage = pdfContainer.scrollHeight > 0 ? scrollPos / pdfContainer.scrollHeight : 0;
  
  pdfCanvasWrapper.innerHTML = '';
  renderedPages.clear();
  renderingPages.clear();
  pageViewports.clear();
  
  // Create placeholders for all pages (fast, no rendering)
  await createPagePlaceholders();
  
  // Recalculate focus window and render
  focusWindow = calculateFocusWindow(currentPageIndex + 1);
  
  for (const pageNum of focusWindow) {
    await renderPageHighQuality(pageNum);
  }
  
  baseContentHeight = pdfCanvasWrapper.scrollHeight;
  const scaleValue = currentScale / 1.2;
  pdfCanvasWrapper.style.height = `${baseContentHeight * scaleValue}px`;
  
  requestAnimationFrame(() => {
    pdfContainer.scrollTop = pdfContainer.scrollHeight * scrollPercentage;
  });
}

async function createPagePlaceholders() {
  const firstPage = await pdfDocument.getPage(1);
  const baseScale = 1.2;
  const defaultViewport = firstPage.getViewport({ scale: baseScale, rotation: currentRotation });
  
  // Store default viewport
  pageViewports.set(0, defaultViewport);
  
  for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
    const pageContainer = document.createElement('div');
    pageContainer.className = 'pdf-page pdf-page-placeholder';
    pageContainer.dataset.pageNumber = pageNum;
    pageContainer.style.width = defaultViewport.width + 'px';
    pageContainer.style.height = defaultViewport.height + 'px';
    
    const loadingIndicator = document.createElement('div');
    loadingIndicator.className = 'page-loading-indicator';
    loadingIndicator.innerHTML = `<span>Page ${pageNum}</span>`;
    pageContainer.appendChild(loadingIndicator);
    
    pdfCanvasWrapper.appendChild(pageContainer);
  }
  
  baseContentHeight = pdfCanvasWrapper.scrollHeight;
  
  firstPage.cleanup();
}

function restorePageAnnotations(pageNum, canvas) {
  const savedData = annotationHistory.get(pageNum);
  if (savedData && savedData.imageData) {
    const ctx = canvas.getContext('2d');
    
    // Check if dimensions match
    if (savedData.width === canvas.width && savedData.height === canvas.height) {
      // Same dimensions, can use putImageData directly
      ctx.putImageData(savedData.imageData, 0, 0);
    } else {
      // Different dimensions, need to scale
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = savedData.width;
      tempCanvas.height = savedData.height;
      tempCanvas.getContext('2d').putImageData(savedData.imageData, 0, 0);
      
      // Draw scaled to fit new canvas size
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset any existing transforms
      ctx.drawImage(tempCanvas, 0, 0, savedData.width, savedData.height, 
                    0, 0, canvas.width, canvas.height);
      ctx.restore();
    }
  }
}

/* ==========================================
   ZOOM CONTROLS
   ========================================== */

function zoomIn() {
  currentScale = Math.min(currentScale + 0.25, 3.0);
  updateZoom();
}

function zoomOut() {
  currentScale = Math.max(currentScale - 0.25, 0.5);
  updateZoom();
}

function fitToWidth() {
  if (pdfDocument) {
    pdfDocument.getPage(1).then(page => {
      const viewport = page.getViewport({ scale: 1.0 });
      const containerWidth = pdfContainer.clientWidth - 40;
      currentScale = containerWidth / viewport.width;
      previousScale = currentScale;
      updateZoom();
    });
  }
}

function fitToPage() {
  const containerHeight = pdfContainer.clientHeight - 80;
  if (pdfDocument) {
    pdfDocument.getPage(1).then(page => {
      const viewport = page.getViewport({ scale: 1.0 });
      currentScale = Math.min(
        (pdfContainer.clientWidth - 80) / viewport.width,
        containerHeight / viewport.height
      );
      updateZoom();
    });
  }
}

function rotatePDF() {
  currentRotation = (currentRotation + 90) % 360;
  saveAllAnnotations();
  
  // Clear and regenerate thumbnails for new rotation
  thumbnailCache.clear();
  thumbnailsGenerated = false;
  
  renderAllPages();
  generateThumbnails();
}

function updateZoom() {
  zoomLevel.textContent = Math.round(currentScale * 100) + '%';
  const scaleValue = currentScale / 1.2;
  pdfCanvasWrapper.style.transform = `scale(${scaleValue})`;
  pdfCanvasWrapper.style.transformOrigin = 'top center';
  if (baseContentHeight > 0) {
    pdfCanvasWrapper.style.height = `${baseContentHeight * scaleValue}px`;
  }
  scheduleZoomRerender();
}

function updateZoomSmooth() {
  zoomLevel.textContent = Math.round(currentScale * 100) + '%';
  
  const scrollTop = pdfContainer.scrollTop;
  const scrollLeft = pdfContainer.scrollLeft;
  const containerRect = pdfContainer.getBoundingClientRect();
  const cursorX = lastMouseX - containerRect.left;
  const cursorY = lastMouseY - containerRect.top;
  const docX = scrollLeft + cursorX;
  const docY = scrollTop + cursorY;
  
  const scaleValue = currentScale / 1.2;
  pdfCanvasWrapper.style.transform = `scale(${scaleValue})`;
  pdfCanvasWrapper.style.transformOrigin = 'top center';
  pdfCanvasWrapper.style.transition = 'transform 0.15s ease-out';
  if (baseContentHeight > 0) {
    pdfCanvasWrapper.style.height = `${baseContentHeight * scaleValue}px`;
  }
  
  const scaleDelta = currentScale / previousScale;
  const newScrollLeft = docX * scaleDelta - cursorX;
  const newScrollTop = docY * scaleDelta - cursorY;
  
  setTimeout(() => {
    pdfContainer.scrollLeft = newScrollLeft;
    pdfContainer.scrollTop = newScrollTop;
    pdfCanvasWrapper.style.transition = 'none';
    previousScale = currentScale;
  }, 150);
  
  scheduleZoomRerender();
}

/* ==========================================
   SEARCH
   ========================================== */

let searchTimeout = null;
let pdfTextContent = [];

function handleSearchInput(e) {
  const query = e.target.value.trim();
  clearTimeout(searchTimeout);
  
  if (query.length < 2) {
    searchResults.classList.add('hidden');
    return;
  }
  
  searchTimeout = setTimeout(() => performSearch(query), 300);
}

async function indexPDFForSearch() {
  if (!pdfDocument) return;
  
  pdfTextContent = [];
  
  for (let i = 1; i <= pdfDocument.numPages; i++) {
    try {
      const page = await pdfDocument.getPage(i);
      const textContent = await page.getTextContent();
      const text = textContent.items.map(item => item.str).join(' ');
      pdfTextContent.push({ pageNumber: i, text });
      page.cleanup();
    } catch (e) {
      console.error(`Error indexing page ${i}:`, e);
    }
  }
}

function performSearch(query) {
  const queryLower = query.toLowerCase();
  searchMatches = [];
  
  pdfTextContent.forEach(page => {
    const textLower = page.text.toLowerCase();
    let idx = textLower.indexOf(queryLower);
    
    while (idx !== -1) {
      const start = Math.max(0, idx - 30);
      const end = Math.min(page.text.length, idx + query.length + 30);
      const snippet = (start > 0 ? '...' : '') + page.text.slice(start, end) + (end < page.text.length ? '...' : '');
      
      searchMatches.push({
        pageNumber: page.pageNumber,
        snippet,
        query
      });
      
      idx = textLower.indexOf(queryLower, idx + 1);
    }
  });
  
  displaySearchResults(searchMatches);
}

function displaySearchResults(matches) {
  clearSearchHighlights();
  
  if (matches.length === 0) {
    searchResults.innerHTML = '<div class="search-no-results">No results found</div>';
    searchResults.classList.remove('hidden');
    return;
  }
  
  searchResults.innerHTML = matches.map((match, idx) => `
    <div class="search-result-item" data-page="${match.pageNumber}" data-index="${idx}">
      <div class="search-result-page">Page ${match.pageNumber}</div>
      <div class="search-result-snippet">${highlightMatch(match.snippet, match.query)}</div>
    </div>
  `).join('');
  
  searchResults.classList.remove('hidden');
  
  searchResults.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('click', () => {
      const matchIndex = parseInt(item.dataset.index);
      jumpToMatch(matchIndex);
      searchResults.classList.add('hidden');
    });
  });
}

function highlightMatch(text, query) {
  const regex = new RegExp(`(${escapeRegex(query)})`, 'gi');
  return escapeHtml(text).replace(regex, '<mark>$1</mark>');
}

function jumpToMatch(matchIndex) {
  const match = searchMatches[matchIndex];
  if (!match) return;
  
  const pageElement = pdfCanvasWrapper.querySelector(`[data-page-number="${match.pageNumber}"]`);
  if (pageElement) {
    pageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => applyHighlightToPage(match.pageNumber, match.query), 250);
  }
}

function applyHighlightToPage(pageNumber, query) {
  const pageElement = pdfCanvasWrapper.querySelector(`[data-page-number="${pageNumber}"]`);
  if (!pageElement) return;
  
  const textLayer = pageElement.querySelector('.textLayer');
  if (!textLayer) return;
  
  clearSearchHighlights();
  
  const spans = Array.from(textLayer.querySelectorAll('span'));
  if (!spans.length) return;
  
  let combined = '';
  const nodes = [];
  
  spans.forEach(span => {
    const node = span.firstChild;
    const len = node ? node.textContent.length : 0;
    nodes.push({ node, start: combined.length, end: combined.length + len });
    combined += node ? node.textContent : '';
  });
  
  const lowerCombined = combined.toLowerCase();
  const queryLower = query.toLowerCase();
  const matchIndex = lowerCombined.indexOf(queryLower);
  
  if (matchIndex === -1) return;
  
  const matchEnd = matchIndex + query.length;
  const locateOffset = (offset) => nodes.find(n => offset >= n.start && offset <= n.end && n.node);
  
  const startNode = locateOffset(matchIndex);
  const endNode = locateOffset(matchEnd);
  
  if (!startNode || !endNode) return;
  
  try {
    const range = document.createRange();
    range.setStart(startNode.node, matchIndex - startNode.start);
    range.setEnd(endNode.node, Math.min(matchEnd - endNode.start, endNode.node.textContent.length));
    
    const rects = Array.from(range.getClientRects());
    const layerRect = textLayer.getBoundingClientRect();
    
    rects.forEach(rect => {
      const overlay = document.createElement('div');
      overlay.className = 'search-highlight';
      overlay.style.left = `${rect.left - layerRect.left}px`;
      overlay.style.top = `${rect.top - layerRect.top}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
      textLayer.appendChild(overlay);
    });
    
    range.detach();
  } catch (e) {
    console.error('Error highlighting:', e);
  }
  
  if (activeSearchTimeout) clearTimeout(activeSearchTimeout);
  activeSearchTimeout = setTimeout(clearSearchHighlights, 1700);
}

function clearSearchHighlights() {
  pdfCanvasWrapper.querySelectorAll('.search-highlight').forEach(h => h.remove());
  if (activeSearchTimeout) {
    clearTimeout(activeSearchTimeout);
    activeSearchTimeout = null;
  }
}

/* ==========================================
   ANNOTATION TOOLS
   ========================================== */

let isDrawing = false;
let drawingStartX = 0;
let drawingStartY = 0;

function captureCanvasState(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return {
    data: ctx.getImageData(0, 0, canvas.width, canvas.height),
    width: canvas.width,
    height: canvas.height
  };
}

function restoreCanvasState(canvas, snapshot) {
  if (!snapshot) return;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (snapshot.width !== canvas.width || snapshot.height !== canvas.height) {
    canvas.width = snapshot.width;
    canvas.height = snapshot.height;
  }
  ctx.putImageData(snapshot.data, 0, 0);
}

function pushUndoAction(action) {
  if (!action || !action.before || !action.after) return;
  redoStack.length = 0;
  undoStack.push(action);
}

function getAnnotationCanvasByPage(pageNumber) {
  return pdfCanvasWrapper.querySelector(`.pdf-page[data-page-number="${pageNumber}"] .annotation-canvas`);
}

function saveAllAnnotations() {
  document.querySelectorAll('.annotation-canvas').forEach(canvas => {
    const pageNum = parseInt(canvas.dataset.pageNumber);
    const ctx = canvas.getContext('2d');
    annotationHistory.set(pageNum, {
      imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
      width: canvas.width,
      height: canvas.height,
      scale: currentScale
    });
  });
}

function setupAnnotationListeners(canvas) {
  canvas.addEventListener('mousedown', handleAnnotationStart);
  canvas.addEventListener('mousemove', handleAnnotationMove);
  canvas.addEventListener('mouseup', handleAnnotationEnd);
  canvas.addEventListener('mouseleave', handleAnnotationEnd);
  canvas.tempImageData = null;
}

function handleAnnotationStart(e) {
  if (!currentTool) return;
  
  isDrawing = true;
  const rect = e.target.getBoundingClientRect();
  const scaleValue = currentScale / 1.2;
  drawingStartX = (e.clientX - rect.left) / scaleValue;
  drawingStartY = (e.clientY - rect.top) / scaleValue;
  
  const ctx = e.target.getContext('2d');
  ctx.strokeStyle = currentColor;
  ctx.fillStyle = currentColor;
  ctx.lineWidth = currentThickness;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  
  activeAction = {
    pageNumber: parseInt(e.target.dataset.pageNumber),
    before: captureCanvasState(e.target)
  };
  
  if (currentTool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = currentThickness * 2;
  }
  
  if (['rectangle', 'circle', 'arrow'].includes(currentTool)) {
    e.target.tempImageData = ctx.getImageData(0, 0, e.target.width, e.target.height);
  }
  
  if (currentTool === 'pen' || currentTool === 'eraser') {
    ctx.beginPath();
    ctx.moveTo(drawingStartX, drawingStartY);
  }
}

function handleAnnotationMove(e) {
  if (!isDrawing || !currentTool) return;
  
  const rect = e.target.getBoundingClientRect();
  const scaleValue = currentScale / 1.2;
  const x = (e.clientX - rect.left) / scaleValue;
  const y = (e.clientY - rect.top) / scaleValue;
  const ctx = e.target.getContext('2d');
  
  if (currentTool === 'pen' || currentTool === 'eraser') {
    ctx.lineTo(x, y);
    ctx.stroke();
  } else if (currentTool === 'highlight') {
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = currentColor;
    const height = Math.abs(y - drawingStartY) || 20;
    ctx.fillRect(drawingStartX, Math.min(drawingStartY, y), x - drawingStartX, height);
    ctx.globalAlpha = 1.0;
  } else if (['rectangle', 'circle', 'arrow'].includes(currentTool)) {
    if (e.target.tempImageData) {
      ctx.putImageData(e.target.tempImageData, 0, 0);
    }
    
    ctx.strokeStyle = currentColor;
    ctx.lineWidth = currentThickness;
    
    if (currentTool === 'rectangle') {
      ctx.strokeRect(drawingStartX, drawingStartY, x - drawingStartX, y - drawingStartY);
    } else if (currentTool === 'circle') {
      const radius = Math.sqrt(Math.pow(x - drawingStartX, 2) + Math.pow(y - drawingStartY, 2));
      ctx.beginPath();
      ctx.arc(drawingStartX, drawingStartY, radius, 0, 2 * Math.PI);
      ctx.stroke();
    } else if (currentTool === 'arrow') {
      drawArrow(ctx, drawingStartX, drawingStartY, x, y);
    }
  }
}

function handleAnnotationEnd(e) {
  if (!isDrawing || !currentTool) return;
  
  const rect = e.target.getBoundingClientRect();
  const scaleValue = currentScale / 1.2;
  const x = (e.clientX - rect.left) / scaleValue;
  const y = (e.clientY - rect.top) / scaleValue;
  const ctx = e.target.getContext('2d');
  
  if (e.target.tempImageData && ['rectangle', 'circle', 'arrow'].includes(currentTool)) {
    ctx.putImageData(e.target.tempImageData, 0, 0);
  }
  
  ctx.strokeStyle = currentColor;
  ctx.fillStyle = currentColor;
  ctx.lineWidth = currentThickness;
  
  switch (currentTool) {
    case 'rectangle':
      ctx.strokeRect(drawingStartX, drawingStartY, x - drawingStartX, y - drawingStartY);
      break;
    case 'circle':
      const radius = Math.sqrt(Math.pow(x - drawingStartX, 2) + Math.pow(y - drawingStartY, 2));
      ctx.beginPath();
      ctx.arc(drawingStartX, drawingStartY, radius, 0, 2 * Math.PI);
      ctx.stroke();
      break;
    case 'arrow':
      drawArrow(ctx, drawingStartX, drawingStartY, x, y);
      break;
    case 'text':
      const text = prompt('Enter text:');
      if (text) {
        ctx.font = `${currentThickness * 5}px Arial`;
        ctx.fillText(text, drawingStartX, drawingStartY);
      }
      break;
  }
  
  if (currentTool === 'eraser') {
    ctx.globalCompositeOperation = 'source-over';
  }
  
  if (activeAction) {
    activeAction.after = captureCanvasState(e.target);
    pushUndoAction(activeAction);
    activeAction = null;
  }
  
  e.target.tempImageData = null;
  isDrawing = false;
}

function drawArrow(ctx, fromX, fromY, toX, toY) {
  const headLength = 15;
  const angle = Math.atan2(toY - fromY, toX - fromX);
  
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(toX, toY);
  ctx.stroke();
  
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - headLength * Math.cos(angle - Math.PI / 6), toY - headLength * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - headLength * Math.cos(angle + Math.PI / 6), toY - headLength * Math.sin(angle + Math.PI / 6));
  ctx.stroke();
}

function handleToolSelect(tool) {
  currentTool = currentTool === tool ? null : tool;
  
  document.querySelectorAll('.annotation-tool').forEach(t => t.classList.remove('active'));
  
  if (currentTool) {
    const toolElement = document.querySelector(`[data-tool="${tool}"]`);
    if (toolElement) toolElement.classList.add('active');
    
    const isTextTool = ['highlight', 'underline', 'strikethrough'].includes(currentTool);
    
    document.querySelectorAll('.annotation-canvas').forEach(canvas => {
      canvas.style.cursor = isTextTool ? 'text' : 'crosshair';
      canvas.style.pointerEvents = isTextTool ? 'none' : 'auto';
    });
    
    document.querySelectorAll('.textLayer').forEach(layer => {
      layer.style.pointerEvents = isTextTool ? 'auto' : 'none';
    });
  } else {
    document.querySelectorAll('.annotation-canvas').forEach(canvas => {
      canvas.style.cursor = 'default';
      canvas.style.pointerEvents = 'none';
    });
    document.querySelectorAll('.textLayer').forEach(layer => {
      layer.style.pointerEvents = 'auto';
    });
  }
}

function handleKeyShortcuts(e) {
  if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
  
  const isMeta = e.metaKey || e.ctrlKey;
  if (!isMeta) return;
  
  const key = e.key.toLowerCase();
  
  if (key === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if ((key === 'z' && e.shiftKey) || key === 'y') {
    e.preventDefault();
    redo();
  }
}

function undo() {
  const action = undoStack.pop();
  if (!action) return;
  
  const canvas = getAnnotationCanvasByPage(action.pageNumber);
  if (!canvas) return;
  
  restoreCanvasState(canvas, action.before);
  redoStack.push(action);
}

function redo() {
  const action = redoStack.pop();
  if (!action) return;
  
  const canvas = getAnnotationCanvasByPage(action.pageNumber);
  if (!canvas) return;
  
  restoreCanvasState(canvas, action.after);
  undoStack.push(action);
}

/* ==========================================
   TEXT SELECTION ANNOTATION
   ========================================== */

function handleTextSelection(e) {
  const selection = window.getSelection();
  const selectedText = selection.toString().trim();
  
  if (!selectedText || !currentTool) return;
  if (!['highlight', 'underline', 'strikethrough'].includes(currentTool)) return;
  
  try {
    const range = selection.getRangeAt(0);
    const rects = range.getClientRects();
    
    if (rects.length === 0) return;
    
    let pageContainer = range.startContainer;
    while (pageContainer && !pageContainer.classList?.contains('pdf-page')) {
      pageContainer = pageContainer.parentElement;
    }
    
    if (!pageContainer) return;
    
    const annotationCanvas = pageContainer.querySelector('.annotation-canvas');
    if (!annotationCanvas) return;
    
    const ctx = annotationCanvas.getContext('2d');
    const pageNumber = parseInt(annotationCanvas.dataset.pageNumber);
    const before = captureCanvasState(annotationCanvas);
    
    const scaleValue = currentScale / 1.2;
    const canvasRect = annotationCanvas.getBoundingClientRect();
    
    ctx.strokeStyle = currentColor;
    ctx.fillStyle = currentColor;
    ctx.lineWidth = currentThickness;
    
    Array.from(rects).forEach(rect => {
      const x = (rect.left - canvasRect.left) / scaleValue;
      const y = (rect.top - canvasRect.top) / scaleValue;
      const width = rect.width / scaleValue;
      const height = rect.height / scaleValue;
      
      if (currentTool === 'highlight') {
        ctx.globalAlpha = 0.35;
        ctx.fillRect(x, y, width, height);
        ctx.globalAlpha = 1.0;
      } else if (currentTool === 'underline') {
        ctx.beginPath();
        ctx.moveTo(x, y + height - 2);
        ctx.lineTo(x + width, y + height - 2);
        ctx.stroke();
      } else if (currentTool === 'strikethrough') {
        ctx.beginPath();
        ctx.moveTo(x, y + height / 2);
        ctx.lineTo(x + width, y + height / 2);
        ctx.stroke();
      }
    });
    
    pushUndoAction({ pageNumber, before, after: captureCanvasState(annotationCanvas) });
    selection.removeAllRanges();
    
  } catch (error) {
    console.error('Error applying text annotation:', error);
  }
}

/* ==========================================
   SAVE & LOAD ANNOTATIONS (Persistent Storage)
   ========================================== */

/**
 * Generate a unique key for storing annotations based on PDF URL/name
 */
function getPDFStorageKey() {
  // Use a hash of the URL or filename for the storage key
  const identifier = currentPDFUrl || currentPDFName;
  let hash = 0;
  for (let i = 0; i < identifier.length; i++) {
    const char = identifier.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `kiosk_annotations_${Math.abs(hash)}`;
}

/**
 * Save PDF with annotations to Chrome storage
 */
async function savePDFWithAnnotations() {
  try {
    const hasAnnotations = checkForAnnotations();
    
    if (!hasAnnotations) {
      showSaveNotification('No annotations to save', 'info');
      return;
    }
    
    // Collect all annotation canvas data
    const annotationsData = {};
    
    // First, get annotations from currently rendered canvases
    const canvases = document.querySelectorAll('.annotation-canvas');
    canvases.forEach(canvas => {
      const pageNum = canvas.dataset.pageNumber;
      // Check if canvas has any content
      const ctx = canvas.getContext('2d');
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let hasContent = false;
      for (let i = 3; i < imageData.data.length; i += 4) {
        if (imageData.data[i] > 0) {
          hasContent = true;
          break;
        }
      }
      if (hasContent) {
        annotationsData[pageNum] = canvas.toDataURL('image/png');
      }
    });
    
    // Also include annotations from history (pages that were scrolled away)
    for (const [pageNum, data] of annotationHistory) {
      if (data && data.imageData && !annotationsData[pageNum]) {
        // Convert ImageData to data URL
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = data.imageData.width;
        tempCanvas.height = data.imageData.height;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.putImageData(data.imageData, 0, 0);
        annotationsData[pageNum] = tempCanvas.toDataURL('image/png');
      }
    }
    
    if (Object.keys(annotationsData).length === 0) {
      showSaveNotification('No annotations to save', 'info');
      return;
    }
    
    const storageKey = getPDFStorageKey();
    const saveData = {
      pdfUrl: currentPDFUrl,
      pdfName: currentPDFName,
      annotations: annotationsData,
      savedAt: Date.now(),
      pageCount: pdfDocument.numPages
    };
    
    await chrome.storage.local.set({ [storageKey]: saveData });
    
    showSaveNotification('Annotations saved!', 'success');
    console.log(`Saved annotations for ${currentPDFName} with key ${storageKey}`);
    
  } catch (error) {
    console.error('Error saving annotations:', error);
    showSaveNotification('Failed to save: ' + error.message, 'error');
  }
}

/**
 * Load saved annotations from Chrome storage
 */
async function loadSavedAnnotations() {
  try {
    const storageKey = getPDFStorageKey();
    const result = await chrome.storage.local.get(storageKey);
    const saveData = result[storageKey];
    
    if (!saveData || !saveData.annotations) {
      console.log('No saved annotations found for this PDF');
      return;
    }
    
    console.log(`Loading saved annotations for ${currentPDFName}`);
    
    // Wait a bit for pages to render
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Apply annotations to each page
    for (const [pageNum, dataUrl] of Object.entries(saveData.annotations)) {
      const pageContainer = pdfCanvasWrapper.querySelector(`[data-page-number="${pageNum}"]`);
      if (!pageContainer) continue;
      
      const annotationCanvas = pageContainer.querySelector('.annotation-canvas');
      if (!annotationCanvas) continue;
      
      // Load the saved annotation image
      await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const ctx = annotationCanvas.getContext('2d');
          // Reset transform and draw scaled to current canvas size
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(img, 0, 0, img.width, img.height,
                        0, 0, annotationCanvas.width, annotationCanvas.height);
          ctx.restore();
          resolve();
        };
        img.onerror = resolve;
        img.src = dataUrl;
      });
    }
    
    showSaveNotification('Annotations restored', 'info');
    
  } catch (error) {
    console.error('Error loading saved annotations:', error);
  }
}

/**
 * Show a temporary notification for save operations
 */
function showSaveNotification(message, type = 'info') {
  // Remove existing notification if any
  const existing = document.querySelector('.save-notification');
  if (existing) existing.remove();
  
  const notification = document.createElement('div');
  notification.className = `save-notification save-notification-${type}`;
  notification.textContent = message;
  
  document.body.appendChild(notification);
  
  // Animate in
  requestAnimationFrame(() => {
    notification.classList.add('show');
  });
  
  // Remove after delay
  setTimeout(() => {
    notification.classList.remove('show');
    setTimeout(() => notification.remove(), 300);
  }, 2500);
}

/* ==========================================
   PDF DOWNLOAD
   ========================================== */

async function downloadPDF() {
  try {
    const hasAnnotations = checkForAnnotations();
    
    if (hasAnnotations) {
      await exportPDFWithAnnotations();
    } else {
      downloadOriginalPDF();
    }
  } catch (error) {
    console.error('Error downloading PDF:', error);
    alert('Failed to download PDF: ' + error.message);
  }
}

function checkForAnnotations() {
  // Check annotation history first (for saved but not currently rendered pages)
  if (annotationHistory.size > 0) {
    for (const [pageNum, data] of annotationHistory) {
      if (data && data.imageData) return true;
    }
  }
  
  // Check currently rendered annotation canvases
  const canvases = document.querySelectorAll('.annotation-canvas');
  for (const canvas of canvases) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < imageData.data.length; i += 4) {
      if (imageData.data[i] > 0) return true;
    }
  }
  return false;
}

async function downloadOriginalPDF() {
  let blob;
  
  if (currentPDFUrl.startsWith('file://')) {
    // For file:// URLs, use XMLHttpRequest
    const pdfData = await fetchFileURL(currentPDFUrl);
    blob = new Blob([pdfData], { type: 'application/pdf' });
  } else {
    // For http/https URLs, use fetch
    const response = await fetch(currentPDFUrl);
    blob = await response.blob();
  }
  
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = currentPDFName;
  link.click();
  
  URL.revokeObjectURL(url);
}

async function exportPDFWithAnnotations() {
  const pdf = await PDFLib.PDFDocument.create();
  
  for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
    const pageContainer = pdfCanvasWrapper.querySelector(`[data-page-number="${pageNum}"]`);
    if (!pageContainer) continue;
    
    const pdfCanvas = pageContainer.querySelector('canvas:not(.annotation-canvas)');
    const annotationCanvas = pageContainer.querySelector('.annotation-canvas');
    
    if (!pdfCanvas) continue;
    
    const mergedCanvas = document.createElement('canvas');
    mergedCanvas.width = pdfCanvas.width;
    mergedCanvas.height = pdfCanvas.height;
    const ctx = mergedCanvas.getContext('2d');
    
    ctx.drawImage(pdfCanvas, 0, 0);
    if (annotationCanvas) ctx.drawImage(annotationCanvas, 0, 0);
    
    const imgData = mergedCanvas.toDataURL('image/png');
    const pngImage = await pdf.embedPng(imgData);
    
    const page = pdf.addPage([pdfCanvas.width, pdfCanvas.height]);
    page.drawImage(pngImage, { x: 0, y: 0, width: pdfCanvas.width, height: pdfCanvas.height });
  }
  
  const pdfBytes = await pdf.save();
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = currentPDFName.replace('.pdf', '_annotated.pdf');
  link.click();
  
  URL.revokeObjectURL(url);
}

/* ==========================================
   UI UPDATES
   ========================================== */

function updatePDFName(name) {
  const maxLength = 30;
  if (name.length > maxLength) {
    const extension = name.substring(name.lastIndexOf('.'));
    const basename = name.substring(0, name.lastIndexOf('.'));
    pdfNameEl.textContent = basename.substring(0, maxLength - extension.length - 3) + '...' + extension;
    pdfNameEl.title = name;
  } else {
    pdfNameEl.textContent = name;
  }
}

function showError(message) {
  pdfLoading.classList.add('hidden');
  pdfCanvasWrapper.classList.add('hidden');
  pdfError.classList.remove('hidden');
  const errorDiv = pdfError.querySelector('div:nth-of-type(2)');
  if (errorDiv) {
    // Handle multi-line messages
    errorDiv.innerHTML = message.replace(/\n/g, '<br>');
    errorDiv.style.textAlign = 'left';
    errorDiv.style.maxWidth = '400px';
  }
}

/* ==========================================
   UTILITIES
   ========================================== */

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ==========================================
   START THE VIEWER
   ========================================== */

init();
