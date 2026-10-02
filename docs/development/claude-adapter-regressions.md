# Claude adaptation regression investigation (2026-10-02)

This change continues the Claude quota/hook work in #83 and the merged lifecycle
fix in #84. It does not install or launch the built application.

## Source findings and changes

| Reported symptom | Verified source problem | Change |
| --- | --- | --- |
| No quota captured | Only CLI OAuth credentials are read; this Desktop installation has no CLI credentials file. Missing credentials and 403 silently hide the entry. A 429 without a previous reading leaves empty data; the side rail represents missing data as 100% remaining. | Read Desktop OAuth credentials with strict account matching and query live usage; accept measured statusline events and recent Desktop history as alternate sources; serialize queries, retain cooldown, display unavailable/error information, and show unknown quota as a dash. |
| Workspace name instead of session title | Only hook-provided title fields are read. Transcript metadata, Desktop's own title metadata, and the native session name are unused. One live Desktop title has not been written into its transcript yet. | Preserve the exact hook transcript path; read Desktop metadata keyed by `cliSessionId`, `custom-title` and summary/index metadata; accept statusline `session_name`. Scan complete appended transcript records incrementally and re-read on truncation. Metadata never changes turn status. |
| Command approval shown as a question | Claude is excluded from the unified pending-interaction parser. | Normalize `PermissionRequest` as approval and `AskUserQuestion` as user input, preserving relay request identity and tool arguments. Claude approval has no native tool-use ID. |
| Approval click has no effect | Waiting is published before the response channel is registered; missing/disconnected channels return success; the UI swallows errors and assumes processing. The hook's timeout is not aligned with the server's 600-second wait. | Register the channel before publishing; identify each connection by request ID; reject stale clicks and protect replacement requests from old cleanup; configure a 630-second hook timeout; display errors and await acknowledgement. The next hook owns the lifecycle transition. |
| Long work becomes inactive | Desktop without PID still uses silence timeout; an old transcript interruption can stop a new live Claude turn; root Stop does not keep the session active for unfinished descendants. | Remove Claude silence timeout; use explicit lifecycle or confirmed process exit; leave Claude transcript watchers out of lifecycle decisions; defer root completion until descendant work finishes. Query errors do not prove process exit. |

On Unix, the statusline relay preserves the existing command, padding, stdin,
stdout, stderr, and exit status. On Windows, an existing user statusline is left
exactly unchanged so Claude retains ownership of Bash/PowerShell selection.
The earlier Windows wrapper is migrated back to its saved original command.
Only an absent Windows statusline receives our standalone PowerShell observer;
existing Windows commands therefore do not forward native usage/title events.
OAuth quota queries and Desktop/transcript title readers remain available.
Reinstallation does not nest wrappers; unsupported configurations are unchanged.

## PR #86 review regressions

- Claude `PermissionRequest` officially omits `tool_use_id`. A parallel same-tool
  `PostToolUse` cannot identify an idless approval and no longer clears its popup
  or relay. Successful socket delivery clears only the matching relay request;
  failed delivery removes disconnected controls, and stale acknowledgements
  cannot clear a replacement. Explicit Claude hooks still own turn lifecycle.
- Native statusline measurements are stored by exact `session_id`, without an
  inferred account/org. They cannot overwrite OAuth-owned cache or push directly
  into the frontend. A statusline event requests the normal credential-gated
  query; native fallback is eligible only with no known OAuth identity and one
  fresh, unambiguous session. An expired/undecryptable selected Desktop account
  still prevents borrowing an unrelated CLI reading.
- Windows command-preservation fixtures cover inline PowerShell, Bash, explicit
  PowerShell invocation, legacy-wrapper restoration, reinstall, and user removal.
  The standalone transport fixture has no Bash lookup/dependency. These tests
  do not establish GUI approval acceptance or native shell selection.
- The approval command now awaits a writer-to-command oneshot result after
  `write_all` and `flush`. Queue acceptance alone never dismisses the panel;
  write/flush failure and a lost acknowledgement reject the command. Delivery
  failure remains attached to the exact interaction after disconnected controls
  disappear, so session refresh preserves the visible error. Replacements do
  not inherit it. Frontend deferred-promise tests cover disabled/open while
  delivery is pending, failure, confirmed success, and stale success.
- CLI persisted quota/cooldown files now use the default account/organization
  identity, in a namespace separate from Desktop. The old shared CLI file is
  never imported because its owner cannot be established. Default logins without
  known identity and custom configs use token-scoped in-memory reuse only:
  they do not read/write shared persisted balances or cooldowns, and restart
  loses their process-local fallback/cooldown. Tests exercise A-to-B 429 and
  expired-token paths, organization separation, legacy-file rejection, and
  unknown/custom identity rejection without contacting Anthropic.

