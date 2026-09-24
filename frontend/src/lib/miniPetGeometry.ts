export interface CollapsedMascotGeometryState {
  modeReady: boolean
  expanded: boolean
  settingsMode: boolean
  settingsTransitioning: boolean
  updateModalOpen: boolean
  onboardingOpen: boolean
  hiding: boolean
}

export interface LatestWinsSerialQueue<T> {
  enqueue(value: T): Promise<void>
  invalidate(): void
  drain(): Promise<void>
}

export function canApplyCollapsedMascotGeometry(state: CollapsedMascotGeometryState): boolean {
  return state.modeReady
    && !state.expanded
    && !state.settingsMode
    && !state.settingsTransitioning
    && !state.updateModalOpen
    && !state.onboardingOpen
    && !state.hiding
}

/** Serialize native layout writes and discard requests that have not started
 * when a newer geometry arrives. An active native write finishes before the
 * latest request starts, so an older completion cannot land after a newer one.
 */
export function createLatestWinsSerialQueue<T>(apply: (value: T) => Promise<void>): LatestWinsSerialQueue<T> {
  let generation = 0
  let tail: Promise<void> = Promise.resolve()

  return {
    enqueue(value: T): Promise<void> {
      const requestGeneration = ++generation
      const request = tail.catch(() => {}).then(async () => {
        if (requestGeneration !== generation) return
        await apply(value)
      })
      tail = request.catch(() => {})
      return request
    },
    invalidate(): void {
      generation += 1
    },
    drain(): Promise<void> {
      return tail
    },
  }
}
