import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { load } from '@tauri-apps/plugin-store'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import { Maximize2 } from 'lucide-react'
import { MiniPetMascot, type MascotLifecycleState, type MascotReaction } from './components/MiniPetMascot'
import { loadCodexPetById, loadDefaultCodexPet, type CodexPetState } from './lib/codexPet'
import { getPetAspectRatio, getPetRenderMetrics, isVideoPet, type PetAsset } from './lib/petAsset'
import { clearReactionIfCurrent } from './lib/videoPet'
import { classifyMascotPointerOutcome } from './lib/mascotInteraction'
import {
  advanceShenshenLifecyclePlayback,
  createShenshenAnimationScheduler,
  getShenshenCalendarContext,
  isCurrentShenshenLifecycleRequest,
  isShenshenTerminalReactionState,
  SHENSHEN_QUOTA_FRESHNESS_MS,
  type ShenshenAnimationRequest,
  type ShenshenLifecyclePlaybackState,
} from './lib/shenshenAnimationScheduler'

const isWindowsPlatform =
  typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')

// Matches Mini.tsx: the collapsed small mascot's visual size is
// round(MASCOT_BASE_SIZE * mascotScale) * large_mascot_scale, driven by the
// "Mascot Size" slider (large_mascot_scale). Mirror that here so extra mascots
// scale together with the primary one.
function computeMascotSize(mascotScale: number, largeMascotScale: number): number {
  return Math.round(MASCOT_BASE_SIZE * mascotScale) * largeMascotScale
}

// Lightweight mascot-only window used by the dev "演示模式" toggle.
// Spawned by the `spawn_demo_mascot` Tauri command with `?demo=1&pet=<id>`
// in the URL. Each window picks up a single codex pet, listens to the
// same Claude/Codex/Cursor task events the main mini window does, and
// shows the corresponding running/idle/jumping animation. State naturally
// stays in sync because every demo window subscribes to the same events.
const MASCOT_BASE_SIZE = 43
const LARGE_MASCOT_SCALE_MIN = 1
const LARGE_MASCOT_SCALE_MAX = 6
const MASCOT_RESIZE_HANDLE_SIZE = 34
const MASCOT_RESIZE_ICON_SIZE = 26
const MASCOT_RESIZE_CURSOR = 'nwse-resize'
// Default before the real scale is loaded from settings, matching Mini's
// defaults (mascot_scale 1 × large_mascot_scale 5).
const DEFAULT_MASCOT_SIZE = computeMascotSize(1, 5)

function clampLargeMascotScale(s: number): number {
  if (!Number.isFinite(s)) return 5
  return Math.min(LARGE_MASCOT_SCALE_MAX, Math.max(LARGE_MASCOT_SCALE_MIN, Math.round(s * 10) / 10))
}

