// Video-based pet asset model (e.g. DSH-style transparent WebM animations).
// Unlike Codex sprite atlases, video pets use individual transparent video files
// with declared canvas dimensions, stable body box geometry, and baseline alignment.

export type VideoTransparencyMode = 'native' | 'windows-chroma-key' | 'auto'

export interface ChromaKeyOptions {
  // Pixels with max(r,g,b) <= lowThreshold are set to completely transparent (alpha = 0). Default: 12.
  lowThreshold?: number
  // Pixels with max(r,g,b) between lowThreshold and highThreshold get a soft alpha transition. Default: 28.
  highThreshold?: number
}

export interface VideoPetCanvasGeometry {
  width: number
  height: number
  // Stable character body bounding box in canvas coordinates [x1, y1, x2, y2].
  // Used to determine the nominal visual scale of the character independent of
  // effect bounds (particles, fireworks, etc.).
  bodyBox: [number, number, number, number]
  // Baseline y position in canvas coordinates where the character's feet rest.
  feetY: number
}

export interface VideoPetAnimationMeta {
  src: string
  loop?: boolean
  // When true, horizontal mirroring (e.g. facing opposite direction) is disallowed
  // (useful for animations with readable text like "写代码" or "吃Token").
  noMirror?: boolean
  // Optional horizontal displacement stride in pixels per loop cycle
  stridePx?: number
  fps?: number
  // Optional custom playback rate multiplier for this specific animation
  playbackRate?: number
}

export type VideoPetAnimationEntry =
  | VideoPetAnimationMeta
  | string
  | (VideoPetAnimationMeta | string)[]

export interface VideoPet {
  renderer: 'video-clips'
  id: string
  displayName: string
  description?: string
  canvas: VideoPetCanvasGeometry
  fps?: number
  transparency?: VideoTransparencyMode
  chromaKeyOptions?: ChromaKeyOptions
  // Animation mapping by state or action key (e.g. idle, work, drag, etc.).
  // Supports single clip strings, metadata objects, or pools (arrays) of candidates.
  animations: Record<string, VideoPetAnimationEntry>
  // List of animation names or keys where horizontal mirroring is forbidden
  noMirror?: string[]
  baseDir?: string
}

// Canonical DeepSeek Harness (DSH) Shenshen geometry constants
export const DSH_BODY_BOX: [number, number, number, number] = [212, 60, 428, 330]
export const DSH_FEET_Y = 330
export const DSH_FPS = 24

export const DSH_GEOMETRY: VideoPetCanvasGeometry = {
  width: 640,
  height: 360,
  bodyBox: DSH_BODY_BOX,
  feetY: DSH_FEET_Y,
} as const

/**
 * Normalizes an animation entry (single string, object, or candidate pool) to VideoPetAnimationMeta.
 */
export function normalizeVideoAnimation(
  entry: VideoPetAnimationEntry | undefined,
  index = 0,
): VideoPetAnimationMeta | null {
  if (!entry) return null
  if (Array.isArray(entry)) {
    if (entry.length === 0) return null
    const candidate = entry[Math.abs(index) % entry.length]
    return normalizeVideoAnimation(candidate)
  }
  if (typeof entry === 'string') {
    return { src: entry, loop: true }
  }
  return entry
}

/**
 * Resolves the animation for a given key/state, falling back to 'idle' or the first available animation.
 */
export function resolveVideoAnimation(
  pet: VideoPet,
  key: string,
  poolIndex = 0,
): { key: string; meta: VideoPetAnimationMeta } | null {
  const direct = pet.animations[key]
  if (direct) {
    const meta = normalizeVideoAnimation(direct, poolIndex)
    if (meta) return { key, meta }
  }

  // Common fallbacks
  if (key !== 'idle' && pet.animations['idle']) {
    const meta = normalizeVideoAnimation(pet.animations['idle'], poolIndex)
    if (meta) return { key: 'idle', meta }
  }

  const firstKey = Object.keys(pet.animations)[0]
  if (firstKey && pet.animations[firstKey]) {
    const meta = normalizeVideoAnimation(pet.animations[firstKey], poolIndex)
    if (meta) return { key: firstKey, meta }
  }

  return null
}

