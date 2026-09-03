# Agent Guidelines & Project Conventions

This document specifies the architecture, lifecycle hooks, tool execution rules, subagent tracking, and development workflows for AI coding assistants (Google Antigravity, Claude Code, Cursor, Codex, OpenCode, Gemini CLI, and Hermes Agent) in `oc-claw`.

---

## 1. Google Antigravity Integration & Architecture

### Socket Server & IPC
- **Windows TCP Server**: `127.0.0.1:19288`
- **Unix Domain Socket**: `/tmp/ooclaw-antigravity.sock`
- **Hook Scripts**:
  - Windows: `~/.gemini/hooks/ooclaw-antigravity-hook.ps1`
  - Unix: `~/.gemini/hooks/ooclaw-antigravity-hook.sh`
  - Plugin config: `~/.gemini/config/plugins/occlaw/plugin.json` and `hooks.json`
- **Hook Output**: Hook scripts must write `{"decision":"allow"}` (for `PreToolUse`) or `{}` to stdout to avoid blocking Antigravity.

### Status Transitions & Tool Execution
- **`PreInvocation`** $\rightarrow$ maps to `UserPromptSubmit` (`status = "processing"`).
- **`PreToolUse`**:
  - **Interactive Questions Only**: Only `ask_question`, `AskUserQuestion`, `AskQuestion` tools enter `status = "waiting"` to display user prompts/jump buttons.
  - **Regular Tools**: `run_command`, `write_to_file`, `replace_file_content`, etc. **must set `status = "tool_running"`**.
  - **Turbo Mode Rule**: Never set `status = "waiting"` for non-question tools, so Turbo Mode and auto-approved commands run smoothly without reminder popup spam.
- **`PostToolUse`** $\rightarrow$ maps to `PostToolUse` (`status = "processing"`).
- **`Stop` & Multi-turn Execution**:
  - Antigravity emits a `Stop` hook after each model generation turn.
  - **Intermediate Step Check**: When `Stop` arrives, inspect `~/.gemini/antigravity/brain/<session_id>/.system_generated/logs/transcript.jsonl`.
  - If the latest model turn contains pending `tool_calls` or if subagents are running (`pending_agents > 0`):
    - Keep `status = "processing"` or `"tool_running"`.
    - **Suppress completion sound and completion popup**.
  - Only when the model produces a final text response (no `tool_calls`) and all subagents are finished (`pending_agents == 0`):
    - Set `status = "stopped"`.
    - Emit `claude-task-complete` and play the single completion sound effect.

### Subagent Tracking & UI Distinction
- **Subagent Counter**:
  - `PreToolUse` with `tool == "invoke_subagent"` $\rightarrow$ increment `session.pending_agents += 1`.
  - `PostToolUse` with `tool == "invoke_subagent"` / `SubagentStop` $\rightarrow$ decrement `session.pending_agents -= 1`.
- **Role & Title Formatting**:
  - Subagent roles (e.g. `Backend Rust Engineer`, `UI and i18n Engineer`) are extracted from `transcript.jsonl` (e.g. `You are the <Role> for oc-claw...`).
  - In the session list, subagent titles are formatted as `[Role] projectName` to prevent identical repetitive titles.
- **Preview & Rich Text**:
  - User prompts are cleaned of `<USER_REQUEST>`, `<ADDITIONAL_METADATA>`, and XML metadata tags.
  - Assistant responses are rendered with Markdown in the session card and completion reminder popup.

---

## 2. Development & Bug Fixing Conventions

When modifying the codebase:
1. **Target Confirmation**:
   - Always confirm you are working inside `oc-claw/` (the project root). Do not touch parent or sibling directories.
2. **Type & Compilation Checks**:
   - **Rust backend**: Run `cargo check` in `frontend/src-tauri` after any Rust modification.
   - **TypeScript frontend**: Run `npx tsc --noEmit` in `frontend/` after any TypeScript/React modification.
   - **Release binary test**: Run `npx tauri build --no-bundle` in `frontend/` to verify release compilation (`frontend/src-tauri/target/release/oc_claw.exe`).
3. **Behavioral Integrity**:
   - Do not invent fixes for unmentioned edge cases. Implement what is requested first.
   - Preserve all existing comments, docstrings, and cross-platform logic (macOS/Windows).

---

## 3. GitHub & Proxy Environment (Windows)

- **GitHub MCP Tools (Recommended)**:
  - You can use the `github` MCP server directly via `call_mcp_tool`:
    - Create PR: `ToolName: "create_pull_request"`, Arguments: `{"owner": "MERURUXD", "repo": "oc-claw", "title": "...", "head": "branch_name", "base": "main", "body": "..."}`
    - Merge PR: `ToolName: "merge_pull_request"`, Arguments: `{"owner": "MERURUXD", "repo": "oc-claw", "pull_number": <N>, "merge_method": "squash"}`
    - Issue & PR query: `list_pull_requests`, `get_pull_request`, `list_issues`, `create_issue`, etc.
