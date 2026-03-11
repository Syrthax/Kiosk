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
  decodeBase64Rgba,
  createRgbaImageData,
  fileToBytes,
  type LoadResult,
  type LoadPdfResult,
  type PageInfo,
  type CharRect,
  type SearchResult,
  type RenderResult,
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

/**
 * Phase 1 diagnostic flag. Set to true to enable detailed render-cycle
 * logging in the browser console. Disable before release.
 */
const DEBUG_RENDER_DIAGNOSTICS = true;

/** Maximum number of concurrent thumbnail IPC render calls. */
const THUMBNAIL_CONCURRENCY = 2;

/** Phase 2: time (ms) after last interaction before upgrading to high-res. */
const SETTLE_DELAY = 200;

// Render lifecycle states (Phase 2)
export type RenderState = 'IDLE' | 'SCROLLING' | 'ZOOMING' | 'SETTLING' | 'UPGRADING';

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
  renderedPages: Set<number>; // Phase 4: track which pages have a canvas render (no blob URLs)
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
  // Phase 1: render cycle tracking to discard stale IPC results
  renderCycleId: number;
  // Phase 2: render lifecycle state machine
  renderState: RenderState;
  isUserInteracting: boolean;
  lastInteractionTimestamp: number;
  // Phase 2: actual render scale per page, for upgrade detection
  renderedScales: Map<number, number>;
}

const state: ViewerState = {
  docId: null,
  pages: [],
  currentPage: 0,
  scale: DEFAULT_ZOOM,
  renderedPages: new Set(),
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
  renderCycleId: 0,
  renderState: 'IDLE' as RenderState,
  isUserInteracting: false,
  lastInteractionTimestamp: 0,
  renderedScales: new Map(),
};

/** Phase 1 diagnostic logger — no-op when flag is off. */
function diag(...args: unknown[]): void {
  if (DEBUG_RENDER_DIAGNOSTICS) {
    console.log('[Kiosk Diag]', ...args);
  }
}

/** Phase 2 diagnostic logger. */
function diagP2(...args: unknown[]): void {
  if (DEBUG_RENDER_DIAGNOSTICS) {
    console.log('[Kiosk Phase2]', ...args);
  }
}

// ============================================================================
// Phase 2 — Render Lifecycle State Machine
// ============================================================================

let settleTimerId: number | undefined;
let upgradeQueue: number[] = [];
let upgradeInFlight = false;

// ============================================================================
// Phase 4.5 — Live GPU Transform Zoom State
// ============================================================================

/** Whether a CSS-transform-based live zoom is in progress. */
let liveZoomActive = false;
/** state.scale at the moment live zoom started (frozen during gesture). */
let liveZoomBaseScale = 1.0;
/** Current target scale during the live zoom gesture. */
let liveZoomTargetScale = 1.0;
/** Focal point as a ratio within pagesContainer scrollWidth. */
let liveZoomFocalRatioX = 0.5;
/** Focal point as a ratio within pagesContainer scrollHeight. */
let liveZoomFocalRatioY = 0.5;
/** Focal point viewport-relative X (for scroll restore on commit). */
let liveZoomFocalViewX = 0;
/** Focal point viewport-relative Y (for scroll restore on commit). */
let liveZoomFocalViewY = 0;

/** Transition render state with diagnostic logging. */
function transitionRenderState(newState: RenderState): void {
  if (state.renderState === newState) return;
  diagP2(`STATE ${state.renderState} → ${newState}`);
  state.renderState = newState;
}

/**
 * Mark an ongoing user interaction (scroll or zoom).
 * Cancels any in-progress upgrade, transitions to the appropriate
 * interaction state, and resets the settle timer.
 */
function markInteraction(reason: 'scroll' | 'zoom'): void {
  state.isUserInteracting = true;
  state.lastInteractionTimestamp = Date.now();

  // Cancel any in-progress upgrade immediately
  cancelUpgrade();

  const target: RenderState = reason === 'scroll' ? 'SCROLLING' : 'ZOOMING';
  if (state.renderState !== target) {
    transitionRenderState(target);
  }

  scheduleSettle();
}

/**
 * Schedule (or reschedule) the settle timer. After SETTLE_DELAY ms of
 * no interaction, the system transitions SETTLING → IDLE and checks
 * whether visible pages need a high-resolution upgrade.
 */
