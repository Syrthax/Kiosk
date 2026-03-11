//! PDF rendering module using pdfium-render for native-quality output.
//!
//! This module provides:
//! - High-DPI aware page rendering
//! - Glyph-accurate character bounding boxes for text selection
//! - Page metadata and navigation
//! - Persistent document handle caching (Phase 3)

mod renderer;

pub use renderer::*;
