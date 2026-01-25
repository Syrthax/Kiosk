/**
 * Kiosk PDF Viewer - Annotation Manager
 *
 * Handles annotation state, coordinate mapping between screen and PDF space,
 * and interaction with the annotation tools.
 */

import {
  AnnotationData,
  AnnotationType,
  PdfPoint,
  PdfRect,
  AnnotationColor,
  getDocumentPath,
  getAnnotations,
  saveAnnotations,
  removeAnnotation,
  PageInfo,
} from './pdf-api';

// ============================================================================
// Types
// ============================================================================

/** Annotation tool types */
export type AnnotationTool = 
  | 'select'
  | 'highlight' 
  | 'underline' 
  | 'strikethrough' 
  | 'pen' 
  | 'text' 
  | 'eraser';

/** Pending annotation being drawn */
export interface PendingAnnotation {
  type: AnnotationType;
  pageIndex: number;
  color: AnnotationColor;
  opacity: number;
  strokeWidth: number;
  // For markup annotations
  startPoint?: { x: number; y: number };
  endPoint?: { x: number; y: number };
  // For ink annotations
  currentPath?: PdfPoint[];
  allPaths?: PdfPoint[][];
  // For text annotations
  contents?: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Default annotation colors */
export const ANNOTATION_COLORS: Record<string, AnnotationColor> = {
  yellow: { r: 1.0, g: 0.92, b: 0.23 },
  green: { r: 0.0, g: 0.8, b: 0.4 },
  blue: { r: 0.0, g: 0.5, b: 1.0 },
  pink: { r: 1.0, g: 0.4, b: 0.6 },
  red: { r: 0.87, g: 0.15, b: 0.15 },
  orange: { r: 1.0, g: 0.6, b: 0.0 },
  purple: { r: 0.6, g: 0.3, b: 0.9 },
};

// ============================================================================
// Undo/Redo Types
// ============================================================================

interface UndoAction {
  type: 'add' | 'remove';
  pageIndex: number;
  annotation: AnnotationData;
}

// ============================================================================
// State
// ============================================================================

interface AnnotationState {
  // Current tool
  activeTool: AnnotationTool;
  // Current color
  activeColor: AnnotationColor;
  // Opacity
  opacity: number;
  // Stroke width for pen
  strokeWidth: number;
  // All annotations for the current document (by page)
  annotations: Map<number, AnnotationData[]>;
  // Pending annotation being drawn
  pending: PendingAnnotation | null;
  // Document path (for saving)
  documentPath: string | null;
  // Document ID
  docId: string | null;
  // Page info for coordinate mapping
  pageInfos: PageInfo[];
  // Has unsaved changes
  hasUnsavedChanges: boolean;
  // Is currently drawing
  isDrawing: boolean;
  // Undo/Redo stacks
  undoStack: UndoAction[];
  redoStack: UndoAction[];
}

const state: AnnotationState = {
  activeTool: 'select',
  activeColor: ANNOTATION_COLORS.yellow,
  opacity: 0.5,
  strokeWidth: 2,
  annotations: new Map(),
  pending: null,
  documentPath: null,
  docId: null,
  pageInfos: [],
  hasUnsavedChanges: false,
  isDrawing: false,
  undoStack: [],
  redoStack: [],
};

// Callbacks for state changes
type StateChangeCallback = () => void;
const stateChangeCallbacks: StateChangeCallback[] = [];

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the annotation manager for a document.
 */
export async function initAnnotations(docId: string, pageInfos: PageInfo[]): Promise<void> {
  state.docId = docId;
  state.pageInfos = pageInfos;
  state.annotations.clear();
  state.pending = null;
  state.hasUnsavedChanges = false;
  
  // Get document path
  state.documentPath = await getDocumentPath(docId);
  
  // Load existing annotations if we have a file path
  if (state.documentPath) {
    try {
      const existingAnnotations = await getAnnotations(state.documentPath);
      
      // Group by page
      for (const annot of existingAnnotations) {
        const pageAnnots = state.annotations.get(annot.page) || [];
        pageAnnots.push(annot);
        state.annotations.set(annot.page, pageAnnots);
      }
      
      console.log(`[Annotations] Loaded ${existingAnnotations.length} annotations`);
    } catch (err) {
      console.error('[Annotations] Failed to load existing annotations:', err);
    }
  }
  
  notifyStateChange();
}

/**
 * Reset annotation state (when closing document).
 */
export function resetAnnotations(): void {
  state.docId = null;
  state.documentPath = null;
  state.pageInfos = [];
  state.annotations.clear();
  state.pending = null;
  state.hasUnsavedChanges = false;
  state.isDrawing = false;
  state.undoStack = [];
  state.redoStack = [];
  notifyStateChange();
}

/**
 * Set the active annotation tool.
 */
export function setAnnotationTool(tool: AnnotationTool): void {
  state.activeTool = tool;
  state.isDrawing = false;
  state.pending = null;
  notifyStateChange();
}

/**
 * Get the active annotation tool.
 */
export function getAnnotationTool(): AnnotationTool {
  return state.activeTool;
}

/**
 * Set the active color.
 */
export function setAnnotationColor(color: AnnotationColor): void {
  state.activeColor = color;
  notifyStateChange();
}

/**
 * Get the active color.
 */
export function getAnnotationColor(): AnnotationColor {
  return state.activeColor;
}

/**
 * Set the opacity.
 */
export function setAnnotationOpacity(opacity: number): void {
  state.opacity = Math.max(0.1, Math.min(1.0, opacity));
  notifyStateChange();
}

/**
 * Get the opacity.
 */
export function getAnnotationOpacity(): number {
  return state.opacity;
}

/**
 * Set the stroke width.
 */
export function setStrokeWidth(width: number): void {
  state.strokeWidth = Math.max(1, Math.min(20, width));
  notifyStateChange();
}

/**
 * Get the stroke width.
 */
export function getStrokeWidth(): number {
  return state.strokeWidth;
}

/**
 * Get annotations for a specific page.
 */
export function getPageAnnotations(pageIndex: number): AnnotationData[] {
  return state.annotations.get(pageIndex) || [];
}

/**
 * Get all annotations.
 */
export function getAllAnnotations(): AnnotationData[] {
  const all: AnnotationData[] = [];
  for (const annots of state.annotations.values()) {
    all.push(...annots);
  }
  return all;
}

/**
 * Check if there are unsaved changes.
 */
export function hasUnsavedChanges(): boolean {
  return state.hasUnsavedChanges;
}

/**
 * Check if undo is available.
 */
export function canUndo(): boolean {
  return state.undoStack.length > 0;
}

/**
 * Check if redo is available.
 */
export function canRedo(): boolean {
  return state.redoStack.length > 0;
}

/**
 * Undo the last annotation action.
 */
export function undoAnnotation(): boolean {
  if (state.undoStack.length === 0) return false;
  
  const action = state.undoStack.pop()!;
  
  if (action.type === 'add') {
    // Remove the annotation
    const pageAnnots = state.annotations.get(action.pageIndex) || [];
    const index = pageAnnots.findIndex(a => 
      a.rect.x1 === action.annotation.rect.x1 &&
      a.rect.y1 === action.annotation.rect.y1 &&
      a.rect.x2 === action.annotation.rect.x2 &&
      a.rect.y2 === action.annotation.rect.y2 &&
      a.annotation_type === action.annotation.annotation_type
    );
    if (index >= 0) {
      pageAnnots.splice(index, 1);
      state.annotations.set(action.pageIndex, pageAnnots);
    }
    // Push reverse action to redo stack
    state.redoStack.push({
      type: 'remove',
      pageIndex: action.pageIndex,
      annotation: action.annotation,
    });
  } else if (action.type === 'remove') {
    // Re-add the annotation
    const pageAnnots = state.annotations.get(action.pageIndex) || [];
    pageAnnots.push(action.annotation);
    state.annotations.set(action.pageIndex, pageAnnots);
    // Push reverse action to redo stack
    state.redoStack.push({
      type: 'add',
      pageIndex: action.pageIndex,
      annotation: action.annotation,
    });
  }
  
  state.hasUnsavedChanges = true;
  notifyStateChange();
  return true;
}

/**
 * Redo the last undone annotation action.
 */
export function redoAnnotation(): boolean {
  if (state.redoStack.length === 0) return false;
  
  const action = state.redoStack.pop()!;
  
  if (action.type === 'add') {
    // Remove the annotation (redo of a removal)
    const pageAnnots = state.annotations.get(action.pageIndex) || [];
    const index = pageAnnots.findIndex(a => 
      a.rect.x1 === action.annotation.rect.x1 &&
      a.rect.y1 === action.annotation.rect.y1 &&
      a.rect.x2 === action.annotation.rect.x2 &&
      a.rect.y2 === action.annotation.rect.y2 &&
      a.annotation_type === action.annotation.annotation_type
    );
    if (index >= 0) {
      pageAnnots.splice(index, 1);
      state.annotations.set(action.pageIndex, pageAnnots);
    }
    // Push reverse action to undo stack
    state.undoStack.push({
      type: 'remove',
      pageIndex: action.pageIndex,
      annotation: action.annotation,
    });
  } else if (action.type === 'remove') {
    // Re-add the annotation (redo of an addition)
    const pageAnnots = state.annotations.get(action.pageIndex) || [];
    pageAnnots.push(action.annotation);
    state.annotations.set(action.pageIndex, pageAnnots);
    // Push reverse action to undo stack
    state.undoStack.push({
      type: 'add',
      pageIndex: action.pageIndex,
      annotation: action.annotation,
    });
  }
  
  state.hasUnsavedChanges = true;
  notifyStateChange();
  return true;
}

/**
 * Register a callback for state changes.
 */
export function onAnnotationStateChange(callback: StateChangeCallback): () => void {
  stateChangeCallbacks.push(callback);
  return () => {
    const index = stateChangeCallbacks.indexOf(callback);
    if (index >= 0) {
      stateChangeCallbacks.splice(index, 1);
    }
  };
}

// ============================================================================
// Annotation Creation
// ============================================================================

/**
 * Start drawing an annotation.
 */
export function startAnnotation(
  pageIndex: number,
  screenX: number,
  screenY: number,
  scale: number
): void {
  if (state.activeTool === 'select') return;
  
  const pageInfo = state.pageInfos[pageIndex];
  if (!pageInfo) return;
  
  // Convert screen coordinates to PDF coordinates
  const pdfPoint = screenToPdf(screenX, screenY, pageInfo, scale);
  
  state.isDrawing = true;
  
  if (state.activeTool === 'eraser') {
    // Handle eraser immediately
    handleEraser(pageIndex, pdfPoint);
    return;
  }
  
  // Determine annotation type
  let type: AnnotationType;
  switch (state.activeTool) {
    case 'highlight': type = 'highlight'; break;
    case 'underline': type = 'underline'; break;
    case 'strikethrough': type = 'strikethrough'; break;
    case 'pen': type = 'ink'; break;
    case 'text': type = 'text'; break;
    default: return;
  }
  
  state.pending = {
    type,
    pageIndex,
    color: { ...state.activeColor },
    opacity: state.opacity,
    strokeWidth: state.strokeWidth,
    startPoint: pdfPoint,
    endPoint: pdfPoint,
    currentPath: type === 'ink' ? [pdfPoint] : undefined,
    allPaths: type === 'ink' ? [[pdfPoint]] : undefined,
  };
  
  notifyStateChange();
}

/**
 * Continue drawing an annotation (mouse move).
 */
export function continueAnnotation(
  screenX: number,
  screenY: number,
  scale: number
): void {
  if (!state.isDrawing || !state.pending) return;
  
  const pageInfo = state.pageInfos[state.pending.pageIndex];
  if (!pageInfo) return;
  
  const pdfPoint = screenToPdf(screenX, screenY, pageInfo, scale);
  
  state.pending.endPoint = pdfPoint;
  
  if (state.pending.type === 'ink' && state.pending.currentPath) {
    state.pending.currentPath.push(pdfPoint);
    // Also update the last path in allPaths
    if (state.pending.allPaths && state.pending.allPaths.length > 0) {
      state.pending.allPaths[state.pending.allPaths.length - 1] = [...state.pending.currentPath];
    }
  }
  
  notifyStateChange();
}

/**
 * Finish drawing an annotation.
 */
export function finishAnnotation(): void {
  if (!state.pending) return;
  
  state.isDrawing = false;
  
  // Create the annotation
  const annotation = createAnnotationFromPending(state.pending);
  
  if (annotation) {
    // Add to state
    const pageAnnots = state.annotations.get(state.pending.pageIndex) || [];
    pageAnnots.push(annotation);
    state.annotations.set(state.pending.pageIndex, pageAnnots);
    state.hasUnsavedChanges = true;
    
    // Push to undo stack
    state.undoStack.push({
      type: 'add',
      pageIndex: state.pending.pageIndex,
      annotation: annotation,
    });
    // Clear redo stack on new action
    state.redoStack = [];
  }
  
  state.pending = null;
  notifyStateChange();
}

/**
 * Cancel the current annotation.
 */
export function cancelAnnotation(): void {
  state.pending = null;
  state.isDrawing = false;
  notifyStateChange();
}

/**
 * Add a text annotation at a specific point.
 */
export function addTextAnnotation(
  pageIndex: number,
  screenX: number,
  screenY: number,
  scale: number,
  text: string
): void {
  const pageInfo = state.pageInfos[pageIndex];
  if (!pageInfo) return;
  
  const pdfPoint = screenToPdf(screenX, screenY, pageInfo, scale);
  
  const annotation: AnnotationData = {
    annotation_type: 'text',
    page: pageIndex,
    rect: {
      x1: pdfPoint.x,
      y1: pdfPoint.y - 24, // Icon size
      x2: pdfPoint.x + 24,
      y2: pdfPoint.y,
    },
    contents: text,
    color: state.activeColor,
    opacity: state.opacity,
  };
  
  // Add to state
  const pageAnnots = state.annotations.get(pageIndex) || [];
  pageAnnots.push(annotation);
  state.annotations.set(pageIndex, pageAnnots);
  state.hasUnsavedChanges = true;
  
  // Push to undo stack
  state.undoStack.push({
    type: 'add',
    pageIndex: pageIndex,
    annotation: annotation,
  });
  state.redoStack = [];
  
  notifyStateChange();
}

/**
 * Add a markup annotation (highlight/underline/strikethrough) from text selection.
 * This takes screen coordinates of the selection bounding box.
 */
export function addTextSelectionAnnotation(
  pageIndex: number,
  screenRect: { x: number; y: number; width: number; height: number },
  scale: number,
  type: 'highlight' | 'underline' | 'strikethrough'
): void {
  const pageInfo = state.pageInfos[pageIndex];
  if (!pageInfo) return;
  
  // Convert screen rect corners to PDF coordinates
  const topLeft = screenToPdf(screenRect.x, screenRect.y, pageInfo, scale);
  const bottomRight = screenToPdf(
    screenRect.x + screenRect.width,
    screenRect.y + screenRect.height,
    pageInfo,
    scale
  );
  
  const pdfRect: PdfRect = {
    x1: Math.min(topLeft.x, bottomRight.x),
    y1: Math.min(topLeft.y, bottomRight.y),
    x2: Math.max(topLeft.x, bottomRight.x),
    y2: Math.max(topLeft.y, bottomRight.y),
  };
  
  const annotation: AnnotationData = {
    annotation_type: type,
    page: pageIndex,
    rect: pdfRect,
    color: state.activeColor,
    opacity: state.opacity,
  };
  
  // Add to state
  const pageAnnots = state.annotations.get(pageIndex) || [];
  pageAnnots.push(annotation);
  state.annotations.set(pageIndex, pageAnnots);
  state.hasUnsavedChanges = true;
  
  // Push to undo stack
  state.undoStack.push({
    type: 'add',
    pageIndex: pageIndex,
    annotation: annotation,
  });
  state.redoStack = [];
  
  notifyStateChange();
}

// ============================================================================
// Saving
// ============================================================================

/**
 * Save all annotations to the PDF file.
 */
export async function saveAllAnnotations(): Promise<boolean> {
  if (!state.documentPath) {
    console.error('[Annotations] No document path for saving');
    return false;
  }
  
  const allAnnotations = getAllAnnotations();
  
  try {
    const result = await saveAnnotations(state.documentPath, allAnnotations);
    
    if (result.success) {
      state.hasUnsavedChanges = false;
      notifyStateChange();
      console.log(`[Annotations] Saved ${result.annotations_count} annotations`);
      return true;
    } else {
      console.error('[Annotations] Save failed');
      return false;
    }
  } catch (err) {
    console.error('[Annotations] Failed to save:', err);
    return false;
  }
}

// ============================================================================
// Eraser
// ============================================================================

/**
 * Handle eraser tool - remove annotation at point.
 */
async function handleEraser(pageIndex: number, pdfPoint: PdfPoint): Promise<void> {
  const pageAnnots = state.annotations.get(pageIndex);
  if (!pageAnnots || pageAnnots.length === 0) return;
  
  // Find annotation that contains this point
  const hitIndex = pageAnnots.findIndex(annot => {
    return isPointInRect(pdfPoint, annot.rect);
  });
  
  if (hitIndex >= 0) {
    const removed = pageAnnots.splice(hitIndex, 1)[0];
    state.hasUnsavedChanges = true;
    
    // If we have a saved file, also remove from file
    if (state.documentPath) {
      try {
        await removeAnnotation(state.documentPath, pageIndex, removed.rect);
      } catch (err) {
        console.warn('[Annotations] Failed to remove from file:', err);
      }
    }
    
    notifyStateChange();
  }
}

/**
 * Check if a point is inside a rectangle.
 */
function isPointInRect(point: PdfPoint, rect: PdfRect): boolean {
  return point.x >= rect.x1 && point.x <= rect.x2 &&
         point.y >= rect.y1 && point.y <= rect.y2;
}

// ============================================================================
// Coordinate Mapping
// ============================================================================

/**
 * Convert screen coordinates to PDF coordinates.
 * PDF coordinates have origin at bottom-left.
 */
function screenToPdf(
  screenX: number,
  screenY: number,
  pageInfo: PageInfo,
  scale: number
): PdfPoint {
  // Screen Y is top-down, PDF Y is bottom-up
  const pdfX = screenX / scale;
  const pdfY = pageInfo.height - (screenY / scale);
  
  return { x: pdfX, y: pdfY };
}

/**
 * Convert PDF coordinates to screen coordinates.
 */
export function pdfToScreen(
  pdfX: number,
  pdfY: number,
  pageInfo: PageInfo,
  scale: number
): { x: number; y: number } {
  // PDF Y is bottom-up, screen Y is top-down
  const screenX = pdfX * scale;
  const screenY = (pageInfo.height - pdfY) * scale;
  
  return { x: screenX, y: screenY };
}

/**
 * Convert a PDF rect to screen rect.
 */
export function pdfRectToScreen(
  rect: PdfRect,
  pageInfo: PageInfo,
  scale: number
): { x: number; y: number; width: number; height: number } {
  const topLeft = pdfToScreen(rect.x1, rect.y2, pageInfo, scale);
  const bottomRight = pdfToScreen(rect.x2, rect.y1, pageInfo, scale);
  
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create an AnnotationData from a pending annotation.
 */
function createAnnotationFromPending(pending: PendingAnnotation): AnnotationData | null {
  if (!pending.startPoint || !pending.endPoint) return null;
  
  // Calculate bounding rect
  const rect: PdfRect = {
    x1: Math.min(pending.startPoint.x, pending.endPoint.x),
    y1: Math.min(pending.startPoint.y, pending.endPoint.y),
    x2: Math.max(pending.startPoint.x, pending.endPoint.x),
    y2: Math.max(pending.startPoint.y, pending.endPoint.y),
  };
  
  // Ensure minimum size
  if (rect.x2 - rect.x1 < 5) {
    rect.x2 = rect.x1 + 20;
  }
  if (rect.y2 - rect.y1 < 5) {
    rect.y2 = rect.y1 + 12;
  }
  
  const annotation: AnnotationData = {
    annotation_type: pending.type,
    page: pending.pageIndex,
    rect,
    color: pending.color,
    opacity: pending.opacity,
    id: generateId(),
  };
  
  // Type-specific data
  if (pending.type === 'highlight' || pending.type === 'underline' || pending.type === 'strikethrough') {
    // Create quad points from rect (8 values for 4 points)
    annotation.quad_points = [
      { x: rect.x1, y: rect.y2 }, // top-left
      { x: rect.x2, y: rect.y2 }, // top-right
      { x: rect.x1, y: rect.y1 }, // bottom-left
      { x: rect.x2, y: rect.y1 }, // bottom-right
    ];
  } else if (pending.type === 'ink' && pending.allPaths) {
    annotation.ink_paths = pending.allPaths;
    annotation.stroke_width = pending.strokeWidth;
    
    // Recalculate bounding rect from all paths
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const path of pending.allPaths) {
      for (const point of path) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
    }
    annotation.rect = {
      x1: minX - pending.strokeWidth,
      y1: minY - pending.strokeWidth,
      x2: maxX + pending.strokeWidth,
      y2: maxY + pending.strokeWidth,
    };
  }
  
  return annotation;
}

/**
 * Generate a unique ID for an annotation.
 */
function generateId(): string {
  return `annot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Notify all registered callbacks of state change.
 */
function notifyStateChange(): void {
  for (const callback of stateChangeCallbacks) {
    try {
      callback();
    } catch (e) {
      console.error('[Annotations] State change callback error:', e);
    }
  }
}

// ============================================================================
// Get pending annotation for rendering
// ============================================================================

export function getPendingAnnotation(): PendingAnnotation | null {
  return state.pending;
}

export function isAnnotationDrawing(): boolean {
  return state.isDrawing;
}
