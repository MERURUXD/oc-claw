import test from 'node:test'
import assert from 'node:assert/strict'
import type { TFunction } from 'i18next'
import { resolveBubbleStatus, extractToolParam } from './bubbleStatus.ts'
import type { BubbleSessionDetail } from './types.ts'

// Simple mock for i18n t function with default value fallback
const mockT: TFunction = ((_key: string, defaultValue?: string | { defaultValue?: string }) => {
  if (typeof defaultValue === 'string') return defaultValue
  if (defaultValue && typeof defaultValue === 'object' && defaultValue.defaultValue) {
    return defaultValue.defaultValue
  }
  return defaultValue || _key
}) as unknown as TFunction

const EMOJI_REGEX = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF]|[\uE000-\uF8FF]/

test('resolveBubbleStatus: 1. Waiting for user answer', () => {
  const session: BubbleSessionDetail = {
    sessionId: 'session-answer-1',
    title: 'Debug Inject',
    status: 'waiting',
    pendingInteraction: {
      kind: 'user_input',
      summary: 'Which approach should we take?',
    },
  }

  const result = resolveBubbleStatus(session, mockT)
  assert.equal(result.kind, 'answer')
  assert.equal(result.statusLabel, '需要回答')
  assert.equal(result.content, 'Which approach should we take?')
  assert.equal(result.className, 'status-answer')

  // Invariant: no emoji in status label or content
  assert.ok(!EMOJI_REGEX.test(result.statusLabel), 'Status label must not contain emoji')
  assert.ok(!EMOJI_REGEX.test(result.content), 'Content must not contain emoji')
  assert.ok(!result.statusLabel.includes('等你回答'), 'Must use 需要回答, not 等你回答')
})

test('resolveBubbleStatus: 2. Waiting for approval', () => {
  const sessionCommand: BubbleSessionDetail = {
    sessionId: 'session-approval-1',
    title: 'Debug Inject',
    status: 'waiting',
    pendingInteraction: {
      kind: 'approval',
      interactionType: 'command',
      summary: 'Allow running: echo debug-inject',
    },
  }

  const result1 = resolveBubbleStatus(sessionCommand, mockT)
  assert.equal(result1.kind, 'approval')
  assert.equal(result1.statusLabel, '等待批准')
  assert.equal(result1.content, 'Allow running: echo debug-inject')
  assert.equal(result1.className, 'status-approval')
  assert.ok(!EMOJI_REGEX.test(result1.statusLabel), 'Must not contain emoji')

  const sessionFile: BubbleSessionDetail = {
    sessionId: 'session-approval-2',
    title: 'Debug Inject',
    status: 'waiting',
    pendingInteraction: {
      kind: 'approval',
      interactionType: 'file_change',
      summary: 'Allow modifying src/main.rs',
    },
  }

  const result2 = resolveBubbleStatus(sessionFile, mockT)
  assert.equal(result2.kind, 'approval')
  assert.equal(result2.statusLabel, '等待确认修改')
  assert.equal(result2.content, 'Allow modifying src/main.rs')
  assert.ok(!EMOJI_REGEX.test(result2.statusLabel), 'Must not contain emoji')
})

test('resolveBubbleStatus: 3. Running command state', () => {
  const sessionWithCmdActivity: BubbleSessionDetail = {
    sessionId: 'session-running-1',
    title: 'Debug Inject',
    status: 'tool_running',
    tool: 'Bash',
    activity: {
      kind: 'command',
      summary: 'echo debug-inject',
      toolName: 'Bash',
      status: 'running',
    },
  }

  const result1 = resolveBubbleStatus(sessionWithCmdActivity, mockT)
  assert.equal(result1.kind, 'running')
  assert.equal(result1.statusLabel, '正在运行')
  assert.equal(result1.content, 'echo debug-inject')
  assert.equal(result1.className, 'status-running')
  assert.ok(!EMOJI_REGEX.test(result1.statusLabel), 'Must not contain emoji')

  // Legacy tool running fallback with toolInput
  const sessionLegacyCmd: BubbleSessionDetail = {
    sessionId: 'session-running-2',
    title: 'Debug Inject',
    status: 'tool_running',
    tool: 'bash',
    toolInput: JSON.stringify({ command: 'cargo test --workspace' }),
  }

  const result2 = resolveBubbleStatus(sessionLegacyCmd, mockT)
  assert.equal(result2.kind, 'running')
  assert.equal(result2.statusLabel, '正在运行')
  assert.equal(result2.content, 'cargo test --workspace')
})

