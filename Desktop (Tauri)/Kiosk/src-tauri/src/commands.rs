//! Tauri commands for PDF operations.
//!
//! These commands expose the PDF renderer to the WebView frontend via IPC.
//!
//! PHASE 1 FIX (C-3): The outer documents Mutex is held only for the brief
//! state reads (cloning Arc / path). All expensive operations happen OUTSIDE
//! the outer lock to prevent command queue starvation.
//!
//! PHASE 3 FIX: Each document now stores a persistent `CachedPdf` handle
//! (Pdfium binding + parsed PdfDocument), created once at document open time.
//! Render and query commands reuse this handle via `Arc<Mutex<CachedPdf>>`,
//! eliminating the per-call overhead of re-binding pdfium and re-parsing
//! the full PDF byte buffer. The outer documents Mutex is held only for the
//! Arc clone (~microseconds); the per-document CachedPdf Mutex serializes
//! operations on the same document without blocking other documents.

use crate::annotations::{self, AnnotationData, PdfRect, SaveResult};
use crate::pdf::{
    CachedPdf, CharRect, DocumentInfo, PageInfo, PdfError, SearchResult,
};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::State;

/// Phase 4: Result of a page render — raw RGBA pixels + dimensions.
///
/// `pixels` is serialized as a base64 string to avoid the pathological
/// performance of serde_json's `Vec<u8>` → `[number, number, …]` path.
/// Base64 adds ~33% size overhead but is orders of magnitude faster to
/// serialize/deserialize than a multi-million element JSON number array.
#[derive(Debug, Serialize, Deserialize)]
pub struct RenderResult {
    /// Base64-encoded RGBA pixel data (4 bytes per pixel, row-major, top-to-bottom)
    pub pixels: String,
    /// Pixel width of the rendered image
    pub width: u32,
    /// Pixel height of the rendered image
    pub height: u32,
}

/// Phase 1 diagnostic flag. Set to true to emit timing logs for mutex
/// acquisition and render operations to stderr.
const DEBUG_RENDER_DIAGNOSTICS: bool = true;

/// Log a diagnostic message when the flag is enabled.
macro_rules! diag {
    ($($arg:tt)*) => {
        if DEBUG_RENDER_DIAGNOSTICS {
            eprintln!("[Kiosk Diag] {}", format!($($arg)*));
        }
    };
}

/// Helper: clone the Arc<Mutex<CachedPdf>> out of the locked state map.
/// The outer documents Mutex is held only for the HashMap lookup + Arc clone,
/// then released. All expensive operations run against the cloned Arc.
fn clone_cached_pdf(doc_id: &str, state: &State<AppState>) -> Result<Arc<Mutex<CachedPdf>>, String> {
    let start = Instant::now();
    let cached = {
        let docs = state.documents.lock().unwrap();
        let doc_state = docs
            .get(doc_id)
            .ok_or_else(|| "Document not found".to_string())?;
        Arc::clone(&doc_state.cached_pdf)
    }; // <-- outer documents Mutex released here
    diag!("clone_cached_pdf for {}: mutex held {:?}", doc_id, start.elapsed());
    Ok(cached)
}

/// Helper: clone document path out of the locked state map.
fn clone_doc_path(doc_id: &str, state: &State<AppState>) -> Result<Option<String>, String> {
    let docs = state.documents.lock().unwrap();
    let doc_state = docs
        .get(doc_id)
        .ok_or_else(|| "Document not found".to_string())?;
    Ok(doc_state.path.clone())
}

/// Application state holding loaded documents with persistent PDF handles.
///
/// PHASE 3: Each document now stores a `CachedPdf` that holds a pre-parsed
/// PdfDocument handle. The outer `documents` Mutex protects only the HashMap;
/// per-document access is serialized via the inner `Mutex<CachedPdf>`.
pub struct AppState {
    /// Currently loaded documents, keyed by a unique ID
    pub documents: Mutex<HashMap<String, DocumentState>>,
    /// Counter for generating document IDs
    pub next_id: Mutex<u32>,
}

