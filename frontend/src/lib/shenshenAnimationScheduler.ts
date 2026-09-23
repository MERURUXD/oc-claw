import rawCatalog from './shenshen-animation-catalog.json' with { type: 'json' }
import type { HarnessQuotaSummary } from './types'

export type ShenshenSeason = 'spring' | 'summer' | 'autumn' | 'winter'
export type ShenshenTimeWindow = 'breakfast' | 'lunch' | 'dinner' | 'generic'
export type ShenshenIntent =
  | 'idle-cycle'
  | 'ambient'
  | 'click'
  | 'headpat'
  | 'farewell'
  | 'angry'
  | 'drag'
  | 'turn'
  | 'movement'
  | 'agent-state'
  | 'quota-band'
  | 'quota-recovery'
  | 'festival'
  | 'whisper'
  | 'pet-action'

export interface ShenshenMoveMetadata {
  minDist: number
  maxDist: number
  margin: number
  leadSec: number
  tailSec: number
  referenceWidth: number
}

export interface ShenshenCatalogEntry {
  id: string
  src: string
  sourceCategory: 'idle' | 'turn' | 'move' | 'click' | 'drag' | 'quota' | 'random'
  sourceGroup: string | null
  sourceBlobSha1: string
  sha256: string
  sizeBytes: number
  tags: string[]
  loop: boolean
  weight: number
  minimumIdleMs: number
  cooldownMs: number
  intents: ShenshenIntent[]
  petActions: string[]
  agentStates: string[]
  eventIds: string[]
  season: ShenshenSeason | null
  timeWindow: Exclude<ShenshenTimeWindow, 'generic'> | null
  quotaBand: number | null
  noMirror: boolean
  move: ShenshenMoveMetadata | null
}

export interface ShenshenAnimationCatalog {
  schemaVersion: number
  source: {
    repository: string
    tag: string
    commit: string
    assetPath: string
    webmCount: number
    totalBytes: number
    upstreamMetadata: string
    moveStridesFilePresent: boolean
    assetTerms: string
  }
  moveDefaults: ShenshenMoveMetadata
  quotaBands: Array<{ minRemaining: number; maxRemaining: number; exactRemaining?: number; animationId: string }>
  animations: ShenshenCatalogEntry[]
}

export interface ShenshenSelectionContext {
  nowMs: number
  season?: ShenshenSeason
  timeWindow?: ShenshenTimeWindow
  activeEvents?: string[]
  isFree?: boolean
  visible?: boolean
  isDragging?: boolean
  isMoving?: boolean
  interactionActive?: boolean
  idleDurationMs?: number
  petAction?: string
  agentState?: string
  quotaBand?: number
  quotaFresh?: boolean
  workTurnId?: number
  affectionTier?: 'angry' | 'shy' | 'friendly'
}

export interface ShenshenAnimationRequest {
  id: string
  animationId: string
  intent: ShenshenIntent
  priority: number
  reason: string
  entry: ShenshenCatalogEntry
  meta: { src: string; loop: boolean; noMirror?: boolean }
}

export interface ShenshenCandidateInspection {
  id: string
  eligible: boolean
  reason: string
}

export const SHENSHEN_QUOTA_FRESHNESS_MS = 5 * 60_000
export const SHENSHEN_LOOP_ROTATION_DWELL_MS = 15_000
const SHENSHEN_FUTURE_TIMESTAMP_TOLERANCE_MS = 30_000

export interface FreshShenshenQuota {
  band: number
  updatedAtMs: number
  expiresAtMs: number
}

