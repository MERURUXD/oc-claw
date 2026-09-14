import type { TFunction } from 'i18next'
import type { BubbleSessionDetail } from './types.ts'
import { formatActivity } from './activityFormat.ts'

export type BubbleStatusKind = 'answer' | 'approval' | 'running' | 'working'

export interface BubbleStatusPresentation {
  kind: BubbleStatusKind
  statusLabel: string
  content: string
  className: string
}

export function extractToolParam(toolInput: unknown): string | null {
  if (!toolInput) return null
  try {
    const inp = typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput
    if (typeof inp === 'object' && inp !== null) {
      let rawVal = ''
      if (Array.isArray(inp.questions) && inp.questions.length > 0) {
        const firstQ = inp.questions[0]
        if (typeof firstQ === 'object' && firstQ !== null && typeof firstQ.question === 'string' && firstQ.question.trim()) {
          rawVal = firstQ.question.trim()
        } else if (typeof firstQ === 'string' && firstQ.trim()) {
          rawVal = firstQ.trim()
        }
      } else if (typeof inp.question === 'string' && inp.question.trim()) {
        rawVal = inp.question.trim()
      } else if (typeof inp.justification === 'string' && inp.justification.trim()) {
        rawVal = inp.justification.trim()
      } else {
        rawVal =
          inp.command ||
          inp.CommandLine ||
          inp.toolAction ||
          inp.toolSummary ||
          inp.Query ||
          inp.query ||
          inp.Pattern ||
          inp.pattern ||
          inp.file_path ||
          inp.TargetFile ||
          inp.AbsolutePath ||
          inp.DirectoryPath ||
          inp.SearchPath ||
          inp.SearchDirectory ||
          inp.description ||
          inp.Description ||
          inp.prompt ||
          inp.Prompt ||
          (typeof inp === 'string' ? inp : '')
      }
      if (typeof rawVal === 'string' && rawVal.trim()) {
        let cleanVal = rawVal.trim()
        if (cleanVal.includes('/') || cleanVal.includes('\\')) {
          const parts = cleanVal.split(/[/\\]/)
          if (parts.length > 1 && !cleanVal.includes(' ')) {
            cleanVal = parts[parts.length - 1] || cleanVal
          }
        }
        return cleanVal
      }
    } else if (typeof inp === 'string') {
      return inp
    }
  } catch {
    return typeof toolInput === 'string' ? toolInput : null
  }
  return null
}

function isCommandLike(tool?: string): boolean {
  if (!tool) return false
  const lower = tool.toLowerCase()
  return (
    lower.includes('command') ||
    lower.includes('bash') ||
    lower.includes('shell') ||
    lower.includes('terminal')
  )
}

function truncateLine(text: string, maxLen = 80): string {
  const firstLine = text.split('\n')[0].trim()
  return firstLine.length > maxLen ? firstLine.slice(0, maxLen) + '...' : firstLine
}

/**
 * Resolves a session into one of the four centralized status presentations:
 * 1. answer: needs user answer (CircleHelp, blue-violet accent tint)
 * 2. approval: waiting for user confirmation (ShieldAlert, amber tint)
 * 3. running: actively executing a command (Spinner, cyan tint)
 * 4. working: generic working/processing state (ThreeDots, neutral/subtle tint)
 */
export function resolveBubbleStatus(
  session: BubbleSessionDetail,
  t: TFunction,
  fallbackThinkingText?: string
): BubbleStatusPresentation {
  const isWaiting = session.status === 'waiting'
  const isRunning = session.status === 'processing' || session.status === 'tool_running'
  const isProcessing = session.status === 'processing'

  // 1. Waiting states (user action required)
  if (isWaiting) {
    if (session.pendingInteraction?.kind === 'approval') {
      const isFileChange = session.pendingInteraction.interactionType === 'file_change'
      const statusLabel = isFileChange
        ? t('mini.waitingFileApproval', '等待确认修改')
        : t('mini.waitingApproval', '等待批准')
      const target =
        session.pendingInteraction.summary ||
        session.pendingInteraction.tool ||
        session.pendingInteraction.detail ||
        session.questionText ||
        session.userPrompt ||
        t('settings.bubbleJumpToTerminal', 'Waiting for input...')
      return {
        kind: 'approval',
        statusLabel,
        content: truncateLine(target),
        className: 'status-approval',
      }
    }

    // Default waiting state: needs answer
    const statusLabel = t('mini.statusNeedsAnswer', '需要回答')
    const target =
      session.pendingInteraction?.summary ||
      session.pendingInteraction?.detail ||
      session.questionText ||
      session.userPrompt ||
      t('settings.bubbleJumpToTerminal', 'Waiting for input...')
    return {
      kind: 'answer',
      statusLabel,
      content: truncateLine(target),
      className: 'status-answer',
    }
  }

  // 2. Running command state
  const isCommandActivity = isRunning && session.activity?.kind === 'command'
  const isCommandToolLegacy = session.status === 'tool_running' && isCommandLike(session.tool)

  if (isCommandActivity || isCommandToolLegacy) {
    const statusLabel = t('mini.statusRunning', '正在运行')
    let cmd = ''
    if (session.activity?.summary && session.activity.summary !== 'Running command' && session.activity.summary !== 'Ran command') {
      cmd = session.activity.summary
    } else {
      const param = extractToolParam(session.toolInput)
      cmd = param || session.actionText || session.tool || t('mini.activityRunningCommand', 'Running command')
    }
    return {
      kind: 'running',
      statusLabel,
      content: truncateLine(cmd),
      className: 'status-running',
    }
  }

  // 3. Generic working state
  const statusLabel = t('mini.statusWorking', '工作中')
  let content = ''

  if (session.status === 'compacting') {
    content = t('mini.compacting', 'compacting...')
  } else if (isRunning && session.activity) {
    if (session.activity.kind === 'subagent') {
      content = t('mini.statusWaitingSubagents', '等待子代理')
    } else if (session.activity.kind === 'reasoning' && session.activity.summary) {
      content = session.activity.summary
    } else {
      const formatted = formatActivity(session.activity, t)
      content = formatted || (fallbackThinkingText || t('mini.processingFallback', '处理中…'))
    }
  } else if (session.status === 'tool_running' && session.tool) {
    const param = extractToolParam(session.toolInput)
    content = param || session.actionText || session.tool
  } else if (isProcessing) {
    content = fallbackThinkingText || t('mini.processingFallback', '处理中…')
  } else {
    content =
      session.actionText ||
      session.subtitle ||
      session.userPrompt ||
      fallbackThinkingText ||
      t('mini.processingFallback', '处理中…')
  }

  return {
    kind: 'working',
    statusLabel,
    content: truncateLine(content),
    className: 'status-working',
  }
}
