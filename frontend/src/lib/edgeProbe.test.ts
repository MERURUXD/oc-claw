import test from 'node:test'
import assert from 'node:assert/strict'
import {
  detectEdgeAtRest,
  computeRotatedBounds,
  computeProbeEnvelope,
  probeWindowX,
  EdgeProbeMachine,
  type PetRenderMetricsLite,
  type ScreenRect,
} from './edgeProbe.ts'

test('detectEdgeAtRest: identifies left edge when body touches or nears left border', () => {
  const monitor: ScreenRect = { left: 0, top: 0, width: 1920, height: 1080 }

  // Codex pet (hitbox.left = 0, width = 129)
  const codexHitbox = { left: 0, width: 129 }
  assert.equal(detectEdgeAtRest({ x: 0, y: 500 }, codexHitbox, monitor), 'left')
  assert.equal(detectEdgeAtRest({ x: 25, y: 500 }, codexHitbox, monitor), 'left')
  assert.equal(detectEdgeAtRest({ x: 30, y: 500 }, codexHitbox, monitor), 'left')
  assert.equal(detectEdgeAtRest({ x: 31, y: 500 }, codexHitbox, monitor), null)

  // VideoPet with canvas offset (canvasWidth = 382, hitbox.left = 71, width = 129)
  const videoHitbox = { left: 71, width: 129 }
  // windowX = -71 -> bodyLeft = 0
  assert.equal(detectEdgeAtRest({ x: -71, y: 500 }, videoHitbox, monitor), 'left')
  // windowX = -50 -> bodyLeft = 21 <= 30
  assert.equal(detectEdgeAtRest({ x: -50, y: 500 }, videoHitbox, monitor), 'left')
  // windowX = -40 -> bodyLeft = 31 > 30
  assert.equal(detectEdgeAtRest({ x: -40, y: 500 }, videoHitbox, monitor), null)
})

test('detectEdgeAtRest: identifies right edge when body touches or nears right border', () => {
  const monitor: ScreenRect = { left: 0, top: 0, width: 1920, height: 1080 }

  // Codex pet (hitbox.left = 0, width = 129)
  const codexHitbox = { left: 0, width: 129 }
  // windowX = 1920 - 129 = 1791 -> bodyRight = 1920
  assert.equal(detectEdgeAtRest({ x: 1791, y: 500 }, codexHitbox, monitor), 'right')
  // windowX = 1770 -> bodyRight = 1899 >= 1920 - 30 (1890)
  assert.equal(detectEdgeAtRest({ x: 1770, y: 500 }, codexHitbox, monitor), 'right')
  // windowX = 1750 -> bodyRight = 1879 < 1890
  assert.equal(detectEdgeAtRest({ x: 1750, y: 500 }, codexHitbox, monitor), null)

  // Multi-monitor offset (monitor left = 1920, width = 1920)
  const secondMonitor: ScreenRect = { left: 1920, top: 0, width: 1920, height: 1080 }
  // Left edge of second monitor
  assert.equal(detectEdgeAtRest({ x: 1920, y: 500 }, codexHitbox, secondMonitor), 'left')
  // Right edge of second monitor: 3840 - 129 = 3711
  assert.equal(detectEdgeAtRest({ x: 3711, y: 500 }, codexHitbox, secondMonitor), 'right')
})

test('computeRotatedBounds: computes correct AABB at 0, 45, and -45 degrees', () => {
  const rect = { left: 100, top: 100, width: 100, height: 100 }
  const pivot = { x: 150, y: 150 }

  // 0 degrees returns identical bounds
  const zero = computeRotatedBounds(rect, pivot, 0)
  assert.deepEqual(zero, rect)

  // 45 degrees of 100x100 square around center:
  // diagonal = 100 * sqrt(2) ≈ 141.42
  const r45 = computeRotatedBounds(rect, pivot, 45)
  assert.equal(Math.round(r45.width), 141)
  assert.equal(Math.round(r45.height), 141)
  assert.equal(Math.round(r45.left), 150 - Math.round(141.42 / 2))
  assert.equal(Math.round(r45.top), 150 - Math.round(141.42 / 2))

  // -45 degrees produces identical AABB dimensions
  const rm45 = computeRotatedBounds(rect, pivot, -45)
  assert.equal(Math.round(rm45.width), 141)
  assert.equal(Math.round(rm45.height), 141)
})

