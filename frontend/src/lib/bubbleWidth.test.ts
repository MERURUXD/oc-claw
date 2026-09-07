import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BUBBLE_WIDTH,
  BUBBLE_WIDTH_MOTION,
  clampBubbleWidth,
  shouldAnimateBubbleWidth,
  resolveBubbleWidthTarget,
  calculateMultiSessionIntrinsicWidth,
} from './bubbleWidth.ts'

test('1. Clamp boundary enforcement [190, 345]', () => {
  // Below minimum
  assert.equal(clampBubbleWidth(120), 190)
  assert.equal(clampBubbleWidth(0), 190)
  assert.equal(clampBubbleWidth(189), 190)

  // Within bounds
  assert.equal(clampBubbleWidth(190), 190)
  assert.equal(clampBubbleWidth(220), 220)
  assert.equal(clampBubbleWidth(280), 280)
  assert.equal(clampBubbleWidth(345), 345)

  // Above maximum
  assert.equal(clampBubbleWidth(346), 345)
  assert.equal(clampBubbleWidth(400), 345)
  assert.equal(clampBubbleWidth(1000), 345)
})

test('2. Dead-zone threshold behavior (default 6px)', () => {
  assert.equal(BUBBLE_WIDTH_MOTION.instantThreshold, 6)

  // Sub-threshold delta (< 6px) -> instant update, no spring
  const delta4 = resolveBubbleWidthTarget(204, 200)
  assert.equal(delta4.targetWidth, 204)
  assert.equal(delta4.shouldAnimate, false)

  const delta5 = resolveBubbleWidthTarget(205, 200)
  assert.equal(delta5.targetWidth, 205)
  assert.equal(delta5.shouldAnimate, false)

  // Exactly at threshold (delta = 6px) -> spring triggers
  const delta6 = resolveBubbleWidthTarget(206, 200)
  assert.equal(delta6.targetWidth, 206)
  assert.equal(delta6.shouldAnimate, true)

  // Large delta -> spring triggers
  const delta60 = resolveBubbleWidthTarget(260, 200)
  assert.equal(delta60.targetWidth, 260)
  assert.equal(delta60.shouldAnimate, true)

  // Custom threshold
  const customInstant = resolveBubbleWidthTarget(207, 200, { instantThreshold: 8 })
  assert.equal(customInstant.shouldAnimate, false)
  const customAnimate = resolveBubbleWidthTarget(208, 200, { instantThreshold: 8 })
  assert.equal(customAnimate.shouldAnimate, true)
})

test('3. Initial render / prepare: immediate width assignment, zero width spring', () => {
  // Fresh mount (currentWidth is null)
  const initial = resolveBubbleWidthTarget(260, null)
  assert.equal(initial.targetWidth, 260)
  assert.equal(initial.shouldAnimate, false, 'Must not animate on fresh mount')

  // During prepared or entering phase (even with large delta from a fallback)
  const prepared = resolveBubbleWidthTarget(280, 200, { isPreparedOrEntering: true })
  assert.equal(prepared.targetWidth, 280)
  assert.equal(prepared.shouldAnimate, false, 'Must not play width spring during prepare/enter')
})

test('4. Visible phase update: delta >= 6 triggers width spring', () => {
  const visible = resolveBubbleWidthTarget(295, 210, { isPreparedOrEntering: false })
  assert.equal(visible.targetWidth, 295)
  assert.equal(visible.shouldAnimate, true)

  // Shrink delta >= 6
  const shrink = resolveBubbleWidthTarget(210, 295, { isPreparedOrEntering: false })
  assert.equal(shrink.targetWidth, 210)
  assert.equal(shrink.shouldAnimate, true)
})

test('5. Exiting phase: freezes width target and disables spring', () => {
  // During exit, even if payload changes or elements collapse, width must remain stable
  const exiting = resolveBubbleWidthTarget(190, 285, { isExiting: true })
  assert.equal(exiting.targetWidth, 285, 'Must keep existing width during exit')
  assert.equal(exiting.shouldAnimate, false, 'Must not trigger spring during exit')
})

test('6. Reduced motion: always instant without spring', () => {
  const reducedLarge = resolveBubbleWidthTarget(320, 200, { prefersReducedMotion: true })
  assert.equal(reducedLarge.targetWidth, 320)
  assert.equal(reducedLarge.shouldAnimate, false)

  const reducedSmall = resolveBubbleWidthTarget(202, 200, { prefersReducedMotion: true })
  assert.equal(reducedSmall.targetWidth, 202)
  assert.equal(reducedSmall.shouldAnimate, false)
})

