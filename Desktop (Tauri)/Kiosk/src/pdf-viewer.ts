/**
 * Kiosk PDF Viewer - Main Viewer Component
 *
 * Handles PDF rendering, navigation, zoom, and text selection.
 */

import {
  loadPdf,
  loadPdfBytes,
  closePdf,
  renderPage,
  getCharRects,
  getAllPageInfos,
  searchText,
  pngBytesToUrl,
  fileToBytes,
  type LoadResult,
  type PageInfo,
  type CharRect,
  type SearchResult,
  type AnnotationData,
  type AnnotationColor,
} from './pdf-api';

import {
  initAnnotations,
  resetAnnotations,
  setAnnotationTool,
  getAnnotationTool,
  startAnnotation,
  continueAnnotation,
  finishAnnotation,
  cancelAnnotation,
  saveAllAnnotations,
  getPageAnnotations,
  getPendingAnnotation,
  onAnnotationStateChange,
  pdfToScreen,
  pdfRectToScreen,
  hasUnsavedChanges,
  addTextSelectionAnnotation,
  type AnnotationTool,
  type PendingAnnotation,
} from './annotations';

// ============================================================================
// Constants
// ============================================================================

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5.0;
const ZOOM_STEP = 0.1;
const DEFAULT_ZOOM = 1.0;
const RENDER_BUFFER = 2; // Pages to pre-render above/below viewport
const PINCH_SENSITIVITY = 0.01; // Sensitivity for trackpad pinch gesture

// Display modes
export type DisplayMode = 'light' | 'dark' | 'night';

// ============================================================================
// State
// ============================================================================

interface ViewerState {
  docId: string | null;
  pages: PageInfo[];
  currentPage: number;
  scale: number;
  renderedPages: Map<number, string>; // pageIndex -> blob URL
  charRects: Map<number, CharRect[]>; // pageIndex -> char rects
  searchResults: SearchResult[];
  searchQuery: string;
  isLoading: boolean;
  // Gesture state
  isPinching: boolean;
  lastPinchScale: number;
  gestureStartScale: number;
  // Error state
  lastError: string | null;
  // Display mode
  displayMode: DisplayMode;
  // Layout state
  sidebarVisible: boolean;
}

const state: ViewerState = {
  docId: null,
  pages: [],
  currentPage: 0,
  scale: DEFAULT_ZOOM,
  renderedPages: new Map(),
  charRects: new Map(),
  searchResults: [],
  searchQuery: '',
  isLoading: false,
  isPinching: false,
  lastPinchScale: 1,
  gestureStartScale: DEFAULT_ZOOM,
  lastError: null,
  displayMode: (localStorage.getItem('kiosk-display-mode') as DisplayMode) || 'light',
  sidebarVisible: true,
};

// ============================================================================
// DOM Elements
// ============================================================================

let viewerContainer: HTMLElement;
let pagesContainer: HTMLElement;
let thumbnailsContainer: HTMLElement;
let searchInput: HTMLInputElement;
let searchResultsEl: HTMLElement;
let pageCounter: HTMLElement;
let zoomLabel: HTMLElement;
let loadingOverlay: HTMLElement;
let errorDialog: HTMLElement | null;
let pdfInversionOverlay: HTMLElement | null;

// ============================================================================
// Initialization
// ============================================================================

export function initViewer(): void {
  // Get DOM elements
  viewerContainer = document.getElementById('viewer-container')!;
  pagesContainer = document.getElementById('pages-container')!;
  thumbnailsContainer = document.getElementById('thumbnails-container')!;
  searchInput = document.getElementById('search-input') as HTMLInputElement;
  searchResultsEl = document.getElementById('search-results')!;
  pageCounter = document.getElementById('page-counter')!;
  zoomLabel = document.getElementById('zoom-label')!;
  loadingOverlay = document.getElementById('loading-overlay')!;

  // Create error dialog if it doesn't exist
  createErrorDialog();
  
  // Create PDF inversion overlay for night mode
  createInversionOverlay();

  // Set up event listeners
  setupEventListeners();
  
  // Set up trackpad gesture listeners
  setupGestureListeners();
  
  // Set up window resize listener for layout recalculation
  setupResizeListener();

  // Set initial zoom label
  updateZoomLabel();
  
  // Apply initial display mode
  applyDisplayMode(state.displayMode);
  
  // Set up annotation state change listener
  setupAnnotationListener();
  
  // Log initialization
  console.log('[Kiosk] Viewer initialized');
}

/**
 * Set up listener for annotation state changes to re-render overlays.
 */
function setupAnnotationListener(): void {
  onAnnotationStateChange(() => {
    renderAnnotationOverlays();
  });
}

function setupEventListeners(): void {
  // Zoom controls
  document.getElementById('zoom-in')?.addEventListener('click', zoomIn);
  document.getElementById('zoom-out')?.addEventListener('click', zoomOut);
  document.getElementById('zoom-fit-width')?.addEventListener('click', fitWidth);
  document.getElementById('zoom-fit-page')?.addEventListener('click', fitPage);

  // Navigation
  document.getElementById('prev-page')?.addEventListener('click', prevPage);
  document.getElementById('next-page')?.addEventListener('click', nextPage);

  // Search
  searchInput?.addEventListener('input', debounce(handleSearch, 300));

  // Scroll to track current page
  viewerContainer?.addEventListener('scroll', handleScroll);

  // Keyboard shortcuts
  document.addEventListener('keydown', handleKeydown);

  // Drag and drop
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', handleDrop);
}

