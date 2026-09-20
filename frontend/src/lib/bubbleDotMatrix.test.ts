import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GRID_SIZE,
  TOTAL_DOTS,
  DOT_INDEXES,
  MATRIX_DIMENSIONS,
  hashDotMatrix,
  toDotMatrixState,
  getDotParameters,
  ELLIPSIS_GLYPH,
  WARNING_GLYPH,
  THINKING_RESTING_GLYPH,
  LOADING_RESTING_GLYPH,
} from './bubbleDotMatrix.ts'

test('bubbleDotMatrix: grid and dimension invariant verification', () => {
  assert.equal(GRID_SIZE, 5, 'Grid size must be 5×5')
  assert.equal(TOTAL_DOTS, 25, 'Total dots must be exactly 25')
  assert.equal(DOT_INDEXES.length, 25, 'DOT_INDEXES array must contain exactly 25 elements')
  assert.deepEqual(MATRIX_DIMENSIONS.detailed, { width: 14, height: 14 }, 'Detailed footprint must be 14×14')
  assert.deepEqual(MATRIX_DIMENSIONS.compact, { width: 10, height: 10 }, 'Compact footprint must be 10×10')
})

test('bubbleDotMatrix: toDotMatrixState maps all 4 status kinds accurately', () => {
  assert.equal(toDotMatrixState('working'), 'thinking', 'working must map to thinking')
  assert.equal(toDotMatrixState('running'), 'loading', 'running must map to loading')
  assert.equal(toDotMatrixState('answer'), 'waiting', 'answer must map to waiting')
  assert.equal(toDotMatrixState('approval'), 'warning', 'approval must map to warning')
})

test('bubbleDotMatrix: hashDotMatrix is purely deterministic without random/timers', () => {
  // Same inputs must produce exact same output every time
  for (let i = 0; i < 25; i++) {
    const val1 = hashDotMatrix(i, 2, 700)
    const val2 = hashDotMatrix(i, 2, 700)
    assert.equal(val1, val2, `Hash must be deterministic for index ${i}`)
    assert.ok(val1 >= 0 && val1 <= 0.7, `Hash result ${val1} must be within range [0, 0.7]`)
  }

  // Adjacent dots should have distinct hash values (no synchronized column wave)
  const val0 = hashDotMatrix(0, 1, 1200)
  const val1 = hashDotMatrix(1, 1, 1200)
  const val5 = hashDotMatrix(5, 1, 1200)
  assert.notEqual(val0, val1, 'Adjacent horizontal dots must not correlate')
  assert.notEqual(val0, val5, 'Adjacent vertical dots must not correlate')
})

test('bubbleDotMatrix: thinking state has diagonal wave in normal mode', () => {
  for (let i = 0; i < TOTAL_DOTS; i++) {
    const dot = getDotParameters('thinking', i)
    assert.equal(dot.isOn, true, `All dots must be active in thinking, dot ${i} failed`)
    assert.equal(dot.hi, 1, `Base opacity must be 1 for dot ${i}`)
    assert.equal(dot.duration, 1.2, `Duration must be 1.2s for thinking`)
    const expectedDelay = -(dot.row + dot.col) * 0.09
    assert.ok(
      Math.abs((dot.delay ?? 0) - expectedDelay) < 1e-6,
      `Dot ${i} at (${dot.row}, ${dot.col}) should have diagonal wave delay ${expectedDelay}, got ${dot.delay}`
    )
  }
})

test('bubbleDotMatrix: loading state has deterministic randomized twinkle across all 25 dots', () => {
  const delays = new Set<number>()
  for (let i = 0; i < TOTAL_DOTS; i++) {
    const dot = getDotParameters('loading', i)
    assert.equal(dot.isOn, true, `All dots must be active in loading, dot ${i} failed`)
    assert.equal(dot.hi, 1, `Base opacity must be 1 for dot ${i}`)
    assert.equal(dot.lo, 0.15, `Low opacity must be 0.15 for loading`)
    assert.ok(dot.duration && dot.duration >= 0.9 && dot.duration <= 1.6, `Duration out of expected range: ${dot.duration}`)
    if (dot.delay !== undefined) {
      delays.add(dot.delay)
    }
  }
  // At least 20 distinct delays across 25 dots proves high entropy twinkle
  assert.ok(delays.size >= 20, `Expected diverse delays for twinkle, got ${delays.size} unique values`)
})

