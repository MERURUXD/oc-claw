import type { CSSProperties } from 'react'
import {
  DOT_INDEXES,
  GRID_SIZE,
  MATRIX_STATE_CONFIGS,
  type BubbleDotMatrixSize,
  type BubbleDotMatrixState,
} from '../lib/bubbleDotMatrix'

export type { BubbleDotMatrixSize, BubbleDotMatrixState }

export interface BubbleDotMatrixProps {
  state: BubbleDotMatrixState
  size?: BubbleDotMatrixSize
  isMeasure?: boolean
  className?: string
  'aria-label'?: string
}

/**
 * 5×5 Dot Matrix status indicator for Mascot Bubble.
 *
 * Adopts assistant-ui's Dot Matrix mechanism:
 * - Fixed 5×5 SVG (25 permanent circle elements)
 * - Single persistent DOM structure; status transitions cross-fade via CSS property transitions
 * - Fill: `currentColor`
 * - Deterministic CSS animations (no JS timers or Math.random)
 * - Full prefers-reduced-motion support (stops animation while preserving static resting pattern)
 */
export function BubbleDotMatrix({
  state = 'thinking',
  size = 'detailed',
  isMeasure = false,
  className = '',
  'aria-label': ariaLabel,
}: BubbleDotMatrixProps) {
  const config = MATRIX_STATE_CONFIGS[state] ?? MATRIX_STATE_CONFIGS.thinking

  return (
    <span
      className={`bubble-dot-matrix bubble-dot-matrix--${size} ${isMeasure ? 'bubble-dot-matrix--measure' : ''} ${className}`.trim()}
      data-state={state}
      role="img"
      aria-hidden={isMeasure || !ariaLabel}
      aria-label={ariaLabel}
    >
      <svg
        viewBox="0 0 20 20"
        fill="currentColor"
        className="bubble-dot-matrix-svg"
        aria-hidden="true"
      >
        {DOT_INDEXES.map((i) => {
          const row = Math.floor(i / GRID_SIZE)
          const col = i % GRID_SIZE
          const on = !config.glyph || config.glyph.has(i)
          const hi = on ? config.base : (config.dim ?? 0.15)
          const blink = on ? config.blink?.(i, row, col) : undefined

          const dotStyle: CSSProperties = {
            opacity: hi,
            ['--dot-matrix-hi' as string]: hi,
            ['--dot-matrix-lo' as string]: blink?.lo ?? hi,
          }

          if (!isMeasure && blink) {
            dotStyle.animationDuration = `${blink.duration}s`
            dotStyle.animationDelay = `${blink.delay}s`
          }

          return (
            <circle
              key={i}
              className="bubble-dot-matrix-dot"
              cx={2 + col * 4}
              cy={2 + row * 4}
              r={1.3}
              style={dotStyle}
            />
          )
        })}
      </svg>
    </span>
  )
}
