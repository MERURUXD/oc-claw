import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  advanceShenshenLifecyclePlayback,
  advanceShenshenMovementPlayback,
  calculateShenshenMovementOffset,
  createShenshenAnimationScheduler,
  createShenshenQuotaBandTracker,
  getShenshenCalendarContext,
  getShenshenIdleGapMs,
  getShenshenQuotaAnimationId,
  getShenshenQuotaBand,
  getNextShenshenWalkDirection,
  getShenshenTimePreferenceWeight,
  isCurrentShenshenLifecycleRequest,
  isShenshenTerminalReactionState,
  inspectShenshenCandidates,
  resolveFreshShenshenQuota,
  resolveShenshenLifecycleState,
  resolveSemanticCatalogEntry,
  SHENSHEN_LOOP_ROTATION_DWELL_MS,
  SHENSHEN_IDLE_GAP_MIN_MS,
  SHENSHEN_IDLE_GAP_MAX_MS,
  SHENSHEN_QUOTA_FRESHNESS_MS,
  SHENSHEN_ANIMATION_CATALOG,
} from './shenshenAnimationScheduler.ts'
import { classifyMascotPointerOutcome } from './mascotInteraction.ts'
import { resolveVideoPetPresentationState } from './videoPet.ts'

const videoDir = resolve(process.cwd(), 'public/assets/builtin/shenshen/videos')
const catalog = SHENSHEN_ANIMATION_CATALOG

test('the pinned catalog is complete, unique, reachable, and hash-verified', async () => {
  assert.equal(catalog.source.webmCount, 106)
  assert.equal(catalog.animations.length, 106)
  assert.equal(catalog.animations.reduce((sum, entry) => sum + entry.sizeBytes, 0), catalog.source.totalBytes)
  assert.equal(catalog.source.commit, '814b0e47812dfd51dbc2df4ca272b57403c5e9cd')

  const ids = new Set<string>()
  const sources = new Set<string>()
  const categoryCounts = new Map<string, number>()
  for (const entry of catalog.animations) {
    assert.equal(ids.has(entry.id), false, `duplicate catalog id: ${entry.id}`)
    assert.equal(sources.has(entry.src), false, `duplicate catalog source: ${entry.src}`)
    ids.add(entry.id)
    sources.add(entry.src)
    categoryCounts.set(entry.sourceCategory, (categoryCounts.get(entry.sourceCategory) ?? 0) + 1)

    const file = resolve(videoDir, entry.src.replace(/^videos\//, ''))
    const bytes = await readFile(file)
    assert.equal(bytes.byteLength, entry.sizeBytes, `size mismatch: ${entry.id}`)
    const gitBlob = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes])).digest('hex')
    assert.equal(gitBlob, entry.sourceBlobSha1, `upstream Git blob mismatch: ${entry.id}`)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `SHA-256 mismatch: ${entry.id}`)

    const hasRuntimePath = ['idle', 'turn', 'move', 'click', 'drag'].includes(entry.sourceCategory)
      || entry.quotaBand !== null
      || entry.agentStates.length > 0
      || entry.petActions.length > 0
      || entry.intents.length > 0
      || entry.eventIds.length > 0
      || entry.season !== null
    assert.equal(hasRuntimePath, true, `unreachable animation: ${entry.id}`)
    if (entry.sourceCategory === 'move') assert.ok(entry.move, `movement metadata missing: ${entry.id}`)
  }

  const localFiles = (await readdir(videoDir)).filter((name) => name.endsWith('.webm')).sort()
  const catalogFiles = [...sources].map((src) => src.replace(/^videos\//, '')).sort()
  assert.deepEqual(localFiles, catalogFiles, 'video directory has missing or orphan files')
  assert.equal(categoryCounts.get('idle'), 1)
  assert.equal(categoryCounts.get('turn'), 1)
  assert.equal(categoryCounts.get('move'), 3)
  assert.equal(categoryCounts.get('click'), 5)
  assert.equal(categoryCounts.get('drag'), 1)
  assert.equal(categoryCounts.get('quota'), 6)
  assert.equal(categoryCounts.get('random'), 89)

  const manifest = JSON.parse(await readFile(resolve(videoDir, '../pet.json'), 'utf8')) as {
    noMirror: string[]
    animations: Record<string, string | { src: string } | Array<string | { src: string }>>
  }
  for (const entry of Object.values(manifest.animations).flat()) {
    const src = typeof entry === 'string' ? entry : entry.src
    assert.ok(sources.has(src), `pet.json references an unregistered video: ${src}`)
  }
  for (const name of manifest.noMirror) assert.ok(ids.has(name), `noMirror entry is not cataloged: ${name}`)
  for (const band of catalog.quotaBands) assert.ok(ids.has(band.animationId), `quota animation is not cataloged: ${band.animationId}`)
})

