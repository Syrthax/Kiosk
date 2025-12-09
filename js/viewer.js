/* ==========================================
   KIOSK – VIEWER PAGE LOGIC
   Handles PDF rendering, navigation, search, and annotations
   ========================================== */

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Global state
let pdfDocument = null;
let currentScale = 1.2;
let previousScale = 1.2;
let currentRotation = 0;
let currentPDFName = '';
let searchWorker = null;
let currentTool = null;
let currentColor = '#ffc107';
let currentThickness = 3;

// DOM Elements
const pdfNameEl = document.getElementById('pdf-name');
const searchBar = document.getElementById('search-bar');
const searchResults = document.getElementById('search-results');
const pdfLoading = document.getElementById('pdf-loading');
const pdfCanvasWrapper = document.getElementById('pdf-canvas-wrapper');
const pdfError = document.getElementById('pdf-error');
const pdfContainer = document.getElementById('pdf-container');
const zoomLevel = document.getElementById('zoom-level');

/* ==========================================
   INITIALIZATION
   ========================================== */

function init() {
  setupEventListeners();
  setupSearchWorker();
  setupPinchZoom();
  setupDockAutoHide();
  setupCloseWarning();
  loadPDFFromURL();
}

/* ==========================================
   CLOSE WARNING
   ========================================== */

function setupCloseWarning() {
  window.addEventListener('beforeunload', (e) => {
    // Only show warning if PDF is loaded
    if (pdfDocument) {
      e.preventDefault();
      e.returnValue = 'Download recommended! Your annotations will not be saved unless you download the PDF.';
      return e.returnValue;
    }
  });
}

/* ==========================================
   EVENT LISTENERS
   ========================================== */

function setupEventListeners() {
  // Home button
  document.getElementById('home-button').addEventListener('click', () => {
    window.location.href = 'index.html';
  });
  
  // Zoom controls
  document.getElementById('zoom-in').addEventListener('click', () => zoomIn());
  document.getElementById('zoom-out').addEventListener('click', () => zoomOut());
  document.getElementById('fit-width').addEventListener('click', () => fitToWidth());
  document.getElementById('fit-page').addEventListener('click', () => fitToPage());
  document.getElementById('rotate').addEventListener('click', () => rotatePDF());
  
  // Download
  document.getElementById('download').addEventListener('click', () => downloadPDF());
  
  // Search
  searchBar.addEventListener('input', handleSearchInput);
  searchBar.addEventListener('focus', () => {
    if (searchBar.value.trim()) {
      searchResults.classList.remove('hidden');
    }
  });
  
  // Close search results when clicking outside
  document.addEventListener('click', (e) => {
    if (!searchResults.contains(e.target) && e.target !== searchBar) {
      searchResults.classList.add('hidden');
    }
  });
  
  // Annotation tools
  document.querySelectorAll('.annotation-tool').forEach(tool => {
    tool.addEventListener('click', () => handleToolSelect(tool.dataset.tool));
  });
  
  // Selection-based annotation
  document.addEventListener('mouseup', handleTextSelection);
  
  // Color picker
  const colorPickerButton = document.getElementById('color-picker-button');
  const colorPicker = document.getElementById('color-picker');
  colorPickerButton.addEventListener('click', (e) => {
    e.stopPropagation();
    colorPicker.classList.toggle('hidden');
  });
  
  document.querySelectorAll('.color-option').forEach(option => {
    option.addEventListener('click', (e) => {
      e.stopPropagation();
      const color = option.dataset.color;
      currentColor = color;
      colorPickerButton.style.backgroundColor = color;
      colorPicker.classList.add('hidden');
    });
  });
  
  document.addEventListener('click', () => {
    colorPicker.classList.add('hidden');
  });
  
  // Thickness slider
  const thicknessSlider = document.getElementById('thickness-slider');
  thicknessSlider.addEventListener('input', (e) => {
    currentThickness = parseInt(e.target.value);
  });
}

/* ==========================================
   SEARCH WORKER SETUP
   ========================================== */

function setupSearchWorker() {
  searchWorker = new Worker('js/pdfSearchWorker.js');
  
  searchWorker.onmessage = (e) => {
    const { type, matches } = e.data;
    
    if (type === 'searchResults') {
      displaySearchResults(matches);
    }
  };
  
  searchWorker.onerror = (error) => {
    console.error('Search worker error:', error);
  };
}

/* ==========================================
   PINCH TO ZOOM SETUP
   ========================================== */

