import assert from 'node:assert/strict'
import test from 'node:test'
import { canExpandMascotPanel, canStartMascotPointerInteraction } from './mascotInteraction.ts'

test('mascot drag and panel expansion cannot own the native window at the same time', () => {
  assert.equal(canExpandMascotPanel({ dragging: false, expanding: false, collapsing: false }), true)
  assert.equal(canExpandMascotPanel({ dragging: true, expanding: false, collapsing: false }), false)
  assert.equal(canExpandMascotPanel({ dragging: false, expanding: true, collapsing: false }), false)
  assert.equal(canExpandMascotPanel({ dragging: false, expanding: false, collapsing: true }), false)
})

test('mascot pointer interaction does not start after panel expansion has begun', () => {
  assert.equal(canStartMascotPointerInteraction(false), true)
  assert.equal(canStartMascotPointerInteraction(true), false)
})