test('ambient scheduling enforces visibility, free state, idle delay, cooldown, and recent history', () => {
  const base = { nowMs: 1_000_000, season: 'spring' as const, visible: true, isFree: true, idleDurationMs: 600_000 }
  const hidden = inspectShenshenCandidates('ambient', { ...base, visible: false })
  assert.ok(hidden.length > 0)
  assert.ok(hidden.every((candidate) => !candidate.eligible && candidate.reason === 'window-hidden-or-suspended'))
  assert.ok(inspectShenshenCandidates('ambient', { ...base, isFree: false }).every((candidate) => !candidate.eligible))
  assert.ok(inspectShenshenCandidates('ambient', { ...base, idleDurationMs: 0 }).every((candidate) => !candidate.eligible))

  const scheduler = createShenshenAnimationScheduler(() => 0)
  const first = scheduler.select('ambient', base, '/assets/builtin/shenshen')
  const second = scheduler.select('ambient', { ...base, nowMs: base.nowMs + 1_000 }, '/assets/builtin/shenshen')
  assert.ok(first)
  assert.ok(second)
  assert.notEqual(second.animationId, first.animationId, 'recent history should prevent immediate repeats')
  assert.ok(scheduler.getRecentHistory().length >= 2)
  const cooled = inspectShenshenCandidates('ambient', { ...base, nowMs: base.nowMs + 1_001 }, { lastPlayedAt: scheduler.getLastPlayedAt() })
  assert.ok(cooled.some((candidate) => !candidate.eligible && candidate.reason === 'per-clip-cooldown'))
})

test('continuous idle playback uses the ambient pool without replaying the previous clip', () => {
  const scheduler = createShenshenAnimationScheduler(() => 0)
  const context = { nowMs: 1_000_000, season: 'spring' as const, visible: true, isFree: true, idleDurationMs: 0 }
  assert.equal(scheduler.select('idle-cycle', { ...context, visible: false }, '/assets/builtin/shenshen'), null)
  assert.equal(scheduler.select('ambient', context, '/assets/builtin/shenshen'), null, 'occasional ambient events keep their idle delay')
  let previousId: string | null = null
  for (let i = 0; i < 30; i += 1) {
    const request = scheduler.select('idle-cycle', { ...context, nowMs: context.nowMs + i * 10_000 }, '/assets/builtin/shenshen')!
    assert.ok(request)
    assert.equal(request.meta.loop, false)
    assert.notEqual(request.animationId, previousId)
    previousId = request.animationId
  }
})

test('idle playback pauses for a bounded random gap between clips', () => {
  assert.equal(getShenshenIdleGapMs(() => 0), SHENSHEN_IDLE_GAP_MIN_MS)
  assert.equal(getShenshenIdleGapMs(() => 0.5), 12_500)
  assert.equal(getShenshenIdleGapMs(() => 1), SHENSHEN_IDLE_GAP_MAX_MS)
})

test('food timing weights prefer the matching meal period', () => {
  const breakfast = catalog.animations.find((entry) => entry.timeWindow === 'breakfast')!
  const lunch = catalog.animations.find((entry) => entry.timeWindow === 'lunch')!
  assert.equal(getShenshenTimePreferenceWeight(breakfast, 'breakfast'), 2.5)
  assert.equal(getShenshenTimePreferenceWeight(breakfast, 'lunch'), 0.55)
  assert.equal(getShenshenTimePreferenceWeight(lunch, 'lunch'), 2.5)
})

