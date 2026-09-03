import { useState, useEffect, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Zap, Sparkles, Clock, RotateCw } from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import type { HarnessQuotaSummary, QuotaWindow } from '../lib/types'

// Module-level cache and subscriber registry so all components viewing
// the active harness (e.g. top bar capsule + stats view) stay synchronized.
type QuotaSubscriber = (data: HarnessQuotaSummary | null) => void

const subscribers: {
  codex: Set<QuotaSubscriber>
  antigravity: Set<QuotaSubscriber>
} = {
  codex: new Set(),
  antigravity: new Set(),
}

const memoryCache: {
  codex: HarnessQuotaSummary | null
  antigravity: HarnessQuotaSummary | null
} = {
  codex: null,
  antigravity: null,
}

function updateHarnessQuotaCache(
  harness: 'codex' | 'antigravity',
  summary: HarnessQuotaSummary | null,
) {
  memoryCache[harness] = summary
  subscribers[harness].forEach((cb) => {
    try {
      cb(summary)
    } catch {
      // ignore callback error
    }
  })
}

/**
 * Hook to fetch and poll harness quota summary with 5-minute background interval
 * and manual refresh capability.
 */
export function useHarnessQuota(harness: 'codex' | 'antigravity' | null | undefined) {
  const [data, setData] = useState<HarnessQuotaSummary | null>(() => {
    if (harness === 'codex' || harness === 'antigravity') {
      return memoryCache[harness]
    }
    return null
  })
  const [loading, setLoading] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const fetchQuota = useCallback(
    async (forceRefresh = false) => {
      if (!harness || (harness !== 'codex' && harness !== 'antigravity')) {
        setData(null)
        return
      }

      if (forceRefresh) {
        setIsRefreshing(true)
      } else {
        setLoading(true)
      }

      try {
        const res = await invoke<HarnessQuotaSummary | null>('get_harness_quota', {
          harness,
          forceRefresh,
        })
        updateHarnessQuotaCache(harness, res)
        setData(res)
      } catch (err) {
        console.warn(`[Quota] Failed to fetch quota for ${harness}:`, err)
      } finally {
        setLoading(false)
        setIsRefreshing(false)
      }
    },
    [harness],
  )

  useEffect(() => {
    if (!harness || (harness !== 'codex' && harness !== 'antigravity')) {
      setData(null)
      return
    }

    // Set initial data from memory cache if available
    if (memoryCache[harness]) {
      setData(memoryCache[harness])
    }

    const onUpdate: QuotaSubscriber = (next) => {
      setData(next)
    }

    subscribers[harness].add(onUpdate)

    // Initial fetch
    fetchQuota(false)

    // Poll every 5 minutes (300,000 ms) in background
    const interval = setInterval(() => {
      fetchQuota(false)
    }, 300_000)

    return () => {
      subscribers[harness].delete(onUpdate)
      clearInterval(interval)
    }
  }, [harness, fetchQuota])

  const refresh = useCallback(async () => {
    await fetchQuota(true)
  }, [fetchQuota])

  return {
    data,
    loading,
    isRefreshing,
    refresh,
  }
}

/**
 * Local 1-second ticker hook for live countdown and relative timestamp updates.
 */
export function useQuotaTicker(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
    }, intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])

  return now
}

/**
 * Format remaining countdown for resets_at locally.
 */
