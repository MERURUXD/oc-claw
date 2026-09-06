/**
 * Geometry and physics spring motion configurations for the mascot status bubble width.
 */

export const BUBBLE_WIDTH = {
  min: 190,
  max: 345,
}

export const BUBBLE_WIDTH_MOTION = {
  instantThreshold: 6,

  spring: {
    type: 'spring' as const,
    stiffness: 320,
    damping: 27,
    mass: 0.72,
  },
}

export function clampBubbleWidth(width: number): number {
  return Math.max(BUBBLE_WIDTH.min, Math.min(BUBBLE_WIDTH.max, width))
}

export interface ResolveBubbleWidthOptions {
  isPreparedOrEntering?: boolean
  isExiting?: boolean
  prefersReducedMotion?: boolean
  isCurrentlyAnimating?: boolean
  instantThreshold?: number
}

export interface BubbleWidthResolution {
  targetWidth: number
  shouldAnimate: boolean
}

/**
 * Determines whether a width change should trigger a physics spring animation.
 *
 * Rules:
 * - Reduced motion: always instant (duration: 0).
 * - Exiting: freeze current width (no new width animation).
 * - Initial prepare / entering: immediate assignment (no width spring to avoid dual animation with 2D flight).
 * - Rapid retargeting: if a spring is currently in flight, keep animating to the new target so it retargets
 *   continuously without snapping midway.
 * - Dead zone: if |target - current| < instantThreshold, update immediately without spring.
 */
export function shouldAnimateBubbleWidth(
  targetWidth: number,
  currentWidth: number | null,
  options: ResolveBubbleWidthOptions = {}
): boolean {
  if (options.prefersReducedMotion) return false
  if (options.isExiting) return false
  if (currentWidth == null || options.isPreparedOrEntering) return false

  const threshold = options.instantThreshold ?? BUBBLE_WIDTH_MOTION.instantThreshold
  const delta = Math.abs(targetWidth - currentWidth)

  if (delta < threshold) {
    // If a spring is currently underway, keep animating to the new target
    // so it retargets smoothly without snapping to duration: 0 midway
    return Boolean(options.isCurrentlyAnimating)
  }

  return true
}

/**
 * Resolves the next width target and animation decision given the measured intrinsic width.
 */
export function resolveBubbleWidthTarget(
  measuredWidth: number,
  currentWidth: number | null,
  options: ResolveBubbleWidthOptions = {}
): BubbleWidthResolution {
  const targetWidth = clampBubbleWidth(measuredWidth)

  if (options.isExiting) {
    return {
      targetWidth: currentWidth != null ? clampBubbleWidth(currentWidth) : targetWidth,
      shouldAnimate: false,
    }
  }

  const shouldAnimate = shouldAnimateBubbleWidth(targetWidth, currentWidth, options)

  return {
    targetWidth,
    shouldAnimate,
  }
}

/**
 * Calculates the stack's intrinsic width across multiple session rows (maximum row width).
 */
export function calculateMultiSessionIntrinsicWidth(rowWidths: number[]): number {
  if (!rowWidths || rowWidths.length === 0) {
    return BUBBLE_WIDTH.min
  }
  const maxIntrinsic = Math.max(...rowWidths)
  return clampBubbleWidth(maxIntrinsic)
}