function scheduleSettle(): void {
  if (settleTimerId !== undefined) {
    clearTimeout(settleTimerId);
  }
  settleTimerId = window.setTimeout(() => {
    settleTimerId = undefined;
    state.isUserInteracting = false;

    // Phase 4.5: commit pending live-zoom CSS transform before settle
    if (liveZoomActive) {
      commitLiveZoom();
    }

    transitionRenderState('SETTLING');
    // Brief SETTLING → IDLE
    transitionRenderState('IDLE');
    maybeStartUpgrade();
  }, SETTLE_DELAY);
}

/** Cancel the settle timer if active. */
function cancelSettle(): void {
  if (settleTimerId !== undefined) {
    clearTimeout(settleTimerId);
    settleTimerId = undefined;
  }
}

/**
 * Cancel any in-progress or queued high-res upgrade work.
 * The in-flight IPC (if any) will be caught by the renderCycleId
 * check when it resolves.
 */
function cancelUpgrade(): void {
  if (state.renderState === 'UPGRADING' || upgradeQueue.length > 0 || upgradeInFlight) {
    diagP2(`UPGRADE cancelled (interaction resumed) remaining=${upgradeQueue.length} inFlight=${upgradeInFlight}`);
  }
  upgradeQueue = [];
  upgradeInFlight = false;
}

/**
 * Check whether visible pages need a high-resolution upgrade.
 * If so, transition to UPGRADING and begin sequential processing.
 */
function maybeStartUpgrade(): void {
  if (state.renderState !== 'IDLE') return;
  if (!state.docId) return;

  // Phase 5: in deep zoom, skip entirely if an upgrade is already in flight
  const deepZoom = isDeepZoom();
  if (deepZoom && upgradeInFlight) {
    diagP5('Deep zoom: upgrade already in flight, skipping');
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  // Phase 5: cap DPR multiplier in deep zoom to limit GPU/CPU cost
  const effectiveDpr = deepZoom ? Math.min(dpr, 1.5) : dpr;
  const targetScale = state.scale * effectiveDpr;
  const visibleRange = getVisiblePageRange();

  upgradeQueue = [];
  for (let i = visibleRange.start; i <= visibleRange.end; i++) {
    if (i < 0 || i >= state.pages.length) continue;
    const currentScale = state.renderedScales.get(i);
    // Upgrade if page was never rendered or rendered at a lower scale
    if (currentScale === undefined || currentScale < targetScale * 0.95) {
      upgradeQueue.push(i);
    }
  }

  // Phase 5: in deep zoom, limit upgrade queue to one page at a time
  if (deepZoom && upgradeQueue.length > 1) {
    upgradeQueue = upgradeQueue.slice(0, 1);
    diagP5(`Deep zoom: limited upgrade queue to 1 page`);
  }

  if (upgradeQueue.length === 0) {
    diagP2('No pages need upgrade');
    return;
  }

  diagP2(`HIGH-RES upgrade queued pages=[${upgradeQueue.join(',')}]`);
  transitionRenderState('UPGRADING');
  drainUpgradeQueue();
}

/**
 * Process the upgrade queue one page at a time.
 * Respects renderCycleId from Phase 1 to discard stale results.
 * If the user interacts during upgrade, the queue is cancelled by
 * markInteraction → cancelUpgrade.
 */
async function drainUpgradeQueue(): Promise<void> {
  if (upgradeInFlight) return;
  if (state.renderState !== 'UPGRADING') return;

  const pageIndex = upgradeQueue.shift();
  if (pageIndex === undefined) {
    // Queue drained — return to IDLE
    transitionRenderState('IDLE');
    diagP2('Upgrade queue drained');
    return;
  }

  upgradeInFlight = true;
  const cycleId = state.renderCycleId;

  try {
    const dpr = window.devicePixelRatio || 1;
    // Phase 5: cap DPR in deep zoom
    const effectiveDpr = isDeepZoom() ? Math.min(dpr, 1.5) : dpr;
    const renderScale = state.scale * effectiveDpr;

    diagP2(`HIGH-RES upgrade START page=${pageIndex} scale=${renderScale.toFixed(2)} cycleId=${cycleId}`);
    const result: RenderResult = await renderPage(state.docId!, pageIndex, renderScale);

    // Check if still valid after IPC round-trip
    if (cycleId !== state.renderCycleId || state.renderState !== 'UPGRADING') {
      diagP2(`HIGH-RES upgrade DISCARDED (stale) page=${pageIndex}`);
      upgradeInFlight = false;
      return;
    }

    const pageEl = pagesContainer.querySelector(`[data-page-index="${pageIndex}"]`);
    if (!pageEl) {
      upgradeInFlight = false;
      drainUpgradeQueue();
      return;
    }

    // Phase 4: decode RGBA → ImageData → createImageBitmap → canvas
    const rgba = decodeBase64Rgba(result.pixels);
    const imageData = createRgbaImageData(rgba, result.width, result.height);
    const bitmap = await createImageBitmap(imageData);

    // Re-check staleness after async createImageBitmap
    if (cycleId !== state.renderCycleId || state.renderState !== 'UPGRADING') {
      bitmap.close();
      diagP2(`HIGH-RES upgrade DISCARDED (stale after bitmap) page=${pageIndex}`);
      upgradeInFlight = false;
      return;
    }

    const canvas = pageEl.querySelector('canvas.page-canvas') as HTMLCanvasElement;
    if (canvas) {
      canvas.width = result.width;
      canvas.height = result.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0);
      }
    }
    bitmap.close();

    state.renderedPages.add(pageIndex);
    state.renderedScales.set(pageIndex, renderScale);

    diagP2(`HIGH-RES upgrade applied page=${pageIndex} ${result.width}x${result.height}`);
  } catch (err) {
    console.error(`Failed to upgrade page ${pageIndex}:`, err);
  } finally {
    upgradeInFlight = false;
    drainUpgradeQueue();
  }
}

