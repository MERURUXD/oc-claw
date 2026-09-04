import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { motion, useReducedMotion } from 'motion/react'
import type {
  BubbleSessionDetail,
  BubbleTransitionEvent,
  MascotBubblePayload,
  SubagentDetail,
} from '../lib/types'
import { QuotaMiniBadge } from './QuotaCapsule'

/**
 * Centralized motion and geometry constants for the mascot status bubble.
 * 2D Spring Flight entry/exit parameters matched to current Codex Desktop live observations:
 * - Entry vector: (-150, -95) -> (0, 0)
 * - Spring: stiffness 140, damping 17, mass 1 (~300ms main travel, ~4-5px overshoot, settle by ~500ms)
 * - Motion envelope reserves: 170x115 to guarantee zero clipping in native transparent window
 */
export const BUBBLE_MOTION = {
  offsetX: 150,
  offsetY: 95,
  spring: {
    type: 'spring' as const,
    stiffness: 140,
    damping: 17,
    mass: 1,
  },
  exitSpring: {
    type: 'spring' as const,
    stiffness: 140,
    damping: 17,
    mass: 1,
  },
  reserveX: 170, // 150 flight + 20 margin for overshoot and shadow
  reserveY: 115, // 95 flight + 20 margin for overshoot and shadow
  padRight: 16,  // right margin inside envelope
  padBottom: 16, // bottom margin inside envelope
}

export const BUBBLE_WIDTH = {
  min: 190,
  max: 345,
}

export const SHIMMER_TIMING = {
  initialDelayMs: 500,
  activeMs: 1400,
  intervalMs: 4600,
}

export type BubblePlacement = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export function getBubbleEntryOffset(placement: BubblePlacement = 'top-left') {
  switch (placement) {
    case 'top-right':
      return { x: BUBBLE_MOTION.offsetX, y: -BUBBLE_MOTION.offsetY }
    case 'bottom-left':
      return { x: -BUBBLE_MOTION.offsetX, y: BUBBLE_MOTION.offsetY }
    case 'bottom-right':
      return { x: BUBBLE_MOTION.offsetX, y: BUBBLE_MOTION.offsetY }
    case 'top-left':
    default:
      return { x: -BUBBLE_MOTION.offsetX, y: -BUBBLE_MOTION.offsetY }
  }
}

type BubblePhase =
  | 'hidden'
  | 'prepared'
  | 'entering'
  | 'visible'
  | 'exiting'

function logBubbleDev(...args: unknown[]) {
  if (import.meta.env.DEV) {
    console.debug(...args)
  }
}

function hashSessionId(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash << 5) - hash + id.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

function extractToolParam(toolInput: unknown): string | null {
  if (!toolInput) return null
  try {
    const inp = typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput
    if (typeof inp === 'object' && inp !== null) {
      let rawVal = ''
      if (Array.isArray(inp.questions) && inp.questions.length > 0) {
        const firstQ = inp.questions[0]
        if (typeof firstQ === 'object' && firstQ !== null && typeof firstQ.question === 'string' && firstQ.question.trim()) {
          rawVal = firstQ.question.trim()
        } else if (typeof firstQ === 'string' && firstQ.trim()) {
          rawVal = firstQ.trim()
        }
      } else if (typeof inp.question === 'string' && inp.question.trim()) {
        rawVal = inp.question.trim()
      } else if (typeof inp.justification === 'string' && inp.justification.trim()) {
        rawVal = inp.justification.trim()
      } else {
        rawVal =
          inp.command ||
          inp.CommandLine ||
          inp.toolAction ||
          inp.toolSummary ||
          inp.Query ||
          inp.query ||
          inp.Pattern ||
          inp.pattern ||
          inp.file_path ||
          inp.TargetFile ||
          inp.AbsolutePath ||
          inp.DirectoryPath ||
          inp.SearchPath ||
          inp.SearchDirectory ||
          inp.description ||
          inp.Description ||
          inp.prompt ||
          inp.Prompt ||
          (typeof inp === 'string' ? inp : '')
      }
      if (typeof rawVal === 'string' && rawVal.trim()) {
        let cleanVal = rawVal.trim()
        if (cleanVal.includes('/') || cleanVal.includes('\\')) {
          const parts = cleanVal.split(/[/\\]/)
          if (parts.length > 1 && !cleanVal.includes(' ')) {
            cleanVal = parts[parts.length - 1] || cleanVal
          }
        }
        return cleanVal
      }
    } else if (typeof inp === 'string') {
      return inp
    }
  } catch {
    return typeof toolInput === 'string' ? toolInput : null
  }
  return null
}

