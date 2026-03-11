//! Core PDF renderer implementation using pdfium-render.
//!
//! Note: pdfium-render's Pdfium struct is not Send+Sync, so we create instances
//! on-demand within each operation rather than storing in shared state.

use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use std::path::Path;
use thiserror::Error;

/// Errors that can occur during PDF operations.
#[derive(Error, Debug)]
#[allow(dead_code)]
pub enum PdfError {
    #[error("Failed to initialize PDFium: {0}")]
    InitError(String),

    #[error("Failed to load PDF: {0}")]
    LoadError(String),

    #[error("No document loaded")]
    NoDocument,

    #[error("Invalid page index: {0}")]
    InvalidPage(u32),

    #[error("Rendering failed: {0}")]
    RenderError(String),

    #[error("Image encoding failed: {0}")]
    ImageError(String),

    #[error("Password required to open this PDF")]
    PasswordRequired,

    #[error("Incorrect password")]
    InvalidPassword,
}

impl Serialize for PdfError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Character bounding box with precise positioning for text selection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharRect {
    /// The character as a string (handles multi-byte Unicode)
    pub char: String,
    /// Character index within the page
    pub index: usize,
    /// Left edge in PDF points (1/72 inch)
    pub x: f32,
    /// Top edge in PDF points
    pub y: f32,
    /// Character width in PDF points
    pub width: f32,
    /// Character height in PDF points
    pub height: f32,
}

/// Page metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageInfo {
    /// Page index (0-based)
    pub index: u32,
    /// Page width in PDF points
    pub width: f32,
    /// Page height in PDF points
    pub height: f32,
    /// Page rotation in degrees (0, 90, 180, 270)
    pub rotation: i32,
}

/// Document metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentInfo {
    /// Total number of pages
    pub page_count: u32,
    /// Document title (if available)
    pub title: Option<String>,
    /// Document author (if available)
    pub author: Option<String>,
    /// PDF version string
    pub pdf_version: String,
}

/// Result of a text search operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    /// Page index where match was found
    pub page: u32,
    /// Start character index
    pub start_index: usize,
    /// End character index
    pub end_index: usize,
    /// The matched text
    pub text: String,
    /// Bounding rectangles for the match (may span multiple lines)
    pub rects: Vec<TextRect>,
}

