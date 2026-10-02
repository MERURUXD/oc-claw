import test from 'node:test'
import assert from 'node:assert/strict'
import { submitClaudePermission } from './claudePermission.ts'

test('queued approval stays disabled/open and failed socket delivery shows an error', async () => {
  let rejectDelivery!: (reason: Error) => void
  const delivery = new Promise<void>((_, reject) => { rejectDelivery = reject })
  let busy = false
  let error = ''
  let collapsed = false
  const submission = submitClaudePermission({
    // Local enqueue succeeded; the command is still waiting for writer ack.
    deliver: () => delivery,
    isCurrent: () => true,
    setBusy: (value) => { busy = value },
    setError: (value) => { error = value },
    onDelivered: () => { collapsed = true },
  })
  assert.equal(busy, true)
  assert.equal(collapsed, false)
  rejectDelivery(new Error('Approval response was not delivered; approve in Claude'))
  await submission
  assert.equal(collapsed, false)
  assert.equal(busy, false)
  assert.match(error, /not delivered/)
})

test('only confirmed delivery for the current request may collapse the panel', async () => {
  for (const current of [true, false]) {
    let acknowledge!: () => void
    const delivery = new Promise<void>((resolve) => { acknowledge = resolve })
    let collapsed = false
    const submission = submitClaudePermission({
      deliver: () => delivery,
      isCurrent: () => current,
      setBusy: () => {},
      setError: () => {},
      onDelivered: () => { collapsed = true },
    })
    assert.equal(collapsed, false)
    acknowledge()
    await submission
    assert.equal(collapsed, current)
  }
})
