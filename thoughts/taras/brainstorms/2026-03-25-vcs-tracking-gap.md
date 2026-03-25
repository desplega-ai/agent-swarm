---
date: 2026-03-25T18:00:00-04:00
author: Claude + Taras
topic: "Closing the VCS tracking gap for agent-created PRs"
tags: [brainstorm, github, vcs, task-lifecycle, pr-tracking]
status: complete
exploration_type: problem
last_updated: 2026-03-25
last_updated_by: Claude
---

# Closing the VCS Tracking Gap for Agent-Created PRs — Brainstorm

## Context

### The Problem

When a GitHub webhook creates a task (e.g., bot assigned to PR #42), the task is created with `vcsNumber: 42`, `vcsRepo: "owner/repo"`, etc. Subsequent GitHub events (reviews, CI failures, PR closed) use `findTaskByVcs(repo, number)` to link back to that task. This works.

However, when an agent works on a task (from Slack, manual creation, etc.) and **creates a PR** during execution, the task's `vcsNumber` field is never updated. There is no `UPDATE agent_tasks SET vcsNumber = ...` anywhere in the codebase. This means:

- If someone reviews the agent's PR → `findTaskByVcs()` returns null → review event silently dropped
- If CI fails on the agent's PR → same, silently dropped
- If the PR is merged/closed → no follow-up notification task created

### What We Know

- `vcsNumber` is only set at INSERT time by `createTaskExtended()` in `src/be/db.ts`
- `findTaskByVcs()` is the sole mechanism for linking follow-up events to tasks
- The `send-task` MCP tool accepts `vcsRepo` but NOT `vcsNumber`, `vcsProvider`, `vcsUrl`
- `store-progress` has no VCS-related fields
- The `tracker-link-task` tool links to external trackers (Linear), not VCS PRs
- The `create-pr` skill (plugin) runs `gh pr create` but doesn't call back to the API

### Scope

This is specifically about the **outbound PR creation → inbound webhook linkage** gap. The inbound-only flow (webhook → task) works correctly.

## Exploration

### Q: When should the system learn that a task is associated with a PR?

**Answer:** At PR creation time — explicit linking.

Three options were considered:
1. At PR creation time (explicit) ← **chosen**
2. At webhook time (inference/heuristics)
3. Via post-tool hook (automatic interception)

**Insights:** Explicit is most reliable. Heuristic matching at webhook time is fuzzy and error-prone. Hooks are fragile to output format changes.

### Q: What's the detection mechanism?

**Answer:** Branch detection — check `gh pr list --head <branch>` to see if a PR exists for the current branch.

Rejected alternatives:
- New MCP tool (`link-vcs-to-task`) — requires every agent to learn to call it
- Extend `store-progress` with VCS fields — less friction but still relies on agent behavior
- Extend `create-pr` skill — only covers one path, not provider-agnostic
- Hook on `gh pr create` output — fragile, only works in Claude Code (not Codex, Gemini CLI)

**Insights:** Branch detection is provider-agnostic. Doesn't matter *how* the PR was created (gh CLI, GitHub API, web UI, human). Works for Claude Code, Codex, and Gemini CLI workers equally. The worker already has git access in its working directory.

### Q: When does the branch detection run?

**Answer:** At two moments:
1. **On `store-progress` calls** — catches PRs created mid-task
2. **At task completion** — catches any remaining PRs

**Insights:** `store-progress` is already the natural mid-task checkpoint. Agents call it after meaningful work (including after creating PRs). Task completion is the final safety net. No need for periodic/heartbeat checks — too much overhead and GitHub API rate limit risk.

### Q: Where does the detection logic run?

**Answer:** Worker detects, reports to API.

Flow: Worker runs `git branch --show-current` + `gh pr list --head <branch> --json number,url,repository` → if PR found, sends to new API endpoint (e.g., `PATCH /api/tasks/:id/vcs`).

**Insights:** Keeps the worker/API DB boundary clean. Worker has git/gh access. API owns the DB. New endpoint is simple — just updates `vcsNumber`, `vcsRepo`, `vcsProvider`, `vcsUrl` on the task row.

### Q: Should this be automatic or opt-in?

**Answer:** Automatic in the runner. Baked into the runner code for every task that has a `vcsRepo` or `dir` set. Zero agent awareness needed.

**Insights:** Opt-in would rely on agents/skills cooperating — defeats the purpose. The whole point is to close the gap transparently.

### Q: How to handle multiple PRs per task?

**Answer:** Last PR wins. The `vcsNumber` field is a single value — overwrite on each new detection. Revisit if this becomes a real problem.

**Insights:** Multiple PRs per task is rare (closed + reopened, or stacked PRs). YAGNI applies here. A `vcs_links` table would add complexity for a ~1% edge case.

## Synthesis

### Key Decisions

1. **Branch detection as primary mechanism** — check `gh pr list --head <branch>` to find associated PRs
2. **Runs automatically in the runner** at `store-progress` and task completion — no agent awareness needed
3. **Worker detects, API stores** — worker runs git/gh commands, calls `PATCH /api/tasks/:id/vcs` on the API
4. **Last PR wins** — single `vcsNumber` field, overwrite on new detection
5. **Provider-agnostic** — works for Claude Code, Codex, Gemini CLI, and human-created PRs

### Open Questions

- Should the detection also set `vcsProvider` automatically (infer from `gh` vs `glab` availability)?
- Rate limiting: if many tasks check `gh pr list` simultaneously, could we hit GitHub API limits? May need a cache or throttle.
- Should we also detect MRs for GitLab tasks? Same pattern with `glab mr list --source-branch <branch>`.
- What happens if the worker's `gh` CLI isn't authenticated? Need a graceful fallback (skip detection, log warning).

### Constraints Identified

- Worker/API DB boundary must be maintained — worker never writes to DB directly
- `gh` CLI must be available and authenticated in the Docker worker
- GitHub API rate limits (5000/hr for authenticated, 60/hr for unauthenticated)
- Detection must not block or slow down `store-progress` — should be async/fire-and-forget

### Core Requirements

1. **New DB function:** `updateTaskVcs(taskId, { vcsProvider, vcsRepo, vcsNumber, vcsUrl })` in `db.ts`
2. **New HTTP endpoint:** `PATCH /api/tasks/:id/vcs` — accepts VCS fields, calls `updateTaskVcs`
3. **Runner integration:** After `store-progress` and at task completion, run branch detection → if PR found and task has no `vcsNumber`, call the endpoint
4. **Detection logic:** `git rev-parse --is-inside-work-tree` → `git branch --show-current` → `gh pr list --head <branch> --json number,url,headRepository` → parse and report
5. **Idempotent:** If `vcsNumber` is already set (e.g., task came from a webhook), skip detection

## Next Steps

- Create a plan via `/create-plan` based on this brainstorm
