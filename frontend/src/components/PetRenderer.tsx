import type React from 'react'
import type { PetAsset } from '../lib/petAsset'
import { isVideoPet } from '../lib/petAsset'
import { SpritePet } from './SpritePet'
import { VideoPetRenderer } from './VideoPetRenderer'
import type { CodexPetState } from '../lib/codexPet'
import type { VideoTransparencyMode, ChromaKeyOptions } from './BufferedVideo'

export interface PetRendererProps {
  pet: PetAsset
  state?: CodexPetState | string
  size: number
  onOneShotEnd?: () => void
  loop?: boolean
  flipHorizontal?: boolean
  replayToken?: number | string
  transparency?: VideoTransparencyMode
  chromaKeyOptions?: ChromaKeyOptions
  layoutMode?: 'body' | 'canvas'
  className?: string
  style?: React.CSSProperties
}

/**
 * Universal pet renderer that automatically dispatches to SpritePet for Codex
 * sprite atlases or VideoPetRenderer for WebM video pets.
 */
export function PetRenderer({
  pet,
  state = 'idle',
  size,
  onOneShotEnd,
  loop,
  flipHorizontal,
  replayToken,
  transparency,
  chromaKeyOptions,
  layoutMode,
  className,
  style,
}: PetRendererProps) {
  if (isVideoPet(pet)) {
    return (
      <VideoPetRenderer
        pet={pet}
        state={state}
        size={size}
        onOneShotEnd={onOneShotEnd}
        loop={loop}
        flipHorizontal={flipHorizontal}
        replayToken={replayToken}
        transparency={transparency}
        chromaKeyOptions={chromaKeyOptions}
        layoutMode={layoutMode}
        className={className}
        style={style}
      />
    )
  }

  return (
    <SpritePet
      pet={pet}
      state={(state as CodexPetState) || 'idle'}
      size={size}
      onOneShotEnd={onOneShotEnd}
      loop={loop}
      className={className}
      style={style}
    />
  )
}
