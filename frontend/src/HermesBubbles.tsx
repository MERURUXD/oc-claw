import { useEffect, useState } from 'react'
import { emit, listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'

// ─── Standalone Hermes bubble window (coding mode) ───
// Renders `index.html#/mini?bubbles=1`. A dumb renderer: the Mini window (the
// pet) owns session polling and pushes the sorted/capped bubble list via the
// `hermes-bubble-data` event; this window only draws it, reports its own
// interactive-rect geometry for the native passthrough poll, and forwards ✕
// dismissals back via `hermes-bubble-dismiss`.

type BubbleItem = {
  sessionId: string
  title: string
  body: string
  label: string
  status: 'waiting' | 'processing' | 'stopped'
}

export default function HermesBubbles() {
  const [bubbles, setBubbles] = useState<BubbleItem[]>([])

  // Receive the bubble feed from the Mini window.
  useEffect(() => {
    const unlisten = listen<BubbleItem[]>('hermes-bubble-data', (ev) => {
      setBubbles(Array.isArray(ev.payload) ? ev.payload : [])
    })
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [])

  // Report interactive rects (each bubble's ✕ button, padded) to Rust so the
  // passthrough poll knows where clicks belong; everything else passes through.
  useEffect(() => {
    let raf = 0
    const collect = () => {
      raf = 0
      try {
        const closeEls = document.querySelectorAll<HTMLElement>('[data-hermes-bubble-close]')
        type Rect = { x: number; y: number; w: number; h: number }
        const rects: Rect[] = []
        closeEls.forEach((el) => {
          const r = el.getBoundingClientRect()
          const pad = 6
          rects.push({
            x: Math.max(0, Math.round(r.left - pad)),
            y: Math.max(0, Math.round(r.top - pad)),
            w: Math.min(window.innerWidth, Math.round(r.width + pad * 2)),
            h: Math.min(window.innerHeight, Math.round(r.height + pad * 2)),
          })
        })
        invoke('set_hermes_bubble_hitboxes', { rectsJson: JSON.stringify(rects) }).catch(() => {})
      } catch {
        /* DOM not ready — skip this tick */
      }
    }
    collect()
    const tid = window.setInterval(collect, 500)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.clearInterval(tid)
    }
  }, [bubbles])

  // Report the live content height so Rust shrinks the window to hug the
  // stack (bottom edge anchored above the pet — kills the transparent dead
  // zone that made the bubble look far away). scrollHeight works even when
  // content overflows the current clip.
  useEffect(() => {
    let last = -1
    const report = () => {
      try {
        const root = document.querySelector<HTMLElement>('[data-hermes-bubble-stack]')
        if (!root || !root.lastElementChild) return
        // Measure the real visual extent (last bubble's bottom edge + the
        // root's top padding), NOT scrollHeight — the root is height:100%,
        // so scrollHeight would just echo the window height.
        const rootTop = root.getBoundingClientRect().top
        const lastBottom = root.lastElementChild.getBoundingClientRect().bottom
        const h = Math.ceil(lastBottom - rootTop)
        if (h > 0 && h !== last) {
          last = h
          invoke('set_hermes_bubble_content_height', { h }).catch(() => {})
        }
      } catch {
        /* DOM not ready */
      }
    }
    report()
    requestAnimationFrame(report)
    const tid = window.setTimeout(report, 250) // after webfonts/layout settle
    return () => window.clearTimeout(tid)
  }, [bubbles])

  return (
    <div
      data-hermes-bubble-stack
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-start',
        gap: 8,
        padding: '6px 0 2px 0',
        boxSizing: 'border-box',
        overflow: 'hidden',
        pointerEvents: 'none', // only the ✕ buttons opt back in — rest passes through natively anyway
      }}
    >
      {bubbles.map((b) => (
        <div
          key={b.sessionId}
          style={{
            width: '100%',
            padding: '8px 12px',
            borderRadius: 12,
            background: 'rgba(20, 20, 24, 0.92)',
            color: '#eee',
            boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
            border: '1px solid rgba(255,255,255,0.12)',
            backdropFilter: 'blur(6px)',
            fontFamily: 'inherit',
            textAlign: 'left',
            flex: 'none',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 0.3,
                color: '#fff',
                flex: 1,
                minWidth: 0,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {b.title}
            </span>
            <span style={{ fontSize: 11, opacity: 0.9 }}>{b.label}</span>
            <button
              type="button"
              data-hermes-bubble-close
              aria-label="close"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                emit('hermes-bubble-dismiss', b.sessionId).catch(() => {})
              }}
              style={{
                width: 16,
                height: 16,
                lineHeight: '14px',
                padding: 0,
                flex: 'none',
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.25)',
                background: 'transparent',
                color: 'rgba(255,255,255,0.75)',
                fontSize: 11,
                cursor: 'pointer',
                pointerEvents: 'auto',
                textAlign: 'center',
              }}
            >
              ✕
            </button>
          </div>
          <div
            style={{
              fontSize: 12,
              lineHeight: 1.45,
              color: '#d6d6dc',
              display: '-webkit-box',
              WebkitLineClamp: 1,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              wordBreak: 'break-word',
            }}
          >
            {b.body}
          </div>
        </div>
      ))}
    </div>
  )
}
