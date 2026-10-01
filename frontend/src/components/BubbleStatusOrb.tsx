import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import type { OrbState } from 'thinking-orbs/engine'
import {
  ORB_GEOMETRY,
  resolveBubbleOrbInk,
  type BubbleOrbInk,
  type BubbleOrbSize,
} from '../lib/bubbleStatusMotion'

export type { BubbleOrbSize }

export interface BubbleStatusOrbProps {
  /** Which thinking-orbs animation to run (see `toOrbState`). */
  state: OrbState
  size?: BubbleOrbSize
  /** Layout-only mode: an empty box, no canvas and no animation. */
  isMeasure?: boolean
  className?: string
  style?: CSSProperties
  'aria-label'?: string
}

/**
 * thinking-orbs status indicator for the mascot bubble.
 *
 * Mirrors `BubbleDotMatrix`'s surface (same box, same `isMeasure` semantics,
 * `currentColor` ink, full reduced-motion support) so the two styles are
 * interchangeable through the `bubble_status_motion` setting:
 *
 * - The orb is laid out at the library's 20px inline preset and displayed in
 *   the 14px / 10px matrix box, so marks stay supersampled and the bubble
 *   geometry — which drives the native window size — never changes.
 * - The bubble's own status colour is read back from CSS and handed to the
 *   library as a tint; its alpha is re-applied to the canvas, keeping the
 *   depth ramp as quiet as the surrounding text.
 * - The library pauses offscreen and on hidden tabs, and paints a single
 *   static frame under `prefers-reduced-motion: reduce`.
 */
export function BubbleStatusOrb({
  state,
  size = 'detailed',
  isMeasure = false,
  className = '',
  style: propStyle,
  'aria-label': ariaLabel,
}: BubbleStatusOrbProps) {
  const hostRef = useRef<HTMLSpanElement | null>(null)
  const [ink, setInk] = useState<BubbleOrbInk | null>(null)
  const geometry = ORB_GEOMETRY[size] ?? ORB_GEOMETRY.detailed

  // The status tint is defined by CSS (`currentColor` on the badge), so read it
  // back rather than duplicating the palette here. A layout effect means the
  // canvas never paints a frame with the fallback ink.
  useLayoutEffect(() => {
    if (isMeasure) return
    const el = hostRef.current
    if (!el || typeof getComputedStyle !== 'function') return
    const next = resolveBubbleOrbInk(getComputedStyle(el).color)
    setInk((prev) =>
      prev && prev.color === next.color && prev.opacity === next.opacity ? prev : next
    )
  }, [state, size, isMeasure])

  return (
    <span
      ref={hostRef}
      className={`bubble-status-orb bubble-status-orb--${size} ${className}`.trim()}
      data-state={state}
      role="img"
      aria-hidden={isMeasure || !ariaLabel}
      aria-label={ariaLabel}
      style={{
        width: geometry.displaySize,
        height: geometry.displaySize,
        ...propStyle,
      }}
    >
      {!isMeasure && (
        <ThinkingOrb
          state={state}
          size={geometry.presetSize}
          theme="dark"
          color={ink?.color}
          dots={geometry.dots}
          dotSize={geometry.dotSize}
          speed={geometry.speed}
          className="bubble-status-orb-canvas"
          role="presentation"
          aria-hidden="true"
          style={{
            width: geometry.displaySize,
            height: geometry.displaySize,
            opacity: ink?.opacity ?? 1,
          }}
        />
      )}
    </span>
  )
}
