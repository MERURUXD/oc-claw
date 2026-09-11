import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeTraceDetails } from './bubbleTrace.ts'

test('sanitizeTraceDetails converts primitives to string and omits undefined/null', () => {
  const input = {
    transition: 42,
    phase: 'visible',
    enabled: true,
    unset: undefined,
    nil: null,
    w: 240.5,
  }
  const result = sanitizeTraceDetails(input)
  assert.deepEqual(result, {
    transition: '42',
    phase: 'visible',
    enabled: 'true',
    w: '240.5',
  })
})

test('sanitizeTraceDetails returns null for undefined or empty object', () => {
  assert.equal(sanitizeTraceDetails(undefined), null)
  assert.equal(sanitizeTraceDetails({}), null)
  assert.equal(sanitizeTraceDetails({ a: undefined, b: null }), null)
})
