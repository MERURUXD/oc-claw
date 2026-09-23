import assert from 'node:assert/strict'
import test from 'node:test'
import { canApplyCollapsedMascotGeometry, createLatestWinsSerialQueue } from './miniPetGeometry.ts'

test('collapsed mascot geometry is gated while panel and modal layouts own the native window', () => {
  const collapsed = {
    expanded: false,
    settingsMode: false,
    settingsTransitioning: false,
    updateModalOpen: false,
    onboardingOpen: false,
    hiding: false,
  }
  assert.equal(canApplyCollapsedMascotGeometry(collapsed), true)
  assert.equal(canApplyCollapsedMascotGeometry({ ...collapsed, expanded: true }), false)
  assert.equal(canApplyCollapsedMascotGeometry({ ...collapsed, settingsMode: true }), false)
  assert.equal(canApplyCollapsedMascotGeometry({ ...collapsed, settingsTransitioning: true }), false)
  assert.equal(canApplyCollapsedMascotGeometry({ ...collapsed, updateModalOpen: true }), false)
  assert.equal(canApplyCollapsedMascotGeometry({ ...collapsed, onboardingOpen: true }), false)
  assert.equal(canApplyCollapsedMascotGeometry({ ...collapsed, hiding: true }), false)
})

test('native resize queue serializes active requests and skips obsolete pending requests', async () => {
  const started: number[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const applied: number[] = []
  const queue = createLatestWinsSerialQueue(async (value: number) => {
    started.push(value)
    if (value === 1) await firstGate
    applied.push(value)
  })

  const request1 = queue.enqueue(1)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const request2 = queue.enqueue(2)
  const request3 = queue.enqueue(3)
  releaseFirst()
  await Promise.all([request1, request2, request3])

  assert.deepEqual(started, [1, 3])
  assert.deepEqual(applied, [1, 3])
})

test('invalidating a pending geometry prevents it from applying after a mode transition', async () => {
  const started: number[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const queue = createLatestWinsSerialQueue(async (value: number) => {
    started.push(value)
    if (value === 1) await firstGate
  })

  const request1 = queue.enqueue(1)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const request2 = queue.enqueue(2)
  queue.invalidate()
  releaseFirst()
  await Promise.all([request1, request2])

  assert.deepEqual(started, [1])
})

test('a pending clear supersedes queued VideoPet bounds', async () => {
  const started: Array<number | null> = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const queue = createLatestWinsSerialQueue(async (value: number | null) => {
    started.push(value)
    if (value === 1) await firstGate
  })

  const request1 = queue.enqueue(1)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const obsoleteBounds = queue.enqueue(2)
  const clear = queue.enqueue(null)
  releaseFirst()
  await Promise.all([request1, obsoleteBounds, clear])

  assert.deepEqual(started, [1, null])
})
