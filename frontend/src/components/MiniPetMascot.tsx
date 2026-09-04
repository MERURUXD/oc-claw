import { useCallback, useEffect, useRef, useState } from 'react'
import { SpritePet } from './SpritePet'
import { ANIMATION_ROWS, fpsFor } from '../lib/codexPet'
import type { CodexPet, CodexPetState } from '../lib/codexPet'

export interface MascotReaction {
  state: 'waving' | 'failed'
  id: number
}

interface MiniPetMascotProps {
  pet: CodexPet
  // Resting state computed by the parent: idle / running (working+compacting) /
  // waiting / review / run-right / run-left. `jumping` is owned by this wrapper via
  // hover and should not be passed in.
  baseState: CodexPetState
  size: number
  // Transient reaction: waving (success one-shot) or failed (error one-shot).
  reaction?: MascotReaction | null
  // Fired when the one-shot reaction reaches its last frame so the parent can clear it.
  onReactionEnd?: (reactionId: number) => void
  // When true, the wrapper plays a one-shot jump while hovered, then waits
  // before triggering the next jump.
  enableHoverJump?: boolean
  // External hover signal driven by a native cursor poll (used on macOS).
  // When `useExternalHover` is true this is the single source of truth and
  // webview-level mouseenter/leave is ignored, because macOS does not
  // deliver mouseenter to non-key floating windows reliably and would also
  // keep firing during a drag (sprite would stay frozen on `jumping`).
  externalHover?: boolean
  useExternalHover?: boolean
  // While true, hover is forced off so the wrapper never enters the
  // `jumping` cycle. Used during a drag (Windows uses the webview-level
  // `onMouseEnter`/`onMouseLeave`, which stay stuck on `enter` because the
  // pointer never crosses the mascot border while the user is dragging
  // it). Without this, walkDir → run-left/run-right is hidden by the
  // continuous jump animation.
  suppressHover?: boolean
  className?: string
  style?: React.CSSProperties
}

// How long the sprite holds the jump's final frame before replaying the
// next one-shot. While hovered, the cycle is: play jump → freeze on last
// frame for JUMP_REST_MS → replay jump → ...
const JUMP_REST_MS = 400

export function MiniPetMascot({
  pet,
  baseState,
  size,
  reaction = null,
  onReactionEnd,
  enableHoverJump = false,
  externalHover = false,
  useExternalHover = false,
  suppressHover = false,
  className,
  style,
}: MiniPetMascotProps) {
  const [internalHover, setInternalHover] = useState(false)
  const [showJump, setShowJump] = useState(false)
  // Bumping this remounts SpritePet (via `key`) and replays the jump
  // animation from frame 0 without leaving the `jumping` state — that way
  // the rest period stays on the last jump frame instead of falling back
  // to baseState (idle/run/etc.) between cycles.
  const [jumpKey, setJumpKey] = useState(0)
  const hoveringRef = useRef(false)
  const restTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onReactionEndRef = useRef(onReactionEnd)
  onReactionEndRef.current = onReactionEnd

  const isMovement = baseState === 'run-left' || baseState === 'run-right'
  const isReactionActive = !!reaction && (reaction.state === 'failed' || reaction.state === 'waving')
  const isReview = baseState === 'review'

  // Hover jumping is only allowed when:
  // 1. enableHoverJump is active and not suppressed by drag
  // 2. Not in active movement (run-left / run-right)
  // 3. Not currently playing a transient reaction (failed / waving)
  // 4. Not in persistent review state
  const allowHoverJump =
    enableHoverJump &&
    !suppressHover &&
    !isMovement &&
    !isReactionActive &&
    !isReview

  const onEnter = useCallback(() => {
    if (allowHoverJump && !useExternalHover) setInternalHover(true)
  }, [allowHoverJump, useExternalHover])

  const onLeave = useCallback(() => {
    if (!useExternalHover) setInternalHover(false)
  }, [useExternalHover])

  const hovering =
    allowHoverJump && (useExternalHover ? externalHover : internalHover)
  hoveringRef.current = hovering

  useEffect(() => {
    if (!hovering) {
      if (restTimerRef.current) {
        clearTimeout(restTimerRef.current)
        restTimerRef.current = null
      }
      setShowJump(false)
      return
    }
    setShowJump(true)
    return () => {
      if (restTimerRef.current) {
        clearTimeout(restTimerRef.current)
        restTimerRef.current = null
      }
    }
  }, [hovering])

  const handleJumpEnd = useCallback(() => {
    // SpritePet's one-shot logic naturally holds the last frame here, so
    // we do NOT flip back to baseState. After the rest delay we just
    // bump jumpKey to remount SpritePet and let it play from frame 0.
    if (restTimerRef.current) clearTimeout(restTimerRef.current)
    restTimerRef.current = setTimeout(() => {
      restTimerRef.current = null
      if (hoveringRef.current) setJumpKey((k) => k + 1)
    }, JUMP_REST_MS)
  }, [])

  // Safety net for jumping: if SpritePet's onOneShotEnd somehow doesn't fire (e.g.
  // tab throttling), schedule the rest cycle by the animation's nominal
  // duration plus a small buffer.
  useEffect(() => {
    if (!showJump) return
    const row = ANIMATION_ROWS['jumping']
    const fps = fpsFor('jumping')
    const expected = (row.frames / Math.max(fps, 1)) * 1000
    const fallback = setTimeout(() => {
      handleJumpEnd()
    }, expected + 200)
    return () => clearTimeout(fallback)
  }, [showJump, jumpKey, handleJumpEnd])

  // Reaction handling: when reaction is active, handle its completion
  const handleReactionEnd = useCallback(() => {
    if (reaction) {
      onReactionEndRef.current?.(reaction.id)
    }
  }, [reaction])

  // Safety net for reaction one-shot: if SpritePet's onOneShotEnd somehow doesn't fire,
  // ensure we clear the reaction after nominal duration + buffer.
  useEffect(() => {
    if (!isReactionActive || !reaction) return
    const row = ANIMATION_ROWS[reaction.state]
    const fps = fpsFor(reaction.state)
    const expected = (row.frames / Math.max(fps, 1)) * 1000
    const fallback = setTimeout(() => {
      handleReactionEnd()
    }, expected + 250)
    return () => clearTimeout(fallback)
  }, [isReactionActive, reaction, handleReactionEnd])

  // Unified priority:
  // movement > failed > waving > review > jumping > baseState
  const renderState: CodexPetState = isMovement
    ? baseState
    : reaction?.state === 'failed'
      ? 'failed'
      : reaction?.state === 'waving'
        ? 'waving'
        : isReview
          ? 'review'
          : showJump
            ? 'jumping'
            : baseState

  const spriteKey = isMovement
    ? `move-${renderState}`
    : isReactionActive && reaction
      ? `reaction-${reaction.state}-${reaction.id}`
      : showJump
        ? `jump-${jumpKey}`
        : `base-${renderState}`

  const onOneShotEnd = showJump
    ? handleJumpEnd
    : isReactionActive
      ? handleReactionEnd
      : undefined

  return (
    <div
      className={className}
      onMouseEnter={allowHoverJump && !useExternalHover ? onEnter : undefined}
      onMouseLeave={!useExternalHover ? onLeave : undefined}
      style={{ display: 'inline-block', lineHeight: 0, ...style }}
    >
      <SpritePet
        key={spriteKey}
        pet={pet}
        state={renderState}
        size={size}
        onOneShotEnd={onOneShotEnd}
      />
    </div>
  )
}
