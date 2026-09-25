/**
 * Edge Probe interaction logic and state machine.
 *
 * Implements collapsed mascot peeking at screen edges:
 * - OFF -> ENTERING -> PEEKING -> STRAIGHTENING -> STRAIGHTENED -> RETURNING -> PEEKING
 * - Left/right mirrored tilt (+45deg on left edge, -45deg on right edge).
 * - Exact body-bounds exposure: 55% during peek, 82% when clicked/straightened.
 * - Universal probe envelope calculation to prevent DOM and native window clipping.
 */

export const EDGE_PROBE_ANGLE = 45.0
export const EDGE_PEEK_EXPOSURE = 0.55
export const EDGE_STRAIGHTEN_EXPOSURE = 0.82
export const EDGE_ENTER_MS = 300
export const EDGE_STRAIGHTEN_MS = 250
export const EDGE_RETURN_MS = 300
export const EDGE_IDLE_SECONDS = 5.0
export const EDGE_SNAP_THRESHOLD = 30

export type EdgeProbeState =
  | 'OFF'
  | 'ENTERING'
  | 'PEEKING'
  | 'STRAIGHTENING'
  | 'STRAIGHTENED'
  | 'RETURNING'

export type EdgeProbeSide = 'left' | 'right'

export interface ScreenRect {
  left: number
  top: number
  width: number
  height: number
}

export interface PetRenderMetricsLite {
  body: { width: number; height: number }
  canvas: { width: number; height: number }
  hitbox: { left: number; top: number; width: number; height: number }
}

export interface ProbeEnvelope {
  canvasWidth: number
  canvasHeight: number
  hitboxLeft: number
  hitboxTop: number
  bodyWidth: number
  bodyHeight: number
  contentOffsetX: number
  contentOffsetY: number
}

export interface EdgeProbePose {
  state: EdgeProbeState
  side: EdgeProbeSide | null
  angle: number
  exposure: number
  active: boolean
  transformOrigin: string
}

/**
 * Detects whether the character's physical body is resting against the left or right screen edge.
 * Uses the character's nominal body box rather than raw canvas dimensions.
 */
export function detectEdgeAtRest(
  windowPos: { x: number; y: number },
  bodyHitbox: { left: number; width: number },
  monitor: ScreenRect,
  threshold = EDGE_SNAP_THRESHOLD,
): EdgeProbeSide | null {
  const bodyLeft = windowPos.x + bodyHitbox.left
  const bodyRight = windowPos.x + bodyHitbox.left + bodyHitbox.width
  const monitorLeft = monitor.left
  const monitorRight = monitor.left + monitor.width

  if (bodyLeft <= monitorLeft + threshold) return 'left'
  if (bodyRight >= monitorRight - threshold) return 'right'
  return null
}

/**
 * Calculates the axis-aligned bounding box (AABB) of a rectangle rotated around a pivot.
 */
