---
date: 2026-04-03T12:00:00-07:00
researcher: Claude
git_commit: 1488e30077bd8a0cba21caffc11b0872214a6db6
branch: main
repository: agent-swarm
topic: "CI Hooks, Pre-commit Enforcement, and PR Quality for Agent Workers"
tags: [research, ci, git-hooks, pre-commit, pre-push, prek, docker, templates, prompts, pr-quality]
status: complete
autonomy: verbose
last_updated: 2026-04-03
last_updated_by: Claude
---

# Research: CI Hooks, Pre-commit Enforcement, and PR Quality for Agent Workers

**Date**: 2026-04-03
**Researcher**: Claude
**Git Commit**: `1488e300`
**Branch**: `main`

## Research Question

A user reports that agents recurrently send PRs with failing CI (tests, linting). The user believed linting was part of pre-commit hooks, but agents appear to skip them. Additionally, agents don't autonomously fix CI failures after PR creation unless explicitly told. How does the codebase handle CI checks, git hooks, commit/PR workflows, and post-PR monitoring?

## Summary

The agent-swarm system has **seven distinct gaps** that collectively cause PRs to be created with failing CI and prevent autonomous remediation:

1. **No pre-commit hooks exist** -- `prek.toml` configures all quality checks (lint, typecheck, tests) as `pre-push` hooks only. There is no `pre-commit` hook anywhere in the project.

2. **Docker workers don't have `prek` installed** -- The `Dockerfile.worker` installs git, gh, and glab, but NOT the `prek` hook manager. When repos are cloned inside Docker containers, `.git/hooks/` only contains default sample hooks. Pre-push hooks from `prek.toml` never run in Docker.

3. **The `/create-pr` command has no pre-check steps** -- The PR creation workflow goes directly from "verify state" to "push branch" to "create PR" with no step to run tests, linters, or type checks.

4. **Template instructions are advisory, not enforced** -- The coder template says "Run linters and type checks before committing" (`coder/CLAUDE.md:38`) and "Always run the full test suite before pushing" (`coder/CLAUDE.md:32`), but these are natural language suggestions that depend on the AI following instructions. They are not mechanically enforced.

5. **CI webhook handlers are deliberately suppressed** -- Infrastructure for `check_run`, `check_suite`, and `workflow_run` events exists (types, handlers, prompt templates) but all handlers return `{ created: false }` without creating tasks. This was done to prevent auto-merge cascades (see `thoughts/taras/brainstorms/2026-03-28-pr-auto-merge-safety.md`).

6. **No post-PR CI monitoring mechanism exists** -- There is no code that polls CI status, watches for failures, or triggers auto-fix workflows. The only CI-checking mechanism is the reviewer's `/review-pr` command, which is reactive (runs when a reviewer agent is assigned, not proactively after PR creation).

7. **The lead template has no merge-safety instructions** -- The `templates/official/lead/` directory contains no instructions about CI checks, merge conditions, or when auto-merge is appropriate. The lead's merge decisions are entirely emergent from agent autonomy + `gh` CLI access.

## Detailed Findings

### 1. Git Hooks Configuration

> **Important framing note**: The agent-swarm project's own hook setup (prek, biome, etc.) is described below for reference, but the swarm operates on **arbitrary user-configured projects**. The real issue is that the swarm has no general mechanism to ensure agents respect or run whatever hooks/checks a target project has — regardless of what those hooks are. The solution must be project-agnostic.

#### Agent-Swarm's Own Setup (for reference)

The agent-swarm project uses `prek` (a pre-push hook manager) configured via `prek.toml`. Key observations:

- All 7 quality checks (biome-lint, typecheck, tests, db-boundary, pi-skills-freshness, new-ui-lint, new-ui-typecheck) are configured as `pre-push` only — there are no `pre-commit` hooks.
- Docker workers don't have `prek` installed, so even these pre-push hooks don't run in containers.

#### The General Problem

When a swarm agent works on any user project:
- **The agent clones the repo fresh** (via `gh repo clone` or `git clone` in `docker-entrypoint.sh` or `runner.ts:ensureRepoForTask`). Fresh clones don't have locally-installed hooks (e.g., husky, lefthook, prek) unless the project's `prepare` or `postinstall` script sets them up.
- **Even if the project has hook setup scripts**, the Docker container may not have the hook manager installed (husky, lefthook, prek, etc.).
- **The agent can always bypass hooks** — Claude Code runs with `--dangerously-skip-permissions`, and there's no mechanism preventing `--no-verify` flags (though no template currently instructs agents to use them).
- **The swarm has no awareness of what CI checks a project runs** — it doesn't read CI config files to know what to run locally before pushing.

