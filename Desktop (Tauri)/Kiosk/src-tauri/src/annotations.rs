//! PDF Annotation Module
//!
//! Implements true PDF-spec compliant annotations that persist in the file
//! and are visible in Preview, Acrobat, Edge, and other PDF readers.
//!
//! Supported annotation types:
//! - Highlight (markup annotation)
//! - Underline (markup annotation)  
//! - Strikethrough (markup annotation)
//! - Freehand/Ink (ink annotation)
//! - Text comment (text annotation / sticky note)

use lopdf::{Document, Object, ObjectId, Dictionary};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use thiserror::Error;

/// Errors that can occur during annotation operations.
#[derive(Error, Debug)]
pub enum AnnotationError {
    #[error("Failed to load PDF: {0}")]
    LoadError(String),

    #[error("Failed to save PDF: {0}")]
    SaveError(String),

    #[error("Invalid page index: {0}")]
    InvalidPage(u32),

    #[error("Annotation error: {0}")]
    AnnotationFailed(String),
}

impl Serialize for AnnotationError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Annotation types supported by Kiosk.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationType {
    Highlight,
    Underline,
    Strikethrough,
    Ink,         // Freehand drawing
    Text,        // Sticky note / text comment
}

/// A rectangle in PDF coordinates (bottom-left origin).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfRect {
    pub x1: f64,  // left
    pub y1: f64,  // bottom
    pub x2: f64,  // right
    pub y2: f64,  // top
}

/// A point in PDF coordinates.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfPoint {
    pub x: f64,
    pub y: f64,
}

/// Color in RGB format (0.0-1.0 range).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnotationColor {
    pub r: f64,
    pub g: f64,
    pub b: f64,
}

impl Default for AnnotationColor {
    fn default() -> Self {
        // Default yellow for highlights
        Self { r: 1.0, g: 0.92, b: 0.23 }
    }
}

/// Annotation data sent from the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnotationData {
    /// Type of annotation
    pub annotation_type: AnnotationType,
    
    /// Page index (0-based)
    pub page: u32,
    
    /// Bounding rectangle in PDF coordinates
    pub rect: PdfRect,
    
    /// For markup annotations (highlight, underline, strikethrough):
    /// The quad points defining the text region
    #[serde(default)]
    pub quad_points: Vec<PdfPoint>,
    
    /// For ink annotations: array of strokes, each stroke is array of points
    #[serde(default)]
    pub ink_paths: Vec<Vec<PdfPoint>>,
    
    /// For text comments: the comment content
    #[serde(default)]
    pub contents: String,
    
    /// Annotation color
    #[serde(default)]
    pub color: AnnotationColor,
    
    /// Opacity (0.0-1.0)
    #[serde(default = "default_opacity")]
    pub opacity: f64,
    
    /// Stroke width for ink annotations
    #[serde(default = "default_stroke_width")]
    pub stroke_width: f64,
    
    /// Optional unique identifier (for tracking/erasing)
    #[serde(default)]
    pub id: Option<String>,
}

fn default_opacity() -> f64 { 0.5 }
fn default_stroke_width() -> f64 { 2.0 }

/// Result of saving annotations.
#[derive(Debug, Serialize, Deserialize)]
pub struct SaveResult {
    pub success: bool,
    pub path: String,
    pub annotations_count: usize,
}

