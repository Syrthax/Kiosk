# Add project specific ProGuard rules here.

# ── PDF rendering ────────────────────────────────────────────────────
-keep class android.graphics.pdf.** { *; }

# ── PDFBox Android ───────────────────────────────────────────────────
# PDFBox's JPXFilter optionally references Gemalto JPEG2000 classes.
# These are not bundled (JPEG2000 is unused for our annotation workflow)
# so we tell R8 to silently ignore the missing references.
-dontwarn com.gemalto.jp2.**
-dontwarn org.apache.pdfbox.filter.JPXFilter

# Keep all PDFBox classes — they are loaded reflectively at runtime.
-keep class com.tom_roush.pdfbox.** { *; }
-keep class org.apache.pdfbox.** { *; }

# ── Kotlin coroutines ────────────────────────────────────────────────
-keepnames class kotlinx.coroutines.internal.MainDispatcherFactory {}
-keepnames class kotlinx.coroutines.CoroutineExceptionHandler {}

# ── Data classes ─────────────────────────────────────────────────────
-keepclassmembers class * {
    @com.google.gson.annotations.SerializedName <fields>;
}
