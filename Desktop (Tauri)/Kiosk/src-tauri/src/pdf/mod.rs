//! PDF rendering module using pdfium-render for native-quality output.
//!
//! This module provides:
//! - High-DPI aware page rendering
//! - Glyph-accurate character bounding boxes for text selection
//! - Page metadata and navigation

mod renderer;

pub use renderer::*;