### 2. Docker Worker Environment

The `Dockerfile.worker` installs these tools (`Dockerfile.worker:38-54`):
- `git`, `git-lfs`
- `gh` (GitHub CLI)
- `glab` (GitLab CLI, pinned v1.89.0)

It does NOT install:
- `prek` (pre-push hook manager)
- `biome` (linter -- available via `bun run lint` but hooks don't trigger it)
- Any git hook setup mechanism

The Docker `settings.json` (`Dockerfile.worker:114-128`) configures Claude Code hooks for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `Stop` -- but these call `agent-swarm hook` for heartbeat/cancellation/file-sync, NOT for code quality gates.

Claude Code is spawned with `--dangerously-skip-permissions` (`src/providers/claude-adapter.ts:232-235`), meaning all Bash commands execute without approval.

### 3. Template Instructions About CI/Testing

#### Coder Template (the implementation agent)

Three files reinforce CI/testing expectations, but only as natural language:

- `templates/official/coder/CLAUDE.md:32`: "Always run the full test suite before pushing -- no exceptions"
- `templates/official/coder/CLAUDE.md:38`: "Run linters and type checks before committing"
- `templates/official/coder/SOUL.md:31`: "Tests before push. Every push should have a green test suite behind it. No exceptions."
- `templates/official/coder/IDENTITY.md:23`: "Test-first verification. I run the full test suite before pushing."

#### Reviewer Template (the quality gate agent)

- `templates/official/reviewer/SOUL.md:33`: "CI must be green. Never approve a PR with failing CI checks. No exceptions."
- `templates/official/reviewer/CLAUDE.md:40-42`: "Before approving any PR, verify that all CI checks are passing (`gh pr checks`). If any CI check is failing, you MUST request changes."

#### Lead Template

- **No instructions about CI, merging, auto-merge, or PR quality** exist in `templates/official/lead/`. The lead agent's merge behavior is entirely emergent.

#### Other Templates

- `tester/`, `researcher/`, `content-writer/`, `content-reviewer/`, `content-strategist/`, `forward-deployed-engineer/` -- No CI/testing/commit instructions.

### 4. Plugin Commands (Slash Commands)

#### `/create-pr` (`plugin/commands/create-pr.md`)

Workflow steps:
1. Verify state (in git repo, not on main, have commits)
2. Push branch (`git push -u origin HEAD`)
3. Gather context (commit messages, changed files)
4. Generate title/description
5. Create PR (`gh pr create` / `glab mr create`)
6. Report URL

**No step for running tests, linters, or type checks.**

#### `/implement-issue` (`plugin/commands/implement-issue.md`)

Workflow steps include clone, branch, implement, commit, push, create PR. At the bottom, a "Tips" section (line 59) states: "Run linters and tests before creating the PR." This is **advisory text in a tips section**, not a mandatory workflow step.

#### `/review-pr` (`plugin/commands/review-pr.md`)

This command has the strongest CI enforcement, but it runs AFTER the PR is created:
- Step 2 (MANDATORY, lines 25-29): Check CI with `gh pr checks`. Failing CI = automatic `REQUEST_CHANGES`.
- Step 3 (MANDATORY, lines 31-39): Verify tests are included. No tests = automatic `REQUEST_CHANGES`.

### 5. CI Pipeline (merge-gate.yml)

The merge gate (`.github/workflows/merge-gate.yml`) runs on PRs to `main` with 7 check jobs + 1 aggregator:

| Job | Check | Local Command |
|-----|-------|---------------|
| `lint-and-typecheck` | Biome lint | `bun run lint` |
| `lint-and-typecheck` | TypeScript | `bun run tsc:check` |
| `lint-and-typecheck` | DB boundary | `bash scripts/check-db-boundary.sh` |
| `test` | Unit tests | `bun test` |
| `pi-skills-freshness` | Pi-skills drift | `bun run build:pi-skills` + diff |
| `openapi-freshness` | OpenAPI drift | `bun run docs:openapi` + diff |
| `docker-build` | Docker builds | `docker build -f Dockerfile .` |
| `new-ui-lint` | UI lint + typecheck | `cd new-ui && pnpm lint && pnpm exec tsc -b` |
| `gate` | All jobs pass | (aggregator) |

All checks are detectable locally before pushing. The CLAUDE.md documents a pre-PR checklist (lines 273-284), but this is for human developers working on the agent-swarm repo itself, not injected into agent worker prompts.

### 6. CI Webhook Infrastructure (Suppressed)

Full infrastructure exists but is deliberately disabled:

- **Handlers** (`src/github/handlers.ts:919-974`): `handleCheckRun`, `handleCheckSuite`, `handleWorkflowRun` -- all log as `[GitHub:suppressed]` and return `{ created: false }`.
- **Types** (`src/github/types.ts:69-159`): `CheckRunEvent`, `CheckSuiteEvent`, `WorkflowRunEvent` fully defined.
- **Prompt templates** (`src/github/templates.ts:377-453`): `github.check_run.failed`, `github.check_suite.failed`, `github.workflow_run.failed` -- fully written with guidance like "CI check failed. Review the logs and fix the issue." but never triggered.
- **Webhook routing** (`src/http/webhooks.ts:160-168`): Events routed to handlers but NOT emitted to `workflowEventBus`.

Suppression rationale: Prevent auto-merge cascades where agents auto-merge PRs without meaningful human review (`thoughts/taras/brainstorms/2026-03-28-pr-auto-merge-safety.md`).

### 7. The Hook System (`src/hooks/hook.ts`)

The Claude Code hook system runs on every lifecycle event but does NOT gate code quality:

| Event | What it does |
|-------|-------------|
| `SessionStart` | Pings server for heartbeat |
| `UserPromptSubmit` | Detects task cancellation |
| `PreToolUse` | Cancellation check, tool loop detection, shared disk write blocking |
| `PostToolUse` | File sync (SOUL.md, IDENTITY.md, etc.), write failure detection |
| `PreCompact` | Context management |
| `Stop` | Session cleanup |

There is no `PreToolUse` hook that intercepts `git commit` or `git push` to enforce running tests/lint first.

### 8. System Prompt Assembly

The system prompt is assembled in `src/prompts/base-prompt.ts:47-173`:
1. Session template (swarm mechanics -- no CI instructions)
2. SOUL.md + IDENTITY.md (personality -- coder has CI mentions, others don't)
3. Template CLAUDE.md (operational -- coder has CI mentions)
4. Repo-context CLAUDE.md (from the cloned project's own CLAUDE.md)

The system prompt templates (`src/prompts/session-templates.ts`) contain **zero instructions** about testing, linting, or CI. All quality instructions come exclusively from template identity files, which only the `coder` and `reviewer` templates include.

Agents created without an official template (via `src/prompts/defaults.ts`) get **no CI/quality instructions** at all.

## Code References

| File | Line | Description |
|------|------|-------------|
| `prek.toml` | 1-75 | All 7 hooks configured as `pre-push` only |
| `.git/hooks/` | -- | No `pre-commit` hook exists |
| `Dockerfile.worker` | 38-54 | Installs git/gh/glab but NOT prek |
| `Dockerfile.worker` | 114-128 | Docker settings.json -- hooks for heartbeat, not quality gates |
| `src/providers/claude-adapter.ts` | 232-235 | `--dangerously-skip-permissions` flag |
| `plugin/commands/create-pr.md` | 23-31 | PR creation workflow -- no test/lint step |
| `plugin/commands/implement-issue.md` | 59 | "Run linters and tests" as a tip only |
| `plugin/commands/review-pr.md` | 25-29 | CI check as MANDATORY step (review time, not creation time) |
| `templates/official/coder/CLAUDE.md` | 32, 38 | Advisory "run tests" and "run linters" instructions |
| `templates/official/coder/SOUL.md` | 31 | "Tests before push. No exceptions." (advisory) |
| `templates/official/reviewer/CLAUDE.md` | 40-42 | "Verify CI passing via `gh pr checks`" |
| `templates/official/lead/` | -- | No merge/CI/quality instructions at all |
| `src/github/handlers.ts` | 919-974 | CI event handlers -- all suppressed |
| `src/github/templates.ts` | 377-453 | CI failure prompt templates -- defined but never triggered |
| `src/hooks/hook.ts` | -- | Handles heartbeat/cancellation, NOT code quality |
| `src/prompts/session-templates.ts` | -- | System templates have zero CI/testing instructions |
| `src/prompts/defaults.ts` | -- | Default templates have zero CI/quality instructions |
| `.github/workflows/merge-gate.yml` | 1-234 | Full CI pipeline -- catches failures but only after push |

## Architecture Documentation

### Current Quality Gate Architecture

```
                  COMMIT          PUSH           PR CREATED          CI RUNS         REVIEW
                    │               │                │                  │               │
Local dev:     [no hook]    [prek pre-push]          │           [merge-gate]    [reviewer agent]
                              ✓ lint                 │            ✓ lint          ✓ gh pr checks
                              ✓ typecheck            │            ✓ typecheck
                              ✓ tests                │            ✓ tests
                              ✓ db-boundary          │            ✓ docker build
                                                     │            ✓ freshness
                                                     │
Docker worker: [no hook]    [no hook]         [no checks]    [merge-gate]    [reviewer agent]
                  ↑              ↑                 ↑              │               ↑
                  │              │                 │              │               │
              NO pre-commit  prek NOT          /create-pr     catches it      only runs if
              hook exists    installed         has no          but PR is       reviewer is
                                               test/lint      already open    assigned
                                               step
```

### Gap Analysis

| Layer | Local Dev | Docker Worker | Gap |
|-------|-----------|---------------|-----|
| Pre-commit hook | Not configured | Not configured | No quality gate at commit time |
| Pre-push hook | `prek` runs lint/test/typecheck | `prek` not installed, no hooks | Workers push without checks |
| PR creation command | N/A | No test/lint step in `/create-pr` | PRs created without verification |
| Template instructions | N/A | Advisory only in coder SOUL/CLAUDE | Agents may not follow |
| CI pipeline | merge-gate catches failures | merge-gate catches failures | Catches but doesn't fix |
| CI event response | N/A | Handlers suppressed | No auto-task on CI failure |
| Post-PR monitoring | N/A | No mechanism exists | No polling or auto-fix |
| Lead merge decisions | N/A | No merge-safety instructions | Emergent, unguided behavior |

## Historical Context (from thoughts/)

### `thoughts/taras/brainstorms/2026-03-28-pr-auto-merge-safety.md`

Documents why CI events were suppressed: users reported agents auto-merging PRs without sufficient human review. The event cascade (PR created -> checks pass -> review submitted) triggers agent actions that culminate in merge without meaningful human review. The solution was to suppress CI events entirely, which prevents the cascade but also prevents agents from being notified of CI failures.

Key insight from the brainstorm: "The auto-merge isn't hardcoded -- it's emergent. The codebase handles pull_request, pull_request_review, check_run, check_suite, and workflow_run events. Each event can create a task for an agent, and the agent's response to that task may include GitHub actions (approve, merge)."

### `thoughts/taras/plans/2026-03-30-github-event-safety-defaults.md`

Implementation plan for the safety defaults that suppressed CI events. Referenced in handler comments.

### `thoughts/taras/brainstorms/2026-03-25-vcs-tracking-gap.md`

Documents the VCS tracking system design -- the runner's `detectVcsForTask()` that automatically links PRs to tasks. This is the system that tracks PRs after creation but does not monitor their CI status.

## Related Research

- `thoughts/taras/brainstorms/2026-03-28-pr-auto-merge-safety.md` - Why CI events were suppressed
- `thoughts/taras/plans/2026-03-30-github-event-safety-defaults.md` - Implementation of event suppression
- `thoughts/taras/brainstorms/2026-03-25-vcs-tracking-gap.md` - VCS tracking system design

## Open Questions

1. **Lead merge behavior is confirmed emergent.** The lead uses `gh pr merge` via the CLI autonomously — there are no template instructions guiding when or whether to merge. This is a gap: the lead has no merge-safety guardrails (e.g., "only merge when CI is green and human review is complete").

2. **Do worktrees (created via `wts`) inherit git hooks?** Git worktrees share the same `.git` directory, so hooks should be shared. But it's unclear if `wts create` ensures hook managers (prek, husky, etc.) are properly set up in worktrees. (Unconfirmed)

3. **Could the `PreToolUse` hook intercept git operations?** The hook system already intercepts every tool use. It could be extended to detect `git commit` / `git push` / `gh pr create` in Bash calls and enforce pre-checks. **Important constraint**: any solution must also work for the pi-mono provider, not just Claude Code — pi-mono has a different tool execution model and may not have the same hook interception capability.

4. **Better prompting as a CI-awareness solution.** Rather than re-enabling the suppressed CI event handlers (which risk cascade merges), improving the prompts — specifically the `/create-pr` command and session templates — could instruct agents to proactively run project checks before pushing and to monitor CI status after PR creation. This is a lower-risk approach that Taras believes could work.

5. **Agents without templates get no CI/quality instructions.** When an agent is created without specifying a `templateId` (e.g., via the API or without matching an official template), the system falls back to `src/prompts/defaults.ts` which generates generic identity/personality prompts with zero CI, testing, or linting instructions. This means any non-coder agent that happens to create a PR (e.g., a custom agent, or one using a community template) gets no guidance about running checks first.
