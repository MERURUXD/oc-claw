import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyDeferredStable,
  beginGeometryMotion,
  cancelDeferredStable,
  canSettleToStable,
  createGeometryLifecycle,
  estimateDetailedBubbleHeight,
  isIncrementalMotionActive,
  resolveObservedGeometryMode,
  scheduleDeferredStable,
  shouldGateIncrementalResizeObserver,
} from './bubbleGeometryLifecycle.ts'

test('1. Normal settle: motion → schedule → double-rAF apply marks settled without native shrink', () => {
  let s = createGeometryLifecycle(1)
  s = beginGeometryMotion(s, 1)
  assert.equal(s.stableGeometryAllowed, false)
  assert.equal(resolveObservedGeometryMode({ stableGeometryAllowed: s.stableGeometryAllowed, hasActiveMotion: true, phase: 'entering' }), 'motion')

  const { state: scheduled, ticket } = scheduleDeferredStable(s)
  s = scheduled
  assert.equal(
    resolveObservedGeometryMode({
      stableGeometryAllowed: s.stableGeometryAllowed,
      hasActiveMotion: false,
      phase: 'visible',
    }),
    'motion',
  )

  const applied = applyDeferredStable(s, ticket, { phase: 'visible', hasActiveMotion: false })
  s = applied.state
  // Under persistent envelope architecture, native window never shrinks to stable
  assert.equal(applied.shouldShrinkToStable, false)
  assert.equal(s.stableGeometryAllowed, true)
  assert.equal(
    resolveObservedGeometryMode({
      stableGeometryAllowed: s.stableGeometryAllowed,
      hasActiveMotion: false,
      phase: 'visible',
    }),
    'motion',
  )
})

test('2. Close during enter: begin exit invalidates deferred stable (no shrink)', () => {
  let s = createGeometryLifecycle(10)
  s = beginGeometryMotion(s, 10)
  const { state: scheduled, ticket } = scheduleDeferredStable(s)
  s = beginGeometryMotion(scheduled) // close / exit starts
  const applied = applyDeferredStable(s, ticket, { phase: 'exiting', hasActiveMotion: true })
  assert.equal(applied.shouldShrinkToStable, false)
  assert.equal(applied.state.stableGeometryAllowed, false)
})

test('3. Fast re-enter: old deferred rAF is dirty against new generation/transitionId', () => {
  let s = createGeometryLifecycle(1)
  s = beginGeometryMotion(s, 1)
  const first = scheduleDeferredStable(s)
  s = beginGeometryMotion(first.state, 2) // reopen with new transition id
  const applied = applyDeferredStable(s, first.ticket, { phase: 'visible', hasActiveMotion: false })
  assert.equal(applied.shouldShrinkToStable, false)
  assert.equal(applied.state.stableGeometryAllowed, false)

  const second = scheduleDeferredStable(s)
  const ok = applyDeferredStable(second.state, second.ticket, { phase: 'visible', hasActiveMotion: false })
  assert.equal(ok.shouldShrinkToStable, false)
  assert.equal(ok.state.stableGeometryAllowed, true)
})

test('4. Width retarget while settling: RO stays motion until deferred apply', () => {
  let s = createGeometryLifecycle(3)
  s = beginGeometryMotion(s, 3)
  const { state: scheduled } = scheduleDeferredStable(s)
  s = scheduled
  // Under persistent envelope, RO always maintains motion envelope
  assert.equal(
    resolveObservedGeometryMode({
      stableGeometryAllowed: s.stableGeometryAllowed,
      hasActiveMotion: false,
      phase: 'visible',
    }),
    'motion',
  )
})

test('5. Multi-session: only final settle (no active motion) may open gate', () => {
  let s = createGeometryLifecycle(4)
  s = beginGeometryMotion(s, 4)
  // First row finishes but others still moving — caller must not schedule, or schedule then fail apply
  const early = scheduleDeferredStable(s)
  const blocked = applyDeferredStable(early.state, early.ticket, {
    phase: 'visible',
    hasActiveMotion: true,
  })
  assert.equal(blocked.shouldShrinkToStable, false)

  const last = scheduleDeferredStable(blocked.state)
  const done = applyDeferredStable(last.state, last.ticket, {
    phase: 'visible',
    hasActiveMotion: false,
  })
  assert.equal(done.shouldShrinkToStable, false)
  assert.equal(done.state.stableGeometryAllowed, true)
})