## Protocol references and limits

- [Claude hooks reference](https://code.claude.com/docs/en/hooks):
  `PermissionRequest` input has no `tool_use_id`, and its output returns
  `hookSpecificOutput.decision.behavior`; timeout
  discards hook output and returns control to the client's normal flow.
- [Claude statusline reference](https://code.claude.com/docs/en/statusline):
  `session_name` is the native custom/generated title. `rate_limits` contains
  measured `used_percentage` and Unix `resets_at`, with `session_id` but no
  account/org identity. On Windows, Claude uses Git Bash when present and
  PowerShell otherwise. Quota fields require a
  supporting client version (the reference specifies v2.1.251+) and appear only
  after an API response on an eligible account. Older clients retain OAuth
  fallback. Desktop support must be verified on the user's client.

No credentials are refreshed or rewritten. The generated scripts were exercised
on fixture sockets, without contacting the installed OC-Claw server.

## Authorized read-only native investigation

The user authorized this investigation on 2026-10-02. The installed application
is Claude Desktop 2.19675.0.0 (Windows Store), embedding Claude Code 2.1.286.
The inspected OC-Claw run log identifies the installed executable as v1.8.6;
the newly built executable has not replaced it or been launched.

- The CLI config directory has no `.credentials.json`, explaining the missing
  input to the previous OAuth-only quota reader. Desktop's config has separate
  encrypted token-cache fields; the initial metadata-only investigation did not
  decrypt them. The subsequent authorized OAuth probe is recorded below.
- Desktop stores session metadata under `claude-code-sessions/<account>/<org>`.
  `cliSessionId` matches the actual hook/transcript session identity; the
  `sessionId` field is Desktop's separate host identity. The observed title
  fields include a live session with no transcript `custom-title` yet.
- Desktop's `plan-usage-history.json` version 2 records organization-scoped
  samples `{t, org, u}`; its application source confirms `t` is milliseconds,
  and `fh` / `sd` are measured utilization percentages. Background sampling
  is normally 15 minutes; history is throttled to at most one sample per
  4.5 minutes per organization. It does not store reset times.
- The latest inspected sample was 2026-10-02 06:28 local time, roughly six
  hours before investigation, with 5-hour utilization 0% and weekly 44%.
  These are historical measurements, not confirmed current balances.
- The new reader discovers normal and Store-redirected Desktop data, scopes
  titles to the last known account and exact CLI identity, and uses usage only
  when that account has one unambiguous organization. Multiple organizations
  are not guessed. A two-second metadata cache bounds repeated panel polls.
  This passive history is a fallback when subscription credentials are absent.
  The separate OAuth reader below now provides the primary Desktop path.
- Usage older than 20 minutes or dated in the future yields an unavailable
  diagnostic with the historical values, no current percentage/progress bar.
  Fresh measurements preserve their actual timestamp and omit reset countdowns.
  An empty latest sample supersedes earlier samples rather than reviving them.
- An installed hook has no configured PermissionRequest timeout. The inspected
  run log records a PermissionRequest transitioning to `waiting`; fixes to
  request identity and response delivery remain covered by transport fixtures,
  not a click in the installed Desktop UI.

The initial investigation did not change settings, hooks, credentials, or
application state. Desktop's use of the terminal statusline remains unverified.

## Desktop OAuth query and upstream comparison

The user selected cc-bar as the main implementation reference. Sources were
inspected at fixed commits on 2026-10-02:

- [cc-bar Desktop authentication](https://github.com/nanvon/cc-bar/blob/63d0f7eb06b307177bc85be586ed32fe2e5ec997/Core/Credentials/ClaudeDesktopAuth.swift):
  independent Desktop discovery, exact account/organization matching when
  borrowing for an expired CLI login, `user:profile`, token expiry, preference
  for the official Claude Code client, and no refresh-token use.
- [cc-bar quota request](https://github.com/nanvon/cc-bar/blob/63d0f7eb06b307177bc85be586ed32fe2e5ec997/Core/Quota/ClaudeQuotaClient.swift):
  GET `https://api.anthropic.com/api/oauth/usage` with the OAuth beta header.
- [TokenTracker credentials](https://github.com/xiufengsun/TokenTracker/blob/d710709356fec03cb1c3bf301b200e5d213e07ee/src/lib/subscriptions.js):
  Windows/Linux read CLI `.credentials.json`; macOS reads CLI Keychain storage.
  This does not cover the installed Desktop-only login.
- [TokenTracker quota/cache](https://github.com/xiufengsun/TokenTracker/blob/d710709356fec03cb1c3bf301b200e5d213e07ee/src/lib/usage-limits.js):
  same usage endpoint; a two-minute process cache, ten-minute fresh disk cache,
  persisted Retry-After cooldown, and removal of reset windows from stale data.

Our Windows reader adapts the identity rules to Electron safeStorage: DPAPI
unwraps `Local State`'s key; CNG authenticates/decrypts `v10`/`v11` AES-256-GCM
cache values. It supports normal and Store-redirected roots without a fixed
package suffix. No renewal, native file changes, credential logging, or
cross-account fallback is performed. Unlike cc-bar's discovery fallback, a
selected account with no usable token never switches to another cached account.
Without a known organization, multiple eligible organizations are unavailable
rather than guessed. Expired CLI credentials may borrow only with both exact
IDs; custom CLI config directories do not use default account metadata.

The new OAuth decryption path currently targets Windows. Other platforms retain
existing CLI credentials and passive history; macOS Desktop OAuth still needs a
noninteractive Keychain/CBC adapter and native verification.

Backend query cache and frontend Claude polling both use two minutes. Native
statusline events request a credential-gated query without overriding its HTTP
cache or cooldown; an unbound native measurement is used only when no OAuth
identity exists and exactly one session has fresh data. Passive history uses
the existing two-second metadata cache and does not wait for the HTTP TTL. Manual
refresh skips the query cache, but never skips the server's cooldown. Credential
changes invalidate process quota reuse; Desktop persisted state is separated
by account/organization from CLI and from other Desktop accounts. Reset boundaries
also invalidate fresh cache, and expired/future fallback readings are removed.
Server-side reporting lag remains outside this refresh policy.

A read-only probe of the installed Store client authenticated to the usage
endpoint and received HTTP 200: five-hour utilization 29%, weekly 48%, with real
reset timestamps. A separate temporary Rust probe compiled the actual credential
reader and confirmed it extracts an unexpired scoped Desktop token and Pro plan.
Only quota/validation fields were printed; no token or decrypted credential
payload was persisted. Installed Claude settings/hooks and OC-Claw remain untouched.

## Validation

- `pnpm test`: 175 passed after the delivery-ack review repair.
- `cargo test --locked`: 180 passed, 2 existing ignored tests after review repairs.
- `cargo check --locked`: passed.
- A temporary Rust probe compiled the actual Desktop reader and read the
  installed data: 20 exact CLI titles loaded, including the session whose
  transcript has no title, and the historical 0% / 44% usage sample decoded.
  The probe only reads metadata; it does not launch OC-Claw or install hooks.
- `python scripts/test_claude_hook_transport.py`: 4 passed during earlier PR
  validation; scripts are unchanged by the delivery-ack/CLI-state repair. This
  includes actual PowerShell transport of an idless approval with large Unicode parameters and
  a standalone observer without Bash. Unix fixtures preserve the original
  statusline's stdin/stdout/exit code and use socket mocks.
- `python scripts/test_codex_hook_transport.py`: 7 passed during the original
  PR validation; no Codex transport changes in the review repairs.
- `pnpm build` and `pnpm exec tauri build --no-bundle`: passed.
- `pnpm lint`: advisory baseline findings, including Tauri generated assets
  incorrectly included by the existing lint configuration. Comparison of the
  modified frontend files against the previous PR head added no findings;
  the new approval submission helper/tests have no lint findings.
- `cargo fmt --check`: repository baseline differences remain; new modules are
  formatted. No broad formatting cleanup is included.

## Pending native acceptance

1. Verify the directly queried Desktop quota is displayed by the new app,
   including manual refresh, account switch, and 429 diagnostics. HTTP 200 and
   real utilization/reset fields are confirmed; installed UI rendering and
   Desktop statusline support remain unverified.
2. Compare the displayed session title with Claude's title, including `/rename`
   while active and after Stop.
3. Exercise deny, allow once, session rule, and explicit bypass-mode selection
   on a harmless command; confirm Claude actually consumes the selected response.
4. Verify disconnected/expired relay returns to native approval, and an old
   popup cannot act on a replacement request.
5. Run a long quiet tool/reasoning interval, a question, and descendant work
   past root Stop; confirm the session remains logically active until the
   relevant lifecycle completion or process exit.

The read-only HTTP probe establishes real account quota capture. Automated
fixtures and compilation do not establish Desktop GUI acceptance.
