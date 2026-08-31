import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { useTranslation } from 'react-i18next'
import type { MascotBubblePayload } from '../lib/types'

/**
 * Mascot status bubble — an interactive status capsule/card for the `mascot-bubble` window
 * (`index.html#/mascot-bubble`).
 *
 *   1. Listens for `mascot-bubble-summary` events emitted by Mini.tsx and
 *      renders either a compact glassmorphism capsule or a rich detailed status card.
 *   2. Measures its own content size with a ResizeObserver and reports it to
 *      Rust via `sync_mascot_bubble` so the window can be positioned next to
 *      the primary mascot.
 *   3. Allows clicking on the bubble card to interact
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

  const handleClick = () => {
    emit('mascot-bubble-click').catch(() => {})
  }

  const isDetailed = summary.style === 'detailed' && !!summary.activeSession
  const active = summary.activeSession

  if (!isDetailed || !active) {
    return (
      <div className="mascot-bubble-root" ref={contentRef}>
        <div
          className="mascot-bubble-card"
          onClick={handleClick}
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

  // Detailed View (Clean 2-line Card with side spinner / pulsing beacon)
  const isWaiting = active.status === 'waiting'
  const isToolRunning = active.status === 'tool_running'
  const isCompacting = active.status === 'compacting'

  // Dynamic Line 2 action / status text & prefix
  let actionPrefix: string | null = null
  let actionContent: string | null = null

  if (isWaiting) {
    actionContent = active.questionText || active.userPrompt || t('settings.bubbleJumpToTerminal', 'Waiting for input...')
  } else if (isToolRunning && active.tool) {
    actionPrefix = active.tool
    if (active.toolInput) {
      try {
        const inp = typeof active.toolInput === 'string' ? JSON.parse(active.toolInput) : active.toolInput
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
            actionContent = cleanVal
          }
        } else if (typeof inp === 'string') {
          actionContent = inp
        }
      } catch {
        actionContent = typeof active.toolInput === 'string' ? active.toolInput : null
      }
    }
  } else if (isCompacting) {
    actionContent = t('mini.compacting', 'compacting...')
  } else {
    actionContent = active.actionText || active.subtitle || active.userPrompt || t('mini.working', 'working...')
  }

  const otherCount = active.otherCount ?? ((summary.running + summary.waiting) - 1)

  return (
    <div className="mascot-bubble-root" ref={contentRef}>
      {/* Main status bubble card */}
      <div
        className={`mascot-bubble-detailed ${isWaiting ? 'is-waiting-card' : ''}`}
        onClick={handleClick}
        role="button"
        tabIndex={0}
        title={active.title}
      >
        <div className="mascot-bubble-content">
          {/* Line 1: Session Title / Topic */}
          <div className="mascot-bubble-title-line">
            <span className="mascot-bubble-main-title">{active.title}</span>
          </div>

          {/* Line 2: Current Action / Status */}
          <div className={`mascot-bubble-action-line ${isWaiting ? 'is-waiting' : ''}`}>
            {actionPrefix && <span className="mascot-bubble-tool-prefix">{actionPrefix}: </span>}
            <span className="mascot-bubble-action-text">{actionContent || (actionPrefix ? '' : t('mini.working', 'working...'))}</span>
          </div>
        </div>

        {/* Right side indicator: Spinner or Pulsing Dot + Badge */}
        <div className="mascot-bubble-status-area">
          {otherCount > 0 && (
            <span
              className="mascot-bubble-badge"
              title={t('settings.bubbleActiveOthers', { count: otherCount })}
            >
              +{otherCount}
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
    </div>
  )
}

