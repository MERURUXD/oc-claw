/**
 * Panel UI transition ownership across collapse / enterSettings / exitSettings.
 *
 * A shared generation token lets a newer transition invalidate stale
 * timeout/await tails from an earlier collapse so they cannot clear
 * settings/expanded or rewrite native geometry after ownership has moved.
 *
 * Windows acceptance (manual): startup → mascot → gear → settings appears;
 * after interact/exit, Tray Hide/Show and fullscreen suppression still work.
 */

export type PanelUiOwner = 'idle' | 'collapse' | 'enterSettings' | 'exitSettings'

export interface PanelUiTransitionState {
  /** Monotonic ownership token; bump on every winning transition. */
  generation: number
  owner: PanelUiOwner
}

export function createPanelUiTransition(generation = 0): PanelUiTransitionState {
  return { generation, owner: 'idle' }
}

/** Take ownership for a new transition; bumps generation so stale work aborts. */
export function beginPanelUiTransition(
  state: PanelUiTransitionState,
  owner: Exclude<PanelUiOwner, 'idle'>,
): PanelUiTransitionState {
  return {
    generation: state.generation + 1,
    owner,
  }
}

export function capturePanelUiGeneration(state: PanelUiTransitionState): number {
  return state.generation
}

/** True iff the captured ticket still owns the panel UI. */
export function isPanelUiGenerationCurrent(
  state: PanelUiTransitionState,
  capturedGeneration: number,
): boolean {
  return state.generation === capturedGeneration
}

/**
 * Snapshot of flags shared by blur / window mousedown / mini-outside-click /
 * hover-close dismiss admission. Keep callers on one helper so guard sets
 * do not drift.
 */
export interface PanelDismissSnapshot {
  pinned: boolean
  settingsMode: boolean
  settingsTransitioning: boolean
  collapsing: boolean
  updateModalOpen: boolean
  createModalOpen: boolean
  filePickerOpen: boolean
  settingsPickerBlocking: boolean
}

export type PanelDismissAction = 'collapse' | 'exitSettings' | 'ignore'

export interface ResolvePanelDismissOptions {
  /**
   * Blur while settings is open should run exitSettings (restore geometry),
   * not ignore. Outside-click / hover-close treat settingsMode as ignore
   * (collapse is wrong; exit is owned by blur / explicit X).
   */
  allowExitSettings?: boolean
}

/**
 * Decide whether a dismiss event may collapse, may exit settings, or must
 * be ignored. Order matches existing Mini intent.
 */
export function resolvePanelDismissAction(
  snap: PanelDismissSnapshot,
  opts: ResolvePanelDismissOptions = {},
): PanelDismissAction {
  if (snap.filePickerOpen) return 'ignore'
  if (snap.settingsPickerBlocking) return 'ignore'
  if (snap.settingsTransitioning) return 'ignore'
  if (snap.collapsing) return 'ignore'
  if (snap.updateModalOpen) return 'ignore'
  if (snap.createModalOpen) return 'ignore'
  if (snap.settingsMode) {
    return opts.allowExitSettings ? 'exitSettings' : 'ignore'
  }
  if (snap.pinned) return 'ignore'
  return 'collapse'
}

export function shouldAdmitPanelCollapse(snap: PanelDismissSnapshot): boolean {
  return resolvePanelDismissAction(snap) === 'collapse'
}
