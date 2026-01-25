package com.kiosk.reader.ui.viewer

import android.content.Context
import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Matrix
import android.graphics.Paint
import android.util.AttributeSet
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import androidx.core.content.ContextCompat
import androidx.core.view.GestureDetectorCompat
import com.kiosk.reader.R
import com.kiosk.reader.pdf.PageCache
import com.kiosk.reader.pdf.PdfDocument
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.max
import kotlin.math.min

/**
 * Continuous vertical scrolling PDF view with smooth canvas-based zoom.
 * 
 * ZOOM DESIGN (matches Tauri/macOS reference):
 * - Pages are rendered ONCE at a base resolution (fit-width * 2 for quality headroom)
 * - All zoom is done via Canvas matrix transforms on cached bitmaps
 * - NO re-rendering during zoom gestures
 * - Re-render only when zoom gesture ENDS and quality is insufficient
 * - This ensures smooth, native-feeling pinch-to-zoom
 */
class ContinuousPdfView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    // PDF document
    private var pdfDocument: PdfDocument? = null
    private var pageCount: Int = 0

    // Page dimensions (original PDF units)
    private val pageDimensions = mutableListOf<Pair<Int, Int>>()
    private var pageGap: Int = 16.dpToPx()

    // Zoom and scroll state
    private var scrollY: Float = 0f
    private var scale: Float = 1.0f
    private var minScale: Float = 0.5f
    private var maxScale: Float = 4.0f
    private var fitScale: Float = 1.0f
    private var baseRenderScale: Float = 1.0f

    // Content dimensions
    private var totalContentHeight: Float = 0f
    private var maxPageWidth: Int = 0

    // Rendering
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val nightModePaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val bitmapMatrix = Matrix()
    private val pageCache = PageCache(128)
    
    // Night mode (DO NOT MODIFY)
    private var nightModeEnabled: Boolean = false
    private val invertColorMatrix = ColorMatrix(
        floatArrayOf(
            -1f, 0f, 0f, 0f, 255f,
            0f, -1f, 0f, 0f, 255f,
            0f, 0f, -1f, 0f, 255f,
            0f, 0f, 0f, 1f, 0f
        )
    )

    // Gesture detection
    private val scaleGestureDetector: ScaleGestureDetector
    private val gestureDetector: GestureDetectorCompat
    private var isScaling = false

    // Coroutines
    private val viewScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val renderJobs = mutableMapOf<Int, Job>()
    private var initJob: Job? = null
    private var qualityUpgradeJob: Job? = null

    // Callbacks
    var onPageChanged: ((Int, Int) -> Unit)? = null
    var onLoadingStateChanged: ((Boolean) -> Unit)? = null
    var onError: ((String) -> Unit)? = null

    // Current visible page
    private var currentVisiblePage: Int = 0

    init {
        nightModePaint.colorFilter = ColorMatrixColorFilter(invertColorMatrix)
        setBackgroundColor(ContextCompat.getColor(context, R.color.pdf_background))

        // Scale gesture detector for pinch-to-zoom
        scaleGestureDetector = ScaleGestureDetector(context, ScaleListener())
        scaleGestureDetector.isQuickScaleEnabled = false

        // Gesture detector for scroll, fling, double-tap
        gestureDetector = GestureDetectorCompat(context, GestureListener())
    }

    /**
     * Scale gesture listener for pinch-to-zoom.
     * Uses canvas transforms only - NO re-rendering during gesture.
     */
    private inner class ScaleListener : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        private var focusY: Float = 0f
        
        override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
            isScaling = true
            focusY = detector.focusY
            qualityUpgradeJob?.cancel()
            return true
        }

        override fun onScale(detector: ScaleGestureDetector): Boolean {
            val scaleFactor = detector.scaleFactor
            if (scaleFactor == 1.0f) return true
            
            val prevScale = scale
            val newScale = (scale * scaleFactor).coerceIn(minScale, maxScale)
            
            if (newScale != prevScale) {
                focusY = detector.focusY
                val contentY = scrollY + focusY
                
                scale = newScale
                updateContentDimensions()
                
                val newContentY = contentY * (newScale / prevScale)
                scrollY = (newContentY - focusY).coerceIn(0f, maxScrollY())
                
                invalidate()
            }
            return true
        }

        override fun onScaleEnd(detector: ScaleGestureDetector) {
            isScaling = false
            scheduleQualityUpgrade()
        }
    }

    /**
     * Gesture listener for scroll, fling, and double-tap.
     */
    private inner class GestureListener : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent): Boolean = true
        
        override fun onScroll(
            e1: MotionEvent?,
            e2: MotionEvent,
            distanceX: Float,
            distanceY: Float
        ): Boolean {
            if (!isScaling) {
                scrollY = (scrollY + distanceY).coerceIn(0f, maxScrollY())
                invalidate()
                updateCurrentPage()
            }
            return true
        }

        override fun onFling(
            e1: MotionEvent?,
            e2: MotionEvent,
            velocityX: Float,
            velocityY: Float
        ): Boolean {
            if (!isScaling) {
                viewScope.launch {
                    var velocity = -velocityY * 0.5f
                    while (kotlin.math.abs(velocity) > 50) {
                        scrollY = (scrollY + velocity * 0.016f).coerceIn(0f, maxScrollY())
                        velocity *= 0.95f
                        invalidate()
                        updateCurrentPage()
                        delay(16)
                    }
                    ensureVisiblePagesLoaded()
                }
            }
            return true
        }

        override fun onDoubleTap(e: MotionEvent): Boolean {
            val targetScale = if (scale < fitScale * 1.5f) {
                min(fitScale * 2.5f, maxScale)
            } else {
                fitScale
            }
            smoothZoomTo(targetScale, e.x, e.y)
            return true
        }

        override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
            performClick()
            return true
        }
    }

    private fun scheduleQualityUpgrade() {
        qualityUpgradeJob?.cancel()
        qualityUpgradeJob = viewScope.launch {
            delay(250)
            upgradeVisiblePageQuality()
        }
    }

    private fun upgradeVisiblePageQuality() {
        val document = pdfDocument ?: return
        if (pageDimensions.isEmpty()) return

        val visiblePages = getVisiblePageIndices()
        
        for (pageIndex in visiblePages) {
            val entry = pageCache.getBestAvailable(pageIndex)
            val needsUpgrade = entry == null || 
                (scale * fitScale > entry.renderedScale * 1.3f)
            
            if (needsUpgrade && !renderJobs.containsKey(pageIndex)) {
                renderPageAsync(document, pageIndex)
            }
        }
    }

    private fun ensureVisiblePagesLoaded() {
        val document = pdfDocument ?: return
        if (pageDimensions.isEmpty()) return

        val visiblePages = getVisiblePageIndices()
        val pagesToPreload = mutableSetOf<Int>()
        pagesToPreload.addAll(visiblePages)
        
        visiblePages.forEach { page ->
            if (page > 0) pagesToPreload.add(page - 1)
            if (page < pageCount - 1) pagesToPreload.add(page + 1)
        }

        for (pageIndex in pagesToPreload) {
            if (pageCache.getBestAvailable(pageIndex) == null && !renderJobs.containsKey(pageIndex)) {
                renderPageAsync(document, pageIndex)
            }
        }
    }

    private fun renderPageAsync(document: PdfDocument, pageIndex: Int) {
        renderJobs[pageIndex] = viewScope.launch {
            try {
                val bitmap = document.renderPage(pageIndex, baseRenderScale)
                if (bitmap != null) {
                    pageCache.put(pageIndex, baseRenderScale, bitmap)
                    withContext(Dispatchers.Main) {
                        invalidate()
                    }
                }
            } catch (e: Exception) {
                e.printStackTrace()
            } finally {
                renderJobs.remove(pageIndex)
            }
        }
    }

    private fun getVisiblePageIndices(): List<Int> {
        val visibleTop = scrollY
        val visibleBottom = scrollY + height
        val visiblePages = mutableListOf<Int>()
        
        var pageTop = 0f
        for (i in pageDimensions.indices) {
            val pageHeight = pageDimensions[i].second * scale
            val pageBottom = pageTop + pageHeight
            
            if (pageBottom >= visibleTop && pageTop <= visibleBottom) {
                visiblePages.add(i)
            }
            
            pageTop = pageBottom + pageGap
            if (pageTop > visibleBottom) break
        }
        
        return visiblePages
    }

    private fun smoothZoomTo(targetScale: Float, focusX: Float, focusY: Float) {
        val startScale = scale
        val contentY = scrollY + focusY
        
        viewScope.launch {
            val duration = 200L
            val startTime = System.currentTimeMillis()
            
            while (true) {
                val elapsed = System.currentTimeMillis() - startTime
                val progress = min(1f, elapsed.toFloat() / duration)
                val eased = 1f - (1f - progress) * (1f - progress)
                
                scale = startScale + (targetScale - startScale) * eased
                updateContentDimensions()
                
                val newContentY = contentY * (scale / startScale)
                scrollY = (newContentY - focusY).coerceIn(0f, maxScrollY())
                
                invalidate()
                
                if (progress >= 1f) break
                delay(16)
            }
            
            scheduleQualityUpgrade()
        }
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    fun setDocument(document: PdfDocument) {
        release()
        pdfDocument = document
        pageCount = document.pageCount

        initJob = viewScope.launch {
            onLoadingStateChanged?.invoke(true)
            try {
                pageDimensions.clear()
                maxPageWidth = 0

                for (i in 0 until pageCount) {
                    val dims = document.getPageDimensions(i)
                    if (dims != null) {
                        pageDimensions.add(dims)
                        maxPageWidth = max(maxPageWidth, dims.first)
                    } else {
                        pageDimensions.add(Pair(612, 792))
                    }
                }

                if (width > 0 && maxPageWidth > 0) {
                    fitScale = (width - 32.dpToPx()).toFloat() / maxPageWidth
                    scale = fitScale
                    minScale = fitScale * 0.5f
                    maxScale = fitScale * 4.0f
                    baseRenderScale = fitScale * 2.0f
                }

                updateContentDimensions()
                scrollY = 0f
                
                withContext(Dispatchers.Main) {
                    invalidate()
                    ensureVisiblePagesLoaded()
                    onPageChanged?.invoke(0, pageCount)
                }
            } catch (e: Exception) {
                onError?.invoke("Failed to initialize PDF: ${e.message}")
            } finally {
                onLoadingStateChanged?.invoke(false)
            }
        }
    }

    fun getCurrentPage(): Int = currentVisiblePage
    fun getPageCount(): Int = pageCount

    fun goToPage(pageIndex: Int) {
        if (pageIndex < 0 || pageIndex >= pageCount) return
        scrollY = getPageTop(pageIndex)
        invalidate()
        updateCurrentPage()
        ensureVisiblePagesLoaded()
    }

    fun setNightMode(enabled: Boolean) {
        if (nightModeEnabled != enabled) {
            nightModeEnabled = enabled
            invalidate()
        }
    }
    
    fun isNightModeEnabled(): Boolean = nightModeEnabled

    fun zoomIn() {
        val newScale = min(scale * 1.25f, maxScale)
        smoothZoomTo(newScale, width / 2f, height / 2f)
    }

    fun zoomOut() {
        val newScale = max(scale / 1.25f, minScale)
        smoothZoomTo(newScale, width / 2f, height / 2f)
    }

    fun resetZoom() {
        smoothZoomTo(fitScale, width / 2f, height / 2f)
    }

    private fun updateContentDimensions() {
        totalContentHeight = 0f
        for ((_, h) in pageDimensions) {
            totalContentHeight += h * scale + pageGap
        }
        if (pageDimensions.isNotEmpty()) {
            totalContentHeight -= pageGap
        }
    }

    private fun maxScrollY(): Float = max(0f, totalContentHeight - height)

    private fun getPageTop(pageIndex: Int): Float {
        var top = 0f
        for (i in 0 until pageIndex) {
            if (i < pageDimensions.size) {
                top += pageDimensions[i].second * scale + pageGap
            }
        }
        return top.coerceIn(0f, maxScrollY())
    }

    private fun updateCurrentPage() {
        if (pageDimensions.isEmpty()) return
        
        var accumulatedHeight = 0f
        val viewCenter = scrollY + height / 3f
        
        for (i in pageDimensions.indices) {
            val pageHeight = pageDimensions[i].second * scale + pageGap
            if (viewCenter < accumulatedHeight + pageHeight) {
                if (i != currentVisiblePage) {
                    currentVisiblePage = i
                    onPageChanged?.invoke(currentVisiblePage, pageCount)
                }
                return
            }
            accumulatedHeight += pageHeight
        }
        
        if (currentVisiblePage != pageCount - 1) {
            currentVisiblePage = pageCount - 1
            onPageChanged?.invoke(currentVisiblePage, pageCount)
        }
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        
        if (maxPageWidth > 0 && w > 0) {
            val newFitScale = (w - 32.dpToPx()).toFloat() / maxPageWidth
            val relativeZoom = scale / fitScale
            fitScale = newFitScale
            scale = (newFitScale * relativeZoom).coerceIn(minScale, maxScale)
            
            minScale = fitScale * 0.5f
            maxScale = fitScale * 4.0f
            baseRenderScale = fitScale * 2.0f
            
            updateContentDimensions()
            scrollY = scrollY.coerceIn(0f, maxScrollY())
            
            ensureVisiblePagesLoaded()
        }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (pageDimensions.isEmpty()) return

        val activePaint = if (nightModeEnabled) nightModePaint else paint
        var pageTop = -scrollY
        
        for (i in pageDimensions.indices) {
            val (origWidth, origHeight) = pageDimensions[i]
            val displayWidth = origWidth * scale
            val displayHeight = origHeight * scale
            val pageBottom = pageTop + displayHeight
            
            if (pageBottom >= 0 && pageTop <= height) {
                val left = (width - displayWidth) / 2f
                
                if (!nightModeEnabled) {
                    paint.color = 0xFFFFFFFF.toInt()
                    canvas.drawRect(left, pageTop, left + displayWidth, pageBottom, paint)
                }

                val entry = pageCache.getBestAvailable(i)
                if (entry != null && !entry.bitmap.isRecycled) {
                    val bw = entry.bitmap.width.toFloat()
                    val bh = entry.bitmap.height.toFloat()
                    
                    bitmapMatrix.reset()
                    bitmapMatrix.postScale(displayWidth / bw, displayHeight / bh)
                    bitmapMatrix.postTranslate(left, pageTop)
                    
                    canvas.drawBitmap(entry.bitmap, bitmapMatrix, activePaint)
                } else {
                    paint.color = 0xFFF0F0F0.toInt()
                    canvas.drawRect(left, pageTop, left + displayWidth, pageBottom, paint)
                }
            }
            
            pageTop = pageBottom + pageGap
        }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        scaleGestureDetector.onTouchEvent(event)
        
        if (!scaleGestureDetector.isInProgress) {
            gestureDetector.onTouchEvent(event)
        }
        
        if (event.actionMasked == MotionEvent.ACTION_UP || 
            event.actionMasked == MotionEvent.ACTION_CANCEL) {
            if (!isScaling) {
                ensureVisiblePagesLoaded()
            }
        }
        
        if (event.pointerCount > 1 || scaleGestureDetector.isInProgress) {
            parent?.requestDisallowInterceptTouchEvent(true)
        }
        
        return true
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        release()
    }

    fun release() {
        initJob?.cancel()
        qualityUpgradeJob?.cancel()
        renderJobs.values.forEach { it.cancel() }
        renderJobs.clear()
        pageCache.clear()
        pageDimensions.clear()
        pdfDocument?.close()
        pdfDocument = null
    }

    private fun Int.dpToPx(): Int = (this * resources.displayMetrics.density).toInt()
}
