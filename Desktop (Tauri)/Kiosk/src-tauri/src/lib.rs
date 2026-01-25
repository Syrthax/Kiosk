// Kiosk PDF Reader - Native Tauri Backend
//
// This module provides high-quality PDF rendering using PDFium,
// with glyph-accurate text selection and native-grade output.

mod annotations;
mod commands;
mod pdf;

use commands::{
    close_pdf, get_all_page_infos, get_char_rects, get_document_info, get_page_info,
    get_page_text, load_pdf, load_pdf_bytes, render_page, search_text, AppState,
    // Annotation commands
    get_annotations, save_annotations, remove_annotation, clear_page_annotations,
    get_document_path,
};
use std::sync::Mutex;
use tauri::{Emitter, RunEvent};

/// Stores the file path that was passed to the app on launch (if any).
/// This is used to open PDFs when the app is launched via file association.
pub struct LaunchFile(pub Mutex<Option<String>>);

/// Check if a path is a valid PDF file.
fn is_pdf_file(path: &str) -> bool {
    let path = std::path::Path::new(path);
    path.exists()
        && path.is_file()
        && path
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case("pdf"))
            .unwrap_or(false)
}

/// Check if a path string looks like a PDF (extension check only, for URLs before download).
fn looks_like_pdf(path: &str) -> bool {
    path.to_lowercase().ends_with(".pdf")
}

/// Extract PDF file path from command line arguments.
/// On macOS: when opening via Finder, the file path is passed as an argument.
/// On Windows: the file path is passed as the first argument after the executable.
fn get_pdf_from_args() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    eprintln!("[Kiosk] Launch arguments: {:?}", args);
    
    // Skip the first arg (executable path)
    // Look for a .pdf file in the arguments
    for arg in args.iter().skip(1) {
        // Skip Tauri/debug flags
        if arg.starts_with('-') || arg.starts_with("--") {
            continue;
        }
        
        // First try as a direct file path
        if is_pdf_file(arg) {
            eprintln!("[Kiosk] Found PDF in args (direct): {}", arg);
            return Some(arg.clone());
        }
        
        // Handle file:// URLs (macOS sometimes passes these)
        if arg.starts_with("file://") {
            if let Ok(url) = url::Url::parse(arg) {
                if let Ok(path) = url.to_file_path() {
                    if let Some(path_str) = path.to_str() {
                        if is_pdf_file(path_str) {
                            eprintln!("[Kiosk] Found PDF in args (file URL): {}", path_str);
                            return Some(path_str.to_string());
                        }
                    }
                }
            }
        }
        
        // Handle URL-encoded paths (e.g., spaces as %20)
        if let Ok(decoded) = urlencoding::decode(arg) {
            let decoded_str = decoded.to_string();
            if decoded_str != *arg && is_pdf_file(&decoded_str) {
                eprintln!("[Kiosk] Found PDF in args (URL-decoded): {}", decoded_str);
                return Some(decoded_str);
            }
        }
    }
    
    None
}

/// Convert a URL to a file path string, handling macOS file:// URLs properly.
fn url_to_file_path(url: &url::Url) -> Option<String> {
    // Use the URL's to_file_path method for proper handling
    url.to_file_path()
        .ok()
        .and_then(|p| p.to_str().map(|s| s.to_string()))
}

/// Handle file associations - extract PDF paths from URLs and emit to frontend.
fn handle_file_associations<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>, urls: Vec<url::Url>) {
    eprintln!("[Kiosk] Received file open event with {} URLs", urls.len());
    
    for url in urls {
        eprintln!("[Kiosk] Processing URL: {}", url);
        
        // Convert URL to file path
        if let Some(path_str) = url_to_file_path(&url) {
            eprintln!("[Kiosk] Converted to path: {}", path_str);
            
            // Check if it's a PDF
            if is_pdf_file(&path_str) {
                eprintln!("[Kiosk] Emitting open-file event for: {}", path_str);
                if let Err(e) = app_handle.emit("open-file", &path_str) {
                    eprintln!("[Kiosk] Failed to emit open-file event: {}", e);
                }
                // Only open the first PDF
                return;
            } else if looks_like_pdf(&path_str) {
                // Path looks like PDF but file might not exist yet or not accessible
                eprintln!("[Kiosk] Path looks like PDF but file check failed: {}", path_str);
                // Still try to emit - frontend can handle the error
                if let Err(e) = app_handle.emit("open-file", &path_str) {
                    eprintln!("[Kiosk] Failed to emit open-file event: {}", e);
                }
                return;
            }
        } else {
            eprintln!("[Kiosk] Could not convert URL to file path: {}", url);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize app state
    let app_state = AppState::new();

    // Check for PDF file in launch arguments (Windows/Linux primarily)
    let launch_file = get_pdf_from_args();
    if let Some(ref file) = launch_file {
        eprintln!("[Kiosk] Launch file from args: {}", file);
    }
    
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .manage(LaunchFile(Mutex::new(launch_file)))
        .invoke_handler(tauri::generate_handler![
            // PDF loading and viewing
            load_pdf,
            load_pdf_bytes,
            close_pdf,
            get_document_info,
            get_document_path,
            get_page_info,
            get_all_page_infos,
            render_page,
            get_char_rects,
            get_page_text,
            search_text,
            get_launch_file,
            // Annotation commands
            get_annotations,
            save_annotations,
            remove_annotation,
            clear_page_annotations,
        ])
        .setup(|_app| {
            eprintln!("[Kiosk] App setup complete");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Run with event handler for macOS file associations
    app.run(|app_handle, event| {
        match event {
            // Handle macOS "Open With" / double-click file associations
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            RunEvent::Opened { urls } => {
                handle_file_associations(app_handle, urls);
            }
            
            // Handle app reopen (clicking dock icon when app is already running)
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { has_visible_windows, .. } => {
                eprintln!("[Kiosk] Reopen event, has_visible_windows: {}", has_visible_windows);
                // If no visible windows, we could show the main window
                // But for now we don't need to do anything special
            }
            
            _ => {}
        }
    });
}

/// Get the file path that was passed on launch (if any).
/// Frontend calls this on startup to check if a PDF should be opened.
#[tauri::command]
fn get_launch_file(state: tauri::State<LaunchFile>) -> Option<String> {
    let mut guard = state.0.lock().unwrap();
    guard.take() // Return and clear the launch file
}
