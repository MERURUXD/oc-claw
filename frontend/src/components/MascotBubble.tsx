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
  const contentRef = useRef<HTMLDivElement>(null)
  const lastSizeRef = useRef<{ width: number; height: number } | null>(null)

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let disposed = false
    listen<MascotBubblePayload>('mascot-bubble-summary', (e) => {
      if (disposed) return
      setSummary(e.payload)
    }).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // Report content size changes to Rust so it can reposition the bubble next
  // to the mascot.
  useEffect(() => {
    const el = contentRef.current
    if (!el || !summary) return
    const ro = new ResizeObserver((entries) => {
      const el = entries[0]?.target as HTMLElement | undefined
      if (!el) return
      const rect = el.getBoundingClientRect()
      const width = Math.ceil(rect.width)
      const height = Math.ceil(rect.height)
      const last = lastSizeRef.current
      if (last && last.width === width && last.height === height) return
      lastSizeRef.current = { width, height }
      invoke('sync_mascot_bubble', { width, height }).catch(() => {})
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [summary])

  if (!summary) return <div className="mascot-bubble-root" />

  const hasRunning = summary.running > 0
  const hasWaiting = summary.waiting > 0
  if (!hasRunning && !hasWaiting) return <div className="mascot-bubble-root" />

  const handleClick = (sessionId?: string) => {
    emit('mascot-bubble-click', { sessionId }).catch(() => {})
    emit('mascot-bubble-session-click', { sessionId }).catch(() => {})
  }

  const sessionsToRender = (summary.activeSessions && summary.activeSessions.length > 0)
    ? summary.activeSessions
    : (summary.activeSession ? [summary.activeSession] : [])

  const isDetailed = summary.style === 'detailed' && sessionsToRender.length > 0

  if (!isDetailed) {
    return (
      <div className="mascot-bubble-root" ref={contentRef}>
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
              <span className="mascot-bubble-count is-running">{summary.running}</span>
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
              <span className="mascot-bubble-count is-waiting">{summary.waiting}</span>
              <span className="mascot-bubble-label">waiting</span>
            </div>
          )}
        </div>
      </div>
    )
  }

  const totalActive = summary.running + summary.waiting

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
              className={`mascot-bubble-detailed ${isWaiting ? 'is-waiting-card' : ''}`}
              onClick={() => handleClick(session.sessionId)}
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

