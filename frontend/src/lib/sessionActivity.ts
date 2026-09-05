import type { BubbleSessionDetail, MascotBubblePayload, PendingInteraction, SessionActivity, SessionActivityKind, SessionActivitySource } from './types'

export type { PendingInteraction, SessionActivity, SessionActivityKind, SessionActivitySource }

/**
 * Normalizes reasoning summary string for presentation in the mascot bubble:
 * - Strips Markdown headings (### ...)
 * - Strips Markdown emphasis (**...**, *...*, __...__, _..._)
 * - Strips code quote wrappers (`...`)
 * - Strips bullet prefixes (-, *, +, 1., •)
 * - Collapses whitespace
 * - Truncates to max 180 chars
 * - Returns null if result is empty
 */
export function normalizeActivitySummary(raw?: string | null): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Take first non-empty line
  let line = ''
  for (const l of trimmed.split('\n')) {
    const t = l.trim()
    if (t) {
      line = t
      break
    }
  }
  if (!line) return null

  // Strip Markdown headings (### ...)
  line = line.replace(/^#+\s*/, '')

  // Strip bullet prefixes
  line = line.replace(/^[-*+•]\s+/, '')
  line = line.replace(/^\d+\.\s+/, '')

  // Repeatedly strip matching wrappers (code backticks, bold, italic, quotes)
  while (true) {
    line = line.trim()
    const len = line.length
    if (len >= 6 && line.startsWith('```') && line.endsWith('```')) {
      line = line.slice(3, -3)
      continue
    }
    if (len >= 4 && ((line.startsWith('**') && line.endsWith('**')) || (line.startsWith('__') && line.endsWith('__')))) {
      line = line.slice(2, -2)
      continue
    }
    if (len >= 2 && (
      (line.startsWith('*') && line.endsWith('*')) ||
      (line.startsWith('_') && line.endsWith('_')) ||
      (line.startsWith('`') && line.endsWith('`')) ||
      (line.startsWith('"') && line.endsWith('"')) ||
      (line.startsWith('\'') && line.endsWith('\''))
    )) {
      line = line.slice(1, -1)
      continue
    }
    break
  }

  // Collapse whitespace
  const collapsed = line.replace(/\s+/g, ' ').trim()
  if (!collapsed) return null

  // Safe truncation to max 180 characters
  const truncated = Array.from(collapsed).slice(0, 180).join('').trim()
  return truncated.length > 0 ? truncated : null
}

/**
 * Extracts clean basename from file path string.
 */
export function extractBasename(pathStr?: string | null): string {
  if (!pathStr) return ''
  const unquoted = pathStr.trim().replace(/^["'`]|["'`]$/g, '')
  const normalized = unquoted.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = normalized.split('/')
  return parts.pop() || normalized
}

/**
 * Normalizes tool name (removes mcp__server__ prefix, converts underscores/hyphens to spaces).
 */
export function normalizeToolName(toolName?: string | null): string {
  if (!toolName) return 'tool'
  let s = toolName.trim()
  const mcpIdx = s.lastIndexOf('__')
  if (mcpIdx !== -1) {
    s = s.slice(mcpIdx + 2)
  }
  const cleaned = s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  const truncated = Array.from(cleaned).slice(0, 50).join('').trim()
  return truncated || toolName
}

interface ParsedToolInput {
  target?: string
  query?: string
  command?: string
  count?: number
  toolAction?: string
  toolSummary?: string
}

function parseRawToolInput(toolInput: unknown): ParsedToolInput {
  if (!toolInput) return {}
  try {
    const inp = typeof toolInput === 'string' ? JSON.parse(toolInput) : toolInput
    if (typeof inp !== 'object' || inp === null) {
      return {}
    }

    const rec = inp as Record<string, unknown>
    const pathCandidate =
      rec.TargetFile ||
      rec.AbsolutePath ||
      rec.file_path ||
      rec.filePath ||
      rec.path ||
      rec.target_file ||
      rec.target

    const target = pathCandidate ? extractBasename(String(pathCandidate)) : undefined

    const queryCandidate =
      rec.Query ||
      rec.query ||
      rec.Pattern ||
      rec.pattern ||
      rec.search_query ||
      rec.searchQuery

    const query = queryCandidate
      ? Array.from(String(queryCandidate).trim()).slice(0, 100).join('')
      : undefined

    const commandCandidate = rec.CommandLine || rec.command || rec.cmd

    return {
      target: target || undefined,
      query: query || undefined,
      command: commandCandidate ? String(commandCandidate) : undefined,
      toolAction: rec.toolAction ? String(rec.toolAction) : undefined,
      toolSummary: rec.toolSummary ? String(rec.toolSummary) : undefined,
    }
  } catch {
    return {}
  }
}

/**
 * Generic Tool Activity Normalizer:
 * Maps tool name and input into a structured SessionActivity.
 */
export function deriveSessionActivity(session: {
  tool?: string
  toolInput?: unknown
  source?: string
  status?: string
}): SessionActivity | undefined {
  if (!session.tool) return undefined
  if (session.status && session.status !== 'tool_running') return undefined

  const toolName = session.tool.trim()
  const toolLower = toolName.toLowerCase()
  const input = parseRawToolInput(session.toolInput)

  // 1. invoke_subagent
  if (toolLower === 'invoke_subagent' || toolLower === 'agent') {
    return {
      kind: 'subagent',
      status: 'running',
      source: 'tool-call',
    }
  }

  // 2. Web search
  if (toolLower.includes('search_web') || toolLower.includes('web_search')) {
    return {
      kind: 'web',
      query: input.query,
      status: 'running',
      source: 'tool-call',
    }
  }

  // 3. Read / view file
  if ((toolLower.includes('read') || toolLower.includes('view') || toolLower.includes('open') || toolLower.includes('cat')) && input.target) {
    return {
      kind: 'read',
      target: input.target,
      status: 'running',
      source: 'tool-call',
    }
  }

  // 4. Search / grep / find
  if (toolLower.includes('search') || toolLower.includes('grep') || toolLower.includes('find') || toolLower.includes('query')) {
    return {
      kind: 'search',
      query: input.query,
      status: 'running',
      source: 'tool-call',
    }
  }

  // 5. List files
  if (toolLower.includes('list') || toolLower.includes('ls') || toolLower.includes('dir')) {
    return {
      kind: 'list',
      status: 'running',
      source: 'tool-call',
    }
  }

  // 6. Edit / write / replace / patch
  if (toolLower.includes('edit') || toolLower.includes('write') || toolLower.includes('replace') || toolLower.includes('patch') || toolLower.includes('apply')) {
    return {
      kind: 'edit',
      target: input.target,
      count: input.count,
      status: 'running',
      source: 'tool-call',
    }
  }

  // 7. Command
  if (toolLower.includes('command') || toolLower.includes('bash') || toolLower.includes('shell') || toolLower.includes('terminal') || input.command) {
    return {
      kind: 'command',
      status: 'running',
      source: 'tool-call',
    }
  }

  // 8. Unknown / custom tool
  return {
    kind: 'tool',
    toolName: normalizeToolName(toolName),
    status: 'running',
    source: 'tool-call',
  }
}

/**
 * Compare two SessionActivity objects for structural equality to avoid redundant re-renders.
 */
export function isSameActivity(a?: SessionActivity | null, b?: SessionActivity | null): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.kind === b.kind &&
    a.status === b.status &&
    a.source === b.source &&
    a.summary === b.summary &&
    a.target === b.target &&
    a.query === b.query &&
    a.count === b.count &&
    a.toolName === b.toolName
  )
}

