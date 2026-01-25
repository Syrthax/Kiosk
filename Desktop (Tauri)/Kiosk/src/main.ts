/**
 * Kiosk PDF Reader - Main Entry Point
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { 
  initViewer, 
  openFile, 
  openBytes, 
  toggleSidebar, 
  setDisplayMode, 
  getDisplayMode,
  setAnnotationTool,
  saveAllAnnotations,
  hasUnsavedChanges,
  applyAnnotationToSelection,
  type DisplayMode,
  type AnnotationTool
} from './pdf-viewer';
import { setAnnotationColor, onAnnotationStateChange, undoAnnotation, redoAnnotation, canUndo, canRedo } from './annotations';
import { fileToBytes } from './pdf-api';

// ============================================================================
// Initialization
// ============================================================================

window.addEventListener('DOMContentLoaded', async () => {
  initViewer();
  setupToolbar();
  setupWelcomeScreen();
  setupAnnotationDock();
  
  // Set up file open event listener (for files opened while app is running)
  await setupFileOpenListener();
  
  // Check if app was launched with a PDF file
  await checkLaunchFile();
});

// ============================================================================
// File Association Handling
// ============================================================================

/**
 * Check if the app was launched with a PDF file argument.
 * This handles double-clicking a PDF or "Open with" from Finder/Explorer.
 */
async function checkLaunchFile(): Promise<void> {
  try {
    const launchFile = await invoke<string | null>('get_launch_file');
    if (launchFile) {
      console.log('App launched with file:', launchFile);
      await openFile(launchFile);
      hideWelcome();
    }
  } catch (err) {
    console.error('Failed to check launch file:', err);
  }
}

/**
 * Listen for file open events from the backend.
 * This handles files opened while the app is already running.
 */
async function setupFileOpenListener(): Promise<void> {
  try {
    // Listen for open-file events from Rust
    await listen<string>('open-file', async (event) => {
      const filePath = event.payload;
      console.log('Received open-file event:', filePath);
      
      if (filePath && filePath.toLowerCase().endsWith('.pdf')) {
        await openFile(filePath);
        hideWelcome();
      }
    });
    
    // Also listen for Tauri's file drop events
    await listen<{ paths: string[] }>('tauri://file-drop', async (event) => {
      const paths = event.payload.paths;
      if (paths && paths.length > 0) {
        const pdfPath = paths.find(p => p.toLowerCase().endsWith('.pdf'));
        if (pdfPath) {
          console.log('File dropped:', pdfPath);
          await openFile(pdfPath);
          hideWelcome();
        }
      }
    });
  } catch (err) {
    console.error('Failed to setup file open listener:', err);
  }
}

// ============================================================================
// Toolbar
// ============================================================================

function setupToolbar(): void {
  // Open file button
  document.getElementById('open-file')?.addEventListener('click', handleOpenFile);

  // Sidebar toggle - use the viewer's toggle function for proper layout recalculation
  document.getElementById('toggle-sidebar')?.addEventListener('click', toggleSidebar);
  
  // Display mode dropdown
  setupDisplayModeDropdown();
}

/**
 * Set up the display mode dropdown in the toolbar.
 */
function setupDisplayModeDropdown(): void {
  const container = document.getElementById('display-mode-container');
  if (!container) return;
  
  const btn = container.querySelector('.display-mode-btn');
  const dropdown = container.querySelector('.display-mode-dropdown');
  
  if (!btn || !dropdown) return;
  
  // Toggle dropdown visibility
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
  });
  
  // Handle mode selection
  dropdown.querySelectorAll('.display-mode-option').forEach((option) => {
    option.addEventListener('click', () => {
      const mode = (option as HTMLElement).dataset.mode as DisplayMode;
      if (mode) {
        setDisplayMode(mode);
        dropdown.classList.remove('open');
        
        // Update active state
        dropdown.querySelectorAll('.display-mode-option').forEach(opt => {
          opt.classList.toggle('active', (opt as HTMLElement).dataset.mode === mode);
        });
      }
    });
  });
  
  // Close dropdown when clicking outside
  document.addEventListener('click', () => {
    dropdown.classList.remove('open');
  });
  
  // Set initial active state
  const currentMode = getDisplayMode();
  dropdown.querySelectorAll('.display-mode-option').forEach(opt => {
    opt.classList.toggle('active', (opt as HTMLElement).dataset.mode === currentMode);
  });
}

async function handleOpenFile(): Promise<void> {
  try {
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: 'PDF',
          extensions: ['pdf'],
        },
      ],
    });

    if (selected && typeof selected === 'string') {
      await openFile(selected);
      hideWelcome();
    }
  } catch (err) {
    console.error('Failed to open file dialog:', err);
  }
}

// ============================================================================
// Welcome Screen
// ============================================================================

