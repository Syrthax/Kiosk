package com.kiosk.reader.ui

import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.print.PrintManager
import android.text.InputType
import android.view.GestureDetector
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.animation.DecelerateInterpolator
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.lifecycle.lifecycleScope
import com.google.android.material.snackbar.Snackbar
import com.kiosk.reader.R
import com.kiosk.reader.databinding.ActivityPdfViewerBinding
import com.kiosk.reader.pdf.PdfDocument
import com.kiosk.reader.ui.viewer.AnnotationLayer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * PdfViewerActivity – Kiosk Premium PDF viewer.
 *
 * UI Architecture:
 * ─────────────────
 * • Full-screen edge-to-edge layout
 * • Minimal top-bar: Logo | Page pill | Save / Print / More
 * • Trio-Dock System (View / Annotation / Search) at bottom-center
 *   – Physical layer-replacement animation (250 ms ease-out)
 *   – Gesture-driven switching: swipe UP on View dock → Annotation,
 *     swipe DOWN on Annotation → View, swipe LEFT on View → Search,
 *     swipe RIGHT on Search → View
 * • Appearance panel: Light / Dark / Night modes
 * • AnnotationLayer overlay with Pen / Highlight / Eraser / Undo / Redo
 */
class PdfViewerActivity : AppCompatActivity() {

    // ─── View binding ──────────────────────────────────────────────────────
    private lateinit var binding: ActivityPdfViewerBinding

    // ─── Document state ────────────────────────────────────────────────────
    private var currentDocument: PdfDocument? = null
    private var currentUri: Uri? = null

    // ─── Dock state ────────────────────────────────────────────────────────
    private enum class DockMode { VIEW, ANNOTATION, SEARCH }
    private var activeDock = DockMode.VIEW

    // ─── Appearance state ──────────────────────────────────────────────────
    private enum class AppearanceMode { LIGHT, DARK, NIGHT }
    private var appearanceMode = AppearanceMode.DARK
    private var appearancePanelVisible = false

    // ─── Annotation state ──────────────────────────────────────────────────
    private var selectedAnnotationColor: Int = Color.RED
    private var selectedStrokeWidth: Float = 2.5f

    // ─── Dock animation ────────────────────────────────────────────────────
    private val DOCK_ANIM_MS = 260L
    private val DOCK_INTERP  = DecelerateInterpolator(2.2f)

    // ─── Dock vertical position controller ────────────────────────────────
    private lateinit var dockPositionController: DockPositionController
    private var dockNavInsets = 0
    private val DOCK_BOTTOM_MARGIN_DP = 28
    private var dockVelocityTracker: VelocityTracker? = null

    // ─── Gesture detection for dock switching ──────────────────────────────
    private lateinit var dockGestureDetector: GestureDetector
    private var dockGestureStartX = 0f
    private var dockGestureStartY = 0f
    private val SWIPE_VELOCITY_THRESHOLD = 400f
    private val SWIPE_DISTANCE_THRESHOLD = 60f  // dp → px later

    // ─── Zoom percentage update throttle ──────────────────────────────────
    private var lastReportedScale = -1f

    // ══════════════════════════════════════════════════════════════════════
    // Lifecycle
    // ══════════════════════════════════════════════════════════════════════

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Edge-to-edge
        WindowCompat.setDecorFitsSystemWindows(window, false)

        binding = ActivityPdfViewerBinding.inflate(layoutInflater)
        setContentView(binding.root)

        applyWindowInsets()
        setupTopBar()
        setupDockPositionGestures()
        setupDockGestures()
        setupViewDock()
        setupAnnotationDock()
        setupSearchDock()
        setupAppearancePanel()
        setupPdfCallbacks()
        setupErrorButtons()

        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onDestroy() {
        super.onDestroy()
        binding.pdfView.release()
        currentDocument?.close()
        currentDocument = null
        dockVelocityTracker?.recycle()
        dockVelocityTracker = null
    }

    // ══════════════════════════════════════════════════════════════════════
    // Window insets  (edge-to-edge top/bottom padding)
    // ══════════════════════════════════════════════════════════════════════

