//! Tauri commands for PDF operations.
//!
//! These commands expose the PDF renderer to the WebView frontend via IPC.
//! 
//! Note: pdfium-render's Pdfium struct is not Send+Sync, so we don't store
//! it in app state. Instead, we create Pdfium instances on-demand for each
//! operation. The document bytes are stored in state for reuse.

use crate::annotations::{self, AnnotationData, PdfRect, SaveResult};
use crate::pdf::{
    self, CharRect, DocumentInfo, PageInfo, SearchResult,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

/// Application state holding loaded documents (bytes only, no Pdfium references).
pub struct AppState {
    /// Currently loaded documents, keyed by a unique ID
    pub documents: Mutex<HashMap<String, DocumentState>>,
    /// Counter for generating document IDs
    pub next_id: Mutex<u32>,
}

/// State for a single loaded document.
pub struct DocumentState {
    /// Raw PDF bytes (needed because PdfDocument has lifetime tied to bytes)
    pub bytes: Vec<u8>,
    /// File path (if loaded from file)
    pub path: Option<String>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            documents: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }

    fn generate_id(&self) -> String {
        let mut id = self.next_id.lock().unwrap();
        let current = *id;
        *id += 1;
        format!("doc_{}", current)
    }
}

/// Result of loading a PDF.
#[derive(Debug, Serialize, Deserialize)]
pub struct LoadResult {
    /// Unique document ID for subsequent operations
    pub id: String,
    /// Document metadata
    pub info: DocumentInfo,
}

/// Load a PDF from a file path.
#[tauri::command]
pub fn load_pdf(path: String, state: State<AppState>) -> Result<LoadResult, String> {
    // Load PDF from file and get info
    let (bytes, info) = pdf::load_pdf_from_file(&path).map_err(|e| e.to_string())?;

    // Store document bytes
    let id = state.generate_id();
    {
        let mut docs = state.documents.lock().unwrap();
        docs.insert(
            id.clone(),
            DocumentState {
                bytes,
                path: Some(path),
            },
        );
    }

    Ok(LoadResult { id, info })
}

/// Load a PDF from bytes (e.g., from drag-and-drop).
#[tauri::command]
pub fn load_pdf_bytes(bytes: Vec<u8>, state: State<AppState>) -> Result<LoadResult, String> {
    // Load and get info
    let info = pdf::load_pdf_from_bytes(&bytes).map_err(|e| e.to_string())?;

    // Store document bytes
    let id = state.generate_id();
    {
        let mut docs = state.documents.lock().unwrap();
        docs.insert(id.clone(), DocumentState { bytes, path: None });
    }

    Ok(LoadResult { id, info })
}

/// Close a document and free its resources.
#[tauri::command]
pub fn close_pdf(doc_id: String, state: State<AppState>) -> Result<(), String> {
    let mut docs = state.documents.lock().unwrap();
    docs.remove(&doc_id);
    Ok(())
}

/// Get document info.
#[tauri::command]
pub fn get_document_info(doc_id: String, state: State<AppState>) -> Result<DocumentInfo, String> {
    let docs = state.documents.lock().unwrap();
    let doc_state = docs
        .get(&doc_id)
        .ok_or_else(|| "Document not found".to_string())?;

    pdf::get_document_info(&doc_state.bytes).map_err(|e| e.to_string())
}

/// Get page info for a specific page.
#[tauri::command]
pub fn get_page_info(
    doc_id: String,
    page_index: u32,
    state: State<AppState>,
) -> Result<PageInfo, String> {
    let docs = state.documents.lock().unwrap();
    let doc_state = docs
        .get(&doc_id)
        .ok_or_else(|| "Document not found".to_string())?;

    pdf::get_page_info(&doc_state.bytes, page_index).map_err(|e| e.to_string())
}

/// Render a page to PNG bytes.
///
/// # Arguments
/// * `doc_id` - Document ID from load_pdf
/// * `page_index` - 0-based page index
/// * `scale` - Render scale (1.0 = 72 DPI, 2.0 = 144 DPI, etc.)
#[tauri::command]
pub fn render_page(
    doc_id: String,
    page_index: u32,
    scale: f32,
    state: State<AppState>,
) -> Result<Vec<u8>, String> {
    let docs = state.documents.lock().unwrap();
    let doc_state = docs
        .get(&doc_id)
        .ok_or_else(|| "Document not found".to_string())?;

    pdf::render_page_to_png(&doc_state.bytes, page_index, scale).map_err(|e| e.to_string())
}

/// Get character bounding boxes for text selection.
#[tauri::command]
pub fn get_char_rects(
    doc_id: String,
    page_index: u32,
    state: State<AppState>,
) -> Result<Vec<CharRect>, String> {
    let docs = state.documents.lock().unwrap();
    let doc_state = docs
        .get(&doc_id)
        .ok_or_else(|| "Document not found".to_string())?;

    pdf::get_char_rects(&doc_state.bytes, page_index).map_err(|e| e.to_string())
}

