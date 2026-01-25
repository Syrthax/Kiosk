package com.kiosk.reader.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.kiosk.reader.R
import com.kiosk.reader.databinding.ActivityMainBinding

/**
 * Main Activity - Home screen with file picker
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    private val pickPdfLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        uri?.let { openPdf(it) }
    }

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { isGranted ->
        if (isGranted) {
            openFilePicker()
        } else {
            Toast.makeText(this, R.string.error_permission_denied, Toast.LENGTH_LONG).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setupUI()
    }

    private fun setupUI() {
        binding.openButton.setOnClickListener {
            checkPermissionAndOpenPicker()
        }

        binding.welcomeContainer.setOnClickListener {
            checkPermissionAndOpenPicker()
        }
    }

    private fun checkPermissionAndOpenPicker() {
        // For Android 13+, no storage permission needed for SAF
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            openFilePicker()
            return
        }

        // For Android 10-12, SAF doesn't require permission
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            openFilePicker()
            return
        }

        // For older versions, check read permission
        if (ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.READ_EXTERNAL_STORAGE
            ) == PackageManager.PERMISSION_GRANTED
        ) {
            openFilePicker()
        } else {
            permissionLauncher.launch(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
    }

    private fun openFilePicker() {
        try {
            pickPdfLauncher.launch(arrayOf("application/pdf"))
        } catch (e: Exception) {
            Toast.makeText(this, R.string.error_loading_pdf, Toast.LENGTH_SHORT).show()
        }
    }

    private fun openPdf(uri: Uri) {
        // Take persistent permission if possible
        try {
            val takeFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION
            contentResolver.takePersistableUriPermission(uri, takeFlags)
        } catch (e: Exception) {
            // Permission may not be persistable, that's okay
        }

        val intent = Intent(this, PdfViewerActivity::class.java).apply {
            data = uri
            flags = Intent.FLAG_GRANT_READ_URI_PERMISSION
        }
        startActivity(intent)
    }
}