test('bubbleDotMatrix: waiting state activates exactly 3 horizontal ellipsis dots', () => {
  assert.equal(ELLIPSIS_GLYPH.size, 3, 'Ellipsis glyph must contain exactly 3 dots')
  assert.ok(ELLIPSIS_GLYPH.has(10), 'Must include [2, 0] (index 10)')
  assert.ok(ELLIPSIS_GLYPH.has(12), 'Must include [2, 2] (index 12)')
  assert.ok(ELLIPSIS_GLYPH.has(14), 'Must include [2, 4] (index 14)')

  let onCount = 0
  let offCount = 0
  for (let i = 0; i < TOTAL_DOTS; i++) {
    const dot = getDotParameters('waiting', i)
    if (dot.isOn) {
      onCount++
      assert.equal(dot.hi, 1, `On dot ${i} must have hi = 1`)
      assert.equal(dot.lo, 0.2, `On dot ${i} must blink down to lo = 0.2`)
      assert.equal(dot.row, 2, `On dot ${i} must be on middle row 2`)
      assert.equal(dot.resting, 1, `On dot ${i} must have resting = 1`)
    } else {
      offCount++
      assert.equal(dot.hi, 0.15, `Off dot ${i} must rest at dim = 0.15`)
      assert.equal(dot.lo, 0.15, `Off dot ${i} must stay at dim = 0.15 without blinking`)
      assert.equal(dot.duration, undefined, `Off dot ${i} must not have blink animation`)
      assert.equal(dot.resting, 0.15, `Off dot ${i} must have resting = 0.15`)
    }
  }
  assert.equal(onCount, 3, 'Must have exactly 3 on dots')
  assert.equal(offCount, 22, 'Must have exactly 22 dim resting dots')
})

test('bubbleDotMatrix: warning state activates exclamation mark glyph with slow synchronized pulse', () => {
  assert.equal(WARNING_GLYPH.size, 4, 'Warning glyph must contain exactly 4 dots')
  assert.ok(WARNING_GLYPH.has(2), 'Must include stem top [0, 2] (index 2)')
  assert.ok(WARNING_GLYPH.has(7), 'Must include stem mid [1, 2] (index 7)')
  assert.ok(WARNING_GLYPH.has(12), 'Must include stem bottom [2, 2] (index 12)')
  assert.ok(WARNING_GLYPH.has(22), 'Must include dot [4, 2] (index 22)')
  assert.ok(!WARNING_GLYPH.has(17), 'Must NOT include gap at [3, 2] (index 17)')

  let onCount = 0
  let offCount = 0
  for (let i = 0; i < TOTAL_DOTS; i++) {
    const dot = getDotParameters('warning', i)
    if (dot.isOn) {
      onCount++
      assert.equal(dot.hi, 1, `Warning dot ${i} must have hi = 1`)
      assert.equal(dot.lo, 0.45, `Warning dot ${i} must have lo = 0.45`)
      assert.equal(dot.duration, 1.6, `Warning dot ${i} must have 1.6s period`)
      assert.equal(dot.delay, 0, `Warning dots must pulse synchronously with 0s delay`)
      assert.equal(dot.resting, 1, `Warning dot ${i} must have resting = 1`)
    } else {
      offCount++
      assert.equal(dot.hi, 0.15, `Off dot ${i} must rest at dim = 0.15`)
      assert.equal(dot.duration, undefined, `Off dot ${i} must not have blink animation`)
      assert.equal(dot.resting, 0.15, `Off dot ${i} must have resting = 0.15`)
    }
  }
  assert.equal(onCount, 4, 'Must have exactly 4 on dots')
  assert.equal(offCount, 21, 'Must have exactly 21 dim resting dots')
})

test('bubbleDotMatrix: reduced-motion resting patterns distinctly differentiate thinking and loading', () => {
  // Thinking resting pattern: exactly 5 dots along the diagonal [0,0], [1,1], [2,2], [3,3], [4,4]
  assert.equal(THINKING_RESTING_GLYPH.size, 5, 'Thinking resting glyph must have 5 diagonal dots')
  for (let r = 0; r < 5; r++) {
    assert.ok(THINKING_RESTING_GLYPH.has(r * 5 + r), `Thinking resting glyph must have [${r}, ${r}]`)
  }

  // Loading resting pattern: fixed set of 8 scattered constellation dots
  assert.equal(LOADING_RESTING_GLYPH.size, 8, 'Loading resting glyph must have 8 scattered dots')

  // Verify that thinking and loading have distinct resting opacity vectors
  const thinkingRestingVector: number[] = []
  const loadingRestingVector: number[] = []

  for (let i = 0; i < TOTAL_DOTS; i++) {
    const thinkingDot = getDotParameters('thinking', i)
    const loadingDot = getDotParameters('loading', i)

    thinkingRestingVector.push(thinkingDot.resting)
    loadingRestingVector.push(loadingDot.resting)

    if (THINKING_RESTING_GLYPH.has(i)) {
      assert.equal(thinkingDot.resting, 1, `Thinking diagonal dot ${i} must rest at 1.0`)
    } else {
      assert.equal(thinkingDot.resting, 0.2, `Thinking non-diagonal dot ${i} must rest at 0.2`)
    }

    if (LOADING_RESTING_GLYPH.has(i)) {
      assert.equal(loadingDot.resting, 1, `Loading constellation dot ${i} must rest at 1.0`)
    } else {
      assert.equal(loadingDot.resting, 0.2, `Loading background dot ${i} must rest at 0.2`)
    }
  }

  // Invariant: resting patterns must NOT be identical under reduced motion
  assert.notDeepEqual(
    thinkingRestingVector,
    loadingRestingVector,
    'Thinking and loading resting patterns must be distinctly different under reduced motion'
  )
})
