import type { CSSProperties } from 'react'
import {
  DOT_INDEXES,
  MATRIX_DIMENSIONS,
  getDotParameters,
  toDotMatrixState,
  type BubbleDotMatrixSize,
  type BubbleDotMatrixState,
} from '../lib/bubbleDotMatrix'

export { toDotMatrixState }
export type { BubbleDotMatrixSize, BubbleDotMatrixState }

export interface BubbleDotMatrixProps {
  state: BubbleDotMatrixState
  size?: BubbleDotMatrixSize
  isMeasure?: boolean
  className?: string
  style?: CSSProperties
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
 * - Full prefers-reduced-motion support:
 *   - Stops continuous blinking
 *   - thinking: shows resting diagonal stripe
 *   - loading: shows resting scattered constellation
 *   - waiting: shows resting ellipsis
 *   - warning: shows resting exclamation mark
 */
export function BubbleDotMatrix({
  state = 'thinking',
  size = 'detailed',
  isMeasure = false,
  className = '',
  style: propStyle,
  'aria-label': ariaLabel,
}: BubbleDotMatrixProps) {
  const dimensions = MATRIX_DIMENSIONS[size] ?? MATRIX_DIMENSIONS.detailed

  return (
    <span
      className={`bubble-dot-matrix bubble-dot-matrix--${size} ${isMeasure ? 'bubble-dot-matrix--measure' : ''} ${className}`.trim()}
      data-state={state}
      role="img"
      aria-hidden={isMeasure || !ariaLabel}
      aria-label={ariaLabel}
      style={{
        width: dimensions.width,
        height: dimensions.height,
        ...propStyle,
      }}
    >
      <svg
        viewBox="0 0 20 20"
        fill="currentColor"
        className="bubble-dot-matrix-svg"
        aria-hidden="true"
      >
        {DOT_INDEXES.map((i) => {
          const dot = getDotParameters(state, i)

          const dotStyle: CSSProperties = {
            opacity: dot.resting,
            ['--dot-matrix-hi' as string]: dot.hi,
            ['--dot-matrix-lo' as string]: dot.lo,
            ['--dot-matrix-resting' as string]: dot.resting,
          }

          if (!isMeasure && dot.duration !== undefined) {
            dotStyle.animationDuration = `${dot.duration}s`
            dotStyle.animationDelay = `${dot.delay ?? 0}s`
          }

          return (
            <circle
              key={i}
              className="bubble-dot-matrix-dot"
              cx={2 + dot.col * 4}
              cy={2 + dot.row * 4}
              r={1.3}
              style={dotStyle}
            />
          )
        })}
      </svg>
    </span>
  )
}
