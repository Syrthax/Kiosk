/**
 * Kiosk PDF Viewer - Native Rendering Interface
 *
 * TypeScript types and API for communicating with the Rust PDF renderer.
 */

import { invoke } from '@tauri-apps/api/core';

// ============================================================================
// Types
// ============================================================================

/** Character bounding box for text selection */
export interface CharRect {
  char: string;
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Page metadata */
export interface PageInfo {
  index: number;
  width: number;
  height: number;
  rotation: number;
}

/** Document metadata */
export interface DocumentInfo {
  page_count: number;
  title: string | null;
  author: string | null;
  pdf_version: string;
}

/** Result from loading a PDF */
export interface LoadResult {
  id: string;
  info: DocumentInfo;
}

/** Text rectangle for highlights/selection */
export interface TextRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Search result */
export interface SearchResult {
  page: number;
  start_index: number;
  end_index: number;
  text: string;
  rects: TextRect[];
}

// ============================================================================
// PDF API
// ============================================================================

/**
 * Load a PDF from a file path.
 */
export async function loadPdf(path: string): Promise<LoadResult> {
  return invoke<LoadResult>('load_pdf', { path });
}

/**
 * Load a PDF from bytes (e.g., from drag-and-drop).
 */
export async function loadPdfBytes(bytes: Uint8Array): Promise<LoadResult> {
  return invoke<LoadResult>('load_pdf_bytes', { bytes: Array.from(bytes) });
}

/**
 * Close a document and free its resources.
 */
export async function closePdf(docId: string): Promise<void> {
  return invoke('close_pdf', { docId });
}

/**
 * Get document info.
 */
export async function getDocumentInfo(docId: string): Promise<DocumentInfo> {
  return invoke<DocumentInfo>('get_document_info', { docId });
}

/**
 * Get page info for a specific page.
 */
export async function getPageInfo(docId: string, pageIndex: number): Promise<PageInfo> {
  return invoke<PageInfo>('get_page_info', { docId, pageIndex });
}

/**
 * Get all page infos for the document.
 */
export async function getAllPageInfos(docId: string): Promise<PageInfo[]> {
  return invoke<PageInfo[]>('get_all_page_infos', { docId });
}

/**
 * Render a page to PNG bytes.
 *
 * @param docId - Document ID from loadPdf
 * @param pageIndex - 0-based page index
 * @param scale - Render scale (1.0 = 72 DPI, 2.0 = 144 DPI)
 * @returns PNG bytes as Uint8Array
 */
export async function renderPage(
  docId: string,
  pageIndex: number,
  scale: number
): Promise<Uint8Array> {
  const bytes = await invoke<number[]>('render_page', { docId, pageIndex, scale });
  return new Uint8Array(bytes);
}

/**
 * Get character bounding boxes for text selection.
 */
export async function getCharRects(docId: string, pageIndex: number): Promise<CharRect[]> {
  return invoke<CharRect[]>('get_char_rects', { docId, pageIndex });
}

/**
 * Get plain text content of a page.
 */
export async function getPageText(docId: string, pageIndex: number): Promise<string> {
  return invoke<string>('get_page_text', { docId, pageIndex });
}

/**
 * Search for text across all pages.
 */
export async function searchText(
  docId: string,
  query: string,
  caseSensitive: boolean = false,
  maxResults: number = 50
): Promise<SearchResult[]> {
  return invoke<SearchResult[]>('search_text', {
    docId,
    query,
    caseSensitive,
    maxResults,
  });
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Convert PNG bytes to a blob URL for display in <img>.
 */
export function pngBytesToUrl(bytes: Uint8Array): string {
  const blob = new Blob([bytes], { type: 'image/png' });
  return URL.createObjectURL(blob);
}

/**
 * Convert file to Uint8Array.
 */
export async function fileToBytes(file: File): Promise<Uint8Array> {
  const buffer = await file.arrayBuffer();
  return new Uint8Array(buffer);
}