function setupWelcomeScreen(): void {
  const dropZone = document.getElementById('welcome-drop-zone');
  const browseBtn = document.getElementById('welcome-browse');

  // Drag and drop
  dropZone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone?.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone?.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    if (file.type !== 'application/pdf' && !file.name.endsWith('.pdf')) {
      alert('Please drop a PDF file');
      return;
    }

    const bytes = await fileToBytes(file);
    await openBytes(bytes, file.name);
    hideWelcome();
  });

  // Browse button
  browseBtn?.addEventListener('click', async () => {
    await handleOpenFile();
  });
}

function hideWelcome(): void {
  const welcome = document.getElementById('welcome-screen');
  welcome?.classList.add('hidden');
  showAnnotationDock();
}

function showWelcome(): void {
  const welcome = document.getElementById('welcome-screen');
  welcome?.classList.remove('hidden');
}

// ============================================================================
// Annotation Dock
// ============================================================================

/**
 * Annotation dock auto-hide state
 */
const dockState = {
  lastScrollY: 0,
  lastScrollTime: 0,
  scrollVelocity: 0,
  hideTimeout: null as ReturnType<typeof setTimeout> | null,
  isHidden: false,
  isDocumentOpen: false,
};

/**
 * Set up the annotation dock with tool selection, color picker, and auto-hide behavior.
 */
function setupAnnotationDock(): void {
  const dock = document.getElementById('annotation-dock');
  if (!dock) return;
  
  // Tool buttons
  dock.querySelectorAll('.dock-tool-btn[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tool = (btn as HTMLElement).dataset.tool as AnnotationTool;
      if (tool) {
        selectTool(tool, dock);
      }
    });
  });
  
  // Color buttons
  dock.querySelectorAll('.dock-color-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const colorName = (btn as HTMLElement).dataset.color;
      if (colorName) {
        selectColor(colorName, dock);
      }
    });
  });
  
  // Save button
  const saveBtn = document.getElementById('save-annotations');
  saveBtn?.addEventListener('click', async () => {
    if (hasUnsavedChanges()) {
      await saveAllAnnotations();
      updateSaveButton();
      updateUndoRedoButtons();
    }
  });
  
  // Undo button
  const undoBtn = document.getElementById('undo-annotation');
  undoBtn?.addEventListener('click', () => {
    if (canUndo()) {
      undoAnnotation();
      updateUndoRedoButtons();
    }
  });
  
  // Redo button
  const redoBtn = document.getElementById('redo-annotation');
  redoBtn?.addEventListener('click', () => {
    if (canRedo()) {
      redoAnnotation();
      updateUndoRedoButtons();
    }
  });
  
  // Listen for annotation state changes to update buttons
  onAnnotationStateChange(() => {
    updateSaveButton();
    updateUndoRedoButtons();
  });
  
  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (!dockState.isDocumentOpen) return;
    
    // Only handle if not typing in an input
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }
    
    // Cmd/Ctrl+Z to undo
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      if (canUndo()) {
        undoAnnotation();
        updateUndoRedoButtons();
      }
      return;
    }
    
    // Cmd/Ctrl+Shift+Z to redo
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey) {
      e.preventDefault();
      if (canRedo()) {
        redoAnnotation();
        updateUndoRedoButtons();
      }
      return;
    }
    
    // Cmd/Ctrl+S to save
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (hasUnsavedChanges()) {
        saveAllAnnotations().then(() => {
          updateSaveButton();
          updateUndoRedoButtons();
        });
      }
      return;
    }
    
    // Tool shortcuts (without modifiers)
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    
    switch (e.key.toLowerCase()) {
      case 'v':
        selectTool('select', dock);
        break;
      case 'h':
        selectTool('highlight', dock);
        break;
      case 'u':
        selectTool('underline', dock);
        break;
      case 's':
        selectTool('strikethrough', dock);
        break;
      case 'p':
        selectTool('pen', dock);
        break;
      case 't':
        selectTool('text', dock);
        break;
      case 'e':
        selectTool('eraser', dock);
        break;
      case 'escape':
        selectTool('select', dock);
        break;
    }
  });
  
  // Auto-hide behavior on scroll
  setupDockAutoHide(dock);
}

/**
 * Color presets for annotations
 */
const colorPresets: Record<string, { r: number; g: number; b: number }> = {
  yellow: { r: 1, g: 0.922, b: 0.231 },
  green: { r: 0.298, g: 0.686, b: 0.314 },
  blue: { r: 0.129, g: 0.588, b: 0.953 },
  pink: { r: 0.914, g: 0.118, b: 0.388 },
  red: { r: 0.957, g: 0.263, b: 0.212 },
};

/**
 * Select an annotation tool.
 */
