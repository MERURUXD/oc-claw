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
} from '../lib/types'
import { QuotaMiniBadge } from './QuotaCapsule'

const BUBBLE_HIDDEN_SCALE = 0.97
const BUBBLE_HIDDEN_Y = 8
const BUBBLE_SPRING_TRANSITION = {
  type: 'spring' as const,
  stiffness: 360,
  damping: 26,
  mass: 0.8,
}

type BubblePhase =
  | 'hidden'
  | 'prepared'
  | 'entering'
  | 'visible'
  | 'exiting'

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

const SHIMMER_INITIAL_DELAY_MS = 600
const SHIMMER_ACTIVE_MS = 1000
const SHIMMER_INTERVAL_MS = 4000

/**
 * Codex-style Cadenced Shimmer for session title:
 * - 600ms initial delay after active
 * - 1000ms active sweep (mask/sweep translated opposite to highlight layer)
 * - 4000ms cadence interval (1s sweep, ~3s quiet)
 * - steps(48, end) timing
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
      }, SHIMMER_ACTIVE_MS)
    }

    initialTimer = setTimeout(() => {
      triggerSweep()
      intervalTimer = setInterval(() => {
        triggerSweep()
      }, SHIMMER_INTERVAL_MS)
    }, SHIMMER_INITIAL_DELAY_MS)

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
 * Mascot status bubble — an interactive status capsule/card stack for the `mascot-bubble` window
 * (`index.html#/mascot-bubble`).
 *
 * Synchronizes with Mini.tsx via an explicit handshake protocol:
 *   1. Mini emits `mascot-bubble-prepare` with a monotonic transitionId.
 *   2. MascotBubble renders content in hidden spring state (opacity: 0, scale: 0.97, y: 8),
 *      measures untransformed geometry (offsetWidth / offsetHeight), reports to Rust via `sync_mascot_bubble`,
 *      and emits `mascot-bubble-ready`.
 *   3. Mini shows the native window and emits `mascot-bubble-enter`.
 *   4. MascotBubble awaits double requestAnimationFrame and springs to visible state.
 *   5. When closing, Mini emits `mascot-bubble-close`. MascotBubble springs back to hidden state,
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

    lastSizeRef.current = { width, height }
    invoke('sync_mascot_bubble', { width, height })
      .then(() => {
        if (readySentForTransitionRef.current !== tid && transitionIdRef.current === tid) {
          readySentForTransitionRef.current = tid
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
        invoke('sync_mascot_bubble', { width, height }).catch(() => {})
      }

      if (phaseRef.current === 'prepared') {
        const tid = transitionIdRef.current
        if (readySentForTransitionRef.current !== tid) {
          readySentForTransitionRef.current = tid
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
      emit('mascot-bubble-exit-complete', { transitionId: currentId }).catch(() => {})
    }
  }, [prefersReducedMotion, phase])

  const handleAnimationComplete = useCallback(() => {
    const currentPhase = phaseRef.current
    const currentId = transitionIdRef.current

    if (currentPhase === 'entering') {
      setPhase('visible')
      phaseRef.current = 'visible'
    } else if (currentPhase === 'exiting') {
      setPhase('hidden')
      phaseRef.current = 'hidden'
      setSummary(null)
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

  return (
    <div className="mascot-bubble-root" ref={contentRef}>
      <motion.div
        className="mascot-bubble-motion"
        initial={false}
        animate={
          isBubbleShown
            ? {
                opacity: 1,
                scale: 1,
                y: 0,
              }
            : {
                opacity: 0,
                scale: prefersReducedMotion ? 1 : BUBBLE_HIDDEN_SCALE,
                y: prefersReducedMotion ? 0 : BUBBLE_HIDDEN_Y,
              }
        }
        transition={
          prefersReducedMotion
            ? { duration: 0 }
            : BUBBLE_SPRING_TRANSITION
        }
        onAnimationComplete={handleAnimationComplete}
        style={{
          pointerEvents: isInteractive ? 'auto' : 'none',
        }}
      >
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
                        <div className="mascot-bubble-subagents-row">
                          {session.activeSubagents.map((sub, sIdx) => {
                            const isSubWorking = sub.status === 'tool_running' || sub.status === 'processing'
                            return (
                              <span
                                key={sub.id || sIdx}
                                className="mascot-bubble-subagent-chip"
                                title={`${sub.role} (${sub.status})`}
                              >
                                <span className="mascot-bubble-subagent-role">{sub.role}</span>
                                {isSubWorking && <span className="mascot-bubble-subagent-dot" />}
                              </span>
                            )
                          })}
                        </div>
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
      </motion.div>
    </div>
  )
}

