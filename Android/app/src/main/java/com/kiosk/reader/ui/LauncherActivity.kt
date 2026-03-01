package com.kiosk.reader.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity

/**
 * LauncherActivity – Single entry point for the entire app.
 *
 * Routing logic:
 * ───────────────
 * • If the incoming intent carries a PDF (ACTION_VIEW with a URI) →
 *   forward directly to [PdfViewerActivity].  The user never sees the
 *   home screen — the PDF opens immediately, matching the behaviour of
 *   Google Drive PDF viewer.
 *
 * • Otherwise (normal launcher tap, no data) → open [MainActivity]
 *   (the home / file-picker screen).
 *
 * Handles cold start, warm start, and "already running" scenarios via
 * [onNewIntent].  Uses FLAG_ACTIVITY_CLEAR_TOP so we never stack
 * duplicate viewer instances.
 *
 * This activity has no layout and finishes itself immediately after routing.
 */
class LauncherActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        route(intent)
        finish()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        route(intent)
        finish()
    }

    private fun route(intent: Intent?) {
        val pdfUri = extractPdfUri(intent)

        if (pdfUri != null) {
            openViewer(pdfUri, intent)
        } else {
            openHome()
        }
    }

    /**
     * Extract a PDF URI from the intent.
     *
     * Covers every common surface:
     * • File manager tap  → ACTION_VIEW with content:// or file:// data
     * • Share intent       → ACTION_VIEW / ACTION_SEND with data or extras
     * • Browser download   → ACTION_VIEW with content:// + application/pdf
     */
    private fun extractPdfUri(intent: Intent?): Uri? {
        if (intent == null) return null

        // ── Primary: intent.data (covers ACTION_VIEW) ────────────────────
        val data = intent.data
        if (data != null && isPdfIntent(intent, data)) return data

        // ── Secondary: EXTRA_STREAM (covers ACTION_SEND) ─────────────────
        if (intent.action == Intent.ACTION_SEND) {
            val stream = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
            if (stream != null) return stream
        }

        return null
    }

    /**
     * Returns true when the intent + URI pair looks like a PDF.
     *
     * Checks:
     * 1. Explicit MIME type = application/pdf
     * 2. URI path ends in .pdf (case-insensitive) — catch-all for
     *    file managers that don't set MIME type
     * 3. Content-resolver probing as last resort
     */
    private fun isPdfIntent(intent: Intent, uri: Uri): Boolean {
        // 1. Declared MIME
        if (intent.type?.equals("application/pdf", ignoreCase = true) == true) return true

        // 2. File extension
        val path = uri.path ?: uri.lastPathSegment ?: ""
        if (path.endsWith(".pdf", ignoreCase = true)) return true

        // 3. Content resolver MIME probe (safe — returns null on failure)
        try {
            val resolved = contentResolver.getType(uri)
            if (resolved?.equals("application/pdf", ignoreCase = true) == true) return true
        } catch (_: Exception) { /* SecurityException on some OEMs */ }

        return false
    }

    // ── Navigation targets ────────────────────────────────────────────────

    private fun openViewer(uri: Uri, sourceIntent: Intent?) {
        val viewerIntent = Intent(this, PdfViewerActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = uri
            // Propagate read permission from the original caller
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            // Prevent stacking duplicate viewer instances
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)

            // Carry over clip data if present (some file managers use it to
            // grant URI read permission via ClipData rather than flags).
            if (sourceIntent?.clipData != null) {
                clipData = sourceIntent.clipData
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        }
        startActivity(viewerIntent)
    }

    private fun openHome() {
        val homeIntent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        startActivity(homeIntent)
    }
}