test('6. Dirty rAF after cancelDeferredStable / generation bump', () => {
  let s = createGeometryLifecycle(5)
  s = beginGeometryMotion(s, 5)
  const { state: scheduled, ticket } = scheduleDeferredStable(s)
  s = cancelDeferredStable(scheduled)
  const applied = applyDeferredStable(s, ticket, { phase: 'visible', hasActiveMotion: false })
  assert.equal(applied.shouldShrinkToStable, false)
})

test('7. Incremental motion detection: recognizes incremental tokens', () => {
  assert.equal(isIncrementalMotionActive(new Set(['global-entry'])), false)
  assert.equal(isIncrementalMotionActive(new Set(['global-exit'])), false)
  assert.equal(isIncrementalMotionActive(new Set()), false)
  assert.equal(isIncrementalMotionActive(new Set(['incremental:session-1'])), true)
  assert.equal(isIncrementalMotionActive(new Set(['global-entry', 'incremental:session-2'])), true)
})

test('8. ResizeObserver gating during incremental motion', () => {
  // Gated ONLY when both incremental motion is active AND envelope is prepared
  assert.equal(
    shouldGateIncrementalResizeObserver({
      hasIncrementalMotion: true,
      incrementalEnvelopePrepared: true,
    }),
    true
  )
  // Not gated if envelope has not been prepared yet
  assert.equal(
    shouldGateIncrementalResizeObserver({
      hasIncrementalMotion: true,
      incrementalEnvelopePrepared: false,
    }),
    false
  )
  // Not gated if incremental motion has completed
  assert.equal(
    shouldGateIncrementalResizeObserver({
      hasIncrementalMotion: false,
      incrementalEnvelopePrepared: true,
    }),
    false
  )
  assert.equal(
    shouldGateIncrementalResizeObserver({
      hasIncrementalMotion: false,
      incrementalEnvelopePrepared: false,
    }),
    false
  )
})

test('9. Stable settle gating: decouples row completion from window settle', () => {
  // Disallowed if phase is not visible
  assert.equal(
    canSettleToStable({
      phase: 'entering',
      activeMotionTokensCount: 0,
      pendingIncrementalCount: 0,
      isWidthAnimating: false,
    }),
    false
  )

  // Disallowed if active motion tokens still exist (e.g. other incremental rows)
  assert.equal(
    canSettleToStable({
      phase: 'visible',
      activeMotionTokensCount: 1,
      pendingIncrementalCount: 0,
      isWidthAnimating: false,
    }),
    false
  )

  // Disallowed if pending incremental row entries exist
  assert.equal(
    canSettleToStable({
      phase: 'visible',
      activeMotionTokensCount: 0,
      pendingIncrementalCount: 1,
      isWidthAnimating: false,
    }),
    false
  )

  // Disallowed while width spring is still animating
  assert.equal(
    canSettleToStable({
      phase: 'visible',
      activeMotionTokensCount: 0,
      pendingIncrementalCount: 0,
      isWidthAnimating: true,
    }),
    false
  )

  // Allowed only when all conditions are satisfied
  assert.equal(
    canSettleToStable({
      phase: 'visible',
      activeMotionTokensCount: 0,
      pendingIncrementalCount: 0,
      isWidthAnimating: false,
    }),
    true
  )
})

test('10. Detailed bubble height estimation', () => {
  assert.equal(estimateDetailedBubbleHeight(0), 60)
  assert.equal(estimateDetailedBubbleHeight(1), 60)
  // 2 rows: 60 + 8 + 60 = 128px
  assert.equal(estimateDetailedBubbleHeight(2), 128)
  // 3 rows: 60 + 8 + 60 + 8 + 60 = 196px
  assert.equal(estimateDetailedBubbleHeight(3), 196)
  // 4 rows: 60*4 + 8*3 = 264px
  assert.equal(estimateDetailedBubbleHeight(4), 264)
})
