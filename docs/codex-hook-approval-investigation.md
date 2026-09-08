# Codex hook approval wait investigation (2026-09-08)

## Findings

Codex runs `PermissionRequest` before its normal approval prompt. A hook can
allow, deny, or decline to decide; `{}` leaves the normal approval flow in control.
Source: [OpenAI hook documentation](https://learn.chatgpt.com/docs/hooks#permissionrequest).

The installed PowerShell hook waits synchronously in `ReadToEnd()` without a
read deadline. The installer configured 600 seconds for this event. The OC-Claw
server creates a responder, advertises actionable approval buttons, then waits
up to 300 seconds. A missing or unresponsive frontend therefore holds the gate
in front of native approval. `frontend actionable` is a server-side log statement,
not an acknowledgement that a frontend rendered or received the event.

The running process was PID 44324, `D:\oc-claw\frontend\src-tauri\target\release\oc_claw.exe`.
Its log `run-2026-09-06_18-44-10.log` contains these matched request/response pairs
on September 8 (UTC, aligned with the Codex transcript):

| Turn prefix | Responder created | Empty response submitted | Wait |
| --- | --- | --- | --- |
| 01a07f1d | 03:43:59 | 03:45:18 | ~79 s |
| 01a07f29 | 03:57:02 | 03:58:40 | ~98 s |
| 01a07f2e | 04:03:10 | 04:04:02 | ~52 s |

Log line ranges are 574714–574977, 577153–577455, and 578286–578454.
These establish real relay waits, not five-minute timeouts in every case. They
do not identify who initiated the empty response. The matching Codex transcript
has no hook timing events and cannot establish when a native card rendered.
The executable has not been proven to match this checkout byte for byte; its
logs independently confirm that it uses the relay mechanism.

The old server cleans responders on accepted `PostToolUse`, `Stop`, and
`UserPromptSubmit` events. Cleanup is conditional on turn identity. It does not
register an `Interrupt` hook or explicitly release on permission-mode changes,
`SessionEnd`, frontend acknowledgement failure, or socket peer disconnection.
Consequently cancellation cannot be assumed to release it promptly.

Sandbox ACL initialization is separate. This change does not diagnose or change
ACLs and makes no claim that Codex automatic approval is faulty.

## Change

PermissionRequest is now observation-only:

- Both generated scripts send the event and return `{}` without reading a decision.
- Windows connect/write and Unix socket operations have 500 ms timeouts.
- The installer uses the existing 5-second hook limit for PermissionRequest too.
- The backend immediately writes `{}` for compatibility with old scripts. It
  creates no responder or actionable relay ID and releases any existing waiter.
- Existing event processing and native "view in Codex" UI remain in place.

There is no automatic allow. Native Codex owns approval, cancellation, and mode
changes. Frontend responsiveness is no longer on the approval response path.
Direct allow/deny through this hook relay is intentionally no longer offered.

## Verification and scope

- `cargo check`: passed (two unrelated dead-code warnings).
- `cargo test --lib codex_ -- --test-threads=1`: 57 passed.
- `npx tauri build --no-bundle`: passed, producing the executable only in this
  worktree's `frontend/src-tauri/target/release/`. It was not launched or installed.
- `python scripts/test_codex_hook_transport.py`: passed. Real PowerShell processes
  send events over a separate ephemeral port; the test server deliberately never
  replies. PermissionRequest and three status events exit with exactly `{}`.
  Server unavailable also returns `{}`. Unix payload tested with a socket mock;
  native macOS/Linux execution is not covered.
- The old generated PowerShell script, on the same isolated no-response server,
  was still blocked at four seconds and was terminated by the test harness.
- PowerShell wall times include interpreter startup and vary under compilation
  load (observed roughly 0.8–3.2 seconds). These are not UI latency measurements.

No installed hooks/configuration, running executable, or directory permissions
were changed. Test scripts were extracted into temporary directories in this
worktree. No real approval was allowed or denied.

Desktop enable/disable comparison remains a deployment-stage check, explicitly
deferred because the user requested that the running program and disabled hook
remain untouched. After deployment is authorized, compare the same harmless
approval-requiring operation with the hook disabled and enabled, under the same
permission mode. Record native card timing separately from hook completion;
repeat cancellation, mode switch, and unresponsive OC-Claw frontend cases. In
automatic mode, preserve Codex's own outcome rather than expecting a card.
