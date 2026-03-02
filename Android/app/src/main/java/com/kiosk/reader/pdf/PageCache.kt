package com.kiosk.reader.pdf

import android.graphics.Bitmap
import android.util.LruCache

/**
 * LRU cache for PDF page bitmaps.
 * 
 * DESIGN: One bitmap per page (not per scale level).
 * Pages are rendered at a base scale (fitScale * 2), then displayed
 * via canvas Matrix transforms at any zoom level.
 * 
 * This ensures:
 * - Smooth zoom (no re-render during pinch gesture)
 * - Memory efficiency (one bitmap per page)
 * - Quality maintained at reasonable zoom levels
 */
class PageCache(maxSizeMb: Int = 128) {

    /**
     * Entry stored for each cached page.
     */
    data class CacheEntry(
        val bitmap: Bitmap,
        val renderedScale: Float
    )

    private val cache: LruCache<Int, CacheEntry>

    init {
        val maxBytes = maxSizeMb * 1024 * 1024
        cache = object : LruCache<Int, CacheEntry>(maxBytes) {
            override fun sizeOf(key: Int, entry: CacheEntry): Int {
                return entry.bitmap.allocationByteCount
            }

            override fun entryRemoved(
                evicted: Boolean,
                key: Int,
                oldValue: CacheEntry,
                newValue: CacheEntry?
            ) {
                // Recycle old bitmap on both eviction AND replacement,
                // as long as the bitmap object is different from the new one.
                // LruCache guarantees the old entry is already removed from the
                // map when this callback fires, so onDraw will never read it.
                if (!oldValue.bitmap.isRecycled &&
                    (newValue == null || oldValue.bitmap !== newValue.bitmap)
                ) {
                    oldValue.bitmap.recycle()
                }
            }
        }
    }

    /**
     * Store a rendered page bitmap.
     * Old bitmap recycling is handled by LruCache.entryRemoved() —
     * never recycle manually here to avoid a window where onDraw
     * reads a recycled bitmap (the blank-page-during-zoom bug).
     */
    fun put(pageIndex: Int, renderedScale: Float, bitmap: Bitmap) {
        cache.put(pageIndex, CacheEntry(bitmap, renderedScale))
    }

    /**
     * Get cached bitmap for page (if available).
     */
    fun getBestAvailable(pageIndex: Int): CacheEntry? {
        return cache.get(pageIndex)
    }

    /**
     * Get bitmap for page (legacy API for PdfPageView compatibility).
     * The scale parameter is ignored as we cache one bitmap per page.
     */
    fun get(pageIndex: Int, @Suppress("UNUSED_PARAMETER") scale: Float): Bitmap? {
        return cache.get(pageIndex)?.bitmap
    }

    /**
     * Check if a page is cached.
     */
    fun contains(pageIndex: Int): Boolean {
        return cache.get(pageIndex) != null
    }

    /**
     * Clear all cached bitmaps.
     */
    fun clear() {
        cache.evictAll()
    }

    /**
     * Remove a specific page from cache.
     */
    fun remove(pageIndex: Int) {
        val entry = cache.remove(pageIndex)
        if (entry != null && !entry.bitmap.isRecycled) {
            entry.bitmap.recycle()
        }
    }

    /**
     * Get current cache size in bytes.
     */
    fun size(): Int = cache.size()

    /**
     * Get max cache size in bytes.
     */
    fun maxSize(): Int = cache.maxSize()

    /**
     * Check if page needs re-render for quality.
     * Only returns true if viewing at much higher zoom than cached render.
     */
    fun needsRerender(pageIndex: Int, targetScale: Float, threshold: Float = 1.5f): Boolean {
        val entry = cache.get(pageIndex) ?: return true
        return targetScale > entry.renderedScale * threshold
    }
}
