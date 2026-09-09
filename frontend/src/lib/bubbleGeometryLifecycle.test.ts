import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyDeferredStable,
  beginGeometryMotion,
  cancelDeferredStable,
  createGeometryLifecycle,
  resolveObservedGeometryMode,
  scheduleDeferredStable,
} from './bubbleGeometryLifecycle.ts'

test('1. Normal settle: motion → schedule → double-rAF apply opens gate and shrinks', () => {
  let s = createGeometryLifecycle(1)
  s = beginGeometryMotion(s, 1)
  assert.equal(s.stableGeometryAllowed, false)
  assert.equal(resolveObservedGeometryMode({ stableGeometryAllowed: s.stableGeometryAllowed, hasActiveMotion: true, phase: 'entering' }), 'motion')

  const { state: scheduled, ticket } = scheduleDeferredStable(s)
  s = scheduled
  // Before apply, RO must stay on motion envelope even if phase looks visible and tokens empty
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
  assert.equal(applied.shouldShrinkToStable, true)
  assert.equal(s.stableGeometryAllowed, true)
  assert.equal(
    resolveObservedGeometryMode({
      stableGeometryAllowed: s.stableGeometryAllowed,
      hasActiveMotion: false,
      phase: 'visible',
    }),
    'stable',
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
  assert.equal(ok.shouldShrinkToStable, true)
  assert.equal(ok.state.stableGeometryAllowed, true)
})

test('4. Width retarget while settling: RO stays motion until deferred apply', () => {
  let s = createGeometryLifecycle(3)
  s = beginGeometryMotion(s, 3)
  const { state: scheduled } = scheduleDeferredStable(s)
  s = scheduled
  // Simulate width retarget RO while gate still closed
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
  assert.equal(done.shouldShrinkToStable, true)
})

test('6. Dirty rAF after cancelDeferredStable / generation bump', () => {
  let s = createGeometryLifecycle(5)
  s = beginGeometryMotion(s, 5)
  const { state: scheduled, ticket } = scheduleDeferredStable(s)
  s = cancelDeferredStable(scheduled)
  const applied = applyDeferredStable(s, ticket, { phase: 'visible', hasActiveMotion: false })
  assert.equal(applied.shouldShrinkToStable, false)
})
