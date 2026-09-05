import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeActivitySummary,
  extractBasename,
  normalizeToolName,
  deriveSessionActivity,
  isSameActivity,
  isSameSessionDetail,
  isSameBubblePayload,
  isSamePendingInteraction,
} from './sessionActivity.ts'
import { formatActivity } from './activityFormat.ts'
import type { BubbleSessionDetail, MascotBubblePayload, PendingInteraction, SessionActivity } from './types.ts'

test('normalizeActivitySummary handles headings, bullets, code, and emphasis', () => {
  assert.equal(
    normalizeActivitySummary('### Investigating the authentication flow'),
    'Investigating the authentication flow'
  )
  assert.equal(
    normalizeActivitySummary('- Running lint checks'),
    'Running lint checks'
  )
  assert.equal(
    normalizeActivitySummary('1. Building release binary'),
    'Building release binary'
  )
  assert.equal(
    normalizeActivitySummary('`cargo check --workspace`'),
    'cargo check --workspace'
  )
  assert.equal(
    normalizeActivitySummary('**Checking system status**'),
    'Checking system status'
  )
  assert.equal(
    normalizeActivitySummary('*Refactoring backend logic*'),
    'Refactoring backend logic'
  )
  assert.equal(
    normalizeActivitySummary('__Analyzing project configuration__'),
    'Analyzing project configuration'
  )
  assert.equal(
    normalizeActivitySummary('   \n\n  ### **Exploring socket server**  \n '),
    'Exploring socket server'
  )
  assert.equal(normalizeActivitySummary(''), null)
  assert.equal(normalizeActivitySummary('   \n  '), null)
  assert.equal(normalizeActivitySummary(undefined), null)
  assert.equal(normalizeActivitySummary(null), null)
})

test('normalizeActivitySummary truncates to 180 characters gracefully', () => {
  const longText = 'A'.repeat(250)
  const result = normalizeActivitySummary(longText)
  assert.ok(result)
  assert.equal(result.length, 180)
})

test('extractBasename correctly extracts filename across platforms and quoting', () => {
  assert.equal(extractBasename('/path/to/src/main.rs'), 'main.rs')
  assert.equal(extractBasename('C:\\Users\\dev\\project\\src\\lib.rs'), 'lib.rs')
  assert.equal(extractBasename('"C:\\Users\\dev\\project\\README.md"'), 'README.md')
  assert.equal(extractBasename('\'frontend/src/Mini.tsx\''), 'Mini.tsx')
  assert.equal(extractBasename(''), '')
  assert.equal(extractBasename(null), '')
})

test('normalizeToolName strips MCP prefix and transforms hyphens/underscores', () => {
  assert.equal(normalizeToolName('mcp__github__create_pull_request'), 'create pull request')
  assert.equal(normalizeToolName('mcp__sqlite__execute_query'), 'execute query')
  assert.equal(normalizeToolName('run_command'), 'run command')
  assert.equal(normalizeToolName('replace-file-content'), 'replace file content')
  assert.equal(normalizeToolName(null), 'tool')
})

test('deriveSessionActivity maps tool inputs into typed SessionActivity', () => {
  const readAct = deriveSessionActivity({
    tool: 'view_file',
    toolInput: JSON.stringify({ AbsolutePath: 'frontend/src/Mini.tsx' }),
    status: 'tool_running',
  })
  assert.deepEqual(readAct, {
    kind: 'read',
    target: 'Mini.tsx',
    status: 'running',
    source: 'tool-call',
  })

  const searchAct = deriveSessionActivity({
    tool: 'grep_search',
    toolInput: JSON.stringify({ Query: 'isSameBubblePayload' }),
    status: 'tool_running',
  })
  assert.deepEqual(searchAct, {
    kind: 'search',
    query: 'isSameBubblePayload',
    status: 'running',
    source: 'tool-call',
  })

  const editAct = deriveSessionActivity({
    tool: 'replace_file_content',
    toolInput: JSON.stringify({ TargetFile: 'frontend/src-tauri/src/lib.rs' }),
    status: 'tool_running',
  })
  assert.deepEqual(editAct, {
    kind: 'edit',
    target: 'lib.rs',
    count: undefined,
    status: 'running',
    source: 'tool-call',
  })

  const cmdAct = deriveSessionActivity({
    tool: 'run_command',
    toolInput: JSON.stringify({ CommandLine: 'rm -rf /' }),
    status: 'tool_running',
  })
  assert.deepEqual(cmdAct, {
    kind: 'command',
    status: 'running',
    source: 'tool-call',
  })

  const subagentAct = deriveSessionActivity({
    tool: 'invoke_subagent',
    toolInput: JSON.stringify({ role: 'Backend Engineer' }),
    status: 'tool_running',
  })
  assert.deepEqual(subagentAct, {
    kind: 'subagent',
    status: 'running',
    source: 'tool-call',
  })

  const webAct = deriveSessionActivity({
    tool: 'search_web',
    toolInput: JSON.stringify({ query: 'Rust Connect-RPC' }),
    status: 'tool_running',
  })
  assert.deepEqual(webAct, {
    kind: 'web',
    query: 'Rust Connect-RPC',
    status: 'running',
    source: 'tool-call',
  })

  const unknownAct = deriveSessionActivity({
    tool: 'mcp__custom__my_custom_action',
    status: 'tool_running',
  })
  assert.deepEqual(unknownAct, {
    kind: 'tool',
    toolName: 'my custom action',
    status: 'running',
    source: 'tool-call',
  })
})

