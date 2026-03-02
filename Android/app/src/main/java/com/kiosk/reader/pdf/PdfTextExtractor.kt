package com.kiosk.reader.pdf

import android.content.Context
import android.net.Uri
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.text.PDFTextStripper
import com.tom_roush.pdfbox.text.TextPosition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.util.Locale

/**
 * PDF full-text search powered by PdfBox text extraction.
 *
 * Usage:
 * ```
 * val results = PdfTextExtractor.search(context, uri, "hello")
 * ```
 *
 * Each [SearchResult] contains the 0-based page index, the number of
 * matches on that page, and a short snippet surrounding the first match.
 *
 * [searchWithHighlights] additionally returns per-match bounding
 * rectangles in PDF-unit coordinates for on-screen highlighting.
 */
object PdfTextExtractor {

    data class SearchResult(
        /** 0-based page index. */
        val pageIndex: Int,
        /** Number of occurrences of the query on this page. */
        val matchCount: Int,
        /** Short text snippet around the first match for preview. */
        val snippet: String
    )

    /** A rectangular region on a PDF page where a search match was found. */
    data class SearchHighlight(
        val pageIndex: Int,
        /** X offset from the left of the page, in PDF points. */
        val x: Float,
        /** Y offset from the TOP of the page (direction-adjusted), in PDF points. */
        val y: Float,
        /** Width in PDF points. */
        val width: Float,
        /** Height in PDF points. */
        val height: Float
    )

    /**
     * Search the PDF at [uri] for [query] (case-insensitive).
     *
     * Returns a list of [SearchResult] for every page that contains the
     * query string, ordered by page number.  The search extracts text
     * one page at a time so it can be cancelled via structured
     * concurrency without loading the entire document into memory.
     */
    suspend fun search(
        context: Context,
        uri: Uri,
        query: String
    ): List<SearchResult> = withContext(Dispatchers.IO) {
        if (query.isBlank()) return@withContext emptyList()

        val results = mutableListOf<SearchResult>()
        val lowerQuery = query.lowercase(Locale.getDefault())

        var document: PDDocument? = null
        try {
            val inputStream = context.contentResolver.openInputStream(uri)
                ?: return@withContext emptyList()

            document = PDDocument.load(inputStream)
            val pageCount = document.numberOfPages

            val stripper = PDFTextStripper()

            for (i in 0 until pageCount) {
                // Allow cancellation between pages
                ensureActive()

                stripper.startPage = i + 1  // PdfBox pages are 1-indexed
                stripper.endPage = i + 1

                val pageText = try {
                    stripper.getText(document) ?: ""
                } catch (_: Exception) {
                    ""
                }

                if (pageText.isBlank()) continue

                val lowerText = pageText.lowercase(Locale.getDefault())
                val matchCount = countOccurrences(lowerText, lowerQuery)

                if (matchCount > 0) {
                    val snippet = extractSnippet(pageText, lowerText, lowerQuery)
                    results.add(SearchResult(i, matchCount, snippet))
                }
            }
        } catch (_: Exception) {
            // Return whatever results we collected so far
        } finally {
            try { document?.close() } catch (_: Exception) { }
        }

        results
    }

    /**
     * Search with per-match bounding rectangles for on-screen highlighting.
     *
     * Returns the same [SearchResult] list as [search], plus a flat list
     * of [SearchHighlight] rectangles in PDF-unit coordinates.
     */
    suspend fun searchWithHighlights(
        context: Context,
        uri: Uri,
        query: String
    ): Pair<List<SearchResult>, List<SearchHighlight>> = withContext(Dispatchers.IO) {
        if (query.isBlank()) return@withContext Pair(emptyList(), emptyList())

        val results = mutableListOf<SearchResult>()
        val highlights = mutableListOf<SearchHighlight>()
        val lowerQuery = query.lowercase(Locale.getDefault())

        var document: PDDocument? = null
        try {
            val inputStream = context.contentResolver.openInputStream(uri)
                ?: return@withContext Pair(emptyList(), emptyList())

            document = PDDocument.load(inputStream)
            val pageCount = document.numberOfPages
            val stripper = HighlightStripper()

            for (i in 0 until pageCount) {
                ensureActive()

                stripper.startPage = i + 1
                stripper.endPage = i + 1
                stripper.resetCollector()

                val pageText = try {
                    stripper.getText(document) ?: ""
                } catch (_: Exception) { "" }

                if (pageText.isBlank()) continue

                val lowerText = pageText.lowercase(Locale.getDefault())
                val matchCount = countOccurrences(lowerText, lowerQuery)

                if (matchCount > 0) {
                    val snippet = extractSnippet(pageText, lowerText, lowerQuery)
                    results.add(SearchResult(i, matchCount, snippet))
                    highlights.addAll(stripper.findHighlights(lowerQuery, i))
                }
            }
        } catch (_: Exception) {
            // Return whatever we collected
        } finally {
            try { document?.close() } catch (_: Exception) { }
        }

        Pair(results, highlights)
    }