// Functional coding-mode mascots keep Shenshen clicks local to the clicked
// mascot and use right-click to toggle the main panel. Other extra mascots keep
// their existing click-to-open behavior.
export function DemoMascot({ functional = false }: { functional?: boolean } = {}) {
  const [pet, setPet] = useState<PetAsset | null>(null)
  const petRef = useRef<PetAsset | null>(null)
  useEffect(() => { petRef.current = pet }, [pet])
  const [working, setWorking] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [isReview, setIsReview] = useState(false)
  const [syncedLifecycleState, setSyncedLifecycleState] = useState<MascotLifecycleState | null>(null)
  const [syncedBaseState, setSyncedBaseState] = useState<CodexPetState | null>(null)
  const [mascotReaction, setMascotReaction] = useState<MascotReaction | null>(null)
  const mascotReactionRef = useRef<MascotReaction | null>(null)
  useLayoutEffect(() => { mascotReactionRef.current = mascotReaction }, [mascotReaction])
  const [shenshenAnimationRequest, setShenshenAnimationRequest] = useState<ShenshenAnimationRequest | null>(null)
  const shenshenAnimationRequestRef = useRef<ShenshenAnimationRequest | null>(null)
  const shenshenSchedulerRef = useRef<ReturnType<typeof createShenshenAnimationScheduler> | null>(null)
  const shenshenLifecycleRequestVersionRef = useRef(0)
  const shenshenLifecyclePlaybackRef = useRef<ShenshenLifecyclePlaybackState | null>(null)
  const shenshenEffectiveAgentStateRef = useRef<MascotLifecycleState | 'success' | 'failure'>('idle')
  const shenshenQuotaRef = useRef<{ band: number; updatedAtMs: number } | null>(null)
  const shenshenWorkTurnIdRef = useRef(0)
  const completedReactionIdRef = useRef(0)
  if (shenshenSchedulerRef.current == null) shenshenSchedulerRef.current = createShenshenAnimationScheduler()
  const [walkDir, setWalkDir] = useState<-1 | 0 | 1>(0)
  const [dragging, setDragging] = useState(false)
  const [dragInterruptedReactionId, setDragInterruptedReactionId] = useState<number | null>(null)

  const clearReaction = useCallback((reactionId?: number) => {
    const current = mascotReactionRef.current
    if (current && (reactionId === undefined || current.id === reactionId)) {
      completedReactionIdRef.current = Math.max(completedReactionIdRef.current, current.id)
    }
    setMascotReaction((cur) => clearReactionIfCurrent(cur, reactionId))
  }, [])
  const setActiveShenshenRequest = useCallback((request: ShenshenAnimationRequest | null) => {
    shenshenAnimationRequestRef.current = request
    setShenshenAnimationRequest(request)
  }, [])
  const requestShenshenClick = useCallback(() => {
    const selected = petRef.current
    if (!selected || !isVideoPet(selected) || selected.id !== 'shenshen') return
    const nowMs = Date.now()
    const request = shenshenSchedulerRef.current?.select(
      'click',
      {
        ...getShenshenCalendarContext(nowMs),
        nowMs,
        visible: document.visibilityState === 'visible',
        isFree: true,
        affectionTier: 'friendly',
      },
      selected.baseDir ?? '/assets/builtin/shenshen',
    ) ?? null
    if (request) setActiveShenshenRequest(request)
  }, [setActiveShenshenRequest])

  const makeShenshenLifecycleRequest = useCallback((state: MascotLifecycleState | 'success' | 'failure') => {
    const selected = petRef.current
    if (!selected || !isVideoPet(selected) || selected.id !== 'shenshen' || state === 'idle') return null
    const nowMs = Date.now()
    const quota = shenshenQuotaRef.current
    const quotaAgeMs = quota ? nowMs - quota.updatedAtMs : Infinity
    const request = shenshenSchedulerRef.current?.select(
      'agent-state',
      {
        nowMs,
        agentState: state,
        quotaBand: quota?.band,
        quotaFresh: quotaAgeMs >= -30_000 && quotaAgeMs <= SHENSHEN_QUOTA_FRESHNESS_MS,
        workTurnId: shenshenWorkTurnIdRef.current,
      },
      selected.baseDir ?? '/assets/builtin/shenshen',
    ) ?? null
    return request
  }, [])

  const selectShenshenLifecycleAnimation = useCallback((state: MascotLifecycleState | 'success' | 'failure') => {
    const request = makeShenshenLifecycleRequest(state)
    if (request) setActiveShenshenRequest(request)
    return request
  }, [makeShenshenLifecycleRequest, setActiveShenshenRequest])

  const resumeShenshenLifecycleAnimation = useCallback((state: MascotLifecycleState | 'success' | 'failure') => {
    if (
      state === 'idle'
      || document.visibilityState !== 'visible'
    ) return false
    return selectShenshenLifecycleAnimation(state) !== null
  }, [selectShenshenLifecycleAnimation])

  const handleShenshenAnimationEnd = useCallback((requestId: string) => {
    const active = shenshenAnimationRequestRef.current
    if (active?.id !== requestId) return
    if (active.intent === 'agent-state') {
      const state = shenshenEffectiveAgentStateRef.current
      if (!isCurrentShenshenLifecycleRequest(active, requestId, state)) return
      if (isShenshenTerminalReactionState(state)) {
        const reactionId = mascotReactionRef.current?.id
        if (reactionId !== undefined) clearReaction(reactionId)
        setActiveShenshenRequest(null)
        return
      }
      if (resumeShenshenLifecycleAnimation(state)) return
      setActiveShenshenRequest(null)
      return
    }
    if (resumeShenshenLifecycleAnimation(shenshenEffectiveAgentStateRef.current)) return
    setActiveShenshenRequest(null)
  }, [clearReaction, resumeShenshenLifecycleAnimation, setActiveShenshenRequest])

  const handleShenshenPlaybackProgress = useCallback((requestId: string | null, currentTime: number) => {
    const active = shenshenAnimationRequestRef.current
    if (!requestId || active?.id !== requestId || active.intent !== 'agent-state') return
    const state = shenshenEffectiveAgentStateRef.current
    if (
      !isCurrentShenshenLifecycleRequest(active, requestId, state)
      || state === 'idle'
      || isShenshenTerminalReactionState(state)
      || document.visibilityState !== 'visible'
    ) return
    const step = advanceShenshenLifecyclePlayback(
      shenshenLifecyclePlaybackRef.current,
      requestId,
      state,
      currentTime,
      Date.now(),
      active.meta.loop,
    )
    shenshenLifecyclePlaybackRef.current = step.state
    if (step.shouldRotate) resumeShenshenLifecycleAnimation(state)
  }, [resumeShenshenLifecycleAnimation])
  const [resizeHandleHovered, setResizeHandleHovered] = useState(false)
  const [hitboxHovered, setHitboxHovered] = useState(false)
  const [size, setSize] = useState(DEFAULT_MASCOT_SIZE)
  const dragActiveRef = useRef(false)
  const actualDraggingRef = useRef(false)
  const baseSizeRef = useRef(MASCOT_BASE_SIZE)
  const largeScaleRef = useRef(5)

  // Parse pet ID from query string or hash
  const params = new URLSearchParams(typeof window !== 'undefined' ? (window.location.search || (window.location.hash.split('?')[1] ?? '')) : '')
  const petIdFromUrl = params.get('pet') ?? ''

  useEffect(() => {
    let cancelled = false
    const id = petIdFromUrl?.trim()
    if (id) {
      loadCodexPetById(id).then((p) => {
        if (!cancelled && p) setPet(p)
      }).catch(() => {})
    } else {
      loadDefaultCodexPet().then((p) => {
        if (!cancelled && p) setPet(p)
      }).catch(() => {})
    }
    return () => {
      cancelled = true
    }
  }, [petIdFromUrl])

  const syncMascotWindowLayout = useCallback((currentPet: PetAsset | null, newSize: number) => {
    if (!currentPet || newSize <= 0) return
    const win = getCurrentWebviewWindow()
    const metrics = getPetRenderMetrics(currentPet, newSize)
    if (isVideoPet(currentPet)) {
      invoke('set_pet_canvas_bounds', {
        windowLabel: win.label,
        canvasW: metrics.canvas.width,
        canvasH: metrics.canvas.height,
        hitboxX: metrics.hitbox.left,
        hitboxY: metrics.hitbox.top,
        hitboxW: metrics.hitbox.width,
        hitboxH: metrics.hitbox.height,
        anchorMode: 'top-left',
      }).catch(() => {})
    } else {
      win.setSize(new LogicalSize(metrics.canvas.width, metrics.canvas.height)).catch(() => {})
    }
  }, [])

  // Sync window size with pet canvas bounds when pet loads or size changes.
  // We explicitly DO NOT unregister in this effect's cleanup so that size changes (e.g. slider, drag)
  // maintain body-anchor continuity in Rust's prev_entry registry.
  useEffect(() => {
    if (size > 0 && pet) {
      syncMascotWindowLayout(pet, size)
    }
  }, [pet, size, syncMascotWindowLayout])

  // Unregister canvas bounds ONLY when component unmounts or pet identity changes
  const petId = pet?.id
  const isVideo = pet ? isVideoPet(pet) : false
  useEffect(() => {
    return () => {
      if (isVideo) {
        const win = getCurrentWebviewWindow()
        invoke('set_pet_canvas_bounds', {
          windowLabel: win.label,
          canvasW: null,
          canvasH: null,
          hitboxX: null,
          hitboxY: null,
          hitboxW: null,
          hitboxH: null,
          anchorMode: 'top-left',
        }).catch(() => {})
      }
    }
  }, [petId, isVideo])

  // Match the primary mascot's size. Read the persisted scale on mount and keep
  // in sync with live slider changes broadcast by the main window. The owning
  // webview window is resized to fit so the mascot never clips and the
  // transparent drag area stays tight to the sprite.
  useEffect(() => {
    let cancelled = false
    const applySize = (next: number) => {
      if (cancelled || !Number.isFinite(next) || next <= 0) return
      setSize(next)
      largeScaleRef.current = clampLargeMascotScale(next / Math.max(1, baseSizeRef.current))
      syncMascotWindowLayout(petRef.current, next)
    }
    ;(async () => {
      try {
        const store = await load('settings.json', { defaults: {}, autoSave: false })
        const ms = (await store.get('mascot_scale')) as number | null
        const lms = (await store.get('large_mascot_scale')) as number | null
        const mascotScale = typeof ms === 'number' && ms > 0 ? ms : 1
        const largeScale = clampLargeMascotScale(typeof lms === 'number' && lms > 0 ? lms : 5)
        baseSizeRef.current = Math.round(MASCOT_BASE_SIZE * mascotScale)
        largeScaleRef.current = largeScale
        applySize(computeMascotSize(
          mascotScale,
          largeScale,
        ))
      } catch {
        /* fall back to default size */
      }
    })()
    const unlisten = listen<{ size?: number }>('mascot-visual-size', (ev) => {
      const s = ev.payload?.size
      if (typeof s === 'number') applySize(s)
    })
    return () => {
      cancelled = true
      unlisten.then((fn) => fn())
    }
  }, [syncMascotWindowLayout])

  const handleResizePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 || e.ctrlKey) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.screenX
    const startY = e.screenY
    const startSize = size
    const baseSize = Math.max(1, baseSizeRef.current)
    const aspect = getPetAspectRatio(petRef.current)
    const pid = e.pointerId
    let latestScale = largeScaleRef.current
    let rafId: number | null = null

    const applyScale = (scale: number) => {
      const clamped = clampLargeMascotScale(scale)
      latestScale = clamped
      largeScaleRef.current = clamped
      const nextSize = baseSize * clamped
      setSize(nextSize)
      syncMascotWindowLayout(petRef.current, nextSize)
      emit('mascot-scale-change', { scale: clamped }).catch(() => {})
      emit('mascot-visual-size', { size: nextSize }).catch(() => {})
    }

    const schedule = (scale: number) => {
      latestScale = scale
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        applyScale(latestScale)
      })
    }

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return
      const dx = ev.screenX - startX
      const dy = ev.screenY - startY
      const targetSize = startSize + Math.max(dx, dy / aspect)
      schedule(targetSize / baseSize)
    }

    const cleanup = async () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      applyScale(latestScale)
      try {
        const store = await load('settings.json', { defaults: {}, autoSave: true })
        await store.set('large_mascot_scale', latestScale)
        await store.save()
      } catch {
        /* main mini window also persists via mascot-scale-change */
      }
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      setResizeHandleHovered(false)
    }

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return
      cleanup().catch(() => {})
    }

    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return
      cleanup().catch(() => {})
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
    window.addEventListener('pointercancel', onCancel, { once: true })
  }, [size])

  // Mirror the main mini window's resolved mascot state. The main
  // window owns the claude/codex/cursor session polling and emits
  // `mini-pet-state` on every change (and every 2s as a heartbeat),
  // so listening here keeps every demo window perfectly in sync with
  // the real mascot's working / waiting / idle / review without duplicating
  // any poll loops on our side.
  useEffect(() => {
    const unlisten = listen<{
      state?: MascotLifecycleState
      baseState?: CodexPetState
      reaction?: 'waving' | 'failed' | null
      reactionId?: number | null
      quotaBand?: number | null
      quotaUpdatedAtMs?: number | null
      workTurnId?: number
    }>('mini-pet-state', (ev) => {
      const p = ev.payload
      shenshenWorkTurnIdRef.current = typeof p?.workTurnId === 'number' ? p.workTurnId : 0
      shenshenQuotaRef.current = typeof p?.quotaBand === 'number' && typeof p.quotaUpdatedAtMs === 'number'
        ? { band: p.quotaBand, updatedAtMs: p.quotaUpdatedAtMs }
        : null
      if (p?.baseState) {
        setSyncedBaseState(p.baseState)
      }
      const s = p?.state
      if (s) setSyncedLifecycleState(s)
      if (s === 'review') {
        setIsReview(true)
        setWaiting(false)
        setWorking(false)
      } else if (s === 'waiting') {
        setIsReview(false)
        setWaiting(true)
        setWorking(false)
      } else if (s === 'working' || s === 'compacting') {
        setIsReview(false)
        setWaiting(false)
        setWorking(true)
      } else {
        setIsReview(false)
        setWaiting(false)
        setWorking(false)
      }

      if (p?.reaction && typeof p.reactionId === 'number') {
        if (p.reactionId <= completedReactionIdRef.current) return
        const nextReaction: MascotReaction = { state: p.reaction, id: p.reactionId }
        if (actualDraggingRef.current) setDragInterruptedReactionId(nextReaction.id)
        setMascotReaction((cur) => (cur?.id === nextReaction.id ? cur : nextReaction))
      } else if (p?.reaction === null) {
        setMascotReaction(null)
      }
    })
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [])

  // Direct drag using the current webview's absolute position. Read the native
  // position once on pointerdown, then coalesce move events through RAF so fast
  // pointer bursts do not queue stale async window-position reads.
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 || e.ctrlKey) return
    e.preventDefault()
    dragActiveRef.current = true
    const win = getCurrentWebviewWindow()
    const startX = e.screenX
    const startY = e.screenY
    let lastX = e.screenX
    let dragging = false
    const pid = e.pointerId
    let originX = 0
    let originY = 0
    let originReady = false
    let targetX = 0
    let targetY = 0
    let rafId: number | null = null
    let latestDxTotal = 0
    let latestDyTotal = 0
    let positionInFlight = false
    let positionDirty = false

    Promise.all([win.scaleFactor(), win.outerPosition()])
      .then(([scale, pos]) => {
        originX = pos.x / scale
        originY = pos.y / scale
        targetX = originX + latestDxTotal
        targetY = originY + latestDyTotal
        originReady = true
        if (dragging) schedulePosition()
      })
      .catch(() => {
        originReady = false
      })

    const flushPosition = () => {
      rafId = null
      if (!originReady || !dragActiveRef.current) return
      if (positionInFlight) {
        positionDirty = true
        return
      }
      positionInFlight = true
      const x = targetX
      const y = targetY
      win.setPosition(new LogicalPosition(x, y))
        .catch(() => {})
        .finally(() => {
          positionInFlight = false
          if (positionDirty && dragActiveRef.current) {
            positionDirty = false
            schedulePosition()
          }
        })
    }

    const schedulePosition = () => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(flushPosition)
    }

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return
      const dxTotal = ev.screenX - startX
      const dyTotal = ev.screenY - startY
      if (!dragging) {
        if (Math.abs(dxTotal) + Math.abs(dyTotal) >= 3) {
          dragging = true
          actualDraggingRef.current = true
          // Force the hover/jump animation off so walkDir → run-left/run-right
          // is visible while dragging (otherwise the pointer stays over the
          // mascot and the jump cycle hides the walk frames).
          setDragInterruptedReactionId(mascotReaction?.id ?? null)
          setDragging(true)
        } else {
          return
        }
      }
      latestDxTotal = dxTotal
      latestDyTotal = dyTotal
      if (originReady) {
        targetX = originX + latestDxTotal
        targetY = originY + latestDyTotal
        schedulePosition()
      }
      const dx = ev.screenX - lastX
      lastX = ev.screenX
      if (dx !== 0) setWalkDir(dx > 0 ? 1 : -1)
    }

    const cleanup = () => {
      dragActiveRef.current = false
      actualDraggingRef.current = false
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      if (originReady) {
        win.setPosition(new LogicalPosition(targetX, targetY)).catch(() => {})
      }
      setWalkDir(0)
      setDragging(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return
      cleanup()
    }
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return
      const wasDragging = dragging
      cleanup()
      // A tap (no drag) on a functional extra mascot mirrors the primary
      // mascot's click action: expand the main session panel. On macOS the
      // primary mascot opens the panel via notch hover (a tap is a no-op), so
      // keep extra mascots consistent and skip the click-to-expand there.
      const outcome = classifyMascotPointerOutcome({ button: e.button, ctrlKey: e.ctrlKey, wasDragging })
      if (functional && outcome === 'left-click') {
        if (petRef.current?.id === 'shenshen') requestShenshenClick()
        else if (isWindowsPlatform) emit('extra-mascot-activate').catch(() => {})
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
    window.addEventListener('pointercancel', onCancel, { once: true })
  }, [functional, mascotReaction, requestShenshenClick])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    if (functional && e.button === 2) emit('extra-mascot-activate', { toggle: true }).catch(() => {})
  }, [functional])

  useEffect(() => {
    const requestVersion = ++shenshenLifecycleRequestVersionRef.current
    if (petRef.current?.id !== 'shenshen') {
      shenshenAnimationRequestRef.current = null
      shenshenSchedulerRef.current?.clear()
      return
    }
    const lifecycle = syncedLifecycleState ?? (isReview ? 'review' : waiting ? 'waiting' : working ? 'working' : 'idle')
    const agentState = mascotReaction?.state === 'waving'
      ? 'success'
      : mascotReaction?.state === 'failed'
        ? 'failure'
        : lifecycle
    shenshenEffectiveAgentStateRef.current = agentState
    if (agentState === 'idle') {
      if (shenshenAnimationRequestRef.current?.intent === 'agent-state') {
        shenshenAnimationRequestRef.current = null
      }
      return
    }
    const request = makeShenshenLifecycleRequest(agentState)
    if (!request) return
    queueMicrotask(() => {
      const active = shenshenAnimationRequestRef.current
      if (
        shenshenLifecycleRequestVersionRef.current === requestVersion
        && petRef.current?.id === 'shenshen'
        && shenshenEffectiveAgentStateRef.current === agentState
        && (!active || active.intent === 'agent-state')
      ) setActiveShenshenRequest(request)
    })
    return () => { shenshenLifecycleRequestVersionRef.current += 1 }
  }, [syncedLifecycleState, isReview, waiting, working, mascotReaction, pet?.id, makeShenshenLifecycleRequest, setActiveShenshenRequest])

  const baseState: CodexPetState = walkDir === 1
    ? 'run-right'
    : walkDir === -1
      ? 'run-left'
      : syncedBaseState
        ? syncedBaseState
        : isReview
          ? 'review'
          : waiting
            ? 'waiting'
            : working
              ? 'running'
              : 'idle'
  const lifecycleState = syncedLifecycleState ?? (isReview ? 'review' : waiting ? 'waiting' : working ? 'working' : 'idle')
  const effectiveAgentState = mascotReaction?.state === 'waving'
    ? 'success'
    : mascotReaction?.state === 'failed'
      ? 'failure'
      : lifecycleState
  useLayoutEffect(() => { shenshenEffectiveAgentStateRef.current = effectiveAgentState }, [effectiveAgentState])
  const activeShenshenAnimationRequest = pet?.id === 'shenshen'
    && !(effectiveAgentState === 'idle' && shenshenAnimationRequest?.intent === 'agent-state')
    ? shenshenAnimationRequest
    : null

  if (!pet) return null

  const metrics = getPetRenderMetrics(pet, size)

  return (
    <div
      onContextMenu={functional && pet?.id === 'shenshen' ? handleContextMenu : undefined}
      style={{
        position: 'relative',
        width: metrics.canvas.width,
        height: metrics.canvas.height,
        background: 'transparent',
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
        }}
      >
        <MiniPetMascot
          pet={pet}
          baseState={baseState}
          lifecycleState={lifecycleState}
          reaction={mascotReaction}
          onReactionEnd={clearReaction}
          animationRequest={activeShenshenAnimationRequest}
          onAnimationRequestEnd={handleShenshenAnimationEnd}
          onPlaybackProgress={handleShenshenPlaybackProgress}
          size={size}
          layoutMode="canvas"
          enableHoverJump
          externalHover={hitboxHovered}
          useExternalHover
          suppressHover={dragging}
          isDragging={dragging}
          interruptedReactionId={dragInterruptedReactionId}
        />
      </div>

      {/* Interactive hitbox overlay for character body */}
      <div
        onPointerDown={handlePointerDown}
        onPointerEnter={() => setHitboxHovered(true)}
        onPointerLeave={() => setHitboxHovered(false)}
        style={{
          position: 'absolute',
          left: metrics.hitbox.left,
          top: metrics.hitbox.top,
          width: metrics.hitbox.width,
          height: metrics.hitbox.height,
          cursor: 'grab',
          pointerEvents: 'auto',
          background: 'transparent',
          zIndex: 10,
        }}
      />

      <div
        data-no-drag
        onPointerEnter={() => setResizeHandleHovered(true)}
        onPointerLeave={() => setResizeHandleHovered(false)}
        onPointerDown={handleResizePointerDown}
        style={{
          position: 'absolute',
          left: metrics.hitbox.left + metrics.hitbox.width - MASCOT_RESIZE_HANDLE_SIZE,
          top: metrics.hitbox.top + metrics.hitbox.height - MASCOT_RESIZE_HANDLE_SIZE,
          width: MASCOT_RESIZE_HANDLE_SIZE,
          height: MASCOT_RESIZE_HANDLE_SIZE,
          cursor: MASCOT_RESIZE_CURSOR,
          pointerEvents: 'auto',
          zIndex: 12,
          touchAction: 'none',
          background: 'rgba(255,255,255,0.01)',
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'flex-end',
          padding: 4,
        }}
      >
        <div
          style={{
            width: MASCOT_RESIZE_ICON_SIZE,
            height: MASCOT_RESIZE_ICON_SIZE,
            borderRadius: 8,
            background: 'rgba(255,255,255,0.94)',
            boxShadow: '0 3px 10px rgba(0,0,0,0.22)',
            color: '#1f2937',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: MASCOT_RESIZE_CURSOR,
            opacity: resizeHandleHovered ? 1 : 0,
            transform: resizeHandleHovered ? 'translateY(0) scale(1) rotate(90deg)' : 'translateY(3px) scale(0.92) rotate(90deg)',
            transition: 'opacity 120ms ease, transform 120ms ease',
            pointerEvents: 'none',
          }}
        >
          <Maximize2 size={15} strokeWidth={2.4} />
        </div>
      </div>
      {/* Status indicator dot, mirroring the primary mascot's bottom-right
          light so coding-mode extra mascots show the same working/waiting/idle
          status. Decorative demo mascots stay clean. */}
      {functional && (
        <div
          style={{
            position: 'absolute',
            left: metrics.hitbox.left + metrics.hitbox.width - 15,
            top: metrics.hitbox.top + metrics.hitbox.height - 13,
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: isReview ? '#c084fc' : waiting ? '#f59e0b' : working ? '#2ecc71' : '#777',
            border: '1.1px solid rgba(0,0,0,0.3)',
            pointerEvents: 'none',
            zIndex: 11,
          }}
        />
      )}
    </div>
  )
}
