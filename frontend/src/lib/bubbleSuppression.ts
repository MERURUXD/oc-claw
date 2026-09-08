export type BubblePhase = 'hidden' | 'prepared' | 'entering' | 'visible' | 'exiting'

export interface BubbleLifecycleState {
  desiredVisible: boolean
  phase: BubblePhase
  nativeVisible: boolean
  transitionId: number
  presentationSuppressed: boolean
}

export type PresentationReconcileAction = 'restore' | 'stay_hidden'

export interface PresentationSuppressionReconcileResult {
  action: 'suppressed' | PresentationReconcileAction
  shouldShowNative: boolean
  shouldEmitEnter: boolean
  newPhase?: BubblePhase
  logMessage: string
}

/**
 * Reconciles the aggregate native presentation state (fullscreen or tray Hide).
 *
 * Presentation suppression is an independent native presentation state:
 * - suppressed = true:
 *   Native window is hidden by OS/Rust watcher.
 *   Logical lifecycle (desiredVisible, phase, transitionId, payload) is preserved.
 *   nativeVisible is updated to false.
 * - suppressed = false:
 *   If the bubble logically still desires to be visible and is in an active phase
 *   ('visible', 'entering', or 'prepared'):
 *     -> action = 'restore', native presentation is re-asserted.
 *     -> if phase was 'prepared', request entry after ready and native show succeed.
 *     -> if phase was 'visible' or 'entering', restore directly without replaying animations.
 *   If the session ended, panel expanded, or desiredVisible became false while suppressed:
 *     -> action = 'stay_hidden', native window remains hidden.
 */
export function handlePresentationSuppressionChange(
  state: BubbleLifecycleState,
  suppressed: boolean
): PresentationSuppressionReconcileResult {
  if (suppressed) {
    state.presentationSuppressed = true
    state.nativeVisible = false
    const logMessage = `[bubble-native] presentation suppressed=true phase=${state.phase} desired=${state.desiredVisible} native=false`
    return {
      action: 'suppressed',
      shouldShowNative: false,
      shouldEmitEnter: false,
      logMessage,
    }
  }

  state.presentationSuppressed = false
  const shouldRestore =
    state.desiredVisible &&
    (state.phase === 'visible' || state.phase === 'entering' || state.phase === 'prepared')

  const action: PresentationReconcileAction = shouldRestore ? 'restore' : 'stay_hidden'
  const logMessage = `[bubble-native] presentation suppressed=false phase=${state.phase} desired=${state.desiredVisible} action=${action}`

  if (shouldRestore) {
    if (state.phase === 'prepared') {
      return {
        action: 'restore',
        shouldShowNative: true,
        shouldEmitEnter: true,
        newPhase: 'entering',
        logMessage,
      }
    }
    return {
      action: 'restore',
      shouldShowNative: true,
      shouldEmitEnter: false,
      logMessage,
    }
  }

  return {
    action: 'stay_hidden',
    shouldShowNative: false,
    shouldEmitEnter: false,
    logMessage,
  }
}

/**
 * Handles `mascot-bubble-ready` handshake event.
 * If currently presentation-suppressed, prevents setting nativeVisible or showing window.
 */
export function handleBubbleReadyWhileSuppressed(
  state: BubbleLifecycleState,
  readyTransitionId: number
): { canShowNative: boolean; reason: 'suppressed' | 'mismatch' | 'ok' } {
  if (readyTransitionId !== state.transitionId || !state.desiredVisible) {
    return { canShowNative: false, reason: 'mismatch' }
  }
  if (state.presentationSuppressed) {
    state.nativeVisible = false
    return { canShowNative: false, reason: 'suppressed' }
  }
  return { canShowNative: true, reason: 'ok' }
}

/** Re-read live state after IPC, then claim entry at most once for this transition. */
export function commitBubbleNativeShow(
  state: BubbleLifecycleState,
  transitionId: number,
  result: string,
): { applied: boolean; shouldEmitEnter: boolean } {
  if (transitionId !== state.transitionId) return { applied: false, shouldEmitEnter: false }
  const shown = handleNativeShowResult(state, result)
  const shouldEmitEnter = shown && state.phase === 'prepared'
  if (shouldEmitEnter) state.phase = 'entering'
  return { applied: true, shouldEmitEnter }
}

/**
 * Reconciles the native command execution result of `set_mascot_bubble_visible`.
 */
export function handleNativeShowResult(
  state: BubbleLifecycleState,
  result: 'shown' | 'suppressed' | 'hidden' | 'error' | string
): boolean {
  if (result === 'shown' && !state.presentationSuppressed && state.desiredVisible &&
      (state.phase === 'prepared' || state.phase === 'entering' || state.phase === 'visible')) {
    state.nativeVisible = true
    return true
  }
  state.nativeVisible = false
  return false
}

/**
 * Updates logical phase to 'visible' once entry animation has settled.
 */
export function handleBubbleVisible(
  state: BubbleLifecycleState,
  transitionId: number
): boolean {
  if (
    transitionId === state.transitionId &&
    state.desiredVisible &&
    state.phase === 'entering'
  ) {
    state.phase = 'visible'
    return true
  }
  return false
}
