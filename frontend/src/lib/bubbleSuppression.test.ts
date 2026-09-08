import test from 'node:test'
import assert from 'node:assert/strict'
import {
  type BubbleLifecycleState,
  handlePresentationSuppressionChange,
  handleBubbleReadyWhileSuppressed,
  handleNativeShowResult,
  commitBubbleNativeShow,
  handleBubbleVisible,
} from './bubbleSuppression.ts'
import { isSameBubblePayload } from './sessionActivity.ts'
import type { MascotBubblePayload, BubbleSessionDetail } from './types.ts'

test('tray Hide preserves every logical phase and payload; Show uses current lifecycle', () => {
  for (const phase of ['hidden', 'prepared', 'entering', 'visible', 'exiting'] as const) {
    const state = {
      desiredVisible: phase !== 'hidden' && phase !== 'exiting', phase,
      nativeVisible: true, transitionId: 90, presentationSuppressed: false,
      payload: { sessionId: 'same-session', turnId: 'turn-1' },
    }
    const before = { ...state }
    handlePresentationSuppressionChange(state, true)
    assert.equal(state.phase, before.phase)
    assert.equal(state.desiredVisible, before.desiredVisible)
    assert.equal(state.transitionId, before.transitionId)
    assert.equal(state.payload, before.payload)
    assert.equal(handleBubbleReadyWhileSuppressed(state, 90).canShowNative, false)
    assert.equal(handleNativeShowResult(state, 'shown'), false, 'Late show cannot override Hide')
    const restore = handlePresentationSuppressionChange(state, false)
    assert.equal(restore.shouldShowNative, before.desiredVisible)
    assert.equal(restore.shouldEmitEnter, phase === 'prepared')
  }
})

test('tray Show and delayed ready may both finish IPC, but entry is committed exactly once', () => {
  const state: BubbleLifecycleState = {
    desiredVisible: true, phase: 'prepared', nativeVisible: false,
    transitionId: 100, presentationSuppressed: true,
  }
  handlePresentationSuppressionChange(state, false)
  assert.equal(state.phase, 'prepared')
  assert.equal(commitBubbleNativeShow(state, 100, 'suppressed').shouldEmitEnter, false)
  assert.equal(state.phase, 'prepared', 'Failed show must not consume entry')
  assert.equal(commitBubbleNativeShow(state, 100, 'shown').shouldEmitEnter, true)
  assert.equal(commitBubbleNativeShow(state, 100, 'shown').shouldEmitEnter, false)
})

test('completion or a new turn during restore IPC invalidates the old show acknowledgement', () => {
  const state: BubbleLifecycleState = {
    desiredVisible: true, phase: 'visible', nativeVisible: false,
    transitionId: 110, presentationSuppressed: true,
  }
  handlePresentationSuppressionChange(state, false)
  state.desiredVisible = false
  state.phase = 'exiting'
  assert.equal(commitBubbleNativeShow(state, 110, 'shown').shouldEmitEnter, false)
  assert.equal(state.nativeVisible, false)
  state.transitionId = 111
  state.desiredVisible = true
  state.phase = 'prepared'
  assert.equal(commitBubbleNativeShow(state, 110, 'shown').applied, false)
  assert.equal(state.phase, 'prepared')
  handlePresentationSuppressionChange(state, true)
  assert.equal(commitBubbleNativeShow(state, 111, 'shown').shouldEmitEnter, false)
  handlePresentationSuppressionChange(state, false)
  assert.equal(commitBubbleNativeShow(state, 111, 'shown').shouldEmitEnter, true)
})

test('1. Core reproduction: visible bubble stays visible on fullscreen exit without re-entering', () => {
  const state: BubbleLifecycleState = {
    desiredVisible: true,
    phase: 'visible',
    nativeVisible: true,
    transitionId: 1,
    presentationSuppressed: false,
  }

  // Step 1: Windows watcher detects fullscreen and suppresses presentation
  const supResult = handlePresentationSuppressionChange(state, true)
  assert.equal(supResult.action, 'suppressed')
  assert.equal(supResult.shouldShowNative, false)
  assert.equal(supResult.shouldEmitEnter, false)
  assert.equal(state.presentationSuppressed, true)
  assert.equal(state.nativeVisible, false)
  // Logical state preserved!
  assert.equal(state.desiredVisible, true)
  assert.equal(state.phase, 'visible')
  assert.equal(state.transitionId, 1)
  assert.ok(supResult.logMessage.includes('[bubble-native] presentation suppressed=true phase=visible desired=true native=false'))

  // Step 2: Poll during suppression with completely unchanged payload
  const payload1: MascotBubblePayload = {
    style: 'compact',
    running: 1,
    waiting: 0,
    activeSession: null,
    activeSessions: [],
  }
  const payload2: MascotBubblePayload = {
    style: 'compact',
    running: 1,
    waiting: 0,
    activeSession: null,
    activeSessions: [],
  }
  const isDuplicate = isSameBubblePayload(payload1, payload2)
  assert.ok(isDuplicate, 'Duplicate payload is correctly detected and suppressed during polling')

  // Step 3: Presentation exit lifts suppression
  const exitResult = handlePresentationSuppressionChange(state, false)
  assert.equal(exitResult.action, 'restore')
  assert.equal(exitResult.shouldShowNative, true)
  assert.equal(exitResult.shouldEmitEnter, false, 'Must NOT re-play global enter animation')
  assert.equal(state.presentationSuppressed, false)
  assert.equal(state.phase, 'visible', 'Logical phase remains visible')
  assert.ok(exitResult.logMessage.includes('[bubble-native] presentation suppressed=false phase=visible desired=true action=restore'))

  // Step 4: Native window is shown
  const shown = handleNativeShowResult(state, 'shown')
  assert.ok(shown)
  assert.equal(state.nativeVisible, true)
  assert.equal(state.phase, 'visible')
})

