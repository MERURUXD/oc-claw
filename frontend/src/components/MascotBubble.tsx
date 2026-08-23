import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

interface BubbleSummary {
  running: number
  waiting: number
}

/**
 * Mascot status bubble — a *passive* renderer for the `mascot-bubble` window
 * (`index.html#/mascot-bubble`).
 *
 * It only does three things:
 *   1. Listens for `mascot-bubble-summary` events emitted by Mini.tsx and
 *      renders a one-line "● N running · M waiting" summary.
 *   2. Measures its own content size with a ResizeObserver and reports it to
 *      Rust via `sync_mascot_bubble` so the window can be positioned next to
 *      the primary mascot.
 *   3. Renders nothing when no summary has arrived yet.
 *
 * It never polls sessions and never decides its own visibility — show/hide is
 * driven exclusively by Mini.tsx via `set_mascot_bubble_visible`.
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
  // to the mascot (right-aligned, above/below with platform-aware axes).
  useEffect(() => {
    const el = contentRef.current
    if (!el || !summary) return
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect) return
      const width = Math.min(Math.ceil(rect.width), 200)
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
  return (
    <div className="mascot-bubble-root">
      <div className="mascot-bubble-card" ref={contentRef}>
        <span className={`mascot-bubble-dot ${hasRunning ? 'is-running' : 'is-waiting'}`} />
        {hasRunning && <span className="mascot-bubble-running">{summary.running} running</span>}
        {hasWaiting && (
          <>
            {hasRunning && <span className="mascot-bubble-sep">·</span>}
            <span className="mascot-bubble-waiting">{summary.waiting} waiting</span>
          </>
        )}
      </div>
    </div>
  )
}