let initialPinchDistance = 0;
let initialScale = 1.0;
let isZooming = false;
let lastMouseX = 0;
let lastMouseY = 0;

function setupPinchZoom() {
  // Prevent default pinch zoom on the container
  pdfContainer.addEventListener('wheel', handleWheelZoom, { passive: false });
  
  // Track mouse position for zoom origin
  pdfContainer.addEventListener('mousemove', (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  });
  
  // Touch events for trackpad pinch
  pdfContainer.addEventListener('gesturestart', handleGestureStart, { passive: false });
  pdfContainer.addEventListener('gesturechange', handleGestureChange, { passive: false });
  pdfContainer.addEventListener('gestureend', handleGestureEnd, { passive: false });
}

function handleWheelZoom(e) {
  // Check if Ctrl/Cmd is pressed (pinch on trackpad triggers this)
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

function handleGestureStart(e) {
  e.preventDefault();
  initialScale = currentScale;
  isZooming = true;
}

function handleGestureChange(e) {
  e.preventDefault();
  
  // e.scale gives us the pinch scale factor
  const newScale = initialScale * e.scale;
  if (newScale >= 0.5 && newScale <= 3.0) {
    currentScale = newScale;
    updateZoomSmooth();
  }
}

function handleGestureEnd(e) {
  e.preventDefault();
  isZooming = false;
}

/* ==========================================
   DOCK AUTO-HIDE ON SCROLL
   ========================================== */

let lastScrollTop = 0;
let scrollTimeout = null;
let hideTimeout = null;
let scrollVelocity = 0;
const annotationDock = document.querySelector('.annotation-dock');

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
  
  // Calculate scroll velocity
  scrollVelocity = Math.abs(scrollDelta);
  
  // Clear timeouts
  clearTimeout(scrollTimeout);
  clearTimeout(hideTimeout);
  
  if (scrollTop > lastScrollTop && scrollTop > 100 && scrollVelocity > 5) {
    // Fast scrolling down - hide dock
    annotationDock.classList.add('hidden');
  } else if (scrollTop < lastScrollTop) {
    // Any scroll up - show dock immediately
    annotationDock.classList.remove('hidden');
  }
  
  lastScrollTop = scrollTop;
  
  // Show dock after scrolling stops for 1 second
  scrollTimeout = setTimeout(() => {
    annotationDock.classList.remove('hidden');
  }, 1000);
}

/* ==========================================
   LOAD PDF FROM URL
   ========================================== */

function loadPDFFromURL() {
  // Get PDF ID from query string
  const urlParams = new URLSearchParams(window.location.search);
  const pdfId = urlParams.get('id');
  
  if (!pdfId) {
    showError('No PDF specified');
    return;
  }
  
  // Get PDF data from sessionStorage
  const pdfBase64 = sessionStorage.getItem(`kiosk_pdf_${pdfId}`);
  const pdfName = sessionStorage.getItem(`kiosk_pdf_name_${pdfId}`);
  
  if (!pdfBase64) {
    showError('PDF not found. Please select a PDF from the home page.');
    return;
  }
  
  currentPDFName = pdfName || 'Document.pdf';
  updatePDFName(currentPDFName);
  
  // Convert base64 back to Uint8Array
  const pdfData = base64ToUint8Array(pdfBase64);
  
  // Load the PDF
  loadPDF(pdfData);
}

/* ==========================================
   LOAD PDF
   ========================================== */

async function loadPDF(pdfData) {
  try {
    pdfLoading.classList.remove('hidden');
    pdfError.classList.add('hidden');
    pdfCanvasWrapper.classList.add('hidden');
    
    // Load PDF from Uint8Array data
    const loadingTask = pdfjsLib.getDocument({ data: pdfData });
    pdfDocument = await loadingTask.promise;
    
    console.log(`PDF loaded: ${pdfDocument.numPages} pages`);
    
    // Render all pages
    await renderAllPages();
    
    // Index PDF for search (send to worker)
    indexPDFForSearch();
    
    pdfLoading.classList.add('hidden');
    pdfCanvasWrapper.classList.remove('hidden');
    
  } catch (error) {
    console.error('Error loading PDF:', error);
    showError('Failed to load PDF: ' + error.message);
  }
}

/* ==========================================
   RENDER PDF PAGES
   ========================================== */