test('event clips are gated, and explicit season events reach seasonal animations', () => {
  const halloween = inspectShenshenCandidates('festival', {
    nowMs: Date.UTC(2026, 5, 1), season: 'summer', activeEvents: [],
  }, { eventId: 'halloween' })
  assert.ok(halloween.length > 0)
  assert.ok(halloween.every((candidate) => !candidate.eligible))

  const winter = resolveSemanticCatalogEntry('festival', {
    nowMs: Date.UTC(2026, 5, 1), season: 'summer', activeEvents: ['season:winter'],
  }, { eventId: 'winter' })
  assert.ok(winter.some((entry) => entry.id === '堆雪人'))
  assert.ok(winter.every((entry) => entry.season === 'winter'))

  const christmas = resolveSemanticCatalogEntry('festival', {
    nowMs: Date.UTC(2026, 5, 1), season: 'summer', activeEvents: ['christmas'],
  }, { eventId: 'christmas' })
  assert.ok(christmas.length > 0)
  assert.ok(christmas.every((entry) => entry.eventIds.includes('christmas')))

  const calendar = getShenshenCalendarContext(Date.UTC(2026, 9, 31))
  const inWindow = resolveSemanticCatalogEntry('festival', {
    ...calendar,
    nowMs: Date.UTC(2026, 9, 31),
  }, { eventId: 'halloween' })
  assert.ok(inWindow.length > 0)
})

test('click pools gate the angry reaction by affection state', () => {
  const ordinary = resolveSemanticCatalogEntry('click', { nowMs: 0, affectionTier: 'friendly' })
  assert.equal(ordinary.some((entry) => entry.id === '点击回应-傲娇生气'), false)
  const angry = resolveSemanticCatalogEntry('click', { nowMs: 0, affectionTier: 'angry' })
  assert.equal(angry.some((entry) => entry.id === '点击回应-傲娇生气'), true)
})

test('PetAction headpat filters the angry response by affection, while angry action remains explicit', () => {
  const friendlyContext = { nowMs: 0, petAction: 'headpat' as const, affectionTier: 'friendly' as const }
  const friendlyCandidates = inspectShenshenCandidates('pet-action', friendlyContext)
  const angryHeadpat = friendlyCandidates.find((candidate) => candidate.id === '点击回应-傲娇生气')
  assert.deepEqual(angryHeadpat, {
    id: '点击回应-傲娇生气',
    eligible: false,
    reason: 'angry-reaction-requires-angry-context',
  })
  const friendlyRequest = createShenshenAnimationScheduler(() => 0).select(
    'pet-action', friendlyContext, '/assets/builtin/shenshen',
  )
  assert.ok(friendlyRequest)
  assert.notEqual(friendlyRequest.animationId, '点击回应-傲娇生气')

  const angryCandidates = inspectShenshenCandidates('pet-action', {
    ...friendlyContext,
    affectionTier: 'angry',
  })
  assert.equal(angryCandidates.find((candidate) => candidate.id === '点击回应-傲娇生气')?.eligible, true)
  const explicitAngryAction = inspectShenshenCandidates('pet-action', {
    nowMs: 0, petAction: 'angry', affectionTier: 'friendly',
  })
  assert.equal(explicitAngryAction.find((candidate) => candidate.id === '点击回应-傲娇生气')?.eligible, true)
})

