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
// Screen State Controller (Part 1)
// ============================================================================

/** Current visible screen. */
type Screen = 'home' | 'viewer';
let currentScreen: Screen | null = null;

/** Guard: set to true when a file-open event/launch-file arrives during startup. */
let startupFileReceived = false;

/**
 * Show the Home screen, hide the Viewer screen.
 * Only toggles container visibility — no render-engine interaction.
 */
function showHome(): void {
  const home = document.getElementById('home-screen');
  const viewer = document.getElementById('viewer-screen');
  home?.classList.remove('hidden');
  viewer?.classList.add('hidden');
  currentScreen = 'home';
  renderRecentsList(); // refresh recents every time we show Home
  hideAnnotationDock();
}

/**
 * Show the Viewer screen, hide the Home screen.
 * Only toggles container visibility — no render-engine interaction.
 */
function showViewer(): void {
  const home = document.getElementById('home-screen');
  const viewer = document.getElementById('viewer-screen');
  viewer?.classList.remove('hidden');
  home?.classList.add('hidden');
  currentScreen = 'viewer';
  showAnnotationDock();
}

// ============================================================================
// Recents (Part 2)
// ============================================================================

interface RecentFile {
  path: string;
  name: string;
  lastOpened: number;
}

const RECENTS_KEY = 'kiosk_recent_files';
const MAX_RECENTS = 10;

/** Read the recents list from localStorage. */
function getRecents(): RecentFile[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as RecentFile[];
  } catch {
    return [];
  }
}

/** Persist the recents list. */
function saveRecents(recents: RecentFile[]): void {
  localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
}

/** Add (or bump) a file in the recents list. Deduplicates by path, keeps max 10. */
function addToRecents(filePath: string): void {
  const name = filePath.split('/').pop()?.split('\\').pop() ?? filePath;
  let recents = getRecents().filter(r => r.path !== filePath);
  recents.unshift({ path: filePath, name, lastOpened: Date.now() });
  if (recents.length > MAX_RECENTS) recents = recents.slice(0, MAX_RECENTS);
  saveRecents(recents);
}

/** Render the recents list into the Home screen. */
function renderRecentsList(): void {
  const list = document.getElementById('recents-list');
  const emptyMsg = document.getElementById('recents-empty');
  if (!list) return;
  list.innerHTML = '';

  const recents = getRecents();
  if (recents.length === 0) {
    if (emptyMsg) emptyMsg.style.display = '';
    return;
  }
  if (emptyMsg) emptyMsg.style.display = 'none';

  for (const file of recents) {
    const li = document.createElement('li');
    li.className = 'recents-item';
    li.title = file.path;
    li.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
      </svg>
      <span class="recents-item-name">${escapeHtml(file.name)}</span>
      <span class="recents-item-path">${escapeHtml(file.path)}</span>
    `;
    li.addEventListener('click', () => openRecentFile(file.path));
    list.appendChild(li);
  }
}

/** Minimal HTML escaper. */
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Open a recent file — switches to Viewer immediately. */
async function openRecentFile(filePath: string): Promise<void> {
  showViewer();
  await openFile(filePath);
  addToRecents(filePath);
}

// ============================================================================
// Initialization
// ============================================================================

window.addEventListener('DOMContentLoaded', async () => {
  initViewer();
  setupToolbar();
  setupHomeScreen();
  setupAnnotationDock();

  // Set up file open event listener (for files opened while app is running)
  await setupFileOpenListener();

  // Check if app was launched with a PDF file
  try {
    const launchFile = await invoke<string | null>('get_launch_file');
    if (launchFile) {
      console.log('App launched with file:', launchFile);
      startupFileReceived = true;
      showViewer();
      await openFile(launchFile);
      addToRecents(launchFile);
    }
  } catch (err) {
    console.error('Failed to check launch file:', err);
  }

  // Anti-flicker: delay Home by 50 ms so a quick file-open event can skip it
  if (!startupFileReceived) {
    await new Promise(r => setTimeout(r, 50));
    if (!startupFileReceived) {
      showHome();
    }
  }
});

// ============================================================================
// File Association Handling
// ============================================================================

/**
 * Listen for file open events from the backend.
 * Handles files opened while the app is already running + drag-and-drop.
 */
async function setupFileOpenListener(): Promise<void> {
  try {
    // Listen for open-file events from Rust
    await listen<string>('open-file', async (event) => {
      const filePath = event.payload;
      console.log('Received open-file event:', filePath);

      if (filePath && filePath.toLowerCase().endsWith('.pdf')) {
        startupFileReceived = true;
        showViewer();
        await openFile(filePath);
        addToRecents(filePath);
      }
    });

    // Also listen for the generic "file-open-requested" event name (alias)
    await listen<string>('file-open-requested', async (event) => {
      const filePath = event.payload;
      console.log('Received file-open-requested event:', filePath);

      if (filePath && filePath.toLowerCase().endsWith('.pdf')) {
        startupFileReceived = true;
        showViewer();
        await openFile(filePath);
        addToRecents(filePath);
      }
    });

    // Tauri file drop events
    await listen<{ paths: string[] }>('tauri://file-drop', async (event) => {
      const paths = event.payload.paths;
      if (paths && paths.length > 0) {
        const pdfPath = paths.find(p => p.toLowerCase().endsWith('.pdf'));
        if (pdfPath) {
          console.log('File dropped:', pdfPath);
          startupFileReceived = true;
          showViewer();
          await openFile(pdfPath);
          addToRecents(pdfPath);
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
      showViewer();
      await openFile(selected);
      addToRecents(selected);
    }
  } catch (err) {
    console.error('Failed to open file dialog:', err);
  }
}

// ============================================================================
// Home Screen Setup (Part 2)
// ============================================================================

function setupHomeScreen(): void {
  // "Open PDF" button on Home screen
  document.getElementById('home-open-btn')?.addEventListener('click', handleOpenFile);

  // Drop zone on the whole Home screen (optional convenience)
  const homeScreen = document.getElementById('home-screen');
  homeScreen?.addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  homeScreen?.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    if (file.type !== 'application/pdf' && !file.name.endsWith('.pdf')) return;
    const bytes = await fileToBytes(file);
    showViewer();
    await openBytes(bytes, file.name);
    // We don't have a path for drag-dropped File objects, so skip addToRecents
  });
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
  showHome,
  showViewer,
  getRecents,
  get currentScreen() { return currentScreen; },
};
