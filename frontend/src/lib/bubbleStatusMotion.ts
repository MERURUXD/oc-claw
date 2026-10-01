import { MATRIX_DIMENSIONS, type BubbleDotMatrixState } from './bubbleDotMatrix.ts'
import type { OrbSize, OrbState } from 'thinking-orbs/engine'
import type { BubbleStatusMotion } from './types.ts'

/**
 * Which animation the mascot bubble shows while a session is active:
 *
 * - `matrix` — the project default: a 5×5 dot matrix (see `bubbleDotMatrix.ts`)
 *   driven by deterministic CSS opacity animations.
 * - `orbs`   — the thinking-orbs dotted thought orbs
 *   (https://github.com/Jakubantalik/thinking-orbs), painted on a plain 2D canvas:
 *   hand-tuned orbital animations, one per bubble status.
 *
 * Both render inside the exact same box, so switching styles never changes bubble
 * geometry (and therefore never moves the native window). This module owns the
 * shared contract: the persisted key, the status → animation mapping, the small-size
 * tuning, and the ink resolution that keeps the orb in the bubble's status colour.
 */

/** Settings-store key holding the chosen animation style. */
export const BUBBLE_STATUS_MOTION_STORE_KEY = 'bubble_status_motion'

/** Tauri event used to push a live style change into the `mascot-bubble` window. */
export const BUBBLE_STATUS_MOTION_EVENT = 'mascot-bubble-status-motion'

/**
 * Existing installs have no stored value, and the dot matrix is the shipped
 * behaviour — anything unknown keeps it instead of silently restyling the bubble.
 */
export const BUBBLE_STATUS_MOTION_DEFAULT: BubbleStatusMotion = 'matrix'

export const BUBBLE_STATUS_MOTION_VALUES: readonly BubbleStatusMotion[] = ['matrix', 'orbs']

export function isBubbleStatusMotion(value: unknown): value is BubbleStatusMotion {
  return (BUBBLE_STATUS_MOTION_VALUES as readonly string[]).includes(String(value))
}

export function normalizeBubbleStatusMotion(value: unknown): BubbleStatusMotion | null {
  return isBubbleStatusMotion(value) ? value : null
}

/**
 * Optional local override for QA in the browser preview, where the settings store
 * and the `mascot-bubble-*` event handshake are unavailable:
 * `index.html#/mascot-bubble?motion=orbs`.
 */
export function readBubbleStatusMotionFromHash(hash: string | undefined): BubbleStatusMotion | null {
  if (!hash) return null
  const queryStart = hash.indexOf('?')
  if (queryStart === -1) return null
  const params = new URLSearchParams(hash.slice(queryStart + 1))
  return normalizeBubbleStatusMotion(params.get('motion'))
}

/**
 * thinking-orbs state per dot-matrix state. The matrix states are the single
 * source of truth: the detailed rows reach them through `toDotMatrixState()`
 * and the compact capsule passes them directly, so both styles stay in step.
 *
 * - thinking (working)  → `breathing` — a ring slowly morphing; the library's own "Thinking…"
 * - loading  (running)  → `working`   — particles running tilted orbits
 * - waiting  (answer)   → `listening` — a waveform rolling through the rings
 * - warning  (approval) → `solving`   — bands scramble until the click that resolves them
 */
export const ORB_STATE_BY_MATRIX_STATE: Record<BubbleDotMatrixState, OrbState> = {
  thinking: 'breathing',
  loading: 'working',
  waiting: 'listening',
  warning: 'solving',
}

export function toOrbState(state: BubbleDotMatrixState): OrbState {
  return ORB_STATE_BY_MATRIX_STATE[state] ?? ORB_STATE_BY_MATRIX_STATE.thinking
}

/** Bubble indicator sizes — same two names the dot matrix uses. */
export type BubbleOrbSize = keyof typeof MATRIX_DIMENSIONS

export interface BubbleOrbGeometry {
  /**
   * thinking-orbs ships hand-tuned designs at 64 / 32 / 20 CSS px; 20 is the
   * inline-text scale, so the orb is laid out at 20 and displayed in the
   * matrix box (a slight supersample instead of a blurry upscale).
   */
  presetSize: OrbSize
  /** CSS box of the rendered orb — always the dot matrix box it replaces. */
  displaySize: number
  /** Density multiplier: at bubble scale fewer, calmer marks read better. */
  dots: number
  /** Radius multiplier: offsets the shrink from 20px to the matrix box. */
  dotSize: number
  /** Speed multiplier on top of the preset's baked speed. */
  speed: number
}

export const ORB_GEOMETRY: Record<BubbleOrbSize, BubbleOrbGeometry> = {
  detailed: {
    presetSize: 20,
    displaySize: MATRIX_DIMENSIONS.detailed.width,
    dots: 0.85,
    dotSize: 1.3,
    speed: 1,
  },
  compact: {
    presetSize: 20,
    displaySize: MATRIX_DIMENSIONS.compact.width,
    dots: 0.5,
    dotSize: 1.5,
    speed: 0.9,
  },
}

export interface BubbleOrbInk {
  /** Hex ink for the orb's `color` tint (the library ignores alpha). */
  color: string
  /** Alpha of the resolved `currentColor`, re-applied to the canvas. */
  opacity: number
}

const FALLBACK_INK: BubbleOrbInk = { color: '#ffffff', opacity: 1 }

function clampChannel(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.max(0, Math.min(255, Math.round(n)))
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => clampChannel(v).toString(16).padStart(2, '0')).join('')}`
}

/**
 * The orb inherits the bubble's status colour instead of hard-coding one: the
 * wrapper's computed `color` (`#818cf8` for answers, `#fbbf24` for approvals,
 * translucent white otherwise) is split into a hex tint for the library and an
 * opacity for the canvas, so the depth ramp reads exactly as dimmed text does.
 */
export function resolveBubbleOrbInk(cssColor: string | null | undefined): BubbleOrbInk {
  const value = (cssColor ?? '').trim()
  if (!value) return FALLBACK_INK

  const rgb = value.match(/^rgba?\(([^)]+)\)$/i)
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean)
    const [r, g, b] = parts.map((p) => (p.endsWith('%') ? parseFloat(p) * 2.55 : parseFloat(p)))
    const alphaPart = parts[3]
    const alpha =
      alphaPart === undefined
        ? 1
        : Math.max(
            0,
            Math.min(1, alphaPart.endsWith('%') ? parseFloat(alphaPart) / 100 : parseFloat(alphaPart))
          )
    if ([r, g, b].some((n) => !Number.isFinite(n))) return FALLBACK_INK
    return { color: toHex(r, g, b), opacity: alpha }
  }

  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) {
    const hex = value.slice(1)
    const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex
    return { color: `#${full.toLowerCase()}`, opacity: 1 }
  }

  return FALLBACK_INK
}
