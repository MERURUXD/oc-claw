export interface MascotPanelTransitionState {
  dragging: boolean
  expanding: boolean
  collapsing: boolean
}

export function canExpandMascotPanel(state: MascotPanelTransitionState): boolean {
  return !state.dragging && !state.expanding && !state.collapsing
}

export function canStartMascotPointerInteraction(expanding: boolean): boolean {
  return !expanding
}

export type MascotPointerOutcome = 'left-click' | 'right-click' | 'drag' | 'ignore'

export function classifyMascotPointerOutcome(input: {
  button: number
  ctrlKey?: boolean
  wasDragging: boolean
}): MascotPointerOutcome {
  if (input.wasDragging) return 'drag'
  if (input.button === 2 || (input.button === 0 && input.ctrlKey)) return 'right-click'
  if (input.button === 0) return 'left-click'
  return 'ignore'
}