test('formatActivity provides formatted strings with mock t function', () => {
  const mockT = ((key: string, options?: unknown) => {
    if (typeof options === 'object' && options !== null && 'defaultValue' in options) {
      return String((options as { defaultValue: unknown }).defaultValue)
    }
    return key
  }) as unknown as Parameters<typeof formatActivity>[1]

  assert.equal(
    formatActivity(
      { kind: 'reasoning', summary: 'Searching codebase for references', status: 'running', source: 'reasoning-summary' },
      mockT
    ),
    'Searching codebase for references'
  )

  assert.equal(
    formatActivity({ kind: 'read', target: 'Mini.tsx', status: 'running', source: 'tool-call' }, mockT),
    'Reading Mini.tsx'
  )
  assert.equal(
    formatActivity({ kind: 'read', target: 'Mini.tsx', status: 'completed', source: 'tool-call' }, mockT),
    'Read Mini.tsx'
  )

  assert.equal(
    formatActivity({ kind: 'search', query: 'QuotaSideRail', status: 'running', source: 'tool-call' }, mockT),
    'Searching "QuotaSideRail"'
  )
  assert.equal(
    formatActivity({ kind: 'search', query: 'QuotaSideRail', status: 'completed', source: 'tool-call' }, mockT),
    'Searched "QuotaSideRail"'
  )

  assert.equal(
    formatActivity({ kind: 'command', status: 'running', source: 'tool-call' }, mockT),
    'Running command'
  )
  assert.equal(
    formatActivity({ kind: 'command', status: 'completed', source: 'tool-call' }, mockT),
    'Ran command'
  )

  assert.equal(
    formatActivity({ kind: 'edit', target: 'lib.rs', status: 'running', source: 'tool-call' }, mockT),
    'Editing lib.rs'
  )
  assert.equal(
    formatActivity({ kind: 'edit', count: 3, status: 'completed', source: 'tool-call' }, mockT),
    'Edited 3 files'
  )

  assert.equal(
    formatActivity({ kind: 'subagent', status: 'running', source: 'tool-call' }, mockT),
    'Delegating task'
  )
})

test('isSameActivity and isSameBubblePayload accurately detect equality and diffs', () => {
  const a1: SessionActivity = {
    kind: 'read',
    target: 'Mini.tsx',
    status: 'running',
    source: 'tool-call',
  }
  const a2: SessionActivity = {
    kind: 'read',
    target: 'Mini.tsx',
    status: 'running',
    source: 'tool-call',
  }
  const a3: SessionActivity = {
    kind: 'read',
    target: 'Mini.tsx',
    status: 'completed',
    source: 'tool-call',
  }

  assert.ok(isSameActivity(a1, a2))
  assert.ok(!isSameActivity(a1, a3))
  assert.ok(isSameActivity(null, undefined))

  const s1: BubbleSessionDetail = {
    sessionId: 'sess-1',
    title: 'Work on Task',
    source: 'codex',
    status: 'processing',
    activity: a1,
  }
  const s2: BubbleSessionDetail = {
    sessionId: 'sess-1',
    title: 'Work on Task',
    source: 'codex',
    status: 'processing',
    activity: a2,
  }
  const s3: BubbleSessionDetail = {
    sessionId: 'sess-1',
    title: 'Work on Task',
    source: 'codex',
    status: 'processing',
    activity: a3,
  }

  assert.ok(isSameSessionDetail(s1, s2))
  assert.ok(!isSameSessionDetail(s1, s3))

  const p1: MascotBubblePayload = {
    style: 'detailed',
    running: 1,
    waiting: 0,
    activeSession: s1,
    activeSessions: [s1],
  }
  const p2: MascotBubblePayload = {
    style: 'detailed',
    running: 1,
    waiting: 0,
    activeSession: s2,
    activeSessions: [s2],
  }
  const p3: MascotBubblePayload = {
    style: 'detailed',
    running: 1,
    waiting: 0,
    activeSession: s3,
    activeSessions: [s3],
  }

  assert.ok(isSameBubblePayload(p1, p2))
  assert.ok(!isSameBubblePayload(p1, p3))
})

