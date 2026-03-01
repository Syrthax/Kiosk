package com.kiosk.reader.ui

import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView

/**
 * Full HSV colour picker presented as a bottom-sheet–style dialog.
 *
 * Layout (all programmatic – no XML required):
 *   • Colour preview swatch  (56 dp, rounded)
 *   • Hex label               (#RRGGBB)
 *   • Hue seek bar            (0 – 360)
 *   • Saturation seek bar     (0 – 100)
 *   • Brightness seek bar     (0 – 100)
 *   • Cancel / Apply buttons
 */
class ColorPickerDialog(
    context: Context,
    private val initialColor: Int,
    private val onColorSelected: (Int) -> Unit
) : Dialog(context) {

    private var hue = 0f
    private var sat = 1f
    private var value = 1f

    private lateinit var preview: View
    private lateinit var hexLabel: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val hsv = FloatArray(3)
        Color.colorToHSV(initialColor, hsv)
        hue = hsv[0]; sat = hsv[1]; value = hsv[2]

        val dp = context.resources.displayMetrics.density
        val pad = (24 * dp).toInt()

        val root = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(Color.parseColor("#1C1C1E"))
        }

        // ── Title ──
        root.addView(TextView(context).apply {
            text = "Pick Colour"
            setTextColor(Color.WHITE)
            textSize = 18f
            gravity = Gravity.CENTER
            layoutParams = lp(bot = 16)
        })

        // ── Colour preview swatch ──
        preview = View(context).apply {
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, (56 * dp).toInt()
            ).also { it.bottomMargin = (12 * dp).toInt() }
            background = GradientDrawable().apply {
                cornerRadius = 14 * dp
                setColor(currentColor())
            }
        }
        root.addView(preview)

        // ── Hex label ──
        hexLabel = TextView(context).apply {
            setTextColor(Color.WHITE); textSize = 14f; gravity = Gravity.CENTER
            text = hexString()
            layoutParams = lp(bot = 18)
        }
        root.addView(hexLabel)

        // ── Sliders ──
        root.addView(sliderLabel("Hue"))
        root.addView(seekBar(360, hue.toInt()) { hue = it.toFloat(); refresh() })

        root.addView(sliderLabel("Saturation"))
        root.addView(seekBar(100, (sat * 100).toInt()) { sat = it / 100f; refresh() })

        root.addView(sliderLabel("Brightness"))
        root.addView(seekBar(100, (value * 100).toInt()) { value = it / 100f; refresh() })

        // ── Buttons ──
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.END
            layoutParams = lp(top = 22)
        }
        row.addView(button("Cancel", Color.parseColor("#AAAAAA")) { dismiss() })
        row.addView(button("Apply", Color.parseColor("#E53935")) {
            onColorSelected(currentColor()); dismiss()
        })
        root.addView(row)

        setContentView(root)
        window?.setLayout((300 * dp).toInt(), LinearLayout.LayoutParams.WRAP_CONTENT)
        window?.setBackgroundDrawableResource(android.R.color.transparent)
    }

    // ── Helpers ──────────────────────────────────────────────────

    private fun currentColor() = Color.HSVToColor(floatArrayOf(hue, sat, value))

    private fun hexString(): String {
        val c = currentColor()
        return String.format("#%02X%02X%02X", Color.red(c), Color.green(c), Color.blue(c))
    }

    private fun refresh() {
        (preview.background as? GradientDrawable)?.setColor(currentColor())
        hexLabel.text = hexString()
    }

    private fun dp(v: Int) = (v * context.resources.displayMetrics.density).toInt()

    private fun lp(
        top: Int = 0, bot: Int = 0
    ) = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
    ).also { it.topMargin = dp(top); it.bottomMargin = dp(bot) }

    private fun sliderLabel(text: String) = TextView(context).apply {
        this.text = text
        setTextColor(Color.parseColor("#AAFFFFFF"))
        textSize = 12f
        layoutParams = lp(top = 10, bot = 2)
    }

    private fun seekBar(max: Int, progress: Int, onChange: (Int) -> Unit) =
        SeekBar(context).apply {
            this.max = max; this.progress = progress
            layoutParams = lp(bot = 2)
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(s: SeekBar?, p: Int, user: Boolean) {
                    if (user) onChange(p)
                }
                override fun onStartTrackingTouch(s: SeekBar?) {}
                override fun onStopTrackingTouch(s: SeekBar?) {}
            })
        }

    private fun button(label: String, color: Int, action: () -> Unit) =
        TextView(context).apply {
            text = label; setTextColor(color); textSize = 15f
            setPadding(dp(16), dp(10), dp(16), dp(10))
            setOnClickListener { action() }
        }
}
