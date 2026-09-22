import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createQuotaRecoveryStateMachine,
  calculateRemainingPercent,
  computeResetCheckDelay,
  extractQuotaWindows,
  QUOTA_LOW_REMAINING_THRESHOLD,
  RESET_GRACE_PERIOD_MS,
  RESET_RETRY_INTERVAL_MS,
  MAX_RESET_RETRIES,
} from './quotaRecovery.ts'
import type { HarnessQuotaSummary } from './types.ts'

function createSummary(
  harness: 'codex' | 'antigravity',
  windows: { label: string; percent: number; resets_at?: string | null }[],
  connected = true,
): HarnessQuotaSummary {
  const primary = windows[0] || null
  const details = windows.slice(1)
  return {
    harness,
    connected,
    plan_label: 'Pro',
    primary,
    details,
    updated_at: Date.now(),
  }
}

test('computeResetCheckDelay: handles null, invalid, future, and bounded retries for past targets', () => {
  assert.equal(computeResetCheckDelay(null), null)
  assert.equal(computeResetCheckDelay(undefined), null)
  assert.equal(computeResetCheckDelay('not-a-date'), null)

  const now = 1000000000000
  // Target 10 seconds in future: delay should be 10000 + 3000 = 13000ms
  const targetFuture = new Date(now + 10000).toISOString()
  assert.equal(computeResetCheckDelay(targetFuture, now, 0), 13000)

  // Target in the past:
  const targetPast = new Date(now - 5000).toISOString()
  // retryCount 0 -> grace period (3000ms)
  assert.equal(computeResetCheckDelay(targetPast, now, 0), RESET_GRACE_PERIOD_MS)
  // retryCount 1, 2 -> 30s retry interval
  assert.equal(computeResetCheckDelay(targetPast, now, 1), RESET_RETRY_INTERVAL_MS)
  assert.equal(computeResetCheckDelay(targetPast, now, 2), RESET_RETRY_INTERVAL_MS)
  // retryCount >= MAX_RESET_RETRIES (3) -> null (stop retrying)
  assert.equal(computeResetCheckDelay(targetPast, now, MAX_RESET_RETRIES), null)
  assert.equal(computeResetCheckDelay(targetPast, now, MAX_RESET_RETRIES + 1), null)
})

test('calculateRemainingPercent: bounds and calculation', () => {
  assert.equal(QUOTA_LOW_REMAINING_THRESHOLD, 10)
  assert.equal(calculateRemainingPercent(0), 100)
  assert.equal(calculateRemainingPercent(90), 10)
  assert.equal(calculateRemainingPercent(91), 9)
  assert.equal(calculateRemainingPercent(95), 5)
  assert.equal(calculateRemainingPercent(100), 0)
  assert.equal(calculateRemainingPercent(-10), 100)
  assert.equal(calculateRemainingPercent(150), 0)
  assert.equal(calculateRemainingPercent(NaN), 0)
})

test('extractQuotaWindows: handles primary and details without duplication', () => {
  const summary: HarnessQuotaSummary = {
    harness: 'codex',
    connected: true,
    primary: { label: '5-hour', percent: 80 },
    details: [
      { label: '5-hour', percent: 80 }, // duplicate of primary
      { label: '1-day', percent: 50 },
    ],
    updated_at: Date.now(),
  }
  const windows = extractQuotaWindows(summary)
  assert.equal(windows.length, 2)
  assert.equal(windows[0].label, '5-hour')
  assert.equal(windows[1].label, '1-day')
})

test('quota recovery: 首次 100% 保持 normal，不触发恢复', () => {
  const sm = createQuotaRecoveryStateMachine()
  const event = sm.processQuotaSummary(createSummary('codex', [{ label: '5h', percent: 0 }]))
  assert.equal(event, null)
  assert.equal(sm.getWindowState('codex', '5h'), 'normal')
  assert.equal(sm.getArmedWindows().length, 0)
})

test('quota recovery: 首次 5% 进入 armed，但不触发恢复', () => {
  const sm = createQuotaRecoveryStateMachine()
  // used = 95% -> remaining = 5% < 10%
  const event = sm.processQuotaSummary(
    createSummary('codex', [{ label: '5h', percent: 95, resets_at: '2026-09-22T16:00:00Z' }]),
  )
  assert.equal(event, null)
  assert.equal(sm.getWindowState('codex', '5h'), 'armed')
  const armed = sm.getArmedWindows()
  assert.equal(armed.length, 1)
  assert.equal(armed[0].harness, 'codex')
  assert.equal(armed[0].label, '5h')
  assert.equal(armed[0].resetsAt, '2026-09-22T16:00:00Z')
})

