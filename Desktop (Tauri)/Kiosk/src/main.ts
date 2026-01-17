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
  type DisplayMode 
} from './pdf-viewer';
import { fileToBytes } from './pdf-api';

// ============================================================================
// Initialization
// ============================================================================

window.addEventListener('DOMContentLoaded', async () => {
  initViewer();
  setupToolbar();
  setupWelcomeScreen();
  
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
}

function showWelcome(): void {
  const welcome = document.getElementById('welcome-screen');
  welcome?.classList.remove('hidden');
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
