import type { CodexPet } from './codexPet'
import {
  computeVideoPetGeometry,
  type ChromaKeyOptions,
  type VideoPet,
  type VideoPetAnimationEntry,
  type VideoPetAnimationMeta,
  type VideoPetCanvasGeometry,
  type VideoTransparencyMode,
} from './videoPet.ts'

export type PetRendererType = 'sprite-atlas' | 'video-clips'

// PetAsset union represents any pet supported by oc-claw:
// either a traditional Codex/Hatch 8x9 sprite atlas or a video-based pet.
export type PetAsset = CodexPet | VideoPet

export interface PetVisualBounds {
  width: number
  height: number
}

export interface PetHitboxBounds {
  left: number
  top: number
  width: number
  height: number
}

export interface PetRenderMetrics {
  body: PetVisualBounds
  canvas: PetVisualBounds
  hitbox: PetHitboxBounds
  scale: number
  // Backward compatibility: width and height equal body.width and body.height
  width: number
  height: number
  aspectRatio: number
}

/**
 * Returns height-to-width aspect ratio for a given pet asset.
 * Video pets use their declared nominal bodyBox / feetY baseline ratio.
 * Codex sprite pets default to 208 / 192 (~1.0833).
 */
export function getPetAspectRatio(pet: PetAsset | null | undefined): number {
  if (isVideoPet(pet)) {
    const w = Math.max(1, pet.canvas.bodyBox[2] - pet.canvas.bodyBox[0])
    const feetY = pet.canvas.feetY ?? pet.canvas.bodyBox[3]
    const h = Math.max(1, feetY - pet.canvas.bodyBox[1])
    return h / w
  }
  return 208 / 192
}

/**
 * Computes container render metrics (body, canvas, hitbox bounds, and scale)
 * for a pet given a nominal visual width.
 */
export function getPetRenderMetrics(
  pet: PetAsset | null | undefined,
  visualWidth: number,
): PetRenderMetrics {
  if (isVideoPet(pet)) {
    const geo = computeVideoPetGeometry(pet.canvas, visualWidth)
    return {
      body: { width: geo.bodyWidth, height: geo.bodyHeight },
      canvas: { width: geo.canvasWidth, height: geo.canvasHeight },
      hitbox: {
        left: geo.hitboxLeft,
        top: geo.hitboxTop,
        width: geo.bodyWidth,
        height: geo.bodyHeight,
      },
      scale: geo.scale,
      width: geo.bodyWidth,
      height: geo.bodyHeight,
      aspectRatio: geo.bodyHeight / Math.max(1, geo.bodyWidth),
    }
  }

  const aspectRatio = getPetAspectRatio(pet)
  const width = Math.round(visualWidth)
  const height = Math.round(visualWidth * aspectRatio)
  return {
    body: { width, height },
    canvas: { width, height },
    hitbox: { left: 0, top: 0, width, height },
    scale: 1,
    width,
    height,
    aspectRatio,
  }
}

/**
 * Type guard for VideoPet.
 */
export function isVideoPet(pet: PetAsset | null | undefined): pet is VideoPet {
  return pet != null && pet.renderer === 'video-clips'
}

/**
 * Type guard for CodexPet.
 * Treats undefined or missing renderer as 'sprite-atlas' for backward compatibility.
 */
export function isCodexPet(pet: PetAsset | null | undefined): pet is CodexPet {
  return pet != null && (pet.renderer === undefined || pet.renderer === 'sprite-atlas')
}

function parseAnimationMetaItem(
  item: Record<string, unknown>,
  baseUrl: string,
): VideoPetAnimationMeta {
  const src = typeof item.src === 'string' ? resolveRelativeUrl(item.src, baseUrl) : ''
  return {
    src,
    loop: typeof item.loop === 'boolean' ? item.loop : true,
    noMirror: typeof item.noMirror === 'boolean' ? item.noMirror : undefined,
    stridePx: typeof item.stridePx === 'number' ? item.stridePx : undefined,
    fps: typeof item.fps === 'number' ? item.fps : undefined,
    playbackRate: typeof item.playbackRate === 'number' ? item.playbackRate : undefined,
  }
}

/**
 * Safely parse a raw pet.json manifest object into a strongly typed PetAsset.
 * If renderer is omitted, defaults to legacy 'sprite-atlas' CodexPet behavior.
 */
