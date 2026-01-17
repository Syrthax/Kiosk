// Kiosk PDF Reader - Native Tauri Backend
//
// This module provides high-quality PDF rendering using PDFium,
// with glyph-accurate text selection and native-grade output.

mod commands;
mod pdf;

use commands::{
    close_pdf, get_all_page_infos, get_char_rects, get_document_info, get_page_info,
    get_page_text, load_pdf, load_pdf_bytes, render_page, search_text, AppState,
};
use std::sync::Mutex;
use tauri::Emitter;

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

/// Extract PDF file path from command line arguments.
/// On macOS: when opening via Finder, the file path is passed as an argument.
/// On Windows: the file path is passed as the first argument after the executable.
fn get_pdf_from_args() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    
    // Skip the first arg (executable path)
    // Look for a .pdf file in the arguments
    for arg in args.iter().skip(1) {
        // Skip Tauri/debug flags
        if arg.starts_with('-') || arg.starts_with("--") {
            continue;
        }
        
        if is_pdf_file(arg) {
            return Some(arg.clone());
        }
        
        // Handle file:// URLs (macOS sometimes passes these)
        if arg.starts_with("file://") {
            if let Ok(url) = url::Url::parse(arg) {
                if let Ok(path) = url.to_file_path() {
                    if let Some(path_str) = path.to_str() {
                        if is_pdf_file(path_str) {
                            return Some(path_str.to_string());
                        }
                    }
                }
            }
        }
    }
    
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize app state
    let app_state = AppState::new();

    // Check for PDF file in launch arguments
    let launch_file = get_pdf_from_args();
    
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .manage(LaunchFile(Mutex::new(launch_file)))
        .invoke_handler(tauri::generate_handler![
            load_pdf,
            load_pdf_bytes,
            close_pdf,
            get_document_info,
            get_page_info,
            get_all_page_infos,
            render_page,
            get_char_rects,
            get_page_text,
            search_text,
            get_launch_file,
        ])
        .setup(|app| {
            // Clone app handle for the event handler
            let app_handle = app.handle().clone();
            
            // Handle file open events on macOS
            // This is called when a file is opened while the app is already running
            // or when the app is launched via file association
            #[cfg(target_os = "macos")]
            {
                use tauri::Listener;
                
                app.listen("tauri://file-drop", move |event| {
                    // Get the payload as a string
                    let payload_str = event.payload();
                    // Parse the dropped files from JSON
                    if let Ok(files) = serde_json::from_str::<Vec<String>>(payload_str) {
                        for file in files {
                            if is_pdf_file(&file) {
                                // Emit to frontend
                                let _ = app_handle.emit("open-file", file);
                                break;
                            }
                        }
                    }
                });
            }
            
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Get the file path that was passed on launch (if any).
/// Frontend calls this on startup to check if a PDF should be opened.
#[tauri::command]
fn get_launch_file(state: tauri::State<LaunchFile>) -> Option<String> {
    let mut guard = state.0.lock().unwrap();
    guard.take() // Return and clear the launch file
}