test('computeProbeEnvelope: expands envelope and assigns content offsets to prevent clipping', () => {
  // Codex pet (canvas == body: 129x140)
  const codexMetrics: PetRenderMetricsLite = {
    canvas: { width: 129, height: 140 },
    body: { width: 129, height: 140 },
    hitbox: { left: 0, top: 0, width: 129, height: 140 },
  }

  const codexEnv = computeProbeEnvelope(codexMetrics)
  // Must expand beyond 129x140
  assert.ok(codexEnv.canvasWidth > 129)
  assert.ok(codexEnv.canvasHeight > 140)
  assert.ok(codexEnv.contentOffsetX > 0)
  assert.ok(codexEnv.contentOffsetY > 0)
  assert.equal(codexEnv.bodyWidth, 129)
  assert.equal(codexEnv.bodyHeight, 140)
  assert.equal(codexEnv.hitboxLeft, codexEnv.contentOffsetX)
  assert.equal(codexEnv.hitboxTop, codexEnv.contentOffsetY)

  // Check that rotated 45 deg AABB fits completely inside the envelope without clipping
  const pivot = {
    x: codexEnv.hitboxLeft + codexEnv.bodyWidth / 2,
    y: codexEnv.hitboxTop + codexEnv.bodyHeight / 2,
  }
  const rotated = computeRotatedBounds(
    { left: codexEnv.hitboxLeft, top: codexEnv.hitboxTop, width: codexEnv.bodyWidth, height: codexEnv.bodyHeight },
    pivot,
    45,
  )
  assert.ok(rotated.left >= 0)
  assert.ok(rotated.top >= 0)
  assert.ok(rotated.left + rotated.width <= codexEnv.canvasWidth)
  assert.ok(rotated.top + rotated.height <= codexEnv.canvasHeight)
})

test('probeWindowX: calculates exact exposure on left and right edges', () => {
  const monitor: ScreenRect = { left: 0, top: 0, width: 1920, height: 1080 }

  // Rotated AABB with width 150, positioned at left = 30 inside probe envelope
  const rotatedAABB = { left: 30, width: 150 }

  // Left edge, 55% exposure (0.55):
  // offscreen = 0.45 * 150 = 67.5
  // targetWindowX = monitor.left - offscreen - rotatedAABB.left = 0 - 67.5 - 30 = -97.5 -> Math.round is -97
  const leftX = probeWindowX('left', 0.55, rotatedAABB, monitor)
  assert.equal(leftX, -97)
  // Rotated body left on screen: -98 + 30 = -68.
  // Rotated body right on screen: -68 + 150 = 82.
  // Portion on screen: 82 px. 82 / 150 = 54.67% ≈ 55%!

  // Left edge, 82% exposure (0.82):
  // offscreen = 0.18 * 150 = 27
  // targetWindowX = 0 - 27 - 30 = -57
  const leftStraightX = probeWindowX('left', 0.82, rotatedAABB, monitor)
  assert.equal(leftStraightX, -57)
  // Rotated body left on screen: -57 + 30 = -27.
  // Rotated body right on screen: -27 + 150 = 123.
  // Portion on screen: 123 px. 123 / 150 = 82%!

  // Right edge, 55% exposure (0.55):
  // offscreen = 0.45 * 150 = 67.5
  // targetWindowX = 1920 + 67.5 - (30 + 150) = 1987.5 - 180 = 1808
  const rightX = probeWindowX('right', 0.55, rotatedAABB, monitor)
  assert.equal(rightX, 1808)
  // Rotated body right on screen: 1808 + 180 = 1988.
  // Rotated body left on screen: 1988 - 150 = 1838.
  // Portion on screen: 1920 - 1838 = 82 px ≈ 55%!
})