/// A text rectangle (for search highlights, selections).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// Bind to PDFium library and return a usable Pdfium instance.
/// This is called on-demand for each operation since Pdfium is not Send+Sync.
fn bind_pdfium() -> Result<Pdfium, PdfError> {
    use std::sync::atomic::{AtomicBool, Ordering};
    static LOGGED_SUCCESS: AtomicBool = AtomicBool::new(false);
    
    // Try multiple library loading strategies
    
    // Strategy 1: Use absolute path relative to executable (for bundled app)
    #[cfg(target_os = "macos")]
    {
        if let Ok(exe_path) = std::env::current_exe() {
            // exe_path is Contents/MacOS/kiosk
            // we need Contents/Frameworks/libpdfium.dylib
            if let Some(macos_dir) = exe_path.parent() {
                let frameworks_path = macos_dir
                    .join("..")
                    .join("Frameworks")
                    .join("libpdfium.dylib");
                
                // Canonicalize to resolve .. and symlinks
                if let Ok(canonical_path) = frameworks_path.canonicalize() {
                    match Pdfium::bind_to_library(&canonical_path) {
                        Ok(bindings) => {
                            if !LOGGED_SUCCESS.swap(true, Ordering::Relaxed) {
                                eprintln!("[Kiosk PDF] Loaded bundled library: {:?}", canonical_path);
                            }
                            return Ok(Pdfium::new(bindings));
                        }
                        Err(e) => {
                            eprintln!("[Kiosk PDF] Failed bundled library: {:?}", e);
                        }
                    }
                }
            }
        }
    }
    
    // Strategy 2: Try @executable_path (may work in some contexts)
    #[cfg(target_os = "macos")]
    {
        let lib_path = "@executable_path/../Frameworks/libpdfium.dylib";
        match Pdfium::bind_to_library(lib_path) {
            Ok(bindings) => {
                if !LOGGED_SUCCESS.swap(true, Ordering::Relaxed) {
                    eprintln!("[Kiosk PDF] Loaded via @executable_path");
                }
                return Ok(Pdfium::new(bindings));
            }
            Err(_) => {}
        }
    }
    
    // Strategy 3: Try system library (for development)
    match Pdfium::bind_to_system_library() {
        Ok(bindings) => {
            if !LOGGED_SUCCESS.swap(true, Ordering::Relaxed) {
                eprintln!("[Kiosk PDF] Loaded system library");
            }
            return Ok(Pdfium::new(bindings));
        }
        Err(_) => {}
    }
    
    // Strategy 4: Try /usr/local/lib (common development location on macOS)
    #[cfg(target_os = "macos")]
    {
        let dev_path = "/usr/local/lib/libpdfium.dylib";
        match Pdfium::bind_to_library(dev_path) {
            Ok(bindings) => {
                if !LOGGED_SUCCESS.swap(true, Ordering::Relaxed) {
                    eprintln!("[Kiosk PDF] Loaded from /usr/local/lib");
                }
                return Ok(Pdfium::new(bindings));
            }
            Err(_) => {}
        }
    }
    
    #[cfg(target_os = "windows")]
    {
        // Strategy W1: Load pdfium.dll from the same directory as the executable
        // (Tauri bundles resources next to the exe)
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                let dll_path = exe_dir.join("pdfium.dll");
                if dll_path.exists() {
                    match Pdfium::bind_to_library(&dll_path) {
                        Ok(bindings) => {
                            if !LOGGED_SUCCESS.swap(true, Ordering::Relaxed) {
                                eprintln!("[Kiosk PDF] Loaded bundled pdfium.dll: {:?}", dll_path);
                            }
                            return Ok(Pdfium::new(bindings));
                        }
                        Err(e) => {
                            eprintln!("[Kiosk PDF] Failed bundled pdfium.dll: {:?}", e);
                        }
                    }
                }
            }
        }

        // Strategy W2: Fallback — try loading from system PATH
        if let Ok(bindings) = Pdfium::bind_to_library("pdfium.dll") {
            if !LOGGED_SUCCESS.swap(true, Ordering::Relaxed) {
                eprintln!("[Kiosk PDF] Loaded pdfium.dll from system PATH");
            }
            return Ok(Pdfium::new(bindings));
        }
    }
    
    #[cfg(target_os = "linux")]
    {
        // Strategy L1: Load from next to executable (AppImage or dev build)
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                let so_path = exe_dir.join("libpdfium.so");
                if so_path.exists() {
                    match Pdfium::bind_to_library(&so_path) {
                        Ok(bindings) => {
                            if !LOGGED_SUCCESS.swap(true, Ordering::Relaxed) {
                                eprintln!("[Kiosk PDF] Loaded bundled libpdfium.so: {:?}", so_path);
                            }
                            return Ok(Pdfium::new(bindings));
                        }
                        Err(e) => {
                            eprintln!("[Kiosk PDF] Failed bundled libpdfium.so: {:?}", e);
                        }
                    }
                }

                // Strategy L2: Try ../lib/kiosk/ (standard .deb install layout)
                let lib_path = exe_dir.join("../lib/kiosk/libpdfium.so");
                if let Ok(canonical) = lib_path.canonicalize() {
                    match Pdfium::bind_to_library(&canonical) {
                        Ok(bindings) => {
                            if !LOGGED_SUCCESS.swap(true, Ordering::Relaxed) {
                                eprintln!("[Kiosk PDF] Loaded libpdfium.so from lib dir: {:?}", canonical);
                            }
                            return Ok(Pdfium::new(bindings));
                        }
                        Err(e) => {
                            eprintln!("[Kiosk PDF] Failed lib dir libpdfium.so: {:?}", e);
                        }
                    }
                }
            }
        }

        // Strategy L3: Try system library path
        if let Ok(bindings) = Pdfium::bind_to_library("libpdfium.so") {
            if !LOGGED_SUCCESS.swap(true, Ordering::Relaxed) {
                eprintln!("[Kiosk PDF] Loaded system libpdfium.so");
            }
            return Ok(Pdfium::new(bindings));
        }
    }
    
    // All strategies failed
    #[cfg(target_os = "macos")]
    let msg = "Could not load PDFium library. Please ensure libpdfium.dylib is in the app bundle.";
    #[cfg(target_os = "windows")]
    let msg = "Could not load PDFium library. Please ensure pdfium.dll is alongside the executable.";
    #[cfg(target_os = "linux")]
    let msg = "Could not load PDFium library. Please ensure libpdfium.so is installed or bundled with the app.";
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    let msg = "Could not load PDFium library.";
    Err(PdfError::InitError(msg.to_string()))
}