test('7. Rapid target updates: continuous retargeting without snap-back or queuing', () => {
  // First update: 200 -> 260 starts spring
  const step1 = resolveBubbleWidthTarget(260, 200)
  assert.equal(step1.targetWidth, 260)
  assert.equal(step1.shouldAnimate, true)

  // Second update arrives while step1 is in flight (isCurrentlyAnimating = true)
  // New target is 263 (delta from 260 is 3, which is < instantThreshold).
  // Because animation is ALREADY in flight, it must continue animating to 263
  // rather than snapping to duration: 0 midway!
  const step2 = resolveBubbleWidthTarget(263, 260, { isCurrentlyAnimating: true })
  assert.equal(step2.targetWidth, 263)
  assert.equal(step2.shouldAnimate, true, 'In-flight retargeting maintains spring continuity')

  // Third update: larger shift to 310 while still in flight
  const step3 = resolveBubbleWidthTarget(310, 263, { isCurrentlyAnimating: true })
  assert.equal(step3.targetWidth, 310)
  assert.equal(step3.shouldAnimate, true)
})

test('8. Multi-session stack intrinsic width resolution', () => {
  // Empty or invalid
  assert.equal(calculateMultiSessionIntrinsicWidth([]), BUBBLE_WIDTH.min)

  // Single session
  assert.equal(calculateMultiSessionIntrinsicWidth([220]), 220)

  // Multiple sessions: max row width governs stack width
  assert.equal(calculateMultiSessionIntrinsicWidth([220, 310]), 310)
  assert.equal(calculateMultiSessionIntrinsicWidth([310, 220, 260]), 310)

  // All below minimum -> clamped to min
  assert.equal(calculateMultiSessionIntrinsicWidth([140, 160]), 190)

  // Above maximum -> clamped to max
  assert.equal(calculateMultiSessionIntrinsicWidth([250, 420]), 345)

  // Widest row removal scenario:
  // Before: row A (230px), row B (310px) -> stack 310px
  const beforeRemoval = calculateMultiSessionIntrinsicWidth([230, 310])
  assert.equal(beforeRemoval, 310)

  // After removal: row B finished, only row A (230px) remains
  const afterRemoval = calculateMultiSessionIntrinsicWidth([230])
  assert.equal(afterRemoval, 230)

  // Target resolution for shrinking from 310 to 230 triggers smooth spring
  const shrinkRes = resolveBubbleWidthTarget(afterRemoval, beforeRemoval)
  assert.equal(shrinkRes.targetWidth, 230)
  assert.equal(shrinkRes.shouldAnimate, true)
})

test('9. Close mid-spring: freezes at current interpolated width and halts spring', () => {
  // Scenario: Bubble was springing from 200 toward 320.
  // Mid-flight, current rendered width is at 254px when user triggers close (isExiting = true).
  // Target width must freeze at 254px and shouldAnimate must be false.
  const midSpringExit = resolveBubbleWidthTarget(320, 254, {
    isExiting: true,
    isCurrentlyAnimating: true,
  })
  assert.equal(midSpringExit.targetWidth, 254, 'Must freeze at intermediate rendered width, not spring target')
  assert.equal(midSpringExit.shouldAnimate, false, 'Must halt spring on exit')
})

test('10. Reopen before exit completes: re-enables spring to content target', () => {
  // Scenario: Bubble was frozen at 254px during exit.
  // Before exit completes, a new notification or interaction reopens it to 'visible' phase.
  // Content requires 320px. Since |320 - 254| = 66 >= 6, a spring animation must be re-triggered.
  const reopened = resolveBubbleWidthTarget(320, 254, {
    isPreparedOrEntering: false,
    isExiting: false,
  })
  assert.equal(reopened.targetWidth, 320, 'Must target full content width on reopen')
  assert.equal(reopened.shouldAnimate, true, 'Must re-enable spring from frozen width to target width')
})

test('11. Unchanged-content phase transitions: phase changes reconcile width animation', () => {
  const contentWidth = 300
  const initialWidth = 200

  // 1. In visible phase: delta is 100 -> spring triggers
  const visibleRes = resolveBubbleWidthTarget(contentWidth, initialWidth, {
    isPreparedOrEntering: false,
    isExiting: false,
  })
  assert.equal(visibleRes.targetWidth, 300)
  assert.equal(visibleRes.shouldAnimate, true)

  // 2. Content is identical (contentWidth still 300), but phase changes to exiting while at 260px:
  // Must freeze at 260px with shouldAnimate = false
  const exitRes = resolveBubbleWidthTarget(contentWidth, 260, {
    isExiting: true,
  })
  assert.equal(exitRes.targetWidth, 260)
  assert.equal(exitRes.shouldAnimate, false)

  // 3. Phase changes back to prepared: instant assignment without spring
  const preparedRes = resolveBubbleWidthTarget(contentWidth, 260, {
    isPreparedOrEntering: true,
  })
  assert.equal(preparedRes.targetWidth, 300)
  assert.equal(preparedRes.shouldAnimate, false)
})

