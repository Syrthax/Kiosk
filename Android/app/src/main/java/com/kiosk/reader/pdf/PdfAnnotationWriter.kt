package com.kiosk.reader.pdf

import android.content.Context
import android.graphics.Color
import android.net.Uri
import com.kiosk.reader.ui.viewer.AnnotationLayer
import com.tom_roush.pdfbox.cos.COSArray
import com.tom_roush.pdfbox.cos.COSDictionary
import com.tom_roush.pdfbox.cos.COSFloat
import com.tom_roush.pdfbox.cos.COSName
import com.tom_roush.pdfbox.pdmodel.PDDocument
import java.io.File
import java.io.FileOutputStream

/**
 * Writes annotation strokes to a real PDF file using pdfbox-android.
 *
 * Each non-erase stroke becomes a standard `/Type /Annot /Subtype /Ink`
 * object with correct PDF-coordinate-space geometry, so the annotations
 * are visible in Adobe Acrobat, Chrome, Google Drive, etc.
 *
 * Coordinate mapping
 * ──────────────────
 * App stores page-local coordinates with origin at **top-left** (y↓).
 * PDF spec defines origin at **bottom-left** (y↑).
 *   ⇒  pdf_y = pageHeight − app_y
 */
class PdfAnnotationWriter {

    companion object {

        /**
         * Save all [strokes] into the PDF referenced by [sourceUri] and
         * write the result to [outputFile].
         *
         * @return `true` on success.
         */
        fun saveAnnotations(
            context: Context,
            sourceUri: Uri,
            strokes: List<AnnotationLayer.AnnotationStroke>,
            outputFile: File
        ): Boolean {
            var document: PDDocument? = null
            val tempInput = File(context.cacheDir, "annot_in_${System.currentTimeMillis()}.pdf")
            return try {
                // Copy source URI into a local temp file for PDDocument.load()
                context.contentResolver.openInputStream(sourceUri)?.use { inp ->
                    FileOutputStream(tempInput).use { out -> inp.copyTo(out) }
                } ?: return false

                document = PDDocument.load(tempInput)

                // Group non-erase strokes by page index
                val byPage = strokes
                    .filter { !it.isErase }
                    .groupBy { it.pageIndex }

                for ((pageIdx, pageStrokes) in byPage) {
                    if (pageIdx >= document.numberOfPages) continue
                    val page = document.getPage(pageIdx)
                    val pageDict = page.cosObject          // COSDictionary
                    val pageHeight = page.mediaBox.height

                    // Get or create the page's /Annots array
                    var annots = pageDict.getDictionaryObject(COSName.ANNOTS) as? COSArray
                    if (annots == null) {
                        annots = COSArray()
                        pageDict.setItem(COSName.ANNOTS, annots)
                    }

                    for (stroke in pageStrokes) {
                        val ad = buildInkAnnotDict(stroke, pageHeight) ?: continue
                        annots.add(ad)
                    }
                }

                document.save(outputFile)
                document.close(); document = null
                tempInput.delete()
                true
            } catch (e: Exception) {
                e.printStackTrace()
                document?.close()
                tempInput.delete()
                false
            }
        }

        // ────────────────────────────────────────────────────────

        private fun buildInkAnnotDict(
            stroke: AnnotationLayer.AnnotationStroke,
            pageHeight: Float
        ): COSDictionary? {
            if (stroke.points.size < 2) return null

            // Convert app coords (top-left origin) → PDF coords (bottom-left)
            val pdfPts = stroke.points.map { Pair(it.x, pageHeight - it.y) }

            // Bounding rect
            var x1 = Float.MAX_VALUE; var y1 = Float.MAX_VALUE
            var x2 = Float.MIN_VALUE; var y2 = Float.MIN_VALUE
            for ((px, py) in pdfPts) {
                if (px < x1) x1 = px;  if (py < y1) y1 = py
                if (px > x2) x2 = px;  if (py > y2) y2 = py
            }
            val m = stroke.strokeWidth * 2f

            val ad = COSDictionary()
            ad.setName(COSName.TYPE, "Annot")
            ad.setName(COSName.SUBTYPE, "Ink")

            // /Rect [llx lly urx ury]
            val rect = COSArray()
            rect.add(COSFloat(x1 - m)); rect.add(COSFloat(y1 - m))
            rect.add(COSFloat(x2 + m)); rect.add(COSFloat(y2 + m))
            ad.setItem(COSName.RECT, rect)

            // /C [r g b] — normalised 0..1
            val cArr = COSArray()
            cArr.add(COSFloat(Color.red(stroke.color) / 255f))
            cArr.add(COSFloat(Color.green(stroke.color) / 255f))
            cArr.add(COSFloat(Color.blue(stroke.color) / 255f))
            ad.setItem(COSName.C, cArr)

            // /InkList [[x₁ y₁ x₂ y₂ …]]
            val pts = COSArray()
            for ((px, py) in pdfPts) { pts.add(COSFloat(px)); pts.add(COSFloat(py)) }
            val inkList = COSArray(); inkList.add(pts)
            ad.setItem(COSName.getPDFName("InkList"), inkList)

            // /BS << /W strokeWidth >>
            val bs = COSDictionary()
            bs.setItem(COSName.getPDFName("W"), COSFloat(stroke.strokeWidth))
            ad.setItem(COSName.BS, bs)

            // /F 4  (Print flag → visible when printing)
            ad.setInt(COSName.F, 4)

            // Highlight strokes get reduced opacity
            if (stroke.isHighlight) {
                ad.setItem(COSName.getPDFName("CA"), COSFloat(0.35f))
            }

            return ad
        }
    }
}