export function parsePetManifest(raw: unknown, baseUrl: string): PetAsset | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>

  const id = typeof m.id === 'string' && m.id.trim()
    ? m.id.trim()
    : baseUrl.split('/').filter(Boolean).pop() || 'unknown-pet'

  const displayName = typeof m.displayName === 'string' && m.displayName.trim()
    ? m.displayName.trim()
    : id

  const description = typeof m.description === 'string' ? m.description : ''

  if (m.renderer === 'video-clips') {
    const rawCanvas = (m.canvas && typeof m.canvas === 'object') ? (m.canvas as Record<string, unknown>) : {}
    const width = typeof rawCanvas.width === 'number' && rawCanvas.width > 0 ? rawCanvas.width : 640
    const height = typeof rawCanvas.height === 'number' && rawCanvas.height > 0 ? rawCanvas.height : 360

    let bodyBox: [number, number, number, number]
    if (
      Array.isArray(rawCanvas.bodyBox) &&
      rawCanvas.bodyBox.length === 4 &&
      rawCanvas.bodyBox.every((v) => typeof v === 'number')
    ) {
      bodyBox = rawCanvas.bodyBox as [number, number, number, number]
    } else {
      bodyBox = [0, 0, width, height]
    }

    const feetY = typeof rawCanvas.feetY === 'number' ? rawCanvas.feetY : height

    const canvas: VideoPetCanvasGeometry = {
      width,
      height,
      bodyBox,
      feetY,
    }

    const rawAnims = (m.animations && typeof m.animations === 'object')
      ? (m.animations as Record<string, unknown>)
      : {}

    const animations: Record<string, VideoPetAnimationEntry> = {}
    for (const [key, val] of Object.entries(rawAnims)) {
      if (typeof val === 'string') {
        animations[key] = resolveRelativeUrl(val, baseUrl)
      } else if (Array.isArray(val)) {
        animations[key] = val
          .map((entry) => {
            if (typeof entry === 'string') {
              return resolveRelativeUrl(entry, baseUrl)
            }
            if (entry && typeof entry === 'object') {
              return parseAnimationMetaItem(entry as Record<string, unknown>, baseUrl)
            }
            return null
          })
          .filter((v): v is string | VideoPetAnimationMeta => v !== null)
      } else if (val && typeof val === 'object') {
        animations[key] = parseAnimationMetaItem(val as Record<string, unknown>, baseUrl)
      }
    }

    const noMirror = Array.isArray(m.noMirror)
      ? m.noMirror.filter((x): x is string => typeof x === 'string')
      : undefined

    const fps = typeof m.fps === 'number' && m.fps > 0 ? m.fps : 24

    const transparency = (
      m.transparency === 'native' ||
      m.transparency === 'windows-chroma-key' ||
      m.transparency === 'auto'
    )
      ? (m.transparency as VideoTransparencyMode)
      : undefined

    let chromaKeyOptions: ChromaKeyOptions | undefined
    if (m.chromaKeyOptions && typeof m.chromaKeyOptions === 'object') {
      const cko = m.chromaKeyOptions as Record<string, unknown>
      chromaKeyOptions = {
        lowThreshold: typeof cko.lowThreshold === 'number' ? cko.lowThreshold : undefined,
        highThreshold: typeof cko.highThreshold === 'number' ? cko.highThreshold : undefined,
      }
    }

    return {
      renderer: 'video-clips',
      id,
      displayName,
      description,
      canvas,
      fps,
      transparency,
      chromaKeyOptions,
      animations,
      noMirror,
      baseDir: baseUrl,
    }
  }

  // Legacy Codex sprite atlas path:
  const spritesheetPath = typeof m.spritesheetPath === 'string' && m.spritesheetPath.trim()
    ? m.spritesheetPath.trim()
    : 'spritesheet.webp'

  return {
    renderer: 'sprite-atlas',
    id,
    displayName,
    description,
    spritesheetUrl: resolveRelativeUrl(spritesheetPath, baseUrl),
  }
}

function resolveRelativeUrl(path: string, baseUrl: string): string {
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('/') || path.startsWith('asset://')) {
    return path
  }
  const cleanBase = baseUrl.replace(/\/+$/, '')
  const cleanPath = path.replace(/^\/+/, '')
  return `${cleanBase}/${cleanPath}`
}