// ============================================================================
// Phase 4.5 — Live GPU Transform Zoom
// ============================================================================

/** Phase 4.5 diagnostic logger. */
function diagP45(...args: unknown[]): void {
  if (DEBUG_RENDER_DIAGNOSTICS) {
    console.log('[Kiosk Phase4.5]', ...args);
  }
}

/** Phase 5 diagnostic logger. */
function diagP5(...args: unknown[]): void {
  if (DEBUG_RENDER_DIAGNOSTICS) {
    console.log('[Kiosk Phase5]', ...args);
  }
}

/**
 * Phase 5: Compute the "fit width" scale — the scale at which the current
 * page fills the viewport width.  Used to determine whether we are in
 * deep-zoom mode (state.scale > pageFitScale * 1.8).
 */
function getPageFitScale(): number {
  if (state.pages.length === 0) return 1.0;
  const containerWidth = viewerContainer.clientWidth - 40; // 20px padding each side
  const page = state.pages[state.currentPage] || state.pages[0];
  return containerWidth / page.width;
}

/**
 * Phase 5: Returns true when the user has zoomed far enough beyond fit-width
 * that we should activate deep-zoom resource conservation.
 */
function isDeepZoom(): boolean {
  return state.scale > getPageFitScale() * 1.8;
}

/**
 * Phase 4.5: Begin a live GPU-accelerated zoom.
 *
 * Records the current scale and focal point, applies `will-change: transform`
 * to the pages container, and sets the CSS transform-origin so that subsequent
 * calls to `updateLiveZoom` produce a smooth visual scale around the focal
 * point with no backend renders.
 */
function enterLiveZoom(focalClientX: number, focalClientY: number): void {
  liveZoomActive = true;
  liveZoomBaseScale = state.scale;
  liveZoomTargetScale = state.scale;

  const viewerRect = viewerContainer.getBoundingClientRect();

  // Focal point as a proportion within the scroll area (for scroll restore on commit)
  liveZoomFocalRatioX = (focalClientX - viewerRect.left + viewerContainer.scrollLeft) / (pagesContainer.scrollWidth || 1);
  liveZoomFocalRatioY = (focalClientY - viewerRect.top + viewerContainer.scrollTop) / (pagesContainer.scrollHeight || 1);

  // Focal point viewport-relative position (constant during gesture)
  liveZoomFocalViewX = focalClientX - viewerRect.left;
  liveZoomFocalViewY = focalClientY - viewerRect.top;

  // Transform origin in pagesContainer-local coordinates
  const pagesRect = pagesContainer.getBoundingClientRect();
  const originX = focalClientX - pagesRect.left;
  const originY = focalClientY - pagesRect.top;

  pagesContainer.style.transformOrigin = `${originX}px ${originY}px`;
  pagesContainer.style.willChange = 'transform';

  diagP45(`ENTER base=${liveZoomBaseScale.toFixed(3)} origin=(${originX.toFixed(0)}, ${originY.toFixed(0)})`);
}

/**
 * Phase 4.5: Update the live zoom CSS transform.
 *
 * No IPC calls, no DOM mutations beyond the single `transform` property.
 * Runs at gesture/wheel frequency (~60 Hz) without triggering layout/paint.
 */