/// Load a PDF from a file path and return document info.
/// NOTE: Superseded by CachedPdf::new() for normal operations (Phase 3).
#[allow(dead_code)]
pub fn load_pdf_from_file(path: &str) -> Result<(Vec<u8>, DocumentInfo), PdfError> {
    let path_obj = Path::new(path);
    let bytes = std::fs::read(path_obj).map_err(|e| PdfError::LoadError(e.to_string()))?;
    let info = load_pdf_from_bytes(&bytes)?;
    Ok((bytes, info))
}

/// Load a PDF from bytes and return document info.
/// NOTE: Superseded by CachedPdf::new() + get_document_info() (Phase 3).
#[allow(dead_code)]
pub fn load_pdf_from_bytes(bytes: &[u8]) -> Result<DocumentInfo, PdfError> {
    let pdfium = bind_pdfium()?;
    let doc = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| PdfError::LoadError(e.to_string()))?;
    
    // Get metadata using the new API
    let metadata = doc.metadata();
    let title = metadata
        .get(PdfDocumentMetadataTagType::Title)
        .map(|t| t.value().to_string());
    let author = metadata
        .get(PdfDocumentMetadataTagType::Author)
        .map(|t| t.value().to_string());
    
    // Get version as string
    let version = doc.version();
    let pdf_version = format!("{:?}", version);
    
    Ok(DocumentInfo {
        page_count: doc.pages().len() as u32,
        title,
        author,
        pdf_version,
    })
}

/// Get document info from bytes.
/// NOTE: Superseded by CachedPdf::get_document_info() (Phase 3).
#[allow(dead_code)]
pub fn get_document_info(bytes: &[u8]) -> Result<DocumentInfo, PdfError> {
    load_pdf_from_bytes(bytes)
}

/// Get page info for a specific page.
/// NOTE: Superseded by CachedPdf::get_page_info() (Phase 3).
#[allow(dead_code)]
pub fn get_page_info(bytes: &[u8], page_index: u32) -> Result<PageInfo, PdfError> {
    let pdfium = bind_pdfium()?;
    let doc = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| PdfError::LoadError(e.to_string()))?;
    
    let page = doc
        .pages()
        .get(page_index as u16)
        .map_err(|_| PdfError::InvalidPage(page_index))?;

    Ok(PageInfo {
        index: page_index,
        width: page.width().value,
        height: page.height().value,
        rotation: match page.rotation() {
            Ok(rot) => match rot {
                PdfPageRenderRotation::None => 0,
                PdfPageRenderRotation::Degrees90 => 90,
                PdfPageRenderRotation::Degrees180 => 180,
                PdfPageRenderRotation::Degrees270 => 270,
            },
            Err(_) => 0,
        },
    })
}