export function computeRotatedBounds(
  rect: { left: number; top: number; width: number; height: number },
  pivot: { x: number; y: number },
  angleDeg: number,
): { left: number; top: number; width: number; height: number } {
  if (Math.abs(angleDeg) < 1e-4) {
    return { ...rect }
  }
  const rad = (angleDeg * Math.PI) / 180
  const cosA = Math.cos(rad)
  const sinA = Math.sin(rad)
  const corners = [
    { x: rect.left, y: rect.top },
    { x: rect.left + rect.width, y: rect.top },
    { x: rect.left, y: rect.top + rect.height },
    { x: rect.left + rect.width, y: rect.top + rect.height },
  ]
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of corners) {
    const dx = p.x - pivot.x
    const dy = p.y - pivot.y
    const rx = pivot.x + dx * cosA - dy * sinA
    const ry = pivot.y + dx * sinA + dy * cosA
    minX = Math.min(minX, rx)
    maxX = Math.max(maxX, rx)
    minY = Math.min(minY, ry)
    maxY = Math.max(maxY, ry)
  }
  return {
    left: minX,
    top: minY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

/**
 * Universally calculates the expanded canvas envelope and placement offsets for any pet.
 * Ensures the rotated body at +/-45 degrees around its true body center never clips
 * against either DOM container bounds or native window borders.
 */
export function computeProbeEnvelope(metrics: PetRenderMetricsLite): ProbeEnvelope {
  const bodyCenterX = metrics.hitbox.left + metrics.body.width / 2
  const bodyCenterY = metrics.hitbox.top + metrics.body.height / 2

  // AABB at 45 degrees rotation
  const rotatedAABB = computeRotatedBounds(
    metrics.hitbox,
    { x: bodyCenterX, y: bodyCenterY },
    EDGE_PROBE_ANGLE,
  )

  const extraLeft = Math.max(0, -rotatedAABB.left)
  const extraTop = Math.max(0, -rotatedAABB.top)
  const extraRight = Math.max(0, rotatedAABB.left + rotatedAABB.width - metrics.canvas.width)
  const extraBottom = Math.max(0, rotatedAABB.top + rotatedAABB.height - metrics.canvas.height)

  if (extraLeft > 0 || extraTop > 0 || extraRight > 0 || extraBottom > 0) {
    const padX = Math.ceil(Math.max(extraLeft, extraRight)) + 8
    const padY = Math.ceil(Math.max(extraTop, extraBottom)) + 8
    return {
      canvasWidth: metrics.canvas.width + padX * 2,
      canvasHeight: metrics.canvas.height + padY * 2,
      hitboxLeft: metrics.hitbox.left + padX,
      hitboxTop: metrics.hitbox.top + padY,
      bodyWidth: metrics.body.width,
      bodyHeight: metrics.body.height,
      contentOffsetX: padX,
      contentOffsetY: padY,
    }
  }

  return {
    canvasWidth: metrics.canvas.width,
    canvasHeight: metrics.canvas.height,
    hitboxLeft: metrics.hitbox.left,
    hitboxTop: metrics.hitbox.top,
    bodyWidth: metrics.body.width,
    bodyHeight: metrics.body.height,
    contentOffsetX: 0,
    contentOffsetY: 0,
  }
}

/**
 * Calculates the native window X coordinate to position the character such that
 * exactly fraction `exposure` of the rotated character is visible within the monitor bounds.
 */
export function probeWindowX(
  side: EdgeProbeSide,
  exposure: number,
  envelopeRotatedBounds: { left: number; width: number },
  monitor: ScreenRect,
): number {
  const clampedExp = Math.max(0, Math.min(1, exposure))
  const offscreen = (1 - clampedExp) * envelopeRotatedBounds.width
  if (side === 'left') {
    return Math.round(monitor.left - offscreen - envelopeRotatedBounds.left)
  }
  return Math.round(
    monitor.left + monitor.width + offscreen - (envelopeRotatedBounds.left + envelopeRotatedBounds.width),
  )
}

/**
 * OutCubic easing curve for natural physical deceleration.
 */
export function easedProgress(elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return 1
  const raw = Math.max(0, Math.min(1, elapsedMs / durationMs))
  return 1 - Math.pow(1 - raw, 3)
}

/**
 * State machine managing edge probe interaction lifecycle and interpolated poses.
 */
export class EdgeProbeMachine {
  private state: EdgeProbeState = 'OFF'
  private side: EdgeProbeSide | null = null
  private metrics: PetRenderMetricsLite | null = null
  private angle = 0
  private exposure = 1.0

  private transitionStartMs = 0
  private transitionDurationMs = 0
  private transitionFromAngle = 0
  private transitionToAngle = 0
  private transitionFromExposure = 1.0
  private transitionToExposure = 1.0

  private idleRemainingMs = 0
  private lastTickMs = 0

  getState(): EdgeProbeState {
    return this.state
  }

  getSide(): EdgeProbeSide | null {
    return this.side
  }

  isActive(): boolean {
    return this.state !== 'OFF'
  }

  isTransitioning(): boolean {
    return this.state === 'ENTERING' || this.state === 'STRAIGHTENING' || this.state === 'RETURNING'
  }

  getAngle(): number {
    return this.isActive() ? this.angle : 0
  }

  getExposure(): number {
    return this.isActive() ? this.exposure : 1.0
  }

  getPose(originMetrics?: PetRenderMetricsLite): EdgeProbePose {
    const active = this.isActive()
    const m = originMetrics ?? this.metrics
    const pivotX = m ? m.hitbox.left + m.body.width / 2 : 0
    const pivotY = m ? m.hitbox.top + m.body.height / 2 : 0
    return {
      state: this.state,
      side: this.side,
      angle: active ? this.angle : 0,
      exposure: active ? this.exposure : 1.0,
      active,
      transformOrigin: `${pivotX}px ${pivotY}px`,
    }
  }

  onDragStarted(): void {
    if (this.isActive()) {
      this.cancel('drag_started')
    }
  }

  startEntering(side: EdgeProbeSide, metrics: PetRenderMetricsLite, nowMs: number): void {
    this.side = side
    this.metrics = metrics
    const targetAngle = side === 'left' ? EDGE_PROBE_ANGLE : -EDGE_PROBE_ANGLE
    this.beginTransition('ENTERING', EDGE_ENTER_MS, targetAngle, EDGE_PEEK_EXPOSURE, nowMs)
  }

  onDragEnded(
    windowPos: { x: number; y: number },
    normalMetrics: PetRenderMetricsLite,
    monitor: ScreenRect,
    nowMs: number,
  ): EdgeProbeSide | null {
    if (this.isActive()) return null
    const side = detectEdgeAtRest(windowPos, normalMetrics.hitbox, monitor)
    if (!side) return null

    this.startEntering(side, normalMetrics, nowMs)
    return side
  }

  onClicked(nowMs: number): boolean {
    if (!this.isActive()) return false

    if (this.state === 'PEEKING' || this.state === 'RETURNING') {
      this.beginTransition('STRAIGHTENING', EDGE_STRAIGHTEN_MS, 0, EDGE_STRAIGHTEN_EXPOSURE, nowMs)
      return true
    }

    if (this.state === 'STRAIGHTENED') {
      this.idleRemainingMs = EDGE_IDLE_SECONDS * 1000
      this.lastTickMs = nowMs
      return true
    }

    // When active but in ENTERING or STRAIGHTENING, consume the click without state change
    return true
  }

  startReturning(nowMs: number): boolean {
    if (this.state !== 'STRAIGHTENED') return false
    const targetAngle = this.side === 'left' ? EDGE_PROBE_ANGLE : -EDGE_PROBE_ANGLE
    this.beginTransition('RETURNING', EDGE_RETURN_MS, targetAngle, EDGE_PEEK_EXPOSURE, nowMs)
    return true
  }

  tick(nowMs: number): { stateChanged: boolean; pose: EdgeProbePose; isTransitioning: boolean } {
    if (!this.isActive()) {
      return { stateChanged: false, pose: this.getPose(), isTransitioning: false }
    }

    let stateChanged = false

    if (
      this.state === 'ENTERING' ||
      this.state === 'STRAIGHTENING' ||
      this.state === 'RETURNING'
    ) {
      const elapsed = Math.max(0, nowMs - this.transitionStartMs)
      const progress = easedProgress(elapsed, this.transitionDurationMs)
      this.angle =
        this.transitionFromAngle +
        (this.transitionToAngle - this.transitionFromAngle) * progress
      this.exposure =
        this.transitionFromExposure +
        (this.transitionToExposure - this.transitionFromExposure) * progress

      if (progress >= 1.0) {
        this.angle = this.transitionToAngle
        this.exposure = this.transitionToExposure
        stateChanged = true

        if (this.state === 'ENTERING') {
          this.state = 'PEEKING'
        } else if (this.state === 'STRAIGHTENING') {
          this.state = 'STRAIGHTENED'
          this.idleRemainingMs = EDGE_IDLE_SECONDS * 1000
          this.lastTickMs = nowMs
        } else if (this.state === 'RETURNING') {
          this.state = 'PEEKING'
        }
      }
    } else if (this.state === 'STRAIGHTENED') {
      const dt = Math.max(0, nowMs - this.lastTickMs)
      this.lastTickMs = nowMs
      this.idleRemainingMs = Math.max(0, this.idleRemainingMs - dt)

      if (this.idleRemainingMs <= 0) {
        stateChanged = true
        const targetAngle = this.side === 'left' ? EDGE_PROBE_ANGLE : -EDGE_PROBE_ANGLE
        this.beginTransition('RETURNING', EDGE_RETURN_MS, targetAngle, EDGE_PEEK_EXPOSURE, nowMs)
      }
    }

    return {
      stateChanged,
      pose: this.getPose(),
      isTransitioning: this.isTransitioning(),
    }
  }

  cancel(_reason = ''): void {
    void _reason
    this.state = 'OFF'
    this.side = null
    this.metrics = null
    this.angle = 0
    this.exposure = 1.0
    this.idleRemainingMs = 0
  }

  private beginTransition(
    nextState: 'ENTERING' | 'STRAIGHTENING' | 'RETURNING',
    durationMs: number,
    toAngle: number,
    toExposure: number,
    nowMs: number,
  ): void {
    this.state = nextState
    this.transitionDurationMs = durationMs
    this.transitionStartMs = nowMs
    this.lastTickMs = nowMs
    this.transitionFromAngle = this.angle
    this.transitionToAngle = toAngle
    this.transitionFromExposure = this.exposure
    this.transitionToExposure = toExposure
  }
}