test('normalizeActivitySummary cleans multi-nested markdown wrappers', () => {
  assert.equal(normalizeActivitySummary('### **Exploring socket server**'), 'Exploring socket server')
  assert.equal(normalizeActivitySummary('**`Testing code quote`**'), 'Testing code quote')
  assert.equal(normalizeActivitySummary('`**Bold inside code**`'), 'Bold inside code')
  assert.equal(normalizeActivitySummary('***Bold and italic***'), 'Bold and italic')
  assert.equal(normalizeActivitySummary('__*Underline italic*__'), 'Underline italic')
  assert.equal(normalizeActivitySummary('• `Checking bullet point`'), 'Checking bullet point')
  assert.equal(normalizeActivitySummary('****'), null)
  assert.equal(normalizeActivitySummary('``` ```'), null)
})

test('deriveSessionActivity guards against stale tool when status is processing', () => {
  const staleAct = deriveSessionActivity({
    tool: 'view_file',
    toolInput: JSON.stringify({ AbsolutePath: 'frontend/src/Mini.tsx' }),
    status: 'processing',
  })
  assert.equal(staleAct, undefined)

  const activeAct = deriveSessionActivity({
    tool: 'view_file',
    toolInput: JSON.stringify({ AbsolutePath: 'frontend/src/Mini.tsx' }),
    status: 'tool_running',
  })
  assert.ok(activeAct)
  assert.equal(activeAct.kind, 'read')
  assert.equal(activeAct.target, 'Mini.tsx')
})

test('UI priority ladder maintains waiting > subagents > activity > thinkingPool', () => {
  // Priority 1: Waiting
  const waitingSession: BubbleSessionDetail = {
    sessionId: 'sess-wait',
    title: 'Task',
    status: 'waiting',
    questionText: 'Do you want to proceed?',
    activity: { kind: 'command', status: 'running', source: 'tool-call' },
  }
  assert.equal(waitingSession.status, 'waiting')
  assert.ok(waitingSession.questionText)

  // Priority 2: Subagents
  const subagentSession: BubbleSessionDetail = {
    sessionId: 'sess-sub',
    title: 'Task',
    status: 'processing',
    activeSubagents: [{ id: 'sub-1', role: 'Architect', status: 'processing' }],
    activity: { kind: 'command', status: 'running', source: 'tool-call' },
  }
  assert.ok(subagentSession.activeSubagents && subagentSession.activeSubagents.length > 0)

  // Priority 3: Activity
  const activitySession: BubbleSessionDetail = {
    sessionId: 'sess-act',
    title: 'Task',
    status: 'processing',
    activity: { kind: 'reasoning', summary: 'Analyzing bubble logic', status: 'running', source: 'reasoning-summary' },
  }
  assert.ok(activitySession.activity)

  // Priority 4: Fallback thinkingPool (when activity is undefined)
  const fallbackSession: BubbleSessionDetail = {
    sessionId: 'sess-fb',
    title: 'Task',
    status: 'processing',
  }
  assert.equal(fallbackSession.activity, undefined)
})

