import type { ChromaKeyOptions, Offset } from '../utils/spriteUtils'

export type { ChromaKeyOptions, Offset }

export type ClaudeStatsSource = 'cc' | 'codex' | 'cursor' | 'gemini' | 'hermes' | 'opencode' | 'antigravity'

export type BubbleStyle = 'compact' | 'detailed'

export interface SubagentDetail {
  id: string
  role: string
  status: string // "tool_running" | "processing" | "stopped"
  updatedAt?: number
}

export type SessionActivityKind =
  | 'reasoning'
  | 'read'
  | 'list'
  | 'search'
  | 'edit'
  | 'command'
  | 'tool'
  | 'web'
  | 'subagent'
  | 'generic'

export type SessionActivitySource =
  | 'reasoning-summary'
  | 'tool-call'
  | 'agent-message'
  | 'derived'
  | 'fallback'

export interface SessionActivity {
  kind: SessionActivityKind
  target?: string
  query?: string
  count?: number
  summary?: string
  toolName?: string
  status: 'running' | 'completed'
  source: SessionActivitySource
}

export type PendingInteractionKind = 'approval' | 'user_input'

export interface ApprovalActions {
  canDeny: boolean
  canAllowTurn: boolean
  canAllowSession: boolean
}

export interface PendingInteraction {
  kind: PendingInteractionKind
  interactionType?: string
  turnId?: string
  itemId?: string
  callId?: string
  tool?: string
  summary?: string
  detail?: string
  justification?: string
  requestId?: string
  approvalActions?: ApprovalActions
}

export interface ClaudeSession {
  sessionId: string
  cwd: string
  status: string
  tool?: string
  toolInput?: string
  userPrompt?: string
  customTitle?: string
  interactive: boolean
  updatedAt: number
  isProcessing: boolean
  pid?: number
  pendingAgents?: number
  permissionSuggestions?: any
  needsReview?: boolean
  lastResponse?: string
  isActiveTab?: boolean
  source: string
  terminalId?: string
  hostTerminal?: string
  platform?: string
  cursorPort?: number
  cursorWorkspaceRoot?: string
  cursorWorkspaceName?: string
  cursorNativeHandle?: string
  activeSubagents?: SubagentDetail[]
  activity?: SessionActivity
  turnId?: string
  pendingInteraction?: PendingInteraction
}

export interface BubbleSessionDetail {
  sessionId: string
  title: string
  subtitle?: string
  actionText?: string
  role?: string
  source: string
  status: string
  tool?: string
  toolInput?: string
  userPrompt?: string
  questionText?: string
  customTitle?: string
  activeSubagents?: SubagentDetail[]
  otherCount?: number
  activity?: SessionActivity
  turnId?: string
  pendingInteraction?: PendingInteraction
}

export interface MascotBubblePayload {
  style: BubbleStyle
  running: number
  waiting: number
  activeSession?: BubbleSessionDetail | null
  activeSessions?: BubbleSessionDetail[]
}

export interface BubbleTransitionEvent {
  transitionId: number
  payload?: MascotBubblePayload
}

export interface SessionInfo {
  id: string
  label?: string
  status: string
  model?: string
  channel?: string
}

export interface CharacterMeta {
  name: string
  builtin?: boolean
  ip?: string
  workGifs: string[]
  restGifs: string[]
  crawlGifs?: string[]
  angryGifs?: string[]
  shyGifs?: string[]
  miniActions?: Record<string, string[]>
  largeActions?: Record<string, string>
}

export interface AgentInfo {
  id: string
  identityName?: string
  identityEmoji?: string
}

export interface AgentHealth {
  agentId: string
  active: boolean
}

export interface ToolCallStat {
  name: string
  count: number
}

export interface RecentAction {
  type: 'tool' | 'text'
  summary: string
  detail?: string
  timestamp?: string
}

export interface AgentMetrics {
  agentId: string
  active: boolean
  currentModel?: string
  thinkingLevel?: string
  activeSessionCount: number
  currentTask?: string
  currentTool?: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalCost: number
  toolCalls: ToolCallStat[]
  recentActions: RecentAction[]
  errorCount: number
  messageCount: number
  sessionStart?: string
  lastActivity?: string
  channel?: string
}

export interface PipelinePreset {
  id: string; name: string; description: string; promptFile: string
  cols: number; rows: number; needsRefImage: boolean
  rowLabels?: string[]; excludeLastFrameRows?: number[]
}

export interface PipelineConfig {
  id: string; name: string; description: string
  presets: PipelinePreset[]; exportMode: 'whole' | 'by-row'; discardLastFrame: boolean
}

export interface OcConnection {
  id: string
  type: 'local' | 'remote'
  host?: string
  user?: string
}

export type CardStatus = 'idle' | 'generating' | 'processing' | 'ready' | 'error'

export interface PipelineItem {
  preset: PipelinePreset; status: CardStatus; error?: string
  rawFrames: HTMLCanvasElement[]
  keyedFrames: HTMLCanvasElement[]
  rowGroups: HTMLCanvasElement[][]
  rowLabels: string[]
  globalOffset: Offset
  rowOffsets: Offset[]
}

export interface QuotaWindow {
  label: string
  percent: number // 0 to 100
  resets_at?: string | null // ISO string
}

export interface HarnessQuotaSummary {
  harness: 'codex' | 'antigravity'
  connected: boolean
  plan_label?: string | null
  primary?: QuotaWindow | null
  details: QuotaWindow[]
  updated_at: number
}