test('quota bands, calendar windows, and all movement curves use catalog metadata', () => {
  assert.deepEqual(Array.from({ length: 6 }, (_, band) => getShenshenQuotaAnimationId(band)), [
    '余额-分文不剩', '余额-袋空如洗', '余额-数金皱眉', '余额-钱袋如常', '余额-金袋叮当', '余额-钱袋满溢',
  ])
  assert.equal(getShenshenQuotaBand(0), 0)
  assert.equal(getShenshenQuotaBand(5), 1)
  assert.equal(getShenshenQuotaBand(20), 2)
  assert.equal(getShenshenQuotaBand(40), 3)
  assert.equal(getShenshenQuotaBand(60), 4)
  assert.equal(getShenshenQuotaBand(80), 5)
  assert.equal(getShenshenQuotaBand(100), 5)
  assert.equal(getShenshenCalendarContext(Date.UTC(2026, 9, 25)).activeEvents?.includes('halloween'), true)
  assert.equal(getShenshenCalendarContext(Date.UTC(2026, 5, 1)).activeEvents?.includes('halloween'), false)

  const moves = catalog.animations.filter((entry) => entry.sourceCategory === 'move')
  assert.equal(moves.length, 3)
  assert.deepEqual(catalog.moveDefaults, {
    referenceWidth: 462, minDist: 60, maxDist: 240, margin: 20, leadSec: 2, tailSec: 2,
  })
  const moveById = new Map(moves.map((entry) => [entry.id, entry.move!]))
  assert.deepEqual(moveById.get('螃蟹走路'), { referenceWidth: 462, minDist: 60, maxDist: 240, margin: 20, leadSec: 2, tailSec: 2 })
  assert.deepEqual(moveById.get('原地漂浮踏步'), { referenceWidth: 462, minDist: 40, maxDist: 120, margin: 20, leadSec: 2, tailSec: 2 })
  assert.deepEqual(moveById.get('原地左转奔跑'), { referenceWidth: 462, minDist: 120, maxDist: 320, margin: 20, leadSec: 1.75, tailSec: 4.8 })
  for (const entry of moves) {
    const move = entry.move!
    const duration = move.leadSec + 4 + move.tailSec
    assert.equal(calculateShenshenMovementOffset(entry, move.leadSec, duration, move.referenceWidth, 1), 0)
    const midOffset = calculateShenshenMovementOffset(entry, move.leadSec + 2, duration, move.referenceWidth, 1)
    const fullOffset = calculateShenshenMovementOffset(entry, move.leadSec + 4, duration, move.referenceWidth, -1)
    assert.ok(Math.abs(midOffset - (move.minDist + move.maxDist) / 4) < 1e-9)
    assert.ok(Math.abs(fullOffset + (move.minDist + move.maxDist) / 2) < 1e-9)
  }
})

test('looped movement progress preserves its window offset and walk rotates one-shot segments', () => {
  const move = catalog.animations.find((entry) => entry.sourceCategory === 'move')!
  const width = 120
  const direction = -1
  const fraction = 0.5
  const atEnd = advanceShenshenMovementPlayback(null, 'walk:1', move, 8, 8, width, direction, fraction)
  assert.equal(atEnd.looped, false)
  const wrapped = advanceShenshenMovementPlayback(atEnd.state, 'walk:1', move, 0, 8, width, direction, fraction)
  assert.equal(wrapped.looped, true)
  assert.equal(wrapped.delta, 0)
  assert.equal(wrapped.state.absoluteOffset, atEnd.state.absoluteOffset)

  const scheduler = createShenshenAnimationScheduler(() => 0)
  const firstSegment = scheduler.select('pet-action', { nowMs: 0, petAction: 'walk' }, '/assets/builtin/shenshen')!
  const nextSegment = scheduler.select('pet-action', { nowMs: 1, petAction: 'walk' }, '/assets/builtin/shenshen')!
  assert.equal(firstSegment.entry.loop, true, 'the catalog keeps the source loop metadata')
  assert.equal(firstSegment.meta.loop, false, 'Pet Mode plays each movement clip once per segment')
  assert.equal(nextSegment.meta.loop, false)
  assert.notEqual(nextSegment.animationId, firstSegment.animationId, 'recent history rotates to another movement clip')
  assert.equal(getNextShenshenWalkDirection(-1, false), 1)
  assert.equal(getNextShenshenWalkDirection(1, false), -1)
  assert.equal(getNextShenshenWalkDirection(1, true), 1, 'walk-to-edge keeps its heading between segments')
})