// ============================================================================
// Trackpad Gesture Support (macOS pinch-to-zoom)
// ============================================================================

function setupGestureListeners(): void {
  // macOS Safari/WebKit gesture events for trackpad pinch-to-zoom
  viewerContainer?.addEventListener('gesturestart', handleGestureStart as EventListener);
  viewerContainer?.addEventListener('gesturechange', handleGestureChange as EventListener);
  viewerContainer?.addEventListener('gestureend', handleGestureEnd as EventListener);
  
  // Standard wheel event with ctrlKey for pinch-to-zoom (Chrome/Firefox on Mac)
  viewerContainer?.addEventListener('wheel', handleWheel, { passive: false });
  
  console.log('[Kiosk] Gesture listeners initialized');
}

function handleGestureStart(e: GestureEvent): void {
  e.preventDefault();
  state.isPinching = true;
  state.gestureStartScale = state.scale;
  state.lastPinchScale = e.scale;
}

function handleGestureChange(e: GestureEvent): void {
  e.preventDefault();
  if (!state.isPinching) return;
  
  // Calculate new scale based on gesture
  const scaleChange = e.scale / state.lastPinchScale;
  const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, state.scale * scaleChange));
  
  state.lastPinchScale = e.scale;
  
  // Apply zoom smoothly
  setZoomSmooth(newScale, e.clientX, e.clientY);
}

function handleGestureEnd(e: GestureEvent): void {
  e.preventDefault();
  state.isPinching = false;
  
  // Re-render at final scale
  renderVisiblePages();
}

function handleWheel(e: WheelEvent): void {
  // Check if this is a pinch gesture (ctrlKey is set on trackpad pinch in Chrome/Firefox)
  if (e.ctrlKey) {
    e.preventDefault();
    
    // Calculate zoom change (negative deltaY = zoom in)
    const zoomDelta = -e.deltaY * PINCH_SENSITIVITY;
    const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, state.scale * (1 + zoomDelta)));
    
    // Apply zoom centered on cursor position
    setZoomSmooth(newScale, e.clientX, e.clientY);
  }
  // Regular scroll is handled by default browser behavior
}

// Gesture event type for Safari/WebKit
interface GestureEvent extends UIEvent {
  scale: number;
  rotation: number;
  clientX: number;
  clientY: number;
}

// ============================================================================
// Document Loading
// ============================================================================

export async function openFile(path: string): Promise<void> {
  setLoading(true);
  try {
    // Close previous document
    if (state.docId) {
      await closePdf(state.docId);
      resetAnnotations();
      clearRenderedPages();
    }

    // Load new document
    const result = await loadPdf(path);
    await initializeDocument(result);
  } catch (err) {
    console.error('Failed to load PDF:', err);
    showError(`Failed to load PDF: ${err}`);
  } finally {
    setLoading(false);
  }
}

export async function openBytes(bytes: Uint8Array, fileName?: string): Promise<void> {
  setLoading(true);
  try {
    // Close previous document
    if (state.docId) {
      await closePdf(state.docId);
      resetAnnotations();
      clearRenderedPages();
    }

    // Load new document
    const result = await loadPdfBytes(bytes);
    await initializeDocument(result);
    
    // Update title if filename provided
    if (fileName) {
      document.title = `Kiosk - ${fileName}`;
    }
  } catch (err) {
    console.error('Failed to load PDF:', err);
    showError(`Failed to load PDF: ${err}`);
  } finally {
    setLoading(false);
  }
}

async function initializeDocument(result: LoadResult): Promise<void> {
  state.docId = result.id;
  state.pages = await getAllPageInfos(result.id);
  state.currentPage = 0;

  // Update title
  const title = result.info.title || 'Untitled';
  document.title = `Kiosk - ${title}`;

  // Create page containers
  createPageContainers();

  // Create thumbnails
  await createThumbnails();

  // Render visible pages
  await renderVisiblePages();

  // Update UI
  updatePageCounter();
  
  // Initialize annotations for this document
  await initAnnotations(result.id, state.pages);
}

// ============================================================================
// Page Rendering
// ============================================================================

function createPageContainers(): void {
  pagesContainer.innerHTML = '';

  for (let i = 0; i < state.pages.length; i++) {
    const page = state.pages[i];
    const pageEl = document.createElement('div');
    pageEl.className = 'page';
    pageEl.dataset.pageIndex = String(i);

    // Set size based on zoom
    const width = page.width * state.scale;
    const height = page.height * state.scale;
    pageEl.style.width = `${width}px`;
    pageEl.style.height = `${height}px`;

    // Image element for rendered page
    const img = document.createElement('img');
    img.className = 'page-image';
    img.alt = `Page ${i + 1}`;
    pageEl.appendChild(img);

    // Text overlay for selection
    const textOverlay = document.createElement('div');
    textOverlay.className = 'text-overlay';
    pageEl.appendChild(textOverlay);

    // Annotation overlay (for displaying and drawing annotations)
    const annotationOverlay = document.createElement('div');
    annotationOverlay.className = 'annotation-overlay';
    setupAnnotationOverlayEvents(annotationOverlay, i);
    pageEl.appendChild(annotationOverlay);

    pagesContainer.appendChild(pageEl);
  }
}