/// State for a single loaded document.
///
/// PHASE 3: Document bytes and parsed PdfDocument are now encapsulated inside
/// `CachedPdf`. The PDF is parsed once at open time and reused for all
/// subsequent operations.
pub struct DocumentState {
    /// Persistent parsed PDF document (pdfium binding + PdfDocument).
    /// Wrapped in Arc<Mutex<>> for safe shared access outside the outer lock.
    pub cached_pdf: Arc<Mutex<CachedPdf>>,
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

/// Structured response for load_pdf / load_pdf_bytes that lets the frontend
/// distinguish between success, password-required, invalid-password, and
/// generic errors without parsing error strings.
///
/// Serialized as a tagged JSON enum, e.g.
///   { "status": "Success", "data": { "id": "doc_1", "info": { ... } } }
///   { "status": "PasswordRequired" }
///   { "status": "InvalidPassword" }
///   { "status": "Error", "message": "..." }
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "status")]
pub enum LoadPdfResult {
    Success { data: LoadResult },
    PasswordRequired,
    InvalidPassword,
    Error { message: String },
}

/// Load a PDF from a file path.
///
/// PHASE 3: The document is parsed once here. The resulting CachedPdf is stored
/// and reused for all subsequent render/query operations — no re-parse per call.
///
/// Password support: pass `password` = `null` for first attempt; if the
/// response is `PasswordRequired`, prompt the user and retry with the
/// password. The password is used only for this call and is never stored.
#[tauri::command]
pub fn load_pdf(path: String, password: Option<String>, state: State<AppState>) -> LoadPdfResult {
    diag!("load_pdf START path={}", path);
    let load_start = Instant::now();

    // Read file bytes
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => return LoadPdfResult::Error { message: format!("Failed to read PDF file: {}", e) },
    };

    // Parse once — bind pdfium and load document (the expensive part).
    // Password is borrowed for this call only, never stored.
    let cached_pdf = match CachedPdf::new(bytes, password.as_deref()) {
        Ok(c) => c,
        Err(PdfError::PasswordRequired) => return LoadPdfResult::PasswordRequired,
        Err(PdfError::InvalidPassword) => return LoadPdfResult::InvalidPassword,
        Err(e) => return LoadPdfResult::Error { message: e.to_string() },
    };
    let info = match cached_pdf.get_document_info() {
        Ok(i) => i,
        Err(e) => return LoadPdfResult::Error { message: e.to_string() },
    };

    diag!("load_pdf parsed document in {:?} pages={}", load_start.elapsed(), info.page_count);

    // Store persistent handle
    let id = state.generate_id();
    {
        let mut docs = state.documents.lock().unwrap();
        docs.insert(
            id.clone(),
            DocumentState {
                cached_pdf: Arc::new(Mutex::new(cached_pdf)),
                path: Some(path),
            },
        );
    }

    LoadPdfResult::Success { data: LoadResult { id, info } }
}

/// Load a PDF from bytes (e.g., from drag-and-drop).
///
/// PHASE 3: Same persistent-handle strategy as load_pdf.
/// Password support: same semantics as load_pdf.
#[tauri::command]
pub fn load_pdf_bytes(bytes: Vec<u8>, password: Option<String>, state: State<AppState>) -> LoadPdfResult {
    diag!("load_pdf_bytes START len={}", bytes.len());
    let load_start = Instant::now();

    // Parse once
    let cached_pdf = match CachedPdf::new(bytes, password.as_deref()) {
        Ok(c) => c,
        Err(PdfError::PasswordRequired) => return LoadPdfResult::PasswordRequired,
        Err(PdfError::InvalidPassword) => return LoadPdfResult::InvalidPassword,
        Err(e) => return LoadPdfResult::Error { message: e.to_string() },
    };
    let info = match cached_pdf.get_document_info() {
        Ok(i) => i,
        Err(e) => return LoadPdfResult::Error { message: e.to_string() },
    };

    diag!("load_pdf_bytes parsed document in {:?} pages={}", load_start.elapsed(), info.page_count);

    // Store persistent handle
    let id = state.generate_id();
    {
        let mut docs = state.documents.lock().unwrap();
        docs.insert(
            id.clone(),
            DocumentState {
                cached_pdf: Arc::new(Mutex::new(cached_pdf)),
                path: None,
            },
        );
    }

    LoadPdfResult::Success { data: LoadResult { id, info } }
}

/// Close a document and free its resources.
#[tauri::command]
pub fn close_pdf(doc_id: String, state: State<AppState>) -> Result<(), String> {
    let mut docs = state.documents.lock().unwrap();
    docs.remove(&doc_id);
    Ok(())
}

/// Get document info.
///
/// PHASE 3: Uses cached PdfDocument — no re-parse.
#[tauri::command]
pub fn get_document_info(doc_id: String, state: State<AppState>) -> Result<DocumentInfo, String> {
    let cached = clone_cached_pdf(&doc_id, &state)?;
    let pdf = cached.lock().unwrap();
    pdf.get_document_info().map_err(|e| e.to_string())
}

