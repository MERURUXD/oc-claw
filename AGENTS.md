# Agent Guidelines

Shared repository rules for all coding agents working on `oc-claw`.

## Scope and working method

- Work only inside this repository unless the user explicitly asks otherwise. Do not use computer-use unless requested by the user.
- Inspect affected code and nearby tests before changing behavior. Current code/tests take precedence over historical notes; inspect workflows when CI, build, or release behavior matters.
- Locate UI targets from code and available screenshots. Ask only when multiple plausible targets would materially change the implementation.
- Keep changes scoped to the task, preserve user-owned work and cross-platform behavior, and avoid unrelated cleanup or formatting churn.
- Within authorized scope, complete implementation, focused validation, and fixes for failures introduced by the change. Report blockers and continue independent work.
- For regressions, identify the failing transition when practical and add the smallest missing test for the broken invariant and necessary edge cases.
- Fix ownership/state transitions at their source; prefer explicit lifecycle/acknowledgement state over timers or duplicate flags.
- Preserve useful comments unless the behavior they describe changes. Review the final diff and affected call paths.

## Behavioral invariants

### Sessions, turns, and subagents

- Explicit harness/lifecycle events determine whether work is active or complete. Metadata, silence, elapsed time, and newer database/message timestamps must not terminate a live turn.
- A root session remains logically active while descendant work required by that turn is active.
- Preserve nested subagent lineage and identity, including when names collide or metadata is incomplete.
- Scope asynchronous/delayed events to their originating session, turn, and agent. Stale events must not mutate a newer active turn.

### Approval and presentation

- Preserve native harness approval flows. Observation/relay hooks must not silently approve, deny, or block interaction unless explicitly required.
- Distinguish interactive questions/waiting for the user from ordinary tool execution.
- Temporary hiding (fullscreen/tray) must preserve logical session and bubble lifecycles.
- Animation, window geometry, and visual transitions must not determine session completion or ownership.

## Validation

Use checked-in toolchains and lockfiles. Use pnpm, not npm/npx, when an equivalent pnpm command exists.

Choose checks for the affected layer and concrete risks; this table is not a mandatory checklist for every edit. Matching CI evidence may cover a check when commit, configuration, and scope match. Rerun after relevant changes, preserve required CI gates, and stop optional checking once sufficient evidence exists.

| Affected area | Working directory | Checks |
| --- | --- | --- |
| Frontend / TypeScript / React | `frontend/` | `pnpm test`, `pnpm build`, `pnpm lint` |
| Rust | `frontend/src-tauri/` | `cargo fmt --check`, `cargo check --locked`, `cargo test --locked` |
| Tauri integration / native windows / release compilation | `frontend/` | `pnpm exec tauri build --no-bundle` |

- `pnpm build` includes TypeScript checking.
- Lint and Rust formatting currently have advisory CI baselines. Do not introduce new findings in touched code; report existing findings without unrelated cleanup. Workflows define current gates.
- Pure prose edits need no local compile; changes to executable examples, config, workflows, or generated content require relevant validation. PR CI still runs normally.
- Report checks actually run and manual scenarios still unverified. Never claim an unexecuted test or manual scenario passed.

## Git and pull requests

- Default workflow: branch -> commits -> push -> PR -> review/validation -> authorized squash merge. Never push directly to `main` unless explicitly requested.
- An implementation request alone does not authorize commit/push. A request to open a PR authorizes scoped branching, commits, push, and same-scope revisions; advice/review alone does not authorize implementation.
- Branch from the latest practical `main`, use a short descriptive name such as `fix/<topic>` or `docs/<topic>`, and keep one logical goal per PR. Disclose dependencies on unmerged PRs; do not silently include their changes.
- Use a concise Conventional Commit-style title describing the outcome. PR bodies cover the problem, important changes, actual validation, pending manual scenarios, and relevant risks/dependencies. For bugs, explain the root cause when known; for races, name the guarded transition or stale-event path.
- Keep same-scope review fixes in the same PR, rerun relevant checks, and review the resulting diff. If `main` changes, re-check overlapping assumptions and conflicts before merge.
- Merge requires user authorization; green CI alone is insufficient. A conditional request such as "review and merge if clean" authorizes merging once its conditions are met. Use squash unless another strategy is requested.
- Before merging, verify the complete PR scope, required green checks (apart from documented advisory baselines), and acknowledgement of required manual/user validation.
- Authorized merges include the existing automatic dev-release workflow they trigger. Manual releases/tags and publishing-policy changes require separate authorization; workflows define release behavior.

## Maintaining these instructions

Keep shared rules here and `CLAUDE.md` as a minimal import entry point. Include only durable scope, behavior, validation, and collaboration constraints.

Put architecture/protocol details, UI measurements, debugging procedures, and other changing implementation information in code, tests, or `docs/`. Do not put machine-specific paths, ports, credentials, tokens, or tool-install locations in repository guidance.

[Historical implementation notes](docs/development/historical-implementation.md) are optional investigation context, not active instructions or a startup checklist. Read only relevant sections and verify them against current code/tests; do not restore old behavior based on these notes alone.
