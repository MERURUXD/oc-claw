import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'

interface BubbleSummary {
  running: number
  waiting: number
}

/**
 * Mascot status bubble — an interactive status capsule for the `mascot-bubble` window
 * (`index.html#/mascot-bubble`).
 *
 *   1. Listens for `mascot-bubble-summary` events emitted by Mini.tsx and
 *      renders a refined glassmorphism status capsule.
 *   2. Measures its own content size with a ResizeObserver and reports it to
 *      Rust via `sync_mascot_bubble` so the window can be positioned next to
 *      the primary mascot.
 *   3. Allows clicking on the bubble to expand the main session panel.
 *   4. Renders nothing when no summary has arrived yet.
 */
export default function MascotBubble() {
  const [summary, setSummary] = useState<BubbleSummary | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const lastSizeRef = useRef<{ width: number; height: number } | null>(null)

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let disposed = false
    listen<BubbleSummary>('mascot-bubble-summary', (e) => {
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
      const width = Math.min(Math.ceil(rect.width), 260)
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