test('resolveBubbleStatus: 4. Generic working state', () => {
  // 4a. Processing with reasoning summary
  const sessionReasoning: BubbleSessionDetail = {
    sessionId: 'session-working-1',
    title: 'Debug Inject',
    status: 'processing',
    activity: {
      kind: 'reasoning',
      summary: '分析代码结构',
      status: 'running',
    },
  }

  const result1 = resolveBubbleStatus(sessionReasoning, mockT)
  assert.equal(result1.kind, 'working')
  assert.equal(result1.statusLabel, '工作中')
  assert.equal(result1.content, '分析代码结构')
  assert.equal(result1.className, 'status-working')
  assert.ok(!EMOJI_REGEX.test(result1.statusLabel), 'Must not contain emoji')

  // 4b. Subagent delegation
  const sessionSubagent: BubbleSessionDetail = {
    sessionId: 'session-working-2',
    title: 'Debug Inject',
    status: 'processing',
    activity: {
      kind: 'subagent',
      status: 'running',
    },
  }

  const result2 = resolveBubbleStatus(sessionSubagent, mockT)
  assert.equal(result2.kind, 'working')
  assert.equal(result2.statusLabel, '工作中')
  assert.equal(result2.content, '等待子代理')

  // 4c. Non-command tool running (e.g. read file)
  const sessionRead: BubbleSessionDetail = {
    sessionId: 'session-working-3',
    title: 'Debug Inject',
    status: 'tool_running',
    tool: 'view_file',
    activity: {
      kind: 'read',
      target: 'MascotBubble.tsx',
      status: 'running',
    },
  }

  const result3 = resolveBubbleStatus(sessionRead, mockT)
  assert.equal(result3.kind, 'working')
  assert.equal(result3.statusLabel, '工作中')
  assert.ok(result3.content.includes('MascotBubble.tsx'))

  // 4d. Processing fallback with thinking pool text
  const sessionFallback: BubbleSessionDetail = {
    sessionId: 'session-working-4',
    title: 'Debug Inject',
    status: 'processing',
  }

  const result4 = resolveBubbleStatus(sessionFallback, mockT, '思考中...')
  assert.equal(result4.kind, 'working')
  assert.equal(result4.statusLabel, '工作中')
  assert.equal(result4.content, '思考中...')

  // 4e. Absolute fallback when nothing is provided
  const sessionEmpty: BubbleSessionDetail = {
    sessionId: 'session-working-5',
    title: 'Debug Inject',
    status: 'processing',
  }

  const result5 = resolveBubbleStatus(sessionEmpty, mockT)
  assert.equal(result5.kind, 'working')
  assert.equal(result5.statusLabel, '工作中')
  assert.equal(result5.content, '处理中…')
})

test('resolveBubbleStatus: content truncation at 80 characters without breaking formatting', () => {
  const longPrompt = 'A'.repeat(150)
  const session: BubbleSessionDetail = {
    sessionId: 'session-long',
    title: 'Debug Inject',
    status: 'waiting',
    questionText: longPrompt,
  }

  const result = resolveBubbleStatus(session, mockT)
  assert.equal(result.content.length, 83) // 80 chars + '...'
  assert.ok(result.content.endsWith('...'))
})