    private fun applyWindowInsets() {
        ViewCompat.setOnApplyWindowInsetsListener(binding.rootLayout) { v, insets ->
            val sys = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val nav = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
            binding.topBar.updatePadding(top = sys.top)
            dockNavInsets = nav.bottom
            // Init controller now if layout has been measured, else defer..
            if (v.height > 0) initDockPositionController()
            else v.post { initDockPositionController() }
            insets
        }
        // Fallback: post after first layout pass in case insets fire first
        binding.rootLayout.post { initDockPositionController() }
    }

    private fun initDockPositionController() {
        // Guard: only initialise once; height must be > 0
        if (::dockPositionController.isInitialized) return
        if (binding.rootLayout.height == 0) return
        dockPositionController = DockPositionController(binding.dockContainer)
        val bottomMarginPx = (DOCK_BOTTOM_MARGIN_DP * resources.displayMetrics.density).toInt()
        dockPositionController.onLayoutReady(
            parentHeight = binding.rootLayout.height,
            navBarHeight = dockNavInsets,
            bottomMargin = bottomMarginPx
        )
    }

    // ══════════════════════════════════════════════════════════════════════
    // DOCK VERTICAL POSITION – HANDLE DRAG GESTURE
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Attaches a VelocityTracker-backed touch listener to every dock handle.
     * The listener updates [dockPositionController] in real time and snaps on release.
     *
     * Only the drag handle views receive these gestures.  All other dock views
     * continue to function normally (buttons etc.).
     */
    @SuppressLint("ClickableViewAccessibility")
    private fun setupDockPositionGestures() {
        val handles = listOf(
            binding.viewDockHandle,
            binding.annotationDockHandle,
            binding.searchDockHandle
        )

        val listener = View.OnTouchListener { v, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    dockVelocityTracker?.recycle()
                    dockVelocityTracker = VelocityTracker.obtain()
                    addMovementWithRawCoords(event)
                    if (::dockPositionController.isInitialized) {
                        dockPositionController.onDragStart(event.rawY)
                    }
                    v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
                    true
                }

                MotionEvent.ACTION_MOVE -> {
                    addMovementWithRawCoords(event)
                    if (::dockPositionController.isInitialized) {
                        dockPositionController.onDrag(event.rawY)
                    }
                    true
                }

                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    val vy = dockVelocityTracker?.let { vt ->
                        addMovementWithRawCoords(event)
                        vt.computeCurrentVelocity(1000)  // px/s, in raw-coord space
                        val v2 = vt.yVelocity
                        vt.recycle()
                        dockVelocityTracker = null
                        v2
                    } ?: 0f

                    if (::dockPositionController.isInitialized) {
                        dockPositionController.onDragEnd(vy)
                    }
                    v.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                    true
                }