test('quota band polling is quiet until a band changes and recovery uses the existing recovery event', () => {
  const tracker = createShenshenQuotaBandTracker()
  assert.equal(tracker.observe('codex', 1), null)
  assert.equal(tracker.observe('codex', 1), null)
  assert.deepEqual(tracker.observe('codex', 2), { intent: 'quota-band', band: 2 })
  assert.equal(tracker.observe('codex', 2), null)
  assert.deepEqual(tracker.observe('codex', 4, 5), { intent: 'quota-recovery', band: 5 })
  assert.equal(tracker.observe('codex', 4), null)
  assert.equal(tracker.observe('antigravity', 4), null, 'harness histories must be independent')
})

test('each Pet Mode action named by PR3 has a registered catalog pool', () => {
  const petActions = ['sleep', 'work', 'study', 'watch', 'music', 'walk', 'dance', 'eat', 'hungry', 'headpat', 'farewell', 'grasp', 'angry', 'spin', 'rest', 'peek', 'walkout']
  for (const petAction of petActions) {
    assert.ok(resolveSemanticCatalogEntry('pet-action', { nowMs: 0, petAction }).length > 0, `missing PetAction pool: ${petAction}`)
  }
})

test('every Agent lifecycle state has an explicitly mapped Shenshen animation pool', () => {
  const agentStates = ['working', 'compacting', 'waiting', 'review', 'success', 'failure']
  for (const agentState of agentStates) {
    const pool = resolveSemanticCatalogEntry('agent-state', { nowMs: 0, agentState })
    assert.ok(pool.length > 0, `missing Agent state pool: ${agentState}`)
    assert.ok(pool.every((entry) => entry.agentStates.includes(agentState)), `Agent state pool contains unrelated clips: ${agentState}`)
  }
})

test('lifecycle pools match reviewed work, compacting, waiting, review, success, and failure clips', () => {
  const expected = {
    working: [
      '工作状态-忙碌点按', '工作状态-思考冒泡', '写代码', '轻快记录',
      '深度思考碎碎念', '碎碎念-对屏碎碎念', '碎碎念-擦桌碎碎念',
    ],
    compacting: ['工作状态-清点归档', '轻快记录', '碎碎念-擦桌碎碎念'],
    waiting: ['工作状态-原地踱步张望', '东张西望', '碎碎念-发呆碎碎念'],
    review: ['工作状态-思考冒泡', '深度思考碎碎念', '碎碎念-对屏碎碎念'],
    success: ['工作状态-雀跃庆祝', '点击回应-元气挥手', '点击回应-开心跃动'],
    failure: ['工作状态-垂头叹气冒汗'],
  }
  for (const [agentState, expectedIds] of Object.entries(expected)) {
    const pool = resolveSemanticCatalogEntry('agent-state', { nowMs: 0, agentState })
    assert.deepEqual(pool.map((entry) => entry.id).sort(), [...expectedIds].sort(), agentState)
  }
  assert.equal(resolveSemanticCatalogEntry('agent-state', { nowMs: 0, agentState: 'failure' }).some((entry) => entry.id === '被吓一跳'), false)
})

test('real Coding Mode lifecycle signal priority remains review, waiting, compacting, working, idle', () => {
  const cases = [
    [{ review: false, waiting: false, compacting: false, working: false }, 'idle'],
    [{ review: false, waiting: false, compacting: false, working: true }, 'working'],
    [{ review: false, waiting: false, compacting: true, working: true }, 'compacting'],
    [{ review: false, waiting: true, compacting: true, working: true }, 'waiting'],
    [{ review: true, waiting: true, compacting: true, working: true }, 'review'],
  ] as const
  for (const [signals, expected] of cases) assert.equal(resolveShenshenLifecycleState(signals), expected)
})

test('success and failure are finite lifecycle reactions; persistent states keep their scheduler', () => {
  assert.equal(isShenshenTerminalReactionState('success'), true)
  assert.equal(isShenshenTerminalReactionState('failure'), true)
  for (const state of ['working', 'compacting', 'waiting', 'review']) {
    assert.equal(isShenshenTerminalReactionState(state), false)
  }
})