    // ─── Custom stripper that records character positions ────────────────

    private class HighlightStripper : PDFTextStripper() {
        private val charPositions = mutableListOf<TextPosition?>()
        private val collectedText = StringBuilder()

        override fun writeString(text: String, textPositions: MutableList<TextPosition>) {
            val limit = minOf(text.length, textPositions.size)
            for (i in 0 until limit) {
                collectedText.append(text[i])
                charPositions.add(textPositions[i])
            }
            // Text chars exceeding positions (rare) — use last known position
            for (i in limit until text.length) {
                collectedText.append(text[i])
                charPositions.add(textPositions.lastOrNull())
            }
            super.writeString(text, textPositions)
        }

        override fun writeWordSeparator() {
            collectedText.append(wordSeparator)
            charPositions.add(null) // no position for separator
            super.writeWordSeparator()
        }

        override fun writeLineSeparator() {
            collectedText.append('\n')
            charPositions.add(null) // no position for line break
            super.writeLineSeparator()
        }

        fun resetCollector() {
            charPositions.clear()
            collectedText.clear()
        }

        fun findHighlights(lowerQuery: String, pageIndex: Int): List<SearchHighlight> {
            val hl = mutableListOf<SearchHighlight>()
            val text = collectedText.toString().lowercase(Locale.getDefault())
            var start = 0

            while (true) {
                val idx = text.indexOf(lowerQuery, start)
                if (idx < 0) break
                val end = idx + lowerQuery.length

                // Find first and last non-null TextPosition in match range
                var firstPos: TextPosition? = null
                var lastPos: TextPosition? = null
                for (i in idx until end.coerceAtMost(charPositions.size)) {
                    val pos = charPositions[i] ?: continue
                    if (firstPos == null) firstPos = pos
                    lastPos = pos
                }

                if (firstPos != null && lastPos != null) {
                    val x = firstPos.xDirAdj
                    // yDirAdj is baseline-relative from top; subtract height for top edge
                    val y = firstPos.yDirAdj - firstPos.heightDir
                    val w = (lastPos.xDirAdj + lastPos.widthDirAdj) - x
                    val h = firstPos.heightDir

                    if (w > 0 && h > 0) {
                        hl.add(SearchHighlight(pageIndex, x, y, w, h * 1.15f))
                    }
                }

                start = idx + lowerQuery.length
            }
            return hl
        }
    }

    /**
     * Extract text from a single page (0-based index).
     * Returns empty string on failure.
     */
    suspend fun extractPageText(
        context: Context,
        uri: Uri,
        pageIndex: Int
    ): String = withContext(Dispatchers.IO) {
        var document: PDDocument? = null
        try {
            val inputStream = context.contentResolver.openInputStream(uri)
                ?: return@withContext ""
            document = PDDocument.load(inputStream)
            val stripper = PDFTextStripper().apply {
                startPage = pageIndex + 1
                endPage = pageIndex + 1
            }
            stripper.getText(document) ?: ""
        } catch (_: Exception) {
            ""
        } finally {
            try { document?.close() } catch (_: Exception) { }
        }
    }

    // ─── Internal helpers ────────────────────────────────────────────────

    private fun countOccurrences(text: String, query: String): Int {
        var count = 0
        var idx = 0
        while (true) {
            idx = text.indexOf(query, idx)
            if (idx < 0) break
            count++
            idx += query.length
        }
        return count
    }

    private fun extractSnippet(
        original: String,
        lower: String,
        lowerQuery: String,
        snippetRadius: Int = 40
    ): String {
        val idx = lower.indexOf(lowerQuery)
        if (idx < 0) return ""

        val start = (idx - snippetRadius).coerceAtLeast(0)
        val end = (idx + lowerQuery.length + snippetRadius).coerceAtMost(original.length)

        val prefix = if (start > 0) "…" else ""
        val suffix = if (end < original.length) "…" else ""

        return prefix + original.substring(start, end)
            .replace('\n', ' ')
            .replace('\r', ' ')
            .trim() + suffix
    }
}