test('quota recovery: 9% -> 8% 持续保持 armed，不触发恢复', () => {
  const sm = createQuotaRecoveryStateMachine()
  // 9% remaining (used 91%)
  sm.processQuotaSummary(createSummary('codex', [{ label: '5h', percent: 91 }]))
  assert.equal(sm.getWindowState('codex', '5h'), 'armed')

  // 8% remaining (used 92%)
  const event = sm.processQuotaSummary(createSummary('codex', [{ label: '5h', percent: 92 }]))
  assert.equal(event, null)
  assert.equal(sm.getWindowState('codex', '5h'), 'armed')
})

test('quota recovery: 9% -> 10% 边界值触发一次恢复', () => {
  const sm = createQuotaRecoveryStateMachine()
  // used 91% -> remaining 9% (<10%) -> armed
  sm.processQuotaSummary(createSummary('codex', [{ label: '5h', percent: 91 }]))
  assert.equal(sm.getWindowState('codex', '5h'), 'armed')

  // used 90% -> remaining 10% (>=10%) -> recovered!
  const event = sm.processQuotaSummary(createSummary('codex', [{ label: '5h', percent: 90 }]))
  assert.notEqual(event, null)
  assert.equal(event?.harness, 'codex')
  assert.deepEqual(event?.recoveredWindows, ['5h'])
  assert.equal(sm.getWindowState('codex', '5h'), 'normal')

  // next observation at 10% again -> no duplicate recovery
  const nextEvent = sm.processQuotaSummary(createSummary('codex', [{ label: '5h', percent: 90 }]))
  assert.equal(nextEvent, null)
})

test('quota recovery: 9% -> 100% 触发一次恢复', () => {
  const sm = createQuotaRecoveryStateMachine()
  // 9% remaining -> armed
  sm.processQuotaSummary(createSummary('antigravity', [{ label: 'daily', percent: 91 }]))
  assert.equal(sm.getWindowState('antigravity', 'daily'), 'armed')

  // 100% remaining -> recovered
  const event = sm.processQuotaSummary(createSummary('antigravity', [{ label: 'daily', percent: 0 }]))
  assert.notEqual(event, null)
  assert.equal(event?.harness, 'antigravity')
  assert.deepEqual(event?.recoveredWindows, ['daily'])
  assert.equal(sm.getWindowState('antigravity', 'daily'), 'normal')
})

test('quota recovery: 11% -> 100% 未曾进入 armed，不触发恢复', () => {
  const sm = createQuotaRecoveryStateMachine()
  // 11% remaining (used 89%) -> normal
  sm.processQuotaSummary(createSummary('codex', [{ label: '5h', percent: 89 }]))
  assert.equal(sm.getWindowState('codex', '5h'), 'normal')

  // 100% remaining (used 0%) -> still normal, no event
  const event = sm.processQuotaSummary(createSummary('codex', [{ label: '5h', percent: 0 }]))
  assert.equal(event, null)
  assert.equal(sm.getWindowState('codex', '5h'), 'normal')
})

test('quota recovery: 异常 / 断连 / 缺失窗口不清除 armed 状态且不误报', () => {
  const sm = createQuotaRecoveryStateMachine()
  // Armed at 5% remaining
  sm.processQuotaSummary(
    createSummary('codex', [{ label: '5h', percent: 95, resets_at: '2026-09-22T17:00:00Z' }]),
  )
  assert.equal(sm.getWindowState('codex', '5h'), 'armed')

  // Disconnected summary
  const disconnEvent = sm.processQuotaSummary(createSummary('codex', [], false))
  assert.equal(disconnEvent, null)
  assert.equal(sm.getWindowState('codex', '5h'), 'armed')

  // Null summary
  const nullEvent = sm.processQuotaSummary(null)
  assert.equal(nullEvent, null)
  assert.equal(sm.getWindowState('codex', '5h'), 'armed')

  // Window missing in one observation
  const missingEvent = sm.processQuotaSummary(
    createSummary('codex', [{ label: 'other-window', percent: 20 }]),
  )
  assert.equal(missingEvent, null)
  assert.equal(sm.getWindowState('codex', '5h'), 'armed')

  // Finally observed with 100% -> recovers!
  const recoverEvent = sm.processQuotaSummary(
    createSummary('codex', [{ label: '5h', percent: 0 }]),
  )
  assert.notEqual(recoverEvent, null)
  assert.equal(recoverEvent?.harness, 'codex')
  assert.deepEqual(recoverEvent?.recoveredWindows, ['5h'])
  assert.equal(sm.getWindowState('codex', '5h'), 'normal')
})

