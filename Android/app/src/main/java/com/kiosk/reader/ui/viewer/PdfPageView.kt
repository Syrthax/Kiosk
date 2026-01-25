package com.kiosk.reader.ui.viewer

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.PointF
import android.graphics.RectF
import android.util.AttributeSet
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import androidx.core.view.GestureDetectorCompat
import com.kiosk.reader.pdf.PageCache
import com.kiosk.reader.pdf.PdfDocument
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Custom View for rendering and interacting with PDF pages
 * Supports smooth scrolling, pinch-to-zoom, and double-tap zoom
 */
class PdfPageView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    // PDF document and rendering
    private var pdfDocument: PdfDocument? = null
    private var currentPageIndex: Int = 0
    private var pageBitmap: Bitmap? = null
    private var pageWidth: Int = 0
    private var pageHeight: Int = 0
    
    // Page cache for smooth navigation
    private val pageCache = PageCache()

    // Transformation state
    private var scale: Float = 1.0f
    private var minScale: Float = 0.5f
    private var maxScale: Float = 5.0f
    private var translateX: Float = 0f
    private var translateY: Float = 0f

    // Rendering
    private val matrix = Matrix()
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val nightModePaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)

    // Night mode (inverted colors)
    private var nightModeEnabled: Boolean = false
    private val invertColorMatrix = ColorMatrix(
        floatArrayOf(
            -1f, 0f, 0f, 0f, 255f,
            0f, -1f, 0f, 0f, 255f,
            0f, 0f, -1f, 0f, 255f,
            0f, 0f, 0f, 1f, 0f
        )
    )

    // Gesture detectors
    private val scaleGestureDetector: ScaleGestureDetector
    private val gestureDetector: GestureDetectorCompat

    // Touch handling
    private var lastTouchX: Float = 0f
    private var lastTouchY: Float = 0f
    private var isScaling: Boolean = false
    private var activePointerId: Int = MotionEvent.INVALID_POINTER_ID

    // Coroutine scope for async rendering
    private val viewScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var renderJob: Job? = null

    // Callbacks
    var onPageChanged: ((Int, Int) -> Unit)? = null
    var onLoadingStateChanged: ((Boolean) -> Unit)? = null
    var onError: ((String) -> Unit)? = null

    init {
        // Initialize night mode paint
        nightModePaint.colorFilter = ColorMatrixColorFilter(invertColorMatrix)

        // Scale gesture detector for pinch-to-zoom
        scaleGestureDetector = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            private var focusX: Float = 0f
            private var focusY: Float = 0f

            override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
                isScaling = true
                focusX = detector.focusX
                focusY = detector.focusY
                return true
            }

            override fun onScale(detector: ScaleGestureDetector): Boolean {
                val scaleFactor = detector.scaleFactor
                val newScale = (scale * scaleFactor).coerceIn(minScale, maxScale)
                
                if (newScale != scale) {
                    // Scale around the focus point
                    val focusXInBitmap = (focusX - translateX) / scale
                    val focusYInBitmap = (focusY - translateY) / scale

                    scale = newScale

                    translateX = focusX - focusXInBitmap * scale
                    translateY = focusY - focusYInBitmap * scale

                    constrainTranslation()
                    invalidate()
                }
                return true
            }

            override fun onScaleEnd(detector: ScaleGestureDetector) {
                isScaling = false
            }
        })

        // Gesture detector for double-tap zoom and flings
        gestureDetector = GestureDetectorCompat(context, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDoubleTap(e: MotionEvent): Boolean {
                // Toggle between fit width and 2x zoom
                val targetScale = if (scale < 1.8f) 2.5f else calculateFitScale()
                animateScaleTo(targetScale, e.x, e.y)
                return true
            }

            override fun onScroll(
                e1: MotionEvent?,
                e2: MotionEvent,
                distanceX: Float,
                distanceY: Float
            ): Boolean {
                if (!isScaling) {
                    translateX -= distanceX
                    translateY -= distanceY
                    constrainTranslation()
                    invalidate()
                }
                return true
            }

            override fun onFling(
                e1: MotionEvent?,
                e2: MotionEvent,
                velocityX: Float,
                velocityY: Float
            ): Boolean {
                // Could add momentum scrolling here
                return true
            }

            override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
                // Could show/hide UI here
                performClick()
                return true
            }
        })
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    fun setDocument(document: PdfDocument) {
        pageCache.clear()
        pdfDocument?.close()
        pdfDocument = document
        currentPageIndex = 0
        loadCurrentPage()
    }

    fun getCurrentPage(): Int = currentPageIndex

    fun getPageCount(): Int = pdfDocument?.pageCount ?: 0

    fun goToPage(pageIndex: Int) {
        val document = pdfDocument ?: return
        if (pageIndex < 0 || pageIndex >= document.pageCount) return
        if (pageIndex == currentPageIndex) return

        currentPageIndex = pageIndex
        loadCurrentPage()
    }

    fun nextPage() {
        goToPage(currentPageIndex + 1)
    }

    fun previousPage() {
        goToPage(currentPageIndex - 1)
    }

    fun setNightMode(enabled: Boolean) {
        if (nightModeEnabled != enabled) {
            nightModeEnabled = enabled
            invalidate()
        }
    }

    fun isNightModeEnabled(): Boolean = nightModeEnabled

    fun zoomIn() {
        val newScale = (scale * 1.25f).coerceAtMost(maxScale)
        animateScaleTo(newScale, width / 2f, height / 2f)
    }

    fun zoomOut() {
        val newScale = (scale / 1.25f).coerceAtLeast(minScale)
        animateScaleTo(newScale, width / 2f, height / 2f)
    }

    fun resetZoom() {
        val fitScale = calculateFitScale()
        animateScaleTo(fitScale, width / 2f, height / 2f)
    }

    private fun loadCurrentPage() {
        renderJob?.cancel()
        onLoadingStateChanged?.invoke(true)

        renderJob = viewScope.launch {
            try {
                val document = pdfDocument ?: return@launch

                // Check cache first
                val cachedBitmap = pageCache.get(currentPageIndex, 1.0f)
                if (cachedBitmap != null && !cachedBitmap.isRecycled) {
                    setPageBitmap(cachedBitmap, fromCache = true)
                    return@launch
                }

                // Get page dimensions
                val dimensions = document.getPageDimensions(currentPageIndex)
                if (dimensions == null) {
                    onError?.invoke("Failed to get page dimensions")
                    return@launch
                }

                pageWidth = dimensions.first
                pageHeight = dimensions.second

                // Render at appropriate scale for quality
                val renderScale = calculateRenderScale()
                val bitmap = document.renderPage(currentPageIndex, renderScale)

                if (bitmap != null) {
                    pageCache.put(currentPageIndex, 1.0f, bitmap)
                    setPageBitmap(bitmap, fromCache = false)
                    
                    // Preload adjacent pages
                    preloadAdjacentPages()
                } else {
                    onError?.invoke("Failed to render page")
                }
            } catch (e: Exception) {
                e.printStackTrace()
                onError?.invoke("Error loading page: ${e.message}")
            } finally {
                onLoadingStateChanged?.invoke(false)
            }
        }
    }

    private suspend fun setPageBitmap(bitmap: Bitmap, fromCache: Boolean) {
        withContext(Dispatchers.Main) {
            pageBitmap = bitmap
            
            // Reset transform to fit page
            if (!fromCache) {
                scale = calculateFitScale()
                centerPage()
            }
            
            invalidate()
            onPageChanged?.invoke(currentPageIndex, pdfDocument?.pageCount ?: 0)
        }
    }

    private fun preloadAdjacentPages() {
        val document = pdfDocument ?: return
        
        // Preload next and previous pages
        listOf(currentPageIndex - 1, currentPageIndex + 1).forEach { pageIndex ->
            if (pageIndex in 0 until document.pageCount) {
                if (pageCache.get(pageIndex, 1.0f) == null) {
                    viewScope.launch {
                        val bitmap = document.renderPage(pageIndex, calculateRenderScale())
                        if (bitmap != null) {
                            pageCache.put(pageIndex, 1.0f, bitmap)
                        }
                    }
                }
            }
        }
    }

    private fun calculateRenderScale(): Float {
        if (width == 0 || height == 0 || pageWidth == 0) return 2.0f
        
        // Render at 2x the fit scale for quality when zooming
        val fitScale = calculateFitScale()
        return (fitScale * 2.0f).coerceIn(1.0f, 4.0f)
    }

    private fun calculateFitScale(): Float {
        val bitmap = pageBitmap ?: return 1.0f
        if (width == 0 || height == 0) return 1.0f

        val scaleX = width.toFloat() / bitmap.width
        val scaleY = height.toFloat() / bitmap.height
        
        return min(scaleX, scaleY)
    }

    private fun centerPage() {
        val bitmap = pageBitmap ?: return
        
        val scaledWidth = bitmap.width * scale
        val scaledHeight = bitmap.height * scale
        
        translateX = (width - scaledWidth) / 2f
        translateY = (height - scaledHeight) / 2f
    }

    private fun constrainTranslation() {
        val bitmap = pageBitmap ?: return
        
        val scaledWidth = bitmap.width * scale
        val scaledHeight = bitmap.height * scale
        
        // Allow centering if content is smaller than view
        if (scaledWidth <= width) {
            translateX = (width - scaledWidth) / 2f
        } else {
            translateX = translateX.coerceIn(width - scaledWidth, 0f)
        }
        
        if (scaledHeight <= height) {
            translateY = (height - scaledHeight) / 2f
        } else {
            translateY = translateY.coerceIn(height - scaledHeight, 0f)
        }
    }

    private fun animateScaleTo(targetScale: Float, focusX: Float, focusY: Float) {
        // Simple immediate scale for now (could animate)
        val focusXInBitmap = (focusX - translateX) / scale
        val focusYInBitmap = (focusY - translateY) / scale

        scale = targetScale

        translateX = focusX - focusXInBitmap * scale
        translateY = focusY - focusYInBitmap * scale

        constrainTranslation()
        invalidate()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        
        if (pageBitmap != null) {
            scale = calculateFitScale()
            centerPage()
            invalidate()
        }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)

        val bitmap = pageBitmap ?: return

        // Set up transformation matrix
        matrix.reset()
        matrix.postScale(scale, scale)
        matrix.postTranslate(translateX, translateY)

        // Draw bitmap with or without night mode filter
        val activePaint = if (nightModeEnabled) nightModePaint else paint
        canvas.drawBitmap(bitmap, matrix, activePaint)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        // Handle scale gestures first
        scaleGestureDetector.onTouchEvent(event)
        gestureDetector.onTouchEvent(event)
        
        return true
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        viewScope.cancel()
        pageCache.clear()
        pageBitmap = null
    }

    fun release() {
        viewScope.cancel()
        pageCache.clear()
        pageBitmap = null
        pdfDocument?.close()
        pdfDocument = null
    }
}