                else -> false
            }
        }

        handles.forEach { handle ->
            handle.setOnTouchListener(listener)
        }
    }

    /**
     * Add a MotionEvent to the VelocityTracker using raw (screen) coordinates.
     *
     * VelocityTracker.addMovement() uses event.x/event.y (view-local).  As the
     * dock container translates, the handle's screen position changes, so
     * event.y drifts without the finger moving — giving wrong velocity.  Offsetting
     * to rawX/rawY before adding ensures the velocity is in screen coordinates,
     * matching the rawY values passed to DockPositionController.onDrag().
     */
    private fun addMovementWithRawCoords(event: MotionEvent) {
        val vt = dockVelocityTracker ?: return
        val dx = event.rawX - event.x
        val dy = event.rawY - event.y
        event.offsetLocation(dx, dy)   // event.x == event.rawX temporarily
        vt.addMovement(event)
        event.offsetLocation(-dx, -dy) // restore to original coordinates
    }

    // ══════════════════════════════════════════════════════════════════════
    // TOP BAR
    // ══════════════════════════════════════════════════════════════════════

    private fun setupTopBar() {
        binding.saveButton.setOnClickListener { saveDocument() }
        binding.printButton.setOnClickListener { printDocument() }
        binding.moreButton.setOnClickListener { showMoreOptions() }
    }

    // ─── Save with cloud-fill confirmation animation ───────────────────────

    private fun saveDocument() {
        // Animate: scale up → scale down, tint to accent then back
        val scaleUpX   = ObjectAnimator.ofFloat(binding.saveButton, "scaleX", 1f, 1.3f)
        val scaleUpY   = ObjectAnimator.ofFloat(binding.saveButton, "scaleY", 1f, 1.3f)
        val scaleDownX = ObjectAnimator.ofFloat(binding.saveButton, "scaleX", 1.3f, 1f)
        val scaleDownY = ObjectAnimator.ofFloat(binding.saveButton, "scaleY", 1.3f, 1f)
        val upSet   = AnimatorSet().apply { playTogether(scaleUpX, scaleUpY); duration = 120 }
        val downSet = AnimatorSet().apply { playTogether(scaleDownX, scaleDownY); duration = 200 }
        AnimatorSet().apply {
            playSequentially(upSet, downSet)
            start()
        }

        // Tint momentarily to accent red then back to normal
        binding.saveButton.setColorFilter(ContextCompat.getColor(this, R.color.accent))
        lifecycleScope.launch {
            delay(600)
            binding.saveButton.clearColorFilter()
        }

        // TODO: Persist annotation layer bitmap to file alongside PDF
        showBriefToast(getString(R.string.document_saved))
    }

    private fun printDocument() {
        if (currentDocument == null) {
            showBriefToast("No document loaded"); return
        }
        val uri = currentUri ?: return
        try {
            val printManager = getSystemService(PRINT_SERVICE) as PrintManager
            printManager.print("Kiosk – PDF", createPrintDocumentAdapter(uri), null)
        } catch (e: Exception) {
            showBriefToast("Printing not available on this device")
        }
    }

    private fun createPrintDocumentAdapter(
        uri: Uri
    ): android.print.PrintDocumentAdapter {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            object : android.print.PrintDocumentAdapter() {
                override fun onLayout(
                    oldAttributes: android.print.PrintAttributes?,
                    newAttributes: android.print.PrintAttributes,
                    cancellationSignal: android.os.CancellationSignal,
                    callback: LayoutResultCallback,
                    bundle: Bundle?
                ) {
                    if (cancellationSignal.isCanceled) {
                        callback.onLayoutCancelled()
                        return
                    }
                    callback.onLayoutFinished(
                        android.print.PrintDocumentInfo.Builder("document.pdf")
                            .setContentType(android.print.PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                            .build(),
                        true
                    )
                }

                override fun onWrite(
                    pages: Array<out android.print.PageRange>?,
                    destination: android.os.ParcelFileDescriptor,
                    cancellationSignal: android.os.CancellationSignal,
                    callback: WriteResultCallback
                ) {
                    try {
                        contentResolver.openInputStream(uri)?.use { input ->
                            destination.fileDescriptor.let { fd ->
                                java.io.FileOutputStream(fd).use { out ->
                                    input.copyTo(out)
                                }
                            }
                        }
                        callback.onWriteFinished(arrayOf(android.print.PageRange.ALL_PAGES))
                    } catch (e: Exception) {
                        callback.onWriteFailed(e.message)
                    }
                }
            }
        } else {
            // Unreachable for minSdk 21 but satisfies the type system
            throw UnsupportedOperationException()
        }
    }

    private fun showMoreOptions() {
        val options = arrayOf("Go to page…", "About")
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setItems(options) { _, which ->
                when (which) {
                    0 -> showGoToPageDialog()
                    1 -> showBriefToast("Kiosk – Premium PDF Reader")
                }
            }
            .show()
    }

    private fun showGoToPageDialog() {
        val count = binding.pdfView.getPageCount()
        val input = android.widget.EditText(this).apply {
            hint = "1 – $count"
            inputType = android.text.InputType.TYPE_CLASS_NUMBER
        }
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Go to page")
            .setView(input)
            .setPositiveButton("Go") { _, _ ->
                val page = input.text.toString().toIntOrNull()
                if (page != null && page in 1..count) {
                    binding.pdfView.goToPage(page - 1)
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    // ══════════════════════════════════════════════════════════════════════
    // DOCK GESTURE DETECTION
    // ══════════════════════════════════════════════════════════════════════

    @SuppressLint("ClickableViewAccessibility")
    private fun setupDockGestures() {
        val swipeThresholdPx = (SWIPE_DISTANCE_THRESHOLD * resources.displayMetrics.density)

        dockGestureDetector = GestureDetector(
            this,
            object : GestureDetector.SimpleOnGestureListener() {
                override fun onDown(e: MotionEvent): Boolean = true

                override fun onFling(
                    e1: MotionEvent?,
                    e2: MotionEvent,
                    velocityX: Float,
                    velocityY: Float
                ): Boolean {
                    val dX = e2.x - (e1?.x ?: e2.x)
                    val dY = e2.y - (e1?.y ?: e2.y)

                    // Determine dominant axis
                    return when {
                        // Vertical fling
                        abs(dY) > abs(dX) -> {
                            when {
                                dY < -swipeThresholdPx &&
                                        abs(velocityY) > SWIPE_VELOCITY_THRESHOLD &&
                                        activeDock == DockMode.VIEW -> {
                                    // Swipe UP on View dock → Annotation dock
                                    binding.dockContainer.performHapticFeedback(
                                        HapticFeedbackConstants.KEYBOARD_TAP
                                    )
                                    switchDock(DockMode.ANNOTATION)
                                    true
                                }
                                dY > swipeThresholdPx &&
                                        abs(velocityY) > SWIPE_VELOCITY_THRESHOLD &&
                                        activeDock == DockMode.ANNOTATION -> {
                                    // Swipe DOWN on Annotation dock → View dock
                                    binding.dockContainer.performHapticFeedback(
                                        HapticFeedbackConstants.KEYBOARD_TAP
                                    )
                                    switchDock(DockMode.VIEW)
                                    true
                                }
                                else -> false
                            }
                        }
                        // Horizontal fling
                        abs(dX) > abs(dY) -> {
                            when {
                                dX < -swipeThresholdPx &&
                                        abs(velocityX) > SWIPE_VELOCITY_THRESHOLD &&
                                        activeDock == DockMode.VIEW -> {
                                    // Swipe LEFT on View dock → Search dock
                                    binding.dockContainer.performHapticFeedback(
                                        HapticFeedbackConstants.KEYBOARD_TAP
                                    )
                                    switchDock(DockMode.SEARCH)
                                    true
                                }
                                dX > swipeThresholdPx &&
                                        abs(velocityX) > SWIPE_VELOCITY_THRESHOLD &&
                                        activeDock == DockMode.SEARCH -> {
                                    // Swipe RIGHT on Search dock → View dock
                                    binding.dockContainer.performHapticFeedback(
                                        HapticFeedbackConstants.KEYBOARD_TAP
                                    )
                                    switchDock(DockMode.VIEW)
                                    true
                                }
                                else -> false
                            }
                        }
                        else -> false
                    }
                }
            }
        )

        // Attach gesture detector to the dock container.
        // IMPORTANT: return the detector's result (not 'false') so the ViewGroup
        // claims ownership of the gesture sequence and receives subsequent MOVE/UP
        // events.  Returning 'false' here meant only ACTION_DOWN was ever processed,
        // so swipe-to-switch-mode was silently broken.
        binding.dockContainer.setOnTouchListener { _, event ->
            dockGestureDetector.onTouchEvent(event)
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // DOCK SWITCHING ANIMATION
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Physically replaces the current dock with [target] using a directional
     * slide animation.  The motion direction follows the design:
     *   VIEW → ANNOTATION : slide up
     *   ANNOTATION → VIEW : slide down
     *   VIEW → SEARCH     : slide left
     *   SEARCH → VIEW     : slide right
     */
    private fun switchDock(target: DockMode) {
        if (target == activeDock) return

        val outDock = dockViewFor(activeDock)
        val inDock  = dockViewFor(target)

        // Cancel any in-flight animations on ALL dock views before starting new
        // ones.  Without this, rapid mode-switching leaves stale translationX/Y
        // values when the interrupted animation's withEndAction fires late.
        binding.viewDock.animate().cancel()
        binding.annotationDock.animate().cancel()
        binding.searchDock.animate().cancel()

        // Reset every dock view to a clean state; the outgoing dock's exit
        // animation will move it off-screen, and the incoming dock's enter
        // animation will bring it in from off-screen below/beside.
        binding.viewDock.apply      { translationX = 0f; translationY = 0f; alpha = if (this == outDock) 1f else 0f }
        binding.annotationDock.apply{ translationX = 0f; translationY = 0f; alpha = if (this == outDock) 1f else 0f }
        binding.searchDock.apply    { translationX = 0f; translationY = 0f; alpha = if (this == outDock) 1f else 0f }

        // Decide direction
        val slideVertical = (activeDock == DockMode.VIEW && target == DockMode.ANNOTATION) ||
                            (activeDock == DockMode.ANNOTATION && target == DockMode.VIEW)
        val slideIn  = if (slideVertical) {
            if (target == DockMode.ANNOTATION) 1f else -1f   // +1 = from below, -1 = from above
        } else {
            if (target == DockMode.SEARCH) 1f else -1f       // +1 = from right, -1 = from left
        }

        // Prime the incoming dock off-screen before making visible.
        // Use a safe fixed offset so the dock starts off-screen regardless of
        // its measured size at the time of the call (which may be 0 if first show).
        val offscreenV = (80 * resources.displayMetrics.density)   // 80 dp for vertical switch
        val offscreenH = resources.displayMetrics.widthPixels.toFloat()  // full width for horizontal

        inDock.apply {
            visibility = View.VISIBLE
            alpha = 0f
            // Annotation enters from below (+Y = down); View returns from above (-Y).
            // Search enters from the right (+X); returns from the left.
            if (slideVertical) translationY = offscreenV * slideIn
            else               translationX = offscreenH * slideIn
        }

        // Animate both docks together
        inDock.animate()
            .apply {
                if (slideVertical) translationY(0f) else translationX(0f)
                alpha(1f)
                duration = DOCK_ANIM_MS
                interpolator = DOCK_INTERP
            }

        outDock.animate()
            .apply {
                // Out-dock exits in the opposite direction the in-dock came from
                if (slideVertical) translationY(offscreenV * slideIn * -1)
                else               translationX(offscreenH * slideIn * -1)
                alpha(0f)
                duration = DOCK_ANIM_MS
                interpolator = DOCK_INTERP
                withEndAction {
                    outDock.visibility = View.GONE
                    outDock.translationX = 0f
                    outDock.translationY = 0f
                    outDock.alpha = 1f
                }
            }

        activeDock = target

        // Annotation mode side-effects
        when (target) {
            DockMode.ANNOTATION -> enterAnnotationMode()
            DockMode.VIEW       -> {
                exitAnnotationMode()
                hideKeyboardIfVisible()
            }
            DockMode.SEARCH     -> {
                binding.searchInput.requestFocus()
                showKeyboard(binding.searchInput)
            }
        }

        // Dismiss appearance panel when switching docks
        if (appearancePanelVisible) dismissAppearancePanel()
    }

    private fun dockViewFor(mode: DockMode): View = when (mode) {
        DockMode.VIEW       -> binding.viewDock
        DockMode.ANNOTATION -> binding.annotationDock
        DockMode.SEARCH     -> binding.searchDock
    }

    // ══════════════════════════════════════════════════════════════════════
    // VIEW DOCK
    // ══════════════════════════════════════════════════════════════════════

    private fun setupViewDock() {
        binding.dockZoomIn.setOnClickListener  { binding.pdfView.zoomIn() }
        binding.dockZoomOut.setOnClickListener { binding.pdfView.zoomOut() }

        binding.dockPrevPage.setOnClickListener {
            val cur = binding.pdfView.getCurrentPage()
            if (cur > 0) binding.pdfView.goToPage(cur - 1)
        }
        binding.dockNextPage.setOnClickListener {
            val cur   = binding.pdfView.getCurrentPage()
            val total = binding.pdfView.getPageCount()
            if (cur < total - 1) binding.pdfView.goToPage(cur + 1)
        }

        binding.dockSearch.setOnClickListener {
            switchDock(DockMode.SEARCH)
        }

        binding.dockAppearance.setOnClickListener { toggleAppearancePanel() }

        binding.dockOptions.setOnClickListener {
            Snackbar.make(binding.root, getString(R.string.hint_swipe_up), Snackbar.LENGTH_SHORT).show()
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // ANNOTATION DOCK
    // ══════════════════════════════════════════════════════════════════════

    private fun setupAnnotationDock() {
        // Tool selection
        binding.toolPen.setOnClickListener       { selectAnnotationTool(AnnotationLayer.Tool.PEN) }
        binding.toolHighlight.setOnClickListener { selectAnnotationTool(AnnotationLayer.Tool.HIGHLIGHT) }
        binding.toolEraser.setOnClickListener    { selectAnnotationTool(AnnotationLayer.Tool.ERASER) }
        binding.toolShapes.setOnClickListener    { selectAnnotationTool(AnnotationLayer.Tool.SHAPES) }

        // Color swatches
        binding.colorRed.setOnClickListener    { selectAnnotationColor(Color.parseColor("#FF4757")) }
        binding.colorBlue.setOnClickListener   { selectAnnotationColor(Color.parseColor("#2979FF")) }
        binding.colorYellow.setOnClickListener { selectAnnotationColor(Color.parseColor("#FFD600")) }

        // Stroke size
        binding.strokeUp.setOnClickListener {
            selectedStrokeWidth = (selectedStrokeWidth + 0.5f).coerceAtMost(10f)
            syncStrokeLabel()
            binding.annotationLayer.currentStrokeWidth = selectedStrokeWidth
        }
        binding.strokeDown.setOnClickListener {
            selectedStrokeWidth = (selectedStrokeWidth - 0.5f).coerceAtLeast(0.5f)
            syncStrokeLabel()
            binding.annotationLayer.currentStrokeWidth = selectedStrokeWidth
        }

        // Undo / Redo
        binding.annotUndo.setOnClickListener {
            binding.annotationLayer.undo()
            updateUndoRedoState()
        }
        binding.annotRedo.setOnClickListener {
            binding.annotationLayer.redo()
            updateUndoRedoState()
        }

        // Done
        binding.annotDone.setOnClickListener {
            switchDock(DockMode.VIEW)
        }
    }

    private fun selectAnnotationTool(tool: AnnotationLayer.Tool) {
        binding.annotationLayer.currentTool = tool
        // Reset all tool button backgrounds, highlight active
        val tools = listOf(binding.toolPen, binding.toolHighlight, binding.toolEraser, binding.toolShapes)
        val active = when (tool) {
            AnnotationLayer.Tool.PEN       -> binding.toolPen
            AnnotationLayer.Tool.HIGHLIGHT -> binding.toolHighlight
            AnnotationLayer.Tool.ERASER    -> binding.toolEraser
            AnnotationLayer.Tool.SHAPES    -> binding.toolShapes
        }
        tools.forEach { btn ->
            btn.background = if (btn == active)
                getDrawable(R.drawable.bg_tool_selected)
            else
                getDrawable(R.drawable.ripple_dock_button)
        }
    }

    private fun selectAnnotationColor(color: Int) {
        selectedAnnotationColor = color
        binding.annotationLayer.currentColor = color
    }

    private fun syncStrokeLabel() {
        binding.strokeSizeLabel.text = when {
            selectedStrokeWidth < 10f -> "%.1f".format(selectedStrokeWidth)
            else                      -> selectedStrokeWidth.roundToInt().toString()
        }
        binding.annotationLayer.currentStrokeWidth = selectedStrokeWidth
    }

    private fun updateUndoRedoState() {
        binding.annotUndo.alpha = if (binding.annotationLayer.canUndo()) 1.0f else 0.35f
        binding.annotRedo.alpha = if (binding.annotationLayer.canRedo()) 1.0f else 0.35f
    }

    private fun enterAnnotationMode() {
        binding.annotationLayer.visibility = View.VISIBLE
        binding.annotationLayer.attachToPdfView(binding.pdfView)
        updateUndoRedoState()
        // Disable PDF view touch so annotation layer gets all events
        binding.pdfView.isEnabled = false
    }

    private fun exitAnnotationMode() {
        binding.annotationLayer.visibility = View.GONE
        binding.pdfView.isEnabled = true
    }

    // ══════════════════════════════════════════════════════════════════════
    // SEARCH DOCK
    // ══════════════════════════════════════════════════════════════════════

    private fun setupSearchDock() {
        binding.searchClose.setOnClickListener {
            switchDock(DockMode.VIEW)
            hideKeyboardIfVisible()
        }

        binding.searchInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH) {
                performSearch(binding.searchInput.text.toString())
                true
            } else false
        }

        binding.searchPrev.setOnClickListener { navigateSearchResult(false) }
        binding.searchNext.setOnClickListener { navigateSearchResult(true) }
    }

    // ─── Search logic ────────────────────────────────────────────────────
    // Note: Android's PdfRenderer does not expose a text-extraction API.
    // The UI is fully implemented and ready for a text-extraction backend.
    // When you integrate a library that supports text search (e.g. PdfBox,
    // PDFium, MuPDF), replace the stub below with real results.

    private var searchResults: List<Int> = emptyList()  // page indices of matches
    private var searchResultIndex = 0

    private fun performSearch(query: String) {
        if (query.isBlank()) {
            binding.searchMatchCount.text = ""
            return
        }
        hideKeyboardIfVisible()

        // TODO: Replace with real text-extraction search when PDF engine supports it.
        // For now, show a graceful "not available" message.
        searchResults = emptyList()
        binding.searchMatchCount.text = getString(R.string.search_no_matches)

        Snackbar.make(
            binding.root,
            "Full-text search requires an indexable PDF library",
            Snackbar.LENGTH_LONG
        ).show()
    }

    private fun navigateSearchResult(forward: Boolean) {
        if (searchResults.isEmpty()) return
        searchResultIndex = if (forward) {
            (searchResultIndex + 1) % searchResults.size
        } else {
            (searchResultIndex - 1 + searchResults.size) % searchResults.size
        }
        binding.pdfView.goToPage(searchResults[searchResultIndex])
        binding.searchMatchCount.text =
            "${searchResultIndex + 1} / ${searchResults.size}"
    }

    // ══════════════════════════════════════════════════════════════════════
    // APPEARANCE PANEL
    // ══════════════════════════════════════════════════════════════════════

    private fun setupAppearancePanel() {
        binding.modeLightBtn.setOnClickListener { applyAppearance(AppearanceMode.LIGHT) }
        binding.modeDarkBtn.setOnClickListener  { applyAppearance(AppearanceMode.DARK) }
        binding.modeNightBtn.setOnClickListener { applyAppearance(AppearanceMode.NIGHT) }
    }

    private fun toggleAppearancePanel() {
        if (appearancePanelVisible) dismissAppearancePanel() else showAppearancePanel()
    }

    private fun showAppearancePanel() {
        binding.appearancePanel.apply {
            alpha = 0f
            visibility = View.VISIBLE
            animate().alpha(1f).translationY(0f).setDuration(180).start()
        }
        appearancePanelVisible = true
    }

    private fun dismissAppearancePanel() {
        binding.appearancePanel.animate()
            .alpha(0f)
            .setDuration(150)
            .withEndAction { binding.appearancePanel.visibility = View.GONE }
            .start()
        appearancePanelVisible = false
    }

    private fun applyAppearance(mode: AppearanceMode) {
        appearanceMode = mode

        val bgColor = when (mode) {
            AppearanceMode.LIGHT -> Color.parseColor("#EBEBEB")
            AppearanceMode.DARK  -> Color.parseColor("#0A0A0A")
            AppearanceMode.NIGHT -> Color.parseColor("#0A0A0A")
        }
        binding.rootLayout.setBackgroundColor(bgColor)
        binding.pdfView.setBackgroundColor(bgColor)
        binding.pdfView.setNightMode(mode == AppearanceMode.NIGHT)

        // Update selected-mode visual indicator
        listOf(
            binding.modeLightLabel to AppearanceMode.LIGHT,
            binding.modeDarkLabel  to AppearanceMode.DARK,
            binding.modeNightLabel to AppearanceMode.NIGHT
        ).forEach { (label, m) ->
            label.alpha = if (m == mode) 1.0f else 0.45f
        }

        dismissAppearancePanel()
    }

    // ══════════════════════════════════════════════════════════════════════
    // PDF VIEW CALLBACKS
    // ══════════════════════════════════════════════════════════════════════

    private fun setupPdfCallbacks() {
        binding.pdfView.onPageChanged = { currentPage, totalPages ->
            runOnUiThread {
                binding.pageIndicator.text =
                    getString(R.string.page_indicator, currentPage + 1, totalPages)
            }
        }

        binding.pdfView.onLoadingStateChanged = { isLoading ->
            runOnUiThread {
                binding.loadingIndicator.visibility =
                    if (isLoading) View.VISIBLE else View.GONE
            }
        }

        binding.pdfView.onError = { message ->
            runOnUiThread { showError(message) }
        }

        // Keep annotation layer in sync during scroll / zoom
        binding.pdfView.onTransformChanged = {
            if (binding.annotationLayer.visibility == View.VISIBLE) {
                binding.annotationLayer.invalidate()
            }
            // Update zoom percentage in dock
            val scalePct = (binding.pdfView.getScale() * 100f).roundToInt()
            if (scalePct != lastReportedScale.roundToInt()) {
                lastReportedScale = scalePct.toFloat()
                runOnUiThread {
                    binding.dockZoomPercent.text = "$scalePct%"
                }
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // INTENT / DOCUMENT LOADING
    // ══════════════════════════════════════════════════════════════════════

    private fun handleIntent(intent: Intent?) {
        val uri = intent?.data
        if (uri == null) { showError(getString(R.string.no_pdf_selected)); return }
        loadPdf(uri)
    }

    private fun loadPdf(uri: Uri) {
        currentUri = uri
        showLoading()
        hideError()

        lifecycleScope.launch {
            try {
                currentDocument?.close()
                currentDocument = null

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
                        withContext(Dispatchers.Main) { showError(getErrorMessage(error)) }
                    }
                )
            } catch (e: Exception) {
                withContext(Dispatchers.Main) { showError(getErrorMessage(e)) }
            }
        }
    }

    private fun updateTitle(uri: Uri) {
        val filename = try {
            uri.lastPathSegment?.substringAfterLast('/') ?: "PDF"
        } catch (_: Exception) { "PDF" }
        // The top bar shows app name + page indicator; the file name lives
        // in the system back-stack title and is available via content resolver.
        // We update the page indicator text with the document name briefly.
        title = filename.removeSuffix(".pdf").removeSuffix(".PDF")
    }

    // ══════════════════════════════════════════════════════════════════════
    // ERROR STATE
    // ══════════════════════════════════════════════════════════════════════

    private fun setupErrorButtons() {
        binding.retryButton.setOnClickListener {
            hideError()
            handleIntent(intent)
        }
        binding.closeButton.setOnClickListener { finish() }
    }

    private fun showLoading() {
        binding.loadingIndicator.visibility = View.VISIBLE
        binding.errorContainer.visibility   = View.GONE
    }

    private fun hideLoading() {
        binding.loadingIndicator.visibility = View.GONE
    }

    private fun showError(message: String) {
        binding.loadingIndicator.visibility = View.GONE
        binding.errorContainer.visibility   = View.VISIBLE
        binding.errorText.text              = message
    }

    private fun hideError() {
        binding.errorContainer.visibility = View.GONE
    }

    private fun getErrorMessage(error: Throwable): String = when {
        error.message?.contains("Permission", ignoreCase = true) == true ->
            getString(R.string.error_permission_denied)
        error.message?.contains("not found", ignoreCase = true) == true ->
            getString(R.string.error_file_not_found)
        error.message?.contains("corrupt", ignoreCase = true) == true ->
            getString(R.string.error_corrupted_pdf)
        else -> getString(R.string.error_loading_pdf) + ": ${error.message}"
    }

    // ══════════════════════════════════════════════════════════════════════
    // KEYBOARD HELPERS
    // ══════════════════════════════════════════════════════════════════════

    private fun showKeyboard(view: View) {
        view.post {
            val imm = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
            imm.showSoftInput(view, InputMethodManager.SHOW_IMPLICIT)
        }
    }

    private fun hideKeyboardIfVisible() {
        val imm = getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager
        val focused = currentFocus ?: binding.root
        imm.hideSoftInputFromWindow(focused.windowToken, 0)
    }

    // ══════════════════════════════════════════════════════════════════════
    // MISC HELPERS
    // ══════════════════════════════════════════════════════════════════════

    private fun showBriefToast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }
}

