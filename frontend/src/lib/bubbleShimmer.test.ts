import test from 'node:test'
import assert from 'node:assert/strict'
import { SHIMMER_TIMING, isShimmerActive } from './bubbleShimmer.ts'

test('bubbleShimmer: timing constants invariants', () => {
  assert.equal(SHIMMER_TIMING.initialDelayMs, 600, 'Initial delay should be 600ms')
  assert.equal(SHIMMER_TIMING.activeMs, 1800, 'Sweep animation duration should be 1800ms')
  assert.equal(SHIMMER_TIMING.intervalMs, 4200, 'Cycle interval should be 4200ms')
  assert.ok(SHIMMER_TIMING.intervalMs > SHIMMER_TIMING.activeMs, 'Interval must be longer than active sweep')
  const pauseMs = SHIMMER_TIMING.intervalMs - SHIMMER_TIMING.activeMs
  assert.equal(pauseMs, 2400, 'Quiet resting gap should be exactly 2400ms')
})

test('bubbleShimmer: isShimmerActive identifies active vs waiting states accurately', () => {
  // Active states
  assert.equal(isShimmerActive('processing', 'working'), true, 'processing + working must shimmer')
  assert.equal(isShimmerActive('tool_running', 'running'), true, 'tool_running + running must shimmer')
  assert.equal(isShimmerActive('processing', 'running'), true, 'processing + running must shimmer')
  assert.equal(isShimmerActive('tool_running', 'working'), true, 'tool_running + working must shimmer')

  // Waiting states should not shimmer
  assert.equal(isShimmerActive('waiting', 'answer'), false, 'waiting + answer must not shimmer')
  assert.equal(isShimmerActive('waiting', 'approval'), false, 'waiting + approval must not shimmer')
  assert.equal(isShimmerActive('processing', 'answer'), false, 'answer waiting kind must not shimmer')
  assert.equal(isShimmerActive('processing', 'approval'), false, 'approval waiting kind must not shimmer')
  assert.equal(isShimmerActive('tool_running', 'answer'), false, 'tool_running + answer must not shimmer')
  assert.equal(isShimmerActive('tool_running', 'approval'), false, 'tool_running + approval must not shimmer')

  // Inactive / idle states
  assert.equal(isShimmerActive('idle', 'working'), false, 'idle + working must not shimmer')
  assert.equal(isShimmerActive('completed', 'working'), false, 'completed must not shimmer')
  assert.equal(isShimmerActive(undefined, undefined), false, 'empty state must not shimmer')
})