/// Get page info for a specific page.
///
/// PHASE 3: Uses cached PdfDocument — no re-parse.
#[tauri::command]
pub fn get_page_info(
    doc_id: String,
    page_index: u32,
    state: State<AppState>,
) -> Result<PageInfo, String> {
    let cached = clone_cached_pdf(&doc_id, &state)?;
    let pdf = cached.lock().unwrap();
    pdf.get_page_info(page_index).map_err(|e| e.to_string())
}

/// Render a page to raw RGBA pixels.
///
/// # Arguments
/// * `doc_id` - Document ID from load_pdf
/// * `page_index` - 0-based page index
/// * `scale` - Render scale (1.0 = 72 DPI, 2.0 = 144 DPI, etc.)
///
/// PHASE 1 FIX (C-3): outer documents Mutex released before rendering.
/// PHASE 3 FIX: Uses cached PdfDocument — no re-bind or re-parse per call.
/// PHASE 4 FIX: Returns raw RGBA pixels instead of PNG, eliminating
/// PNG encode on the Rust side and PNG decode on the browser side.
/// Pixel data is base64-encoded for efficient JSON transport.
#[tauri::command]
pub fn render_page(
    doc_id: String,
    page_index: u32,
    scale: f32,
    state: State<AppState>,
) -> Result<RenderResult, String> {
    diag!("render_page START doc={} page={} scale={:.2}", doc_id, page_index, scale);
    let render_start = Instant::now();

    // Clone Arc (outer documents mutex held only for this)
    let cached = clone_cached_pdf(&doc_id, &state)?;

    // Render using persistent document (per-document mutex held for render only)
    let pdf = cached.lock().unwrap();
    let (pixels, width, height) = pdf
        .render_page_to_rgba(page_index, scale)
        .map_err(|e| e.to_string())?;

    // Base64-encode for efficient IPC transport
    let b64_start = Instant::now();
    let pixels_b64 = base64::engine::general_purpose::STANDARD.encode(&pixels);
    diag!("render_page base64 encode: {:?} raw={}B b64={}B",
          b64_start.elapsed(), pixels.len(), pixels_b64.len());

    diag!("render_page COMPLETE doc={} page={} {}x{} elapsed={:?}",
          doc_id, page_index, width, height, render_start.elapsed());

    Ok(RenderResult {
        pixels: pixels_b64,
        width,
        height,
    })
}

/// Get character bounding boxes for text selection.
///
/// PHASE 3: Uses cached PdfDocument — no re-parse.
#[tauri::command]
pub fn get_char_rects(
    doc_id: String,
    page_index: u32,
    state: State<AppState>,
) -> Result<Vec<CharRect>, String> {
    let cached = clone_cached_pdf(&doc_id, &state)?;
    let pdf = cached.lock().unwrap();
    pdf.get_char_rects(page_index).map_err(|e| e.to_string())
}

/// Get plain text content of a page.
///
/// PHASE 3: Uses cached PdfDocument — no re-parse.
#[tauri::command]
pub fn get_page_text(
    doc_id: String,
    page_index: u32,
    state: State<AppState>,
) -> Result<String, String> {
    let cached = clone_cached_pdf(&doc_id, &state)?;
    let pdf = cached.lock().unwrap();
    pdf.get_page_text(page_index).map_err(|e| e.to_string())
}

/// Search for text across all pages.
///
/// PHASE 3: Uses cached PdfDocument — no re-parse.
#[tauri::command]
pub fn search_text(
    doc_id: String,
    query: String,
    case_sensitive: bool,
    max_results: Option<usize>,
    state: State<AppState>,
) -> Result<Vec<SearchResult>, String> {
    let cached = clone_cached_pdf(&doc_id, &state)?;
    let pdf = cached.lock().unwrap();
    pdf.search_text(&query, case_sensitive, max_results.unwrap_or(50))
        .map_err(|e| e.to_string())
}

/// Get all page infos for the document.
///
/// PHASE 3: Uses cached PdfDocument — no re-parse.
#[tauri::command]
pub fn get_all_page_infos(doc_id: String, state: State<AppState>) -> Result<Vec<PageInfo>, String> {
    let cached = clone_cached_pdf(&doc_id, &state)?;
    let pdf = cached.lock().unwrap();
    pdf.get_all_page_infos().map_err(|e| e.to_string())
}

// ============================================================================
// Annotation Commands
// ============================================================================

/// Get file path for a loaded document.
#[tauri::command]
pub fn get_document_path(doc_id: String, state: State<AppState>) -> Result<Option<String>, String> {
    clone_doc_path(&doc_id, &state)
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
