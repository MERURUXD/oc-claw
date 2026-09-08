import type { ClaudeSession, SessionActivity } from './types'

export const DEBUG_SESSION_PREFIX = 'debug-inject-'

export type DebugInjectPreset =
  | 'processing-generic'
  | 'processing-command'
  | 'waiting-approval'
  | 'waiting-user-input'

export function isDebugInjectSession(session: { sessionId?: string } | null | undefined): boolean {
  return Boolean(session?.sessionId?.startsWith(DEBUG_SESSION_PREFIX))
}

export function mergeSessionsWithDebugInject<T extends { sessionId?: string }>(
  polled: T[],
  inject: T[],
): T[] {
  const withoutDebug = polled.filter((s) => !isDebugInjectSession(s))
  return [...withoutDebug, ...inject]
}

function activity(kind: 'generic' | 'command', summary: string, toolName?: string): SessionActivity {
  return {
    kind,
    summary,
    toolName,
    status: 'running',
    source: 'fallback',
  }
}

export function buildDebugSession(preset: DebugInjectPreset, now = Date.now()): ClaudeSession {
  const base = {
    cwd: '/tmp/oc-claw-debug-inject',
    interactive: true,
    updatedAt: now,
    isProcessing: preset.startsWith('processing'),
    source: 'cc',
    customTitle: 'Debug Inject',
    userPrompt: 'debug inject (no network)',
  }

  switch (preset) {
    case 'processing-generic':
      return {
        ...base,
        sessionId: `${DEBUG_SESSION_PREFIX}processing-generic`,
        status: 'processing',
        activity: activity('generic', 'Thinking through the next step…'),
      }
    case 'processing-command':
      return {
        ...base,
        sessionId: `${DEBUG_SESSION_PREFIX}processing-command`,
        status: 'tool_running',
        tool: 'Bash',
        toolInput: JSON.stringify({ command: 'echo debug-inject' }),
        activity: activity('command', 'Running command', 'Bash'),
      }
    case 'waiting-approval':
      return {
        ...base,
        sessionId: `${DEBUG_SESSION_PREFIX}waiting-approval`,
        status: 'waiting',
        isProcessing: false,
        pendingInteraction: {
          kind: 'approval',
          interactionType: 'command',
          summary: 'Allow running: echo debug-inject',
          tool: 'Bash',
          approvalActions: {
            canDeny: true,
            canAllowTurn: true,
            canAllowSession: true,
          },
        },
      }
    case 'waiting-user-input':
      return {
        ...base,
        sessionId: `${DEBUG_SESSION_PREFIX}waiting-user-input`,
        status: 'waiting',
        isProcessing: false,
        pendingInteraction: {
          kind: 'user_input',
          summary: 'Which approach should we take?',
          detail: 'debug inject user_input',
        },
      }
  }
}

export const DEBUG_INJECT_PRESETS: { id: DebugInjectPreset; labelKey: string; fallback: string }[] = [
  { id: 'processing-generic', labelKey: 'settings.debugInjectProcessingGeneric', fallback: 'Inject processing (generic)' },
  { id: 'processing-command', labelKey: 'settings.debugInjectProcessingCommand', fallback: 'Inject processing (command)' },
  { id: 'waiting-approval', labelKey: 'settings.debugInjectWaitingApproval', fallback: 'Inject waiting (approval)' },
  { id: 'waiting-user-input', labelKey: 'settings.debugInjectWaitingUserInput', fallback: 'Inject waiting (user input)' },
]