function getSessionLine2(
  session: BubbleSessionDetail,
  t: TFunction,
  thinkingText?: string
): { actionPrefix: string | null; actionContent: string; isWaiting: boolean; isProcessing: boolean } {
  const isWaiting = session.status === 'waiting'
  const isToolRunning = session.status === 'tool_running' && !!session.tool
  const isCompacting = session.status === 'compacting'
  const isProcessing = session.status === 'processing'

  if (isWaiting) {
    return {
      actionPrefix: null,
      actionContent: session.questionText || session.userPrompt || t('settings.bubbleJumpToTerminal', 'Waiting for input...'),
      isWaiting: true,
      isProcessing: false,
    }
  }

  if (session.activeSubagents && session.activeSubagents.length > 0) {
    const roles = session.activeSubagents.map((s) => s.role).filter(Boolean)
    if (roles.length > 0) {
      return {
        actionPrefix: null,
        actionContent: `[${roles.join(', ')}]`,
        isWaiting: false,
        isProcessing: session.status === 'processing',
      }
    }
  }

  if (isToolRunning && session.tool) {
    const param = extractToolParam(session.toolInput)
    return {
      actionPrefix: session.tool,
      actionContent: param || session.actionText || '',
      isWaiting: false,
      isProcessing: false,
    }
  }

  if (isCompacting) {
    return {
      actionPrefix: null,
      actionContent: t('mini.compacting', 'compacting...'),
      isWaiting: false,
      isProcessing: false,
    }
  }

  if (isProcessing) {
    return {
      actionPrefix: null,
      actionContent: thinkingText || t('mini.thinking', '思考中...'),
      isWaiting: false,
      isProcessing: true,
    }
  }

  return {
    actionPrefix: null,
    actionContent: session.actionText || session.subtitle || session.userPrompt || t('mini.working', 'working...'),
    isWaiting: false,
    isProcessing: false,
  }
}

/**
 * Codex-style Cadenced Shimmer for session title:
 * - 500ms initial delay after active
 * - 1400ms active sweep (mask/sweep translated opposite to highlight layer)
 * - 4600ms cadence interval (1.4s sweep, ~3.2s quiet)
 * - steps(60, end) timing
 * - Stops immediately when inactive (e.g. waiting / stopped)
 * - Completely disabled under prefers-reduced-motion
 * - Isolated against QuotaMiniBadge 1-second ticker rerenders
 */
export function CadencedShimmerText({
  children,
  active,
  reducedMotion = false,
  className = '',
}: {
  children: React.ReactNode
  active: boolean
  reducedMotion?: boolean
  className?: string
}) {
  const [isShimmering, setIsShimmering] = useState(false)

  useEffect(() => {
    if (!active || reducedMotion) {
      setIsShimmering(false)
      return
    }

    let activeTimer: ReturnType<typeof setTimeout> | null = null
    let intervalTimer: ReturnType<typeof setInterval> | null = null
    let initialTimer: ReturnType<typeof setTimeout> | null = null

    const triggerSweep = () => {
      setIsShimmering(true)
      if (activeTimer) clearTimeout(activeTimer)
      activeTimer = setTimeout(() => {
        setIsShimmering(false)
      }, SHIMMER_TIMING.activeMs)
    }

    initialTimer = setTimeout(() => {
      triggerSweep()
      intervalTimer = setInterval(() => {
        triggerSweep()
      }, SHIMMER_TIMING.intervalMs)
    }, SHIMMER_TIMING.initialDelayMs)

    return () => {
      if (initialTimer) clearTimeout(initialTimer)
      if (intervalTimer) clearInterval(intervalTimer)
      if (activeTimer) clearTimeout(activeTimer)
      setIsShimmering(false)
    }
  }, [active, reducedMotion])

  return (
    <div className={`mascot-bubble-title-wrapper ${className}`}>
      <span className="mascot-bubble-main-title truncate">{children}</span>
      {isShimmering && !reducedMotion && (
        <span className="mascot-bubble-shimmer-sweep" aria-hidden="true">
          <span className="mascot-bubble-shimmer-highlight truncate">{children}</span>
        </span>
      )}
    </div>
  )
}

