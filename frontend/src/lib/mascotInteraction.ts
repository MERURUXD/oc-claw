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
