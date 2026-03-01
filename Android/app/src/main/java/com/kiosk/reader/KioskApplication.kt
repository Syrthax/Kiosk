package com.kiosk.reader

import android.app.Application
import android.content.Context
import androidx.appcompat.app.AppCompatDelegate
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader

/**
 * Kiosk Application class
 * Handles app-wide initialization and configuration
 */
class KioskApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        instance = this

        // Follow system dark mode setting
        AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM)

        // Initialise PDFBox resource loader (required for annotation saving)
        PDFBoxResourceLoader.init(this)
    }

    companion object {
        lateinit var instance: KioskApplication
            private set

        val context: Context
            get() = instance.applicationContext
    }
}
