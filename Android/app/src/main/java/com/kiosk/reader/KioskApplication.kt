package com.kiosk.reader

import android.app.Application
import android.content.Context
import androidx.appcompat.app.AppCompatDelegate

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
    }

    companion object {
        lateinit var instance: KioskApplication
            private set

        val context: Context
            get() = instance.applicationContext
    }
}
