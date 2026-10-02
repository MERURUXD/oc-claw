import type { TFunction } from 'i18next'
import type { BubbleSessionDetail } from './types.ts'
import { deriveSessionActivity, extractBasename, normalizeActivitySummary } from './sessionActivity.ts'
import { formatActivity } from './activityFormat.ts'

const commandLabels = {
  commit: 'Committing changes',
  stage: 'Staging changes',
  push: 'Pushing changes',
  diff: 'Reviewing changes',
  status: 'Checking repository status',
  log: 'Reading commit history',
  test: 'Running tests',
  build: 'Building project',
  lint: 'Checking code quality',
  install: 'Installing dependencies',
} as const

type CommandActivity = keyof typeof commandLabels

function commandActivity(command: string): CommandActivity | null {
  // Read the first executable, keeping quoted arguments together. Only skip a
  // leading directory change; don't label text in echo, scripts or later shell
  // branches as if that operation were already running.
  const tokens = command.match(/"(?:\\.|[^"\\])*"|'[^']*'|&&|\|\||[;|\n]|[^\s;&|]+/g) || []
  let words: string[] = []
  for (const token of tokens) {
    if (['&&', '||', ';', '|', '\n'].includes(token)) {
      if (token === '&&' && /^(cd|set-location)$/i.test(words[0] || '')) {
        words = []
        continue
      }
      break
    }
    words.push(token.replace(/^(["'])(.*)\1$/, '$2'))
  }
  while (/^[A-Za-z_][A-Za-z_0-9]*=/.test(words[0] || '')) words.shift()
  const executable = extractBasename(words.shift()).toLowerCase().replace(/\.(exe|cmd|bat)$/, '')
  if (executable === 'git') {
    while (words[0]?.startsWith('-')) {
      const option = words.shift()!
      if (['-C', '-c', '--git-dir', '--work-tree'].includes(option)) words.shift()
      else if (!/^--(?:git-dir|work-tree)=/.test(option)) return null
    }
    const action = words[0]
    if (action === 'add') return 'stage'
    if (action && ['commit', 'push', 'diff', 'status', 'log'].includes(action)) return action as CommandActivity
  }
  if (['pnpm', 'npm', 'yarn', 'bun'].includes(executable)) {
    while (['-C', '--dir', '--prefix', '--cwd'].includes(words[0])) words.splice(0, 2)
    if (['run', 'exec', 'x'].includes(words[0])) words.shift()
    const action = words[0] || ''
    if (/^(test|vitest|jest)(:|$)/.test(action)) return 'test'
    if (action === 'tsc') return words.includes('--noEmit') ? 'lint' : 'build'
    if (/^build(:|$)/.test(action) || (action === 'vite' && words[1] === 'build')) return 'build'
    if (/^(lint|eslint|typecheck|check)(:|$)/.test(action)) return 'lint'
    if (['install', 'ci', 'add'].includes(action)) return 'install'
  }
  if (['cargo', 'dotnet'].includes(executable)) {
    if (words[0]?.startsWith('+')) words.shift()
    if (words[0] === 'test') return 'test'
    if (words[0] === 'build') return 'build'
    if (['check', 'clippy', 'fmt', 'format'].includes(words[0])) return 'lint'
    if (words[0] === 'restore') return 'install'
  }
  if (['pytest', 'vitest', 'jest'].includes(executable)) return 'test'
  if (/^python(?:3(?:\.\d+)?)?$/.test(executable) && words[0] === '-m') {
    if (['pytest', 'unittest'].includes(words[1])) return 'test'
    if (words[1] === 'pip' && words[2] === 'install') return 'install'
  }
  if (executable === 'node' && words.includes('--test')) return 'test'
  if (executable === 'tsc') return words.includes('--noEmit') ? 'lint' : 'build'
  if (['eslint', 'ruff'].includes(executable)) return 'lint'
  if (executable === 'pip' && words[0] === 'install') return 'install'
  return null
}

/** Short activity text from Claude's live tool evidence; never changes lifecycle. */
export function formatClaudeToolActivity(session: BubbleSessionDetail, t: TFunction): string | null {
  if (session.source !== 'cc' || session.status !== 'tool_running' || !session.tool) return null
  let input: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(session.toolInput || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>
  } catch {
    // A malformed/truncated hook payload still has a usable tool name/activity.
  }
  const field = (key: string) => typeof input[key] === 'string' ? (input[key] as string).trim() : ''
  const tool = session.tool.toLowerCase()
  // Only these built-ins define description as a short activity label. Task
  // management and arbitrary MCP tools may use it for detailed business data.
  if (['bash', 'powershell', 'agent', 'task'].includes(tool)) {
    const description = normalizeActivitySummary(field('description'))
    if (description) return description
  }
  if (tool === 'bash' || tool === 'powershell') {
    const activity = commandActivity(field('command'))
    return activity ? t(`mini.claudeActivity.${activity}`, commandLabels[activity]) : null
  }
  if (tool === 'agent' || tool === 'task') return t('mini.activityDelegating', 'Delegating task')
  if (tool === 'glob') {
    const pattern = field('pattern')
    return pattern
      ? t('mini.activitySearching', { query: pattern, defaultValue: `Searching "${pattern}"` })
      : t('mini.activityListing', 'Listing files')
  }
  if (tool === 'websearch') {
    const query = field('query')
    return query
      ? t('mini.activitySearchingWeb', { query, defaultValue: `Searching web for "${query}"` })
      : t('mini.activitySearchingWebGeneric', 'Searching web')
  }
  if (tool === 'webfetch') {
    let target = ''
    try { target = new URL(field('url')).hostname } catch { /* Omit an invalid URL. */ }
    return [t('mini.claudeActivity.fetch', 'Reading web page'), target].filter(Boolean).join(' · ')
  }
  if (tool === 'taskcreate' || tool === 'taskupdate') {
    return normalizeActivitySummary(field('activeForm')) || t('mini.claudeActivity.updateTasks', 'Updating task plan')
  }
  if (tool === 'todowrite') {
    return t('mini.claudeActivity.updateTasks', 'Updating task plan')
  }
  if (['tasklist', 'taskget'].includes(tool)) return t('mini.claudeActivity.readTasks', 'Checking task progress')
  if (tool === 'skill') {
    return [t('mini.claudeActivity.skill', 'Using skill'), field('skill')].filter(Boolean).join(' · ')
  }
  if (tool === 'notebookedit') {
    return t('mini.activityEditing', {
      target: extractBasename(field('notebook_path')) || 'notebook',
      defaultValue: `Editing ${extractBasename(field('notebook_path')) || 'notebook'}`,
    })
  }
  const activity = session.activity || deriveSessionActivity(session)
  return activity ? formatActivity(activity, t) : null
}
