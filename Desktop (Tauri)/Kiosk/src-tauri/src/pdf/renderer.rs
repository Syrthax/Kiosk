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
        if let Ok(bindings) = Pdfium::bind_to_library("libpdfium.so") {
            return Ok(Pdfium::new(bindings));
        }
    }
    
    // All strategies failed
    Err(PdfError::InitError(
        "Could not load PDFium library. Please ensure libpdfium.dylib is in the app bundle.".to_string()
    ))
}

/// Load a PDF from a file path and return document info.
pub fn load_pdf_from_file(path: &str) -> Result<(Vec<u8>, DocumentInfo), PdfError> {
    let path_obj = Path::new(path);
    let bytes = std::fs::read(path_obj).map_err(|e| PdfError::LoadError(e.to_string()))?;
    let info = load_pdf_from_bytes(&bytes)?;
    Ok((bytes, info))
}

/// Load a PDF from bytes and return document info.
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
pub fn get_document_info(bytes: &[u8]) -> Result<DocumentInfo, PdfError> {
    load_pdf_from_bytes(bytes)
}

/// Get page info for a specific page.
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
