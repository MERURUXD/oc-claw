import type { HarnessQuotaSummary, QuotaWindow } from './types'

export const QUOTA_LOW_REMAINING_THRESHOLD = 10
export const RESET_GRACE_PERIOD_MS = 3000

export type QuotaHarness = 'codex' | 'antigravity'

export type WindowStatus = 'normal' | 'armed'

export interface WindowRecord {
  harness: QuotaHarness
  label: string
  status: WindowStatus
  resetsAt?: string | null
}

export interface QuotaRecoveryEvent {
  harness: QuotaHarness
  recoveredWindows: string[]
}

export function calculateRemainingPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 0
  return Math.max(0, Math.min(100, 100 - usedPercent))
}

export function computeResetCheckDelay(
  resetsAt: string | null | undefined,
  now = Date.now(),
): number | null {
  if (!resetsAt) return null
  const targetMs = new Date(resetsAt).getTime()
  if (Number.isNaN(targetMs)) return null
  const delay = targetMs + RESET_GRACE_PERIOD_MS - now
  return Math.max(RESET_GRACE_PERIOD_MS, delay)
}

export function extractQuotaWindows(summary: HarnessQuotaSummary): QuotaWindow[] {
  const windows: QuotaWindow[] = []
  if (summary.primary && typeof summary.primary.percent === 'number') {
    windows.push(summary.primary)
  }
  if (Array.isArray(summary.details)) {
    for (const detail of summary.details) {
      if (
        typeof detail.percent === 'number' &&
        (!summary.primary || detail.label !== summary.primary.label)
      ) {
        windows.push(detail)
      }
    }
  }
  return windows
}

export interface QuotaRecoveryStateMachine {
  processQuotaSummary(
    summary: HarnessQuotaSummary | null | undefined,
  ): QuotaRecoveryEvent | null
  getWindowState(harness: QuotaHarness, label: string): WindowStatus | undefined
  getArmedWindows(): WindowRecord[]
  reset(): void
}

export function createQuotaRecoveryStateMachine(): QuotaRecoveryStateMachine {
  const windowRecords = new Map<string, WindowRecord>()

  const getWindowKey = (harness: QuotaHarness, label: string) => `${harness}:${label}`

  const processQuotaSummary = (
    summary: HarnessQuotaSummary | null | undefined,
  ): QuotaRecoveryEvent | null => {
    if (!summary || !summary.connected) {
      return null
    }

    const harness = summary.harness
    if (harness !== 'codex' && harness !== 'antigravity') {
      return null
    }

    const windows = extractQuotaWindows(summary)
    if (windows.length === 0) {
      return null
    }

    const recoveredWindows: string[] = []

    for (const win of windows) {
      const key = getWindowKey(harness, win.label)
      const remaining = calculateRemainingPercent(win.percent)
      const isLow = remaining < QUOTA_LOW_REMAINING_THRESHOLD
      const existing = windowRecords.get(key)

      if (!existing) {
        // Initial observation for this window
        windowRecords.set(key, {
          harness,
          label: win.label,
          status: isLow ? 'armed' : 'normal',
          resetsAt: win.resets_at,
        })
      } else {
        // Subsequent observation
        existing.resetsAt = win.resets_at

        if (existing.status === 'armed') {
          if (!isLow) {
            // Recovered from <10% to >=10%
            existing.status = 'normal'
            recoveredWindows.push(win.label)
          }
          // If still low, stay armed
        } else {
          // Previously normal
          if (isLow) {
            existing.status = 'armed'
          }
        }
      }
    }

    if (recoveredWindows.length > 0) {
      return {
        harness,
        recoveredWindows,
      }
    }

    return null
  }

  const getWindowState = (
    harness: QuotaHarness,
    label: string,
  ): WindowStatus | undefined => {
    return windowRecords.get(getWindowKey(harness, label))?.status
  }

  const getArmedWindows = (): WindowRecord[] => {
    const armed: WindowRecord[] = []
    for (const record of windowRecords.values()) {
      if (record.status === 'armed') {
        armed.push({ ...record })
      }
    }
    return armed
  }

  const reset = (): void => {
    windowRecords.clear()
  }

  return {
    processQuotaSummary,
    getWindowState,
    getArmedWindows,
    reset,
  }
}