/**
 * Compare two PendingInteraction objects for structural equality.
 */
export function isSamePendingInteraction(
  a?: PendingInteraction | null,
  b?: PendingInteraction | null
): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.kind === b.kind &&
    a.interactionType === b.interactionType &&
    a.turnId === b.turnId &&
    a.itemId === b.itemId &&
    a.callId === b.callId &&
    a.tool === b.tool &&
    a.summary === b.summary &&
    a.detail === b.detail &&
    a.justification === b.justification
  )
}

/**
 * Compare two BubbleSessionDetail objects for structural equality to avoid jitter / redundant re-renders.
 */
export function isSameSessionDetail(
  a?: BubbleSessionDetail | null,
  b?: BubbleSessionDetail | null
): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  if (
    a.sessionId !== b.sessionId ||
    a.title !== b.title ||
    a.source !== b.source ||
    a.status !== b.status ||
    a.role !== b.role ||
    a.customTitle !== b.customTitle ||
    a.userPrompt !== b.userPrompt ||
    a.questionText !== b.questionText ||
    a.actionText !== b.actionText ||
    a.tool !== b.tool ||
    a.toolInput !== b.toolInput ||
    a.otherCount !== b.otherCount
  ) {
    return false
  }

  if (!isSamePendingInteraction(a.pendingInteraction, b.pendingInteraction)) {
    return false
  }

  if (!isSameActivity(a.activity, b.activity)) {
    return false
  }

  const subA = a.activeSubagents || []
  const subB = b.activeSubagents || []
  if (subA.length !== subB.length) return false
  for (let i = 0; i < subA.length; i++) {
    const sA = subA[i]
    const sB = subB[i]
    if (sA.id !== sB.id || sA.status !== sB.status || sA.role !== sB.role) {
      return false
    }
  }

  return true
}

/**
 * Compare two MascotBubblePayload objects for structural equality to prevent redundant emissions and render loops.
 */
export function isSameBubblePayload(
  a?: MascotBubblePayload | null,
  b?: MascotBubblePayload | null
): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  if (
    a.style !== b.style ||
    a.running !== b.running ||
    a.waiting !== b.waiting
  ) {
    return false
  }

  if (!isSameSessionDetail(a.activeSession, b.activeSession)) {
    return false
  }

  const listA = a.activeSessions || []
  const listB = b.activeSessions || []
  if (listA.length !== listB.length) return false
  for (let i = 0; i < listA.length; i++) {
    if (!isSameSessionDetail(listA[i], listB[i])) {
      return false
    }
  }

  return true
}