- **GitHub CLI Path (Fallback)**: `C:\Program Files\GitHub CLI\gh.exe`
- **Proxy Configuration**:
  Network calls on Windows (such as `gh pr create` / `gh pr merge` / `git push`) require local proxy environment variables:
  ```powershell
  $env:HTTP_PROXY='http://127.0.0.1:63106'; $env:HTTPS_PROXY='http://127.0.0.1:63106'
  ```
- **Commit & PR Strategy**:
  - **Small Fixes & Quick Tweaks**: Commit directly and push to `main` (no PR required).
  - **Major Features & Large Work**: Create branch $\rightarrow$ Commit $\rightarrow$ Push to `origin <branch>` $\rightarrow$ Create PR (via GitHub MCP or `gh`) $\rightarrow$ Squash merge $\rightarrow$ `git fetch origin main`.

---

## 4. AI Harness Usage Limits & Quota Tracking

### Architecture & Endpoints
- **Rust Backend**: [`frontend/src-tauri/src/harness_quota.rs`](file:///C:/Users/Mei_LuLuXD/.gemini/antigravity/worktrees/oc-claw/track_harness_usage_limits/frontend/src-tauri/src/harness_quota.rs)
  - Exposed Tauri command: `get_harness_quota(harness: String, force_refresh: Option<bool>) -> Result<Option<HarnessQuotaSummary>, String>`.
  - **OpenAI Codex**:
    - Credentials: read `$HOME/.codex/auth.json` (`tokens.access_token`, `tokens.account_id`, `tokens.refresh_token`).
    - Endpoint: `GET https://chatgpt.com/backend-api/wham/usage`.
    - Auto-refresh: on HTTP 401, exchange `refresh_token` via `POST https://auth.openai.com/oauth/token` (client_id `app_EMoamEEZ73f0CkXaXp7hrann`), update `auth.json`, and retry once.
  - **Google Antigravity**:
    - Process discovery: scans for `language_server_windows_x64.exe` / `language_server.exe` / `language_server` (Windows: `Get-CimInstance Win32_Process` + `Get-NetTCPConnection`; macOS: `ps -ax` + `lsof`).
    - Extracts `--csrf_token` and `--extension_server_port`.
    - Endpoint: `POST https://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary` (Connect-RPC Protocol v1, with relaxed TLS for self-signed loopback certificate).
    - Decodes model buckets (Gemini 5h rolling limit, Gemini weekly, Claude/GPT limits).
  - **Cache & Throttling**:
    - In-memory cache: 5 minutes TTL per harness.
    - 429 protection: parses `Retry-After` header and enforces dynamic backoff.

### Frontend Components & Codeburn 1:1 Design
- **Core Component**: [`frontend/src/components/QuotaCapsule.tsx`](file:///C:/Users/Mei_LuLuXD/.gemini/antigravity/worktrees/oc-claw/track_harness_usage_limits/frontend/src/components/QuotaCapsule.tsx)
- **Remaining Quota Rule (剩余量准则)**:
  - All metrics are normalized and presented as **Remaining Quota (剩余量)**: `remaining = 100 - used_percent`.
  - Health ladder:
    - $\ge 30\%$: Emerald green (`#10b981`, Healthy).
    - $15\% \sim 30\%$: Amber yellow (`#f59e0b`, Warning).
    - $< 15\%$: Rose red (`#f43f5e` + pulse, Critical).
- **Side Dock (`QuotaSideRail`)**:
  - Mounted inside the right edge of `#mini-panel` in `Mini.tsx`.
  - Theme: unified `#141414` background for seamless surface continuity.
  - Squircle buttons: `44px` `rounded-[14px]` with pure white vector icons (`AntigravityIcon`, `CodexIcon`).
  - Inlaid progress arc: SVG `rect` with `strokeDasharray` rotated `-90deg` from top center, creating a recessed gauge look directly on the dock.
  - Clean remaining percentage displayed below each button.
- **Popover Card (`QuotaCard`)**:
  - Compact Codeburn layout (~180px height), pure `#141414` background.
  - Scrollbar hidden: `[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden`.
  - Wheel isolation: `onWheel={(e) => e.stopPropagation()}` to prevent scrolling the underlying session list.
  - Embedded in `ClaudeStatsView` as a natural stat card (`bg-white/[0.03] border border-white/5`).
- **Mascot Bubble (`QuotaMiniBadge`)**:
  - Mini pill badge (`[⚡ 76%]`) rendered in `MascotBubble.tsx` beside active session title with hover reset countdown tooltip.
