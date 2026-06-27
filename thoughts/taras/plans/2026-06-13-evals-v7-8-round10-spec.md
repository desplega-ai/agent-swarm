---
date: 2026-06-13T00:30:00Z
topic: "Evals v7.8 (round 10) — topological task scheduling for parallel deps, per-task worker attribution w/ crown for lead"
status: in-progress
branch: feat/evals-subproject
pr: 737
---

# Evals v7.8 (round 10)

From Taras 2026-06-13 ~00:25. Two items.

## 1. Topological task scheduling (parallel tasks + deps)

Scenarios can define tasks with `dependsOn` (R6 native swarm deps) AND independent tasks that
should run in PARALLEL across workers. The runner must:
- create tasks in TOPOLOGICAL order (dependencies created before dependents — dependsOn references
  resolve from scenario-local task indices/names to real swarm task ids at creation time, so order
  matters), rejecting cycles with a clear registry/validation error at load time,
- NOT serialize execution beyond what deps require: all roots created up-front so the swarm
  scheduler can hand independent branches to different workers concurrently (verify what the
  current implementation does — if it already creates all tasks up-front in authoring order,
  the fix is topo-sort + cycle validation; if it gates creation on completion, remove the gate),
- keep cascade-skip semantics intact.
Contracts agent verifies current creation flow in evals/src/runner (and SwarmClient.createTask)
before freezing the design. Registry validation: dependsOn references must point at existing
scenario tasks; cycles rejected with the offending chain named.

## 2. Run details: which worker did what task (+ crown for the lead)

Join task.agentId (AttemptTaskJson, v7.5) ↔ the roster (attempt.workers, v7 §10) to show WHO ran
each task:
- left-bar task rows + per-task sub-tab header get the member name (e.g. "Worker 0" / "scribe-a"),
  harness-iconed like roster chips, hover = member detail (configId/model/role),
- the coordinator/lead member renders a CROWN icon (match the main dashboard ui/ convention —
  check how ui/ renders lead agents and reuse the same glyph/icon style) — in task rows, sub-tab
  hovers, AND the Workers/roster section (replace-or-augment the existing LEAD text badge),
- null agentId / no roster (v1-era) → render nothing (back-compat sacred).

## Verification
- Gates: evals tsc + tests + root lint; ui:build; restart :4801.
- Unit: topo-sort (chain, diamond, independent roots, cycle rejection), attribution join nulls.
- E2E (≤$0.6): two-workers × claude-haiku (independent tasks actually claimed by DIFFERENT workers
  — assert both workers' taskIds non-empty in roster) + relay-handoff × claude-haiku (dep chain
  ordering preserved). Assert worker names + lead crown data flow in the attempt payload.
