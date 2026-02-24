package com.kiosk.reader.ui

import android.view.View
import androidx.dynamicanimation.animation.DynamicAnimation
import androidx.dynamicanimation.animation.SpringAnimation
import androidx.dynamicanimation.animation.SpringForce
import kotlin.math.abs

/**
 * DockPositionController
 * ──────────────────────
 * Single source of truth for the dock's vertical snap position.
 *
 * Three snap states:
 *   COLLAPSED – dock rests near the bottom (above nav bar)
 *   HALF      – dock lifted ~30% of screen height
 *   FULL      – dock lifted ~58% of screen height
 *
 * Key design:
 * • dockContainer.translationY is the ONLY property that moves the dock.
 * • onDrag() tracks finger 1:1 with no interpolation.
 * • onDragEnd() kicks off a spring animation to the resolved snap position.
 * • SpringForce is created FRESH per animation — a shared SpringForce whose
 *   finalPosition is never set throws IllegalStateException on start().
 */
class DockPositionController(private val dockContainer: View) {

    // ── Snap state ────────────────────────────────────────────────────────
    enum class SnapState { COLLAPSED, HALF, FULL }

    var currentState: SnapState = SnapState.COLLAPSED
        private set

    // ── Snap offset values (px, negative = upward translation) ───────────
    private var offsetCollapsed = 0f
    private var offsetHalf      = 0f
    private var offsetFull      = 0f

    private var isLayoutReady = false

    // ── Spring animation ──────────────────────────────────────────────────
    private var springAnim: SpringAnimation? = null

    // ── Live drag tracking ────────────────────────────────────────────────
    private var dragStartRawY         = 0f
    private var dragStartTranslationY = 0f

    // ──────────────────────────────────────────────────────────────────────
    // Initialisation
    // ──────────────────────────────────────────────────────────────────────

    fun onLayoutReady(parentHeight: Int, navBarHeight: Int, bottomMargin: Int) {
        val anchorOffset = (navBarHeight + bottomMargin).toFloat()
        offsetCollapsed = -anchorOffset
        offsetHalf      = -(anchorOffset + parentHeight * 0.30f)
        offsetFull      = -(anchorOffset + parentHeight * 0.58f)

        isLayoutReady = true
        dockContainer.translationY = offsetCollapsed
    }

    // ──────────────────────────────────────────────────────────────────────
    // Public API
    // ──────────────────────────────────────────────────────────────────────

    fun snapTo(state: SnapState, animate: Boolean = true) {
        if (!isLayoutReady) { currentState = state; return }
        cancelSpring()
        currentState = state
        val target = offsetFor(state)
        if (animate) springTo(target, startVelocity = 0f)
        else         dockContainer.translationY = target
    }

    /** Record drag start — call from ACTION_DOWN on the handle. */
    fun onDragStart(rawY: Float) {
        cancelSpring()
        dragStartRawY         = rawY
        dragStartTranslationY = dockContainer.translationY
    }

    /** Move dock 1:1 with finger — call from ACTION_MOVE on the handle. */
    fun onDrag(rawY: Float) {
        if (!isLayoutReady) return
        val delta = rawY - dragStartRawY
        val raw   = dragStartTranslationY + delta
        dockContainer.translationY = clampWithRubber(raw)
    }

    /** Resolve snap target and spring to it — call from ACTION_UP/CANCEL. */
    fun onDragEnd(velocityY: Float) {
        if (!isLayoutReady) return
        val target = resolveSnapTarget(dockContainer.translationY, velocityY)
        currentState = target
        springTo(offsetFor(target), startVelocity = velocityY)
    }

    // ──────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ──────────────────────────────────────────────────────────────────────

    private fun offsetFor(state: SnapState) = when (state) {
        SnapState.COLLAPSED -> offsetCollapsed
        SnapState.HALF      -> offsetHalf
        SnapState.FULL      -> offsetFull
    }

    private fun resolveSnapTarget(currentY: Float, velocityY: Float): SnapState {
        val velocityThreshold = 800f  // px/s

        // Strong upward fling → advance one step up
        if (velocityY < -velocityThreshold) {
            return when (currentState) {
                SnapState.COLLAPSED -> SnapState.HALF
                SnapState.HALF      -> SnapState.FULL
                SnapState.FULL      -> SnapState.FULL
            }
        }
        // Strong downward fling → advance one step down
        if (velocityY > velocityThreshold) {
            return when (currentState) {
                SnapState.FULL      -> SnapState.HALF
                SnapState.HALF      -> SnapState.COLLAPSED
                SnapState.COLLAPSED -> SnapState.COLLAPSED
            }
        }

        // No strong velocity → snap to nearest by distance
        return listOf(SnapState.COLLAPSED, SnapState.HALF, SnapState.FULL)
            .minByOrNull { abs(currentY - offsetFor(it)) }!!
    }

    /**
     * Rubber-band clamping.
     * • Past FULL limit (too far up): elastic resistance upward.
     * • Past COLLAPSED limit (too far down): elastic resistance downward.
     *   hardMax = offsetCollapsed — NEVER allow positive translationY which
     *   would push the bottom-anchored dock below the screen edge.
     */
    private fun clampWithRubber(rawY: Float): Float {
        val hardMin = offsetFull        // most-negative (highest)
        val hardMax = offsetCollapsed   // least-negative (lowest) — no going below

        return when {
            rawY < hardMin -> hardMin + (rawY - hardMin) * 0.25f   // stretch upward
            rawY > hardMax -> hardMax + (rawY - hardMax) * 0.25f   // stretch downward
            else           -> rawY
        }
    }

    /**
     * Spring to [targetY] with optional start velocity.
     *
     * Creates a FRESH SpringForce every time — DO NOT share a SpringForce
     * across animations without setting finalPosition, as the default
     * constructor leaves finalPosition = Float.MAX_VALUE (UNSET), causing:
     *   IllegalStateException: Final position of the spring must be set
     *   before the animation starts.
     */
    private fun springTo(targetY: Float, startVelocity: Float) {
        cancelSpring()
        springAnim = SpringAnimation(dockContainer, DynamicAnimation.TRANSLATION_Y).apply {
            spring = SpringForce(targetY).apply {
                stiffness    = SpringForce.STIFFNESS_MEDIUM
                dampingRatio = SpringForce.DAMPING_RATIO_LOW_BOUNCY
            }
            if (startVelocity != 0f) setStartVelocity(startVelocity)
            start()
        }
    }

    private fun cancelSpring() {
        springAnim?.cancel()
        springAnim = null
    }
}
