//! Tauri commands for PDF operations.
//!
//! These commands expose the PDF renderer to the WebView frontend via IPC.
//! 
//! Note: pdfium-render's Pdfium struct is not Send+Sync, so we don't store
//! it in app state. Instead, we create Pdfium instances on-demand for each
//! operation. The document bytes are stored in state for reuse.

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