/**
 * Set up mouse/touch events for annotation drawing on a page overlay.
 */
function setupAnnotationOverlayEvents(overlay: HTMLElement, pageIndex: number): void {
  overlay.addEventListener('mousedown', (e) => {
    if (getAnnotationTool() === 'select') return;
    
    const rect = overlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    startAnnotation(pageIndex, x, y, state.scale);
    e.preventDefault();
  });
  
  overlay.addEventListener('mousemove', (e) => {
    const rect = overlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    continueAnnotation(x, y, state.scale);
  });
  
  overlay.addEventListener('mouseup', () => {
    finishAnnotation();
  });
  
  overlay.addEventListener('mouseleave', () => {
    // Cancel the annotation if mouse leaves - user can start again
    cancelAnnotation();
  });
  
  // Keyboard handler for Escape to cancel annotation
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      cancelAnnotation();
    }
  });
}

async function renderVisiblePages(): Promise<void> {
  if (!state.docId) return;

  const visibleRange = getVisiblePageRange();
  const pagesToRender = new Set<number>();

  // Add visible pages plus buffer
  for (let i = visibleRange.start - RENDER_BUFFER; i <= visibleRange.end + RENDER_BUFFER; i++) {
    if (i >= 0 && i < state.pages.length) {
      pagesToRender.add(i);
    }
  }

  // Render pages that aren't already rendered
  const renderPromises: Promise<void>[] = [];
  for (const pageIndex of pagesToRender) {
    if (!state.renderedPages.has(pageIndex)) {
      renderPromises.push(renderPageToContainer(pageIndex));
    }
  }

  await Promise.all(renderPromises);

  // Unload pages far from viewport to save memory
  const unloadThreshold = RENDER_BUFFER * 2;
  for (const [pageIndex] of state.renderedPages) {
    if (pageIndex < visibleRange.start - unloadThreshold || pageIndex > visibleRange.end + unloadThreshold) {
      unloadPage(pageIndex);
    }
  }
}

async function renderPageToContainer(pageIndex: number): Promise<void> {
  if (!state.docId) return;

  try {
    // Render at device pixel ratio for HiDPI
    const dpr = window.devicePixelRatio || 1;
    const renderScale = state.scale * dpr;

    const pngBytes = await renderPage(state.docId, pageIndex, renderScale);
    const url = pngBytesToUrl(pngBytes);

    state.renderedPages.set(pageIndex, url);

    // Update image element
    const pageEl = pagesContainer.querySelector(`[data-page-index="${pageIndex}"]`);
    const img = pageEl?.querySelector('img.page-image') as HTMLImageElement;
    if (img) {
      img.src = url;
    }

    // Load char rects for text selection
    if (!state.charRects.has(pageIndex)) {
      const rects = await getCharRects(state.docId, pageIndex);
      state.charRects.set(pageIndex, rects);
      buildTextOverlay(pageIndex, rects);
    }
  } catch (err) {
    console.error(`Failed to render page ${pageIndex}:`, err);
  }
}

function unloadPage(pageIndex: number): void {
  const url = state.renderedPages.get(pageIndex);
  if (url) {
    URL.revokeObjectURL(url);
    state.renderedPages.delete(pageIndex);

    // Clear image src
    const pageEl = pagesContainer.querySelector(`[data-page-index="${pageIndex}"]`);
    const img = pageEl?.querySelector('img.page-image') as HTMLImageElement;
    if (img) {
      img.src = '';
    }
  }
}

function clearRenderedPages(): void {
  for (const url of state.renderedPages.values()) {
    URL.revokeObjectURL(url);
  }
  state.renderedPages.clear();
  state.charRects.clear();
}

// ============================================================================
// Text Overlay (for selection)
// ============================================================================

function buildTextOverlay(pageIndex: number, rects: CharRect[]): void {
  const pageEl = pagesContainer.querySelector(`[data-page-index="${pageIndex}"]`);
  const overlay = pageEl?.querySelector('.text-overlay') as HTMLElement;
  if (!overlay) return;

  overlay.innerHTML = '';

  for (const rect of rects) {
    const span = document.createElement('span');
    span.textContent = rect.char;
    span.style.position = 'absolute';
    span.style.left = `${rect.x * state.scale}px`;
    span.style.top = `${rect.y * state.scale}px`;
    span.style.width = `${rect.width * state.scale}px`;
    span.style.height = `${rect.height * state.scale}px`;
    span.style.color = 'transparent';
    span.style.fontSize = `${rect.height * state.scale}px`;
    span.style.lineHeight = '1';
    span.dataset.charIndex = String(rect.index);
    overlay.appendChild(span);
  }
}

// ============================================================================
// Thumbnails
// ============================================================================