function updateLiveZoom(newTargetScale: number): void {
  liveZoomTargetScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newTargetScale));
  const ratio = liveZoomTargetScale / liveZoomBaseScale;
  pagesContainer.style.transform = `scale(${ratio})`;

  // Update zoom label to reflect live scale
  if (zoomLabel) {
    zoomLabel.textContent = `${Math.round(liveZoomTargetScale * 100)}%`;
  }
}

/**
 * Phase 4.5: Commit the live zoom.
 *
 * 1. Remove the CSS transform (visual snap-back to un-transformed layout).
 * 2. Update state.scale to the target scale.
 * 3. Resize all page containers to the new scale.
 * 4. Adjust scroll position so the focal point remains at its original
 *    viewport-relative position.
 * 5. Mark all pages as needing re-render (but do NOT clear canvas backing
 *    stores — the existing content at the old scale serves as a placeholder
 *    until the new renders arrive).
 * 6. Trigger renderVisiblePages for immediate low-res feedback.
 *
 * The normal render lifecycle (SETTLING → UPGRADING) handles high-res
 * upgrade after this function returns.
 */
function commitLiveZoom(): void {
  if (!liveZoomActive) return;

  diagP45(`COMMIT base=${liveZoomBaseScale.toFixed(3)} → target=${liveZoomTargetScale.toFixed(3)}`);

  // ── Remove CSS transform ──────────────────────────────────────────
  pagesContainer.style.transform = '';
  pagesContainer.style.willChange = '';
  pagesContainer.style.transformOrigin = '';

  // ── Update logical scale ──────────────────────────────────────────
  state.scale = liveZoomTargetScale;

  // ── Resize page containers ────────────────────────────────────────
  const pages = pagesContainer.querySelectorAll('.page');
  pages.forEach((pageEl, i) => {
    const page = state.pages[i];
    if (!page) return;
    const el = pageEl as HTMLElement;
    el.style.width = `${page.width * state.scale}px`;
    el.style.height = `${page.height * state.scale}px`;
  });

  // ── Adjust scroll to keep focal point at its viewport position ────
  viewerContainer.scrollLeft =
    liveZoomFocalRatioX * pagesContainer.scrollWidth - liveZoomFocalViewX;
  viewerContainer.scrollTop =
    liveZoomFocalRatioY * pagesContainer.scrollHeight - liveZoomFocalViewY;

  // ── Mark pages for re-render WITHOUT clearing canvas content ──────
  // Existing canvases keep their pixel data (at the old scale, CSS-stretched)
  // until new renders overwrite them — no blank-page flash.
  state.renderedPages.clear();
  state.renderedScales.clear();
  state.charRects.clear();

  // Clear text overlay spans (stale positions at old scale)
  pagesContainer.querySelectorAll('.text-overlay').forEach(el => {
    (el as HTMLElement).innerHTML = '';
  });

  liveZoomActive = false;

  // ── Re-render visible pages (low-res during interaction) ──────────
  renderVisiblePages();
  updateZoomLabel();

  // ── Refresh annotation overlays at new scale ──────────────────────
  renderAnnotationOverlays();
}

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

  // Phase 4.5: enter live GPU zoom
  enterLiveZoom(e.clientX, e.clientY);

  markInteraction('zoom');
}

function handleGestureChange(e: GestureEvent): void {
  e.preventDefault();
  if (!state.isPinching) return;
  
  // Phase 4.5: compute target scale from cumulative gesture scale.
  // Safari gesturechange e.scale is cumulative from gesturestart (starts at 1.0).
  const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, state.gestureStartScale * e.scale));

  state.lastPinchScale = e.scale;

  markInteraction('zoom');

  // Phase 4.5: GPU transform — no backend renders, no DOM resize
  updateLiveZoom(newScale);
}

function handleGestureEnd(e: GestureEvent): void {
  e.preventDefault();
  state.isPinching = false;

  // Phase 4.5: commit the live GPU zoom transform.
  // Resizes page containers to the target scale and triggers low-res renders.
  // Existing canvas content serves as placeholder until new renders arrive.
  commitLiveZoom();

  // Phase 2: schedule settle for high-res upgrade after SETTLE_DELAY.
  scheduleSettle();
}

function handleWheel(e: WheelEvent): void {
  // Check if this is a pinch gesture (ctrlKey is set on trackpad pinch in Chrome/Firefox)
  if (e.ctrlKey) {
    e.preventDefault();
    markInteraction('zoom');

    // Phase 4.5: enter live GPU zoom on first ctrl+wheel event
    if (!liveZoomActive) {
      enterLiveZoom(e.clientX, e.clientY);
    }

    // Calculate zoom change (negative deltaY = zoom in)
    const zoomDelta = -e.deltaY * PINCH_SENSITIVITY;
    const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, liveZoomTargetScale * (1 + zoomDelta)));

    // Phase 4.5: GPU transform — no backend renders, no DOM resize
    updateLiveZoom(newScale);
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

