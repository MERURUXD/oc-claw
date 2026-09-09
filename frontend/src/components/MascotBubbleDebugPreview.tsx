import { useRef, useState } from 'react'
import { emit } from '@tauri-apps/api/event'
import MascotBubble from './MascotBubble'
import type { BubbleSessionDetail, MascotBubblePayload } from '../lib/types'

type DebugKind =
  | 'processing-generic'
  | 'processing-command'
  | 'waiting-approval'
  | 'waiting-user-input'

type DebugStyle = 'compact' | 'detailed'

function buildDebugBubblePayload(kind: DebugKind, style: DebugStyle): MascotBubblePayload {
  const sessionId = `debug-inject-${kind}`
  if (kind === 'processing-generic') {
    const s: BubbleSessionDetail = {
      sessionId,
      title: 'Debug Inject',
      source: 'cc',
      status: 'processing',
      activity: { kind: 'generic', summary: 'Thinking through the next step…', status: 'running', source: 'fallback' },
    }
    return { style, running: 1, waiting: 0, activeSession: s, activeSessions: [s] }
  }
  if (kind === 'processing-command') {
    const s: BubbleSessionDetail = {
      sessionId,
      title: 'Debug Inject',
      source: 'cc',
      status: 'tool_running',
      tool: 'Bash',
      activity: { kind: 'command', summary: 'Running command', toolName: 'Bash', status: 'running', source: 'fallback' },
    }
    return { style, running: 1, waiting: 0, activeSession: s, activeSessions: [s] }
  }
  if (kind === 'waiting-approval') {
    const s: BubbleSessionDetail = {
      sessionId,
      title: 'Debug Inject',
      source: 'cc',
      status: 'waiting',
      pendingInteraction: {
        kind: 'approval',
        interactionType: 'command',
        summary: 'Allow running: echo debug-inject',
        tool: 'Bash',
        approvalActions: { canDeny: true, canAllowTurn: true, canAllowSession: true },
      },
    }
    return { style, running: 0, waiting: 1, activeSession: s, activeSessions: [s] }
  }
  const s: BubbleSessionDetail = {
    sessionId,
    title: 'Debug Inject',
    source: 'cc',
    status: 'waiting',
    questionText: 'Which approach should we take?',
    pendingInteraction: { kind: 'user_input', summary: 'Which approach should we take?' },
  }
  return { style, running: 0, waiting: 1, activeSession: s, activeSessions: [s] }
}

export function MascotBubbleDebugPreview() {
  const transitionRef = useRef(10_000)
  const [style, setStyle] = useState<DebugStyle>('compact')

  const show = async (kind: DebugKind) => {
    const transitionId = ++transitionRef.current
    const payload = buildDebugBubblePayload(kind, style)
    await emit('mascot-bubble-prepare', { transitionId, payload }).catch(() => {})
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        emit('mascot-bubble-enter', { transitionId }).catch(() => {})
      })
    })
  }

  const clear = () => {
    const transitionId = ++transitionRef.current
    emit('mascot-bubble-close', { transitionId }).catch(() => {})
  }

  return (
    <>
      <MascotBubble />
      <div
        style={{
          position: 'fixed',
          left: 8,
          top: 8,
          zIndex: 9999,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          pointerEvents: 'auto',
          maxWidth: 220,
        }}
      >
        <div style={{ display: 'flex', gap: 4 }}>
          {(['compact', 'detailed'] as const).map((value) => (
            <button
              key={value}
              type="button"
              style={{ fontSize: 10, padding: '3px 5px', borderRadius: 5, background: style === value ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.7)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)' }}
              onClick={() => setStyle(value)}
            >
              {value}
            </button>
          ))}
        </div>
        {([
          'processing-generic',
          'processing-command',
          'waiting-approval',
          'waiting-user-input',
        ] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            style={{ fontSize: 11, padding: '4px 6px', borderRadius: 6, background: 'rgba(0,0,0,0.7)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)' }}
            onClick={() => void show(kind)}
          >
            {kind}
          </button>
        ))}
        <button
          type="button"
          style={{ fontSize: 11, padding: '4px 6px', borderRadius: 6, background: 'rgba(80,0,0,0.7)', color: '#f88', border: '1px solid rgba(255,100,100,0.3)' }}
          onClick={clear}
        >
          clear
        </button>
      </div>
    </>
  )
}