/**
 * Subagent row with deterministic overflow management:
 * - Displays active subagents as quiet pills with dot in front: ● researcher
 * - Dot is emerald (#10b981) during processing / tool_running; no dot for idle/other
 * - Deterministically calculates how many chips fit in available container width
 * - When space is insufficient, displays visible chips + +N badge with hover tooltip
 * - Never silently truncates active subagents
 */
function SubagentsRow({ subagents }: { subagents: SubagentDetail[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState<number>(subagents.length)

  const recomputeVisible = useCallback(() => {
    const container = containerRef.current
    const measure = measureRef.current
    if (!container || !measure || subagents.length <= 1) {
      setVisibleCount(subagents.length)
      return
    }

    const availableWidth = container.clientWidth
    if (availableWidth <= 0) return

    const chips = Array.from(measure.querySelectorAll<HTMLElement>('.mascot-bubble-subagent-chip'))
    const plusBadge = measure.querySelector<HTMLElement>('.mascot-bubble-badge')
    const plusWidth = plusBadge ? plusBadge.offsetWidth : 26
    const gap = 6

    let totalWidth = 0
    let allFit = true
    const chipWidths: number[] = []

    for (let i = 0; i < subagents.length; i++) {
      const chipEl = chips[i]
      const w = chipEl ? chipEl.offsetWidth : 80
      chipWidths.push(w)
      totalWidth += (i > 0 ? gap : 0) + w
      if (totalWidth > availableWidth) {
        allFit = false
      }
    }

    if (allFit) {
      setVisibleCount(subagents.length)
      return
    }

    // Not all fit, determine how many fit alongside +N badge
    let runningWidth = 0
    let count = 0
    for (let i = 0; i < subagents.length; i++) {
      const needed = (i > 0 ? gap : 0) + chipWidths[i] + gap + plusWidth
      if (runningWidth + needed <= availableWidth) {
        runningWidth += (i > 0 ? gap : 0) + chipWidths[i]
        count++
      } else {
        break
      }
    }

    setVisibleCount(Math.max(1, count))
  }, [subagents])

  useLayoutEffect(() => {
    recomputeVisible()
  }, [recomputeVisible, subagents])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver(() => {
      recomputeVisible()
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [recomputeVisible])

  const visibleSubagents = subagents.slice(0, visibleCount)
  const hiddenSubagents = subagents.slice(visibleCount)
  const hiddenRolesTitle = hiddenSubagents.map((s) => s.role).join(', ')

  return (
    <>
      {/* Hidden off-screen measurement row */}
      <div
        ref={measureRef}
        className="mascot-bubble-subagents-row"
        style={{
          position: 'absolute',
          visibility: 'hidden',
          pointerEvents: 'none',
          top: -9999,
          left: -9999,
          width: 'max-content',
          whiteSpace: 'nowrap',
        }}
        aria-hidden="true"
      >
        {subagents.map((sub, idx) => {
          const isWorking = sub.status === 'tool_running' || sub.status === 'processing'
          return (
            <span key={sub.id || idx} className="mascot-bubble-subagent-chip">
              {isWorking && <span className="mascot-bubble-subagent-dot" />}
              <span className="mascot-bubble-subagent-role">{sub.role}</span>
            </span>
          )
        })}
        <span className="mascot-bubble-badge">+99</span>
      </div>

      {/* Actual rendered subagents row */}
      <div ref={containerRef} className="mascot-bubble-subagents-row">
        {visibleSubagents.map((sub, sIdx) => {
          const isSubWorking = sub.status === 'tool_running' || sub.status === 'processing'
          return (
            <span
              key={sub.id || sIdx}
              className="mascot-bubble-subagent-chip"
              title={`${sub.role} (${sub.status})`}
            >
              {isSubWorking && <span className="mascot-bubble-subagent-dot" />}
              <span className="mascot-bubble-subagent-role">{sub.role}</span>
            </span>
          )
        })}
        {hiddenSubagents.length > 0 && (
          <span
            className="mascot-bubble-badge"
            title={hiddenRolesTitle}
          >
            +{hiddenSubagents.length}
          </span>
        )}
      </div>
    </>
  )
}

/**
 * Mascot status bubble — an interactive status capsule/card stack for the `mascot-bubble` window
 * (`index.html#/mascot-bubble`).
 *
 * Synchronizes with Mini.tsx via an explicit handshake protocol:
 *   1. Mini emits `mascot-bubble-prepare` with a monotonic transitionId.
 *   2. MascotBubble renders content in hidden 2D offset state (x: -150, y: -95, scale: 1, opacity: 1),
 *      measures untransformed geometry (offsetWidth / offsetHeight), reports to Rust via `sync_mascot_bubble`,
 *      and emits `mascot-bubble-ready`.
 *   3. Mini shows the native window and emits `mascot-bubble-enter`.
 *   4. MascotBubble awaits double requestAnimationFrame and springs to visible state (0, 0).
 *   5. When closing, Mini emits `mascot-bubble-close`. MascotBubble springs back to hidden state (-150, -95),
 *      and on animation completion emits `mascot-bubble-exit-complete`, prompting Mini to hide the native window.
 */
export default function MascotBubble() {
  const { t } = useTranslation()
  const prefersReducedMotion = useReducedMotion()

  const [summary, setSummary] = useState<MascotBubblePayload | null>(null)
  const [phase, setPhase] = useState<BubblePhase>('hidden')
  const phaseRef = useRef<BubblePhase>('hidden')
  phaseRef.current = phase

  const lastValidSummaryRef = useRef<MascotBubblePayload | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const lastSizeRef = useRef<{ width: number; height: number } | null>(null)
  const transitionIdRef = useRef<number>(0)
  const readySentForTransitionRef = useRef<number>(-1)
  const rafIdRef = useRef<number | null>(null)

  // Measure geometry and notify Mini that the bubble is ready to be natively shown
  const syncGeometryAndNotifyReady = useCallback((tid: number) => {
    const el = contentRef.current
    if (!el) return
    const width = Math.ceil(el.offsetWidth)
    const height = Math.ceil(el.offsetHeight)
    if (width <= 0 || height <= 0) return

    const nativeWidth = width + BUBBLE_MOTION.reserveX + BUBBLE_MOTION.padRight
    const nativeHeight = height + BUBBLE_MOTION.reserveY + BUBBLE_MOTION.padBottom

    logBubbleDev(`[bubble ${tid}] geometry ${width}x${height}`)
    logBubbleDev(`[bubble ${tid}] native envelope ${nativeWidth}x${nativeHeight} (reserves ${BUBBLE_MOTION.reserveX}x${BUBBLE_MOTION.reserveY})`)

    lastSizeRef.current = { width, height }
    invoke('sync_mascot_bubble', {
      width,
      height,
      entryOffsetX: BUBBLE_MOTION.reserveX,
      entryOffsetY: BUBBLE_MOTION.reserveY,
    })
      .then(() => {
        if (readySentForTransitionRef.current !== tid && transitionIdRef.current === tid) {
          readySentForTransitionRef.current = tid
          logBubbleDev(`[bubble ${tid}] ready`)
          emit('mascot-bubble-ready', { transitionId: tid }).catch(() => {})
        }
      })
      .catch(() => {})
  }, [])

  // Listen for handshake events from Mini
  useEffect(() => {
    let unlistenPrepare: (() => void) | undefined
    let unlistenEnter: (() => void) | undefined
    let unlistenSummary: (() => void) | undefined
    let unlistenClose: (() => void) | undefined
    let disposed = false

    listen<BubbleTransitionEvent>('mascot-bubble-prepare', (e) => {
      if (disposed) return
      const tid = e.payload?.transitionId ?? 0
      const newPayload = e.payload?.payload
      transitionIdRef.current = tid
      readySentForTransitionRef.current = -1
      logBubbleDev(`[bubble ${tid}] prepare`)

      if (newPayload) {
        lastValidSummaryRef.current = newPayload
        setSummary(newPayload)
      }
      setPhase('prepared')
      phaseRef.current = 'prepared'
    }).then((fn) => {
      if (disposed) fn()
      else unlistenPrepare = fn
    })

    listen<BubbleTransitionEvent>('mascot-bubble-enter', (e) => {
      if (disposed) return
      const tid = e.payload?.transitionId ?? 0
      if (tid !== transitionIdRef.current) return
      logBubbleDev(`[bubble ${tid}] enter`)

      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = requestAnimationFrame(() => {
          if (disposed || transitionIdRef.current !== tid) return
          setPhase('entering')
          phaseRef.current = 'entering'
        })
      })
    }).then((fn) => {
      if (disposed) fn()
      else unlistenEnter = fn
    })

    listen<MascotBubblePayload>('mascot-bubble-summary', (e) => {
      if (disposed) return
      const p = e.payload
      const hasActive = p.running > 0 || p.waiting > 0

      if (hasActive) {
        lastValidSummaryRef.current = p
        setSummary(p)
        // If an update arrives while exiting, reverse back to entering
        if (phaseRef.current === 'exiting') {
          setPhase('entering')
          phaseRef.current = 'entering'
        }
      } else {
        if (phaseRef.current !== 'hidden' && phaseRef.current !== 'exiting') {
          setPhase('exiting')
          phaseRef.current = 'exiting'
        }
      }
    }).then((fn) => {
      if (disposed) fn()
      else unlistenSummary = fn
    })

    listen<BubbleTransitionEvent | undefined>('mascot-bubble-close', (e) => {
      if (disposed) return
      const tid = e?.payload?.transitionId
      if (tid != null) {
        transitionIdRef.current = tid
      }
      logBubbleDev(`[bubble ${transitionIdRef.current}] close`)
      if (phaseRef.current === 'hidden') return
      setPhase('exiting')
      phaseRef.current = 'exiting'
    }).then((fn) => {
      if (disposed) fn()
      else unlistenClose = fn
    })

    return () => {
      disposed = true
      unlistenPrepare?.()
      unlistenEnter?.()
      unlistenSummary?.()
      unlistenClose?.()
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current)
    }
  }, [])

  // The active payload to render (retain last valid summary during exiting so DOM does not collapse early)
  const displaySummary = summary || (phase === 'exiting' ? lastValidSummaryRef.current : null)

  // Measure geometry on commit whenever prepared
  useLayoutEffect(() => {
    if (phase === 'prepared') {
      syncGeometryAndNotifyReady(transitionIdRef.current)
    }
  }, [phase, displaySummary, syncGeometryAndNotifyReady])

  // Continuous ResizeObserver to synchronize size changes with Rust untransformed
  useEffect(() => {
    const el = contentRef.current
    if (!el || !displaySummary) return
    const ro = new ResizeObserver((entries) => {
      const target = entries[0]?.target as HTMLElement | undefined
      if (!target) return
      const width = Math.ceil(target.offsetWidth)
      const height = Math.ceil(target.offsetHeight)
      if (width <= 0 || height <= 0) return

      const last = lastSizeRef.current
      if (!last || last.width !== width || last.height !== height) {
        lastSizeRef.current = { width, height }
        logBubbleDev(`[bubble ro] resize ${width}x${height}`)
        invoke('sync_mascot_bubble', {
          width,
          height,
          entryOffsetX: BUBBLE_MOTION.reserveX,
          entryOffsetY: BUBBLE_MOTION.reserveY,
        }).catch(() => {})
      }

      if (phaseRef.current === 'prepared') {
        const tid = transitionIdRef.current
        if (readySentForTransitionRef.current !== tid) {
          readySentForTransitionRef.current = tid
          logBubbleDev(`[bubble ${tid}] ready (ro)`)
          emit('mascot-bubble-ready', { transitionId: tid }).catch(() => {})
        }
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [displaySummary])

  // Safety fallback for prefersReducedMotion: ensure exit completion is emitted without hanging
  useEffect(() => {
    if (prefersReducedMotion && phase === 'exiting') {
      const currentId = transitionIdRef.current
      setPhase('hidden')
      phaseRef.current = 'hidden'
      setSummary(null)
      logBubbleDev(`[bubble ${currentId}] exit complete (reduced-motion)`)
      emit('mascot-bubble-exit-complete', { transitionId: currentId }).catch(() => {})
    }
  }, [prefersReducedMotion, phase])

  const handleAnimationComplete = useCallback(() => {
    const currentPhase = phaseRef.current
    const currentId = transitionIdRef.current

    if (currentPhase === 'entering') {
      setPhase('visible')
      phaseRef.current = 'visible'
      logBubbleDev(`[bubble ${currentId}] visible`)
    } else if (currentPhase === 'exiting') {
      setPhase('hidden')
      phaseRef.current = 'hidden'
      setSummary(null)
      logBubbleDev(`[bubble ${currentId}] exit complete`)
      emit('mascot-bubble-exit-complete', { transitionId: currentId }).catch(() => {})
    }
  }, [])

  if (!displaySummary || phase === 'hidden') {
    return <div className="mascot-bubble-root" />
  }

  const hasRunning = displaySummary.running > 0
  const hasWaiting = displaySummary.waiting > 0
  if (!hasRunning && !hasWaiting && phase !== 'exiting') {
    return <div className="mascot-bubble-root" />
  }

  const isBubbleShown = phase === 'entering' || phase === 'visible'
  const isInteractive = isBubbleShown

  const handleClick = (sessionId?: string) => {
    if (!isInteractive) return
    emit('mascot-bubble-click', { sessionId }).catch(() => {})
    emit('mascot-bubble-session-click', { sessionId }).catch(() => {})
  }

  const sessionsToRender =
    displaySummary.activeSessions && displaySummary.activeSessions.length > 0
      ? displaySummary.activeSessions
      : displaySummary.activeSession
        ? [displaySummary.activeSession]
        : []

  const isDetailed = displaySummary.style === 'detailed' && sessionsToRender.length > 0

  const getThinkingText = (sessionId: string) => {
    const rawPool = t('mini.thinkingPool', { returnObjects: true })
    const pool = Array.isArray(rawPool) && rawPool.length > 0 ? (rawPool as string[]) : [t('mini.thinking', '思考中...')]
    const idx = hashSessionId(sessionId)
    return pool[idx % pool.length]
  }

  const totalActive = displaySummary.running + displaySummary.waiting
  const entryOffset = getBubbleEntryOffset('top-left')

  return (
    <div className="mascot-bubble-root">
      <motion.div
        className="mascot-bubble-motion"
        initial={false}
        animate={
          isBubbleShown
            ? {
                opacity: 1,
                scale: 1,
                x: 0,
                y: 0,
              }
            : {
                opacity: 1,
                scale: 1,
                x: prefersReducedMotion ? 0 : entryOffset.x,
                y: prefersReducedMotion ? 0 : entryOffset.y,
              }
        }
        transition={
          prefersReducedMotion
            ? { duration: 0 }
            : phase === 'exiting'
              ? BUBBLE_MOTION.exitSpring
              : BUBBLE_MOTION.spring
        }
        onAnimationComplete={handleAnimationComplete}
        style={{
          pointerEvents: isInteractive ? 'auto' : 'none',
        }}
      >
        <div className="mascot-bubble-logical-box" ref={contentRef}>
          {!isDetailed ? (
            <div
              className="mascot-bubble-card"
              onClick={() => handleClick()}
              role="button"
              tabIndex={0}
            >
              {hasRunning && (
                <div className="mascot-bubble-item">
                  <span className="mascot-bubble-beacon">
                    <span className="mascot-bubble-beacon-ring is-running" />
                    <span className="mascot-bubble-beacon-dot is-running" />
                  </span>
                  <span className="mascot-bubble-count is-running">{displaySummary.running}</span>
                  <span className="mascot-bubble-label">running</span>
                </div>
              )}

              {hasRunning && hasWaiting && <span className="mascot-bubble-divider" />}

              {hasWaiting && (
                <div className="mascot-bubble-item">
                  <span className="mascot-bubble-beacon">
                    <span className="mascot-bubble-beacon-ring is-waiting" />
                    <span className="mascot-bubble-beacon-dot is-waiting" />
                  </span>
                  <span className="mascot-bubble-count is-waiting">{displaySummary.waiting}</span>
                  <span className="mascot-bubble-label">waiting</span>
                </div>
              )}
            </div>
          ) : (
            <div className="mascot-bubble-stack">
              {sessionsToRender.map((session, idx) => {
                const thinkingText = session.status === 'processing' ? getThinkingText(session.sessionId) : undefined
                const { actionPrefix, actionContent, isWaiting, isProcessing } = getSessionLine2(session, t, thinkingText)
                const isLast = idx === sessionsToRender.length - 1
                const remainingOthers = Math.max(0, totalActive - sessionsToRender.length)
                const showBadge = isLast && remainingOthers > 0

                return (
                  <motion.div
                    key={session.sessionId || idx}
                    className="mascot-bubble-row-motion"
                    initial={{
                      opacity: 0,
                      y: prefersReducedMotion ? 0 : 4,
                    }}
                    animate={{
                      opacity: 1,
                      y: 0,
                    }}
                    transition={
                      prefersReducedMotion
                        ? { duration: 0 }
                        : {
                            delay: Math.min(idx, 3) * 0.035,
                            duration: 0.18,
                            ease: 'easeOut',
                          }
                    }
                  >
                    <div
                      className="mascot-bubble-detailed"
                      onClick={() => handleClick(session.sessionId)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          handleClick(session.sessionId)
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      title={session.title}
                    >
                      <div className="mascot-bubble-content">
                        {/* Line 1: Session Title / Topic + Metadata */}
                        <div className="mascot-bubble-title-line">
                          <CadencedShimmerText
                            active={(session.status === 'processing' || session.status === 'tool_running') && !isWaiting}
                            reducedMotion={Boolean(prefersReducedMotion)}
                          >
                            {session.title}
                          </CadencedShimmerText>

                          <div className="mascot-bubble-metadata-group">
                            {showBadge && (
                              <span
                                className="mascot-bubble-badge"
                                title={t('settings.bubbleActiveOthers', { count: remainingOthers })}
                              >
                                +{remainingOthers}
                              </span>
                            )}
                            {(session.source === 'codex' || session.source === 'antigravity') && (
                              <QuotaMiniBadge harness={session.source} />
                            )}
                          </div>
                        </div>

                        {/* Line 2: Current Action / Subagents */}
                        {session.activeSubagents && session.activeSubagents.length > 0 ? (
                          <SubagentsRow subagents={session.activeSubagents} />
                        ) : (
                          <div className={`mascot-bubble-action-line ${isWaiting ? 'is-waiting' : ''} ${isProcessing ? 'is-processing' : ''}`}>
                            {actionPrefix && <span className="mascot-bubble-tool-prefix">{actionPrefix}:</span>}
                            <span className="mascot-bubble-action-text truncate">
                              {actionContent || (actionPrefix ? '' : t('mini.working', 'working...'))}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </motion.div>
                )
              })}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  )
}