export async function openFile(path: string, password: string | null = null): Promise<void> {
  setLoading(true);
  try {
    // Close previous document (only on first attempt, not retry)
    if (!password && state.docId) {
      await closePdf(state.docId);
      resetAnnotations();
      clearRenderedPages();
    }

    // Load new document — password is null on first attempt
    const result = await loadPdf(path, password);
    const handled = await handleLoadResult(result, path, null, null);
    if (!handled) {
      // handleLoadResult showed modal — loading flag stays off until retry
    }
  } catch (err) {
    console.error('Failed to load PDF:', err);
    showError(`Failed to load PDF: ${err}`);
  } finally {
    setLoading(false);
  }
}

export async function openBytes(bytes: Uint8Array, fileName?: string, password: string | null = null): Promise<void> {
  setLoading(true);
  try {
    // Close previous document (only on first attempt, not retry)
    if (!password && state.docId) {
      await closePdf(state.docId);
      resetAnnotations();
      clearRenderedPages();
    }

    // Load new document
    const result = await loadPdfBytes(bytes, password);
    const handled = await handleLoadResult(result, null, bytes, fileName ?? null);
    if (!handled) {
      // handleLoadResult showed modal — loading flag stays off until retry
    }
  } catch (err) {
    console.error('Failed to load PDF:', err);
    showError(`Failed to load PDF: ${err}`);
  } finally {
    setLoading(false);
  }
}

/**
 * Process the tagged LoadPdfResult from the backend.
 * Returns true if the document loaded successfully, false if modal was shown.
 */
async function handleLoadResult(
  result: LoadPdfResult,
  filePath: string | null,
  fileBytes: Uint8Array | null,
  fileName: string | null,
): Promise<boolean> {
  switch (result.status) {
    case 'Success':
      await initializeDocument(result.data);
      if (fileName) {
        document.title = `Kiosk - ${fileName}`;
      }
      return true;

    case 'PasswordRequired':
      showPasswordModal(filePath, fileBytes, fileName, false);
      return false;

    case 'InvalidPassword':
      showPasswordModal(filePath, fileBytes, fileName, true);
      return false;

    case 'Error':
      showError(`Failed to load PDF: ${result.message}`);
      return false;

    default:
      showError('Unexpected response from PDF loader');
      return false;
  }
}

// ============================================================================
// Password Modal
// ============================================================================

/**
 * Show the password modal overlay. Password is never stored — only held
 * in memory for the retry invoke call, then discarded.
 */
function showPasswordModal(
  filePath: string | null,
  fileBytes: Uint8Array | null,
  fileName: string | null,
  showError: boolean,
): void {
  // Create modal if it doesn't exist yet
  let modal = document.getElementById('password-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'password-modal';
    modal.className = 'password-modal-overlay';
    modal.innerHTML = `
      <div class="password-modal">
        <h3 class="password-modal-title">Password Protected PDF</h3>
        <p class="password-modal-desc">This PDF requires a password to open.</p>
        <p id="password-error" class="password-modal-error" style="display:none;">Incorrect password. Please try again.</p>
        <input id="password-input" type="password" class="password-modal-input" placeholder="Enter password" autocomplete="off" />
        <div class="password-modal-buttons">
          <button id="password-cancel" class="password-modal-btn password-modal-cancel">Cancel</button>
          <button id="password-submit" class="password-modal-btn password-modal-submit">Open</button>
        </div>
      </div>
    `;
    document.getElementById('app')!.appendChild(modal);
  }

  // Reset state
  const input = document.getElementById('password-input') as HTMLInputElement;
  const errorEl = document.getElementById('password-error')!;
  input.value = '';
  errorEl.style.display = showError ? '' : 'none';
  modal.style.display = 'flex';

  // Focus the input after a tick (for transition)
  requestAnimationFrame(() => input.focus());

  // Wire up handlers (remove old ones first to avoid duplicates)
  const submitBtn = document.getElementById('password-submit')!;
  const cancelBtn = document.getElementById('password-cancel')!;

  const handleSubmit = async () => {
    const pw = input.value;
    if (!pw) return;
    hidePasswordModal();
    // Retry with password — password lives only in this closure scope
    if (filePath) {
      await openFile(filePath, pw);
    } else if (fileBytes) {
      await openBytes(fileBytes, fileName ?? undefined, pw);
    }
  };

  const handleCancel = () => {
    hidePasswordModal();
  };

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') handleSubmit();
    if (e.key === 'Escape') handleCancel();
  };

  // Clean up old listeners by cloning nodes
  const newSubmit = submitBtn.cloneNode(true) as HTMLElement;
  const newCancel = cancelBtn.cloneNode(true) as HTMLElement;
  submitBtn.replaceWith(newSubmit);
  cancelBtn.replaceWith(newCancel);
  newSubmit.addEventListener('click', handleSubmit);
  newCancel.addEventListener('click', handleCancel);
  input.addEventListener('keydown', handleKeydown, { once: false });
  // Clean up on hide
  (modal as any)._keydownHandler = handleKeydown;
}

