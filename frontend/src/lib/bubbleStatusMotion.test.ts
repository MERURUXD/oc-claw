import test from 'node:test'
import assert from 'node:assert/strict'
import { MODE_FRAMES, STATE_TO_MODE, resolvePreset } from 'thinking-orbs/engine'
import { scaleCounts, scaleRadii } from 'thinking-orbs'
import { MATRIX_DIMENSIONS } from './bubbleDotMatrix.ts'
import {
  BUBBLE_STATUS_MOTION_DEFAULT,
  BUBBLE_STATUS_MOTION_STORE_KEY,
  BUBBLE_STATUS_MOTION_VALUES,
  ORB_GEOMETRY,
  isBubbleStatusMotion,
  normalizeBubbleStatusMotion,
  readBubbleStatusMotionFromHash,
  resolveBubbleOrbInk,
  toOrbState,
} from './bubbleStatusMotion.ts'

const MATRIX_STATES = ['thinking', 'loading', 'waiting', 'warning'] as const

test('bubbleStatusMotion: matrix remains the default and only the two known styles are accepted', () => {
  assert.equal(BUBBLE_STATUS_MOTION_DEFAULT, 'matrix', 'existing installs must keep the shipped dot matrix')
  assert.equal(BUBBLE_STATUS_MOTION_STORE_KEY, 'bubble_status_motion')
  assert.deepEqual([...BUBBLE_STATUS_MOTION_VALUES], ['matrix', 'orbs'])
  assert.equal(isBubbleStatusMotion('orbs'), true)
  assert.equal(isBubbleStatusMotion('matrix'), true)
  assert.equal(isBubbleStatusMotion('spinner'), false)
  assert.equal(isBubbleStatusMotion(undefined), false)
  assert.equal(normalizeBubbleStatusMotion('orbs'), 'orbs', 'stored values pass through')
  assert.equal(normalizeBubbleStatusMotion(null), null, 'unknown values must not restyle the bubble')
  assert.equal(normalizeBubbleStatusMotion(42), null)
})

test('bubbleStatusMotion: hash override enables the browser preview', () => {
  assert.equal(readBubbleStatusMotionFromHash('#/mascot-bubble?motion=orbs'), 'orbs')
  assert.equal(readBubbleStatusMotionFromHash('#/mascot-bubble?debug=1&motion=matrix'), 'matrix')
  assert.equal(readBubbleStatusMotionFromHash('#/mascot-bubble'), null, 'no query means no override')
  assert.equal(readBubbleStatusMotionFromHash('#/mascot-bubble?motion=globe'), null, 'unknown style is ignored')
  assert.equal(readBubbleStatusMotionFromHash(undefined), null)
})

test('bubbleStatusMotion: every dot-matrix state maps to an orb state the library ships', () => {
  for (const state of MATRIX_STATES) {
    const orb = toOrbState(state)
    assert.ok(
      Object.prototype.hasOwnProperty.call(STATE_TO_MODE, orb),
      `${state} must map to a real thinking-orbs state, got ${orb}`
    )
  }
  assert.equal(toOrbState('thinking'), 'breathing', 'working reads as the library\u2019s Thinking… state')
  assert.equal(toOrbState('loading'), 'working', 'running commands read as orbiting particles')
  assert.equal(toOrbState('waiting'), 'listening', 'awaiting an answer reads as the waveform')
  assert.equal(toOrbState('warning'), 'solving', 'awaiting approval reads as the scrambling bands')
  // Distinct statuses must stay visually distinguishable.
  assert.equal(new Set(MATRIX_STATES.map(toOrbState)).size, MATRIX_STATES.length)
})

test('bubbleStatusMotion: orb box equals the dot-matrix box so bubble geometry is unchanged', () => {
  for (const size of ['detailed', 'compact'] as const) {
    const geometry = ORB_GEOMETRY[size]
    assert.equal(geometry.displaySize, MATRIX_DIMENSIONS[size].width, `${size} width must match the matrix`)
    assert.equal(geometry.displaySize, MATRIX_DIMENSIONS[size].height, `${size} box must be square`)
    assert.equal(geometry.presetSize, 20, '20 is the tuned inline-text design; smaller values fall off a preset')
    assert.ok(geometry.dots > 0 && geometry.dots <= 1, `${size} density must be tuned down for a tiny box`)
    assert.ok(geometry.dotSize >= 1, `${size} marks must not get finer than the tuned 20px design`)
    assert.ok(geometry.speed > 0 && geometry.speed <= 1.5, `${size} speed must stay calm`)
  }
})

