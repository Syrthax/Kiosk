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
import android.widget.OverScroller
import androidx.core.content.ContextCompat
import androidx.core.view.GestureDetectorCompat
import androidx.core.view.ViewCompat
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

    // Per-page fit-width scales (each page fills full view width independently)
    private val pageFitScales = mutableListOf<Float>()

    // Content dimensions
    private var totalContentHeight: Float = 0f
    private var maxPageWidth: Int = 0

    // Native fling scroller for frame-perfect momentum scrolling
    private val flingScroller = OverScroller(context)
    private var flingRunnable: Runnable? = null

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
    /** Fired whenever scrollY or scale changes so overlays (e.g. AnnotationLayer) can redraw. */
    var onTransformChanged: (() -> Unit)? = null
    /** Fired with the raw scroll distanceY during finger-driven scroll (not fling). */
    var onScrollDelta: ((Float) -> Unit)? = null

    /** When false, single-finger scroll/fling is suppressed (annotation mode).
     *  Pinch zoom still works via [handleExternalTouch]. */
    var allowSingleFingerGestures = true

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
            if (!isScaling && allowSingleFingerGestures) {
                scrollY = (scrollY + distanceY).coerceIn(0f, maxScrollY())
                invalidate()
                updateCurrentPage()
                onScrollDelta?.invoke(distanceY)
            }
            return true
        }

        override fun onFling(
            e1: MotionEvent?,
            e2: MotionEvent,
            velocityX: Float,
            velocityY: Float
        ): Boolean {
            if (!isScaling && allowSingleFingerGestures) {
                startFling(-velocityY.toInt())
            }
            return true
        }

        override fun onDoubleTap(e: MotionEvent): Boolean {
            if (!allowSingleFingerGestures) return false
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

    // ─── Fling via OverScroller ─────────────────────────────────────────

    private fun startFling(velocityY: Int) {
        flingScroller.forceFinished(true)
        flingScroller.fling(
            0, scrollY.toInt(),
            0, velocityY,
            0, 0,
            0, maxScrollY().toInt(),
            0, (48 * resources.displayMetrics.density).toInt() // edge overscroll glow
        )
        tickFling()
    }

    private fun tickFling() {
        flingRunnable = Runnable {
            if (flingScroller.computeScrollOffset()) {
                scrollY = flingScroller.currY.toFloat().coerceIn(0f, maxScrollY())
                invalidate()
                updateCurrentPage()
                tickFling()
            } else {
                ensureVisiblePagesLoaded()
            }
        }
        ViewCompat.postOnAnimation(this, flingRunnable!!)
    }

    // ─── Quality upgrade after gesture ends ────────────────────────────────

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
                // Per-page render scale: ensures each page fills screen width
                val pageRenderScale = if (pageIndex < pageFitScales.size)
                    pageFitScales[pageIndex] * 2.0f   // 2× headroom for zoom quality
                else
                    baseRenderScale

                val bitmap = document.renderPage(pageIndex, pageRenderScale)
                if (bitmap != null) {
                    pageCache.put(pageIndex, pageRenderScale, bitmap)
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
        val zoomRatio = if (fitScale > 0f) scale / fitScale else 1f
        val visibleTop = scrollY
        val visibleBottom = scrollY + height
        val visiblePages = mutableListOf<Int>()

        var pageTop = 0f
        for (i in pageDimensions.indices) {
            val pageFit = pageFitScales.getOrElse(i) { fitScale }
            val pageHeight = pageDimensions[i].second * pageFit * zoomRatio
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
                updateCurrentPage()
                
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

                // Compute per-page fit-width scale so every page fills the screen
                pageFitScales.clear()
                val viewW = width.toFloat()
                for (dims in pageDimensions) {
                    val pageW = dims.first.toFloat().coerceAtLeast(1f)
                    pageFitScales.add(viewW / pageW)
                }

                if (width > 0 && maxPageWidth > 0) {
                    // Global fitScale based on widest page (used for zoom limits)
                    fitScale = viewW / maxPageWidth.toFloat()
                    scale = fitScale
                    minScale = fitScale              // 1× = can't zoom out below fit-width
                    maxScale = fitScale * 5.0f       // 5× zoom
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

    // ──────────────────────────────────────────────────────────────────────
    // State accessors for AnnotationLayer coordinate mapping
    // ──────────────────────────────────────────────────────────────────────

    /** Current vertical scroll offset in pixel content-space. */
    fun getPdfScrollY(): Float = scrollY

    /** Current display scale applied to PDF pages. */
    fun getScale(): Float = scale

    /** Vertical gap between pages in pixels. */
    fun getPageGapPx(): Int = pageGap

    /**
     * Snapshot of page dimensions (originalWidth x originalHeight in PDF units).
     * Returned list is a defensive copy – safe to iterate off the main thread.
     */
    fun getPageDimensionsList(): List<Pair<Int, Int>> = pageDimensions.toList()

    /** Per-page fit-width scale factors. */
    fun getPageFitScales(): List<Float> = pageFitScales.toList()

    /** Global fit scale (widest page fills view width). */
    fun getFitScale(): Float = fitScale

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
        val zoomRatio = if (fitScale > 0f) scale / fitScale else 1f
        for (i in pageDimensions.indices) {
            val pageFit = pageFitScales.getOrElse(i) { fitScale }
            totalContentHeight += pageDimensions[i].second * pageFit * zoomRatio + pageGap
        }
        if (pageDimensions.isNotEmpty()) {
            totalContentHeight -= pageGap
        }
    }

    private fun maxScrollY(): Float = max(0f, totalContentHeight - height)

    private fun getPageTop(pageIndex: Int): Float {
        val zoomRatio = if (fitScale > 0f) scale / fitScale else 1f
        var top = 0f
        for (i in 0 until pageIndex) {
            if (i < pageDimensions.size) {
                val pageFit = pageFitScales.getOrElse(i) { fitScale }
                top += pageDimensions[i].second * pageFit * zoomRatio + pageGap
            }
        }
        return top.coerceIn(0f, maxScrollY())
    }

    private fun updateCurrentPage() {
        if (pageDimensions.isEmpty()) return

        val zoomRatio = if (fitScale > 0f) scale / fitScale else 1f
        var accumulatedHeight = 0f
        val viewCenter = scrollY + height / 3f

        for (i in pageDimensions.indices) {
            val pageFit = pageFitScales.getOrElse(i) { fitScale }
            val pageHeight = pageDimensions[i].second * pageFit * zoomRatio + pageGap
            if (viewCenter < accumulatedHeight + pageHeight) {
                if (i != currentVisiblePage) {
                    currentVisiblePage = i
                    onPageChanged?.invoke(currentVisiblePage, pageCount)
                }
                onTransformChanged?.invoke()
                return
            }
            accumulatedHeight += pageHeight
        }

        if (currentVisiblePage != pageCount - 1) {
            currentVisiblePage = pageCount - 1
            onPageChanged?.invoke(currentVisiblePage, pageCount)
        }
        onTransformChanged?.invoke()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        
        if (maxPageWidth > 0 && w > 0) {
            val newFitScale = w.toFloat() / maxPageWidth.toFloat()
            val relativeZoom = if (fitScale > 0f) scale / fitScale else 1f
            fitScale = newFitScale
            scale = (newFitScale * relativeZoom).coerceIn(minScale, maxScale)
            
            minScale = fitScale              // 1×
            maxScale = fitScale * 5.0f       // 5×
            baseRenderScale = fitScale * 2.0f

            // Recompute per-page scales for new width
            pageFitScales.clear()
            for (dims in pageDimensions) {
                val pageW = dims.first.toFloat().coerceAtLeast(1f)
                pageFitScales.add(w.toFloat() / pageW)
            }
            
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

        // At fitScale (default zoom = 1×) every page fills the view width.
        // The global `scale` can differ from fitScale when the user zooms.
        // zoomRatio > 1 means zoomed in beyond fit-width; < 1 means zoomed out.
        val zoomRatio = if (fitScale > 0f) scale / fitScale else 1f

        for (i in pageDimensions.indices) {
            val (origWidth, origHeight) = pageDimensions[i]

            // Per-page scale: fills width at zoomRatio = 1
            val pageFit = pageFitScales.getOrElse(i) { fitScale }
            val effectiveScale = pageFit * zoomRatio

            val displayWidth = origWidth * effectiveScale
            val displayHeight = origHeight * effectiveScale
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

    /**
     * Forward touch events from overlays (e.g. AnnotationLayer) for pinch-to-zoom.
     * Only feeds the ScaleGestureDetector — single-finger gestures are NOT processed.
     */
    fun handleExternalTouch(event: MotionEvent) {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            flingScroller.forceFinished(true)
            flingRunnable?.let { removeCallbacks(it) }
            flingRunnable = null
        }
        scaleGestureDetector.onTouchEvent(event)
        if (event.pointerCount > 1 || scaleGestureDetector.isInProgress) {
            parent?.requestDisallowInterceptTouchEvent(true)
        }
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        // Cancel any running fling on new touch down
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            flingScroller.forceFinished(true)
            flingRunnable?.let { removeCallbacks(it) }
            flingRunnable = null
        }

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
        flingScroller.forceFinished(true)
        flingRunnable?.let { removeCallbacks(it) }
        flingRunnable = null
        initJob?.cancel()
        qualityUpgradeJob?.cancel()
        renderJobs.values.forEach { it.cancel() }
        renderJobs.clear()
        pageCache.clear()
        pageDimensions.clear()
        pageFitScales.clear()
        pdfDocument?.close()
        pdfDocument = null
    }

    private fun Int.dpToPx(): Int = (this * resources.displayMetrics.density).toInt()
}