test('EdgeProbeMachine: full lifecycle from entry to click, straighten, hold, and return', () => {
  const machine = new EdgeProbeMachine()
  assert.equal(machine.getState(), 'OFF')
  assert.equal(machine.isActive(), false)

  const monitor: ScreenRect = { left: 0, top: 0, width: 1920, height: 1080 }
  const metrics: PetRenderMetricsLite = {
    canvas: { width: 129, height: 140 },
    body: { width: 129, height: 140 },
    hitbox: { left: 0, top: 0, width: 129, height: 140 },
  }

  // 1. Drag release at left edge -> enters ENTERING
  const side = machine.onDragEnded({ x: 10, y: 400 }, metrics, monitor, 1000)
  assert.equal(side, 'left')
  assert.equal(machine.getState(), 'ENTERING')
  assert.equal(machine.getSide(), 'left')

  // Tick midway through ENTERING (150ms of 300ms)
  const midway = machine.tick(1150)
  assert.equal(midway.stateChanged, false)
  assert.ok(machine.getAngle() > 0 && machine.getAngle() < 45)
  assert.ok(machine.getExposure() < 1.0 && machine.getExposure() > 0.55)

  // Tick after 300ms -> settles in PEEKING
  const settled = machine.tick(1300)
  assert.equal(settled.stateChanged, true)
  assert.equal(machine.getState(), 'PEEKING')
  assert.equal(machine.getAngle(), 45)
  assert.equal(machine.getExposure(), 0.55)

  // 2. Click while PEEKING -> enters STRAIGHTENING
  const clicked = machine.onClicked(2000)
  assert.equal(clicked, true)
  assert.equal(machine.getState(), 'STRAIGHTENING')

  // Tick after 250ms -> settles in STRAIGHTENED
  const straightened = machine.tick(2250)
  assert.equal(straightened.stateChanged, true)
  assert.equal(machine.getState(), 'STRAIGHTENED')
  assert.equal(machine.getAngle(), 0)
  assert.equal(machine.getExposure(), 0.82)

  // 3. Repeated click during STRAIGHTENED resets 5s hold timer
  machine.tick(4000) // 1.75s elapsed
  assert.equal(machine.getState(), 'STRAIGHTENED')
  machine.onClicked(4000) // Reset 5s timer

  // 4s later, still in STRAIGHTENED because timer was reset
  machine.tick(8000)
  assert.equal(machine.getState(), 'STRAIGHTENED')

  // When full 5s passes from 4000 (at 9001ms) -> transitions to RETURNING
  const returning = machine.tick(9001)
  assert.equal(returning.stateChanged, true)
  assert.equal(machine.getState(), 'RETURNING')

  // Tick after 300ms -> settles back to PEEKING
  const backToPeek = machine.tick(9301)
  assert.equal(backToPeek.stateChanged, true)
  assert.equal(machine.getState(), 'PEEKING')
  assert.equal(machine.getAngle(), 45)
  assert.equal(machine.getExposure(), 0.55)

  // 4. Drag start immediately cancels to OFF
  machine.onDragStarted()
  assert.equal(machine.getState(), 'OFF')
  assert.equal(machine.isActive(), false)
  assert.equal(machine.getAngle(), 0)
  assert.equal(machine.getExposure(), 1.0)
})

test('EdgeProbeMachine: right edge mirror handling', () => {
  const machine = new EdgeProbeMachine()
  const monitor: ScreenRect = { left: 0, top: 0, width: 1920, height: 1080 }
  const metrics: PetRenderMetricsLite = {
    canvas: { width: 129, height: 140 },
    body: { width: 129, height: 140 },
    hitbox: { left: 0, top: 0, width: 129, height: 140 },
  }

  // Drop at right edge (1920 - 129 = 1791)
  const side = machine.onDragEnded({ x: 1790, y: 400 }, metrics, monitor, 0)
  assert.equal(side, 'right')
  assert.equal(machine.getSide(), 'right')

  machine.tick(300)
  assert.equal(machine.getState(), 'PEEKING')
  // Right side tilts to -45 deg
  assert.equal(machine.getAngle(), -45)
  assert.equal(machine.getExposure(), 0.55)
})

test('EdgeProbeMachine: transformOrigin reflects body center and isTransitioning tracks state', () => {
  const machine = new EdgeProbeMachine()
  // VideoPet with offset hitbox: canvas 300x300, hitbox left=50, top=60, body 100x120
  const metrics: PetRenderMetricsLite = {
    canvas: { width: 300, height: 300 },
    body: { width: 100, height: 120 },
    hitbox: { left: 50, top: 60, width: 100, height: 120 },
  }

  // Pivot should be at 50 + 50 = 100, 60 + 60 = 120
  machine.startEntering('left', metrics, 1000)
  assert.equal(machine.isTransitioning(), true)

  const tickResult = machine.tick(1100)
  assert.equal(tickResult.isTransitioning, true)
  assert.equal(tickResult.pose.transformOrigin, '100px 120px')
  assert.notEqual(tickResult.pose.transformOrigin, '0px 0px')

  // Completing enter settles into PEEKING
  const peekResult = machine.tick(1300)
  assert.equal(peekResult.isTransitioning, false)
  assert.equal(machine.isTransitioning(), false)
  assert.equal(peekResult.pose.state, 'PEEKING')
  assert.equal(peekResult.pose.transformOrigin, '100px 120px')

  // Straightening transition
  machine.onClicked(2000)
  assert.equal(machine.isTransitioning(), true)
  const straightResult = machine.tick(2250)
  assert.equal(straightResult.isTransitioning, false)
  assert.equal(machine.isTransitioning(), false)
  assert.equal(straightResult.pose.state, 'STRAIGHTENED')

  // Returning transition via startReturning
  const returned = machine.startReturning(7250)
  assert.equal(returned, true)
  assert.equal(machine.isTransitioning(), true)
  const returnResult = machine.tick(7550)
  assert.equal(returnResult.isTransitioning, false)
  assert.equal(returnResult.pose.state, 'PEEKING')
})
