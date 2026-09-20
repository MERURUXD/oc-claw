import type { BubbleStatusKind } from './bubbleStatus'

/**
 * Codex-style Cadenced Shimmer timing configuration:
 * - initialDelayMs: initial delay before first sweep begins
 * - activeMs: duration of the sweep animation across the text
 * - intervalMs: cycle interval between successive sweeps
 *
 * Tuned parameters for tighter cadence and wider presence:
 * - 300ms initial delay
 * - 1200ms sweep duration
 * - 2700ms cadence interval (1.2s active sweep + 1.5s quiet resting pause)
 */
export const SHIMMER_TIMING = {
  initialDelayMs: 300,
  activeMs: 1200,
  intervalMs: 2700,
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