async function renderAllPages() {
  const scrollPos = pdfContainer.scrollTop;
  const scrollPercentage = pdfContainer.scrollHeight > 0 ? scrollPos / pdfContainer.scrollHeight : 0;
  
  pdfCanvasWrapper.innerHTML = '';
  
  for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
    await renderPage(pageNum);
  }
  
  // Only restore scroll position if not zooming (zoom handles it separately)
  if (!isZooming && !zoomTimeout) {
    requestAnimationFrame(() => {
      pdfContainer.scrollTop = pdfContainer.scrollHeight * scrollPercentage;
    });
  }
}

async function renderPage(pageNum) {
  try {
    const page = await pdfDocument.getPage(pageNum);
    
    // Create container for this page
    const pageContainer = document.createElement('div');
    pageContainer.className = 'pdf-page';
    pageContainer.dataset.pageNumber = pageNum;
    
    // Create canvas for PDF
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    const context = canvas.getContext('2d');
    
    // Use currentScale directly (1.0 = actual PDF size)
    const viewport = page.getViewport({ scale: currentScale, rotation: currentRotation });
    
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.display = 'block';
    
    // Render page
    const renderContext = {
      canvasContext: context,
      viewport: viewport
    };
    
    await page.render(renderContext).promise;
    
    // Create text layer for selection
    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    textLayerDiv.style.width = viewport.width + 'px';
    textLayerDiv.style.height = viewport.height + 'px';
    textLayerDiv.style.pointerEvents = 'auto'; // Ensure text selection is enabled by default
    
    // Render text layer
    const textContent = await page.getTextContent();
    pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport: viewport,
      textDivs: []
    });
    
    // Create annotation canvas overlay
    const annotationCanvas = document.createElement('canvas');
    annotationCanvas.className = 'annotation-canvas';
    annotationCanvas.width = viewport.width;
    annotationCanvas.height = viewport.height;
    annotationCanvas.style.position = 'absolute';
    annotationCanvas.style.top = '0';
    annotationCanvas.style.left = '0';
    annotationCanvas.style.pointerEvents = currentTool ? 'auto' : 'none';
    annotationCanvas.dataset.pageNumber = pageNum;
    
    // Add mouse event listeners for annotations
    setupAnnotationListeners(annotationCanvas);
    
    pageContainer.appendChild(canvas);
    pageContainer.appendChild(textLayerDiv);
    pageContainer.appendChild(annotationCanvas);
    pdfCanvasWrapper.appendChild(pageContainer);
    
  } catch (error) {
    console.error(`Error rendering page ${pageNum}:`, error);
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
  // Calculate scale to fit container height
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
  updateZoom();
}

function updateZoom() {
  previousScale = currentScale;
  zoomLevel.textContent = Math.round(currentScale * 100) + '%';
  renderAllPages();
}

let zoomTimeout = null;

function updateZoomSmooth() {
  const scaleDelta = currentScale / previousScale;
  
  // Get scroll position before zoom
  const scrollTop = pdfContainer.scrollTop;
  const scrollLeft = pdfContainer.scrollLeft;
  const containerRect = pdfContainer.getBoundingClientRect();
  
  // Calculate cursor position relative to container
  const cursorX = lastMouseX - containerRect.left;
  const cursorY = lastMouseY - containerRect.top;
  
  // Calculate the point in the document that's under the cursor
  const docX = scrollLeft + cursorX;
  const docY = scrollTop + cursorY;
  
  // Apply instant CSS transform to all pages for smooth visual feedback
  document.querySelectorAll('.pdf-page').forEach(page => {
    const pageRect = page.getBoundingClientRect();
    const pageTop = page.offsetTop;
    const pageLeft = page.offsetLeft;
    
    // Calculate transform origin based on cursor position relative to this page
    const originX = ((docX - pageLeft) / page.offsetWidth) * 100;
    const originY = ((docY - pageTop) / page.offsetHeight) * 100;
    
    page.style.transform = `scale(${scaleDelta})`;
    page.style.transformOrigin = `${originX}% ${originY}%`;
    page.style.transition = 'transform 0.15s ease-out';
  });
  
  zoomLevel.textContent = Math.round(currentScale * 100) + '%';
  
  // Debounce the actual re-render
  clearTimeout(zoomTimeout);
  zoomTimeout = setTimeout(() => {
    previousScale = currentScale;
    
    // Calculate new scroll position to keep cursor point fixed
    const newDocX = docX * scaleDelta;
    const newDocY = docY * scaleDelta;
    const newScrollLeft = newDocX - cursorX;
    const newScrollTop = newDocY - cursorY;
    
    // Reset transforms before re-rendering
    document.querySelectorAll('.pdf-page').forEach(page => {
      page.style.transform = 'none';
      page.style.transition = 'none';
    });
    
    renderAllPages().then(() => {
      // Adjust scroll to keep cursor position stable
      pdfContainer.scrollLeft = newScrollLeft;
      pdfContainer.scrollTop = newScrollTop;
    });
  }, 300);
}