test('looped lifecycle fallback rotates only at a boundary after its dwell and rejects stale callbacks', () => {
  assert.equal(SHENSHEN_LOOP_ROTATION_DWELL_MS, 15_000)
  const scheduler = createShenshenAnimationScheduler(() => 0)
  let request = scheduler.select('agent-state', { nowMs: 0, agentState: 'working' }, '/assets/builtin/shenshen')!
  let playback = advanceShenshenLifecyclePlayback(null, request.id, 'working', 0, 0, true).state
  let rotations = 0
  for (let second = 1; second <= 30; second += 1) {
    const step = advanceShenshenLifecyclePlayback(
      playback, request.id, 'working', second % 10, second * 1000, true,
    )
    playback = step.state
    if (!step.shouldRotate) continue
    const previousId = request.id
    request = scheduler.select('agent-state', {
      nowMs: second * 1000,
      agentState: 'working',
    }, '/assets/builtin/shenshen')!
    playback = advanceShenshenLifecyclePlayback(null, request.id, 'working', 0, second * 1000, true).state
    rotations += 1
    assert.notEqual(request.id, previousId)
  }
  assert.ok(rotations >= 1, 'a sustained 30-second work state must rotate without another lifecycle event')
  assert.equal(isCurrentShenshenLifecycleRequest(request, 'stale-request', 'working'), false)
  assert.equal(isCurrentShenshenLifecycleRequest(request, request.id, 'waiting'), false)
  assert.equal(isCurrentShenshenLifecycleRequest(request, request.id, 'working'), true)
})

test('working clips play once and each completed clip is followed by a different one', () => {
  const scheduler = createShenshenAnimationScheduler(() => 0)
  let previousId: string | null = null
  for (let i = 0; i < 30; i += 1) {
    const request = scheduler.select('agent-state', {
      nowMs: i * 10_000, agentState: 'working',
    }, '/assets/builtin/shenshen')!
    assert.ok(request)
    assert.equal(request.meta.loop, false, 'even catalog loop clips should end after one play in lifecycle rotation')
    assert.notEqual(request.animationId, previousId)
    previousId = request.animationId
  }
})

test('one-shot lifecycle requests can replay after completion and interruption cannot advance them', () => {
  const scheduler = createShenshenAnimationScheduler(() => 0.8)
  const first = scheduler.select('agent-state', { nowMs: 1, agentState: 'working' }, '/assets/builtin/shenshen')!
  assert.equal(first.meta.loop, false)
  const second = scheduler.select('agent-state', { nowMs: 10_001, agentState: 'working' }, '/assets/builtin/shenshen')!
  assert.notEqual(second.id, first.id)
  assert.notEqual(second.animationId, first.animationId)

  const interrupted = advanceShenshenLifecyclePlayback(null, first.id, 'working', 0, 20_000, true).state
  const next = advanceShenshenLifecyclePlayback(interrupted, second.id, 'working', 0, 20_000, true)
  assert.equal(next.shouldRotate, false, 'a late progress event from an interrupted request starts a fresh playback record')

  scheduler.clear()
  const afterClear = scheduler.select('agent-state', {
    nowMs: 20_001, agentState: 'working',
  }, '/assets/builtin/shenshen')!
  assert.notEqual(afterClear.id, first.id, 'clearing history must not recycle request identities')
})

