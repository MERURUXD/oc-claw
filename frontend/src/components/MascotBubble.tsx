import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { BubbleSessionDetail, MascotBubblePayload } from '../lib/types'
import { QuotaMiniBadge } from './QuotaCapsule'

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
 * Mascot status bubble — an interactive status capsule/card stack for the `mascot-bubble` window
 * (`index.html#/mascot-bubble`).
 *
 *   1. Listens for `mascot-bubble-summary` events emitted by Mini.tsx and
 *      renders either a compact glassmorphism capsule or a rich detailed status card stack.
 *   2. Measures its own content size with a ResizeObserver and reports it to
 *      Rust via `sync_mascot_bubble` so the window can be positioned next to
 *      the primary mascot.
 *   3. Allows clicking on individual bubble cards to interact
 *      (jump to terminal or expand panel).
 *   4. Renders nothing when no summary has arrived yet or no active sessions exist.
 */
export default function MascotBubble() {
  const { t } = useTranslation()
  const [summary, setSummary] = useState<MascotBubblePayload | null>(null)
  const [isEntering, setIsEntering] = useState(false)
  const [isExiting, setIsExiting] = useState(false)
  const lastValidSummaryRef = useRef<MascotBubblePayload | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const lastSizeRef = useRef<{ width: number; height: number } | null>(null)
  const enteringTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const exitingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wasActiveRef = useRef(false)

  // Listen for summary updates and close requests
  useEffect(() => {
    let unlistenSummary: (() => void) | undefined
    let unlistenClose: (() => void) | undefined
    let disposed = false

    const handleSummary = (payload: MascotBubblePayload) => {
      if (disposed) return
      const hasActive = payload.running > 0 || payload.waiting > 0

      if (hasActive) {
        lastValidSummaryRef.current = payload
        if (exitingTimerRef.current) {
          clearTimeout(exitingTimerRef.current)
          exitingTimerRef.current = null
        }
        setIsExiting(false)

        if (!wasActiveRef.current) {
          wasActiveRef.current = true
          setIsEntering(true)
          if (enteringTimerRef.current) clearTimeout(enteringTimerRef.current)
          enteringTimerRef.current = setTimeout(() => {
            setIsEntering(false)
            enteringTimerRef.current = null
          }, 450)
        }
        setSummary(payload)
      } else {
        // No active sessions
        if (wasActiveRef.current) {
          wasActiveRef.current = false
          setIsExiting(true)
          setIsEntering(false)
          if (exitingTimerRef.current) clearTimeout(exitingTimerRef.current)
          exitingTimerRef.current = setTimeout(() => {
            setSummary(null)
            setIsExiting(false)
            exitingTimerRef.current = null
          }, 260)
        } else {
          setSummary(null)
        }
      }
    }

    listen<MascotBubblePayload>('mascot-bubble-summary', (e) => {
      handleSummary(e.payload)
    }).then((fn) => {
      if (disposed) fn()
      else unlistenSummary = fn
    })

    listen('mascot-bubble-close', () => {
      if (disposed) return
      if (wasActiveRef.current) {
        wasActiveRef.current = false
        setIsExiting(true)
        setIsEntering(false)
        if (exitingTimerRef.current) clearTimeout(exitingTimerRef.current)
        exitingTimerRef.current = setTimeout(() => {
          setSummary(null)
          setIsExiting(false)
          exitingTimerRef.current = null
        }, 260)
      }
    }).then((fn) => {
      if (disposed) fn()
      else unlistenClose = fn
    })

    return () => {
      disposed = true
      unlistenSummary?.()
      unlistenClose?.()
      if (enteringTimerRef.current) clearTimeout(enteringTimerRef.current)
      if (exitingTimerRef.current) clearTimeout(exitingTimerRef.current)
    }
  }, [])

  // The active payload to render (fallback to lastValidSummary during exiting animation)
  const displaySummary = summary || (isExiting ? lastValidSummaryRef.current : null)

  // Report content size changes to Rust so it can reposition the bubble next
  // to the mascot. Use untransformed offsetWidth / offsetHeight so spring
  // transforms don't cause window resize jitter.
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
      if (last && last.width === width && last.height === height) return
      lastSizeRef.current = { width, height }
      invoke('sync_mascot_bubble', { width, height }).catch(() => {})
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [displaySummary])

  if (!displaySummary) return <div className="mascot-bubble-root" />

  const hasRunning = displaySummary.running > 0
  const hasWaiting = displaySummary.waiting > 0
  if (!hasRunning && !hasWaiting && !isExiting) return <div className="mascot-bubble-root" />

  const handleClick = (sessionId?: string) => {
    emit('mascot-bubble-click', { sessionId }).catch(() => {})
    emit('mascot-bubble-session-click', { sessionId }).catch(() => {})
  }

  const sessionsToRender = (displaySummary.activeSessions && displaySummary.activeSessions.length > 0)
    ? displaySummary.activeSessions
    : (displaySummary.activeSession ? [displaySummary.activeSession] : [])

  const isDetailed = displaySummary.style === 'detailed' && sessionsToRender.length > 0

  if (!isDetailed) {
    return (
      <div className="mascot-bubble-root" ref={contentRef}>
        <div
          className={`mascot-bubble-card ${isEntering ? 'is-entering' : ''} ${isExiting ? 'is-exiting' : ''}`}
          onClick={() => !isExiting && handleClick()}
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
      </div>
    )
  }

  const totalActive = displaySummary.running + displaySummary.waiting

  const getThinkingText = (sessionId: string) => {
    const rawPool = t('mini.thinkingPool', { returnObjects: true })
    const pool = Array.isArray(rawPool) && rawPool.length > 0 ? (rawPool as string[]) : [t('mini.thinking', '思考中...')]
    const idx = hashSessionId(sessionId)
    return pool[idx % pool.length]
  }

  return (
    <div className="mascot-bubble-root" ref={contentRef}>
      <div className="mascot-bubble-stack">
        {sessionsToRender.map((session, idx) => {
          const thinkingText = session.status === 'processing' ? getThinkingText(session.sessionId) : undefined
          const { actionPrefix, actionContent, isWaiting, isProcessing } = getSessionLine2(session, t, thinkingText)
          const isLast = idx === sessionsToRender.length - 1
          const remainingOthers = Math.max(0, totalActive - sessionsToRender.length)
          const showBadge = isLast && remainingOthers > 0

          return (
            <div
              key={session.sessionId || idx}
              className={`mascot-bubble-detailed ${isWaiting ? 'is-waiting-card' : ''} ${isEntering ? 'is-entering' : ''} ${isExiting ? 'is-exiting' : ''}`}
              onClick={() => !isExiting && handleClick(session.sessionId)}
              role="button"
              tabIndex={0}
              title={session.title}
            >
              <div className="mascot-bubble-content">
                {/* Line 1: Session Title / Topic */}
                <div className="mascot-bubble-title-line gap-1.5">
                  <span className="mascot-bubble-main-title truncate">{session.title}</span>
                  {(session.source === 'codex' || session.source === 'antigravity') && (
                    <QuotaMiniBadge harness={session.source} />
                  )}
                </div>

                {/* Line 2: Current Action / Status */}
                {session.activeSubagents && session.activeSubagents.length > 0 ? (
                  <div className="mascot-bubble-subagents-row">
                    <span className="mascot-bubble-subagent-robot">🤖</span>
                    {session.activeSubagents.map((sub, sIdx) => {
                      const isSubWorking = sub.status === 'tool_running' || sub.status === 'processing'
                      return (
                        <span key={sub.id || sIdx} className="mascot-bubble-subagent-chip">
                          <span className="mascot-bubble-subagent-role">[{sub.role}]</span>
                          {isSubWorking && <span className="mascot-bubble-subagent-dot" />}
                        </span>
                      )
                    })}
                  </div>
                ) : (
                  <div className={`mascot-bubble-action-line ${isWaiting ? 'is-waiting' : ''} ${isProcessing ? 'is-processing' : ''}`}>
                    {actionPrefix && <span className="mascot-bubble-tool-prefix">{actionPrefix}: </span>}
                    <span className="mascot-bubble-action-text">{actionContent || (actionPrefix ? '' : t('mini.working', 'working...'))}</span>
                  </div>
                )}
              </div>

              {/* Right side indicator: Spinner or Pulsing Dot + Badge */}
              <div className="mascot-bubble-status-area">
                {showBadge && (
                  <span
                    className="mascot-bubble-badge"
                    title={t('settings.bubbleActiveOthers', { count: remainingOthers })}
                  >
                    +{remainingOthers}
                  </span>
                )}
                {isWaiting ? (
                  <span className="mascot-bubble-beacon">
                    <span className="mascot-bubble-beacon-ring is-waiting" />
                    <span className="mascot-bubble-beacon-dot is-waiting" />
                  </span>
                ) : (
                  <span className="mascot-bubble-spinner" />
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