/** Return the lowest currently usable quota band across connected harnesses. */
export function resolveFreshShenshenQuota(
  summaries: readonly HarnessQuotaSummary[],
  nowMs: number,
  maxAgeMs = SHENSHEN_QUOTA_FRESHNESS_MS,
): FreshShenshenQuota | null {
  let lowestRemaining: number | null = null
  let sourceUpdatedAtMs = 0

  for (const summary of summaries) {
    if (!summary.connected || !Number.isFinite(summary.updated_at) || summary.updated_at <= 0) continue
    const updatedAtMs = summary.updated_at < 1e11 ? summary.updated_at * 1000 : summary.updated_at
    const ageMs = nowMs - updatedAtMs
    if (ageMs < -SHENSHEN_FUTURE_TIMESTAMP_TOLERANCE_MS || ageMs > maxAgeMs) continue

    const windows = [
      ...(summary.primary ? [summary.primary] : []),
      ...(Array.isArray(summary.details) ? summary.details : []),
    ].filter((window, index, all) =>
      Number.isFinite(window.percent)
      && window.percent >= 0
      && window.percent <= 100
      && all.findIndex((candidate) => candidate.label === window.label) === index,
    )
    if (windows.length === 0) continue

    const remaining = Math.min(...windows.map((window) => 100 - window.percent))
    if (
      lowestRemaining === null
      || remaining < lowestRemaining
      || (remaining === lowestRemaining && updatedAtMs > sourceUpdatedAtMs)
    ) {
      lowestRemaining = remaining
      sourceUpdatedAtMs = updatedAtMs
    }
  }

  if (lowestRemaining === null) return null
  return {
    band: getShenshenQuotaBand(lowestRemaining),
    updatedAtMs: sourceUpdatedAtMs,
    expiresAtMs: sourceUpdatedAtMs + maxAgeMs,
  }
}

export interface ShenshenLifecyclePlaybackState {
  requestId: string
  agentState: string
  startedAtMs: number
  lastTimeSeconds: number
}

export function resolveShenshenLifecycleState(signals: {
  review: boolean
  waiting: boolean
  compacting: boolean
  working: boolean
}): 'idle' | 'working' | 'compacting' | 'waiting' | 'review' {
  if (signals.review) return 'review'
  if (signals.waiting) return 'waiting'
  if (signals.compacting) return 'compacting'
  if (signals.working) return 'working'
  return 'idle'
}

export function advanceShenshenLifecyclePlayback(
  previous: ShenshenLifecyclePlaybackState | null,
  requestId: string,
  agentState: string,
  currentTimeSeconds: number,
  nowMs: number,
  isLooping: boolean,
  dwellMs = SHENSHEN_LOOP_ROTATION_DWELL_MS,
): { state: ShenshenLifecyclePlaybackState; shouldRotate: boolean } {
  const currentTime = Math.max(0, Number.isFinite(currentTimeSeconds) ? currentTimeSeconds : 0)
  const sameRequest = previous?.requestId === requestId && previous.agentState === agentState
  const startedAtMs = sameRequest ? previous.startedAtMs : nowMs
  const looped = sameRequest && currentTime < previous.lastTimeSeconds - 0.05
  return {
    state: { requestId, agentState, startedAtMs, lastTimeSeconds: currentTime },
    shouldRotate: Boolean(isLooping && looped && nowMs - startedAtMs >= dwellMs),
  }
}

const LIFECYCLE_POOL_IDS: Record<string, { core: string[]; secondary: string[] }> = {
  working: {
    core: ['工作状态-忙碌点按', '工作状态-思考冒泡'],
    secondary: ['写代码', '轻快记录', '深度思考碎碎念', '碎碎念-对屏碎碎念', '碎碎念-擦桌碎碎念'],
  },
  compacting: {
    core: ['工作状态-清点归档'],
    secondary: ['轻快记录', '碎碎念-擦桌碎碎念'],
  },
  waiting: {
    core: ['工作状态-原地踱步张望'],
    secondary: ['东张西望', '碎碎念-发呆碎碎念'],
  },
  review: {
    core: ['工作状态-思考冒泡'],
    secondary: ['深度思考碎碎念', '碎碎念-对屏碎碎念'],
  },
  success: {
    core: ['工作状态-雀跃庆祝'],
    secondary: ['点击回应-元气挥手', '点击回应-开心跃动'],
  },
  failure: {
    core: ['工作状态-垂头叹气冒汗'],
    secondary: [],
  },
}

export const SHENSHEN_ANIMATION_CATALOG = rawCatalog as unknown as ShenshenAnimationCatalog
export const SHENSHEN_ANIMATIONS = SHENSHEN_ANIMATION_CATALOG.animations

const AMBIENT_RECENT_LIMIT = 8
const INTERACTION_RECENT_LIMIT = 4

