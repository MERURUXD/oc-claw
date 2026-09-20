import type { BubbleStatusKind } from './bubbleStatus.ts'

export type BubbleDotMatrixState = 'thinking' | 'loading' | 'waiting' | 'warning'
export type BubbleDotMatrixSize = 'detailed' | 'compact'

export const GRID_SIZE = 5
export const TOTAL_DOTS = GRID_SIZE * GRID_SIZE
export const DOT_INDEXES = Array.from({ length: TOTAL_DOTS }, (_, i) => i)

export const MATRIX_DIMENSIONS: Record<BubbleDotMatrixSize, { width: number; height: number }> = {
  detailed: { width: 14, height: 14 },
  compact: { width: 10, height: 10 },
}

/**
 * Deterministic bit-mixing hash without Math.random() or timers.
 * Takes index, salt, and range (in ms), and returns a deterministic offset in seconds.
 */
export const hashDotMatrix = (n: number, salt: number, range: number): number => {
  let h = (Math.imul(n, 374761393) + Math.imul(salt, 668265263)) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
  return (((h ^ (h >>> 16)) >>> 0) % range) / 1000
}

export const createGlyphSet = (dots: [number, number][]): Set<number> =>
  new Set(dots.map(([row, col]) => row * GRID_SIZE + col))

// Sequential ellipsis on row 2: [2, 0], [2, 2], [2, 4] -> indices 10, 12, 14
export const ELLIPSIS_GLYPH = createGlyphSet([
  [2, 0],
  [2, 2],
  [2, 4],
])

// Exclamation / Warning glyph: stem at [0, 2], [1, 2], [2, 2] and dot at [4, 2] -> indices 2, 7, 12, 22
export const WARNING_GLYPH = createGlyphSet([
  [0, 2],
  [1, 2],
  [2, 2],
  [4, 2],
])

// Thinking resting glyph: diagonal line [0, 0], [1, 1], [2, 2], [3, 3], [4, 4] -> indices 0, 6, 12, 18, 24
export const THINKING_RESTING_GLYPH = createGlyphSet([
  [0, 0],
  [1, 1],
  [2, 2],
  [3, 3],
  [4, 4],
])

// Loading resting glyph: deterministic scattered constellation -> indices 1, 4, 7, 10, 13, 16, 20, 24
export const LOADING_RESTING_GLYPH = createGlyphSet([
  [0, 1],
  [0, 4],
  [1, 2],
  [2, 0],
  [2, 3],
  [3, 1],
  [4, 0],
  [4, 4],
])

export interface BlinkConfig {
  duration: number
  delay: number
  lo: number
}

export interface StatePatternConfig {
  glyph?: Set<number>
  restingGlyph?: Set<number>
  base: number
  dim?: number
  restingDim?: number
  blink?: (i: number, row: number, col: number) => BlinkConfig
}

export const MATRIX_STATE_CONFIGS: Record<BubbleDotMatrixState, StatePatternConfig> = {
  // Diagonal wave pattern (working)
  thinking: {
    base: 1,
    restingGlyph: THINKING_RESTING_GLYPH,
    restingDim: 0.2,
    blink: (_i, row, col) => ({
      duration: 1.2,
      delay: -(row + col) * 0.09,
      lo: 0.2,
    }),
  },
  // Deterministic randomized twinkle (running)
  loading: {
    base: 1,
    restingGlyph: LOADING_RESTING_GLYPH,
    restingDim: 0.2,
    blink: (i) => ({
      duration: 0.9 + hashDotMatrix(i, 2, 700),
      delay: -hashDotMatrix(i, 1, 1200),
      lo: 0.15,
    }),
  },
  // Sequential ellipsis wave on row 2 (answer)
  waiting: {
    glyph: ELLIPSIS_GLYPH,
    base: 1,
    dim: 0.15,
    blink: (_i, _row, col) => ({
      duration: 1.2,
      delay: -(col / 2) * 0.18,
      lo: 0.2,
    }),
  },
  // Slow exclamation pulse (approval)
  warning: {
    glyph: WARNING_GLYPH,
    base: 1,
    dim: 0.15,
    blink: () => ({
      duration: 1.6,
      delay: 0,
      lo: 0.45,
    }),
  },
}

/**
 * Maps BubbleStatusKind to BubbleDotMatrixState:
 * - working -> thinking (diagonal wave)
 * - running -> loading (deterministic twinkle)
 * - answer  -> waiting (sequential ellipsis)
 * - approval -> warning (slow exclamation pulse)
 */
export function toDotMatrixState(kind: BubbleStatusKind): BubbleDotMatrixState {
  switch (kind) {
    case 'running':
      return 'loading'
    case 'answer':
      return 'waiting'
    case 'approval':
      return 'warning'
    case 'working':
    default:
      return 'thinking'
  }
}

export interface DotCalculatedProperties {
  row: number
  col: number
  isOn: boolean
  hi: number
  lo: number
  resting: number
  duration?: number
  delay?: number
}

/**
 * Computes deterministic properties for a given dot in a given state.
 */
export function getDotParameters(state: BubbleDotMatrixState, dotIndex: number): DotCalculatedProperties {
  const config = MATRIX_STATE_CONFIGS[state] ?? MATRIX_STATE_CONFIGS.thinking
  const row = Math.floor(dotIndex / GRID_SIZE)
  const col = dotIndex % GRID_SIZE
  const isOn = !config.glyph || config.glyph.has(dotIndex)
  const hi = isOn ? config.base : (config.dim ?? 0.15)
  const blink = isOn ? config.blink?.(dotIndex, row, col) : undefined

  // Determine resting opacity for reduced-motion / static display
  const isRestingOn = config.restingGlyph ? config.restingGlyph.has(dotIndex) : isOn
  const restingDim = config.restingDim ?? config.dim ?? 0.15
  const resting = isRestingOn ? config.base : restingDim

  return {
    row,
    col,
    isOn,
    hi,
    lo: blink?.lo ?? hi,
    resting,
    duration: blink?.duration,
    delay: blink?.delay,
  }
}
