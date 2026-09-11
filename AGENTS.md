# Agent Guidelines & Project Conventions

This file contains stable, repository-level rules for coding agents working on `oc-claw`. Keep it focused on behavior, validation, and collaboration conventions. Fast-changing architecture details, protocol payloads, endpoint values, UI measurements/colors, and machine-specific setup belong in code, tests, or `docs/`, not here.

---

## 1. Scope & Sources of Truth

- Work only inside the `oc-claw` repository unless the user explicitly asks otherwise.
- Before changing behavior, inspect the current implementation, nearby tests, and relevant workflows. Prefer current code/tests over stale prose descriptions.
- Keep changes scoped to the requested task. Do not mix unrelated cleanup, formatting churn, or speculative refactors into the same change.
- Do not add machine-specific absolute paths, local proxy ports, credentials, tokens, or tool-install locations to repository guidance.
- Preserve cross-platform behavior. A Windows fix must not casually remove or bypass macOS/Linux logic, and vice versa.

---

## 2. Core Behavioral Invariants

These are project-level invariants. Implementation details may change, but fixes should preserve them unless the task explicitly changes the design.

### Session, Turn & Subagent Lifecycle

- Treat explicit harness/lifecycle events as the authority for whether work is active or complete. Metadata is descriptive and must not terminate a live turn.
- Silence, elapsed wall-clock time, or a newer database/message timestamp is not sufficient evidence that a turn completed.
- A root session remains logically active while descendant/subagent work required by that turn is still active.
- Nested subagents must preserve lineage and identity; do not collapse distinct descendants into one generic entry merely because display names collide or metadata is incomplete.
- Scope asynchronous and delayed events to the session/turn/agent that produced them. Stale events from an older turn must not mutate a newer active turn.

### Approval & Tool Interaction

- Preserve each harness's native approval flow by default. Observation/relay hooks must not silently auto-approve, auto-deny, or block native interaction unless that behavior is an explicit requirement.
- Interactive-question/waiting state must be distinguished from ordinary tool execution; normal tool activity should not be presented as waiting for the user.

### Presentation State

- Temporary presentation suppression (for example fullscreen/tray hide) must not destroy the underlying logical session or bubble lifecycle.
- Animation state, native-window geometry, and visual transitions are presentation concerns; they must not become accidental sources of truth for session completion or ownership.
- Prefer explicit lifecycle/acknowledgement state over arbitrary delays when fixing races.

---

## 3. Implementation & Regression-Fix Rules

- Reproduce or identify the failing state transition before changing code when practical.
- For regressions, add or update the smallest test that captures the broken invariant whenever the behavior is testable.
- Prefer fixing ownership/state-transition mistakes at their source instead of layering timers or duplicate state flags around the symptom.
- Preserve useful existing comments/docstrings; update or remove them only when the behavior they describe changed.
- Do not broaden the task merely because adjacent cleanup looks attractive. Mention follow-up work separately when useful.

---

## 4. Validation

Use the repository's checked-in toolchain and lockfiles. `frontend/package.json` is pnpm-based; do not substitute npm/npx commands in project guidance when an equivalent pnpm command exists.

### Frontend / TypeScript / React changes

From `frontend/`:

```bash
pnpm test
pnpm build
pnpm lint
```

- `pnpm build` includes the TypeScript build/type check.
- Lint currently has a known repository baseline and is advisory in CI. Do not introduce new lint findings in touched code; report pre-existing findings instead of hiding them with unrelated cleanup.

### Rust changes

From `frontend/src-tauri/`:

```bash
cargo fmt --check
cargo check --locked
cargo test --locked
```

- `cargo fmt --check` currently has a known repository baseline and is advisory in CI. Avoid introducing new formatting drift in touched code.

### Cross-layer / native-window / build-system changes

In addition to the relevant checks above, run from `frontend/` when the change can affect Tauri integration or release compilation:

```bash
pnpm exec tauri build --no-bundle
```

### Documentation-only changes

- No local compile is required for pure prose-only edits unless the documentation change also modifies executable examples, workflow/config files, or generated content.
- PR CI is still expected to run normally.

Always report what was actually run. Never claim a test or manual scenario passed if it was not executed.

---

## 5. Git & Pull Request Rules

### Branching

- Default workflow: **branch -> commit(s) -> push -> pull request -> review/validation -> squash merge**.
- Do not push directly to `main` unless the user explicitly requests that exception.
- Branch from the latest practical `main` state and keep one logical goal per branch/PR.
- Prefer short descriptive branch names such as:
  - `feat/<topic>`
  - `fix/<topic>`
  - `refactor/<topic>`
  - `docs/<topic>`
  - `test/<topic>`
  - `ci/<topic>`
  - `chore/<topic>`
- Do not silently include another open PR's changes. If a task depends on an unmerged PR, state that dependency clearly and avoid accidental stacking.

### PR title

Use a concise Conventional Commit-style title whenever practical:

```text
feat(scope): add ...
fix(scope): prevent ...
refactor(scope): simplify ...
docs: clarify ...
ci: add ...
```

The title should describe the user-visible or architectural outcome, not the implementation process.

### PR body

A normal PR should include:

1. **Summary** — what problem or goal the PR addresses.
2. **Changes** — the important implementation changes, kept concise.
3. **Validation** — automated commands actually run plus manual scenarios still required.
4. **Risks / Follow-up** — only when relevant; call out known limitations, unverified GUI behavior, migrations, or dependent PRs.

For bug fixes, explain the failure mode/root cause when known. For race/state-machine fixes, name the state transition or stale-event path being guarded.

### PR scope & follow-up edits

- Keep unrelated refactors and formatting changes out of the PR.
- If review finds follow-up issues within the same logical task, update the same branch/PR, rerun the relevant checks, and review the full resulting diff again.
- If `main` changes underneath the PR, re-check assumptions and conflicts before merge, especially for lifecycle/state-machine work that overlaps nearby changes.

### Merge rules

- Passing CI is necessary for normal code changes but is not permission to merge by itself.
- **Never merge a PR merely because it looks clean or CI is green. Require explicit user approval to merge.**
- Default merge method is **squash** unless the user explicitly requests another strategy.
- Before merging, verify that the intended diff is still the PR's complete scope, required checks are green (aside from documented advisory baseline jobs), and any required manual/user validation has been acknowledged.
- Do not manually move the rolling `dev` tag, publish a release, or create a version tag unless the user explicitly asks. Release workflows are the source of truth for publishing behavior.

---

## 6. What Belongs in `AGENTS.md`

Keep this file limited to durable instructions that materially change how coding agents should work in the repository.

Appropriate here:
- repository scope and safety boundaries;
- durable lifecycle/behavioral invariants;
- validation expectations;
- branch, PR, review, and merge conventions.

Prefer `docs/`, code comments, tests, or the implementation itself for:
- exact hook payloads, socket addresses, endpoints, plugin versions, or protocol internals;
- component-specific dimensions, colors, layout details, and product screenshots;
- temporary debugging procedures or one-off migration notes;
- personal Obsidian/vault workflows;
- local GitHub CLI paths, proxy configuration, or other machine-specific environment setup.

When one of those details becomes important to a future task, inspect the current implementation instead of copying a historical snapshot back into this file.
