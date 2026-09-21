# Native approval and question observation

OC-Claw displays attention states; the harness owns permission decisions and
question answers. Do not restore an approval relay or return wildcard grants to
make a status indicator work.

## Failures addressed

- Codex `PermissionRequest` could set waiting, then transcript reconciliation
  cleared it because the transcript had no matching approval record. Hook-owned
  interactions now survive that absence and unrelated tool results. Matching
  results, interruption, session end, and a new user prompt release the state.
- `request_user_input` was absent from direct hook classification, and
  `request_user_input_async` was absent from both classification and transcript
  reconstruction. Async submission acknowledgement does not answer the question.
  Its waiting state survives ordinary tool activity and normal Stop, and is
  cleared by a user reply, a new prompt, an error, or cancellation. Replies carry
  a `questionItemId` containing the originating call ID.
- Antigravity `PreInvocation` was incorrectly treated as a new user prompt,
  resetting state on every model invocation.
- Antigravity's hook waited for a socket response and supplied `allow` plus
  wildcard `permissionOverrides`. The installer now removes its `PreToolUse`
  handler and observes `PreInvocation`, `PostInvocation`, `PostToolUse`, and
  `Stop`. Both platforms use bounded transport and do not read a decision.
- The frontend classified approvals as `review` but rendered the attention panel
  only for ordinary `waiting`, excluding the approval branch itself.
- The Codex script performed unbounded WMI process-tree queries before its
  bounded socket write. These queries are removed from the synchronous hook path.
  The installer migrates the deprecated `features.codex_hooks` alias to `hooks`,
  preserving explicit disables and per-hook trust/enabled state.

## Antigravity evidence boundary

The [official hook contract](https://antigravity.google/docs/hooks) defines
`PreToolUse` as a permission decision hook; it does not expose a standalone
`PermissionRequest` notification. Returning `ask` would alter policy too.
OC-Claw therefore uses execution records for `ask_question`, `ask_permission`,
and native `WAITING` command steps. A merely planned or running shell command is
not sufficient evidence of approval. The installed language-server schema
includes `CORTEX_STEP_STATUS_WAITING`; whether a particular release writes that
status to `transcript.jsonl` while a native card is visible needs live acceptance.
If it does not, command approval cannot be inferred reliably by this observer.

Disabled hooks cannot deliver live events. Transcript recovery is a fallback,
not a replacement for every native lifecycle notification. Hook configuration
changes also require the harness to reload its configuration; an already loaded
legacy Antigravity PreToolUse handler is not an observation-only integration.

## Validation

Verified on Windows in the implementation worktree:

| Command | Result |
| --- | --- |
| `cargo test --locked --offline --lib -- --test-threads=1 --skip hermes:: --skip harness_quota:: --skip presentation:: --skip bubble_trace::` | 82 passed |
| `python scripts/test_codex_hook_transport.py` | 7 passed |
| `pnpm test` | 77 passed |
| `pnpm build` | Passed |
| `pnpm exec tauri build --debug --no-bundle` | Debug application built |

`pnpm lint` retains the repository baseline (138 errors, 28 warnings);
the modified Mini.tsx has the same diagnostic locations, rules, and messages
as HEAD (58 errors, 15 warnings). `cargo fmt --check` also encounters the
existing repository formatting baseline. `git diff --check` passes.
Windows Node subprocess and Python temporary-directory checks required execution
outside the restricted sandbox. No installed configuration or running app was
modified during validation.

- Rust interaction, Codex adapter, and session activity regressions: includes
  sync/async questions, approval call identity, stale turns, native AGY WAITING
  versus ordinary execution, completion, and configuration migration.
- `python scripts/test_codex_hook_transport.py`: generated scripts only,
  temporary files and ephemeral ports. Real PowerShell against unavailable and
  nonresponding servers; Unix payloads use a socket mock. No installed hook or
  native approval is exercised by this test.
- Frontend tests and production build check presentation compatibility.

Live acceptance still needs a native command approval, synchronous question,
async question/reply, cancellation, and normal execution in the rebuilt app.
Check that approval stays in Codex/Antigravity and that OC-Claw never resolves it.
Run the same cases with OC-Claw absent. macOS/Linux native execution is not
covered by the Windows transport test.

## Antigravity parallel question timing follow-up

A live trace contained a single planner batch with `run_command` and
`ask_question`. The command retained a `GENERIC/RUNNING` background-task step,
while the question subsequently wrote its own `GENERIC/DONE` answer step.
Counting completed steps treated that answer as the command result, hiding the
question before the answer and resurrecting it afterwards. Interaction recovery
now matches each planner call to its individual trajectory step, independently
of other running tools. A regression covers the before-answer, after-answer,
and new-turn snapshots. `PostInvocation` in this trace arrived after the answer;
early detection relies on the already observable planner transcript.

Follow-up validation: 82 scoped Rust tests passed; standalone debug executable
built with `cargo rustc --locked --offline --bin oc_claw --features tauri/custom-protocol -- -C extra-filename=-agy-fix`. Native question timing still needs user verification with this executable.
