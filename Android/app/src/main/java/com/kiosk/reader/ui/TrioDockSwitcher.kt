package com.kiosk.reader.ui

import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import androidx.dynamicanimation.animation.DynamicAnimation
import androidx.dynamicanimation.animation.SpringAnimation
import androidx.dynamicanimation.animation.SpringForce
import kotlin.math.abs

/**
 * TrioDockSwitcher
 * ────────────────
 * Production-grade, gesture-driven state machine for switching between
 * vertically stacked dock modes.  Designed to feel as fluid and alive
 * as the iPadOS floating dock / card switcher.
 *
 * ┌──────────────────────────────────────────────────────┐
 * │  State machine                                       │
 * │                                                      │
 * │  IDLE ─► DRAGGING ─► ARMED ─► SETTLING ─► IDLE      │
 * │               │                                      │
 * │               └─► (below threshold) ► SETTLING ─► IDLE│
 * └──────────────────────────────────────────────────────┘
 *
 * Key behaviours:
 * • CYCLIC switching — swipe up on last dock wraps to first; down on first wraps to last.
 * • 20 % of dock height = arm threshold.
 * • Fast fling (≥ 800 px/s) commits even below threshold.
 * • Drag dampening kicks in after 70 % progress for natural resistance.
 * • translationY is clamped to ±dockHeight — never overshoots during drag.
 * • Release always triggers spring animation — NEVER an instant snap.
 * • Gesture release velocity feeds directly into the spring for
 *   fast-swipe → fast-settle, slow-swipe → slow-settle.
 * • Subtle overshoot-and-settle (Apple bounce) via under-damped spring.
 *
 * Spring tuning (iPadOS baseline):
 *   Commit:  stiffness 600, damping 0.78
 *   Cancel:  stiffness 700, damping 0.80
 */