function getSeason(date: Date): ShenshenSeason {
  const month = date.getMonth() + 1
  if (month >= 3 && month <= 5) return 'spring'
  if (month >= 6 && month <= 8) return 'summer'
  if (month >= 9 && month <= 11) return 'autumn'
  return 'winter'
}

function getTimeWindow(date: Date): ShenshenTimeWindow {
  const hour = date.getHours()
  if (hour >= 5 && hour < 11) return 'breakfast'
  if (hour >= 11 && hour < 16) return 'lunch'
  if (hour >= 16 && hour < 22) return 'dinner'
  return 'generic'
}

export function getShenshenCalendarContext(nowMs: number): Pick<ShenshenSelectionContext, 'season' | 'timeWindow' | 'activeEvents'> {
  const date = new Date(nowMs)
  const month = date.getMonth() + 1
  const day = date.getDate()
  const activeEvents: string[] = []

  // Gregorian events are intentionally small, dependency-free calendar rules.
  // Lunar festivals stay user-selectable through the explicit event pool.
  if ((month === 10 && day >= 20) || (month === 11 && day === 1)) activeEvents.push('halloween')
  if (month === 12 && day >= 1 && day <= 26) activeEvents.push('christmas')
  if ((month === 12 && day === 31) || (month === 1 && day === 1)) activeEvents.push('new-year')

  return { season: getSeason(date), timeWindow: getTimeWindow(date), activeEvents }
}

export function getShenshenQuotaBand(remainingPercent: number): number {
  const remaining = Math.max(0, Math.min(100, Number.isFinite(remainingPercent) ? remainingPercent : 0))
  const bands = SHENSHEN_ANIMATION_CATALOG.quotaBands
  const exactBand = bands.findIndex((candidate) => candidate.exactRemaining === remaining)
  if (exactBand >= 0) return exactBand
  const band = bands.findIndex((candidate) => candidate.exactRemaining === undefined
    && remaining >= candidate.minRemaining
    && (remaining < candidate.maxRemaining || (candidate.maxRemaining === 100 && remaining === 100)))
  return band >= 0 ? band : bands.length - 1
}

export function getShenshenQuotaAnimationId(band: number): string | null {
  return SHENSHEN_ANIMATION_CATALOG.quotaBands[band]?.animationId ?? null
}

export function createShenshenQuotaBandTracker() {
  const bands = new Map<string, number>()
  return {
    observe(harness: string, band: number, recoveredBand?: number): { intent: 'quota-band' | 'quota-recovery'; band: number } | null {
      const previousBand = bands.get(harness)
      bands.set(harness, band)
      if (recoveredBand !== undefined) return { intent: 'quota-recovery', band: recoveredBand }
      if (previousBand === undefined || previousBand === band) return null
      return { intent: 'quota-band', band }
    },
    clear() {
      bands.clear()
    },
  }
}

function eventAllows(entry: ShenshenCatalogEntry, context: ShenshenSelectionContext): boolean {
  const activeEvents = context.activeEvents ?? []
  if (entry.eventIds.length > 0 && !entry.eventIds.some((eventId) => activeEvents.includes(eventId))) return false
  if (entry.season && context.season !== entry.season && !activeEvents.includes(`season:${entry.season}`)) return false
  return true
}

function entryIntentMatches(
  entry: ShenshenCatalogEntry,
  intent: ShenshenIntent,
  context: ShenshenSelectionContext,
  eventId?: string,
): boolean {
  switch (intent) {
    case 'pet-action':
      return !!context.petAction && entry.petActions.includes(context.petAction)
    case 'agent-state':
      return !!context.agentState && entry.agentStates.includes(context.agentState)
    case 'idle-cycle':
      return entry.intents.includes('ambient')
    case 'festival':
      return !!eventId && (entry.eventIds.includes(eventId) || entry.season === eventId)
    case 'quota-band':
    case 'quota-recovery':
      return entry.quotaBand === context.quotaBand
    case 'headpat':
      return entry.petActions.includes('headpat')
    case 'farewell':
      return entry.petActions.includes('farewell')
    case 'angry':
      return entry.petActions.includes('angry')
    default:
      return entry.intents.includes(intent)
  }
}