/** Hide the password modal and clean up. */
function hidePasswordModal(): void {
  const modal = document.getElementById('password-modal');
  if (modal) {
    modal.style.display = 'none';
    const input = document.getElementById('password-input') as HTMLInputElement;
    // Clear password from memory
    if (input) input.value = '';
    // Remove keydown handler
    if ((modal as any)._keydownHandler) {
      input?.removeEventListener('keydown', (modal as any)._keydownHandler);
      delete (modal as any)._keydownHandler;
    }
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

    // Phase 4: Canvas element for rendered page (replaces <img>)
    const canvas = document.createElement('canvas');
    canvas.className = 'page-canvas';
    // CSS sizing — fills the page container
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    // Bitmap size will be set at render time to match actual pixel dimensions
    canvas.width = 0;
    canvas.height = 0;
    pageEl.appendChild(canvas);

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

  // Phase 1: increment cycle so in-flight renders from previous calls are
  // detected as stale when they complete.
  state.renderCycleId++;
  const cycleId = state.renderCycleId;

  // Phase 2: determine render quality based on interaction state
  const isInteracting = state.isUserInteracting ||
                         state.renderState === 'SCROLLING' ||
                         state.renderState === 'ZOOMING' ||
                         state.renderState === 'SETTLING';
  diag(`renderVisiblePages: cycleId=${cycleId} lowRes=${isInteracting} state=${state.renderState}`);

  const visibleRange = getVisiblePageRange();
  const pagesToRender = new Set<number>();

  // Phase 5: in deep zoom, render only visible pages (no buffer)
  const deepZoom = isDeepZoom();
  const buffer = deepZoom ? 0 : RENDER_BUFFER;
  if (deepZoom) {
    diagP5(`Deep zoom active: scale=${state.scale.toFixed(2)} fitScale=${getPageFitScale().toFixed(2)} buffer=0`);
  }

  // Add visible pages plus buffer
  for (let i = visibleRange.start - buffer; i <= visibleRange.end + buffer; i++) {
    if (i >= 0 && i < state.pages.length) {
      pagesToRender.add(i);
    }
  }

  // Render pages that aren't already rendered
  const renderPromises: Promise<void>[] = [];
  for (const pageIndex of pagesToRender) {
    if (!state.renderedPages.has(pageIndex)) {
      renderPromises.push(renderPageToContainer(pageIndex, cycleId, isInteracting));
    }
  }

  await Promise.all(renderPromises);

  // Unload pages far from viewport to save memory
  const unloadThreshold = RENDER_BUFFER * 2;
  for (const pageIndex of state.renderedPages) {
    if (pageIndex < visibleRange.start - unloadThreshold || pageIndex > visibleRange.end + unloadThreshold) {
      unloadPage(pageIndex);
    }
  }
}

/**
 * Render a single page and paint the result to the page's <canvas>.
 *
 * Phase 1 safety:
 * - Captures `cycleId` at call-time; if the global `renderCycleId` has
 *   advanced by the time the IPC resolves, the result is discarded.
 * - Checks the page container still exists before writing to canvas.
 *
 * Phase 4 change:
 * - Receives RGBA pixel buffer (base64-encoded) instead of PNG bytes.
 * - Decodes to Uint8ClampedArray → ImageData → createImageBitmap → canvas.
 * - No blob URLs created or revoked.
 */
async function renderPageToContainer(pageIndex: number, cycleId: number, lowRes = false): Promise<void> {
  if (!state.docId) return;

  try {
    // Render at device pixel ratio for HiDPI
    const dpr = window.devicePixelRatio || 1;
    // Phase 5: cap DPR multiplier in deep zoom to limit CPU/GPU cost
    const effectiveDpr = isDeepZoom() ? Math.min(dpr, 1.5) : dpr;
    let renderScale: number;

    if (lowRes) {
      // Phase 2: cap render scale during interaction to reduce IPC cost.
      renderScale = Math.min(1.0, state.scale);
      diagP2(`LOW-RES render page=${pageIndex} scale=${renderScale.toFixed(2)}`);
    } else {
      renderScale = state.scale * effectiveDpr;
    }

    diag(`render START page=${pageIndex} scale=${renderScale.toFixed(2)} cycleId=${cycleId}`);
    const result: RenderResult = await renderPage(state.docId, pageIndex, renderScale);

    // ── Phase 1: stale-render guard ──────────────────────────────────
    if (cycleId !== state.renderCycleId) {
      diag(`render DISCARDED (stale) page=${pageIndex} cycleId=${cycleId} current=${state.renderCycleId}`);
      return;
    }

    // Verify page container still exists (document may have been switched)
    const pageEl = pagesContainer.querySelector(`[data-page-index="${pageIndex}"]`);
    if (!pageEl) {
      diag(`render DISCARDED (no container) page=${pageIndex}`);
      return;
    }

    // Phase 4: decode base64 → RGBA → ImageData → createImageBitmap → canvas
    const rgba = decodeBase64Rgba(result.pixels);
    const imageData = createRgbaImageData(rgba, result.width, result.height);
    const bitmap = await createImageBitmap(imageData);

    // Re-check staleness after async createImageBitmap
    if (cycleId !== state.renderCycleId) {
      bitmap.close();
      diag(`render DISCARDED (stale after bitmap) page=${pageIndex}`);
      return;
    }

    const canvas = pageEl.querySelector('canvas.page-canvas') as HTMLCanvasElement;
    if (canvas) {
      // Set canvas bitmap dimensions to match rendered pixels
      canvas.width = result.width;
      canvas.height = result.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0);
      }
    }
    bitmap.close(); // free GPU/CPU resources

    state.renderedPages.add(pageIndex);
    // Phase 2: track the actual scale this page was rendered at
    state.renderedScales.set(pageIndex, renderScale);

    diag(`render APPLIED page=${pageIndex} cycleId=${cycleId} scale=${renderScale.toFixed(2)} ${result.width}x${result.height}`);

    // Load char rects for text selection
    if (!state.charRects.has(pageIndex)) {
      const rects = await getCharRects(state.docId!, pageIndex);
      state.charRects.set(pageIndex, rects);
      buildTextOverlay(pageIndex, rects);
    }
  } catch (err) {
    console.error(`Failed to render page ${pageIndex}:`, err);
  }
}