test('quota recovery: 多窗口同时恢复合并为同一个 harness 的单次事件', () => {
  const sm = createQuotaRecoveryStateMachine()
  // Arm two windows
  sm.processQuotaSummary(
    createSummary('codex', [
      { label: '5-hour', percent: 95 },
      { label: 'weekly', percent: 92 },
    ]),
  )
  assert.equal(sm.getWindowState('codex', '5-hour'), 'armed')
  assert.equal(sm.getWindowState('codex', 'weekly'), 'armed')

  // Both recover in same poll
  const event = sm.processQuotaSummary(
    createSummary('codex', [
      { label: '5-hour', percent: 0 },
      { label: 'weekly', percent: 10 },
    ]),
  )
  assert.notEqual(event, null)
  assert.equal(event?.harness, 'codex')
  assert.deepEqual(event?.recoveredWindows, ['5-hour', 'weekly'])
  assert.equal(sm.getWindowState('codex', '5-hour'), 'normal')
  assert.equal(sm.getWindowState('codex', 'weekly'), 'normal')
})

test('quota recovery: Codex 与 Antigravity 相互独立', () => {
  const sm = createQuotaRecoveryStateMachine()
  // Arm Codex
  sm.processQuotaSummary(createSummary('codex', [{ label: '5h', percent: 95 }]))
  // Antigravity is normal
  sm.processQuotaSummary(createSummary('antigravity', [{ label: 'daily', percent: 20 }]))

  assert.equal(sm.getWindowState('codex', '5h'), 'armed')
  assert.equal(sm.getWindowState('antigravity', 'daily'), 'normal')

  // Recover Codex
  const codexEvent = sm.processQuotaSummary(createSummary('codex', [{ label: '5h', percent: 0 }]))
  assert.notEqual(codexEvent, null)
  assert.equal(codexEvent?.harness, 'codex')

  // Antigravity update does not produce event
  const agyEvent = sm.processQuotaSummary(createSummary('antigravity', [{ label: 'daily', percent: 10 }]))
  assert.equal(agyEvent, null)
})

test('quota recovery: reset 第一次检查仍 low，第二次检查恢复', () => {
  const sm = createQuotaRecoveryStateMachine()
  const resetsAt = '2026-09-22T17:00:00Z'

  // 1. Initial observation at T0: quota is low (<10%) -> armed
  const initialEvent = sm.processQuotaSummary(
    createSummary('codex', [{ label: '5h', percent: 95, resets_at: resetsAt }]),
  )
  assert.equal(initialEvent, null)
  assert.equal(sm.getWindowState('codex', '5h'), 'armed')
  const armed = sm.getArmedWindows()
  assert.equal(armed.length, 1)
  assert.equal(armed[0].resetsAt, resetsAt)

  // 2. Reset time arrives (first check at reset+3s): backend still returns low quota (e.g. cache lag / slow propagation)
  const firstCheckEvent = sm.processQuotaSummary(
    createSummary('codex', [{ label: '5h', percent: 94, resets_at: resetsAt }]),
  )
  assert.equal(firstCheckEvent, null)
  // Window remains armed, resetsAt is unchanged
  assert.equal(sm.getWindowState('codex', '5h'), 'armed')
  assert.equal(sm.getArmedWindows().length, 1)
  assert.equal(sm.getArmedWindows()[0].resetsAt, resetsAt)

  // 3. Second check (retry after 30s): quota is recovered (>=10%, e.g. 100%)
  const secondCheckEvent = sm.processQuotaSummary(
    createSummary('codex', [{ label: '5h', percent: 0, resets_at: resetsAt }]),
  )
  assert.notEqual(secondCheckEvent, null)
  assert.equal(secondCheckEvent?.harness, 'codex')
  assert.deepEqual(secondCheckEvent?.recoveredWindows, ['5h'])
  assert.equal(sm.getWindowState('codex', '5h'), 'normal')
  assert.equal(sm.getArmedWindows().length, 0)
})