function contextRejection(
  entry: ShenshenCatalogEntry,
  intent: ShenshenIntent,
  context: ShenshenSelectionContext,
  eventId?: string,
): string | null {
  if (intent === 'agent-state' && entry.quotaBand !== null) {
    if (context.agentState !== 'working') return 'quota-animation-working-only'
    if (context.quotaFresh !== true || context.workTurnId === undefined) return 'quota-data-not-fresh'
    if (context.quotaBand !== entry.quotaBand) return 'quota-band-mismatch'
  }

  if (intent === 'ambient' || intent === 'idle-cycle') {
    if (!context.visible) return 'window-hidden-or-suspended'
    if (!context.isFree) return 'higher-priority-state-active'
    if (context.isDragging) return 'dragging'
    if (context.isMoving) return 'explicit-movement'
    if (context.interactionActive) return 'interaction-active'
    if (intent === 'ambient' && (context.idleDurationMs ?? 0) < entry.minimumIdleMs) return 'minimum-idle-not-reached'
  }

  if (entry.eventIds.length > 0 && !eventAllows(entry, context)) {
    return `event-required:${entry.eventIds.join('|')}`
  }
  if (entry.season && context.season !== entry.season && !(context.activeEvents ?? []).includes(`season:${entry.season}`)) {
    return `season-required:${entry.season}`
  }
  if (intent === 'festival' && eventId && !(context.activeEvents ?? []).includes(eventId) && !(context.activeEvents ?? []).includes(`season:${eventId}`)) {
    return `event-not-active:${eventId}`
  }
  const headpatRequest = intent === 'headpat'
    || (intent === 'pet-action' && context.petAction === 'headpat')
  if (
    entry.id === '点击回应-傲娇生气'
    && context.affectionTier !== 'angry'
    && (intent === 'click' || headpatRequest)
  ) {
    return 'angry-reaction-requires-angry-context'
  }
  return null
}

export function inspectShenshenCandidates(
  intent: ShenshenIntent,
  context: ShenshenSelectionContext,
  options: { eventId?: string; lastPlayedAt?: ReadonlyMap<string, number> } = {},
): ShenshenCandidateInspection[] {
  return SHENSHEN_ANIMATIONS
    .filter((entry) => entryIntentMatches(entry, intent, context, options.eventId))
    .map((entry) => {
      const rejection = contextRejection(entry, intent, context, options.eventId)
      const cooldownUntil = options.lastPlayedAt?.get(entry.id)
      const cooling = (intent === 'ambient' || intent === 'idle-cycle')
        && cooldownUntil !== undefined && context.nowMs - cooldownUntil < entry.cooldownMs
      return {
        id: entry.id,
        eligible: rejection === null && !cooling,
        reason: rejection ?? (cooling ? 'per-clip-cooldown' : 'eligible'),
      }
    })
}

export function resolveSemanticCatalogEntry(
  intent: ShenshenIntent,
  context: ShenshenSelectionContext,
  options: { eventId?: string; lastPlayedAt?: ReadonlyMap<string, number> } = {},
): ShenshenCatalogEntry[] {
  const inspections = inspectShenshenCandidates(intent, context, options)
  const eligibleIds = new Set(inspections.filter((candidate) => candidate.eligible).map((candidate) => candidate.id))
  return SHENSHEN_ANIMATIONS.filter((entry) => eligibleIds.has(entry.id))
}

export function resolveShenshenEntryById(animationId: string): ShenshenCatalogEntry | null {
  return SHENSHEN_ANIMATIONS.find((entry) => entry.id === animationId) ?? null
}

function intentPriority(intent: ShenshenIntent, entry: ShenshenCatalogEntry, agentState?: string): number {
  if (intent === 'click') return 91
  if (intent === 'headpat' || intent === 'farewell' || intent === 'angry' || intent === 'drag') return 90
  if (intent === 'pet-action') return entry.sourceCategory === 'move' ? 81 : 90
  if (intent === 'agent-state') {
    const state = agentState ?? entry.agentStates[0]
    return state === 'success' || state === 'failure' ? 71
      : state === 'review' ? 61
        : state === 'waiting' ? 51
          : state === 'compacting' ? 41
            : 31
  }
  if (intent === 'movement') return 81
  if (intent === 'turn') return 15
  if (intent === 'festival') return 25
  if (intent === 'quota-band' || intent === 'quota-recovery' || intent === 'whisper') return 75
  return 20
}

