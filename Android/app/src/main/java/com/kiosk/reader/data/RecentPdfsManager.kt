package com.kiosk.reader.data

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/**
 * Manages a list of recently opened PDFs using SharedPreferences.
 *
 * Each entry stores the file display name, content URI string, and
 * epoch-millisecond timestamp of the last open.  The list is capped at
 * [MAX_RECENTS] entries, with the most-recently-opened at index 0.
 */

data class RecentPdfEntry(
    val name: String,
    val uriString: String,
    val lastOpened: Long
)

class RecentPdfsManager(context: Context) {

    companion object {
        private const val PREFS_NAME = "kiosk_recent_pdfs"
        private const val KEY_RECENTS = "recents"
        private const val MAX_RECENTS = 20
    }

    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** Add or move [uriString] to the top of the recents list. */
    fun addRecent(name: String, uriString: String) {
        val list = getRecents().toMutableList()
        list.removeAll { it.uriString == uriString }
        list.add(0, RecentPdfEntry(name, uriString, System.currentTimeMillis()))
        while (list.size > MAX_RECENTS) list.removeLast()
        save(list)
    }

    /** Return all recent entries, most-recent first. */
    fun getRecents(): List<RecentPdfEntry> {
        val json = prefs.getString(KEY_RECENTS, null) ?: return emptyList()
        return try {
            val array = JSONArray(json)
            (0 until array.length()).map { i ->
                val obj = array.getJSONObject(i)
                RecentPdfEntry(
                    name = obj.getString("name"),
                    uriString = obj.getString("uri"),
                    lastOpened = obj.getLong("ts")
                )
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    /** Remove a single entry by its URI string. */
    fun removeRecent(uriString: String) {
        val list = getRecents().toMutableList()
        list.removeAll { it.uriString == uriString }
        save(list)
    }

    private fun save(list: List<RecentPdfEntry>) {
        val array = JSONArray()
        for (entry in list) {
            array.put(JSONObject().apply {
                put("name", entry.name)
                put("uri", entry.uriString)
                put("ts", entry.lastOpened)
            })
        }
        prefs.edit().putString(KEY_RECENTS, array.toString()).apply()
    }
}