/// Render a page to PNG bytes.
/// NOTE: Superseded by CachedPdf::render_page_to_png() (Phase 3).
#[allow(dead_code)]
pub fn render_page_to_png(bytes: &[u8], page_index: u32, scale: f32) -> Result<Vec<u8>, PdfError> {
    let pdfium = bind_pdfium()?;
    let doc = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| PdfError::LoadError(e.to_string()))?;
    
    let page = doc
        .pages()
        .get(page_index as u16)
        .map_err(|_| PdfError::InvalidPage(page_index))?;

    let width = (page.width().value * scale) as i32;
    let height = (page.height().value * scale) as i32;

    // Configure high-quality rendering
    let config = PdfRenderConfig::new()
        .set_target_width(width)
        .set_target_height(height)
        .render_form_data(true)
        .render_annotations(true);

    let bitmap = page
        .render_with_config(&config)
        .map_err(|e| PdfError::RenderError(e.to_string()))?;

    // Convert to image and encode as PNG
    let image = bitmap.as_image();
    let mut png_bytes = Vec::new();
    
    image
        .write_to(&mut Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .map_err(|e| PdfError::ImageError(e.to_string()))?;

    Ok(png_bytes)
}

/// Get character bounding boxes for text selection.
/// NOTE: Superseded by CachedPdf::get_char_rects() (Phase 3).
#[allow(dead_code)]
pub fn get_char_rects(bytes: &[u8], page_index: u32) -> Result<Vec<CharRect>, PdfError> {
    let pdfium = bind_pdfium()?;
    let doc = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| PdfError::LoadError(e.to_string()))?;
    
    let page = doc
        .pages()
        .get(page_index as u16)
        .map_err(|_| PdfError::InvalidPage(page_index))?;

    let text_page = page
        .text()
        .map_err(|e| PdfError::RenderError(e.to_string()))?;

    let mut rects = Vec::new();
    let page_height = page.height().value;
    
    // Use the chars() iterator
    for (i, char_obj) in text_page.chars().iter().enumerate() {
        // Get the character string
        if let Some(char_str) = char_obj.unicode_string() {
            // Skip whitespace characters that don't have meaningful bounds (except space)
            let first_char = char_str.chars().next();
            if let Some(c) = first_char {
                if c.is_whitespace() && c != ' ' {
                    continue;
                }
            }
            
            // Get tight bounds for the character
            if let Ok(rect) = char_obj.tight_bounds() {
                rects.push(CharRect {
                    char: char_str,
                    index: i,
                    x: rect.left().value,
                    // PDF coordinates are bottom-up, convert to top-down
                    y: page_height - rect.top().value,
                    width: rect.width().value,
                    height: rect.height().value,
                });
            }
        }
    }

    Ok(rects)
}

/// Get plain text content of a page.
/// NOTE: Superseded by CachedPdf::get_page_text() (Phase 3).
#[allow(dead_code)]
pub fn get_page_text(bytes: &[u8], page_index: u32) -> Result<String, PdfError> {
    let pdfium = bind_pdfium()?;
    let doc = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| PdfError::LoadError(e.to_string()))?;
    
    let page = doc
        .pages()
        .get(page_index as u16)
        .map_err(|_| PdfError::InvalidPage(page_index))?;

    let text_page = page
        .text()
        .map_err(|e| PdfError::RenderError(e.to_string()))?;

    // Use the all() method to get all text
    Ok(text_page.all())
}