function resolveAssetUrl(baseDir: string, src: string): string {
  if (/^(?:https?:|asset:|\/)/i.test(src)) return src
  return `${baseDir.replace(/\/+$/, '')}/${src.replace(/^\/+/, '')}`
}

export function createShenshenAnimationRequest(
  sequence: number,
  intent: ShenshenIntent,
  entry: ShenshenCatalogEntry,
  baseDir: string,
  reason: string,
  agentState?: string,
): ShenshenAnimationRequest {
  return {
    id: `shenshen:${sequence}:${entry.id}`,
    animationId: entry.id,
    intent,
    priority: intentPriority(intent, entry, agentState),
    reason,
    entry,
    meta: {
      src: resolveAssetUrl(baseDir, entry.src),
      loop: intent === 'agent-state' && !isShenshenTerminalReactionState(agentState ?? '') ? false : entry.loop,
      noMirror: entry.noMirror || undefined,
    },
  }
}

export function isCurrentShenshenLifecycleRequest(
  request: Pick<ShenshenAnimationRequest, 'id' | 'intent' | 'reason'> | null | undefined,
  requestId: string,
  agentState: string,
): boolean {
  return request?.intent === 'agent-state'
    && request.id === requestId
    && request.reason === `agent-state:${agentState}`
}

export function isShenshenTerminalReactionState(agentState: string): boolean {
  return agentState === 'success' || agentState === 'failure'
}

export function calculateShenshenMovementOffset(
  entry: ShenshenCatalogEntry,
  elapsedSeconds: number,
  durationSeconds: number,
  mascotWidth: number,
  direction: -1 | 1,
  distanceFraction = 0.5,
): number {
  if (!entry.move || durationSeconds <= 0 || mascotWidth <= 0) return 0
  const { leadSec, tailSec, minDist, maxDist, referenceWidth } = entry.move
  const activeDuration = Math.max(0, durationSeconds - leadSec - tailSec)
  if (activeDuration <= 0) return 0
  const progress = Math.max(0, Math.min(1, (elapsedSeconds - leadSec) / activeDuration))
  const fraction = Math.max(0, Math.min(1, distanceFraction))
  const baseDistance = minDist + (maxDist - minDist) * fraction
  return direction * baseDistance * (mascotWidth / referenceWidth) * progress
}

export type ShenshenMovementPlaybackState = {
  requestId: string
  lastTimeSeconds: number
  cycleBaseOffset: number
  absoluteOffset: number
  direction: -1 | 1
}

export function advanceShenshenMovementPlayback(
  previous: ShenshenMovementPlaybackState | null,
  requestId: string,
  entry: ShenshenCatalogEntry,
  currentTimeSeconds: number,
  durationSeconds: number,
  mascotWidth: number,
  direction: -1 | 1,
  distanceFraction = 0.5,
): { state: ShenshenMovementPlaybackState; delta: number; looped: boolean } {
  const currentTime = Math.max(0, Number.isFinite(currentTimeSeconds) ? currentTimeSeconds : 0)
  const duration = Math.max(0, Number.isFinite(durationSeconds) ? durationSeconds : 0)
  const localOffset = calculateShenshenMovementOffset(entry, currentTime, duration, mascotWidth, direction, distanceFraction)
  const newRequest = previous === null || previous.requestId !== requestId
  const looped = !newRequest && currentTime < previous.lastTimeSeconds - 0.05
  let cycleBaseOffset = newRequest ? 0 : previous.cycleBaseOffset

  if (looped) {
    // The video loop restarts its local clock at zero. Carry the completed
    // stride into the next cycle so the native window does not jump backward.
    cycleBaseOffset += calculateShenshenMovementOffset(entry, duration, duration, mascotWidth, direction, distanceFraction)
  } else if (!newRequest && previous.direction !== direction) {
    // A direction change within one request (for example, edge selection)
    // starts from the current window position instead of reapplying the path.
    cycleBaseOffset = previous.absoluteOffset - localOffset
  }

  const absoluteOffset = cycleBaseOffset + localOffset
  return {
    state: { requestId, lastTimeSeconds: currentTime, cycleBaseOffset, absoluteOffset, direction },
    delta: newRequest ? localOffset : absoluteOffset - previous.absoluteOffset,
    looped,
  }
}

