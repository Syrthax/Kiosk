package com.kiosk.reader.pdf

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * PDF Document wrapper that handles PdfRenderer lifecycle
 * Thread-safe implementation for rendering PDF pages
 */
class PdfDocument private constructor(
    private val fileDescriptor: ParcelFileDescriptor,
    private val renderer: PdfRenderer
) : AutoCloseable {

    val pageCount: Int
        get() = renderer.pageCount

    private val renderMutex = Mutex()
    private var currentPage: PdfRenderer.Page? = null

    /**
     * Renders a specific page at the given scale
     * Returns null if rendering fails
     */
    suspend fun renderPage(pageIndex: Int, scale: Float = 1.0f): Bitmap? = withContext(Dispatchers.IO) {
        if (pageIndex < 0 || pageIndex >= pageCount) {
            return@withContext null
        }

        renderMutex.withLock {
            try {
                // Close any previously opened page
                currentPage?.close()
                currentPage = null

                // Open the requested page
                val page = renderer.openPage(pageIndex)
                currentPage = page

                // Calculate dimensions with scale
                val width = (page.width * scale).toInt().coerceAtLeast(1)
                val height = (page.height * scale).toInt().coerceAtLeast(1)

                // Create bitmap with white background
                val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                val canvas = Canvas(bitmap)
                canvas.drawColor(Color.WHITE)

                // Render the page
                page.render(
                    bitmap,
                    null,
                    null,
                    PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY
                )

                // Close the page after rendering
                page.close()
                currentPage = null

                bitmap
            } catch (e: Exception) {
                e.printStackTrace()
                null
            }
        }
    }

    /**
     * Gets the dimensions of a specific page
     */
    suspend fun getPageDimensions(pageIndex: Int): Pair<Int, Int>? = withContext(Dispatchers.IO) {
        if (pageIndex < 0 || pageIndex >= pageCount) {
            return@withContext null
        }

        renderMutex.withLock {
            try {
                currentPage?.close()
                currentPage = null

                val page = renderer.openPage(pageIndex)
                val dimensions = Pair(page.width, page.height)
                page.close()
                dimensions
            } catch (e: Exception) {
                e.printStackTrace()
                null
            }
        }
    }

    override fun close() {
        try {
            currentPage?.close()
            currentPage = null
            renderer.close()
            fileDescriptor.close()
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    companion object {
        /**
         * Opens a PDF document from a file
         */
        suspend fun open(file: File): Result<PdfDocument> = withContext(Dispatchers.IO) {
            try {
                if (!file.exists()) {
                    return@withContext Result.failure(IOException("File not found: ${file.absolutePath}"))
                }

                if (!file.canRead()) {
                    return@withContext Result.failure(IOException("Cannot read file: ${file.absolutePath}"))
                }

                val fileDescriptor = ParcelFileDescriptor.open(
                    file,
                    ParcelFileDescriptor.MODE_READ_ONLY
                )

                val renderer = PdfRenderer(fileDescriptor)
                
                if (renderer.pageCount == 0) {
                    renderer.close()
                    fileDescriptor.close()
                    return@withContext Result.failure(IOException("PDF has no pages"))
                }

                Result.success(PdfDocument(fileDescriptor, renderer))
            } catch (e: SecurityException) {
                Result.failure(IOException("Permission denied: ${e.message}"))
            } catch (e: IOException) {
                Result.failure(IOException("Failed to open PDF: ${e.message}"))
            } catch (e: Exception) {
                Result.failure(IOException("Unexpected error: ${e.message}"))
            }
        }

        /**
         * Opens a PDF document from a content URI
         * Copies to cache if necessary for PdfRenderer compatibility
         */
        suspend fun open(context: Context, uri: Uri): Result<PdfDocument> = withContext(Dispatchers.IO) {
            try {
                // Try to open directly first (works for some content providers)
                val directResult = tryOpenDirect(context, uri)
                if (directResult.isSuccess) {
                    return@withContext directResult
                }

                // Fall back to copying to cache
                val cacheFile = copyToCache(context, uri)
                    ?: return@withContext Result.failure(IOException("Failed to copy PDF to cache"))

                open(cacheFile)
            } catch (e: SecurityException) {
                Result.failure(IOException("Permission denied: ${e.message}"))
            } catch (e: Exception) {
                Result.failure(IOException("Failed to open PDF: ${e.message}"))
            }
        }

        private fun tryOpenDirect(context: Context, uri: Uri): Result<PdfDocument> {
            return try {
                val fileDescriptor = context.contentResolver.openFileDescriptor(uri, "r")
                    ?: return Result.failure(IOException("Cannot open file descriptor"))

                val renderer = PdfRenderer(fileDescriptor)
                
                if (renderer.pageCount == 0) {
                    renderer.close()
                    fileDescriptor.close()
                    return Result.failure(IOException("PDF has no pages"))
                }

                Result.success(PdfDocument(fileDescriptor, renderer))
            } catch (e: Exception) {
                Result.failure(e)
            }
        }

        private fun copyToCache(context: Context, uri: Uri): File? {
            return try {
                val cacheDir = File(context.cacheDir, "pdf_cache")
                if (!cacheDir.exists()) {
                    cacheDir.mkdirs()
                }

                // Clean old cache files (keep cache size manageable)
                cleanOldCacheFiles(cacheDir)

                val cacheFile = File(cacheDir, "temp_${System.currentTimeMillis()}.pdf")
                
                context.contentResolver.openInputStream(uri)?.use { input ->
                    FileOutputStream(cacheFile).use { output ->
                        input.copyTo(output, bufferSize = 8192)
                    }
                } ?: return null

                if (cacheFile.length() == 0L) {
                    cacheFile.delete()
                    return null
                }

                cacheFile
            } catch (e: Exception) {
                e.printStackTrace()
                null
            }
        }

        private fun cleanOldCacheFiles(cacheDir: File) {
            try {
                val files = cacheDir.listFiles() ?: return
                val maxCacheFiles = 5
                
                if (files.size > maxCacheFiles) {
                    files.sortedBy { it.lastModified() }
                        .take(files.size - maxCacheFiles)
                        .forEach { it.delete() }
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }
}