test('2. Payload updates while suppressed: displays latest payload without replaying entry', () => {
  const state: BubbleLifecycleState = {
    desiredVisible: true,
    phase: 'visible',
    nativeVisible: true,
    transitionId: 10,
    presentationSuppressed: false,
  }

  // Suppressed
  handlePresentationSuppressionChange(state, true)
  assert.equal(state.presentationSuppressed, true)

  // During suppression, session activity updates
  const session1: BubbleSessionDetail = {
    sessionId: 'sess-1',
    title: 'Code Refactor',
    status: 'tool_running',
    activity: { kind: 'read', target: 'lib.rs', status: 'running', source: 'tool-call' },
  }
  const session2: BubbleSessionDetail = {
    sessionId: 'sess-1',
    title: 'Code Refactor',
    status: 'tool_running',
    activity: { kind: 'command', status: 'running', source: 'tool-call' },
  }
  const p1: MascotBubblePayload = { style: 'detailed', running: 1, waiting: 0, activeSession: session1, activeSessions: [session1] }
  const p2: MascotBubblePayload = { style: 'detailed', running: 1, waiting: 0, activeSession: session2, activeSessions: [session2] }
  assert.ok(!isSameBubblePayload(p1, p2), 'Payload change is detected so summary is emitted to bubble')

  // Presentation exit lifts suppression
  const exitResult = handlePresentationSuppressionChange(state, false)
  assert.equal(exitResult.action, 'restore')
  assert.equal(exitResult.shouldShowNative, true)
  assert.equal(exitResult.shouldEmitEnter, false, 'No fly-in replay')

  handleNativeShowResult(state, 'shown')
  assert.equal(state.nativeVisible, true)
  assert.equal(state.phase, 'visible')
})

test('3. Session finishes while suppressed: bubble stays hidden upon fullscreen exit', () => {
  const state: BubbleLifecycleState = {
    desiredVisible: true,
    phase: 'visible',
    nativeVisible: true,
    transitionId: 20,
    presentationSuppressed: false,
  }

  // Presentation suppression starts
  handlePresentationSuppressionChange(state, true)

  // Session finishes during suppression: running/waiting = 0 -> desiredVisible becomes false
  state.desiredVisible = false
  state.phase = 'hidden'

  // Presentation exits
  const exitResult = handlePresentationSuppressionChange(state, false)
  assert.equal(exitResult.action, 'stay_hidden')
  assert.equal(exitResult.shouldShowNative, false)
  assert.equal(exitResult.shouldEmitEnter, false)
  assert.equal(state.nativeVisible, false)
  assert.ok(exitResult.logMessage.includes('action=stay_hidden'))
})

test('4. Panel expands while suppressed: bubble stays hidden upon fullscreen exit', () => {
  const state: BubbleLifecycleState = {
    desiredVisible: true,
    phase: 'visible',
    nativeVisible: true,
    transitionId: 30,
    presentationSuppressed: false,
  }

  // Presentation suppression starts
  handlePresentationSuppressionChange(state, true)

  // Panel expands while suppressed
  state.desiredVisible = false
  state.phase = 'hidden'

  // Presentation exits
  const exitResult = handlePresentationSuppressionChange(state, false)
  assert.equal(exitResult.action, 'stay_hidden')
  assert.equal(exitResult.shouldShowNative, false)
  assert.equal(exitResult.shouldEmitEnter, false)
})