async function createThumbnails(): Promise<void> {
  if (!state.docId) return;

  thumbnailsContainer.innerHTML = '';
  const thumbnailScale = 0.2; // Small for thumbnails

  for (let i = 0; i < state.pages.length; i++) {
    const thumbEl = document.createElement('div');
    thumbEl.className = 'thumbnail';
    thumbEl.dataset.pageIndex = String(i);
    thumbEl.addEventListener('click', () => goToPage(i));

    const page = state.pages[i];
    thumbEl.style.width = `${page.width * thumbnailScale}px`;
    thumbEl.style.height = `${page.height * thumbnailScale}px`;

    const img = document.createElement('img');
    img.alt = `Page ${i + 1}`;
    thumbEl.appendChild(img);

    const label = document.createElement('span');
    label.className = 'thumbnail-label';
    label.textContent = String(i + 1);
    thumbEl.appendChild(label);

    thumbnailsContainer.appendChild(thumbEl);

    // Render thumbnail asynchronously
    renderThumbnail(i, img, thumbnailScale);
  }

  updateThumbnailHighlight();
}

async function renderThumbnail(pageIndex: number, img: HTMLImageElement, scale: number): Promise<void> {
  if (!state.docId) return;

  try {
    const pngBytes = await renderPage(state.docId, pageIndex, scale);
    const url = pngBytesToUrl(pngBytes);
    img.src = url;
  } catch (err) {
    console.error(`Failed to render thumbnail ${pageIndex}:`, err);
  }
}

function updateThumbnailHighlight(): void {
  const thumbs = thumbnailsContainer.querySelectorAll('.thumbnail');
  thumbs.forEach((thumb, i) => {
    thumb.classList.toggle('active', i === state.currentPage);
  });
}

// ============================================================================
// Navigation
// ============================================================================

function getVisiblePageRange(): { start: number; end: number } {
  const containerRect = viewerContainer.getBoundingClientRect();
  const pages = pagesContainer.querySelectorAll('.page');
  let start = 0;
  let end = 0;

  pages.forEach((page, i) => {
    const rect = page.getBoundingClientRect();
    if (rect.bottom > containerRect.top && rect.top < containerRect.bottom) {
      if (start === 0 || i < start) start = i;
      end = i;
    }
  });

  return { start, end };
}

export function goToPage(pageIndex: number): void {
  if (pageIndex < 0 || pageIndex >= state.pages.length) return;

  const pageEl = pagesContainer.querySelector(`[data-page-index="${pageIndex}"]`);
  if (pageEl) {
    pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    state.currentPage = pageIndex;
    updatePageCounter();
    updateThumbnailHighlight();
  }
}

function prevPage(): void {
  goToPage(state.currentPage - 1);
}

function nextPage(): void {
  goToPage(state.currentPage + 1);
}

function handleScroll(): void {
  const range = getVisiblePageRange();
  if (range.start !== state.currentPage) {
    state.currentPage = range.start;
    updatePageCounter();
    updateThumbnailHighlight();
  }

  // Render newly visible pages
  renderVisiblePages();
}

// ============================================================================
// Zoom
// ============================================================================

/**
 * Set zoom to an exact scale value with optional center point.
 * This is the core zoom function that all other zoom methods use.
 */
function setZoomToScale(newScale: number, centerX?: number, centerY?: number): void {
  // Clamp scale to valid range
  newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newScale));
  
  if (newScale === state.scale) return;
  
  // Store scroll position relative to center point for zoom-to-cursor
  let scrollRatioX = 0.5;
  let scrollRatioY = 0.5;
  
  if (centerX !== undefined && centerY !== undefined) {
    const rect = viewerContainer.getBoundingClientRect();
    scrollRatioX = (centerX - rect.left + viewerContainer.scrollLeft) / (pagesContainer.scrollWidth || 1);
    scrollRatioY = (centerY - rect.top + viewerContainer.scrollTop) / (pagesContainer.scrollHeight || 1);
  }

  state.scale = newScale;

  // Clear rendered pages (need to re-render at new scale)
  clearRenderedPages();

  // Resize page containers
  const pages = pagesContainer.querySelectorAll('.page');
  pages.forEach((pageEl, i) => {
    const page = state.pages[i];
    const el = pageEl as HTMLElement;
    el.style.width = `${page.width * state.scale}px`;
    el.style.height = `${page.height * state.scale}px`;
  });

  // Adjust scroll position to maintain focus point
  if (centerX !== undefined && centerY !== undefined) {
    const newScrollLeft = scrollRatioX * pagesContainer.scrollWidth - (centerX - viewerContainer.getBoundingClientRect().left);
    const newScrollTop = scrollRatioY * pagesContainer.scrollHeight - (centerY - viewerContainer.getBoundingClientRect().top);
    viewerContainer.scrollLeft = newScrollLeft;
    viewerContainer.scrollTop = newScrollTop;
  }

  // Re-render visible pages
  renderVisiblePages();
  updateZoomLabel();
}

/**
 * Set zoom smoothly for gesture-based zooming.
 * Uses requestAnimationFrame for smooth visual updates.
 */
function setZoomSmooth(newScale: number, _centerX?: number, _centerY?: number): void {
  // Clamp scale
  newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newScale));
  
  if (Math.abs(newScale - state.scale) < 0.001) return;
  
  state.scale = newScale;

  // Resize page containers immediately (visual feedback)
  const pages = pagesContainer.querySelectorAll('.page');
  pages.forEach((pageEl, i) => {
    const page = state.pages[i];
    const el = pageEl as HTMLElement;
    el.style.width = `${page.width * state.scale}px`;
    el.style.height = `${page.height * state.scale}px`;
  });

  updateZoomLabel();
  
  // Debounce the actual re-render to avoid excessive work during pinch
  debouncedRender();
}