/// Search for text across all pages.
/// NOTE: Superseded by CachedPdf::search_text() (Phase 3).
#[allow(dead_code)]
pub fn search_text(
    bytes: &[u8],
    query: &str,
    case_sensitive: bool,
    max_results: usize,
) -> Result<Vec<SearchResult>, PdfError> {
    let pdfium = bind_pdfium()?;
    let doc = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| PdfError::LoadError(e.to_string()))?;
    
    let mut results = Vec::new();
    let search_query = if case_sensitive {
        query.to_string()
    } else {
        query.to_lowercase()
    };

    for page_index in 0..doc.pages().len() {
        if results.len() >= max_results {
            break;
        }

        if let Ok(page) = doc.pages().get(page_index as u16) {
            if let Ok(text_page) = page.text() {
                let page_text = text_page.all();
                let page_height = page.height().value;
                
                let search_text = if case_sensitive {
                    page_text.clone()
                } else {
                    page_text.to_lowercase()
                };

                let mut start = 0;
                while let Some(pos) = search_text[start..].find(&search_query) {
                    if results.len() >= max_results {
                        break;
                    }

                    let match_start = start + pos;
                    let match_end = match_start + query.len();

                    // Get bounding rects for the match
                    let mut match_rects = Vec::new();
                    
                    // Get the chars collection and keep it alive
                    let chars_collection = text_page.chars();
                    let chars: Vec<_> = chars_collection.iter().collect();
                    
                    for i in match_start..match_end.min(chars.len()) {
                        if let Ok(rect) = chars[i].tight_bounds() {
                            match_rects.push(TextRect {
                                x: rect.left().value,
                                y: page_height - rect.top().value,
                                width: rect.width().value,
                                height: rect.height().value,
                            });
                        }
                    }

                    // Merge adjacent rects on the same line
                    let merged_rects = merge_text_rects(match_rects);

                    results.push(SearchResult {
                        page: page_index as u32,
                        start_index: match_start,
                        end_index: match_end,
                        text: page_text.chars().skip(match_start).take(match_end - match_start).collect(),
                        rects: merged_rects,
                    });

                    start = match_end;
                }
            }
        }
    }

    Ok(results)
}

/// Get all page infos for the document.
/// NOTE: Superseded by CachedPdf::get_all_page_infos() (Phase 3).
#[allow(dead_code)]
pub fn get_all_page_infos(bytes: &[u8]) -> Result<Vec<PageInfo>, PdfError> {
    let pdfium = bind_pdfium()?;
    let doc = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| PdfError::LoadError(e.to_string()))?;
    
    let page_count = doc.pages().len() as u32;
    let mut infos = Vec::with_capacity(page_count as usize);

    for i in 0..page_count {
        let page = doc
            .pages()
            .get(i as u16)
            .map_err(|_| PdfError::InvalidPage(i))?;

        infos.push(PageInfo {
            index: i,
            width: page.width().value,
            height: page.height().value,
            rotation: match page.rotation() {
                Ok(rot) => match rot {
                    PdfPageRenderRotation::None => 0,
                    PdfPageRenderRotation::Degrees90 => 90,
                    PdfPageRenderRotation::Degrees180 => 180,
                    PdfPageRenderRotation::Degrees270 => 270,
                },
                Err(_) => 0,
            },
        });
    }

    Ok(infos)
}

/// Merge adjacent text rectangles on the same line into single rectangles.
fn merge_text_rects(rects: Vec<TextRect>) -> Vec<TextRect> {
    if rects.is_empty() {
        return rects;
    }

    let mut merged = Vec::new();
    let mut current = rects[0].clone();
    let tolerance = 2.0; // Points tolerance for "same line"

    for rect in rects.into_iter().skip(1) {
        // Check if on same line (similar y position)
        if (rect.y - current.y).abs() < tolerance {
            // Extend current rect
            let new_right = rect.x + rect.width;
            let current_right = current.x + current.width;
            current.width = new_right.max(current_right) - current.x;
            current.height = current.height.max(rect.height);
        } else {
            // Start new rect
            merged.push(current);
            current = rect;
        }
    }
    merged.push(current);

    merged
}

// ============================================================================
// Persistent PDF Document Cache (Phase 3)
// ============================================================================

