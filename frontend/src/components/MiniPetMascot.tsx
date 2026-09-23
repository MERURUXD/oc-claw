import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PetRenderer } from './PetRenderer'
import { ANIMATION_ROWS, fpsFor } from '../lib/codexPet'
import type { CodexPetState } from '../lib/codexPet'
import { isCodexPet, type PetAsset } from '../lib/petAsset'
import {
  getVideoReactionIdToConsume,
  isCurrentOneShotRequest,
  isMascotHoverJumpAllowed,
  isMascotReactionActive,
  isVideoReactionRequestActive,
  resolveVideoPetPresentationState,
} from '../lib/videoPet'

export type MascotLifecycleState = 'idle' | 'working' | 'compacting' | 'waiting' | 'review'

export interface MascotReaction {
  state: 'waving' | 'failed'
  id: number
}

interface MiniPetMascotProps {
  pet: PetAsset
  // Resting state computed by the parent: idle / running (working+compacting) /
  // waiting / review / run-right / run-left. `jumping` is owned by this wrapper via
  // hover and should not be passed in.
  baseState: CodexPetState
  // Uncollapsed Agent/session lifecycle, kept separate from the Codex sprite state.
  lifecycleState?: MascotLifecycleState
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
  // Actual window drag state, distinct from early hover suppression.
  isDragging?: boolean
  // Reaction identity already interrupted by this drag; it stays suppressed
  // until a different reaction request arrives.
  interruptedReactionId?: number | null
  layoutMode?: 'body' | 'canvas'
  className?: string
  style?: React.CSSProperties
}

// How long the sprite holds the jump's final frame before replaying the
// next one-shot. While hovered, the cycle is: play jump → freeze on last
// frame for JUMP_REST_MS → replay jump → ...
const JUMP_REST_MS = 400

type VideoOneShotRequest =
  | { id: string; kind: 'reaction'; reactionId: number }
  | { id: string; kind: 'jump' }