// Debounced render for smooth gesture zooming
const debouncedRender = debounce(() => {
  clearRenderedPages();
  renderVisiblePages();
}, 150);

function zoomIn(): void {
  const newScale = Math.min(ZOOM_MAX, state.scale + ZOOM_STEP);
  setZoomToScale(newScale);
}

function zoomOut(): void {
  const newScale = Math.max(ZOOM_MIN, state.scale - ZOOM_STEP);
  setZoomToScale(newScale);
}

function fitWidth(): void {
  if (state.pages.length === 0) return;

  const containerWidth = viewerContainer.clientWidth - 40; // padding
  const pageWidth = state.pages[state.currentPage].width;
  const targetScale = containerWidth / pageWidth;

  setZoomToScale(targetScale);
}

function fitPage(): void {
  if (state.pages.length === 0) return;

  const containerWidth = viewerContainer.clientWidth - 40;
  const containerHeight = viewerContainer.clientHeight - 40;
  const page = state.pages[state.currentPage];

  const scaleW = containerWidth / page.width;
  const scaleH = containerHeight / page.height;
  const targetScale = Math.min(scaleW, scaleH);

  setZoomToScale(targetScale);
}

function updateZoomLabel(): void {
  if (zoomLabel) {
    zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;
  }
}


// ============================================================================
// Search
// ============================================================================

async function handleSearch(): Promise<void> {
  const query = searchInput.value.trim();
  if (query.length < 2 || !state.docId) {
    state.searchResults = [];
    renderSearchResults();
    return;
  }

  state.searchQuery = query;

  try {
    state.searchResults = await searchText(state.docId, query, false, 50);
    renderSearchResults();
  } catch (err) {
    console.error('Search failed:', err);
  }
}

function renderSearchResults(): void {
  searchResultsEl.innerHTML = '';

  if (state.searchResults.length === 0) {
    if (state.searchQuery) {
      searchResultsEl.innerHTML = '<div class="no-results">No results found</div>';
    }
    return;
  }

  for (const result of state.searchResults) {
    const resultEl = document.createElement('div');
    resultEl.className = 'search-result';
    resultEl.innerHTML = `
      <span class="search-result-page">Page ${result.page + 1}</span>
      <span class="search-result-text">${escapeHtml(result.text)}</span>
    `;
    resultEl.addEventListener('click', () => {
      goToPage(result.page);
      // TODO: Highlight the match on the page
    });
    searchResultsEl.appendChild(resultEl);
  }
}

// ============================================================================
// Event Handlers
// ============================================================================

function handleKeydown(e: KeyboardEvent): void {
  const isMeta = e.metaKey || e.ctrlKey;

  if (isMeta && e.key === '=') {
    e.preventDefault();
    zoomIn();
  } else if (isMeta && e.key === '-') {
    e.preventDefault();
    zoomOut();
  } else if (isMeta && e.key === '0') {
    e.preventDefault();
    setZoomToScale(DEFAULT_ZOOM);
  } else if (isMeta && e.key === 'f') {
    e.preventDefault();
    searchInput?.focus();
  } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
    prevPage();
  } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
    nextPage();
  } else if (e.key === 'Home') {
    goToPage(0);
  } else if (e.key === 'End') {
    goToPage(state.pages.length - 1);
  }
}

async function handleDrop(e: DragEvent): Promise<void> {
  e.preventDefault();

  const files = e.dataTransfer?.files;
  if (!files || files.length === 0) return;

  const file = files[0];
  if (file.type !== 'application/pdf' && !file.name.endsWith('.pdf')) {
    showError('Please drop a PDF file');
    return;
  }

  const bytes = await fileToBytes(file);
  await openBytes(bytes, file.name);
}

// ============================================================================
// UI Helpers
// ============================================================================

function updatePageCounter(): void {
  if (pageCounter) {
    if (state.pages.length === 0) {
      pageCounter.textContent = '0 / 0';
    } else {
      pageCounter.textContent = `${state.currentPage + 1} / ${state.pages.length}`;
    }
  }
}

function setLoading(loading: boolean): void {
  state.isLoading = loading;
  if (loadingOverlay) {
    loadingOverlay.style.display = loading ? 'flex' : 'none';
  }
}

/**
 * Create error dialog element if it doesn't exist.
 */
function createErrorDialog(): void {
  if (document.getElementById('error-dialog')) {
    errorDialog = document.getElementById('error-dialog');
    return;
  }
  
  errorDialog = document.createElement('div');
  errorDialog.id = 'error-dialog';
  errorDialog.className = 'error-dialog';
  errorDialog.innerHTML = `
    <div class="error-dialog-content">
      <div class="error-dialog-header">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <h3>Error</h3>
      </div>
      <p class="error-dialog-message"></p>
      <button class="error-dialog-btn">OK</button>
    </div>
  `;
  
  document.body.appendChild(errorDialog);
  
  // Add click handler to close button
  errorDialog.querySelector('.error-dialog-btn')?.addEventListener('click', hideError);
}

/**
 * Show user-friendly error dialog.
 */