/// A cached PDF document that persists across render calls.
/// Eliminates the per-call overhead of binding pdfium and re-parsing the PDF.
///
/// # Safety
///
/// This struct uses `unsafe` to manage self-referential lifetimes:
/// - `document` (`PdfDocument<'static>`) is transmuted from a borrowed lifetime.
/// - It internally holds pointers into the heap data of `_bytes` (`Vec<u8>`)
///   and the heap-allocated bindings inside `_pdfium` (`Pdfium`).
/// - Both `_pdfium` and `_bytes` are owned by this struct and are dropped
///   AFTER `document` (Rust drops fields in declaration order).
/// - The heap-allocated data backing `_bytes` and `_pdfium` does not move
///   when the struct itself is moved, so all internal pointers remain valid.
/// - Neither `_bytes` nor `_pdfium` are modified after document creation.
pub struct CachedPdf {
    // IMPORTANT: `document` MUST be the first field for correct drop order.
    // Rust drops struct fields in declaration order. `document` borrows from
    // `_pdfium` and `_bytes`, so it must be dropped before them.
    document: PdfDocument<'static>,
    _pdfium: Pdfium,
    _bytes: Vec<u8>,
}

// SAFETY: CachedPdf is safe to send between threads because:
// 1. `PdfDocument` wraps an FPDF_DOCUMENT handle (opaque pointer) and a
//    reference to bindings (function pointers on the heap).
// 2. `Pdfium` wraps `Box<dyn PdfiumLibraryBindings>` — heap-allocated
//    function pointers with no thread affinity.
// 3. PDFium's C API is thread-safe when document handles are not used
//    concurrently on the same document.
// 4. We enforce exclusive access via `Mutex<CachedPdf>` at the call site.
unsafe impl Send for CachedPdf {}

impl CachedPdf {
    /// Create a new CachedPdf by binding pdfium once and parsing the document once.
    /// The resulting handle can be reused for all subsequent operations on this document.
    ///
    /// # Password handling
    /// Pass `None` for unprotected PDFs. If the PDF is password-protected
    /// and `password` is `None` or incorrect, a `PasswordRequired` or
    /// `InvalidPassword` error is returned. The password is used only
    /// during this call and is never stored.
    pub fn new(bytes: Vec<u8>, password: Option<&str>) -> Result<Self, PdfError> {
        let pdfium = bind_pdfium()?;
        let document = pdfium
            .load_pdf_from_byte_slice(&bytes, password)
            .map_err(|e| {
                let msg = e.to_string().to_lowercase();
                // pdfium-render surfaces FPDF_ERR_PASSWORD as an error whose
                // description contains "password". We map that to our typed
                // password errors so the frontend can show the right UI.
                if msg.contains("password") {
                    if password.is_some() {
                        PdfError::InvalidPassword
                    } else {
                        PdfError::PasswordRequired
                    }
                } else {
                    PdfError::LoadError(e.to_string())
                }
            })?;

        // SAFETY: Transmuting PdfDocument<'a> to PdfDocument<'static>.
        //
        // The document internally holds:
        //   - A reference to the pdfium bindings (heap-allocated via Box, stable address)
        //   - An FPDF_DOCUMENT handle (pointer to PDFium-internal C data)
        //   - A pointer to the byte slice data (heap data of Vec<u8>, stable address)
        //
        // All three remain valid as long as this struct exists because:
        //   - `_bytes` and `_pdfium` are owned fields, never modified after this point.
        //   - `document` is declared first and therefore dropped first.
        //   - Moving the struct moves only stack metadata (Vec ptr/len/cap, Box ptr);
        //     the heap data they point to does not relocate.
        let document: PdfDocument<'static> = unsafe { std::mem::transmute(document) };

        Ok(CachedPdf {
            document,
            _pdfium: pdfium,
            _bytes: bytes,
        })
    }

    /// Get document metadata from the cached document.
    pub fn get_document_info(&self) -> Result<DocumentInfo, PdfError> {
        let metadata = self.document.metadata();
        let title = metadata
            .get(PdfDocumentMetadataTagType::Title)
            .map(|t| t.value().to_string());
        let author = metadata
            .get(PdfDocumentMetadataTagType::Author)
            .map(|t| t.value().to_string());
        let version = self.document.version();
        let pdf_version = format!("{:?}", version);

        Ok(DocumentInfo {
            page_count: self.document.pages().len() as u32,
            title,
            author,
            pdf_version,
        })
    }

