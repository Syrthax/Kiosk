package com.kiosk.reader.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import com.kiosk.reader.R
import com.kiosk.reader.databinding.ActivityPdfViewerBinding
import com.kiosk.reader.pdf.PdfDocument
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * PDF Viewer Activity - Displays PDF documents
 * Handles intents from file managers and default app selection
 */
class PdfViewerActivity : AppCompatActivity() {

    private lateinit var binding: ActivityPdfViewerBinding
    private var currentDocument: PdfDocument? = null
    private var isToolbarVisible = true
    private var nightModeEnabled = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        // Enable edge-to-edge display
        WindowCompat.setDecorFitsSystemWindows(window, false)
        
        binding = ActivityPdfViewerBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setupUI()
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun setupUI() {
        // Back button
        binding.backButton.setOnClickListener {
            finish()
        }

        // Night mode toggle
        binding.nightModeButton.setOnClickListener {
            toggleNightMode()
        }

        // Zoom controls
        binding.zoomInButton.setOnClickListener {
            binding.pdfView.zoomIn()
        }

        binding.zoomOutButton.setOnClickListener {
            binding.pdfView.zoomOut()
        }

        // Tap to toggle toolbar
        binding.pdfView.setOnClickListener {
            toggleToolbar()
        }

        // PDF view callbacks
        binding.pdfView.onPageChanged = { currentPage, totalPages ->
            runOnUiThread {
                binding.pageIndicator.text = getString(R.string.page_indicator, currentPage + 1, totalPages)
            }
        }

        binding.pdfView.onLoadingStateChanged = { isLoading ->
            runOnUiThread {
                binding.loadingIndicator.visibility = if (isLoading) View.VISIBLE else View.GONE
            }
        }

        binding.pdfView.onError = { message ->
            runOnUiThread {
                showError(message)
            }
        }

        // Error retry button
        binding.retryButton.setOnClickListener {
            hideError()
            handleIntent(intent)
        }

        // Error close button
        binding.closeButton.setOnClickListener {
            finish()
        }
    }

    private fun handleIntent(intent: Intent?) {
        val uri = intent?.data
        
        if (uri == null) {
            showError(getString(R.string.no_pdf_selected))
            return
        }

        loadPdf(uri)
    }

    private fun loadPdf(uri: Uri) {
        showLoading()
        hideError()

        lifecycleScope.launch {
            try {
                // Close previous document
                currentDocument?.close()
                currentDocument = null

                // Open new document
                val result = PdfDocument.open(this@PdfViewerActivity, uri)
                
                result.fold(
                    onSuccess = { document ->
                        currentDocument = document
                        withContext(Dispatchers.Main) {
                            binding.pdfView.setDocument(document)
                            updateTitle(uri)
                            hideLoading()
                        }
                    },
                    onFailure = { error ->
                        withContext(Dispatchers.Main) {
                            showError(getErrorMessage(error))
                        }
                    }
                )
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    showError(getErrorMessage(e))
                }
            }
        }
    }

    private fun updateTitle(uri: Uri) {
        // Try to get filename from URI
        val filename = try {
            uri.lastPathSegment?.substringAfterLast('/') ?: "PDF"
        } catch (e: Exception) {
            "PDF"
        }
        
        binding.titleText.text = filename.removeSuffix(".pdf").removeSuffix(".PDF")
    }

    private fun toggleNightMode() {
        nightModeEnabled = !nightModeEnabled
        binding.pdfView.setNightMode(nightModeEnabled)
        
        // Update button appearance
        binding.nightModeButton.alpha = if (nightModeEnabled) 1.0f else 0.6f
        
        val message = if (nightModeEnabled) R.string.night_mode_on else R.string.night_mode_off
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    private fun toggleToolbar() {
        isToolbarVisible = !isToolbarVisible
        
        val visibility = if (isToolbarVisible) View.VISIBLE else View.GONE
        binding.toolbar.visibility = visibility
        binding.bottomBar.visibility = visibility

        // Also control system bars
        val windowInsetsController = WindowCompat.getInsetsController(window, window.decorView)
        if (isToolbarVisible) {
            windowInsetsController.show(WindowInsetsCompat.Type.systemBars())
        } else {
            windowInsetsController.hide(WindowInsetsCompat.Type.systemBars())
            windowInsetsController.systemBarsBehavior = 
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    private fun showLoading() {
        binding.loadingIndicator.visibility = View.VISIBLE
        binding.pdfView.visibility = View.VISIBLE
        binding.errorContainer.visibility = View.GONE
    }

    private fun hideLoading() {
        binding.loadingIndicator.visibility = View.GONE
    }

    private fun showError(message: String) {
        binding.loadingIndicator.visibility = View.GONE
        binding.errorContainer.visibility = View.VISIBLE
        binding.errorText.text = message
    }

    private fun hideError() {
        binding.errorContainer.visibility = View.GONE
    }

    private fun getErrorMessage(error: Throwable): String {
        return when {
            error.message?.contains("Permission", ignoreCase = true) == true ->
                getString(R.string.error_permission_denied)
            error.message?.contains("not found", ignoreCase = true) == true ->
                getString(R.string.error_file_not_found)
            error.message?.contains("corrupt", ignoreCase = true) == true ->
                getString(R.string.error_corrupted_pdf)
            else -> getString(R.string.error_loading_pdf) + ": ${error.message}"
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        binding.pdfView.release()
        currentDocument?.close()
        currentDocument = null
    }
}
