package com.kiosk.reader.ui.viewer

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import kotlin.math.hypot

/**
 * AnnotationLayer
 * ───────────────
 * Transparent full-screen canvas drawn on top of ContinuousPdfView.
 *
 * Annotations are stored in **page-local PDF coordinates** so they stay
 * perfectly aligned during any zoom / scroll operation.
 *
 * Coordinate mapping
 * ──────────────────
 * Given touch at (screenX, screenY):
 *   contentY  = screenY + pdfView.scrollY
 *   pageTop_i = Σ (pageDims[j].height * scale + gap) for j < i   [content space]
 *   pageLocalX = (screenX − (viewWidth − pageWidth*scale)/2) / scale
 *   pageLocalY = (contentY − pageTop_i) / scale
 *
 * Reverse (page-local → screen):
 *   screenX = pageLocalX * scale + (viewWidth − pageWidth*scale)/2
 *   screenY = (pageTop_i + pageLocalY * scale) − pdfView.scrollY
 */
class AnnotationLayer @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    // ──────────────────────────────────────────────────────────────────────
    // Data model
    // ──────────────────────────────────────────────────────────────────────

    /** A single point within a page's coordinate space. */
    data class PagePoint(val x: Float, val y: Float)

    /** A complete annotation stroke committed to a page. */
    data class AnnotationStroke(
        val pageIndex: Int,
        val points: List<PagePoint>,
        val color: Int,
        val strokeWidth: Float,    // in PDF-page units
        val isHighlight: Boolean,
        val isErase: Boolean = false
    )

    // ──────────────────────────────────────────────────────────────────────
    // Tool state
    // ──────────────────────────────────────────────────────────────────────

    enum class Tool { PEN, HIGHLIGHT, ERASER, SHAPES }

    var currentTool: Tool = Tool.PEN
    var currentColor: Int = Color.RED
    /** Stroke width in PDF-page units (roughly 1 unit = 1 pt on a 72-dpi page). */
    var currentStrokeWidth: Float = 2.5f

    // ──────────────────────────────────────────────────────────────────────
    // Stroke storage
    // ──────────────────────────────────────────────────────────────────────

    private val committedStrokes = mutableListOf<AnnotationStroke>()
    private val undoRedoStack    = mutableListOf<AnnotationStroke>()  // items removed by undo
    private val activePoints     = mutableListOf<PagePoint>()         // current finger path
    private var activePageIndex  = -1

    // ──────────────────────────────────────────────────────────────────────
    // Reference to the PDF view (must be set before use)
    // ──────────────────────────────────────────────────────────────────────

    private var pdfView: ContinuousPdfView? = null

    fun attachToPdfView(view: ContinuousPdfView) {
        pdfView = view
    }

    // ──────────────────────────────────────────────────────────────────────
    // Paints
    // ──────────────────────────────────────────────────────────────────────

    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }

    private val highlightPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.SQUARE
        strokeJoin = Paint.Join.ROUND
        // Highlight is semi-transparent; we use SRC_OVER so it blends with page
        alpha = 100
    }

    private val erasePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        // Erase by drawing transparently over the annotation layer
        xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
    }

    // ──────────────────────────────────────────────────────────────────────
    // Init: hardware layer required for PorterDuff.CLEAR erase support
    // ──────────────────────────────────────────────────────────────────────

    init {
        setBackgroundColor(Color.TRANSPARENT)
        // Hardware layer ensures CLEAR xfermode works correctly
        setLayerType(LAYER_TYPE_HARDWARE, null)
    }

    // ──────────────────────────────────────────────────────────────────────
    // Touch handling
    // ──────────────────────────────────────────────────────────────────────

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val pdf = pdfView ?: return false
        if (visibility != VISIBLE) return false

        val screenX = event.x
        val screenY = event.y

        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                activePoints.clear()
                undoRedoStack.clear()   // new gesture clears redo history
                val mapped = screenToPageCoords(pdf, screenX, screenY) ?: return true
                activePageIndex = mapped.first
                activePoints.add(mapped.second)
                invalidate()
                return true
            }

            MotionEvent.ACTION_MOVE -> {
                val mapped = screenToPageCoords(pdf, screenX, screenY) ?: return true
                // Only add if moved meaningfully (avoids tiny duplicate points)
                val last = activePoints.lastOrNull()
                if (last == null || hypot(mapped.second.x - last.x, mapped.second.y - last.y) > 0.5f) {
                    activePoints.add(mapped.second)
                    invalidate()
                }
                return true
            }

            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (activePoints.size >= 1 && activePageIndex >= 0) {
                    val stroke = AnnotationStroke(
                        pageIndex   = activePageIndex,
                        points      = activePoints.toList(),
                        color       = currentColor,
                        strokeWidth = currentStrokeWidth,
                        isHighlight = (currentTool == Tool.HIGHLIGHT),
                        isErase     = (currentTool == Tool.ERASER)
                    )
                    committedStrokes.add(stroke)
                }
                activePoints.clear()
                activePageIndex = -1
                invalidate()
                return true
            }
        }
        return false
    }

    // ──────────────────────────────────────────────────────────────────────
    // Coordinate mapping: screen → page-local
    // ──────────────────────────────────────────────────────────────────────

    private fun screenToPageCoords(
        pdf: ContinuousPdfView,
        screenX: Float,
        screenY: Float
    ): Pair<Int, PagePoint>? {
        val scale       = pdf.getScale()
        val scrollY     = pdf.getPdfScrollY()
        val gap         = pdf.getPageGapPx().toFloat()
        val viewWidth   = pdf.width.toFloat()
        val dims        = pdf.getPageDimensionsList()

        if (dims.isEmpty()) return null

        val contentY = screenY + scrollY
        var pageContentTop = 0f

        for (i in dims.indices) {
            val (origW, origH) = dims[i]
            val pageH     = origH * scale
            val pageW     = origW * scale
            val pageContentBottom = pageContentTop + pageH

            if (contentY in pageContentTop..pageContentBottom) {
                val left      = (viewWidth - pageW) / 2f
                val pageLocalX = (screenX - left) / scale
                val pageLocalY = (contentY - pageContentTop) / scale
                return Pair(i, PagePoint(pageLocalX, pageLocalY))
            }

            pageContentTop = pageContentBottom + gap
        }
        return null
    }

    // ──────────────────────────────────────────────────────────────────────
    // Coordinate mapping: page-local → screen
    // ──────────────────────────────────────────────────────────────────────

    private fun pageToScreenCoords(
        pdf: ContinuousPdfView,
        pageIndex: Int,
        pageX: Float,
        pageY: Float
    ): Pair<Float, Float>? {
        val scale     = pdf.getScale()
        val scrollY   = pdf.getPdfScrollY()
        val gap       = pdf.getPageGapPx().toFloat()
        val viewWidth = pdf.width.toFloat()
        val dims      = pdf.getPageDimensionsList()

        if (pageIndex >= dims.size) return null

        var pageContentTop = 0f
        for (i in 0 until pageIndex) {
            pageContentTop += dims[i].second * scale + gap
        }

        val origW      = dims[pageIndex].first
        val pageW      = origW * scale
        val left       = (viewWidth - pageW) / 2f
        val screenX    = pageX * scale + left
        val screenY    = pageContentTop + pageY * scale - scrollY
        return Pair(screenX, screenY)
    }

    // ──────────────────────────────────────────────────────────────────────
    // Drawing
    // ──────────────────────────────────────────────────────────────────────

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val pdf = pdfView ?: return

        // Draw committed strokes
        for (stroke in committedStrokes) {
            drawStroke(canvas, pdf, stroke)
        }

        // Draw active (in-progress) stroke
        if (activePoints.size >= 2 && activePageIndex >= 0) {
            val liveStroke = AnnotationStroke(
                pageIndex   = activePageIndex,
                points      = activePoints,
                color       = currentColor,
                strokeWidth = currentStrokeWidth,
                isHighlight = (currentTool == Tool.HIGHLIGHT),
                isErase     = (currentTool == Tool.ERASER)
            )
            drawStroke(canvas, pdf, liveStroke)
        }
    }

    private fun drawStroke(canvas: Canvas, pdf: ContinuousPdfView, stroke: AnnotationStroke) {
        if (stroke.points.size < 2) return

        val paint = when {
            stroke.isErase     -> {
                erasePaint.strokeWidth = stroke.strokeWidth * pdf.getScale() * 4f
                erasePaint
            }
            stroke.isHighlight -> {
                highlightPaint.color       = stroke.color
                highlightPaint.alpha       = 80
                highlightPaint.strokeWidth = stroke.strokeWidth * pdf.getScale() * 6f
                highlightPaint
            }
            else               -> {
                strokePaint.color       = stroke.color
                strokePaint.strokeWidth = stroke.strokeWidth * pdf.getScale()
                strokePaint
            }
        }

        val path = Path()
        var first = true

        for (pt in stroke.points) {
            val screen = pageToScreenCoords(pdf, stroke.pageIndex, pt.x, pt.y) ?: continue
            if (first) {
                path.moveTo(screen.first, screen.second)
                first = false
            } else {
                path.lineTo(screen.first, screen.second)
            }
        }

        canvas.drawPath(path, paint)
    }

    // ──────────────────────────────────────────────────────────────────────
    // Undo / Redo
    // ──────────────────────────────────────────────────────────────────────

    fun undo() {
        if (committedStrokes.isEmpty()) return
        val stroke = committedStrokes.removeLast()
        undoRedoStack.add(stroke)
        invalidate()
    }

    fun redo() {
        if (undoRedoStack.isEmpty()) return
        val stroke = undoRedoStack.removeLast()
        committedStrokes.add(stroke)
        invalidate()
    }

    fun canUndo(): Boolean = committedStrokes.isNotEmpty()
    fun canRedo(): Boolean = undoRedoStack.isNotEmpty()

    // ──────────────────────────────────────────────────────────────────────
    // Clear all annotations
    // ──────────────────────────────────────────────────────────────────────

    fun clearAll() {
        committedStrokes.clear()
        undoRedoStack.clear()
        activePoints.clear()
        invalidate()
    }

    // ──────────────────────────────────────────────────────────────────────
    // Serialisation helpers
    // ──────────────────────────────────────────────────────────────────────

    /** Returns a snapshot of all committed strokes for saving. */
    fun getStrokes(): List<AnnotationStroke> = committedStrokes.toList()

    /** Restores strokes from a saved snapshot. */
    fun loadStrokes(strokes: List<AnnotationStroke>) {
        committedStrokes.clear()
        committedStrokes.addAll(strokes)
        invalidate()
    }
}