    /// Get page info for a specific page from the cached document.
    pub fn get_page_info(&self, page_index: u32) -> Result<PageInfo, PdfError> {
        let page = self.document
            .pages()
            .get(page_index as u16)
            .map_err(|_| PdfError::InvalidPage(page_index))?;

        Ok(PageInfo {
            index: page_index,
            width: page.width().value,
            height: page.height().value,
            rotation: match page.rotation() {
                Ok(rot) => match rot {
                    PdfPageRenderRotation::None => 0,
                    PdfPageRenderRotation::Degrees90 => 90,
                    PdfPageRenderRotation::Degrees180 => 180,
                    PdfPageRenderRotation::Degrees270 => 270,
                },
                Err(_) => 0,
            },
        })
    }

    /// Render a page to PNG bytes using the cached document (no re-parse).
    /// NOTE: Retained as fallback. Phase 4 hot path uses render_page_to_rgba().
    #[allow(dead_code)]
    pub fn render_page_to_png(&self, page_index: u32, scale: f32) -> Result<Vec<u8>, PdfError> {
        let page = self.document
            .pages()
            .get(page_index as u16)
            .map_err(|_| PdfError::InvalidPage(page_index))?;

        let width = (page.width().value * scale) as i32;
        let height = (page.height().value * scale) as i32;

        let config = PdfRenderConfig::new()
            .set_target_width(width)
            .set_target_height(height)
            .render_form_data(true)
            .render_annotations(true);

        let bitmap = page
            .render_with_config(&config)
            .map_err(|e| PdfError::RenderError(e.to_string()))?;

        let image = bitmap.as_image();
        let mut png_bytes = Vec::new();

        image
            .write_to(&mut Cursor::new(&mut png_bytes), image::ImageFormat::Png)
            .map_err(|e| PdfError::ImageError(e.to_string()))?;

        Ok(png_bytes)
    }

    /// Render a page to raw RGBA pixel buffer using the cached document.
    ///
    /// PHASE 4: Replaces PNG encoding on the hot path. Returns raw RGBA
    /// pixels plus dimensions, eliminating the PNG encode step (~20–100 ms
    /// per page at high DPR) and the corresponding browser PNG decode step.
    ///
    /// The returned buffer is tightly packed RGBA (4 bytes per pixel),
    /// row-major, top-to-bottom.
    pub fn render_page_to_rgba(
        &self,
        page_index: u32,
        scale: f32,
    ) -> Result<(Vec<u8>, u32, u32), PdfError> {
        let page = self.document
            .pages()
            .get(page_index as u16)
            .map_err(|_| PdfError::InvalidPage(page_index))?;

        let width = (page.width().value * scale) as i32;
        let height = (page.height().value * scale) as i32;

        let config = PdfRenderConfig::new()
            .set_target_width(width)
            .set_target_height(height)
            .render_form_data(true)
            .render_annotations(true);

        let bitmap = page
            .render_with_config(&config)
            .map_err(|e| PdfError::RenderError(e.to_string()))?;

        // Convert to RGBA without PNG encoding
        let image = bitmap.as_image();
        let rgba = image.to_rgba8();
        let (w, h) = rgba.dimensions();
        let raw_pixels = rgba.into_raw();

        Ok((raw_pixels, w, h))
    }

    /// Get character bounding boxes for text selection from the cached document.
    pub fn get_char_rects(&self, page_index: u32) -> Result<Vec<CharRect>, PdfError> {
        let page = self.document
            .pages()
            .get(page_index as u16)
            .map_err(|_| PdfError::InvalidPage(page_index))?;

        let text_page = page
            .text()
            .map_err(|e| PdfError::RenderError(e.to_string()))?;

        let mut rects = Vec::new();
        let page_height = page.height().value;

        for (i, char_obj) in text_page.chars().iter().enumerate() {
            if let Some(char_str) = char_obj.unicode_string() {
                let first_char = char_str.chars().next();
                if let Some(c) = first_char {
                    if c.is_whitespace() && c != ' ' {
                        continue;
                    }
                }

                if let Ok(rect) = char_obj.tight_bounds() {
                    rects.push(CharRect {
                        char: char_str,
                        index: i,
                        x: rect.left().value,
                        y: page_height - rect.top().value,
                        width: rect.width().value,
                        height: rect.height().value,
                    });
                }
            }
        }

        Ok(rects)
    }

