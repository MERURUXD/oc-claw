import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDebugSession,
  isDebugInjectSession,
  isInteractiveSession,
  mergeSessionsWithDebugInject,
} from './debugInject.ts'

test('merge preserves inject sessions and strips stale debug from polled', () => {
  const inject = [buildDebugSession('processing-generic')]
  const polled = [
    { sessionId: 'real-1', status: 'processing' },
    { sessionId: 'debug-inject-stale', status: 'waiting' },
  ]
  const merged = mergeSessionsWithDebugInject(polled, inject)
  assert.deepEqual(
    merged.map((s) => s.sessionId),
    ['real-1', 'debug-inject-processing-generic'],
  )
  assert.equal(merged.some((s) => s.sessionId === 'debug-inject-stale'), false)
})

test('merge strips stale debug even when inject is empty (clear)', () => {
  const polled = [
    { sessionId: 'real-1' },
    { sessionId: 'debug-inject-waiting-approval' },
  ]
  const merged = mergeSessionsWithDebugInject(polled, [])
  assert.deepEqual(merged.map((s) => s.sessionId), ['real-1'])
})

test('isDebugInjectSession / isInteractiveSession guard fake ids', () => {
  const fake = buildDebugSession('waiting-approval')
  assert.equal(isDebugInjectSession(fake), true)
  assert.equal(isInteractiveSession(fake), false)
  assert.equal(isInteractiveSession({ sessionId: 'real-cc-1' }), true)
  assert.equal(isInteractiveSession(null), false)
})