function selectTool(tool: AnnotationTool, dock: HTMLElement): void {
  // For markup tools (highlight, underline, strikethrough), check if there's a text selection
  if (tool === 'highlight' || tool === 'underline' || tool === 'strikethrough') {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim().length > 0) {
      // Apply annotation to the current text selection
      applyAnnotationToSelection(tool);
      updateUndoRedoButtons();
      // Stay in select mode after applying
      setAnnotationTool('select');
      // Update button states - select should be active
      dock.querySelectorAll('.dock-tool-btn[data-tool]').forEach((btn) => {
        const btnTool = (btn as HTMLElement).dataset.tool;
        btn.classList.toggle('active', btnTool === 'select');
      });
      document.body.classList.remove('annotation-mode');
      delete document.body.dataset.tool;
      return;
    }
  }
  
  setAnnotationTool(tool);
  
  // Update button states
  dock.querySelectorAll('.dock-tool-btn[data-tool]').forEach((btn) => {
    const btnTool = (btn as HTMLElement).dataset.tool;
    btn.classList.toggle('active', btnTool === tool);
  });
  
  // Update body class for cursor changes
  if (tool !== 'select') {
    document.body.classList.add('annotation-mode');
    document.body.dataset.tool = tool;
  } else {
    document.body.classList.remove('annotation-mode');
    delete document.body.dataset.tool;
  }
}

/**
 * Select an annotation color.
 */
function selectColor(colorName: string, dock: HTMLElement): void {
  const color = colorPresets[colorName];
  if (!color) return;
  
  setAnnotationColor(color);
  
  // Update button states
  dock.querySelectorAll('.dock-color-btn').forEach((btn) => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.color === colorName);
  });
}

/**
 * Update the save button state based on unsaved changes.
 */
function updateSaveButton(): void {
  const saveBtn = document.getElementById('save-annotations');
  if (!saveBtn) return;
  
  const hasChanges = hasUnsavedChanges();
  saveBtn.classList.toggle('has-changes', hasChanges);
  (saveBtn as HTMLButtonElement).disabled = !hasChanges;
}

/**
 * Update undo/redo button states.
 */
function updateUndoRedoButtons(): void {
  const undoBtn = document.getElementById('undo-annotation') as HTMLButtonElement | null;
  const redoBtn = document.getElementById('redo-annotation') as HTMLButtonElement | null;
  
  if (undoBtn) {
    undoBtn.disabled = !canUndo();
  }
  if (redoBtn) {
    redoBtn.disabled = !canRedo();
  }
}

/**
 * Set up auto-hide behavior for the annotation dock.
 * 
 * Behavior:
 * - Fast scrolling down: dock slides down and hides
 * - Pause scrolling for ~2 seconds: dock reappears
 * - Scroll up: dock reappears immediately
 */
function setupDockAutoHide(dock: HTMLElement): void {
  const viewerContainer = document.getElementById('viewer-container');
  if (!viewerContainer) return;
  
  const VELOCITY_THRESHOLD = 50; // px/100ms - how fast is "fast scrolling"
  const REAPPEAR_DELAY = 2000; // ms - how long to wait before reappearing
  
  viewerContainer.addEventListener('scroll', () => {
    const currentTime = Date.now();
    const currentScrollY = viewerContainer.scrollTop;
    
    const timeDelta = currentTime - dockState.lastScrollTime;
    const scrollDelta = currentScrollY - dockState.lastScrollY;
    
    // Calculate scroll velocity (px per 100ms)
    if (timeDelta > 0) {
      dockState.scrollVelocity = (scrollDelta / timeDelta) * 100;
    }
    
    dockState.lastScrollY = currentScrollY;
    dockState.lastScrollTime = currentTime;
    
    // Clear any existing reappear timeout
    if (dockState.hideTimeout) {
      clearTimeout(dockState.hideTimeout);
      dockState.hideTimeout = null;
    }
    
    // Scrolling up: show dock immediately
    if (scrollDelta < 0 && dockState.isHidden) {
      showDock(dock);
    }
    // Fast scrolling down: hide dock
    else if (dockState.scrollVelocity > VELOCITY_THRESHOLD && !dockState.isHidden) {
      hideDock(dock);
    }
    
    // Schedule dock to reappear after pause
    if (dockState.isHidden) {
      dockState.hideTimeout = setTimeout(() => {
        showDock(dock);
      }, REAPPEAR_DELAY);
    }
  }, { passive: true });
}

function hideDock(dock: HTMLElement): void {
  dock.classList.add('hidden');
  dockState.isHidden = true;
}

function showDock(dock: HTMLElement): void {
  dock.classList.remove('hidden');
  dockState.isHidden = false;
}

/**
 * Show the annotation dock when a document is opened.
 */
export function showAnnotationDock(): void {
  const dock = document.getElementById('annotation-dock');
  if (dock) {
    dock.style.display = 'block';
    dockState.isDocumentOpen = true;
    dockState.isHidden = false;
  }
}

/**
 * Hide the annotation dock when no document is open.
 */
export function hideAnnotationDock(): void {
  const dock = document.getElementById('annotation-dock');
  if (dock) {
    dock.style.display = 'none';
    dockState.isDocumentOpen = false;
  }
}

// ============================================================================
// Expose for debugging
// ============================================================================

(window as any).kiosk = {
  openFile,
  openBytes,
  showWelcome,
  checkLaunchFile,
};
