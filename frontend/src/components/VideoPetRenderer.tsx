import type React from 'react'
import { BufferedVideo, type ChromaKeyOptions, type VideoTransparencyMode } from './BufferedVideo'
import {
  computeVideoPetGeometry,
  isMirrorForbidden,
  resolveSemanticVideoAnimation,
  type VideoPet,
  type VideoPetAnimationMeta,
} from '../lib/videoPet'

export interface VideoPetRendererProps {
  pet: VideoPet
  // Semantic state (e.g. 'idle', 'running', 'review', 'jumping', 'run-left', 'run-right')
  state?: string
  // Visual width in CSS pixels. Height is derived proportionally from the character's body box.
  size: number
  // Manual horizontal flip override (e.g. facing right)
  flipHorizontal?: boolean
  // Fired when a one-shot animation finishes playing
  onOneShotEnd?: (completedRequestId?: string | null) => void
  // Semantic one-shot identity, separate from BufferedVideo's media-load generation.
  oneShotRequestId?: string | null
  animationOverride?: VideoPetAnimationMeta | null
  onPlaybackProgress?: (requestId: string | null, currentTime: number, duration: number) => void
  // Loop override. When true, treats even one-shot clips as looping (e.g. during continuous hover).
  loop?: boolean
  freeze?: boolean
  playbackRate?: number
  replayToken?: number | string
  transparency?: VideoTransparencyMode
  chromaKeyOptions?: ChromaKeyOptions
  // 'body': container sized to bodyBox, canvas offset with overflow visible (for cards/lists)
  // 'canvas': container sized to full canvas, canvas positioned at (0, 0) (for native mascot windows)
  layoutMode?: 'body' | 'canvas'
  className?: string
  style?: React.CSSProperties
}

/**
 * Pet-aware renderer for VideoPet assets.
 *
 * Scales and positions the video according to the character's nominal bodyBox
 * and feet baseline (feetY), ensuring the character aligns identically to
 * sprite pets while allowing particle/firework effect bounds to extend
 * beyond the container without expanding the clickable hitbox.
 */
export function VideoPetRenderer({
  pet,
  state = 'idle',
  size,
  onOneShotEnd,
  oneShotRequestId,
  animationOverride,
  onPlaybackProgress,
  loop,
  freeze,
  flipHorizontal,
  transparency,
  chromaKeyOptions,
  playbackRate = 1,
  replayToken,
  layoutMode = 'body',
  className,
  style,
}: VideoPetRendererProps) {
  // Compute body-box scaled geometry
  const geo = computeVideoPetGeometry(pet.canvas, size)

  // Resolve best matching animation
  const resolvedAnimation = resolveSemanticVideoAnimation(pet, state, animationOverride)
  const animKey = resolvedAnimation?.key ?? 'idle'
  const animMeta: VideoPetAnimationMeta | null = resolvedAnimation?.meta ?? null

  // Determine whether animation should loop or fire onEnded
  const isLooping = loop ?? (animMeta?.loop ?? true)

  // Horizontal mirroring logic:
  // DSH assets face left by default. When running right or flipHorizontal is requested,
  // we flip unless the animation contains un-mirrorable text (e.g. "写代码").
  const isRightFacing = flipHorizontal ?? (state === 'run-right')
  const mirrorBlocked = isMirrorForbidden(pet, animKey, animMeta)
  const shouldFlip = isRightFacing && !mirrorBlocked
  const transform = shouldFlip ? 'scaleX(-1)' : undefined

  // Determine effective playback rate (animMeta override > fps ratio > base prop)
  const effectivePlaybackRate =
    animMeta?.playbackRate ??
    (animMeta?.fps && pet.fps ? (animMeta.fps / pet.fps) * playbackRate : playbackRate)

  const isCanvasMode = layoutMode === 'canvas'

  return (
    <div
      className={className}
      style={{
        position: 'relative',
        width: isCanvasMode ? geo.canvasWidth : geo.bodyWidth,
        height: isCanvasMode ? geo.canvasHeight : geo.bodyHeight,
        display: 'inline-block',
        lineHeight: 0,
        overflow: 'visible',
        ...style,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: isCanvasMode ? 0 : geo.canvasLeft,
          top: isCanvasMode ? 0 : geo.canvasTop,
          width: geo.canvasWidth,
          height: geo.canvasHeight,
          pointerEvents: 'none',
        }}
      >
        <BufferedVideo
          src={animMeta?.src}
          loop={isLooping}
          freeze={freeze}
          playbackRate={effectivePlaybackRate}
          replayToken={replayToken}
          oneShotRequestId={oneShotRequestId}
          onPlaybackProgress={onPlaybackProgress}
          onEnded={isLooping ? undefined : onOneShotEnd}
          transparency={transparency ?? pet.transparency ?? 'native'}
          chromaKeyOptions={chromaKeyOptions ?? pet.chromaKeyOptions}
          canvasWidth={geo.canvasWidth}
          canvasHeight={geo.canvasHeight}
          transform={transform}
        />
      </div>
    </div>
  )
}
