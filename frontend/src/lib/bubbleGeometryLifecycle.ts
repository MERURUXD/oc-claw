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
    shouldShrinkToStable: true,
  }
}

/** ResizeObserver / coalesced sync must obey the gate. */
export function resolveObservedGeometryMode(opts: {
  stableGeometryAllowed: boolean
  hasActiveMotion: boolean
  phase: BubblePhaseLite
}): BubbleGeometryModeLite {
  if (opts.phase === 'prepared' || opts.phase === 'hidden') return 'motion'
  if (!opts.stableGeometryAllowed) return 'motion'
  if (opts.hasActiveMotion) return 'motion'
  if (opts.phase !== 'visible') return 'motion'
  return 'stable'
}