function unloadPage(pageIndex: number): void {
  if (state.renderedPages.has(pageIndex)) {
    state.renderedPages.delete(pageIndex);

    // Phase 4: clear canvas instead of revoking blob URL
    const pageEl = pagesContainer.querySelector(`[data-page-index="${pageIndex}"]`);
    const canvas = pageEl?.querySelector('canvas.page-canvas') as HTMLCanvasElement;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

function clearRenderedPages(): void {
  // Phase 1: increment renderCycleId so any in-flight IPC results from
  // the previous cycle will be discarded on arrival.
  state.renderCycleId++;
  diag(`clearRenderedPages: new cycleId=${state.renderCycleId}`);

  // Phase 4: no blob URLs to revoke — just clear the set and canvas elements
  for (const pageIndex of state.renderedPages) {
    const pageEl = pagesContainer.querySelector(`[data-page-index="${pageIndex}"]`);
    const canvas = pageEl?.querySelector('canvas.page-canvas') as HTMLCanvasElement;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      canvas.width = 0;
      canvas.height = 0;
    }
  }
  state.renderedPages.clear();
  state.charRects.clear();
  // Phase 2: clear scale tracking
  state.renderedScales.clear();
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

/**
 * Phase 1: thumbnail render queue with bounded concurrency.
 * Prevents the IPC stampede diagnosed in M-5 / C-3.
 */
let thumbnailQueue: Array<{ pageIndex: number; canvas: HTMLCanvasElement; scale: number }> = [];
let thumbnailsInFlight = 0;
let thumbnailDocId: string | null = null;

/**
 * Drain the thumbnail queue, launching up to THUMBNAIL_CONCURRENCY renders
 * at a time. Each completion triggers the next item in the queue.
 */
function drainThumbnailQueue(): void {
  while (thumbnailsInFlight < THUMBNAIL_CONCURRENCY && thumbnailQueue.length > 0) {
    const item = thumbnailQueue.shift()!;
    thumbnailsInFlight++;
    diag(`thumbnail START page=${item.pageIndex} queueLen=${thumbnailQueue.length} inFlight=${thumbnailsInFlight}`);
    renderThumbnailThrottled(item.pageIndex, item.canvas, item.scale)
      .finally(() => {
        thumbnailsInFlight--;
        drainThumbnailQueue();
      });
  }
}

async function createThumbnails(): Promise<void> {
  if (!state.docId) return;

  // Reset thumbnail queue for this document
  thumbnailQueue = [];
  thumbnailsInFlight = 0;
  thumbnailDocId = state.docId;

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

    // Phase 4: use canvas for thumbnails too
    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.width = 0;
    canvas.height = 0;
    thumbEl.appendChild(canvas);

    const label = document.createElement('span');
    label.className = 'thumbnail-label';
    label.textContent = String(i + 1);
    thumbEl.appendChild(label);

    thumbnailsContainer.appendChild(thumbEl);

    // Phase 1: enqueue instead of firing immediately
    thumbnailQueue.push({ pageIndex: i, canvas, scale: thumbnailScale });
  }

  diag(`thumbnails: enqueued ${thumbnailQueue.length} items, concurrency=${THUMBNAIL_CONCURRENCY}`);

  // Kick off the bounded drain
  drainThumbnailQueue();

  updateThumbnailHighlight();
}

/**
 * Render a single thumbnail via IPC. If the document has changed since the
 * queue was created, the render is skipped.
 *
 * Phase 4: paints to canvas instead of setting img.src with blob URL.
 */
async function renderThumbnailThrottled(pageIndex: number, canvas: HTMLCanvasElement, scale: number): Promise<void> {
  // Skip if document changed while queued
  if (!state.docId || state.docId !== thumbnailDocId) {
    diag(`thumbnail SKIPPED (doc changed) page=${pageIndex}`);
    return;
  }

  try {
    const result: RenderResult = await renderPage(state.docId, pageIndex, scale);

    // Verify document still matches after IPC round-trip
    if (state.docId !== thumbnailDocId) {
      diag(`thumbnail DISCARDED (doc changed after IPC) page=${pageIndex}`);
      return;
    }

    // Verify canvas element is still in the DOM
    if (!canvas.isConnected) {
      diag(`thumbnail DISCARDED (canvas disconnected) page=${pageIndex}`);
      return;
    }

    // Phase 4: decode RGBA → ImageData → createImageBitmap → canvas
    const rgba = decodeBase64Rgba(result.pixels);
    const imageData = createRgbaImageData(rgba, result.width, result.height);
    const bitmap = await createImageBitmap(imageData);

    canvas.width = result.width;
    canvas.height = result.height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0);
    }
    bitmap.close();
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
  // Phase 4.5: if a live zoom is active when the user scrolls, commit it
  // so layout matches the actual scroll coordinate space.
  if (liveZoomActive) {
    commitLiveZoom();
  }

  markInteraction('scroll');

  const range = getVisiblePageRange();
  if (range.start !== state.currentPage) {
    state.currentPage = range.start;
    updatePageCounter();
    updateThumbnailHighlight();
  }

  // Render newly visible pages (low-res during SCROLLING)
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
  // Phase 4.5: if a live zoom is active, commit it first
  if (liveZoomActive) {
    commitLiveZoom();
  }

  // Clamp scale to valid range
  newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newScale));
  
  if (newScale === state.scale) return;

  // Phase 2: mark as zoom interaction and schedule settle for upgrade
  markInteraction('zoom');
  
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
 * NOTE: Superseded by Phase 4.5 live GPU zoom (enterLiveZoom / updateLiveZoom
 * / commitLiveZoom).  Retained as dead code with suppression for reference.
 */
// @ts-ignore: TS6133 — retained as Phase 3 fallback reference
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _setZoomSmooth(newScale: number, _centerX?: number, _centerY?: number): void {
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
  _debouncedRender();
}

// Debounced render for smooth gesture zooming (Phase 3 fallback — unused in Phase 4.5+)
// @ts-ignore: TS6133 — retained as fallback reference
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _debouncedRender = debounce(() => {
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
  // Phase 4.5: clean up live zoom state if active
  if (liveZoomActive) {
    pagesContainer.style.transform = '';
    pagesContainer.style.willChange = '';
    pagesContainer.style.transformOrigin = '';
    liveZoomActive = false;
  }

  // Phase 2: cancel all pending timers and upgrade work
  cancelSettle();
  cancelUpgrade();
  transitionRenderState('IDLE');

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

  // Phase 4.5: commit live zoom before recalculation
  if (liveZoomActive) {
    commitLiveZoom();
  }
  
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