/* ==========================================
   SEARCH FUNCTIONALITY
   ========================================== */

let searchTimeout = null;

function handleSearchInput(e) {
  const query = e.target.value.trim();
  
  // Clear previous timeout
  clearTimeout(searchTimeout);
  
  if (query.length < 2) {
    searchResults.classList.add('hidden');
    return;
  }
  
  // Debounce search
  searchTimeout = setTimeout(() => {
    performSearch(query);
  }, 300);
}

async function indexPDFForSearch() {
  if (!pdfDocument || !searchWorker) return;
  
  try {
    const pages = [];
    
    for (let i = 1; i <= pdfDocument.numPages; i++) {
      const page = await pdfDocument.getPage(i);
      const textContent = await page.getTextContent();
      const text = textContent.items.map(item => item.str).join(' ');
      
      pages.push({
        pageNumber: i,
        text: text
      });
    }
    
    // Send to worker for indexing
    searchWorker.postMessage({
      type: 'index',
      pages: pages
    });
    
  } catch (error) {
    console.error('Error indexing PDF:', error);
  }
}

function performSearch(query) {
  if (!searchWorker) return;
  
  searchWorker.postMessage({
    type: 'search',
    query: query
  });
}

function displaySearchResults(matches) {
  if (matches.length === 0) {
    searchResults.innerHTML = '<div class="search-no-results">No results found</div>';
    searchResults.classList.remove('hidden');
    return;
  }
  
  searchResults.innerHTML = matches.map(match => `
    <div class="search-result-item" data-page="${match.pageNumber}">
      <div class="search-result-page">Page ${match.pageNumber}</div>
      <div class="search-result-snippet">${highlightMatch(match.snippet, match.query)}</div>
    </div>
  `).join('');
  
  searchResults.classList.remove('hidden');
  
  // Add click handlers
  searchResults.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('click', () => {
      const pageNumber = parseInt(item.dataset.page);
      jumpToPage(pageNumber);
      searchResults.classList.add('hidden');
    });
  });
}

function highlightMatch(text, query) {
  const regex = new RegExp(`(${escapeRegex(query)})`, 'gi');
  return escapeHtml(text).replace(regex, '<mark>$1</mark>');
}

