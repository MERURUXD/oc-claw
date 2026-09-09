import test from 'node:test'
import assert from 'node:assert/strict'
import {
  beginPanelUiTransition,
  capturePanelUiGeneration,
  createPanelUiTransition,
  isPanelUiGenerationCurrent,
  resolvePanelDismissAction,
  shouldAdmitPanelCollapse,
  type PanelDismissSnapshot,
} from './panelUiTransition.ts'

function snap(partial: Partial<PanelDismissSnapshot> = {}): PanelDismissSnapshot {
  return {
    pinned: false,
    settingsMode: false,
    settingsTransitioning: false,
    collapsing: false,
    updateModalOpen: false,
    createModalOpen: false,
    filePickerOpen: false,
    settingsPickerBlocking: false,
    ...partial,
  }
}

test('generation: enterSettings after collapse invalidates stale collapse ticket', () => {
  let s = createPanelUiTransition()
  s = beginPanelUiTransition(s, 'collapse')
  const collapseGen = capturePanelUiGeneration(s)
  assert.equal(collapseGen, 1)
  assert.equal(isPanelUiGenerationCurrent(s, collapseGen), true)

  // Gear clicked while collapse timeout is pending
  s = beginPanelUiTransition(s, 'enterSettings')
  assert.equal(s.generation, 2)
  assert.equal(s.owner, 'enterSettings')
  assert.equal(isPanelUiGenerationCurrent(s, collapseGen), false)
  assert.equal(isPanelUiGenerationCurrent(s, 2), true)
})

test('generation: exitSettings invalidates prior enterSettings work', () => {
  let s = createPanelUiTransition()
  s = beginPanelUiTransition(s, 'enterSettings')
  const enterGen = capturePanelUiGeneration(s)
  s = beginPanelUiTransition(s, 'exitSettings')
  assert.equal(isPanelUiGenerationCurrent(s, enterGen), false)
  assert.equal(s.owner, 'exitSettings')
})

test('logical sequence: expanded → settings-entering → open → exit → collapsed; stale dismiss ignored', () => {
  let s = createPanelUiTransition()

  // expanded panel: outside-click would collapse
  assert.equal(resolvePanelDismissAction(snap()), 'collapse')

  // settings-entering
  s = beginPanelUiTransition(s, 'enterSettings')
  const enterGen = capturePanelUiGeneration(s)
  assert.equal(
    resolvePanelDismissAction(snap({ settingsTransitioning: true })),
    'ignore',
  )
  // stale collapse from before enter must not apply
  const staleCollapseGen = enterGen - 1
  assert.equal(isPanelUiGenerationCurrent(s, staleCollapseGen), false)

  // settings-open
  assert.equal(resolvePanelDismissAction(snap({ settingsMode: true })), 'ignore')
  assert.equal(
    resolvePanelDismissAction(snap({ settingsMode: true }), { allowExitSettings: true }),
    'exitSettings',
  )
  // blur / outside / hover while pinned+settings: blur may exit
  assert.equal(
    resolvePanelDismissAction(snap({ settingsMode: true, pinned: true }), { allowExitSettings: true }),
    'exitSettings',
  )

  // settings-exit
  s = beginPanelUiTransition(s, 'exitSettings')
  assert.equal(
    resolvePanelDismissAction(snap({ settingsTransitioning: true })),
    'ignore',
  )

  // collapsed / collapsing cooldown
  s = beginPanelUiTransition(s, 'collapse')
  assert.equal(resolvePanelDismissAction(snap({ collapsing: true })), 'ignore')
  assert.equal(shouldAdmitPanelCollapse(snap({ collapsing: true })), false)
})

test('dismiss admission: file picker / settings picker / create modal / update modal block', () => {
  assert.equal(resolvePanelDismissAction(snap({ filePickerOpen: true })), 'ignore')
  assert.equal(resolvePanelDismissAction(snap({ settingsPickerBlocking: true })), 'ignore')
  assert.equal(resolvePanelDismissAction(snap({ createModalOpen: true })), 'ignore')
  assert.equal(resolvePanelDismissAction(snap({ updateModalOpen: true })), 'ignore')
  assert.equal(resolvePanelDismissAction(snap({ pinned: true })), 'ignore')
  assert.equal(shouldAdmitPanelCollapse(snap()), true)
})

test('stale collapse must not apply after newer enterSettings gen (ownership contract)', () => {
  // Simulates collapse timeout checking gen before setExpanded(false) / set_mini_*
  let s = createPanelUiTransition()
  s = beginPanelUiTransition(s, 'collapse')
  const collapseTicket = capturePanelUiGeneration(s)

  const applyCollapseTail = (state: typeof s, ticket: number) => {
    if (!isPanelUiGenerationCurrent(state, ticket)) {
      return { applied: false as const, clearedSettings: false, setExpandedFalse: false, nativeRewrite: false }
    }
    return { applied: true as const, clearedSettings: true, setExpandedFalse: true, nativeRewrite: true }
  }

  // Before enterSettings, collapse would apply
  assert.deepEqual(applyCollapseTail(s, collapseTicket), {
    applied: true,
    clearedSettings: true,
    setExpandedFalse: true,
    nativeRewrite: true,
  })

  // enterSettings wins
  s = beginPanelUiTransition(s, 'enterSettings')
  assert.deepEqual(applyCollapseTail(s, collapseTicket), {
    applied: false,
    clearedSettings: false,
    setExpandedFalse: false,
    nativeRewrite: false,
  })
})