function showError(message: string): void {
  // Log detailed error for debugging
  console.error('[Kiosk Error]', message);
  state.lastError = message;
  
  // Show user-friendly message
  if (errorDialog) {
    const msgEl = errorDialog.querySelector('.error-dialog-message');
    if (msgEl) {
      // Clean up technical error messages for users
      let userMessage = message;
      if (message.includes('Failed to initialize PDFium')) {
        userMessage = 'Unable to load PDF rendering engine. Please restart the app.';
      } else if (message.includes('Failed to load PDF')) {
        userMessage = 'Unable to open this PDF file. The file may be corrupted or password-protected.';
      } else if (message.includes('permission')) {
        userMessage = 'Cannot access this file. Please check file permissions.';
      }
      msgEl.textContent = userMessage;
    }
    errorDialog.classList.add('visible');
  }
}

/**
 * Hide error dialog.
 */
function hideError(): void {
  if (errorDialog) {
    errorDialog.classList.remove('visible');
  }
}

function debounce<T extends (...args: unknown[]) => void>(fn: T, delay: number): T {
  let timeout: number | undefined;
  return ((...args: unknown[]) => {
    clearTimeout(timeout);
    timeout = window.setTimeout(() => fn(...args), delay);
  }) as T;
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================================
// Cleanup & Lifecycle
// ============================================================================

/**
 * Reset viewer state when closing a document.
 */
export function resetViewer(): void {
  // Clear document state
  if (state.docId) {
    closePdf(state.docId).catch(console.error);
  }
  
  clearRenderedPages();
  
  state.docId = null;
  state.pages = [];
  state.currentPage = 0;
  state.scale = DEFAULT_ZOOM;
  state.searchResults = [];
  state.searchQuery = '';
  state.charRects.clear();
  
  // Clear UI
  pagesContainer.innerHTML = '';
  thumbnailsContainer.innerHTML = '';
  searchResultsEl.innerHTML = '';
  
  updatePageCounter();
  updateZoomLabel();
  
  console.log('[Kiosk] Viewer reset');
}

/**
 * Check if a document is currently loaded.
 */
export function hasDocument(): boolean {
  return state.docId !== null && state.pages.length > 0;
}

// ============================================================================
// Layout & Resize Handling
// ============================================================================

/**
 * Set up window resize listener to handle layout changes.
 */
function setupResizeListener(): void {
  // Debounced resize handler
  const handleResize = debounce(() => {
    recalculateLayout();
  }, 100);
  
  window.addEventListener('resize', handleResize);
  
  // Also observe sidebar for CSS transition end
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.addEventListener('transitionend', (e) => {
      if (e.propertyName === 'width' || e.propertyName === 'margin-left') {
        recalculateLayout();
      }
    });
  }
}

/**
 * Recalculate layout after viewport changes (resize, sidebar toggle, etc.)
 */