export function MiniPetMascot({
  pet,
  baseState,
  lifecycleState,
  size,
  reaction = null,
  onReactionEnd,
  enableHoverJump = false,
  externalHover = false,
  useExternalHover = false,
  suppressHover = false,
  isDragging = false,
  interruptedReactionId = null,
  layoutMode,
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
  const isDraggingRef = useRef(isDragging)
  const restTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onReactionEndRef = useRef(onReactionEnd)
  useLayoutEffect(() => {
    onReactionEndRef.current = onReactionEnd
  }, [onReactionEnd])

  const isVideo = !isCodexPet(pet)
  const isMovement = baseState === 'run-left' || baseState === 'run-right'
  const isReactionActive = isMascotReactionActive(reaction)
  const isReview = baseState === 'review'
  useLayoutEffect(() => {
    isDraggingRef.current = isDragging
  }, [isDragging])

  const videoReactionActive = isVideo && isReactionActive && !!reaction &&
    isVideoReactionRequestActive(reaction.id, interruptedReactionId, isDragging)

  // Hover jumping is only allowed when:
  // 1. enableHoverJump is active and not suppressed by drag
  // 2. Not in active movement (run-left / run-right)
  // 3. Not currently playing a transient reaction (failed / waving)
  // 4. Not in persistent review state
  const allowHoverJump = isMascotHoverJumpAllowed(
    enableHoverJump,
    suppressHover,
    isMovement,
    isReactionActive,
    isReview,
  )

  const onEnter = useCallback(() => {
    if (allowHoverJump && !useExternalHover) setInternalHover(true)
  }, [allowHoverJump, useExternalHover])

  const onLeave = useCallback(() => {
    if (!useExternalHover) setInternalHover(false)
  }, [useExternalHover])

  const hovering =
    allowHoverJump && (useExternalHover ? externalHover : internalHover)
  useLayoutEffect(() => {
    hoveringRef.current = hovering
  }, [hovering])

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

  const videoOneShotRequest: VideoOneShotRequest | null = useMemo(
    () => videoReactionActive && reaction
      ? { id: `reaction:${reaction.id}`, kind: 'reaction', reactionId: reaction.id }
      : isVideo && !isDragging && showJump
        ? { id: `jump:${jumpKey}`, kind: 'jump' }
        : null,
    [videoReactionActive, reaction, showJump, jumpKey, isVideo, isDragging],
  )
  const currentVideoRequestRef = useRef<VideoOneShotRequest | null>(null)
  const videoOneShotRequestId = videoOneShotRequest?.id ?? null
  useLayoutEffect(() => {
    currentVideoRequestRef.current = videoOneShotRequest
  }, [videoOneShotRequest, videoOneShotRequestId, reaction?.id])

  const handleVideoOneShotEnd = useCallback((completedRequestId?: string | null) => {
    const currentRequest = currentVideoRequestRef.current
    if (
      !currentRequest ||
      !isCurrentOneShotRequest(completedRequestId, currentRequest.id, isDraggingRef.current)
    ) return

    if (currentRequest.kind === 'reaction') {
      onReactionEndRef.current?.(currentRequest.reactionId)
    } else {
      handleJumpEnd()
    }
  }, [handleJumpEnd])

  // Safety net for jumping: if PetRenderer's onOneShotEnd somehow doesn't fire (e.g.
  // tab throttling), schedule the rest cycle by the animation's nominal
  // duration plus a small buffer.
  useEffect(() => {
    if (!showJump) return
    if (isVideo && videoOneShotRequest?.kind !== 'jump') return
    const expected = isCodexPet(pet)
      ? (ANIMATION_ROWS['jumping'].frames / Math.max(fpsFor('jumping'), 1)) * 1000
      : 3000
    const fallback = setTimeout(() => {
      if (isVideo) handleVideoOneShotEnd(videoOneShotRequestId)
      else handleJumpEnd()
    }, expected + 200)
    return () => clearTimeout(fallback)
  }, [showJump, jumpKey, handleJumpEnd, handleVideoOneShotEnd, isVideo, pet, videoOneShotRequest?.kind, videoOneShotRequestId])

  // Reaction handling: when reaction is active, handle its completion
  const handleReactionEnd = useCallback(() => {
    if (reaction) {
      onReactionEndRef.current?.(reaction.id)
    }
  }, [reaction])

  // Safety net for reaction one-shot: if PetRenderer's onOneShotEnd somehow doesn't fire,
  // ensure we clear the reaction after nominal duration + buffer.
  useEffect(() => {
    if (!isReactionActive || !reaction) return
    if (isVideo && videoOneShotRequest?.kind !== 'reaction') {
      const interruptedId = getVideoReactionIdToConsume(
        isVideo,
        reaction.id,
        isDragging,
        interruptedReactionId,
      )
      if (interruptedId !== null) onReactionEndRef.current?.(interruptedId)
      return
    }
    const expected = isCodexPet(pet)
      ? (ANIMATION_ROWS[reaction.state].frames / Math.max(fpsFor(reaction.state), 1)) * 1000
      : 4000
    const fallback = setTimeout(() => {
      if (isVideo) handleVideoOneShotEnd(videoOneShotRequestId)
      else handleReactionEnd()
    }, expected + 250)
    return () => clearTimeout(fallback)
  }, [isReactionActive, reaction, handleReactionEnd, handleVideoOneShotEnd, isVideo, isDragging, interruptedReactionId, pet, videoOneShotRequest?.kind, videoOneShotRequestId])

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

  // For Codex, SpritePet uses spriteKey to reset its internal frame state or remount for jump loops.
  // For VideoPet, component identity must remain stable so BufferedVideo stays mounted and seamlessly swaps
  // front and back buffers without unmounting or flashing transparent/empty frames.
  const rendererKey = isVideo ? `videopet-${pet.id}` : spriteKey

  // For VideoPet, one-shot replay requests (such as repeating a hover jump or reaction) are communicated
  // via replayToken so BufferedVideo reloads the clip in the back buffer without unmounting.
  const replayToken = isVideo
    ? videoOneShotRequestId ?? 0
    : showJump
      ? jumpKey
      : isReactionActive && reaction
        ? reaction.id
        : 0

  const onOneShotEnd = isVideo
    ? videoOneShotRequest
      ? handleVideoOneShotEnd
      : undefined
    : showJump
      ? handleJumpEnd
      : isReactionActive
        ? handleReactionEnd
        : undefined

  const videoLifecycleState = lifecycleState === 'review'
    ? 'agent-review'
    : lifecycleState ?? baseState
  const videoState = resolveVideoPetPresentationState({
    isDragging,
    movementState: isMovement ? baseState : null,
    reactionState: videoReactionActive && reaction
      ? reaction.state === 'waving' ? 'success' : 'failed'
      : null,
    isJumping: showJump,
    lifecycleState: videoLifecycleState,
  })

  return (
    <div
      className={className}
      onMouseEnter={allowHoverJump && !useExternalHover ? onEnter : undefined}
      onMouseLeave={!useExternalHover ? onLeave : undefined}
      style={{ display: 'inline-block', lineHeight: 0, ...style }}
    >
      <PetRenderer
        key={rendererKey}
        pet={pet}
        state={isVideo ? videoState : renderState}
        size={size}
        replayToken={replayToken}
        onOneShotEnd={onOneShotEnd}
        oneShotRequestId={videoOneShotRequestId}
        layoutMode={layoutMode}
      />
    </div>
  )
}
