import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import i18next, { type TFunction } from 'i18next'
import type { BubbleSessionDetail } from './types.ts'
import { formatClaudeToolActivity } from './claudeActivity.ts'
import { resolveBubbleStatus } from './bubbleStatus.ts'

const t = ((_key: string, fallback: string | { defaultValue: string }) =>
  typeof fallback === 'string' ? fallback : fallback.defaultValue) as TFunction

function session(tool: string, input: unknown = {}): BubbleSessionDetail {
  return { sessionId: 'claude-live', title: 'Claude', source: 'cc', status: 'tool_running', tool, toolInput: JSON.stringify(input) }
}

test('Claude tool description takes priority over a raw command or generic activity', () => {
  const live = session('Bash', { command: 'git commit -m fix', description: '**Committing the approval fix**\nExtra detail' })
  live.activity = { kind: 'command', source: 'tool-call', status: 'running' }
  const result = resolveBubbleStatus(live, t)
  assert.equal(result.kind, 'running')
  assert.equal(result.content, 'Committing the approval fix')
  assert.equal(formatClaudeToolActivity(session('Agent', { description: 'Reviewing the transport changes' }), t), 'Reviewing the transport changes')
})

test('Claude command summaries recognize executable operations and common options', () => {
  const cases = [
    ['git -C "D:/my repo" commit -m "fix test"', 'Committing changes'],
    ['cd "D:/my repo" && git -c core.quotepath=false diff', 'Reviewing changes'],
    ['git add src && git commit -m fix', 'Staging changes'],
    ['git push origin feature', 'Pushing changes'],
    ['git status --short', 'Checking repository status'],
    ['git log --oneline', 'Reading commit history'],
    ['pnpm -C frontend test', 'Running tests'],
    ['CI=true pnpm run test:unit', 'Running tests'],
    ['npm ci', 'Installing dependencies'],
    ['pnpm exec vitest run', 'Running tests'],
    ['pnpm build', 'Building project'],
    ['pnpm exec vite build', 'Building project'],
    ['pnpm exec tsc --noEmit', 'Checking code quality'],
    ['cargo +stable test --locked', 'Running tests'],
    ['cargo check --locked', 'Checking code quality'],
    ['dotnet build', 'Building project'],
    ['python -m pytest tests', 'Running tests'],
    ['python3 -m pip install -r requirements.txt', 'Installing dependencies'],
    ['node --test tests.js', 'Running tests'],
    ['pnpm lint', 'Checking code quality'],
  ]
  for (const [command, expected] of cases) {
    assert.equal(formatClaudeToolActivity(session('Bash', { command }), t), expected, command)
  }
  assert.equal(resolveBubbleStatus(session('PowerShell', { command: 'dotnet test' }), t).kind, 'running')
})

test('Quoted mentions and unsupported commands retain their actual command text', () => {
  for (const command of [
    'echo "git commit && pnpm test"',
    'python script.py --example "git push"',
    'echo done && git commit -m fix',
    'git show HEAD:tests/test.ts',
    'pnpm run custom-script',
    'git diff --stat && pnpm test',
  ]) {
    const live = session('Bash', { command })
    if (command.startsWith('git diff')) {
      assert.equal(formatClaudeToolActivity(live, t), 'Reviewing changes')
    } else {
      assert.equal(formatClaudeToolActivity(live, t), null)
      assert.equal(resolveBubbleStatus(live, t).content, command)
    }
  }
})

test('Claude tools show search targets, web hostnames, task plans and delegated work', () => {
  const cases: [string, unknown, string][] = [
    ['Read', { file_path: 'D:/repo/main.rs' }, 'Reading main.rs'],
    ['Edit', { file_path: 'D:/repo/main.rs' }, 'Editing main.rs'],
    ['Grep', { pattern: 'approval' }, 'Searching "approval"'],
    ['Glob', { pattern: '**/*.rs' }, 'Searching "**/*.rs"'],
    ['WebSearch', { query: 'Tauri window events' }, 'Searching web for "Tauri window events"'],
    ['WebFetch', { url: 'https://example.com/docs?secret=hidden' }, 'Reading web page · example.com'],
    ['Agent', {}, 'Delegating task'],
    ['Task', {}, 'Delegating task'],
    ['TodoWrite', {}, 'Updating task plan'],
    ['TaskUpdate', {}, 'Updating task plan'],
    ['TaskList', {}, 'Checking task progress'],
    ['Skill', { skill: 'review' }, 'Using skill · review'],
    ['NotebookEdit', { notebook_path: 'D:/repo/analysis.ipynb' }, 'Editing analysis.ipynb'],
  ]
  for (const [tool, input, expected] of cases) assert.equal(resolveBubbleStatus(session(tool, input), t).content, expected, tool)
})

test('Activity enrichment is scoped to live Claude tools and preserves waiting and completion', () => {
  const live = session('Bash', { command: 'git commit -m fix', description: 'Committing fix' })
  for (const status of ['processing', 'waiting', 'stopped', 'compacting']) {
    assert.equal(formatClaudeToolActivity({ ...live, status }, t), null, status)
  }
  assert.equal(resolveBubbleStatus({ ...live, status: 'processing' }, t, 'Thinking').content, 'Thinking')
  assert.equal(resolveBubbleStatus({ ...live, status: 'stopped', tool: undefined, toolInput: undefined, actionText: 'Done' }, t).content, 'Done')
  const waiting = { ...live, status: 'waiting', pendingInteraction: { kind: 'approval' as const, summary: 'Allow command?' } }
  assert.equal(resolveBubbleStatus(waiting, t).content, 'Allow command?')
  for (const source of ['codex', 'cursor', 'hermes']) {
    assert.equal(formatClaudeToolActivity({ ...live, source }, t), null)
    assert.equal(resolveBubbleStatus({ ...live, source }, t).content, 'git commit -m fix')
    assert.equal(resolveBubbleStatus({ ...session('PowerShell'), source }, t).kind, 'running')
  }
  const snapshot = JSON.stringify(live)
  resolveBubbleStatus(live, t)
  assert.equal(JSON.stringify(live), snapshot)
})

test('Malformed and non-string tool fields fall back without throwing', () => {
  for (const raw of ['{"command":', 'null', '[]', 'true', '{"description":42,"command":{}}']) {
    const live = { ...session('Bash'), toolInput: raw }
    assert.equal(formatClaudeToolActivity(live, t), null)
    assert.doesNotThrow(() => resolveBubbleStatus(live, t))
  }
  assert.equal(formatClaudeToolActivity(session('Bash', { command: 'pnpm test', description: '  \n ' }), t), 'Running tests')
  assert.equal(formatClaudeToolActivity(session('WebFetch', { url: 'invalid' }), t), 'Reading web page')
})

test('Claude activity labels are present in every supported locale and use the selected language', async () => {
  for (const locale of ['en', 'zh', 'ja', 'ko', 'fr', 'es']) {
    const resources = JSON.parse(readFileSync(new URL(`../i18n/locales/${locale}.json`, import.meta.url), 'utf8'))
    const instance = i18next.createInstance()
    await instance.init({ lng: locale, resources: { [locale]: { translation: resources } } })
    assert.equal(formatClaudeToolActivity(session('Bash', { command: 'git commit -m fix' }), instance.t), resources.mini.claudeActivity.commit)
    assert.deepEqual(Object.keys(resources.mini.claudeActivity).sort(), ['build', 'commit', 'diff', 'fetch', 'install', 'lint', 'log', 'push', 'readTasks', 'skill', 'stage', 'status', 'test', 'updateTasks'].sort())
  }
})
