import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface MascotGeometryRect {
  left: number
  top: number
  width: number
  height: number
}

/** Windows geometry in physical screen pixels. Divide distances by scaleFactor
 * for CSS pixels. `body` is the conservative motion envelope during a probe;
 * negative left/right distances are intentional partial off-screen exposure.
 * This is an observation interface: consumers must not change agent lifecycles.
 */
export interface MascotGeometrySnapshot {
  windowLabel: string
  displayId: string
  scaleFactor: number
  monitor: MascotGeometryRect
  workArea: MascotGeometryRect
  body: MascotGeometryRect
  distanceLeft: number
  distanceRight: number
  distanceBottom: number
  autoHideReserved: boolean
}

/** Null on other platforms and while the primary window displays a panel. */
export function getMascotGeometry(windowLabel = 'mini'): Promise<MascotGeometrySnapshot | null> {
  return invoke('get_mascot_geometry', { windowLabel })
}

/** Emitted only when the snapshot changes, scoped to the originating window.
 * No animation policy is installed by default; existing edge probes own poses.
 */
export function listenMascotGeometry(
  onChange: (geometry: MascotGeometrySnapshot) => void,
): Promise<UnlistenFn> {
  return listen<MascotGeometrySnapshot>('mascot-geometry-changed', event => onChange(event.payload))
}
