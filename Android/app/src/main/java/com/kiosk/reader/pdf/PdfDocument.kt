package com.kiosk.reader.pdf

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.encryption.InvalidPasswordException as PdfBoxInvalidPasswordException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/** Thrown when a PDF is encrypted and no password was provided. */
class PasswordRequiredException : IOException("This PDF is password-protected")

/** Thrown when the supplied password is incorrect. */
class InvalidPasswordException : IOException("Incorrect password")

/**
 * PDF Document wrapper that handles PdfRenderer lifecycle
 * Thread-safe implementation for rendering PDF pages
 */
class PdfDocument private constructor(
    private val fileDescriptor: ParcelFileDescriptor,
    private val renderer: PdfRenderer,
    private val tempUnlockedFile: File? = null
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

    /**
     * Batch-loads dimensions for ALL pages in a single mutex lock.
     * Much faster than calling getPageDimensions() N times, because
     * we acquire the mutex only once and avoid repeated lock overhead.
     */
    suspend fun getAllPageDimensions(): List<Pair<Int, Int>> = withContext(Dispatchers.IO) {
        val result = mutableListOf<Pair<Int, Int>>()
        renderMutex.withLock {
            try {
                currentPage?.close()
                currentPage = null

                for (i in 0 until pageCount) {
                    try {
                        val page = renderer.openPage(i)
                        result.add(Pair(page.width, page.height))
                        page.close()
                    } catch (e: Exception) {
                        // Fallback to standard US Letter dimensions
                        result.add(Pair(612, 792))
                    }
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
        result
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
        // Clean up temp unlocked file (password was only in memory during open)
        tempUnlockedFile?.let { file ->
            try { file.delete() } catch (_: Exception) { }
        }
    }

    companion object {
        /**
         * Opens a PDF document from a file, optionally with a password.
         *
         * Behaviour:
         * 1. Load bytes via PdfBox to detect encryption.
         *    – If encrypted and password is null → throw [PasswordRequiredException]
         *    – If encrypted and password is wrong → throw [InvalidPasswordException]
         * 2. If the document was encrypted, save a decrypted copy to a temp file
         *    and hand that to PdfRenderer. The temp file is deleted on [close].
         * 3. Non-encrypted documents are opened directly via PdfRenderer.
         *
         * @param file    The PDF file on disk.
         * @param password Optional password. Only kept in memory; never stored.
         */
        suspend fun open(file: File, password: String? = null): Result<PdfDocument> = withContext(Dispatchers.IO) {
            try {
                if (!file.exists()) {
                    return@withContext Result.failure(IOException("File not found: ${file.absolutePath}"))
                }
                if (!file.canRead()) {
                    return@withContext Result.failure(IOException("Cannot read file: ${file.absolutePath}"))
                }

                // Try PdfBox to detect encryption
                val pdfBoxDoc: PDDocument? = try {
                    PDDocument.load(file, password ?: "")
                } catch (e: PdfBoxInvalidPasswordException) {
                    if (password == null) throw PasswordRequiredException()
                    else throw InvalidPasswordException()
                }

                val tempFile: File?
                val targetFile: File

                if (pdfBoxDoc != null && pdfBoxDoc.isEncrypted) {
                    // Save unlocked document to temp file for PdfRenderer
                    pdfBoxDoc.isAllSecurityToBeRemoved = true
                    val cacheDir = file.parentFile?.let { File(it, ".kiosk_unlock_cache") }
                        ?: File(System.getProperty("java.io.tmpdir"), ".kiosk_unlock_cache")
                    cacheDir.mkdirs()
                    tempFile = File(cacheDir, "unlocked_${System.currentTimeMillis()}.pdf")
                    FileOutputStream(tempFile).use { out ->
                        pdfBoxDoc.save(out)
                    }
                    pdfBoxDoc.close()
                    targetFile = tempFile
                } else {
                    pdfBoxDoc?.close()
                    tempFile = null
                    targetFile = file
                }

                val fileDescriptor = ParcelFileDescriptor.open(
                    targetFile,
                    ParcelFileDescriptor.MODE_READ_ONLY
                )

                val renderer = PdfRenderer(fileDescriptor)

                if (renderer.pageCount == 0) {
                    renderer.close()
                    fileDescriptor.close()
                    tempFile?.delete()
                    return@withContext Result.failure(IOException("PDF has no pages"))
                }

                Result.success(PdfDocument(fileDescriptor, renderer, tempFile))
            } catch (e: PasswordRequiredException) {
                Result.failure(e)
            } catch (e: InvalidPasswordException) {
                Result.failure(e)
            } catch (e: SecurityException) {
                Result.failure(IOException("Permission denied: ${e.message}"))
            } catch (e: IOException) {
                Result.failure(IOException("Failed to open PDF: ${e.message}"))
            } catch (e: Exception) {
                Result.failure(IOException("Unexpected error: ${e.message}"))
            }
        }

        /**
         * Opens a PDF document from a content URI, optionally with a password.
         * Copies to cache if necessary for PdfRenderer compatibility.
         */
        suspend fun open(context: Context, uri: Uri, password: String? = null): Result<PdfDocument> = withContext(Dispatchers.IO) {
            try {
                // Initialise PdfBox resources (safe to call multiple times)
                PDFBoxResourceLoader.init(context)

                // First copy to cache so we have a File for PdfBox + PdfRenderer
                val cacheFile = copyToCache(context, uri)
                    ?: return@withContext Result.failure(IOException("Failed to copy PDF to cache"))

                open(cacheFile, password)
            } catch (e: PasswordRequiredException) {
                Result.failure(e)
            } catch (e: InvalidPasswordException) {
                Result.failure(e)
            } catch (e: SecurityException) {
                Result.failure(IOException("Permission denied: ${e.message}"))
            } catch (e: Exception) {
                Result.failure(IOException("Failed to open PDF: ${e.message}"))
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