test('bubbleStatusMotion: currentColor resolves to a tint plus its alpha', () => {
  assert.deepEqual(resolveBubbleOrbInk('rgb(129, 140, 248)'), { color: '#818cf8', opacity: 1 })
  assert.deepEqual(
    resolveBubbleOrbInk('rgba(251, 191, 36, 0.9)'),
    { color: '#fbbf24', opacity: 0.9 },
    'the alpha the orb tint drops is re-applied to the canvas'
  )
  assert.deepEqual(resolveBubbleOrbInk('rgba(255, 255, 255, 0.72)'), { color: '#ffffff', opacity: 0.72 })
  assert.deepEqual(resolveBubbleOrbInk('#fbbf24'), { color: '#fbbf24', opacity: 1 })
  assert.deepEqual(resolveBubbleOrbInk('#fff'), { color: '#ffffff', opacity: 1 })
  assert.deepEqual(
    resolveBubbleOrbInk('rgba(255 255 255 / 72%)'),
    { color: '#ffffff', opacity: 0.72 },
    'percentage alpha must scale, not clamp to opaque'
  )
  assert.deepEqual(
    resolveBubbleOrbInk('rgb(0 0 0 / 0.5)'),
    { color: '#000000', opacity: 0.5 },
    'space-separated syntax must not blow up'
  )
  for (const bad of ['', null, undefined, 'transparent', 'currentColor', 'rgb(a,b,c)']) {
    assert.deepEqual(resolveBubbleOrbInk(bad), { color: '#ffffff', opacity: 1 }, `${bad} must fall back`)
  }
  const clamped = resolveBubbleOrbInk('rgb(300, -20, 12.4)')
  assert.equal(clamped.color, '#ff000c', 'channels must clamp to 8-bit range')
})

test('bubbleStatusMotion: engine frames stay inside the box at both bubble sizes', () => {
  for (const size of ['detailed', 'compact'] as const) {
    const { presetSize, dots, dotSize } = ORB_GEOMETRY[size]
    for (const matrixState of MATRIX_STATES) {
      const orbState = toOrbState(matrixState)
      const preset = resolvePreset(orbState, presetSize)
      assert.ok(preset.speed > 0, `${orbState} must resolve a tuned speed at ${presetSize}px`)
      const frameFn = MODE_FRAMES[preset.mode]
      assert.equal(typeof frameFn, 'function', `mode ${preset.mode} must exist`)
      // Same multipliers the component hands to <ThinkingOrb>, so this covers
      // the geometry the bubble actually paints — not just the raw preset.
      const opts = scaleRadii(
        scaleCounts({ ...preset.opts }, Math.max(0.1, dots)),
        Math.max(0.1, dotSize)
      )

      for (const t of [0, 0.37, 1.2, 4.9]) {
        const { dots: frameDots, lines } = frameFn(presetSize, t * preset.speed, opts)
        assert.ok(frameDots.length > 0, `${orbState}@${size} t=${t} must paint something`)
        assert.ok(
          frameDots.length + lines.length < 400,
          `${orbState}@${size} must stay sparse enough to read at ${ORB_GEOMETRY[size].displaySize}px`
        )
        for (const d of frameDots) {
          assert.ok(Number.isFinite(d.x) && Number.isFinite(d.y), `${orbState}@${size} needs finite centres`)
          assert.ok(d.r > 0 && d.r <= presetSize / 2, `${orbState}@${size} radius ${d.r} out of range`)
          assert.ok(d.white >= 0 && d.white <= 1, `${orbState}@${size} ink value out of range`)
          assert.ok((d.a ?? 1) >= 0 && (d.a ?? 1) <= 1, `${orbState}@${size} alpha out of range`)
          assert.ok(d.x >= -1 && d.x <= presetSize + 1 && d.y >= -1 && d.y <= presetSize + 1,
            `${orbState}@${size} mark must stay in the box`)
        }
      }
    }
  }
})