test('quota accents require fresh connected data, match its band, and occur at most once per work turn', () => {
  const nowMs = Date.UTC(2026, 8, 23, 12)
  const freshSummary = {
    harness: 'codex' as const,
    connected: true,
    primary: { label: 'primary', percent: 80 },
    details: [],
    updated_at: nowMs / 1000,
  }
  assert.equal(resolveFreshShenshenQuota([freshSummary], nowMs)?.band, 2)
  assert.equal(resolveFreshShenshenQuota([freshSummary], nowMs)?.expiresAtMs, nowMs + SHENSHEN_QUOTA_FRESHNESS_MS)
  assert.equal(resolveFreshShenshenQuota([
    { ...freshSummary, updated_at: (nowMs - SHENSHEN_QUOTA_FRESHNESS_MS - 1) / 1000 },
  ], nowMs), null)
  assert.equal(resolveFreshShenshenQuota([{ ...freshSummary, connected: false }], nowMs), null)
  assert.equal(resolveFreshShenshenQuota([{ ...freshSummary, primary: null }], nowMs), null)

  const scheduler = createShenshenAnimationScheduler(() => 0.999)
  const context = { nowMs, agentState: 'working', quotaBand: 2, quotaFresh: true, workTurnId: 7 }
  const accent = scheduler.select('agent-state', context, '/assets/builtin/shenshen')!
  assert.equal(accent.entry.quotaBand, 2)
  const next = scheduler.select('agent-state', { ...context, nowMs: nowMs + 1 }, '/assets/builtin/shenshen')!
  assert.equal(next.entry.quotaBand, null, 'a work turn must not repeat its quota accent')
  const stale = scheduler.select('agent-state', {
    ...context, nowMs: nowMs + 2, quotaFresh: false, workTurnId: 8,
  }, '/assets/builtin/shenshen')!
  assert.equal(stale.entry.quotaBand, null)
  const mismatched = scheduler.select('agent-state', {
    ...context, nowMs: nowMs + 3, quotaBand: 1, workTurnId: 9,
  }, '/assets/builtin/shenshen')!
  assert.equal(mismatched.entry.quotaBand, 1, 'the accent must match the supplied measured band exactly')
})

test('working lifecycle draws distribute attention across core and secondary clips', () => {
  let seed = 0x12345678
  const scheduler = createShenshenAnimationScheduler(() => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 0x1_0000_0000
  })
  let core = 0
  let secondary = 0
  for (let i = 0; i < 1_000; i += 1) {
    const request = scheduler.select('agent-state', { nowMs: i, agentState: 'working' }, '/assets/builtin/shenshen')!
    if (['工作状态-忙碌点按', '工作状态-思考冒泡'].includes(request.animationId)) core += 1
    else secondary += 1
  }
  const coreShare = core / (core + secondary)
  assert.ok(coreShare > 0.39 && coreShare < 0.50, `expected about 4:5 core-to-secondary draws, got ${coreShare.toFixed(3)}`)
})

test('Agent work interrupts ambient and drag remains the highest presentation state', () => {
  const scheduler = createShenshenAnimationScheduler(() => 0)
  const ambient = scheduler.select('ambient', {
    nowMs: 10, season: 'spring', visible: true, isFree: true, idleDurationMs: 600_000,
  }, '/assets/builtin/shenshen')!
  assert.equal(resolveVideoPetPresentationState({
    isDragging: false, movementState: null, reactionState: null, isJumping: false,
    lifecycleState: 'working', animationRequest: { id: ambient.id, priority: ambient.priority },
  }), 'working')

  const working = scheduler.select('agent-state', { nowMs: 20, agentState: 'working' }, '/assets/builtin/shenshen')!
  assert.equal(resolveVideoPetPresentationState({
    isDragging: false, movementState: null, reactionState: null, isJumping: false,
    lifecycleState: 'working', animationRequest: { id: working.id, priority: working.priority },
  }), `catalog:${working.id}`)
  assert.equal(resolveVideoPetPresentationState({
    isDragging: true, movementState: null, reactionState: null, isJumping: false,
    lifecycleState: 'working', animationRequest: { id: working.id, priority: working.priority },
  }), 'dragging')
})

test('forced catalog requests support visual QA without changing production eligibility', () => {
  const scheduler = createShenshenAnimationScheduler(() => 0)
  const hiddenContext = { nowMs: 10, visible: false, isFree: false, idleDurationMs: 0 }
  assert.equal(scheduler.select('ambient', hiddenContext, '/assets/builtin/shenshen'), null)
  assert.equal(scheduler.force('装点圣诞树', hiddenContext, '/assets/builtin/shenshen')?.animationId, '装点圣诞树')
  assert.equal(scheduler.select('ambient', hiddenContext, '/assets/builtin/shenshen'), null)
})

test('pointer classification suppresses left and right click actions after a drag', () => {
  assert.equal(classifyMascotPointerOutcome({ button: 0, wasDragging: false }), 'left-click')
  assert.equal(classifyMascotPointerOutcome({ button: 2, wasDragging: false }), 'right-click')
  assert.equal(classifyMascotPointerOutcome({ button: 0, wasDragging: true }), 'drag')
})
