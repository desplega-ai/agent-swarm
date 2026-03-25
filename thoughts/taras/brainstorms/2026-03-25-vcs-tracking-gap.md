---
date: 2026-03-25T18:00:00-04:00
author: Claude + Taras
topic: "Closing the VCS tracking gap for agent-created PRs"
tags: [brainstorm, github, vcs, task-lifecycle, pr-tracking]
status: in-progress
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

[Q&A pairs accumulate here during the session]

## Synthesis

### Key Decisions
- [Filled after exploration]

### Open Questions
- [Filled after exploration]

### Constraints Identified
- [Filled after exploration]

### Core Requirements
- [Filled after exploration]

## Next Steps

- [Handoff decision: research, plan, or parked]