test('5. Prepared race: ready event received while suppressed does not prematurely show or enter', () => {
  const state: BubbleLifecycleState = {
    desiredVisible: true,
    phase: 'prepared',
    nativeVisible: false,
    transitionId: 40,
    presentationSuppressed: false,
  }

  // Presentation suppression hits right after prepare
  handlePresentationSuppressionChange(state, true)
  assert.equal(state.presentationSuppressed, true)

  // mascot-bubble-ready arrives while suppressed
  const readyCheck = handleBubbleReadyWhileSuppressed(state, 40)
  assert.equal(readyCheck.canShowNative, false)
  assert.equal(readyCheck.reason, 'suppressed')
  assert.equal(state.nativeVisible, false)
  assert.equal(state.phase, 'prepared')

  // Presentation exits
  const exitResult = handlePresentationSuppressionChange(state, false)
  assert.equal(exitResult.action, 'restore')
  assert.equal(exitResult.shouldShowNative, true)
  assert.equal(exitResult.shouldEmitEnter, true, 'Prepared bubble should emit enter once native window is shown')
  assert.equal(exitResult.newPhase, 'entering')
  assert.equal(state.phase, 'prepared', 'Restoration must wait for successful native show')

  // Native show succeeds
  assert.equal(commitBubbleNativeShow(state, state.transitionId, 'shown').shouldEmitEnter, true)
  assert.equal(state.phase, 'entering')
  assert.equal(state.nativeVisible, true)

  // Animation settles in MascotBubble
  const settled = handleBubbleVisible(state, 40)
  assert.ok(settled)
  assert.equal(state.phase, 'visible')
})

test('6. Entering race: suppression during entering settles cleanly without double entry', () => {
  const state: BubbleLifecycleState = {
    desiredVisible: true,
    phase: 'entering',
    nativeVisible: true,
    transitionId: 50,
    presentationSuppressed: false,
  }

  // Presentation suppression starts while entering animation was in progress
  handlePresentationSuppressionChange(state, true)
  assert.equal(state.presentationSuppressed, true)
  assert.equal(state.nativeVisible, false)
  assert.equal(state.phase, 'entering')

  // Case A: Animation settles while window was hidden
  handleBubbleVisible(state, 50)
  assert.equal(state.phase, 'visible')

  // Presentation exits
  const exitResult = handlePresentationSuppressionChange(state, false)
  assert.equal(exitResult.action, 'restore')
  assert.equal(exitResult.shouldShowNative, true)
  assert.equal(exitResult.shouldEmitEnter, false, 'No repeated global-entry')
  assert.equal(state.phase, 'visible')

  // Case B: What if animation settles after restore?
  const stateB: BubbleLifecycleState = {
    desiredVisible: true,
    phase: 'entering',
    nativeVisible: true,
    transitionId: 51,
    presentationSuppressed: false,
  }
  handlePresentationSuppressionChange(stateB, true)
  const exitResultB = handlePresentationSuppressionChange(stateB, false)
  assert.equal(exitResultB.action, 'restore')
  assert.equal(exitResultB.shouldShowNative, true)
  assert.equal(exitResultB.shouldEmitEnter, false)
  // Settles after native restore
  handleBubbleVisible(stateB, 51)
  assert.equal(stateB.phase, 'visible')
})

test('7. New turn while suppressed: preserves seenTurnKeys membership behavior', () => {
  // Simulating MascotBubble seenTurnKeysRef
  const seenTurnKeys = new Set<string>()
  const knownSessionIds = new Set<string>()

  // Session A Turn 1 arrives before suppression
  const turn1Key = 'session-A:turn-1'
  knownSessionIds.add('session-A')
  seenTurnKeys.add(turn1Key)

  // Presentation suppression starts
  const state: BubbleLifecycleState = {
    desiredVisible: true,
    phase: 'visible',
    nativeVisible: false,
    transitionId: 60,
    presentationSuppressed: true,
  }

  // While suppressed, Session A updates to Turn 2
  const turn2Key = 'session-A:turn-2'
  assert.ok(knownSessionIds.has('session-A'), 'Session A is already a known session in bubble')
  // Because session-A is already known, it does NOT get categorized as an incremental entry
  seenTurnKeys.add(turn2Key)
  assert.ok(seenTurnKeys.has(turn2Key))

  // Presentation exit lifts suppression
  const exitResult = handlePresentationSuppressionChange(state, false)
  assert.equal(exitResult.action, 'restore')
  assert.equal(exitResult.shouldShowNative, true)
  assert.equal(exitResult.shouldEmitEnter, false, 'Presentation restore is not misclassified as incremental entry')
  assert.equal(state.phase, 'visible')
})

test('handleNativeShowResult handles shown, suppressed, hidden, and error cleanly', () => {
  const state: BubbleLifecycleState = {
    desiredVisible: true,
    phase: 'visible',
    nativeVisible: false,
    transitionId: 70,
    presentationSuppressed: false,
  }

  assert.ok(handleNativeShowResult(state, 'shown'))
  assert.equal(state.nativeVisible, true)

  assert.ok(!handleNativeShowResult(state, 'suppressed'))
  assert.equal(state.nativeVisible, false)

  assert.ok(!handleNativeShowResult(state, 'hidden'))
  assert.equal(state.nativeVisible, false)

  assert.ok(!handleNativeShowResult(state, 'error'))
  assert.equal(state.nativeVisible, false)
})
