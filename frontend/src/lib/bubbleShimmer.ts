import type { BubbleStatusKind } from './bubbleStatus'

/**
 * Codex-style Cadenced Shimmer timing configuration:
 * - initialDelayMs: initial delay before first sweep begins
 * - activeMs: duration of the sweep animation across the text
 * - intervalMs: cycle interval between successive sweeps
 *
 * Tuned parameters for a calmer, narrower title shimmer:
 * - 600ms initial delay
 * - 1800ms sweep duration
 * - 4200ms cadence interval (1.8s active sweep + 2.4s quiet resting pause)
 */
export const SHIMMER_TIMING = {
  initialDelayMs: 600,
  activeMs: 1800,
  intervalMs: 4200,
} as const

/**
 * Determines whether the title shimmer animation should be active.
 * Active when session is running/processing and not waiting for user approval or interaction.
 */
export function isShimmerActive(
  sessionStatus?: string,
  statusKind?: BubbleStatusKind
): boolean {
  const isWaiting = statusKind === 'answer' || statusKind === 'approval'
  return (sessionStatus === 'processing' || sessionStatus === 'tool_running') && !isWaiting
}