/// Get existing annotations from a PDF file.
pub fn get_annotations(path: &str) -> Result<Vec<AnnotationData>, AnnotationError> {
    let doc = Document::load(path)
        .map_err(|e| AnnotationError::LoadError(e.to_string()))?;
    
    let mut annotations = Vec::new();
    
    // Iterate through pages
    for (page_num, page_id) in doc.get_pages() {
        if let Ok(page) = doc.get_object(page_id) {
            if let Object::Dictionary(page_dict) = page {
                // Get the Annots array
                if let Ok(annots) = page_dict.get(b"Annots") {
                    if let Ok(annot_array) = doc.get_object(get_object_id(annots)?) {
                        if let Object::Array(annot_refs) = annot_array {
                            for annot_ref in annot_refs {
                                if let Ok(annot_obj) = doc.get_object(get_object_id(&annot_ref)?) {
                                    if let Some(annot) = parse_annotation(&doc, annot_obj, page_num - 1) {
                                        annotations.push(annot);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    Ok(annotations)
}

/// Helper to get ObjectId from an Object reference.
fn get_object_id(obj: &Object) -> Result<ObjectId, AnnotationError> {
    match obj {
        Object::Reference(id) => Ok(*id),
        _ => Err(AnnotationError::AnnotationFailed("Expected object reference".to_string())),
    }
}

/// Parse a PDF annotation object into our AnnotationData format.
fn parse_annotation(_doc: &Document, obj: &Object, page_index: u32) -> Option<AnnotationData> {
    if let Object::Dictionary(dict) = obj {
        // Get annotation subtype
        let subtype = dict.get(b"Subtype")
            .ok()
            .and_then(|o| {
                if let Object::Name(name) = o {
                    Some(String::from_utf8_lossy(name).to_string())
                } else {
                    None
                }
            })?;
        
        // Get bounding rectangle
        let rect = dict.get(b"Rect")
            .ok()
            .and_then(|o| {
                if let Object::Array(arr) = o {
                    if arr.len() == 4 {
                        let x1 = get_number(&arr[0])?;
                        let y1 = get_number(&arr[1])?;
                        let x2 = get_number(&arr[2])?;
                        let y2 = get_number(&arr[3])?;
                        return Some(PdfRect { x1, y1, x2, y2 });
                    }
                }
                None
            })?;
        
        // Get color
        let color = dict.get(b"C")
            .ok()
            .and_then(|o| {
                if let Object::Array(arr) = o {
                    if arr.len() >= 3 {
                        let r = get_number(&arr[0]).unwrap_or(1.0);
                        let g = get_number(&arr[1]).unwrap_or(0.92);
                        let b = get_number(&arr[2]).unwrap_or(0.23);
                        return Some(AnnotationColor { r, g, b });
                    }
                }
                None
            })
            .unwrap_or_default();
        
        // Get contents (for text annotations)
        let contents = dict.get(b"Contents")
            .ok()
            .and_then(|o| {
                match o {
                    Object::String(s, _) => Some(String::from_utf8_lossy(s).to_string()),
                    _ => None,
                }
            })
            .unwrap_or_default();
        
        // Get opacity
        let opacity = dict.get(b"CA")
            .ok()
            .and_then(|o| get_number(o))
            .unwrap_or(1.0);
        
        // Map PDF subtype to our annotation type
        let annotation_type = match subtype.as_str() {
            "Highlight" => AnnotationType::Highlight,
            "Underline" => AnnotationType::Underline,
            "StrikeOut" => AnnotationType::Strikethrough,
            "Ink" => AnnotationType::Ink,
            "Text" => AnnotationType::Text,
            _ => return None, // Skip unsupported types
        };
        
        // Get quad points for markup annotations
        let quad_points = dict.get(b"QuadPoints")
            .ok()
            .and_then(|o| {
                if let Object::Array(arr) = o {
                    let mut points = Vec::new();
                    for i in (0..arr.len()).step_by(2) {
                        if i + 1 < arr.len() {
                            if let (Some(x), Some(y)) = (get_number(&arr[i]), get_number(&arr[i + 1])) {
                                points.push(PdfPoint { x, y });
                            }
                        }
                    }
                    Some(points)
                } else {
                    None
                }
            })
            .unwrap_or_default();
        
        // Get ink paths for ink annotations
        let ink_paths = dict.get(b"InkList")
            .ok()
            .and_then(|o| {
                if let Object::Array(ink_list) = o {
                    let mut paths = Vec::new();
                    for path_obj in ink_list {
                        if let Object::Array(path) = path_obj {
                            let mut points = Vec::new();
                            for i in (0..path.len()).step_by(2) {
                                if i + 1 < path.len() {
                                    if let (Some(x), Some(y)) = (get_number(&path[i]), get_number(&path[i + 1])) {
                                        points.push(PdfPoint { x, y });
                                    }
                                }
                            }
                            if !points.is_empty() {
                                paths.push(points);
                            }
                        }
                    }
                    Some(paths)
                } else {
                    None
                }
            })
            .unwrap_or_default();
        
        // Get stroke width for ink
        let stroke_width = dict.get(b"BS")
            .ok()
            .and_then(|o| {
                if let Object::Dictionary(bs) = o {
                    bs.get(b"W").ok().and_then(|w| get_number(w))
                } else {
                    None
                }
            })
            .unwrap_or(2.0);
        
        Some(AnnotationData {
            annotation_type,
            page: page_index,
            rect,
            quad_points,
            ink_paths,
            contents,
            color,
            opacity,
            stroke_width,
            id: None,
        })
    } else {
        None
    }
}

/// Helper to extract a number from a PDF object.
fn get_number(obj: &Object) -> Option<f64> {
    match obj {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(f) => Some(*f as f64),
        _ => None,
    }
}

/// Add annotations to a PDF and save to a new file.
pub fn save_annotations(
    source_path: &str,
    dest_path: &str,
    annotations: Vec<AnnotationData>,
) -> Result<SaveResult, AnnotationError> {
    let mut doc = Document::load(source_path)
        .map_err(|e| AnnotationError::LoadError(e.to_string()))?;
    
    let annotations_count = annotations.len();
    
    // Group annotations by page
    let mut annotations_by_page: BTreeMap<u32, Vec<&AnnotationData>> = BTreeMap::new();
    for annot in &annotations {
        annotations_by_page.entry(annot.page).or_default().push(annot);
    }
    
    // Get page IDs
    let pages = doc.get_pages();
    
    // Add annotations to each page
    for (page_num, annots) in annotations_by_page {
        let page_id = pages.get(&(page_num + 1))
            .ok_or_else(|| AnnotationError::InvalidPage(page_num))?;
        
        // Create annotation objects
        let mut annot_refs: Vec<Object> = Vec::new();
        
        for annot in annots {
            let annot_id = create_annotation_object(&mut doc, annot, *page_id)?;
            annot_refs.push(Object::Reference(annot_id));
        }
        
        // Get existing annotations if any
        if let Ok(page) = doc.get_object(*page_id).cloned() {
            if let Object::Dictionary(mut page_dict) = page {
                // Get existing Annots array or create new one
                let mut existing_annots: Vec<Object> = Vec::new();
                if let Ok(annots_obj) = page_dict.get(b"Annots") {
                    if let Object::Reference(annots_ref) = annots_obj {
                        if let Ok(Object::Array(arr)) = doc.get_object(*annots_ref) {
                            existing_annots = arr.clone();
                        }
                    } else if let Object::Array(arr) = annots_obj {
                        existing_annots = arr.clone();
                    }
                }
                
                // Combine existing and new annotations
                existing_annots.extend(annot_refs);
                
                // Update page dictionary with new Annots array
                page_dict.set(b"Annots", Object::Array(existing_annots));
                doc.set_object(*page_id, Object::Dictionary(page_dict));
            }
        }
    }
    
    // Save the document
    doc.save(dest_path)
        .map_err(|e| AnnotationError::SaveError(e.to_string()))?;
    
    Ok(SaveResult {
        success: true,
        path: dest_path.to_string(),
        annotations_count,
    })
}

/// Create a PDF annotation object and add it to the document.
fn create_annotation_object(
    doc: &mut Document,
    annot: &AnnotationData,
    page_id: ObjectId,
) -> Result<ObjectId, AnnotationError> {
    let mut dict = Dictionary::new();
    
    // Common annotation properties
    dict.set(b"Type", Object::Name(b"Annot".to_vec()));
    dict.set(b"P", Object::Reference(page_id));
    
    // Bounding rectangle
    dict.set(b"Rect", Object::Array(vec![
        Object::Real(annot.rect.x1 as f32),
        Object::Real(annot.rect.y1 as f32),
        Object::Real(annot.rect.x2 as f32),
        Object::Real(annot.rect.y2 as f32),
    ]));
    
    // Color
    dict.set(b"C", Object::Array(vec![
        Object::Real(annot.color.r as f32),
        Object::Real(annot.color.g as f32),
        Object::Real(annot.color.b as f32),
    ]));
    
    // Opacity (constant alpha)
    dict.set(b"CA", Object::Real(annot.opacity as f32));
    
    // Annotation flags: Print (4) | NoZoom (8) | NoRotate (16) = 28
    dict.set(b"F", Object::Integer(4)); // Just Print flag for compatibility
    
    // Creation date
    let now = chrono::Utc::now();
    let date_str = format!("D:{}", now.format("%Y%m%d%H%M%S+00'00'"));
    dict.set(b"CreationDate", Object::String(date_str.as_bytes().to_vec(), lopdf::StringFormat::Literal));
    
    // Modified date
    dict.set(b"M", Object::String(date_str.as_bytes().to_vec(), lopdf::StringFormat::Literal));
    
    // Type-specific properties
    match annot.annotation_type {
        AnnotationType::Highlight => {
            dict.set(b"Subtype", Object::Name(b"Highlight".to_vec()));
            add_quad_points(&mut dict, &annot.quad_points, &annot.rect);
        }
        AnnotationType::Underline => {
            dict.set(b"Subtype", Object::Name(b"Underline".to_vec()));
            add_quad_points(&mut dict, &annot.quad_points, &annot.rect);
        }
        AnnotationType::Strikethrough => {
            dict.set(b"Subtype", Object::Name(b"StrikeOut".to_vec()));
            add_quad_points(&mut dict, &annot.quad_points, &annot.rect);
        }
        AnnotationType::Ink => {
            dict.set(b"Subtype", Object::Name(b"Ink".to_vec()));
            
            // InkList: array of strokes, each stroke is array of coordinate pairs
            let ink_list: Vec<Object> = annot.ink_paths.iter().map(|path| {
                let coords: Vec<Object> = path.iter()
                    .flat_map(|p| vec![Object::Real(p.x as f32), Object::Real(p.y as f32)])
                    .collect();
                Object::Array(coords)
            }).collect();
            dict.set(b"InkList", Object::Array(ink_list));
            
            // Border style for stroke width
            let mut bs = Dictionary::new();
            bs.set(b"Type", Object::Name(b"Border".to_vec()));
            bs.set(b"W", Object::Real(annot.stroke_width as f32));
            dict.set(b"BS", Object::Dictionary(bs));
        }
        AnnotationType::Text => {
            dict.set(b"Subtype", Object::Name(b"Text".to_vec()));
            dict.set(b"Contents", Object::String(
                annot.contents.as_bytes().to_vec(),
                lopdf::StringFormat::Literal
            ));
            // Text annotation icon
            dict.set(b"Name", Object::Name(b"Comment".to_vec()));
            dict.set(b"Open", Object::Boolean(false));
        }
    }
    
    // Add the annotation to the document and return its ID
    let annot_id = doc.add_object(Object::Dictionary(dict));
    Ok(annot_id)
}

/// Add QuadPoints to a markup annotation dictionary.
fn add_quad_points(dict: &mut Dictionary, quad_points: &[PdfPoint], rect: &PdfRect) {
    if quad_points.is_empty() {
        // If no quad points provided, create default quad points from rect
        // QuadPoints format: x1,y1, x2,y2, x3,y3, x4,y4 (counter-clockwise from bottom-left)
        let qp = vec![
            Object::Real(rect.x1 as f32), Object::Real(rect.y2 as f32), // top-left
            Object::Real(rect.x2 as f32), Object::Real(rect.y2 as f32), // top-right
            Object::Real(rect.x1 as f32), Object::Real(rect.y1 as f32), // bottom-left
            Object::Real(rect.x2 as f32), Object::Real(rect.y1 as f32), // bottom-right
        ];
        dict.set(b"QuadPoints", Object::Array(qp));
    } else {
        // Use provided quad points
        let qp: Vec<Object> = quad_points.iter()
            .flat_map(|p| vec![Object::Real(p.x as f32), Object::Real(p.y as f32)])
            .collect();
        dict.set(b"QuadPoints", Object::Array(qp));
    }
}

/// Remove an annotation from a PDF by its position/characteristics.
pub fn remove_annotation(
    source_path: &str,
    dest_path: &str,
    page_index: u32,
    rect: &PdfRect,
) -> Result<bool, AnnotationError> {
    let mut doc = Document::load(source_path)
        .map_err(|e| AnnotationError::LoadError(e.to_string()))?;
    
    let pages = doc.get_pages();
    let page_id = pages.get(&(page_index + 1))
        .ok_or_else(|| AnnotationError::InvalidPage(page_index))?;
    
    let mut found = false;
    
    if let Ok(page) = doc.get_object(*page_id).cloned() {
        if let Object::Dictionary(mut page_dict) = page {
            if let Ok(annots_obj) = page_dict.get(b"Annots").cloned() {
                let mut annots_array: Vec<Object> = Vec::new();
                
                // Get the annots array (either direct or reference)
                if let Object::Reference(annots_ref) = &annots_obj {
                    if let Ok(Object::Array(arr)) = doc.get_object(*annots_ref) {
                        annots_array = arr.clone();
                    }
                } else if let Object::Array(arr) = &annots_obj {
                    annots_array = arr.clone();
                }
                
                // Filter out the annotation that matches the rect
                let tolerance = 1.0; // 1 PDF point tolerance
                let filtered: Vec<Object> = annots_array.into_iter().filter(|annot_ref| {
                    if let Object::Reference(ref_id) = annot_ref {
                        if let Ok(Object::Dictionary(annot_dict)) = doc.get_object(*ref_id) {
                            if let Ok(Object::Array(r)) = annot_dict.get(b"Rect") {
                                if r.len() == 4 {
                                    if let (Some(x1), Some(y1), Some(x2), Some(y2)) = (
                                        get_number(&r[0]),
                                        get_number(&r[1]),
                                        get_number(&r[2]),
                                        get_number(&r[3]),
                                    ) {
                                        // Check if rects match within tolerance
                                        if (x1 - rect.x1).abs() < tolerance &&
                                           (y1 - rect.y1).abs() < tolerance &&
                                           (x2 - rect.x2).abs() < tolerance &&
                                           (y2 - rect.y2).abs() < tolerance {
                                            found = true;
                                            return false; // Remove this annotation
                                        }
                                    }
                                }
                            }
                        }
                    }
                    true // Keep this annotation
                }).collect();
                
                // Update the page with filtered annotations
                if found {
                    page_dict.set(b"Annots", Object::Array(filtered));
                    doc.set_object(*page_id, Object::Dictionary(page_dict));
                }
            }
        }
    }
    
    if found {
        doc.save(dest_path)
            .map_err(|e| AnnotationError::SaveError(e.to_string()))?;
    }
    
    Ok(found)
}

/// Clear all annotations from a specific page.
pub fn clear_page_annotations(
    source_path: &str,
    dest_path: &str,
    page_index: u32,
) -> Result<usize, AnnotationError> {
    let mut doc = Document::load(source_path)
        .map_err(|e| AnnotationError::LoadError(e.to_string()))?;
    
    let pages = doc.get_pages();
    let page_id = pages.get(&(page_index + 1))
        .ok_or_else(|| AnnotationError::InvalidPage(page_index))?;
    
    let mut count = 0;
    
    if let Ok(page) = doc.get_object(*page_id).cloned() {
        if let Object::Dictionary(mut page_dict) = page {
            // Count existing annotations
            if let Ok(annots_obj) = page_dict.get(b"Annots") {
                if let Object::Reference(annots_ref) = annots_obj {
                    if let Ok(Object::Array(arr)) = doc.get_object(*annots_ref) {
                        count = arr.len();
                    }
                } else if let Object::Array(arr) = annots_obj {
                    count = arr.len();
                }
            }
            
            // Remove Annots key
            page_dict.remove(b"Annots");
            doc.set_object(*page_id, Object::Dictionary(page_dict));
        }
    }
    
    if count > 0 {
        doc.save(dest_path)
            .map_err(|e| AnnotationError::SaveError(e.to_string()))?;
    }
    
    Ok(count)
}