test('isSamePendingInteraction verifies structural equality and detects mutations', () => {
  assert.ok(isSamePendingInteraction(undefined, undefined))
  assert.ok(isSamePendingInteraction(null, null))
  assert.ok(isSamePendingInteraction(undefined, null))
  assert.ok(isSamePendingInteraction(null, undefined))
  assert.ok(!isSamePendingInteraction({ kind: 'approval' }, undefined))
  assert.ok(!isSamePendingInteraction(undefined, { kind: 'approval' }))

  const baseApproval: PendingInteraction = {
    kind: 'approval',
    interactionType: 'command',
    turnId: 'turn-1',
    itemId: 'item-1',
    callId: 'call-1',
    tool: 'exec_command',
    summary: 'exec cargo build',
    detail: 'cargo build --workspace',
    justification: 'Compile verification needed',
  }

  const identicalApproval: PendingInteraction = { ...baseApproval }
  assert.ok(isSamePendingInteraction(baseApproval, identicalApproval))

  // Kind mismatch
  assert.ok(!isSamePendingInteraction(baseApproval, { ...baseApproval, kind: 'user_input' }))
  // Tool mismatch
  assert.ok(!isSamePendingInteraction(baseApproval, { ...baseApproval, tool: 'other_tool' }))
  // Summary mismatch
  assert.ok(!isSamePendingInteraction(baseApproval, { ...baseApproval, summary: 'exec cargo test' }))
  // Detail mismatch
  assert.ok(!isSamePendingInteraction(baseApproval, { ...baseApproval, detail: 'different command' }))
  // Justification mismatch
  assert.ok(!isSamePendingInteraction(baseApproval, { ...baseApproval, justification: undefined }))
  // TurnId mismatch
  assert.ok(!isSamePendingInteraction(baseApproval, { ...baseApproval, turnId: 'turn-2' }))
  // ItemId mismatch
  assert.ok(!isSamePendingInteraction(baseApproval, { ...baseApproval, itemId: 'item-2' }))
  // CallId mismatch
  assert.ok(!isSamePendingInteraction(baseApproval, { ...baseApproval, callId: 'call-2' }))
  // RequestId mismatch
  assert.ok(!isSamePendingInteraction(baseApproval, { ...baseApproval, requestId: 'req-1' }))
  // ApprovalActions mismatch
  assert.ok(!isSamePendingInteraction(baseApproval, { ...baseApproval, approvalActions: { canDeny: true, canAllowTurn: true, canAllowSession: false } }))
  assert.ok(isSamePendingInteraction(
    { ...baseApproval, requestId: 'req-1', approvalActions: { canDeny: true, canAllowTurn: true, canAllowSession: false } },
    { ...baseApproval, requestId: 'req-1', approvalActions: { canDeny: true, canAllowTurn: true, canAllowSession: false } }
  ))
})

test('isSameSessionDetail and isSameBubblePayload detect pendingInteraction updates', () => {
  const approvalInter: PendingInteraction = {
    kind: 'approval',
    interactionType: 'command',
    summary: 'exec cargo check',
    detail: 'cargo check',
    justification: 'Check types',
  }
  const userInputInter: PendingInteraction = {
    kind: 'user_input',
    interactionType: 'question',
    summary: 'Which port to use?',
    detail: 'Which port to use? [3000/8080]',
  }

  const sessionA: BubbleSessionDetail = {
    sessionId: 'sess-1',
    title: 'Codex Dev',
    status: 'waiting',
    pendingInteraction: approvalInter,
  }

  const sessionB: BubbleSessionDetail = {
    sessionId: 'sess-1',
    title: 'Codex Dev',
    status: 'waiting',
    pendingInteraction: { ...approvalInter },
  }

  const sessionC: BubbleSessionDetail = {
    sessionId: 'sess-1',
    title: 'Codex Dev',
    status: 'waiting',
    pendingInteraction: userInputInter,
  }

  const sessionNoInter: BubbleSessionDetail = {
    sessionId: 'sess-1',
    title: 'Codex Dev',
    status: 'waiting',
  }

  assert.ok(isSameSessionDetail(sessionA, sessionB))
  assert.ok(!isSameSessionDetail(sessionA, sessionC))
  assert.ok(!isSameSessionDetail(sessionA, sessionNoInter))

  const payloadA: MascotBubblePayload = {
    style: 'compact',
    running: 0,
    waiting: 1,
    activeSession: sessionA,
    activeSessions: [sessionA],
  }
  const payloadB: MascotBubblePayload = {
    style: 'compact',
    running: 0,
    waiting: 1,
    activeSession: sessionB,
    activeSessions: [sessionB],
  }
  const payloadC: MascotBubblePayload = {
    style: 'compact',
    running: 0,
    waiting: 1,
    activeSession: sessionC,
    activeSessions: [sessionC],
  }

  assert.ok(isSameBubblePayload(payloadA, payloadB))
  assert.ok(!isSameBubblePayload(payloadA, payloadC))
})

test('deriveSessionActivity with justification or prompt fields does not create waiting state', () => {
  // Regression 1: Tool call with justification field must map to normal command/tool activity
  const justAct = deriveSessionActivity({
    tool: 'exec',
    toolInput: JSON.stringify({ cmd: 'cargo check', justification: 'Routine verification' }),
    status: 'tool_running',
  })
  assert.ok(justAct)
  assert.equal(justAct.kind, 'command')
  assert.equal(justAct.status, 'running')

  // Regression 2: Tool call with prompt/questions parameters must not be treated as waiting/user_input
  const promptAct = deriveSessionActivity({
    tool: 'generate_code',
    toolInput: JSON.stringify({ prompt: 'Write test suite', questions: ['Which format?'] }),
    status: 'tool_running',
  })
  assert.ok(promptAct)
  assert.equal(promptAct.status, 'running')
})


