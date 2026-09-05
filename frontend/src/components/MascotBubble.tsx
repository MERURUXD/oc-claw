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
import { formatActivity } from '../lib/activityFormat'
import { isSameBubblePayload } from '../lib/sessionActivity'
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
  staggerDelay: 0.035,
  exitFadeDuration: 0.18,
  exitFadeDelay: 0.08,
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

export type BubblePhase =
  | 'hidden'
  | 'prepared'
  | 'entering'
  | 'visible'
  | 'exiting'

export type BubbleGeometryMode = 'stable' | 'motion'

export type RowMotionMode =
  | 'none'
  | 'incremental-entry'
  | 'global-entry'
  | 'global-exit'

export function getSessionsFromPayload(payload?: MascotBubblePayload | null): BubbleSessionDetail[] {
  if (!payload) return []
  if (payload.activeSessions && payload.activeSessions.length > 0) {
    return payload.activeSessions
  }
  if (payload.activeSession) {
    return [payload.activeSession]
  }
  return []
}

export function getSessionIdsFromPayload(payload?: MascotBubblePayload | null): string[] {
  return getSessionsFromPayload(payload)
    .map((s) => s.sessionId)
    .filter(Boolean)
}

export function getRowMotionMode({
  phase,
  isMultiSession,
  isIncremental,
}: {
  phase: BubblePhase
  isMultiSession: boolean
  isIncremental: boolean
}): RowMotionMode {
  if (phase === 'exiting') {
    return isMultiSession ? 'global-exit' : 'none'
  }
  if (phase === 'prepared' || phase === 'entering') {
    return isMultiSession ? 'global-entry' : 'none'
  }
  if (phase === 'visible') {
    return isIncremental ? 'incremental-entry' : 'none'
  }
  return 'none'
}

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
  fallbackThinkingText?: string
): { actionPrefix: string | null; actionContent: string; isWaiting: boolean; isProcessing: boolean } {
  const isWaiting = session.status === 'waiting'
  const isRunning = session.status === 'processing' || session.status === 'tool_running'
  const isProcessing = session.status === 'processing'

  // 1. Waiting for user interaction / question / approval
  if (isWaiting) {
    if (session.pendingInteraction?.kind === 'approval') {
      const isFileChange = session.pendingInteraction.interactionType === 'file_change'
      const icon = isFileChange ? '✏️' : '🔐'
      const label = isFileChange
        ? t('mini.waitingFileApproval', '等待确认修改')
        : t('mini.waitingApproval', '等待批准')
      const target =
        session.pendingInteraction.summary ||
        session.pendingInteraction.tool ||
        session.pendingInteraction.detail ||
        session.questionText ||
        session.userPrompt ||
        t('settings.bubbleJumpToTerminal', 'Waiting for input...')
      const firstLine = target.split('\n')[0].trim()
      const displayTarget = firstLine.length > 80 ? firstLine.slice(0, 80) + '...' : firstLine
      return {
        actionPrefix: null,
        actionContent: `${icon} ${label} · ${displayTarget}`,
        isWaiting: true,
        isProcessing: false,
      }
    }

    if (session.pendingInteraction?.kind === 'user_input') {
      const icon = '❓'
      const label = t('mini.waitingYourAnswer', '等你回答')
      const target =
        session.pendingInteraction.summary ||
        session.pendingInteraction.detail ||
        session.questionText ||
        session.userPrompt ||
        t('settings.bubbleJumpToTerminal', 'Waiting for input...')
      const firstLine = target.split('\n')[0].trim()
      const displayTarget = firstLine.length > 80 ? firstLine.slice(0, 80) + '...' : firstLine
      return {
        actionPrefix: null,
        actionContent: `${icon} ${label} · ${displayTarget}`,
        isWaiting: true,
        isProcessing: false,
      }
    }

    return {
      actionPrefix: null,
      actionContent: session.questionText || session.userPrompt || t('settings.bubbleJumpToTerminal', 'Waiting for input...'),
      isWaiting: true,
      isProcessing: false,
    }
  }

  // 2. Active subagents
  if (session.activeSubagents && session.activeSubagents.length > 0) {
    const roles = session.activeSubagents.map((s) => s.role).filter(Boolean)
    if (roles.length > 0) {
      return {
        actionPrefix: null,
        actionContent: `[${roles.join(', ')}]`,
        isWaiting: false,
        isProcessing,
      }
    }
  }

  // 3. Normalized Session Activity (reasoning summary, tool call, command, search, read, edit, etc.)
  if (isRunning && session.activity) {
    const formatted = formatActivity(session.activity, t)
    if (formatted) {
      return {
        actionPrefix: null,
        actionContent: formatted,
        isWaiting: false,
        isProcessing: session.status === 'processing',
      }
    }
  }

  // 4. Compacting
  if (session.status === 'compacting') {
    return {
      actionPrefix: null,
      actionContent: t('mini.compacting', 'compacting...'),
      isWaiting: false,
      isProcessing: false,
    }
  }

  // 5. Legacy tool running fallback (if activity not present)
  if (session.status === 'tool_running' && session.tool) {
    const toolLower = session.tool.toLowerCase()
    if (toolLower.includes('command') || toolLower.includes('bash') || toolLower.includes('shell')) {
      return {
        actionPrefix: null,
        actionContent: t('mini.activityRunningCommand', 'Running command'),
        isWaiting: false,
        isProcessing: false,
      }
    }
    const param = extractToolParam(session.toolInput)
    return {
      actionPrefix: session.tool,
      actionContent: param || session.actionText || '',
      isWaiting: false,
      isProcessing: false,
    }
  }

  // 6. Processing thinking pool fallback
  if (isProcessing) {
    return {
      actionPrefix: null,
      actionContent: fallbackThinkingText || t('mini.thinking', '思考中...'),
      isWaiting: false,
      isProcessing: true,
    }
  }

  // 7. General fallback
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

interface SessionBubbleRowProps {
  session: BubbleSessionDetail
  idx: number
  phase: BubblePhase
  isMultiSession: boolean
  incrementalEntry?: { delay: number }
  prefersReducedMotion: boolean | null
  entryOffset: { x: number; y: number }
  onClick: (sessionId: string) => void
  onAnimationComplete: (sessionId: string) => void
  t: TFunction
  thinkingText?: string
  fallbackThinkingText?: string
  showBadge: boolean
  remainingOthers: number
}

function SessionBubbleRow({
  session,
  idx,
  phase,
  isMultiSession,
  incrementalEntry,
  prefersReducedMotion,
  entryOffset,
  onClick,
  onAnimationComplete,
  t,
  thinkingText,
  fallbackThinkingText,
  showBadge,
  remainingOthers,
}: SessionBubbleRowProps) {
  const fallback = fallbackThinkingText || thinkingText
  const { actionPrefix, actionContent, isWaiting, isProcessing } = getSessionLine2(session, t, fallback)

  const mode = getRowMotionMode({
    phase,
    isMultiSession,
    isIncremental: incrementalEntry != null,
  })

  const rowDelay = Math.min(idx, 3) * BUBBLE_MOTION.staggerDelay

  let initial: false | { opacity: number; x: number; y: number; scale: number } = false
  let animate: { opacity: number; x: number; y: number; scale: number }
  let transition: any

  if (prefersReducedMotion) {
    initial = false
    animate = {
      opacity: mode === 'global-exit' ? 0 : 1,
      x: 0,
      y: 0,
      scale: 1,
    }
    transition = { duration: 0 }
  } else {
    switch (mode) {
      case 'incremental-entry':
        initial = {
          opacity: 1,
          x: entryOffset.x,
          y: entryOffset.y,
          scale: 1,
        }
        animate = {
          opacity: 1,
          x: 0,
          y: 0,
          scale: 1,
        }
        transition = {
          ...BUBBLE_MOTION.spring,
          delay: incrementalEntry?.delay ?? 0,
        }
        break

      case 'global-entry':
        initial = {
          opacity: 1,
          x: entryOffset.x,
          y: entryOffset.y,
          scale: 1,
        }
        animate = {
          opacity: 1,
          x: phase === 'prepared' ? entryOffset.x : 0,
          y: phase === 'prepared' ? entryOffset.y : 0,
          scale: 1,
        }
        transition =
          phase === 'prepared'
            ? { duration: 0 }
            : {
                ...BUBBLE_MOTION.spring,
                delay: rowDelay,
              }
        break

      case 'global-exit':
        initial = false
        animate = {
          opacity: 0,
          x: entryOffset.x,
          y: entryOffset.y,
          scale: 1,
        }
        transition = {
          x: { ...BUBBLE_MOTION.exitSpring, delay: rowDelay },
          y: { ...BUBBLE_MOTION.exitSpring, delay: rowDelay },
          opacity: {
            duration: BUBBLE_MOTION.exitFadeDuration,
            ease: 'easeOut',
            delay: BUBBLE_MOTION.exitFadeDelay + rowDelay,
          },
        }
        break

      case 'none':
      default:
        initial = false
        animate = {
          opacity: 1,
          x: 0,
          y: 0,
          scale: 1,
        }
        transition = { duration: 0 }
        break
    }
  }

  return (
    <motion.div
      key={session.sessionId}
      className="mascot-bubble-row-motion"
      initial={initial}
      animate={animate}
      transition={transition}
      onAnimationComplete={() => onAnimationComplete(session.sessionId)}
    >
      <div
        className="mascot-bubble-detailed"
        onClick={() => onClick(session.sessionId)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onClick(session.sessionId)
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
}

/**
 * Mascot status bubble — an interactive status capsule/card stack for the `mascot-bubble` window
 * (`index.html#/mascot-bubble`).
 *
 * Synchronizes with Mini.tsx via an explicit handshake protocol:
 *   1. Mini emits `mascot-bubble-prepare` with a monotonic transitionId.
 *   2. MascotBubble renders content in hidden 2D offset state (x: -150, y: -95, scale: 1, opacity: 1),
 *      measures untransformed geometry (offsetWidth / offsetHeight), reports to Rust via `sync_mascot_bubble`
 *      with motion reserve, and emits `mascot-bubble-ready`.
 *   3. Mini shows the native window and emits `mascot-bubble-enter`.
 *   4. MascotBubble awaits double requestAnimationFrame and springs to visible state (0, 0).
 *   5. When animation settles in visible state, native geometry shrinks from motion mode to stable mode (0 reserve).
 *   6. When closing, Mini emits `mascot-bubble-close`. MascotBubble expands back to motion mode, springs to (-150, -95)
 *      with concurrent opacity fade-out, and on animation completion emits `mascot-bubble-exit-complete`.
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

  // Session tracking and incremental entry state
  const knownSessionIdsRef = useRef<Set<string>>(new Set())
  const seenTurnKeysRef = useRef<Set<string>>(new Set())
  const [incrementalEntries, setIncrementalEntries] = useState<Record<string, { delay: number }>>({})
  const incrementalEntriesRef = useRef<Record<string, { delay: number }>>({})
  incrementalEntriesRef.current = incrementalEntries

  // Active motion tracking and transient envelope mode
  const activeMotionTokensRef = useRef<Set<string>>(new Set())
  const currentGeometryModeRef = useRef<BubbleGeometryMode>('motion')

  // Multi-row completion tracking
  const enteringCompletedSessionIdsRef = useRef<Set<string>>(new Set())
  const exitingCompletedSessionIdsRef = useRef<Set<string>>(new Set())

  const isMultiSessionRef = useRef<boolean>(false)
  const sessionsToRenderRef = useRef<BubbleSessionDetail[]>([])

  // Unified geometry synchronization helper
  const syncBubbleGeometry = useCallback((mode: BubbleGeometryMode, options?: { preserveAnchor?: boolean }) => {
    const el = contentRef.current
    if (!el) return Promise.resolve()
    const width = Math.ceil(el.offsetWidth)
    const height = Math.ceil(el.offsetHeight)
    if (width <= 0 || height <= 0) return Promise.resolve()

    currentGeometryModeRef.current = mode
    lastSizeRef.current = { width, height }

    const entryOffsetX = mode === 'motion' ? BUBBLE_MOTION.reserveX : 0
    const entryOffsetY = mode === 'motion' ? BUBBLE_MOTION.reserveY : 0
    const preserveAnchor = options?.preserveAnchor ?? (mode === 'stable' || phaseRef.current === 'exiting' || phaseRef.current === 'visible')

    logBubbleDev(`[bubble] syncBubbleGeometry mode=${mode} size=${width}x${height} offset=${entryOffsetX}x${entryOffsetY} preserve=${preserveAnchor}`)
    return invoke('sync_mascot_bubble', {
      width,
      height,
      entryOffsetX,
      entryOffsetY,
      preserveAnchor,
    }).catch(() => {})
  }, [])

  // Measure geometry and notify Mini that the bubble is ready to be natively shown
  const syncGeometryAndNotifyReady = useCallback((tid: number) => {
    const el = contentRef.current
    if (!el) return
    const width = Math.ceil(el.offsetWidth)
    const height = Math.ceil(el.offsetHeight)
    if (width <= 0 || height <= 0) return

    currentGeometryModeRef.current = 'motion'
    lastSizeRef.current = { width, height }

    logBubbleDev(`[bubble ${tid}] geometry ${width}x${height} (motion mode, fresh anchor)`)

    invoke('sync_mascot_bubble', {
      width,
      height,
      entryOffsetX: BUBBLE_MOTION.reserveX,
      entryOffsetY: BUBBLE_MOTION.reserveY,
      preserveAnchor: false,
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

      enteringCompletedSessionIdsRef.current.clear()
      exitingCompletedSessionIdsRef.current.clear()
      activeMotionTokensRef.current.clear()
      activeMotionTokensRef.current.add('global-entry')
      currentGeometryModeRef.current = 'motion'
      setIncrementalEntries({})
      incrementalEntriesRef.current = {}

      if (newPayload) {
        lastValidSummaryRef.current = newPayload
        setSummary(newPayload)
        const initialSessions = getSessionsFromPayload(newPayload)
        const initialSessionIds = initialSessions.map((s) => s.sessionId).filter(Boolean)
        knownSessionIdsRef.current = new Set(initialSessionIds)
        seenTurnKeysRef.current = new Set(
          initialSessions.map((s) => `${s.sessionId}:${s.turnId || 'legacy'}`)
        )
      } else {
        knownSessionIdsRef.current.clear()
        seenTurnKeysRef.current.clear()
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
          enteringCompletedSessionIdsRef.current.clear()
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
        if (phaseRef.current === 'visible' && isSameBubblePayload(lastValidSummaryRef.current, p)) {
          return
        }
        lastValidSummaryRef.current = p
        const currentSessions = getSessionsFromPayload(p)
        const currentSessionIds = currentSessions.map((s) => s.sessionId).filter(Boolean)
        const currentPhase = phaseRef.current

        // Check for removed sessions (were known, but no longer in current payload)
        for (const prevId of knownSessionIdsRef.current) {
          if (!currentSessionIds.includes(prevId)) {
            logBubbleDev(`[bubble-membership] session=${prevId} action=remove`)
          }
        }

        if (currentPhase === 'visible') {
          // Categorize sessions not in knownSessionIdsRef: truly new vs. reappear same turn
          const trulyNewIncrementalSessions: BubbleSessionDetail[] = []
          for (const session of currentSessions) {
            const sid = session.sessionId
            if (!knownSessionIdsRef.current.has(sid)) {
              const turnKey = `${sid}:${session.turnId || 'legacy'}`
              if (seenTurnKeysRef.current.has(turnKey)) {
                // Same session + same turn returning after transient absence:
                // DEFINITELY NO INCREMENTAL-ENTRY!
                logBubbleDev(`[bubble-membership] session=${sid} turn=${session.turnId || 'legacy'} action=reappear_same_turn`)
              } else {
                // Brand-new session / new turn!
                trulyNewIncrementalSessions.push(session)
                logBubbleDev(`[bubble-membership] session=${sid} turn=${session.turnId || 'legacy'} action=add`)
              }
            }
          }

          // Register all current turns into seenTurnKeysRef
          currentSessions.forEach((s) => {
            seenTurnKeysRef.current.add(`${s.sessionId}:${s.turnId || 'legacy'}`)
          })

          const newIncrementalIds = trulyNewIncrementalSessions.map((s) => s.sessionId)
          if (newIncrementalIds.length > 0) {
            logBubbleDev(`[bubble] incremental sessions added:`, newIncrementalIds)
            newIncrementalIds.forEach((id) => {
              activeMotionTokensRef.current.add(`incremental:${id}`)
            })

            const startIncrementalEntry = () => {
              if (disposed) return
              setIncrementalEntries((prev) => {
                const next = { ...prev }
                newIncrementalIds.forEach((id, newIdx) => {
                  next[id] = {
                    delay: Math.min(newIdx, 3) * BUBBLE_MOTION.staggerDelay,
                  }
                })
                return next
              })
              setSummary(p)
            }

            // Expand to motion geometry before row begins flight to guarantee envelope
            if (currentGeometryModeRef.current !== 'motion') {
              syncBubbleGeometry('motion', { preserveAnchor: true }).then(() => {
                requestAnimationFrame(() => {
                  requestAnimationFrame(() => {
                    startIncrementalEntry()
                  })
                })
              })
            } else {
              startIncrementalEntry()
            }
            knownSessionIdsRef.current = new Set(currentSessionIds)
            return
          }
        }

        // Register all current turns into seenTurnKeysRef
        currentSessions.forEach((s) => {
          seenTurnKeysRef.current.add(`${s.sessionId}:${s.turnId || 'legacy'}`)
        })

        // Normal payload update or non-visible phase (or reappear-only update)
        knownSessionIdsRef.current = new Set(currentSessionIds)
        setSummary(p)

        // If an update arrives while exiting, reverse back to entering
        if (phaseRef.current === 'exiting') {
          exitingCompletedSessionIdsRef.current.clear()
          enteringCompletedSessionIdsRef.current.clear()
          activeMotionTokensRef.current.clear()
          activeMotionTokensRef.current.add('global-entry')
          if (currentGeometryModeRef.current !== 'motion') {
            syncBubbleGeometry('motion', { preserveAnchor: true })
          }
          setPhase('entering')
          phaseRef.current = 'entering'
        }
      } else {
        if (phaseRef.current !== 'hidden' && phaseRef.current !== 'exiting') {
          exitingCompletedSessionIdsRef.current.clear()
          activeMotionTokensRef.current.add('global-exit')

          const startExit = () => {
            if (disposed) return
            setPhase('exiting')
            phaseRef.current = 'exiting'
          }

          if (currentGeometryModeRef.current === 'stable') {
            syncBubbleGeometry('motion', { preserveAnchor: true }).then(() => {
              requestAnimationFrame(() => {
                startExit()
              })
            })
          } else {
            startExit()
          }
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
      exitingCompletedSessionIdsRef.current.clear()
      activeMotionTokensRef.current.add('global-exit')

      const startExit = () => {
        if (disposed) return
        setPhase('exiting')
        phaseRef.current = 'exiting'
      }

      if (currentGeometryModeRef.current === 'stable') {
        syncBubbleGeometry('motion', { preserveAnchor: true }).then(() => {
          requestAnimationFrame(() => {
            startExit()
          })
        })
      } else {
        startExit()
      }
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
  }, [syncBubbleGeometry])

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

      const isMotionActive = activeMotionTokensRef.current.size > 0 || phaseRef.current !== 'visible'
      const targetMode: BubbleGeometryMode = isMotionActive ? 'motion' : 'stable'
      currentGeometryModeRef.current = targetMode

      const last = lastSizeRef.current
      if (!last || last.width !== width || last.height !== height) {
        lastSizeRef.current = { width, height }
        logBubbleDev(`[bubble ro] resize ${width}x${height} mode=${targetMode}`)
        const entryOffsetX = targetMode === 'motion' ? BUBBLE_MOTION.reserveX : 0
        const entryOffsetY = targetMode === 'motion' ? BUBBLE_MOTION.reserveY : 0
        const preserveAnchor = phaseRef.current !== 'prepared'
        invoke('sync_mascot_bubble', {
          width,
          height,
          entryOffsetX,
          entryOffsetY,
          preserveAnchor,
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

  // Safety fallback for prefersReducedMotion: ensure exit/enter completion is emitted without hanging
  useEffect(() => {
    if (prefersReducedMotion && phase === 'exiting') {
      const currentId = transitionIdRef.current
      setPhase('hidden')
      phaseRef.current = 'hidden'
      setSummary(null)
      logBubbleDev(`[bubble ${currentId}] exit complete (reduced-motion)`)
      emit('mascot-bubble-exit-complete', { transitionId: currentId }).catch(() => {})
    } else if (prefersReducedMotion && phase === 'entering') {
      const currentId = transitionIdRef.current
      activeMotionTokensRef.current.delete('global-entry')
      setPhase('visible')
      phaseRef.current = 'visible'
      logBubbleDev(`[bubble ${currentId}] visible (reduced-motion)`)
      syncBubbleGeometry('stable', { preserveAnchor: true })
      emit('mascot-bubble-visible', { transitionId: currentId }).catch(() => {})
    }
  }, [prefersReducedMotion, phase, syncBubbleGeometry])

  const handleAnimationComplete = useCallback(() => {
    // If multi-session, row animations control phase completion
    if (isMultiSessionRef.current) return

    const currentPhase = phaseRef.current
    const currentId = transitionIdRef.current

    if (currentPhase === 'entering') {
      activeMotionTokensRef.current.delete('global-entry')
      setPhase('visible')
      phaseRef.current = 'visible'
      logBubbleDev(`[bubble ${currentId}] visible`)
      if (activeMotionTokensRef.current.size === 0) {
        syncBubbleGeometry('stable', { preserveAnchor: true })
      }
      emit('mascot-bubble-visible', { transitionId: currentId }).catch(() => {})
    } else if (currentPhase === 'exiting') {
      activeMotionTokensRef.current.delete('global-exit')
      setPhase('hidden')
      phaseRef.current = 'hidden'
      setSummary(null)
      logBubbleDev(`[bubble ${currentId}] exit complete`)
      emit('mascot-bubble-exit-complete', { transitionId: currentId }).catch(() => {})
    }
  }, [syncBubbleGeometry])

  const handleRowAnimationComplete = useCallback(
    (sessionId: string) => {
      const currentPhase = phaseRef.current
      const currentId = transitionIdRef.current

      // If this was an incremental entry row
      if (incrementalEntriesRef.current[sessionId]) {
        activeMotionTokensRef.current.delete(`incremental:${sessionId}`)
        setIncrementalEntries((prev) => {
          if (!prev[sessionId]) return prev
          const { [sessionId]: _, ...rest } = prev
          return rest
        })
        if (activeMotionTokensRef.current.size === 0 && phaseRef.current === 'visible') {
          syncBubbleGeometry('stable', { preserveAnchor: true })
        }
      }

      if (!isMultiSessionRef.current) return

      if (currentPhase === 'entering') {
        enteringCompletedSessionIdsRef.current.add(sessionId)
        const currentSessions = sessionsToRenderRef.current
        if (
          currentSessions.length > 0 &&
          currentSessions.every((s) => enteringCompletedSessionIdsRef.current.has(s.sessionId))
        ) {
          activeMotionTokensRef.current.delete('global-entry')
          setPhase('visible')
          phaseRef.current = 'visible'
          logBubbleDev(`[bubble ${currentId}] multi-row visible`)
          if (activeMotionTokensRef.current.size === 0) {
            syncBubbleGeometry('stable', { preserveAnchor: true })
          }
          emit('mascot-bubble-visible', { transitionId: currentId }).catch(() => {})
        }
      } else if (currentPhase === 'exiting') {
        exitingCompletedSessionIdsRef.current.add(sessionId)
        const currentSessions = sessionsToRenderRef.current
        if (
          currentSessions.length > 0 &&
          currentSessions.every((s) => exitingCompletedSessionIdsRef.current.has(s.sessionId))
        ) {
          activeMotionTokensRef.current.delete('global-exit')
          setPhase('hidden')
          phaseRef.current = 'hidden'
          setSummary(null)
          knownSessionIdsRef.current.clear()
          seenTurnKeysRef.current.clear()
          logBubbleDev(`[bubble ${currentId}] multi-row exit complete`)
          emit('mascot-bubble-exit-complete', { transitionId: currentId }).catch(() => {})
        }
      }
    },
    [syncBubbleGeometry]
  )

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
  const isMultiSession = isDetailed && sessionsToRender.length > 1

  isMultiSessionRef.current = isMultiSession
  sessionsToRenderRef.current = sessionsToRender

  const getFallbackThinkingText = (sessionId: string) => {
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
          isMultiSession
            ? {
                opacity: 1,
                scale: 1,
                x: 0,
                y: 0,
              }
            : isBubbleShown
              ? {
                  opacity: 1,
                  scale: 1,
                  x: 0,
                  y: 0,
                }
              : {
                  opacity: phase === 'exiting' ? 0 : 1,
                  scale: 1,
                  x: prefersReducedMotion ? 0 : entryOffset.x,
                  y: prefersReducedMotion ? 0 : entryOffset.y,
                }
        }
        transition={
          isMultiSession || prefersReducedMotion
            ? { duration: 0 }
            : phase === 'exiting'
              ? {
                  x: BUBBLE_MOTION.exitSpring,
                  y: BUBBLE_MOTION.exitSpring,
                  opacity: {
                    duration: BUBBLE_MOTION.exitFadeDuration,
                    ease: 'easeOut',
                    delay: BUBBLE_MOTION.exitFadeDelay,
                  },
                }
              : phase === 'prepared'
                ? { duration: 0 }
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
                const fallbackThinkingText = session.status === 'processing' ? getFallbackThinkingText(session.sessionId) : undefined
                const isLast = idx === sessionsToRender.length - 1
                const remainingOthers = Math.max(0, totalActive - sessionsToRender.length)
                const showBadge = isLast && remainingOthers > 0

                return (
                  <SessionBubbleRow
                    key={session.sessionId}
                    session={session}
                    idx={idx}
                    phase={phase}
                    isMultiSession={isMultiSession}
                    incrementalEntry={incrementalEntries[session.sessionId]}
                    prefersReducedMotion={Boolean(prefersReducedMotion)}
                    entryOffset={entryOffset}
                    onClick={handleClick}
                    onAnimationComplete={handleRowAnimationComplete}
                    t={t}
                    fallbackThinkingText={fallbackThinkingText}
                    thinkingText={fallbackThinkingText}
                    showBadge={showBadge}
                    remainingOthers={remainingOthers}
                  />
                )
              })}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  )
}