test('extractToolParam extracts various command / path / question formats', () => {
  assert.equal(extractToolParam(JSON.stringify({ command: 'git status' })), 'git status')
  assert.equal(extractToolParam(JSON.stringify({ CommandLine: 'npm test' })), 'npm test')
  assert.equal(extractToolParam(JSON.stringify({ AbsolutePath: 'src/lib/bubble.ts' })), 'bubble.ts')
  assert.equal(extractToolParam(JSON.stringify({ question: 'Proceed?' })), 'Proceed?')
  assert.equal(extractToolParam('plain string input'), 'plain string input')
  assert.equal(extractToolParam(null), null)
})

test('visual distinction: all four states have unique kind, className, and statusLabel', () => {
  const answerSession: BubbleSessionDetail = {
    sessionId: 's1',
    title: 'Title',
    status: 'waiting',
    pendingInteraction: { kind: 'user_input', summary: 'Question?' },
  }
  const approvalSession: BubbleSessionDetail = {
    sessionId: 's2',
    title: 'Title',
    status: 'waiting',
    pendingInteraction: { kind: 'approval', summary: 'Run cmd' },
  }
  const runningSession: BubbleSessionDetail = {
    sessionId: 's3',
    title: 'Title',
    status: 'tool_running',
    tool: 'Bash',
    activity: { kind: 'command', summary: 'echo test', status: 'running' },
  }
  const workingSession: BubbleSessionDetail = {
    sessionId: 's4',
    title: 'Title',
    status: 'processing',
    activity: { kind: 'reasoning', summary: 'Thinking...', status: 'running' },
  }

  const sAnswer = resolveBubbleStatus(answerSession, mockT)
  const sApproval = resolveBubbleStatus(approvalSession, mockT)
  const sRunning = resolveBubbleStatus(runningSession, mockT)
  const sWorking = resolveBubbleStatus(workingSession, mockT)

  const kinds = [sAnswer.kind, sApproval.kind, sRunning.kind, sWorking.kind]
  const classNames = [sAnswer.className, sApproval.className, sRunning.className, sWorking.className]
  const labels = [sAnswer.statusLabel, sApproval.statusLabel, sRunning.statusLabel, sWorking.statusLabel]

  // All 4 kinds are unique
  assert.equal(new Set(kinds).size, 4)
  // All 4 classNames are unique
  assert.equal(new Set(classNames).size, 4)
  // All 4 status labels are unique
  assert.equal(new Set(labels).size, 4)

  // Content text does not bleed into status label or vice versa
  for (const s of [sAnswer, sApproval, sRunning, sWorking]) {
    assert.ok(s.statusLabel.length > 0)
    assert.ok(s.content.length > 0)
    assert.ok(!s.content.includes(s.statusLabel), `Content '${s.content}' must not include status label '${s.statusLabel}'`)
    assert.ok(!EMOJI_REGEX.test(s.statusLabel), `Status label '${s.statusLabel}' must not contain emoji`)
  }
})

test('state transition: rapid transitions produce correct presentation without stale state', () => {
  const session: BubbleSessionDetail = {
    sessionId: 'turn-1',
    title: 'Test',
    status: 'processing',
  }

  // 1. Working
  let res = resolveBubbleStatus(session, mockT)
  assert.equal(res.kind, 'working')

  // 2. Transition -> running command
  session.status = 'tool_running'
  session.tool = 'Bash'
  session.activity = { kind: 'command', summary: 'echo test', status: 'running' }
  res = resolveBubbleStatus(session, mockT)
  assert.equal(res.kind, 'running')
  assert.equal(res.content, 'echo test')

  // 3. Transition -> waiting for approval
  session.status = 'waiting'
  session.pendingInteraction = { kind: 'approval', summary: 'Allow echo test' }
  res = resolveBubbleStatus(session, mockT)
  assert.equal(res.kind, 'approval')
  assert.equal(res.statusLabel, '等待批准')

  // 4. Transition -> waiting for user input
  session.pendingInteraction = { kind: 'user_input', summary: 'Which file?' }
  res = resolveBubbleStatus(session, mockT)
  assert.equal(res.kind, 'answer')
  assert.equal(res.statusLabel, '需要回答')
})