/// Get plain text content of a page.
#[tauri::command]
pub fn get_page_text(
    doc_id: String,
    page_index: u32,
    state: State<AppState>,
) -> Result<String, String> {
    let docs = state.documents.lock().unwrap();
    let doc_state = docs
        .get(&doc_id)
        .ok_or_else(|| "Document not found".to_string())?;

    pdf::get_page_text(&doc_state.bytes, page_index).map_err(|e| e.to_string())
}

/// Search for text across all pages.
#[tauri::command]
pub fn search_text(
    doc_id: String,
    query: String,
    case_sensitive: bool,
    max_results: Option<usize>,
    state: State<AppState>,
) -> Result<Vec<SearchResult>, String> {
    let docs = state.documents.lock().unwrap();
    let doc_state = docs
        .get(&doc_id)
        .ok_or_else(|| "Document not found".to_string())?;

    pdf::search_text(&doc_state.bytes, &query, case_sensitive, max_results.unwrap_or(50))
        .map_err(|e| e.to_string())
}

/// Get all page infos for the document.
#[tauri::command]
pub fn get_all_page_infos(doc_id: String, state: State<AppState>) -> Result<Vec<PageInfo>, String> {
    let docs = state.documents.lock().unwrap();
    let doc_state = docs
        .get(&doc_id)
        .ok_or_else(|| "Document not found".to_string())?;

    pdf::get_all_page_infos(&doc_state.bytes).map_err(|e| e.to_string())
}

// ============================================================================
// Annotation Commands
// ============================================================================

/// Get file path for a loaded document.
#[tauri::command]
pub fn get_document_path(doc_id: String, state: State<AppState>) -> Result<Option<String>, String> {
    let docs = state.documents.lock().unwrap();
    let doc_state = docs
        .get(&doc_id)
        .ok_or_else(|| "Document not found".to_string())?;
    
    Ok(doc_state.path.clone())
}

/// Get existing annotations from a PDF file.
#[tauri::command]
pub fn get_annotations(path: String) -> Result<Vec<AnnotationData>, String> {
    annotations::get_annotations(&path).map_err(|e| e.to_string())
}

/// Save annotations to a PDF file.
/// If dest_path is None, saves to the original file.
#[tauri::command]
pub fn save_annotations(
    source_path: String,
    dest_path: Option<String>,
    annotations_data: Vec<AnnotationData>,
) -> Result<SaveResult, String> {
    let dest = dest_path.unwrap_or_else(|| source_path.clone());
    
    // If saving to the same file, we need to use a temp file first
    if dest == source_path {
        let temp_path = format!("{}.tmp", source_path);
        
        // Save to temp file
        let result = annotations::save_annotations(&source_path, &temp_path, annotations_data)
            .map_err(|e| e.to_string())?;
        
        // Replace original with temp
        std::fs::rename(&temp_path, &source_path)
            .map_err(|e| format!("Failed to replace original file: {}", e))?;
        
        Ok(SaveResult {
            success: true,
            path: source_path,
            annotations_count: result.annotations_count,
        })
    } else {
        annotations::save_annotations(&source_path, &dest, annotations_data)
            .map_err(|e| e.to_string())
    }
}

/// Remove a specific annotation from a PDF.
#[tauri::command]
pub fn remove_annotation(
    source_path: String,
    dest_path: Option<String>,
    page_index: u32,
    rect_x1: f64,
    rect_y1: f64,
    rect_x2: f64,
    rect_y2: f64,
) -> Result<bool, String> {
    let dest = dest_path.unwrap_or_else(|| source_path.clone());
    let rect = PdfRect { x1: rect_x1, y1: rect_y1, x2: rect_x2, y2: rect_y2 };
    
    if dest == source_path {
        let temp_path = format!("{}.tmp", source_path);
        
        let result = annotations::remove_annotation(&source_path, &temp_path, page_index, &rect)
            .map_err(|e| e.to_string())?;
        
        if result {
            std::fs::rename(&temp_path, &source_path)
                .map_err(|e| format!("Failed to replace original file: {}", e))?;
        } else {
            // Clean up temp file if annotation wasn't found
            let _ = std::fs::remove_file(&temp_path);
        }
        
        Ok(result)
    } else {
        annotations::remove_annotation(&source_path, &dest, page_index, &rect)
            .map_err(|e| e.to_string())
    }
}

/// Clear all annotations from a page.
#[tauri::command]
pub fn clear_page_annotations(
    source_path: String,
    dest_path: Option<String>,
    page_index: u32,
) -> Result<usize, String> {
    let dest = dest_path.unwrap_or_else(|| source_path.clone());
    
    if dest == source_path {
        let temp_path = format!("{}.tmp", source_path);
        
        let count = annotations::clear_page_annotations(&source_path, &temp_path, page_index)
            .map_err(|e| e.to_string())?;
        
        if count > 0 {
            std::fs::rename(&temp_path, &source_path)
                .map_err(|e| format!("Failed to replace original file: {}", e))?;
        } else {
            let _ = std::fs::remove_file(&temp_path);
        }
        
        Ok(count)
    } else {
        annotations::clear_page_annotations(&source_path, &dest, page_index)
            .map_err(|e| e.to_string())
    }
}
