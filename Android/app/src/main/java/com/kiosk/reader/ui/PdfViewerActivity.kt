package com.kiosk.reader.ui

import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.annotation.SuppressLint
import android.content.Intent
import android.database.Cursor
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.print.PrintManager
import android.provider.OpenableColumns
import android.text.InputType
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
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
import com.kiosk.reader.data.RecentPdfsManager
import com.kiosk.reader.databinding.ActivityPdfViewerBinding
import com.kiosk.reader.pdf.PdfAnnotationWriter
import com.kiosk.reader.pdf.PdfDocument
import com.kiosk.reader.ui.viewer.AnnotationLayer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
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

    // ─── Trio Dock switcher (gesture-driven state machine) ───────────────
    private lateinit var trioDockSwitcher: TrioDockSwitcher

    // ─── Dock vertical position controller ────────────────────────────────
    private lateinit var dockPositionController: DockPositionController
    private var dockNavInsets = 0
    private val DOCK_BOTTOM_MARGIN_DP = 28

    // ─── Zoom percentage update throttle ──────────────────────────────────
    private var lastReportedScale = -1f

    // ─── Auto-hide header / dock on fast scroll ──────────────────────────
    private var uiHidden = false
    private val uiHandler = Handler(Looper.getMainLooper())
    private val showUIRunnable = Runnable { showChromeUI() }
    private companion object { const val SCROLL_HIDE_THRESHOLD = 18f }

    // ─── Recent PDFs tracker ─────────────────────────────────────────────
    private lateinit var recentPdfsManager: RecentPdfsManager

    // ─── SAF launcher for saving annotated PDF ──────────────────────────
    private val saveAnnotatedPdfLauncher = registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/pdf")
    ) { uri -> uri?.let { writeAnnotatedPdf(it) } }

    // ══════════════════════════════════════════════════════════════════════
    // Lifecycle
    // ══════════════════════════════════════════════════════════════════════

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Edge-to-edge
        WindowCompat.setDecorFitsSystemWindows(window, false)

        binding = ActivityPdfViewerBinding.inflate(layoutInflater)
        setContentView(binding.root)

        recentPdfsManager = RecentPdfsManager(this)

        applyWindowInsets()
        setupTopBar()
        setupTrioDockSwitcher()
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
        uiHandler.removeCallbacks(showUIRunnable)
        binding.pdfView.release()
        currentDocument?.close()
        currentDocument = null
        if (::trioDockSwitcher.isInitialized) trioDockSwitcher.release()
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
     * Initialises the [TrioDockSwitcher] state machine and wires its touch
     * listeners to every dock handle and the dock container body.
     *
     * Dock order:  0 = View  ·  1 = Annotation  ·  2 = Search
     *
     * Handle drags and body drags both drive the same switcher:
     *   • Vertical gesture → drag-follow + threshold-based dock switch
     *   • Horizontal gesture → fling detection for VIEW ↔ SEARCH shortcut
     */
    @SuppressLint("ClickableViewAccessibility")
    private fun setupTrioDockSwitcher() {
        trioDockSwitcher = TrioDockSwitcher(
            docks = listOf(binding.viewDock, binding.annotationDock, binding.searchDock),
            onDockWillChange = { _, _ -> },
            onDockDidChange  = { from, to -> onDockTransitionComplete(from, to) }
        )

        // Horizontal fling: VIEW ↔ SEARCH shortcut
        trioDockSwitcher.onHorizontalFling = { isLeftFling ->
            when {
                isLeftFling && activeDock == DockMode.VIEW -> {
                    binding.dockContainer.performHapticFeedback(
                        HapticFeedbackConstants.KEYBOARD_TAP
                    )
                    switchDock(DockMode.SEARCH)
                }
                !isLeftFling && activeDock == DockMode.SEARCH -> {
                    binding.dockContainer.performHapticFeedback(
                        HapticFeedbackConstants.KEYBOARD_TAP
                    )
                    switchDock(DockMode.VIEW)
                }
            }
        }

        // Touch listener shared by all handles
        val handleListener = View.OnTouchListener { v, event ->
            if (event.actionMasked == MotionEvent.ACTION_DOWN) {
                v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
            }
            trioDockSwitcher.onTouchEvent(event)
        }
        binding.viewDockHandle.setOnTouchListener(handleListener)
        binding.annotationDockHandle.setOnTouchListener(handleListener)
        binding.searchDockHandle.setOnTouchListener(handleListener)

        // Dock body (empty space between buttons) also drives the switcher
        binding.dockContainer.setOnTouchListener { _, event ->
            trioDockSwitcher.onTouchEvent(event)
        }
    }

    /**
     * Called by [TrioDockSwitcher] when a dock transition animation completes.
     * Handles mode side-effects: annotation layer, keyboard, appearance panel.
     */
    private fun onDockTransitionComplete(fromIndex: Int, toIndex: Int) {
        val fromMode = dockModeForIndex(fromIndex)
        val toMode   = dockModeForIndex(toIndex)
        activeDock = toMode

        // Exit previous mode
        if (fromMode == DockMode.ANNOTATION && toMode != DockMode.ANNOTATION) {
            exitAnnotationMode()
        }

        // Enter new mode
        when (toMode) {
            DockMode.ANNOTATION -> enterAnnotationMode()
            DockMode.VIEW       -> hideKeyboardIfVisible()
            DockMode.SEARCH     -> {
                binding.searchInput.requestFocus()
                showKeyboard(binding.searchInput)
            }
        }

        if (appearancePanelVisible) dismissAppearancePanel()
    }

    private fun dockModeForIndex(index: Int): DockMode = when (index) {
        0    -> DockMode.VIEW
        1    -> DockMode.ANNOTATION
        2    -> DockMode.SEARCH
        else -> DockMode.VIEW
    }

    // ══════════════════════════════════════════════════════════════════════
    // TOP BAR
    // ══════════════════════════════════════════════════════════════════════

    private fun setupTopBar() {
        binding.saveButton.setOnClickListener { saveDocument() }
        binding.printButton.setOnClickListener { printDocument() }
        binding.moreButton.setOnClickListener { showMoreOptions() }

        // Problem 8: Clicking logo navigates back to home
        binding.appLogo.setOnClickListener {
            val intent = Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
            startActivity(intent)
        }
        binding.appName.setOnClickListener { binding.appLogo.performClick() }
    }

    // ─── Save with real PDF annotation writing ──────────────────────────

    private fun saveDocument() {
        // Animate save button
        val scaleUpX   = ObjectAnimator.ofFloat(binding.saveButton, "scaleX", 1f, 1.3f)
        val scaleUpY   = ObjectAnimator.ofFloat(binding.saveButton, "scaleY", 1f, 1.3f)
        val scaleDownX = ObjectAnimator.ofFloat(binding.saveButton, "scaleX", 1.3f, 1f)
        val scaleDownY = ObjectAnimator.ofFloat(binding.saveButton, "scaleY", 1.3f, 1f)
        val upSet   = AnimatorSet().apply { playTogether(scaleUpX, scaleUpY); duration = 120 }
        val downSet = AnimatorSet().apply { playTogether(scaleDownX, scaleDownY); duration = 200 }
        AnimatorSet().apply { playSequentially(upSet, downSet); start() }

        binding.saveButton.setColorFilter(ContextCompat.getColor(this, R.color.accent))
        lifecycleScope.launch {
            delay(600)
            binding.saveButton.clearColorFilter()
        }

        // Check if there are annotations to save
        val strokes = binding.annotationLayer.getStrokes()
        if (strokes.isEmpty()) {
            showBriefToast(getString(R.string.no_annotations))
            return
        }

        // Launch SAF file picker to choose output location
        val suggestedName = (title?.toString() ?: "document") + "_annotated.pdf"
        saveAnnotatedPdfLauncher.launch(suggestedName)
    }

    private fun writeAnnotatedPdf(outputUri: Uri) {
        val sourceUri = currentUri ?: return
        val strokes = binding.annotationLayer.getStrokes()
        if (strokes.isEmpty()) return

        lifecycleScope.launch {
            val success = withContext(Dispatchers.IO) {
                try {
                    val tempOut = File(cacheDir, "annot_out_${System.currentTimeMillis()}.pdf")
                    val result = PdfAnnotationWriter.saveAnnotations(
                        this@PdfViewerActivity, sourceUri, strokes, tempOut
                    )
                    if (result) {
                        // Copy temp file to the SAF URI
                        contentResolver.openOutputStream(outputUri)?.use { out ->
                            tempOut.inputStream().use { inp -> inp.copyTo(out) }
                        }
                        tempOut.delete()
                        true
                    } else false
                } catch (e: Exception) {
                    e.printStackTrace()
                    false
                }
            }
            showBriefToast(getString(
                if (success) R.string.save_success else R.string.save_failed
            ))
        }
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
        val options = arrayOf("Go to page\u2026", "PDF Info", "About")
        AlertDialog.Builder(this)
            .setItems(options) { _, which ->
                when (which) {
                    0 -> showGoToPageDialog()
                    1 -> showPdfInfoDialog()
                    2 -> showBriefToast("Kiosk \u2013 Premium PDF Reader")
                }
            }
            .show()
    }

    private fun showGoToPageDialog() {
        val count = binding.pdfView.getPageCount()
        val input = EditText(this).apply {
            hint = "1 \u2013 $count"
            inputType = InputType.TYPE_CLASS_NUMBER
        }
        AlertDialog.Builder(this)
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

    // ─── PDF Info Dialog (Problem 7) ───────────────────────────────────

    private fun showPdfInfoDialog() {
        val uri = currentUri ?: return
        val pageCount = binding.pdfView.getPageCount()

        // Query file metadata via ContentResolver
        var displayName = title?.toString() ?: "Unknown"
        var fileSize = "Unknown"
        var location = uri.toString()

        try {
            contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (nameIdx >= 0) displayName = cursor.getString(nameIdx) ?: displayName
                    val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (sizeIdx >= 0) {
                        val bytes = cursor.getLong(sizeIdx)
                        fileSize = formatFileSize(bytes)
                    }
                }
            }
        } catch (_: Exception) { }

        // Try to get a cleaner path from the URI
        uri.path?.let { p ->
            if (p.isNotBlank()) location = p
        }

        val message = buildString {
            append(getString(R.string.pdf_name_label)).append(": ").append(displayName).append("\n\n")
            append(getString(R.string.pdf_size_label)).append(": ").append(fileSize).append("\n\n")
            append(getString(R.string.pdf_location_label)).append(": ").append(location).append("\n\n")
            append(getString(R.string.pdf_pages_label)).append(": ").append(pageCount)
        }

        AlertDialog.Builder(this)
            .setTitle(getString(R.string.pdf_info_title))
            .setMessage(message)
            .setPositiveButton("OK", null)
            .show()
    }

    private fun formatFileSize(bytes: Long): String = when {
        bytes < 1024        -> "$bytes B"
        bytes < 1024 * 1024 -> "%.1f KB".format(bytes / 1024f)
        else                -> "%.1f MB".format(bytes / (1024f * 1024f))
    }

    // ══════════════════════════════════════════════════════════════════════
    // DOCK SWITCHING  (delegated to TrioDockSwitcher state machine)
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Programmatic dock switch — delegates to [TrioDockSwitcher.animateToIndex]
     * which drives the spring-animated card-style transition.  Side-effects
     * (annotation layer, keyboard, appearance panel) fire via the
     * [onDockTransitionComplete] callback when the animation settles.
     */
    private fun switchDock(target: DockMode) {
        if (target == activeDock) return
        if (!::trioDockSwitcher.isInitialized) return
        val index = when (target) {
            DockMode.VIEW       -> 0
            DockMode.ANNOTATION -> 1
            DockMode.SEARCH     -> 2
        }
        trioDockSwitcher.animateToIndex(index)
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

        // Full color picker (Problem 6)
        binding.colorPicker.setOnClickListener {
            ColorPickerDialog(this, selectedAnnotationColor) { color ->
                selectAnnotationColor(color)
            }.show()
        }

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

    /**
     * Enter annotation mode.
     *
     * The annotation layer is ALWAYS mounted and visible so strokes persist
     * across dock switches.  Entering annotation mode enables its touch
     * handling and disables the PDF view's single-finger gestures.
     * Pinch zoom still works via AnnotationLayer forwarding.
     */
    private fun enterAnnotationMode() {
        ensureAnnotationLayerAttached()
        binding.annotationLayer.isClickable  = true
        binding.annotationLayer.isFocusable  = true
        updateUndoRedoState()
        binding.pdfView.allowSingleFingerGestures = false
        // Don't set pdfView.isEnabled = false — we want pinch zoom to work
    }

    /**
     * Exit annotation mode.
     *
     * The annotation layer stays visible (strokes remain on screen) but stops
     * intercepting touch events so the PDF view regains scroll/zoom control.
     * Annotations are NEVER cleared — they persist until explicitly deleted.
     */
    private fun exitAnnotationMode() {
        binding.annotationLayer.isClickable  = false
        binding.annotationLayer.isFocusable  = false
        binding.pdfView.allowSingleFingerGestures = true
    }

    /**
     * Lazily wires the annotation layer to the PDF view on first use.
     * Called once from [enterAnnotationMode]; safe to call multiple times.
     */
    private var annotationLayerAttached = false
    private fun ensureAnnotationLayerAttached() {
        if (!annotationLayerAttached) {
            binding.annotationLayer.visibility = View.VISIBLE
            binding.annotationLayer.attachToPdfView(binding.pdfView)
            // Start non-interactive — enterAnnotationMode() enables touch
            binding.annotationLayer.isClickable = false
            binding.annotationLayer.isFocusable = false
            annotationLayerAttached = true
        }
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
            // Auto-hide: reset idle timer while any transform changes (includes fling)
            if (uiHidden) {
                uiHandler.removeCallbacks(showUIRunnable)
                uiHandler.postDelayed(showUIRunnable, 2000)
            }
        }

        // Problem 4: Scroll direction → auto-hide / show header + dock
        binding.pdfView.onScrollDelta = { deltaY ->
            handleScrollAutoHide(deltaY)
        }
    }

    // ─── Auto-hide header & dock (Problem 4) ──────────────────────────────

    private fun handleScrollAutoHide(deltaY: Float) {
        uiHandler.removeCallbacks(showUIRunnable)
        if (deltaY > SCROLL_HIDE_THRESHOLD) {
            hideChromeUI()
        } else if (deltaY < -SCROLL_HIDE_THRESHOLD) {
            showChromeUI()
            return          // don't start hide-timer when user scrolls up
        }
        if (uiHidden) {
            uiHandler.postDelayed(showUIRunnable, 2000)
        }
    }

    private fun hideChromeUI() {
        if (uiHidden) return
        uiHidden = true
        // Slide top bar up out of view
        binding.topBar.animate()
            .translationY(-binding.topBar.height.toFloat())
            .setDuration(250)
            .start()
        // Slide dock below screen
        binding.dockContainer.animate()
            .translationY(binding.dockContainer.height.toFloat() + 200f)
            .setDuration(250)
            .start()
    }

    private fun showChromeUI() {
        if (!uiHidden) return
        uiHidden = false
        binding.topBar.animate()
            .translationY(0f)
            .setDuration(200)
            .start()
        // Restore dock to its DockPositionController state
        if (::dockPositionController.isInitialized) {
            dockPositionController.snapTo(dockPositionController.currentState, animate = true)
        } else {
            binding.dockContainer.animate()
                .translationY(0f)
                .setDuration(200)
                .start()
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // INTENT / DOCUMENT LOADING
    // ══════════════════════════════════════════════════════════════════════

    private fun handleIntent(intent: Intent?) {
        val uri = intent?.data
            ?: intent?.clipData?.getItemAt(0)?.uri
        if (uri == null) { showError(getString(R.string.no_pdf_selected)); return }

        // Persist read permission so the document survives process death
        try {
            contentResolver.takePersistableUriPermission(
                uri, Intent.FLAG_GRANT_READ_URI_PERMISSION
            )
        } catch (_: Exception) { /* not all providers support persistable grants */ }

        // Record in recent files
        val name = resolveFileName(uri)
        recentPdfsManager.addRecent(name, uri.toString())

        loadPdf(uri)
    }

    /** Best-effort extraction of the display name from a content URI. */
    private fun resolveFileName(uri: Uri): String {
        try {
            contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (nameIdx >= 0 && cursor.moveToFirst()) {
                    return cursor.getString(nameIdx) ?: "Untitled.pdf"
                }
            }
        } catch (_: Exception) { }
        return uri.lastPathSegment?.substringAfterLast('/') ?: "Untitled.pdf"
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

