// Video-based pet asset model (e.g. DSH-style transparent WebM animations).
// Unlike Codex sprite atlases, video pets use individual transparent video files
// with declared canvas dimensions, stable body box geometry, and baseline alignment.

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
}

export interface VideoPet {
  renderer: 'video-clips'
  id: string
  displayName: string
  description?: string
  canvas: VideoPetCanvasGeometry
  fps?: number
  // Animation mapping by state or action key (e.g. idle, work, drag, etc.)
  animations: Record<string, VideoPetAnimationMeta | string>
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

// Standard DSH text clips where mirroring would reverse visible Chinese characters
export const DSH_NO_MIRROR_CLIPS: readonly string[] = [
  '是啊，吃什么',
  '写代码',
  '写福字',
  '收红包',
  '吃Token',
  '深度思考碎碎念',
] as const

/**
 * Normalizes an animation entry to VideoPetAnimationMeta.
 */
export function normalizeVideoAnimation(
  entry: VideoPetAnimationMeta | string | undefined,
): VideoPetAnimationMeta | null {
  if (!entry) return null
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
): { key: string; meta: VideoPetAnimationMeta } | null {
  const direct = pet.animations[key]
  if (direct) {
    const meta = normalizeVideoAnimation(direct)
    if (meta) return { key, meta }
  }

  // Common fallbacks
  if (key !== 'idle' && pet.animations['idle']) {
    const meta = normalizeVideoAnimation(pet.animations['idle'])
    if (meta) return { key: 'idle', meta }
  }

  const firstKey = Object.keys(pet.animations)[0]
  if (firstKey && pet.animations[firstKey]) {
    const meta = normalizeVideoAnimation(pet.animations[firstKey])
    if (meta) return { key: firstKey, meta }
  }

  return null
}

/**
 * Calculates container and canvas dimensions and positioning offsets so that
 * the character's body box cleanly fills the container while preserving extra
 * space for animation effects (particles, fireworks, gestures) outside the box.
 */
export interface VideoPetRenderGeometry {
  containerWidth: number
  containerHeight: number
  canvasWidth: number
  canvasHeight: number
  canvasLeft: number
  canvasTop: number
  scale: number
}

export function computeVideoPetGeometry(
  canvas: VideoPetCanvasGeometry,
  visualSize: number,
): VideoPetRenderGeometry {
  const bodyW = Math.max(1, canvas.bodyBox[2] - canvas.bodyBox[0])
  const bodyH = Math.max(1, canvas.bodyBox[3] - canvas.bodyBox[1])
  const scale = visualSize / bodyW

  const containerWidth = Math.round(visualSize)
  const containerHeight = Math.round(visualSize * (bodyH / bodyW))

  const canvasWidth = Math.round(canvas.width * scale)
  const canvasHeight = Math.round(canvas.height * scale)

  const canvasLeft = Math.round(-canvas.bodyBox[0] * scale) || 0
  const canvasTop = Math.round(-canvas.bodyBox[1] * scale) || 0

  return {
    containerWidth,
    containerHeight,
    canvasWidth,
    canvasHeight,
    canvasLeft,
    canvasTop,
    scale,
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
 */
export function isMirrorForbidden(
  pet: VideoPet,
  animationKey: string,
  animationMeta?: VideoPetAnimationMeta | null,
): boolean {
  if (animationMeta?.noMirror === true) return true
  if (pet.noMirror && pet.noMirror.includes(animationKey)) return true
  // Also check if the src filename contains any noMirror name
  if (animationMeta?.src) {
    const filename = animationMeta.src.split('/').pop()?.replace(/\.[^/.]+$/, '')
    if (filename && pet.noMirror && pet.noMirror.includes(filename)) return true
    if (filename && DSH_NO_MIRROR_CLIPS.includes(filename)) return true
  }
  return false
}

