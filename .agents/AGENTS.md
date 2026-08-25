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

- **GitHub CLI Path**: `C:\Program Files\GitHub CLI\gh.exe`
- **Proxy Configuration**:
  Network calls on Windows (such as `gh pr create` / `gh pr merge` / `git push`) require local proxy environment variables:
  ```powershell
  $env:HTTP_PROXY='http://127.0.0.1:63106'; $env:HTTPS_PROXY='http://127.0.0.1:63106'
  ```
- **PR & Merge Flow**:
  - Create branch $\rightarrow$ Commit $\rightarrow$ Push to `origin <branch>`.
  - Create PR: `gh pr create --title "..." --body "..." --base main --head <branch>`
  - Merge PR: `gh pr merge <PR_NUMBER> --squash --admin`
  - Fetch latest `main`: `git fetch origin main`