export function getNextShenshenWalkDirection(direction: -1 | 1, walkingToEdge: boolean): -1 | 1 {
  return walkingToEdge ? direction : direction === 1 ? -1 : 1
}

export function getShenshenTimePreferenceWeight(entry: ShenshenCatalogEntry, timeWindow: ShenshenTimeWindow): number {
  return entry.timeWindow ? (entry.timeWindow === timeWindow ? 2.5 : 0.55) : 1
}

export function createShenshenAnimationScheduler(random: () => number = Math.random) {
  const lastPlayedAt = new Map<string, number>()
  const recentIds: string[] = []
  const lifecycleRecentIds = new Map<string, string[]>()
  let lastQuotaAccentWorkTurnId: number | null = null
  let requestSequence = 0

  const remember = (entry: ShenshenCatalogEntry, nowMs: number, limit: number) => {
    lastPlayedAt.set(entry.id, nowMs)
    recentIds.unshift(entry.id)
    recentIds.length = Math.min(recentIds.length, limit)
  }

  const pickWeighted = (entries: ShenshenCatalogEntry[], timeWindow: ShenshenTimeWindow): ShenshenCatalogEntry => {
    const weighted = entries.map((entry) => ({
      entry,
      weight: Math.max(0, entry.weight) * getShenshenTimePreferenceWeight(entry, timeWindow),
    }))
    const totalWeight = weighted.reduce((sum, candidate) => sum + candidate.weight, 0)
    if (totalWeight <= 0) return entries[Math.floor(Math.max(0, random()) * entries.length) % entries.length]
    let ticket = Math.max(0, Math.min(0.999999999, random())) * totalWeight
    for (const candidate of weighted) {
      ticket -= candidate.weight
      if (ticket < 0) return candidate.entry
    }
    return weighted[weighted.length - 1].entry
  }

  const makeRequest = (
    intent: ShenshenIntent,
    selected: ShenshenCatalogEntry,
    context: ShenshenSelectionContext,
    baseDir: string,
    options: { eventId?: string },
  ): ShenshenAnimationRequest => {
    remember(selected, context.nowMs, intent === 'ambient' || intent === 'idle-cycle' ? AMBIENT_RECENT_LIMIT : INTERACTION_RECENT_LIMIT)
    requestSequence += 1
    const reason = intent === 'festival'
      ? `festival:${options.eventId ?? 'unknown'}`
      : intent === 'pet-action'
        ? `pet-action:${context.petAction ?? 'unknown'}`
        : intent === 'agent-state'
          ? `agent-state:${context.agentState ?? 'unknown'}`
          : intent === 'ambient' || intent === 'idle-cycle'
            ? `idle-${intent}:weighted-context-pool`
            : intent === 'quota-band' || intent === 'quota-recovery'
              ? `quota-band:${context.quotaBand ?? -1}`
              : `intent:${intent}`
    const request = createShenshenAnimationRequest(
      requestSequence, intent, selected, baseDir, reason, context.agentState,
    )
    if (
      intent === 'pet-action'
      && (context.petAction === 'walk' || context.petAction === 'walkout')
      && selected.move
    ) {
      // Walk is a sequence of one-shot strides. The clip's catalog default is
      // looped, but Pet Mode rotates to a fresh clip when this stride ends.
      request.meta = { ...request.meta, loop: false }
    }
    return request
  }

  const selectAgentState = (
    context: ShenshenSelectionContext,
    baseDir: string,
  ): ShenshenAnimationRequest | null => {
    const state = context.agentState
    const pool = state ? LIFECYCLE_POOL_IDS[state] : undefined
    if (!state || !pool) return null

    const candidates = resolveSemanticCatalogEntry('agent-state', context, { lastPlayedAt })
    if (candidates.length === 0) return null

    const fresh = candidates.filter((entry) => entry.id !== recentIds[0])
    const crossIntentFresh = fresh.length > 0 ? fresh : candidates

    const workTurnId = state === 'working' ? context.workTurnId : undefined
    const quotaAvailable = state === 'working'
      && context.quotaFresh === true
      && workTurnId !== undefined
      && lastQuotaAccentWorkTurnId !== workTurnId
    const tiers = [
      { key: 'core', entries: crossIntentFresh.filter((entry) => pool.core.includes(entry.id)), weight: 0.4 },
      { key: 'secondary', entries: crossIntentFresh.filter((entry) => pool.secondary.includes(entry.id)), weight: 0.5 },
      {
        key: 'quota',
        entries: quotaAvailable ? crossIntentFresh.filter((entry) => entry.quotaBand !== null) : [],
        weight: 0.1,
      },
    ].filter((tier) => tier.entries.length > 0)

    if (tiers.length === 0) return null
    const totalTierWeight = tiers.reduce((sum, tier) => sum + tier.weight, 0)
    let ticket = Math.max(0, Math.min(0.999999999, random())) * totalTierWeight
    let selectedTier = tiers[tiers.length - 1]
    for (const tier of tiers) {
      ticket -= tier.weight
      if (ticket < 0) {
        selectedTier = tier
        break
      }
    }

    const timeWindow = context.timeWindow ?? getTimeWindow(new Date(context.nowMs))
    const historyKey = `${state}:${selectedTier.key}`
    const history = lifecycleRecentIds.get(historyKey) ?? []
    let tierFresh = selectedTier.entries.filter((entry) => !history.slice(0, 2).includes(entry.id))
    if (tierFresh.length === 0) tierFresh = selectedTier.entries.filter((entry) => entry.id !== history[0])
    if (tierFresh.length === 0) tierFresh = selectedTier.entries
    const selected = pickWeighted(tierFresh, timeWindow)
    lifecycleRecentIds.set(historyKey, [selected.id, ...history.filter((id) => id !== selected.id)].slice(0, 4))
    if (selected.quotaBand !== null && workTurnId !== undefined) lastQuotaAccentWorkTurnId = workTurnId
    return makeRequest('agent-state', selected, context, baseDir, {})
  }

  const select = (
    intent: ShenshenIntent,
    context: ShenshenSelectionContext,
    baseDir: string,
    options: { eventId?: string } = {},
  ): ShenshenAnimationRequest | null => {
    if (intent === 'agent-state') return selectAgentState(context, baseDir)

    const candidates = resolveSemanticCatalogEntry(intent, context, {
      eventId: options.eventId,
      lastPlayedAt,
    })
    if (candidates.length === 0) return null

    const recentLimit = intent === 'ambient' || intent === 'idle-cycle' ? AMBIENT_RECENT_LIMIT : INTERACTION_RECENT_LIMIT
    let fresh = candidates.filter((entry) => !recentIds.slice(0, recentLimit).includes(entry.id))
    if (fresh.length === 0) fresh = candidates.filter((entry) => entry.id !== recentIds[0])
    if (fresh.length === 0) fresh = candidates

    const timeWindow = context.timeWindow ?? getTimeWindow(new Date(context.nowMs))
    return makeRequest(intent, pickWeighted(fresh, timeWindow), context, baseDir, options)
  }

  const force = (
    animationId: string,
    context: ShenshenSelectionContext,
    baseDir: string,
  ): ShenshenAnimationRequest | null => {
    const entry = resolveShenshenEntryById(animationId)
    if (!entry) return null
    requestSequence += 1
    remember(entry, context.nowMs, INTERACTION_RECENT_LIMIT)
    return createShenshenAnimationRequest(requestSequence, 'pet-action', entry, baseDir, 'debug:forced-catalog-entry')
  }

  const getRecentHistory = () => [...recentIds]
  const getLastPlayedAt = () => new Map(lastPlayedAt)
  const clear = () => {
    lastPlayedAt.clear()
    recentIds.length = 0
    lifecycleRecentIds.clear()
    // Keep request identities monotonic so a delayed callback from before a
    // clear cannot match a later request with the same clip ID.
  }

  return { select, force, getRecentHistory, getLastPlayedAt, clear }
}