export function formatCountdown(
  resetsAt: string | null | undefined,
  now: number,
  options?: { short?: boolean },
): string | null {
  if (!resetsAt) return null
  const target = new Date(resetsAt).getTime()
  if (Number.isNaN(target)) return null

  const diffMs = target - now
  if (diffMs <= 0) {
    return options?.short ? '0s' : 'Reset'
  }

  const totalSeconds = Math.floor(diffMs / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (options?.short) {
    if (days > 0) return `${days}d ${hours}h`
    if (hours > 0) return `${hours}h ${minutes}m`
    if (minutes > 0) return `${minutes}m ${seconds}s`
    return `${seconds}s`
  }

  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/**
 * Format clock time for resets_at (e.g. "14:30" or "9/4 14:30").
 */
export function formatResetTime(resetsAt: string | null | undefined): string | null {
  if (!resetsAt) return null
  const d = new Date(resetsAt)
  if (Number.isNaN(d.getTime())) return null

  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  if (isToday) {
    return timeStr
  }
  const dateStr = d.toLocaleDateString([], { month: 'numeric', day: 'numeric' })
  return `${dateStr} ${timeStr}`
}

/**
 * Format relative elapsed time for updated_at.
 */
export function formatUpdatedAgo(updatedAt: number, now: number): string {
  const ms = updatedAt < 1e11 ? updatedAt * 1000 : updatedAt
  const diffSec = Math.max(0, Math.floor((now - ms) / 1000))
  if (diffSec < 60) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHours = Math.floor(diffMin / 60)
  return `${diffHours}h ago`
}

/**
 * Color ladder helper based on percent:
 * - < 75%: Cyan/Blue
 * - 75% - 90%: Amber
 * - > 90% / 100%: Rose (with pulse)
 */
export function getQuotaColorLadder(percent: number) {
  if (percent > 90) {
    return {
      ladder: 'rose' as const,
      capsule: 'bg-rose-500/15 text-rose-400 border-rose-500/30 animate-pulse',
      bar: 'bg-rose-500',
      text: 'text-rose-400',
      badge: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
    }
  }
  if (percent >= 75) {
    return {
      ladder: 'amber' as const,
      capsule: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
      bar: 'bg-amber-500',
      text: 'text-amber-400',
      badge: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    }
  }
  return {
    ladder: 'cyan' as const,
    capsule: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
    bar: 'bg-cyan-500',
    text: 'text-cyan-400',
    badge: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
  }
}

/**
 * Standalone Quota Card component (usable both embedded in ClaudeStatsView and in Popover).
 */
export function QuotaCard({
  harness,
  summary,
  isRefreshing: propIsRefreshing,
  onRefresh: propOnRefresh,
  variant = 'card',
}: {
  harness?: 'codex' | 'antigravity' | null
  summary?: HarnessQuotaSummary | null
  isRefreshing?: boolean
  onRefresh?: () => Promise<void> | void
  variant?: 'card' | 'popover'
}) {
  const hookResult = useHarnessQuota(summary ? null : harness)
  const data = summary ?? hookResult.data
  const isRefreshing = propIsRefreshing ?? hookResult.isRefreshing
  const handleRefresh = propOnRefresh ?? hookResult.refresh
  const now = useQuotaTicker()

  if (!data || !data.connected) {
    return null
  }

  const harnessName = data.harness === 'codex' ? 'Codex' : 'Google Antigravity'
  const primaryWindow: QuotaWindow | null =
    data.primary || (data.details.length > 0 ? data.details[0] : null)
  const detailWindows: QuotaWindow[] = data.primary ? data.details : data.details.slice(1)
  const primaryLadder = primaryWindow
    ? getQuotaColorLadder(primaryWindow.percent)
    : getQuotaColorLadder(0)
  const primaryResetCountdown = primaryWindow?.resets_at
    ? formatCountdown(primaryWindow.resets_at, now, { short: false })
    : null
  const primaryResetTime = primaryWindow?.resets_at
    ? formatResetTime(primaryWindow.resets_at)
    : null

  const isPopover = variant === 'popover'

  return (
    <div
      className={
        isPopover
          ? 'flex flex-col gap-3 text-white select-none'
          : 'bg-white/[0.03] border border-white/5 rounded-2xl p-4 flex flex-col gap-4 hover:bg-white/[0.05] transition-colors text-white select-none'
      }
    >
      {/* Header: Harness icon + Name + Plan label badge */}
      <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-white/10">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className={`w-6 h-6 rounded-lg flex items-center justify-center border shrink-0 ${
              data.harness === 'codex'
                ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400'
                : 'bg-purple-500/10 border-purple-500/25 text-purple-400'
            }`}
          >
            {data.harness === 'codex' ? <Zap className="w-3.5 h-3.5" /> : <Sparkles className="w-3.5 h-3.5" />}
          </div>
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-semibold text-white tracking-tight truncate">
              {harnessName}
            </span>
            {data.plan_label && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/10 text-slate-300 font-medium border border-white/10 shrink-0">
                {data.plan_label}
              </span>
            )}
          </div>
        </div>

        {/* Refresh button & status */}
        {!isPopover && (
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[11px] text-white/40">
              Updated {formatUpdatedAgo(data.updated_at, now)}
            </span>
            <button
              data-no-drag
              onClick={() => handleRefresh?.()}
              disabled={isRefreshing}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white transition-colors cursor-pointer disabled:opacity-50 text-xs"
              title="Refresh quota"
            >
              <RotateCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin text-cyan-400' : ''}`} />
              <span>Refresh</span>
            </button>
          </div>
        )}
      </div>

      {/* Primary Window Progress Bar */}
      {primaryWindow ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-medium text-slate-300 truncate">
              {primaryWindow.label || 'Primary Limit'}
            </span>
            <span className={`text-sm font-mono font-bold shrink-0 ${primaryLadder.text}`}>
              {Math.round(primaryWindow.percent)}%
            </span>
          </div>

          <div className="h-2 w-full bg-white/10 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${primaryLadder.bar}`}
              style={{ width: `${Math.min(100, Math.max(0, primaryWindow.percent))}%` }}
            />
          </div>

          {primaryResetTime && (
            <div className="flex items-center justify-between text-[11px] text-slate-400 mt-0.5">
              <span className="flex items-center gap-1 truncate">
                <Clock className="w-3 h-3 text-slate-500 shrink-0" />
                Resets at {primaryResetTime}
              </span>
              {primaryResetCountdown && (
                <span className="font-mono text-slate-300 shrink-0 ml-1">
                  in {primaryResetCountdown}
                </span>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="text-xs text-white/40 italic py-1">No limit data available</div>
      )}

      {/* Details list: other windows / model buckets with small progress bars */}
      {detailWindows.length > 0 && (
        <div className="flex flex-col gap-2 pt-2 border-t border-white/5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-white/40">
            Window Details
          </span>
          <div className={isPopover ? 'flex flex-col gap-2' : 'grid grid-cols-1 sm:grid-cols-2 gap-2'}>
            {detailWindows.map((win, idx) => {
              const winLadder = getQuotaColorLadder(win.percent)
              const winCountdown = win.resets_at
                ? formatCountdown(win.resets_at, now, { short: true })
                : null

              return (
                <div
                  key={idx}
                  className={
                    isPopover
                      ? 'flex flex-col gap-1 bg-white/[0.02] border border-white/5 rounded-lg p-2'
                      : 'flex flex-col gap-1 bg-white/[0.02] border border-white/5 rounded-xl p-2.5'
                  }
                >
                  <div className="flex items-center justify-between text-xs gap-2">
                    <span className="text-slate-300 truncate">{win.label}</span>
                    <span className={`font-mono text-xs font-semibold shrink-0 ${winLadder.text}`}>
                      {Math.round(win.percent)}%
                    </span>
                  </div>

                  <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${winLadder.bar}`}
                      style={{ width: `${Math.min(100, Math.max(0, win.percent))}%` }}
                    />
                  </div>

                  {winCountdown && (
                    <div className="flex items-center justify-end text-[10px] text-slate-400 font-mono">
                      in {winCountdown}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Popover Footer: "Updated X min ago" + Refresh button */}
      {isPopover && (
        <div className="flex items-center justify-between pt-2 border-t border-white/10 text-[11px] text-slate-400">
          <span>Updated {formatUpdatedAgo(data.updated_at, now)}</span>
          <button
            data-no-drag
            onClick={(e) => {
              e.stopPropagation()
              handleRefresh?.()
            }}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white transition-colors cursor-pointer disabled:opacity-50"
            title="Refresh quota"
          >
            <RotateCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin text-cyan-400' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Top Control Bar Quota Capsule Component.
 * - Shows lightning icon + harness name + primary percent + short countdown (e.g. ⚡ Codex 68% · 1h 45m).
 * - Color ladder:
 *   - < 75%: Cyan/Blue
 *   - 75% - 90%: Amber
 *   - > 90% / 100%: Rose (pulse)
 * - Click toggles the Glassmorphism popover card.
 * - If no data or not connected, completely hidden (returns null).
 */
export function QuotaCapsule({
  harness,
}: {
  harness?: 'codex' | 'antigravity' | null
}) {
  const { data, isRefreshing, refresh } = useHarnessQuota(harness)
  const now = useQuotaTicker()
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Click outside to close popover
  useEffect(() => {
    if (!isOpen) return

    const handlePointerDown = (e: MouseEvent | PointerEvent) => {
      const target = e.target as Node
      if (
        popoverRef.current &&
        !popoverRef.current.contains(target) &&
        containerRef.current &&
        !containerRef.current.contains(target)
      ) {
        setIsOpen(false)
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen])

  // If no data or not connected, completely hidden
  if (!data || !data.connected) {
    return null
  }

  const harnessName = data.harness === 'codex' ? 'Codex' : 'Antigravity'
  const primaryWindow: QuotaWindow | null =
    data.primary || (data.details.length > 0 ? data.details[0] : null)
  const primaryPercent = primaryWindow ? Math.round(primaryWindow.percent) : 0
  const colorLadder = getQuotaColorLadder(primaryPercent)
  const shortCountdown = primaryWindow?.resets_at
    ? formatCountdown(primaryWindow.resets_at, now, { short: true })
    : null

  return (
    <div className="relative inline-block shrink-0" ref={containerRef}>
      {/* Pill Capsule Button */}
      <button
        data-no-drag
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setIsOpen((prev) => !prev)
        }}
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-medium transition-all duration-200 hover:brightness-125 active:scale-95 cursor-pointer select-none shadow-sm ${colorLadder.capsule}`}
        title={`${harnessName} Quota: ${primaryPercent}%${shortCountdown ? ` (Resets in ${shortCountdown})` : ''}. Click for details.`}
      >
        <Zap className="w-3 h-3 shrink-0" />
        <span className="font-sans font-medium whitespace-nowrap">
          {harnessName} {primaryPercent}%{shortCountdown ? ` · ${shortCountdown}` : ''}
        </span>
      </button>

      {/* Glassmorphism Popover Card */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            ref={popoverRef}
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -4 }}
            transition={{ duration: 0.15 }}
            data-no-drag
            onClick={(e) => e.stopPropagation()}
            className="absolute top-full left-0 mt-2 z-50 w-76 sm:w-80 max-w-[calc(100vw-32px)] bg-[#18181c]/95 backdrop-blur-xl border border-white/10 shadow-2xl rounded-2xl p-4 select-none cursor-default"
          >
            <QuotaCard
              harness={data.harness}
              summary={data}
              isRefreshing={isRefreshing}
              onRefresh={refresh}
              variant="popover"
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