    /// Get plain text content of a page from the cached document.
    pub fn get_page_text(&self, page_index: u32) -> Result<String, PdfError> {
        let page = self.document
            .pages()
            .get(page_index as u16)
            .map_err(|_| PdfError::InvalidPage(page_index))?;

        let text_page = page
            .text()
            .map_err(|e| PdfError::RenderError(e.to_string()))?;

        Ok(text_page.all())
    }

    /// Search for text across all pages using the cached document.
    pub fn search_text(
        &self,
        query: &str,
        case_sensitive: bool,
        max_results: usize,
    ) -> Result<Vec<SearchResult>, PdfError> {
        let mut results = Vec::new();
        let search_query = if case_sensitive {
            query.to_string()
        } else {
            query.to_lowercase()
        };

        for page_index in 0..self.document.pages().len() {
            if results.len() >= max_results {
                break;
            }

            if let Ok(page) = self.document.pages().get(page_index as u16) {
                if let Ok(text_page) = page.text() {
                    let page_text = text_page.all();
                    let page_height = page.height().value;

                    let search_text_str = if case_sensitive {
                        page_text.clone()
                    } else {
                        page_text.to_lowercase()
                    };

                    let mut start = 0;
                    while let Some(pos) = search_text_str[start..].find(&search_query) {
                        if results.len() >= max_results {
                            break;
                        }

                        let match_start = start + pos;
                        let match_end = match_start + query.len();

                        let mut match_rects = Vec::new();
                        let chars_collection = text_page.chars();
                        let chars: Vec<_> = chars_collection.iter().collect();

                        for i in match_start..match_end.min(chars.len()) {
                            if let Ok(rect) = chars[i].tight_bounds() {
                                match_rects.push(TextRect {
                                    x: rect.left().value,
                                    y: page_height - rect.top().value,
                                    width: rect.width().value,
                                    height: rect.height().value,
                                });
                            }
                        }

                        let merged_rects = merge_text_rects(match_rects);

                        results.push(SearchResult {
                            page: page_index as u32,
                            start_index: match_start,
                            end_index: match_end,
                            text: page_text
                                .chars()
                                .skip(match_start)
                                .take(match_end - match_start)
                                .collect(),
                            rects: merged_rects,
                        });

                        start = match_end;
                    }
                }
            }
        }

        Ok(results)
    }

    /// Get all page infos for the document from the cached document.
    pub fn get_all_page_infos(&self) -> Result<Vec<PageInfo>, PdfError> {
        let page_count = self.document.pages().len() as u32;
        let mut infos = Vec::with_capacity(page_count as usize);

        for i in 0..page_count {
            let page = self.document
                .pages()
                .get(i as u16)
                .map_err(|_| PdfError::InvalidPage(i))?;

            infos.push(PageInfo {
                index: i,
                width: page.width().value,
                height: page.height().value,
                rotation: match page.rotation() {
                    Ok(rot) => match rot {
                        PdfPageRenderRotation::None => 0,
                        PdfPageRenderRotation::Degrees90 => 90,
                        PdfPageRenderRotation::Degrees180 => 180,
                        PdfPageRenderRotation::Degrees270 => 270,
                    },
                    Err(_) => 0,
                },
            });
        }

        Ok(infos)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_merge_text_rects() {
        let rects = vec![
            TextRect { x: 0.0, y: 10.0, width: 10.0, height: 12.0 },
            TextRect { x: 10.0, y: 10.0, width: 10.0, height: 12.0 },
            TextRect { x: 20.0, y: 10.0, width: 10.0, height: 12.0 },
        ];
        
        let merged = merge_text_rects(rects);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].width, 30.0);
    }
}
