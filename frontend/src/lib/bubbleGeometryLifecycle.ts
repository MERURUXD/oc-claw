/**
 * Unified mascot-bubble native geometry lifecycle.
 * Gate: stable shrink is only allowed after motion settles + deferred double-rAF,
 * and ResizeObserver must obey the same gate.
 */

export type BubblePhaseLite = 'hidden' | 'prepared' | 'entering' | 'visible' | 'exiting'
export type BubbleGeometryModeLite = 'stable' | 'motion'

export interface GeometryLifecycleSnapshot {
  stableGeometryAllowed: boolean
  /** Bumped on every motion begin; invalidates in-flight deferred stable callbacks. */
  generation: number
  transitionId: number
  pendingGeneration: number | null
  pendingTransitionId: number | null
}

export interface DeferredStableTicket {
  generation: number
  transitionId: number
}

export function createGeometryLifecycle(transitionId = 0): GeometryLifecycleSnapshot {
  return {
    stableGeometryAllowed: false,
    generation: 0,
    transitionId,
    pendingGeneration: null,
    pendingTransitionId: null,
  }
}

/** Entry / exit / row motion starts: close gate and invalidate dirty deferred rAFs. */
export function beginGeometryMotion(
  state: GeometryLifecycleSnapshot,
  nextTransitionId?: number,
): GeometryLifecycleSnapshot {
  return {
    ...state,
    stableGeometryAllowed: false,
    generation: state.generation + 1,
    transitionId: typeof nextTransitionId === 'number' ? nextTransitionId : state.transitionId,
    pendingGeneration: null,
    pendingTransitionId: null,
  }
}

export function cancelDeferredStable(state: GeometryLifecycleSnapshot): GeometryLifecycleSnapshot {
  return {
    ...state,
    pendingGeneration: null,
    pendingTransitionId: null,
  }
}

/**
 * Motion tokens cleared and phase is (or will be) visible — schedule the sole
 * authority path that may shrink to stable after double-rAF.
 */
export function scheduleDeferredStable(
  state: GeometryLifecycleSnapshot,
): { state: GeometryLifecycleSnapshot; ticket: DeferredStableTicket } {
  const ticket: DeferredStableTicket = {
    generation: state.generation,
    transitionId: state.transitionId,
  }
  return {
    state: {
      ...state,
      pendingGeneration: ticket.generation,
      pendingTransitionId: ticket.transitionId,
    },
    ticket,
  }
}

/** Apply deferred stable only if ticket still matches current generation/transitionId. */
export function applyDeferredStable(
  state: GeometryLifecycleSnapshot,
  ticket: DeferredStableTicket,
  opts: { phase: BubblePhaseLite; hasActiveMotion: boolean },
): { state: GeometryLifecycleSnapshot; shouldShrinkToStable: boolean } {
  const ticketMatchesPending =
    state.pendingGeneration === ticket.generation &&
    state.pendingTransitionId === ticket.transitionId
  const ticketMatchesLive =
    ticket.generation === state.generation && ticket.transitionId === state.transitionId

  if (!ticketMatchesPending || !ticketMatchesLive) {
    return {
      state: cancelDeferredStable(state),
      shouldShrinkToStable: false,
    }
  }

  if (opts.phase !== 'visible' || opts.hasActiveMotion) {
    return {
      state: cancelDeferredStable(state),
      shouldShrinkToStable: false,
    }
  }

  return {
    state: {
      ...state,
      stableGeometryAllowed: true,
      pendingGeneration: null,
      pendingTransitionId: null,
    },
    // Under persistent envelope architecture, native window never shrinks to stable
    shouldShrinkToStable: false,
  }
}

/**
 * Under persistent envelope architecture, observed geometry mode remains 'motion'
 * so the window always preserves its motion envelope without shrinking.
 */
export function resolveObservedGeometryMode(_opts?: {
  stableGeometryAllowed?: boolean
  hasActiveMotion?: boolean
  phase?: BubblePhaseLite
}): BubbleGeometryModeLite {
  void _opts
  return 'motion'
}

/** Whether any incremental entry row motion is currently in flight. */
export function isIncrementalMotionActive(
  activeMotionTokens: Set<string> | Iterable<string>
): boolean {
  for (const token of activeMotionTokens) {
    if (token.startsWith('incremental:')) return true
  }
  return false
}

/**
 * Gate native ResizeObserver IPC during incremental entry motion once the
 * envelope has already been expanded upfront, preventing SetWindowPos storms.
 */
export function shouldGateIncrementalResizeObserver(opts: {
  hasIncrementalMotion: boolean
  incrementalEnvelopePrepared: boolean
}): boolean {
  return opts.hasIncrementalMotion && opts.incrementalEnvelopePrepared
}

/**
 * Decouples row-level animation completion from window-level settle.
 * Stable settle is permitted ONLY when:
 * 1. Bubble phase is visible
 * 2. No active motion tokens remain
 * 3. No pending incremental entries exist
 * 4. Width spring layout has settled
 */
export function canSettleToStable(opts: {
  phase: BubblePhaseLite
  activeMotionTokensCount: number
  pendingIncrementalCount: number
  isWidthAnimating: boolean
}): boolean {
  if (opts.phase !== 'visible') return false
  if (opts.activeMotionTokensCount > 0) return false
  if (opts.pendingIncrementalCount > 0) return false
  if (opts.isWidthAnimating) return false
  return true
}

/**
 * Deterministic height estimation for stacked detailed session rows:
 * - Single row base: 60px (22px padding/border + 38px title & action)
 * - Inter-row gap: 8px (.mascot-bubble-stack gap)
 * - N rows: 60 * N + 8 * (N - 1)
 */
export function estimateDetailedBubbleHeight(sessionsCount: number): number {
  if (sessionsCount <= 0) return 60
  return 60 * sessionsCount + 8 * (sessionsCount - 1)
}

/**
 * Determines whether the native motion envelope needs upfront expansion
 * for incremental session rows before their entry animation begins.
 * Expansion is required if the native window has not yet been sized
 * or if either the expected width or expected height exceeds the currently synced dimensions.
 */
export function shouldExpandIncrementalEnvelope(
  currentSynced: { width: number; height: number } | null,
  expected: { width: number; height: number }
): boolean {
  if (!currentSynced) return true
  return expected.width > currentSynced.width || expected.height > currentSynced.height
}