function recalculateLayout(): void {
  if (!hasDocument()) return;
  
  // Store current page to restore scroll position
  const currentPageIndex = state.currentPage;
  
  // Force reflow by reading offsetHeight
  void viewerContainer.offsetHeight;
  
  // Re-render visible pages at correct positions
  renderVisiblePages();
  
  // Restore scroll to current page
  requestAnimationFrame(() => {
    const pageEl = pagesContainer.querySelector(`[data-page-index="${currentPageIndex}"]`);
    if (pageEl) {
      pageEl.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
  });
  
  console.log('[Kiosk] Layout recalculated');
}

/**
 * Toggle sidebar visibility with proper layout recalculation.
 */
export function toggleSidebar(): void {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  
  state.sidebarVisible = !state.sidebarVisible;
  sidebar.classList.toggle('collapsed', !state.sidebarVisible);
  
  // Layout recalculation happens via transitionend listener
  // But also trigger immediate recalc for non-animated cases
  setTimeout(() => recalculateLayout(), 250);
}

/**
 * Get current sidebar visibility state.
 */
export function isSidebarVisible(): boolean {
  return state.sidebarVisible;
}

// ============================================================================
// Display Mode (Light / Dark / Night)
// ============================================================================

/**
 * Create the PDF inversion overlay for night mode.
 * This applies a color inversion filter to the PDF pages only.
 */
function createInversionOverlay(): void {
  if (document.getElementById('pdf-inversion-overlay')) {
    pdfInversionOverlay = document.getElementById('pdf-inversion-overlay');
    return;
  }
  
  pdfInversionOverlay = document.createElement('div');
  pdfInversionOverlay.id = 'pdf-inversion-overlay';
  pdfInversionOverlay.className = 'pdf-inversion-overlay';
  
  // Insert before pages-container so it covers the PDF
  pagesContainer.style.position = 'relative';
  
  console.log('[Kiosk] Inversion overlay created');
}

/**
 * Set the display mode and apply appropriate styles.
 */
export function setDisplayMode(mode: DisplayMode): void {
  state.displayMode = mode;
  localStorage.setItem('kiosk-display-mode', mode);
  applyDisplayMode(mode);
  console.log('[Kiosk] Display mode set to:', mode);
}

/**
 * Apply display mode styles without re-rendering PDF.
 * Note: The CSS handles the inversion via body.mode-night #pages-container selector.
 */
function applyDisplayMode(mode: DisplayMode): void {
  const body = document.body;
  
  // Remove all mode classes first
  body.classList.remove('mode-light', 'mode-dark', 'mode-night');
  
  // Add the appropriate mode class
  body.classList.add(`mode-${mode}`);
  
  // Update display mode button label if it exists
  const modeLabel = document.getElementById('display-mode-label');
  if (modeLabel) {
    const labels: Record<DisplayMode, string> = {
      light: 'Light',
      dark: 'Dark',
      night: 'Night'
    };
    modeLabel.textContent = labels[mode];
  }
}

/**
 * Get current display mode.
 */
export function getDisplayMode(): DisplayMode {
  return state.displayMode;
}

/**
 * Cycle through display modes: light -> dark -> night -> light
 */
export function cycleDisplayMode(): void {
  const modes: DisplayMode[] = ['light', 'dark', 'night'];
  const currentIndex = modes.indexOf(state.displayMode);
  const nextIndex = (currentIndex + 1) % modes.length;
  setDisplayMode(modes[nextIndex]);
}

// ============================================================================
// Annotation Rendering
// ============================================================================

/**
 * Render annotation overlays for all visible pages.
 */
function renderAnnotationOverlays(): void {
  if (!state.docId) return;
  
  const pages = pagesContainer.querySelectorAll('.page');
  pages.forEach((pageEl, pageIndex) => {
    const overlay = pageEl.querySelector('.annotation-overlay') as HTMLElement;
    if (!overlay) return;
    
    const pageInfo = state.pages[pageIndex];
    if (!pageInfo) return;
    
    // Clear existing annotation elements
    overlay.innerHTML = '';
    
    // Render saved annotations
    const annotations = getPageAnnotations(pageIndex);
    for (const annot of annotations) {
      const el = createAnnotationElement(annot, pageInfo, state.scale);
      if (el) {
        overlay.appendChild(el);
      }
    }
    
    // Render pending annotation
    const pending = getPendingAnnotation();
    if (pending && pending.pageIndex === pageIndex) {
      const el = createPendingAnnotationElement(pending, pageInfo, state.scale);
      if (el) {
        overlay.appendChild(el);
      }
    }
  });
}

/**
 * Create a DOM element for a saved annotation.
 */
function createAnnotationElement(
  annot: AnnotationData,
  pageInfo: PageInfo,
  scale: number
): HTMLElement | null {
  const screenRect = pdfRectToScreen(annot.rect, pageInfo, scale);
  
  const el = document.createElement('div');
  el.className = `annotation annotation-${annot.annotation_type}`;
  el.style.position = 'absolute';
  el.style.left = `${screenRect.x}px`;
  el.style.top = `${screenRect.y}px`;
  el.style.width = `${screenRect.width}px`;
  el.style.height = `${screenRect.height}px`;
  
  // Apply color and opacity
  const color = `rgba(${Math.round(annot.color.r * 255)}, ${Math.round(annot.color.g * 255)}, ${Math.round(annot.color.b * 255)}, ${annot.opacity})`;
  
  switch (annot.annotation_type) {
    case 'highlight':
      el.style.backgroundColor = color;
      el.style.mixBlendMode = 'multiply';
      break;
    case 'underline':
      el.style.borderBottom = `2px solid ${color}`;
      el.style.height = '2px';
      el.style.top = `${screenRect.y + screenRect.height - 2}px`;
      break;
    case 'strikethrough':
      el.style.borderTop = `2px solid ${color}`;
      el.style.height = '2px';
      el.style.top = `${screenRect.y + screenRect.height / 2}px`;
      break;
    case 'ink':
      // Render ink as SVG
      return createInkElement(annot, pageInfo, scale);
    case 'text':
      el.style.backgroundImage = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='%23${colorToHex(annot.color)}'%3E%3Cpath d='M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z'/%3E%3C/svg%3E")`;
      el.style.backgroundSize = 'contain';
      el.style.backgroundRepeat = 'no-repeat';
      el.style.width = '24px';
      el.style.height = '24px';
      el.title = annot.contents || '';
      break;
  }
  
  return el;
}

/**
 * Create an SVG element for an ink annotation.
 */
function createInkElement(
  annot: AnnotationData,
  pageInfo: PageInfo,
  scale: number
): HTMLElement {
  const screenRect = pdfRectToScreen(annot.rect, pageInfo, scale);
  
  const container = document.createElement('div');
  container.className = 'annotation annotation-ink';
  container.style.position = 'absolute';
  container.style.left = `${screenRect.x}px`;
  container.style.top = `${screenRect.y}px`;
  container.style.width = `${screenRect.width}px`;
  container.style.height = `${screenRect.height}px`;
  container.style.pointerEvents = 'none';
  
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.style.overflow = 'visible';
  
  const color = `rgba(${Math.round(annot.color.r * 255)}, ${Math.round(annot.color.g * 255)}, ${Math.round(annot.color.b * 255)}, ${annot.opacity})`;
  const strokeWidth = (annot.stroke_width || 2) * scale;
  
  if (annot.ink_paths) {
    for (const path of annot.ink_paths) {
      if (path.length < 2) continue;
      
      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      
      // Convert PDF points to screen coordinates relative to the container
      let d = '';
      for (let i = 0; i < path.length; i++) {
        const screenPt = pdfToScreen(path[i].x, path[i].y, pageInfo, scale);
        const x = screenPt.x - screenRect.x;
        const y = screenPt.y - screenRect.y;
        
        if (i === 0) {
          d = `M ${x} ${y}`;
        } else {
          d += ` L ${x} ${y}`;
        }
      }
      
      pathEl.setAttribute('d', d);
      pathEl.setAttribute('stroke', color);
      pathEl.setAttribute('stroke-width', String(strokeWidth));
      pathEl.setAttribute('fill', 'none');
      pathEl.setAttribute('stroke-linecap', 'round');
      pathEl.setAttribute('stroke-linejoin', 'round');
      
      svg.appendChild(pathEl);
    }
  }
  
  container.appendChild(svg);
  return container;
}

/**
 * Create a DOM element for a pending annotation being drawn.
 */
function createPendingAnnotationElement(
  pending: PendingAnnotation,
  pageInfo: PageInfo,
  scale: number
): HTMLElement | null {
  if (!pending.startPoint || !pending.endPoint) return null;
  
  const el = document.createElement('div');
  el.className = `annotation annotation-pending annotation-${pending.type}`;
  el.style.position = 'absolute';
  el.style.pointerEvents = 'none';
  
  const color = `rgba(${Math.round(pending.color.r * 255)}, ${Math.round(pending.color.g * 255)}, ${Math.round(pending.color.b * 255)}, ${pending.opacity})`;
  
  if (pending.type === 'ink' && pending.currentPath && pending.currentPath.length > 1) {
    // Create SVG for ink drawing
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.position = 'absolute';
    svg.style.top = '0';
    svg.style.left = '0';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.overflow = 'visible';
    svg.style.pointerEvents = 'none';
    
    const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    
    let d = '';
    for (let i = 0; i < pending.currentPath.length; i++) {
      const screenPt = pdfToScreen(pending.currentPath[i].x, pending.currentPath[i].y, pageInfo, scale);
      if (i === 0) {
        d = `M ${screenPt.x} ${screenPt.y}`;
      } else {
        d += ` L ${screenPt.x} ${screenPt.y}`;
      }
    }
    
    pathEl.setAttribute('d', d);
    pathEl.setAttribute('stroke', color);
    pathEl.setAttribute('stroke-width', String(pending.strokeWidth * scale));
    pathEl.setAttribute('fill', 'none');
    pathEl.setAttribute('stroke-linecap', 'round');
    pathEl.setAttribute('stroke-linejoin', 'round');
    
    svg.appendChild(pathEl);
    el.style.left = '0';
    el.style.top = '0';
    el.style.width = '100%';
    el.style.height = '100%';
    el.appendChild(svg);
    
  } else {
    // Rectangle-based annotation (highlight, underline, strikethrough)
    const start = pdfToScreen(pending.startPoint.x, pending.startPoint.y, pageInfo, scale);
    const end = pdfToScreen(pending.endPoint.x, pending.endPoint.y, pageInfo, scale);
    
    const left = Math.min(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y) || 16; // Minimum height
    
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    
    switch (pending.type) {
      case 'highlight':
        el.style.backgroundColor = color;
        el.style.mixBlendMode = 'multiply';
        break;
      case 'underline':
        el.style.borderBottom = `2px solid ${color}`;
        el.style.height = '2px';
        break;
      case 'strikethrough':
        el.style.borderTop = `2px solid ${color}`;
        el.style.height = '2px';
        el.style.top = `${top + height / 2}px`;
        break;
    }
  }
  
  return el;
}

/**
 * Convert annotation color to hex string.
 */
function colorToHex(color: AnnotationColor): string {
  const r = Math.round(color.r * 255).toString(16).padStart(2, '0');
  const g = Math.round(color.g * 255).toString(16).padStart(2, '0');
  const b = Math.round(color.b * 255).toString(16).padStart(2, '0');
  return `${r}${g}${b}`;
}

// ============================================================================
// Text Selection Annotations
// ============================================================================

/**
 * Apply annotation to the current text selection.
 * Returns true if annotation was applied, false if no valid selection.
 */
export function applyAnnotationToSelection(
  tool: 'highlight' | 'underline' | 'strikethrough'
): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    return false;
  }
  
  const range = selection.getRangeAt(0);
  
  // Find which page this selection is on
  let pageElement = range.commonAncestorContainer as HTMLElement;
  while (pageElement && !pageElement.classList?.contains('page')) {
    pageElement = pageElement.parentElement as HTMLElement;
  }
  
  if (!pageElement) return false;
  
  // Get page index from data attribute or DOM position
  const pageIndex = parseInt(pageElement.dataset.pageIndex || '0', 10);
  
  // Get selection bounding rect relative to page
  const selectionRect = range.getBoundingClientRect();
  const pageRect = pageElement.getBoundingClientRect();
  
  const relativeRect = {
    x: selectionRect.left - pageRect.left,
    y: selectionRect.top - pageRect.top,
    width: selectionRect.width,
    height: selectionRect.height,
  };
  
  // Add the annotation
  addTextSelectionAnnotation(pageIndex, relativeRect, state.scale, tool);
  
  // Clear selection after applying
  selection.removeAllRanges();
  
  return true;
}

// ============================================================================
// Export annotation functions for external use
// ============================================================================

export { 
  setAnnotationTool,
  getAnnotationTool,
  saveAllAnnotations,
  hasUnsavedChanges,
  type AnnotationTool,
};

// ============================================================================
// Export state for debugging
// ============================================================================

export { state as viewerState };
