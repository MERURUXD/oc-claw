import { useState, useEffect, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { RotateCw, Zap } from 'lucide-react'
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
 * Google Gemini / Antigravity 4-point star icon SVG
 */
export function AntigravityIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 1C12 7.075 7.075 12 1 12C7.075 12 12 16.925 12 23C12 16.925 16.925 12 23 12C16.925 12 12 7.075 12 1Z" />
    </svg>
  )
}

/**
 * OpenAI ChatGPT spiral flower logo SVG
 */
export function CodexIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  )
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

    // Poll every 5 minutes in background
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
      stroke: '#f43f5e',
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
      stroke: '#f59e0b',
    }
  }
  return {
    ladder: 'emerald' as const,
    capsule: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    card: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    bar: 'bg-emerald-400',
    text: 'text-emerald-400',
    badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    stroke: '#10b981',
  }
}

/**
 * Codeburn-style Compact Quota Card component (usable embedded in ClaudeStatsView or in Popover).
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
  const allWindows: QuotaWindow[] = []
  if (data.primary) {
    allWindows.push(data.primary)
  }
  for (const detail of data.details) {
    if (!data.primary || detail.label !== data.primary.label) {
      allWindows.push(detail)
    }
  }
  if (allWindows.length === 0 && data.details.length > 0) {
    allWindows.push(...data.details)
  }

  const isPopover = variant === 'popover'

  return (
    <div
      onWheel={(e) => e.stopPropagation()}
      onTouchMove={(e) => e.stopPropagation()}
      className={
        isPopover
          ? 'flex flex-col gap-2.5 text-white select-none max-h-[250px] overflow-y-auto overscroll-contain pr-0.5'
          : 'bg-[#0c0c0e] border border-white/10 rounded-2xl p-4 flex flex-col gap-3.5 text-white select-none'
      }
    >
      {/* Header: Icon + Title + Plan Label + Refresh */}
      <div className="flex items-center justify-between gap-2 pb-2 border-b border-white/10">
        <div className="flex items-center gap-2 min-w-0">
          {data.harness === 'antigravity' ? (
            <AntigravityIcon className="w-4 h-4 text-indigo-400 shrink-0" />
          ) : (
            <CodexIcon className="w-4 h-4 text-emerald-400 shrink-0" />
          )}
          <span className="font-bold text-xs tracking-tight text-white/95 truncate">
            {harnessName}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {data.plan_label && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/10 border border-white/10 text-white/70 font-medium">
              {data.plan_label}
            </span>
          )}
          <button
            data-no-drag
            onClick={(e) => {
              e.stopPropagation()
              handleRefresh?.()
            }}
            disabled={isRefreshing}
            className="p-1 rounded-md bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors cursor-pointer disabled:opacity-50"
            title="刷新配额"
          >
            <RotateCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin text-emerald-400' : ''}`} />
          </button>
        </div>
      </div>

      {/* Rows: Each Window (Codeburn compact layout) */}
      <div className="flex flex-col gap-2.5">
        {allWindows.map((win, idx) => {
          const remaining = Math.max(0, Math.min(100, Math.round(100 - win.percent)))
          const winLadder = getQuotaColorLadder(remaining)
          const countdown = win.resets_at
            ? formatCountdown(win.resets_at, now, { short: true })
            : null
          const resetTime = win.resets_at ? formatResetTime(win.resets_at) : null

          return (
            <div key={idx} className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-white/80 font-medium truncate">{win.label}</span>
                <div className="flex items-baseline gap-1 shrink-0 font-mono text-xs font-bold">
                  <span className="text-[9px] font-normal text-white/40">剩余</span>
                  <span className={winLadder.text}>{remaining}%</span>
                </div>
              </div>

              {/* Slim Progress Bar */}
              <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${winLadder.bar}`}
                  style={{ width: `${remaining}%` }}
                />
              </div>

              {/* Reset Info */}
              {countdown && (
                <div className="flex items-center justify-end text-[10px] text-white/40 font-mono">
                  倒计时 {countdown}{resetTime ? ` (${resetTime})` : ''}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Footer: Updated ago */}
      <div className="flex items-center justify-between pt-1.5 border-t border-white/5 text-[9px] text-white/30">
        <span>更新于 {formatUpdatedAgo(data.updated_at, now)}</span>
      </div>
    </div>
  )
}

/**
 * Mini Quota Badge specifically tailored for MascotBubble.
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
 * Codeburn-style side rail dock on the right side of the panel:
 * - Solid pure black background (#010101) flush with the main panel
 * - Icon-based squircle buttons with circular progress rings (Antigravity & OpenAI Codex)
 * - Remaining percentage text right below each icon
 * - Compact popover sliding to the left with beak arrow pointing to active icon
 * - Wheel scroll isolation (prevents penetration to underlying conversation list)
 */
export function QuotaSideRail() {
  const codex = useHarnessQuota('codex')
  const antigravity = useHarnessQuota('antigravity')
  const now = useQuotaTicker()

  const [activePopover, setActivePopover] = useState<'codex' | 'antigravity' | null>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Click outside or Escape to close popover
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
      name: 'Google Antigravity',
    })
  }
  if (codex.data && codex.data.connected) {
    items.push({
      harness: 'codex',
      data: codex.data,
      isRefreshing: codex.isRefreshing,
      refresh: codex.refresh,
      name: 'OpenAI Codex',
    })
  }

  if (items.length === 0) return null

  const activeIdx = items.findIndex((i) => i.harness === activePopover)
  const activeItem = activeIdx >= 0 ? items[activeIdx] : null

  return (
    <div
      ref={railRef}
      style={{ background: '#010101' }}
      className="relative shrink-0 w-[58px] flex flex-col items-center gap-3 py-3 px-1.5 border-l border-white/[0.08] select-none z-30"
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

        // SVG circle dimensions: radius 17, perimeter = 2 * PI * 17 = 106.81
        const perimeter = 106.81
        const strokeDashoffset = perimeter * (1 - remainingPercent / 100)

        return (
          <div key={item.harness} className="flex flex-col items-center">
            <button
              data-no-drag
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setActivePopover((prev) => (prev === item.harness ? null : item.harness))
              }}
              className={`relative w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-200 cursor-pointer ${
                isSelected
                  ? 'bg-white/15 ring-2 ring-emerald-400/50 scale-105'
                  : 'bg-white/[0.06] hover:bg-white/12 hover:scale-105 active:scale-95'
              }`}
              title={`${item.name} · 剩余 ${remainingPercent}%${countdown ? ` (重置倒计时: ${countdown})` : ''}`}
            >
              {/* Circular SVG Progress Ring hugging the squircle */}
              <svg className="absolute inset-0 w-full h-full -rotate-90 pointer-events-none" viewBox="0 0 40 40">
                <circle
                  cx="20"
                  cy="20"
                  r="17"
                  fill="none"
                  stroke="rgba(255,255,255,0.08)"
                  strokeWidth="2.2"
                />
                <circle
                  cx="20"
                  cy="20"
                  r="17"
                  fill="none"
                  stroke={ladder.stroke}
                  strokeWidth="2.2"
                  strokeDasharray={perimeter}
                  strokeDashoffset={strokeDashoffset}
                  strokeLinecap="round"
                  className="transition-all duration-500"
                />
              </svg>

              {/* Provider Icon */}
              {item.harness === 'antigravity' ? (
                <AntigravityIcon className="w-5 h-5 text-indigo-400 shrink-0" />
              ) : (
                <CodexIcon className="w-5 h-5 text-emerald-400 shrink-0" />
              )}
            </button>

            {/* Percentage text right below */}
            <span className={`text-[11px] font-bold font-mono text-center tracking-tight mt-1 leading-none ${ladder.text}`}>
              {remainingPercent}%
            </span>
          </div>
        )
      })}

      {/* Popover Card sliding out to the left */}
      <AnimatePresence>
        {activeItem && (
          <motion.div
            ref={popoverRef}
            initial={{ opacity: 0, scale: 0.96, x: 8 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            exit={{ opacity: 0, scale: 0.96, x: 8 }}
            transition={{ duration: 0.15 }}
            data-no-drag
            onClick={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
            onTouchMove={(e) => e.stopPropagation()}
            className="absolute right-full mr-2.5 top-2 z-50 w-72 max-h-[250px] overflow-y-auto overscroll-contain bg-[#0c0c0e] border border-white/15 shadow-[0_12px_40px_rgba(0,0,0,0.9)] rounded-2xl p-3 select-none cursor-default scrollbar-thin scrollbar-thumb-white/20"
          >
            {/* Arrow beak pointing right towards active dock button */}
            <div
              className="absolute -right-1.5 w-3 h-3 bg-[#0c0c0e] border-t border-r border-white/15 rotate-45 pointer-events-none"
              style={{ top: activeIdx === 0 ? 18 : 72 }}
            />

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
