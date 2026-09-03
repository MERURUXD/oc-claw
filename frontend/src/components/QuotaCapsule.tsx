import { useState, useEffect, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Zap, Clock, RotateCw } from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import type { HarnessQuotaSummary, QuotaWindow } from '../lib/types'

// Module-level cache and subscriber registry so all components viewing
// the active harness (e.g. side rail + bubble + stats view) stay synchronized.
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
    return options?.short ? '0s' : '已重置'
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

  if (days > 0) return `${days}天 ${hours}小时 ${minutes}分`
  if (hours > 0) return `${hours}小时 ${minutes}分 ${seconds}秒`
  if (minutes > 0) return `${minutes}分 ${seconds}秒`
  return `${seconds}秒`
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
  if (diffSec < 60) return '刚刚'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}分钟前`
  const diffHours = Math.floor(diffMin / 60)
  return `${diffHours}小时前`
}

/**
 * Color ladder based on REMAINING percent (剩余量):
 * - >= 30%: Healthy (Emerald / Cyan)
 * - 15% - 30%: Warning (Amber)
 * - < 15%: Critical (Rose with pulse)
 */
export function getQuotaColorLadder(remainingPercent: number) {
  if (remainingPercent < 15) {
    return {
      ladder: 'rose' as const,
      capsule: 'bg-rose-500/15 text-rose-400 border-rose-500/30 animate-pulse',
      card: 'bg-rose-500/10 text-rose-400 border-rose-500/30 animate-pulse',
      bar: 'bg-rose-500',
      text: 'text-rose-400',
      badge: 'bg-rose-500/15 text-rose-400 border-rose-500/30 animate-pulse',
    }
  }
  if (remainingPercent <= 30) {
    return {
      ladder: 'amber' as const,
      capsule: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
      card: 'bg-amber-500/10 text-amber-400 border-amber-500/25',
      bar: 'bg-amber-400',
      text: 'text-amber-400',
      badge: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    }
  }
  return {
    ladder: 'emerald' as const,
    capsule: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    card: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    bar: 'bg-emerald-400',
    text: 'text-emerald-400',
    badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  }
}

/**
 * Standalone Quota Card component (usable embedded in ClaudeStatsView or in Popover).
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

  // Calculate remaining percentages (100 - used)
  const primaryRemaining = primaryWindow
    ? Math.max(0, Math.min(100, Math.round(100 - primaryWindow.percent)))
    : 100
  const primaryLadder = getQuotaColorLadder(primaryRemaining)

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
                ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
                : 'bg-indigo-500/15 border-indigo-500/30 text-indigo-400'
            }`}
          >
            <Zap className="w-3.5 h-3.5" />
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-bold text-sm truncate tracking-wide">{harnessName}</span>
            {data.plan_label && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/10 border border-white/10 text-white/70 font-medium shrink-0">
                {data.plan_label}
              </span>
            )}
          </div>
        </div>

        {!isPopover && (
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[11px] text-white/40">
              更新于 {formatUpdatedAgo(data.updated_at, now)}
            </span>
            <button
              data-no-drag
              onClick={() => handleRefresh?.()}
              disabled={isRefreshing}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white transition-colors cursor-pointer disabled:opacity-50 text-xs"
              title="刷新配额"
            >
              <RotateCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin text-emerald-400' : ''}`} />
              <span>刷新</span>
            </button>
          </div>
        )}
      </div>

      {/* Primary Window Progress Bar (showing Remaining) */}
      {primaryWindow ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-medium text-slate-300 truncate">
              {primaryWindow.label || '主要限额窗口'}
            </span>
            <div className="flex items-baseline gap-1 shrink-0">
              <span className="text-[10px] text-white/50">剩余</span>
              <span className={`text-sm font-mono font-bold ${primaryLadder.text}`}>
                {primaryRemaining}%
              </span>
            </div>
          </div>

          <div className="h-2 w-full bg-white/10 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${primaryLadder.bar}`}
              style={{ width: `${primaryRemaining}%` }}
            />
          </div>

          {primaryResetTime && (
            <div className="flex items-center justify-between text-[11px] text-slate-400 mt-0.5">
              <span className="flex items-center gap-1 truncate">
                <Clock className="w-3 h-3 text-slate-500 shrink-0" />
                将于 {primaryResetTime} 重置
              </span>
              {primaryResetCountdown && (
                <span className="font-mono text-slate-300 shrink-0 ml-1">
                  倒计时 {primaryResetCountdown}
                </span>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="text-xs text-white/40 italic py-1">暂无配额数据</div>
      )}

      {/* Details list: other windows / model buckets with remaining progress bars */}
      {detailWindows.length > 0 && (
        <div className="flex flex-col gap-2 pt-2 border-t border-white/5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-white/40">
            配额与模型分桶明细
          </span>
          <div className={isPopover ? 'flex flex-col gap-2' : 'grid grid-cols-1 sm:grid-cols-2 gap-2'}>
            {detailWindows.map((win, idx) => {
              const winRemaining = Math.max(0, Math.min(100, Math.round(100 - win.percent)))
              const winLadder = getQuotaColorLadder(winRemaining)
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
                    <div className="flex items-baseline gap-1 shrink-0">
                      <span className="text-[9px] text-white/40">剩余</span>
                      <span className={`font-mono text-xs font-semibold ${winLadder.text}`}>
                        {winRemaining}%
                      </span>
                    </div>
                  </div>

                  <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${winLadder.bar}`}
                      style={{ width: `${winRemaining}%` }}
                    />
                  </div>

                  {winCountdown && (
                    <div className="flex items-center justify-end text-[10px] text-slate-400 font-mono">
                      倒计时 {winCountdown}
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
          <span>更新于 {formatUpdatedAgo(data.updated_at, now)}</span>
          <button
            data-no-drag
            onClick={(e) => {
              e.stopPropagation()
              handleRefresh?.()
            }}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white transition-colors cursor-pointer disabled:opacity-50"
            title="刷新配额"
          >
            <RotateCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin text-emerald-400' : ''}`} />
            <span>刷新</span>
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Mini Quota Badge specifically tailored for MascotBubble.
 * Shows remaining percentage: [⚡ 76%], with color ladder and reset countdown tooltip.
 */
export function QuotaMiniBadge({
  harness,
}: {
  harness: 'codex' | 'antigravity'
}) {
  const { data } = useHarnessQuota(harness)
  const now = useQuotaTicker()
  if (!data || !data.connected) return null
  const primary = data.primary || (data.details.length > 0 ? data.details[0] : null)
  if (!primary) return null

  const remainingPercent = Math.max(0, Math.min(100, Math.round(100 - primary.percent)))
  const ladder = getQuotaColorLadder(remainingPercent)
  const countdown = primary.resets_at
    ? formatCountdown(primary.resets_at, now, { short: true })
    : null
  const harnessLabel = data.harness === 'codex' ? 'Codex' : 'Antigravity'

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-medium border shrink-0 transition-colors select-none ${ladder.badge}`}
      title={`${harnessLabel} ${primary.label || '配额'}: 剩余 ${remainingPercent}%${countdown ? ` (重置倒计时: ${countdown})` : ''}`}
    >
      <Zap className="w-2.5 h-2.5 shrink-0" />
      <span>{remainingPercent}%</span>
    </span>
  )
}

/**
 * Apple Dynamic Island style companion dock on the right side of the expanded panel.
 * - Widened pod with unified dark glassmorphic styling
 * - Displays full recognizable names: "Codex" & "Antigravity"
 * - Displays remaining quota ("76% 剩余") and mini capacity gauge
 * - Shows reset countdown ("in 4h 23m")
 * - Clicking any card slides out the full details popover to the left
 */
export function QuotaSideRail() {
  const codex = useHarnessQuota('codex')
  const antigravity = useHarnessQuota('antigravity')
  const now = useQuotaTicker()

  const [activePopover, setActivePopover] = useState<'codex' | 'antigravity' | null>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Click outside to close
  useEffect(() => {
    if (!activePopover) return
    const handlePointerDown = (e: MouseEvent | PointerEvent) => {
      const target = e.target as Node
      if (
        popoverRef.current &&
        !popoverRef.current.contains(target) &&
        railRef.current &&
        !railRef.current.contains(target)
      ) {
        setActivePopover(null)
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActivePopover(null)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [activePopover])

  const items: {
    harness: 'antigravity' | 'codex'
    data: HarnessQuotaSummary
    isRefreshing: boolean
    refresh: () => Promise<void> | void
    name: string
  }[] = []

  if (antigravity.data && antigravity.data.connected) {
    items.push({
      harness: 'antigravity',
      data: antigravity.data,
      isRefreshing: antigravity.isRefreshing,
      refresh: antigravity.refresh,
      name: 'Antigravity',
    })
  }
  if (codex.data && codex.data.connected) {
    items.push({
      harness: 'codex',
      data: codex.data,
      isRefreshing: codex.isRefreshing,
      refresh: codex.refresh,
      name: 'Codex',
    })
  }

  if (items.length === 0) return null

  const activeItem = items.find((i) => i.harness === activePopover)

  return (
    <div
      ref={railRef}
      className="relative shrink-0 w-[126px] my-2 mr-2 p-2 flex flex-col gap-2 rounded-2xl bg-[#0c0c10]/85 backdrop-blur-xl border border-white/[0.08] shadow-[0_8px_30px_rgba(0,0,0,0.5)] select-none z-30"
    >
      {items.map((item) => {
        const primary = item.data.primary || item.data.details[0]
        const remainingPercent = primary
          ? Math.max(0, Math.min(100, Math.round(100 - primary.percent)))
          : 100
        const ladder = getQuotaColorLadder(remainingPercent)
        const countdown = primary?.resets_at
          ? formatCountdown(primary.resets_at, now, { short: true })
          : null
        const isSelected = activePopover === item.harness

        return (
          <button
            key={item.harness}
            data-no-drag
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setActivePopover((prev) => (prev === item.harness ? null : item.harness))
            }}
            className={`w-full flex flex-col gap-1.5 p-2 rounded-xl border transition-all duration-200 cursor-pointer text-left ${
              isSelected
                ? 'ring-2 ring-white/30 scale-[1.02]'
                : 'hover:scale-[1.02] hover:brightness-110 active:scale-95'
            } ${ladder.card}`}
            title={`${item.name} 剩余配额: ${remainingPercent}%${countdown ? ` (重置倒计时: ${countdown})` : ''}. 点击查看详情.`}
          >
            {/* Row 1: Icon + Full Name */}
            <div className="flex items-center justify-between gap-1 min-w-0">
              <div className="flex items-center gap-1.5 min-w-0">
                <Zap className={`w-3 h-3 shrink-0 ${ladder.text}`} />
                <span className="text-[11px] font-semibold tracking-tight text-white/90 truncate">
                  {item.name}
                </span>
              </div>
            </div>

            {/* Row 2: Remaining Percentage */}
            <div className="flex items-baseline justify-between gap-1">
              <span className={`text-sm font-mono font-bold leading-none ${ladder.text}`}>
                {remainingPercent}%
              </span>
              <span className="text-[9px] font-normal text-white/40 uppercase tracking-wider">
                剩余
              </span>
            </div>

            {/* Row 3: Slim Remaining Progress Bar */}
            <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${ladder.bar}`}
                style={{ width: `${remainingPercent}%` }}
              />
            </div>

            {/* Row 4: Reset Countdown */}
            {countdown && (
              <div className="flex items-center justify-end text-[9px] font-mono text-white/40">
                {countdown}
              </div>
            )}
          </button>
        )
      })}

      {/* Popover Card sliding out to the left */}
      <AnimatePresence>
        {activeItem && (
          <motion.div
            ref={popoverRef}
            initial={{ opacity: 0, scale: 0.95, x: 10 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            exit={{ opacity: 0, scale: 0.95, x: 10 }}
            transition={{ duration: 0.15 }}
            data-no-drag
            onClick={(e) => e.stopPropagation()}
            className="absolute right-full mr-2.5 top-0 z-50 w-80 max-w-[calc(100vw-48px)] bg-[#141418]/95 backdrop-blur-2xl border border-white/10 shadow-[0_12px_40px_rgba(0,0,0,0.8)] rounded-2xl p-4 select-none cursor-default"
          >
            <QuotaCard
              harness={activeItem.harness}
              summary={activeItem.data}
              isRefreshing={activeItem.isRefreshing}
              onRefresh={activeItem.refresh}
              variant="popover"
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