/**
 * Calculates container and canvas dimensions and positioning offsets so that
 * the character's body box cleanly fills the container while preserving extra
 * space for animation effects (particles, fireworks, gestures) outside the box.
 * Baseline alignment rests on feetY anchored to the bottom of the container.
 */
export interface VideoPetRenderGeometry {
  bodyWidth: number
  bodyHeight: number
  canvasWidth: number
  canvasHeight: number
  canvasLeft: number
  canvasTop: number
  hitboxLeft: number
  hitboxTop: number
  scale: number
  // Backward-compatibility aliases for body container dimensions
  containerWidth: number
  containerHeight: number
}

export function computeVideoPetGeometry(
  canvas: VideoPetCanvasGeometry,
  visualSize: number,
): VideoPetRenderGeometry {
  const bodyW = Math.max(1, canvas.bodyBox[2] - canvas.bodyBox[0])
  const feetY = canvas.feetY ?? canvas.bodyBox[3]
  const bodyH = Math.max(1, feetY - canvas.bodyBox[1])
  const scale = visualSize / bodyW

  const bodyWidth = Math.round(visualSize)
  const bodyHeight = Math.round(visualSize * (bodyH / bodyW))

  const hitboxLeft = Math.round(canvas.bodyBox[0] * scale) || 0
  const hitboxTop = Math.round(canvas.bodyBox[1] * scale) || 0
  // Round the canvas outward when independently rounded body bounds would
  // otherwise extend one pixel beyond it (for example 22 + 215 > 236).
  const canvasWidth = Math.max(Math.round(canvas.width * scale), hitboxLeft + bodyWidth)
  const canvasHeight = Math.max(Math.round(canvas.height * scale), hitboxTop + bodyHeight)

  const canvasLeft = -hitboxLeft || 0
  const canvasTop = -hitboxTop || 0

  return {
    bodyWidth,
    bodyHeight,
    canvasWidth,
    canvasHeight,
    canvasLeft,
    canvasTop,
    hitboxLeft,
    hitboxTop,
    scale,
    containerWidth: bodyWidth,
    containerHeight: bodyHeight,
  }
}

/**
 * Maps a generic state (idle, working, review, jumping, run-left, etc.)
 * to an animation key candidate list in priority order.
 */
export function mapSemanticStateToVideoCandidates(state: string): string[] {
  switch (state) {
    case 'idle':
      return ['idle', 'rest']
    case 'working':
    case 'running':
      return [state, 'work', 'working', 'running', 'idle']
    case 'review':
      return ['review', 'code', 'thinking', 'work', 'idle']
    case 'waiting':
      return ['waiting', 'question', 'idle']
    case 'jumping':
      return ['jumping', 'drag', 'jump', 'idle']
    case 'waving':
      return ['waving', 'click', 'happy', 'idle']
    case 'failed':
      return ['failed', 'angry', 'idle']
    case 'run-left':
    case 'run-right':
      return [state, 'move', 'walk', 'run', 'running', 'work', 'idle']
    default:
      return [state, 'idle']
  }
}

/**
 * Checks whether an animation should prohibit horizontal mirroring.
 * Purely generic: checks explicit metadata flag and pet.noMirror list.
 */
export function isMirrorForbidden(
  pet: VideoPet,
  animationKey: string,
  animationMeta?: VideoPetAnimationMeta | null,
): boolean {
  if (animationMeta?.noMirror === true) return true
  if (pet.noMirror && pet.noMirror.includes(animationKey)) return true
  // Also check if the decoded src filename matches any noMirror entry
  if (animationMeta?.src && pet.noMirror && pet.noMirror.length > 0) {
    const rawFilename = animationMeta.src.split('/').pop()?.replace(/\.[^/.]+$/, '')
    const filename = rawFilename ? decodeURIComponent(rawFilename) : ''
    if (filename && pet.noMirror.includes(filename)) return true
  }
  return false
}