function jumpToPage(pageNumber) {
  const pageElement = pdfCanvasWrapper.querySelector(`[data-page-number="${pageNumber}"]`);
  if (pageElement) {
    pageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/* ==========================================
   ANNOTATION TOOLS
   ========================================== */

let isDrawing = false;
let drawingStartX = 0;
let drawingStartY = 0;
let annotationHistory = new Map(); // Store annotations per page
let previewCanvas = null; // For live shape preview

function setupAnnotationListeners(canvas) {
  canvas.addEventListener('mousedown', handleAnnotationStart);
  canvas.addEventListener('mousemove', handleAnnotationMove);
  canvas.addEventListener('mouseup', handleAnnotationEnd);
  canvas.addEventListener('mouseleave', handleAnnotationEnd);
  
  // Store reference for preview
  canvas.tempImageData = null;
}

function handleAnnotationStart(e) {
  if (!currentTool) return;
  
  isDrawing = true;
  const rect = e.target.getBoundingClientRect();
  drawingStartX = e.clientX - rect.left;
  drawingStartY = e.clientY - rect.top;
  
  const ctx = e.target.getContext('2d');
  ctx.strokeStyle = currentColor;
  ctx.fillStyle = currentColor;
  ctx.lineWidth = currentThickness;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  
  // Save canvas state for preview
  if (currentTool === 'rectangle' || currentTool === 'circle' || currentTool === 'arrow') {
    e.target.tempImageData = ctx.getImageData(0, 0, e.target.width, e.target.height);
  }
  
  if (currentTool === 'pen') {
    ctx.beginPath();
    ctx.moveTo(drawingStartX, drawingStartY);
  }
}

function handleAnnotationMove(e) {
  if (!isDrawing || !currentTool) return;
  
  const rect = e.target.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const ctx = e.target.getContext('2d');
  
  if (currentTool === 'pen') {
    // Freehand drawing
    ctx.lineTo(x, y);
    ctx.stroke();
  } else if (currentTool === 'highlight') {
    // Highlight effect (semi-transparent yellow marker)
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = currentColor;
    const height = Math.abs(y - drawingStartY) || 20;
    ctx.fillRect(drawingStartX, Math.min(drawingStartY, y), x - drawingStartX, height);
    ctx.globalAlpha = 1.0;
  } else if (currentTool === 'rectangle' || currentTool === 'circle' || currentTool === 'arrow') {
    // Live preview for shapes - restore previous state first
    if (e.target.tempImageData) {
      ctx.putImageData(e.target.tempImageData, 0, 0);
    }
    
    // Draw preview
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
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const ctx = e.target.getContext('2d');
  
  // Restore for final draw
  if (e.target.tempImageData && (currentTool === 'rectangle' || currentTool === 'circle' || currentTool === 'arrow')) {
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
    
    case 'underline':
      ctx.beginPath();
      ctx.moveTo(drawingStartX, drawingStartY);
      ctx.lineTo(x, y);
      ctx.stroke();
      break;
    
    case 'strikethrough':
      ctx.beginPath();
      ctx.moveTo(drawingStartX, drawingStartY);
      ctx.lineTo(x, y);
      ctx.stroke();
      break;
    
    case 'text':
      const text = prompt('Enter text:');
      if (text) {
        ctx.font = `${currentThickness * 5}px Arial`;
        ctx.fillText(text, drawingStartX, drawingStartY);
      }
      break;
  }
  
  // Clear temp data
  e.target.tempImageData = null;
  isDrawing = false;
}

function drawArrow(ctx, fromX, fromY, toX, toY) {
  const headLength = 15;
  const angle = Math.atan2(toY - fromY, toX - fromX);
  
  // Draw line
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(toX, toY);
  ctx.stroke();
  
  // Draw arrowhead
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - headLength * Math.cos(angle - Math.PI / 6), toY - headLength * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - headLength * Math.cos(angle + Math.PI / 6), toY - headLength * Math.sin(angle + Math.PI / 6));
  ctx.stroke();
}

function handleToolSelect(tool) {
  currentTool = currentTool === tool ? null : tool;
  
  // Update active state
  document.querySelectorAll('.annotation-tool').forEach(t => {
    t.classList.remove('active');
  });
  
  if (currentTool) {
    const toolElement = document.querySelector(`[data-tool="${tool}"]`);
    if (toolElement) {
      toolElement.classList.add('active');
    }
    
    // For text-based tools (highlight, underline, strikethrough), allow text selection
    const isTextTool = ['highlight', 'underline', 'strikethrough'].includes(currentTool);
    
    document.querySelectorAll('.annotation-canvas').forEach(canvas => {
      if (isTextTool) {
        // Allow text selection by making canvas transparent to pointer events
        canvas.style.cursor = 'text';
        canvas.style.pointerEvents = 'none';
      } else {
        // For drawing tools, enable canvas interaction
        canvas.style.cursor = 'crosshair';
        canvas.style.pointerEvents = 'auto';
      }
    });
    
    // Text layer should ALWAYS allow text selection, regardless of tool
    document.querySelectorAll('.textLayer').forEach(layer => {
      layer.style.pointerEvents = 'auto';
    });
  } else {
    // Reset cursor and allow text selection
    document.querySelectorAll('.annotation-canvas').forEach(canvas => {
      canvas.style.cursor = 'default';
      canvas.style.pointerEvents = 'none';
    });
    
    // Enable text selection when no tool is active
    document.querySelectorAll('.textLayer').forEach(layer => {
      layer.style.pointerEvents = 'auto';
    });
  }
  
  console.log('Tool selected:', currentTool, 'Color:', currentColor, 'Thickness:', currentThickness);
}

/* ==========================================
   TEXT SELECTION ANNOTATION
   ========================================== */

function handleTextSelection(e) {
  const selection = window.getSelection();
  const selectedText = selection.toString().trim();
  
  if (!selectedText || !currentTool) return;
  
  // Only handle highlight, underline, strikethrough for text selection
  if (!['highlight', 'underline', 'strikethrough'].includes(currentTool)) return;
  
  try {
    const range = selection.getRangeAt(0);
    const rects = range.getClientRects();
    
    if (rects.length === 0) return;
    
    // Find which page contains the selection
    let targetPage = null;
    let pageContainer = range.startContainer;
    
    while (pageContainer && !pageContainer.classList?.contains('pdf-page')) {
      pageContainer = pageContainer.parentElement;
    }
    
    if (!pageContainer) return;
    
    const annotationCanvas = pageContainer.querySelector('.annotation-canvas');
    if (!annotationCanvas) return;
    
    const ctx = annotationCanvas.getContext('2d');
    const canvasRect = annotationCanvas.getBoundingClientRect();
    
    ctx.strokeStyle = currentColor;
    ctx.fillStyle = currentColor;
    ctx.lineWidth = currentThickness;
    
    // Draw annotation on each selection rectangle
    Array.from(rects).forEach(rect => {
      const x = rect.left - canvasRect.left;
      const y = rect.top - canvasRect.top;
      const width = rect.width;
      const height = rect.height;
      
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
    
    // Clear selection
    selection.removeAllRanges();
    
  } catch (error) {
    console.error('Error applying text annotation:', error);
  }
}

/* ==========================================
   PDF DOWNLOAD
   ========================================== */

async function downloadPDF() {
  const urlParams = new URLSearchParams(window.location.search);
  const pdfId = urlParams.get('id');
  const pdfBase64 = sessionStorage.getItem(`kiosk_pdf_${pdfId}`);
  
  if (pdfBase64) {
    try {
      // Check if there are any annotations
      const hasAnnotations = document.querySelectorAll('.annotation-canvas').length > 0;
      
      if (hasAnnotations) {
        // Export PDF with annotations
        await exportPDFWithAnnotations(pdfBase64);
      } else {
        // Download original PDF
        downloadOriginalPDF(pdfBase64);
      }
    } catch (error) {
      console.error('Error downloading PDF:', error);
      // Fallback to original
      downloadOriginalPDF(pdfBase64);
    }
  }
}

function downloadOriginalPDF(pdfBase64) {
  const pdfData = base64ToUint8Array(pdfBase64);
  const blob = new Blob([pdfData], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = currentPDFName;
  link.click();
  
  // Clean up
  URL.revokeObjectURL(url);
}

async function exportPDFWithAnnotations(pdfBase64) {
  // Create a new PDF with annotations burned in
  const pdf = await PDFLib.PDFDocument.create();
  
  for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
    const pageContainer = pdfCanvasWrapper.querySelector(`[data-page-number="${pageNum}"]`);
    if (!pageContainer) continue;
    
    // Get the PDF canvas and annotation canvas
    const pdfCanvas = pageContainer.querySelector('canvas:not(.annotation-canvas)');
    const annotationCanvas = pageContainer.querySelector('.annotation-canvas');
    
    if (!pdfCanvas) continue;
    
    // Create a temporary canvas to merge PDF and annotations
    const mergedCanvas = document.createElement('canvas');
    mergedCanvas.width = pdfCanvas.width;
    mergedCanvas.height = pdfCanvas.height;
    const ctx = mergedCanvas.getContext('2d');
    
    // Draw PDF content
    ctx.drawImage(pdfCanvas, 0, 0);
    
    // Draw annotations on top
    if (annotationCanvas) {
      ctx.drawImage(annotationCanvas, 0, 0);
    }
    
    // Convert to PNG and embed in new PDF
    const imgData = mergedCanvas.toDataURL('image/png');
    const pngImage = await pdf.embedPng(imgData);
    
    const page = pdf.addPage([pdfCanvas.width, pdfCanvas.height]);
    page.drawImage(pngImage, {
      x: 0,
      y: 0,
      width: pdfCanvas.width,
      height: pdfCanvas.height,
    });
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
  // Truncate if too long
  const maxLength = 30;
  if (name.length > maxLength) {
    const extension = name.substring(name.lastIndexOf('.'));
    const basename = name.substring(0, name.lastIndexOf('.'));
    const truncated = basename.substring(0, maxLength - extension.length - 3) + '...' + extension;
    pdfNameEl.textContent = truncated;
    pdfNameEl.title = name;
  } else {
    pdfNameEl.textContent = name;
  }
}

function showError(message) {
  pdfLoading.classList.add('hidden');
  pdfCanvasWrapper.classList.add('hidden');
  pdfError.classList.remove('hidden');
  pdfError.querySelector('div:last-of-type').textContent = message;
}

/* ==========================================
   UTILITY FUNCTIONS
   ========================================== */

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/* ==========================================
   START THE VIEWER
   ========================================== */

init();
