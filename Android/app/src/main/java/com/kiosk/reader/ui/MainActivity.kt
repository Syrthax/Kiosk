package com.kiosk.reader.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.format.DateUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.kiosk.reader.R
import com.kiosk.reader.data.RecentPdfEntry
import com.kiosk.reader.data.RecentPdfsManager

/**
 * Home screen — file picker, recent PDFs list, and About section.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var recentPdfsManager: RecentPdfsManager

    // Views from layout (using findViewById since layout changed to ScrollView)
    private lateinit var openButton: View
    private lateinit var recentContainer: LinearLayout
    private lateinit var noRecentsLabel: TextView

    private val pickPdfLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        uri?.let { openPdf(it) }
    }

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { isGranted ->
        if (isGranted) openFilePicker()
        else Toast.makeText(this, R.string.error_permission_denied, Toast.LENGTH_LONG).show()
    }

    // ═══════════════════════════════════════════════════════════════
    // Lifecycle
    // ═══════════════════════════════════════════════════════════════

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        recentPdfsManager = RecentPdfsManager(this)

        openButton = findViewById(R.id.openButton)
        recentContainer = findViewById(R.id.recentContainer)
        noRecentsLabel = findViewById(R.id.noRecentsLabel)

        openButton.setOnClickListener { checkPermissionAndOpenPicker() }
    }

    override fun onResume() {
        super.onResume()
        refreshRecentsList()
    }

    // ═══════════════════════════════════════════════════════════════
    // Recent PDFs list
    // ═══════════════════════════════════════════════════════════════

    private fun refreshRecentsList() {
        recentContainer.removeAllViews()
        val recents = recentPdfsManager.getRecents()

        if (recents.isEmpty()) {
            noRecentsLabel.visibility = View.VISIBLE
            return
        }
        noRecentsLabel.visibility = View.GONE

        val dp = resources.displayMetrics.density

        for (entry in recents) {
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(
                    (8 * dp).toInt(), (14 * dp).toInt(),
                    (8 * dp).toInt(), (14 * dp).toInt()
                )
                isClickable = true
                isFocusable = true
                val attrs = intArrayOf(android.R.attr.selectableItemBackground)
                val ta = obtainStyledAttributes(attrs)
                foreground = ta.getDrawable(0)
                ta.recycle()
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
            }

            // PDF icon
            val icon = ImageView(this).apply {
                val size = (30 * dp).toInt()
                layoutParams = LinearLayout.LayoutParams(size, size).also {
                    it.marginEnd = (14 * dp).toInt()
                }
                setImageResource(R.drawable.ic_pdf)
                imageTintList = ContextCompat.getColorStateList(this@MainActivity,
                    R.color.on_surface)
            }
            row.addView(icon)

            // Text column
            val col = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            col.addView(TextView(this).apply {
                text = entry.name
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.on_background))
                textSize = 15f
                maxLines = 1
                ellipsize = android.text.TextUtils.TruncateAt.END
            })
            col.addView(TextView(this).apply {
                text = DateUtils.getRelativeTimeSpanString(
                    entry.lastOpened, System.currentTimeMillis(),
                    DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE
                )
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.on_surface))
                textSize = 12f; alpha = 0.6f
            })
            row.addView(col)

            row.setOnClickListener { openRecentPdf(entry) }

            recentContainer.addView(row)
        }
    }

    private fun openRecentPdf(entry: RecentPdfEntry) {
        val uri = try { Uri.parse(entry.uriString) } catch (_: Exception) { null }
        if (uri == null) {
            Toast.makeText(this, R.string.file_moved_or_deleted, Toast.LENGTH_SHORT).show()
            recentPdfsManager.removeRecent(entry.uriString)
            refreshRecentsList()
            return
        }

        // Check if we hold a persisted read permission for this URI
        val hasPersistedPermission = contentResolver.persistedUriPermissions.any {
            it.uri == uri && it.isReadPermission
        }

        // Verify the file is still accessible via openFileDescriptor (more
        // reliable than openInputStream for content:// URIs)
        try {
            contentResolver.openFileDescriptor(uri, "r")?.close()
        } catch (_: SecurityException) {
            // Permission lost — release stale persisted grant if any
            if (hasPersistedPermission) {
                try {
                    contentResolver.releasePersistableUriPermission(
                        uri, Intent.FLAG_GRANT_READ_URI_PERMISSION
                    )
                } catch (_: Exception) { }
            }
            Toast.makeText(this, R.string.file_moved_or_deleted, Toast.LENGTH_SHORT).show()
            recentPdfsManager.removeRecent(entry.uriString)
            refreshRecentsList()
            return
        } catch (_: Exception) {
            Toast.makeText(this, R.string.file_moved_or_deleted, Toast.LENGTH_SHORT).show()
            recentPdfsManager.removeRecent(entry.uriString)
            refreshRecentsList()
            return
        }

        openPdf(uri)
    }

    // ═══════════════════════════════════════════════════════════════
    // File picking + PDF opening
    // ═══════════════════════════════════════════════════════════════

    private fun checkPermissionAndOpenPicker() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            openFilePicker(); return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            openFilePicker(); return
        }
        if (ContextCompat.checkSelfPermission(this,
                Manifest.permission.READ_EXTERNAL_STORAGE)
            == PackageManager.PERMISSION_GRANTED
        ) {
            openFilePicker()
        } else {
            permissionLauncher.launch(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
    }

    private fun openFilePicker() {
        try {
            pickPdfLauncher.launch(arrayOf("application/pdf"))
        } catch (_: Exception) {
            Toast.makeText(this, R.string.error_loading_pdf, Toast.LENGTH_SHORT).show()
        }
    }

    private fun openPdf(uri: Uri) {
        try {
            contentResolver.takePersistableUriPermission(
                uri, Intent.FLAG_GRANT_READ_URI_PERMISSION
            )
        } catch (_: Exception) { }

        // Record in recents
        val name = resolveFileName(uri)
        recentPdfsManager.addRecent(name, uri.toString())

        val intent = Intent(this, PdfViewerActivity::class.java).apply {
            data = uri
            flags = Intent.FLAG_GRANT_READ_URI_PERMISSION
        }
        startActivity(intent)
    }

    /** Best-effort extraction of the display name from a content URI. */
    private fun resolveFileName(uri: Uri): String {
        try {
            contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                val nameIdx = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (nameIdx >= 0 && cursor.moveToFirst()) {
                    return cursor.getString(nameIdx) ?: "Untitled.pdf"
                }
            }
        } catch (_: Exception) { }
        return uri.lastPathSegment?.substringAfterLast('/') ?: "Untitled.pdf"
    }
}