class TrioDockSwitcher(
    private val docks: List<View>,
    private val onDockWillChange: (fromIndex: Int, toIndex: Int) -> Unit,
    private val onDockDidChange: (fromIndex: Int, toIndex: Int) -> Unit
) {
    private val dockCount = docks.size

    // ── State machine ─────────────────────────────────────────────────────

    enum class State { IDLE, DRAGGING, ARMED, SETTLING }

    var currentIndex = 0
        private set

    var state = State.IDLE
        private set

    // ── Gesture tracking ──────────────────────────────────────────────────

    private var dragStartX = 0f
    private var dragStartY = 0f
    private var axisLocked = false
    private var isVerticalGesture = false
    private var targetIndex = -1
    private var lastDragDirection = 0       // -1 = up, +1 = down, 0 = none
    private var releaseVelocityY = 0f       // captured on ACTION_UP for spring
    private var velocityTracker: VelocityTracker? = null

    // ── Thresholds ────────────────────────────────────────────────────────

    private val THRESHOLD_RATIO = 0.20f
    private val FLING_COMMIT_VELOCITY = 800f   // px/s
    private val DRAG_SLOP_DP = 8f
    private var dragSlopPx = -1f

    /** Progress fraction (0‥1) after which drag dampening engages. */
    private val DAMPEN_ONSET = 0.70f
    /** Dampening multiplier applied to the excess past DAMPEN_ONSET. */
    private val DAMPEN_FACTOR = 0.45f

    // ── Visual tuning (subtle, premium) ───────────────────────────────────

    /** Outgoing dock scale at full progress. */
    private val OUT_SCALE_END = 0.96f
    /** Outgoing dock alpha at full progress. */
    private val OUT_ALPHA_END = 0.42f
    /** How far the outgoing dock translates (fraction of dock height). */
    private val OUT_TRANSLATION_RATIO = 0.52f

    /** Incoming dock initial scale. */
    private val IN_SCALE_START = 0.92f
    /** Incoming dock initial alpha. */
    private val IN_ALPHA_START = 0f
    /** Incoming dock initial Y offset (fraction of dock height). */
    private val IN_OFFSET_RATIO = 0.38f

    // ── Spring tuning (Apple-level) ───────────────────────────────────────
    //
    // These create a slightly under-damped spring that overshoots its
    // target by a subtle amount and settles cleanly — the hallmark
    // "alive" feel of iPadOS / iOS system animations.

    /** Commit spring: carries the dock to its new home. */
    private val COMMIT_STIFFNESS = 600f
    private val COMMIT_DAMPING   = 0.78f

    /** Cancel spring: snaps back with a touch more authority. */
    private val CANCEL_STIFFNESS = 700f
    private val CANCEL_DAMPING   = 0.80f

    // ── Active animations ─────────────────────────────────────────────────

    private val activeAnims = mutableListOf<SpringAnimation>()

    // ── Horizontal fling callback ─────────────────────────────────────────

    var onHorizontalFling: ((isLeftFling: Boolean) -> Unit)? = null

    // ══════════════════════════════════════════════════════════════════════
    // Public API
    // ══════════════════════════════════════════════════════════════════════

    fun setCurrentIndex(index: Int) {
        val i = index.mod(dockCount)
        cancelAll()
        currentIndex = i
        state = State.IDLE
        docks.forEachIndexed { idx, d ->
            resetTransform(d)
            d.visibility = if (idx == i) View.VISIBLE else View.GONE
        }
    }

    fun animateToIndex(index: Int) {
        val i = index.mod(dockCount)
        if (i == currentIndex) return
        if (state != State.IDLE) return

        targetIndex = i
        releaseVelocityY = 0f
        lastDragDirection = if (i > currentIndex) -1 else 1
        prepareIncomingDock(i)
        commitTransition()
    }

    fun isBusy(): Boolean = state != State.IDLE

    fun release() {
        cancelAll()
        velocityTracker?.recycle()
        velocityTracker = null
    }

    // ══════════════════════════════════════════════════════════════════════
    // Touch handling
    // ══════════════════════════════════════════════════════════════════════

    fun onTouchEvent(event: MotionEvent): Boolean {
        ensureSlopPx()
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> return onDown(event)
            MotionEvent.ACTION_MOVE -> return onMove(event)
            MotionEvent.ACTION_UP,
            MotionEvent.ACTION_CANCEL -> return onUp(event)
        }
        return false
    }

    // ── ACTION_DOWN ───────────────────────────────────────────────────────

    private fun onDown(event: MotionEvent): Boolean {
        if (state == State.SETTLING) return false

        cancelAll()

        dragStartX = event.rawX
        dragStartY = event.rawY
        axisLocked = false
        isVerticalGesture = false
        targetIndex = -1
        lastDragDirection = 0
        releaseVelocityY = 0f

        velocityTracker?.recycle()
        velocityTracker = VelocityTracker.obtain()
        addRawMovement(event)

        return true
    }

    // ── ACTION_MOVE ───────────────────────────────────────────────────────

    private fun onMove(event: MotionEvent): Boolean {
        addRawMovement(event)

        val dX = event.rawX - dragStartX
        val dY = event.rawY - dragStartY

        // ── Axis lock ────────────────────────────────────────────────────
        if (!axisLocked) {
            if (abs(dX) < dragSlopPx && abs(dY) < dragSlopPx) return true
            axisLocked = true
            isVerticalGesture = abs(dY) >= abs(dX)
        }
        if (!isVerticalGesture) return true

        // ── Resolve target (CYCLIC) ──────────────────────────────────────
        val isSwipeUp = dY < 0
        val candidate = if (isSwipeUp) (currentIndex + 1).mod(dockCount)
                        else           (currentIndex - 1 + dockCount).mod(dockCount)

        val dockHeight = docks[currentIndex].height.toFloat().coerceAtLeast(1f)

        // Clamp raw drag distance to ±dockHeight
        val clampedAbsDrag = abs(dY).coerceAtMost(dockHeight)

        // Apply dampening after DAMPEN_ONSET
        val rawProgress = clampedAbsDrag / dockHeight
        val progress = if (rawProgress > DAMPEN_ONSET) {
            val excess = rawProgress - DAMPEN_ONSET
            DAMPEN_ONSET + excess * DAMPEN_FACTOR
        } else {
            rawProgress
        }

        lastDragDirection = if (isSwipeUp) -1 else 1

        // ── Initialise drag ──────────────────────────────────────────────
        if (state == State.IDLE) {
            targetIndex = candidate
            state = State.DRAGGING
            prepareIncomingDock(targetIndex)
        }

        // ── Direction reversal ───────────────────────────────────────────
        if (candidate != targetIndex) {
            hideTarget()
            targetIndex = candidate
            state = State.DRAGGING
            prepareIncomingDock(targetIndex)
        }

        // ── Apply transforms ─────────────────────────────────────────────
        applyDragTransforms(progress, isSwipeUp)

        // ── Threshold check ──────────────────────────────────────────────
        val threshold = dockHeight * THRESHOLD_RATIO
        if (clampedAbsDrag >= threshold && state == State.DRAGGING) {
            state = State.ARMED
            docks[currentIndex].performHapticFeedback(
                HapticFeedbackConstants.KEYBOARD_TAP
            )
        } else if (clampedAbsDrag < threshold && state == State.ARMED) {
            state = State.DRAGGING
        }

        return true
    }

    // ── ACTION_UP / CANCEL ────────────────────────────────────────────────

    private fun onUp(event: MotionEvent): Boolean {
        addRawMovement(event)
        velocityTracker?.computeCurrentVelocity(1000)
        val vY = velocityTracker?.yVelocity ?: 0f
        val vX = velocityTracker?.xVelocity ?: 0f
        velocityTracker?.recycle()
        velocityTracker = null

        releaseVelocityY = vY

        // ── Horizontal fling ─────────────────────────────────────────────
        if (axisLocked && !isVerticalGesture) {
            val dX = event.rawX - dragStartX
            if (abs(dX) > dragSlopPx * 3 && abs(vX) > 400f) {
                onHorizontalFling?.invoke(dX < 0)
            }
            state = State.IDLE
            return true
        }

        // ── Vertical resolution ──────────────────────────────────────────
        when (state) {
            State.ARMED -> commitTransition()
            State.DRAGGING -> {
                val dY = event.rawY - dragStartY
                val commitByFling = if (dY < 0) vY < -FLING_COMMIT_VELOCITY
                                    else         vY >  FLING_COMMIT_VELOCITY
                if (commitByFling && targetIndex in docks.indices) {
                    commitTransition()
                } else {
                    cancelTransition()
                }
            }
            else -> { state = State.IDLE }
        }
        return true
    }

    // ══════════════════════════════════════════════════════════════════════
    // Drag-phase visual transforms
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Prime the incoming dock off-screen before it becomes visible.
     * Direction is inferred from index relationship to current.
     */
    private fun prepareIncomingDock(index: Int) {
        val dock = docks[index]
        val refHeight = docks[currentIndex].height.toFloat().coerceAtLeast(1f)

        // "Below" means +Y (the user is swiping up, so the next dock rises from the bottom).
        // For cyclic wrapping the comparison currentIndex↔index is used.
        val comesFromBelow = isCyclicForward(currentIndex, index)

        dock.alpha = IN_ALPHA_START
        dock.scaleX = IN_SCALE_START
        dock.scaleY = IN_SCALE_START
        dock.translationY = if (comesFromBelow) refHeight * IN_OFFSET_RATIO
                            else -refHeight * IN_OFFSET_RATIO
        dock.visibility = View.VISIBLE

        docks[currentIndex].bringToFront()
    }

    /**
     * Apply real-time transforms that track the finger.
     *
     * [progress] is already clamped and dampened.
     */
    private fun applyDragTransforms(progress: Float, isSwipeUp: Boolean) {
        val currentDock = docks[currentIndex]
        val targetDock = docks.getOrNull(targetIndex) ?: return
        val dockHeight = currentDock.height.toFloat().coerceAtLeast(1f)
        val p = progress.coerceIn(0f, 1f)

        // ── Outgoing dock ────────────────────────────────────────────────
        val outSign = if (isSwipeUp) -1f else 1f
        val outTranslation = (outSign * p * dockHeight * OUT_TRANSLATION_RATIO)
            .coerceIn(-dockHeight, dockHeight)
        currentDock.translationY = outTranslation
        currentDock.scaleX = lerp(1f, OUT_SCALE_END, p)
        currentDock.scaleY = lerp(1f, OUT_SCALE_END, p)
        currentDock.alpha  = lerp(1f, OUT_ALPHA_END, p)

        // ── Incoming dock (parallax) ─────────────────────────────────────
        val comesFromBelow = isCyclicForward(currentIndex, targetIndex)
        val inStartY = if (comesFromBelow) dockHeight * IN_OFFSET_RATIO
                       else               -dockHeight * IN_OFFSET_RATIO
        targetDock.translationY = lerp(inStartY, 0f, p)
        targetDock.scaleX = lerp(IN_SCALE_START, 1f, p)
        targetDock.scaleY = lerp(IN_SCALE_START, 1f, p)
        targetDock.alpha  = lerp(IN_ALPHA_START, 1f, p)
    }

    // ══════════════════════════════════════════════════════════════════════
    // Spring-animated transitions
    // ══════════════════════════════════════════════════════════════════════

    private fun commitTransition() {
        if (targetIndex !in docks.indices) { cancelTransition(); return }

        state = State.SETTLING
        val from = currentIndex
        val to = targetIndex

        onDockWillChange(from, to)

        val outDock = docks[from]
        val inDock  = docks[to]
        val comesFromBelow = isCyclicForward(from, to)
        val exitY = if (comesFromBelow) -outDock.height.toFloat()
                    else                 outDock.height.toFloat()

        val vel = releaseVelocityY

        // Outgoing → exit with velocity
        springCommit(outDock, DynamicAnimation.TRANSLATION_Y, exitY, vel)
        springCommit(outDock, DynamicAnimation.SCALE_X, OUT_SCALE_END, 0f)
        springCommit(outDock, DynamicAnimation.SCALE_Y, OUT_SCALE_END, 0f)
        springCommit(outDock, DynamicAnimation.ALPHA, 0f, 0f)

        // Incoming → settle at rest with velocity
        val sentinel = springCommit(inDock, DynamicAnimation.TRANSLATION_Y, 0f, vel)
        springCommit(inDock, DynamicAnimation.SCALE_X, 1f, 0f)
        springCommit(inDock, DynamicAnimation.SCALE_Y, 1f, 0f)
        springCommit(inDock, DynamicAnimation.ALPHA, 1f, 0f)

        sentinel.addEndListener { _, _, _, _ ->
            outDock.visibility = View.GONE
            resetTransform(outDock)
            currentIndex = to
            targetIndex = -1
            state = State.IDLE
            onDockDidChange(from, to)
        }
    }

    private fun cancelTransition() {
        state = State.SETTLING

        val currentDock = docks[currentIndex]
        val targetDock = docks.getOrNull(targetIndex)

        val vel = releaseVelocityY

        // Current → spring back with velocity
        springCancel(currentDock, DynamicAnimation.TRANSLATION_Y, 0f, vel)
        springCancel(currentDock, DynamicAnimation.SCALE_X, 1f, 0f)
        springCancel(currentDock, DynamicAnimation.SCALE_Y, 1f, 0f)
        val sentinel = springCancel(currentDock, DynamicAnimation.ALPHA, 1f, 0f)

        // Target → retreat
        targetDock?.let { dock ->
            val refHeight = currentDock.height.toFloat()
                .coerceAtLeast(dock.height.toFloat())
                .coerceAtLeast(1f)
            val comesFromBelow = isCyclicForward(currentIndex, targetIndex)
            val hideY = if (comesFromBelow) refHeight * IN_OFFSET_RATIO
                        else               -refHeight * IN_OFFSET_RATIO
            springCancel(dock, DynamicAnimation.TRANSLATION_Y, hideY, 0f)
            springCancel(dock, DynamicAnimation.SCALE_X, IN_SCALE_START, 0f)
            springCancel(dock, DynamicAnimation.SCALE_Y, IN_SCALE_START, 0f)
            springCancel(dock, DynamicAnimation.ALPHA, 0f, 0f)
        }

        sentinel.addEndListener { _, _, _, _ ->
            targetDock?.apply {
                visibility = View.GONE
                resetTransform(this)
            }
            targetIndex = -1
            state = State.IDLE
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // Spring helpers
    // ══════════════════════════════════════════════════════════════════════

    private fun springCommit(
        view: View, prop: DynamicAnimation.ViewProperty,
        target: Float, velocity: Float
    ): SpringAnimation = makeSpring(view, prop, target, velocity,
        COMMIT_STIFFNESS, COMMIT_DAMPING)

    private fun springCancel(
        view: View, prop: DynamicAnimation.ViewProperty,
        target: Float, velocity: Float
    ): SpringAnimation = makeSpring(view, prop, target, velocity,
        CANCEL_STIFFNESS, CANCEL_DAMPING)

    private fun makeSpring(
        view: View,
        prop: DynamicAnimation.ViewProperty,
        target: Float,
        velocity: Float,
        stiffness: Float,
        damping: Float
    ): SpringAnimation {
        val anim = SpringAnimation(view, prop).apply {
            spring = SpringForce(target).apply {
                this.stiffness = stiffness
                this.dampingRatio = damping
            }
            if (velocity != 0f) setStartVelocity(velocity)
            start()
        }
        activeAnims.add(anim)
        anim.addEndListener { _, _, _, _ -> activeAnims.remove(anim) }
        return anim
    }

    private fun cancelAll() {
        activeAnims.toList().forEach { it.cancel() }
        activeAnims.clear()
    }

    // ══════════════════════════════════════════════════════════════════════
    // Transform & visibility helpers
    // ══════════════════════════════════════════════════════════════════════

    private fun resetTransform(v: View) {
        v.translationX = 0f
        v.translationY = 0f
        v.scaleX = 1f
        v.scaleY = 1f
        v.alpha = 1f
    }

    private fun hideTarget() {
        if (targetIndex in docks.indices) {
            docks[targetIndex].apply {
                visibility = View.GONE
                resetTransform(this)
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // Cyclic index helpers
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Returns true when [to] is the "next" dock in the cyclic order
     * relative to [from] — i.e. the dock that the user reaches by
     * swiping UP (or the natural forward direction).
     */
    private fun isCyclicForward(from: Int, to: Int): Boolean {
        return (from + 1).mod(dockCount) == to
    }

    // ══════════════════════════════════════════════════════════════════════
    // Utility
    // ══════════════════════════════════════════════════════════════════════

    private fun lerp(a: Float, b: Float, t: Float) = a + (b - a) * t

    private fun ensureSlopPx() {
        if (dragSlopPx < 0f) {
            dragSlopPx = DRAG_SLOP_DP * docks[0].resources.displayMetrics.density
        }
    }

    private fun addRawMovement(event: MotionEvent) {
        val vt = velocityTracker ?: return
        val dx = event.rawX - event.x
        val dy = event.rawY - event.y
        event.offsetLocation(dx, dy)
        vt.addMovement(event)
        event.offsetLocation(-dx, -dy)
    }
}
