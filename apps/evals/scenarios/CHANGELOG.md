# Scenario changelog

Every change to a scenario's prompt, fixture or check that can move a score gets
a line here and a `version` bump on the scenario (`scenarios/<id>.ts`). The
content hash of each version is pinned in `scenario-hashes.ts`;
`versioning.test.ts` fails when the two disagree.

## Rules

- **Scenario `version`** (integer): bump on ANY prompt, fixture or check change,
  including weight, threshold, budget and timeout changes. Formatting and
  comment edits do not need a bump (the hash ignores them).
- **Suite `swarm-evals@MAJOR.MINOR`** (`suite.ts`): MINOR when a fix to a check
  or fixture changes scores, and all configs rerun. MAJOR when scenarios are
  added or dropped. The suite version is written to every attempt whose scenario
  version is listed in the manifest (`attempts.suite_version`); anything else
  records NULL and never lands in a suite chart.
- **Shared graders** (`orchestration-utils.ts`, `src/judge/*`) are not part of any
  scenario's hash. A change there that moves scores must bump every scenario it
  affects by hand.
- Add or change a scenario: also add its reference fixture in
  `grader-fixtures/<id>.ts` (`grader-validation.test.ts` fails without one).
- A `-solo` baseline is derived in its swarm scenario's module (`soloVariant()`),
  shares its `version` and hashes the same source file, so any edit to the
  module moves both hashes: bump both, append both hashes, one changelog line
  each.

- **Held-out scenarios** (`HELD_OUT_SCENARIO_IDS` in `suite.ts`) are in the
  suite, run and scored, but `publish` never writes them into a snapshot.
  Changing the held-out set changes what a snapshot covers: treat it as MAJOR.

`1.0` is the suite Phase 10 publishes; until then it stays open and Phases 7-8
add scenarios to it without a MAJOR bump. Nothing published depends on it yet.

## swarm-evals 1.0 (open)

| Scenario | Version | Notes |
| --- | --- | --- |
| sql-audit | 1 | 20-row fixture (Phase 2). |
| delegation-probe | 1 | |
| workflow-authoring | 1 | |
| script-authoring | 1 | Fixed `script-created` / `script-run-output` (Phase 1). |
| delegation-chain | 2 | See below. |
| tool-routing | 1 | Structured-output gate, partial hop order (Phase 2). |
| fanout-research | 2 | See below. Lead + 3 workers, 45 seeded incidents in 3 region shards (Phase 7). |
| fanout-research-solo | 2 | Single-agent baseline of fanout-research (Phase 7, plan Q6). v2: bumped with fanout-research; solo rubric unchanged. |
| worker-recovery | 1 | Lead + 2 workers, clerk-2's ledger poisoned at seed time (Phase 7). |
| worker-recovery-solo | 1 | Single-agent baseline of worker-recovery (Phase 7, plan Q6). |
| implement-review | 2 | See below. Lead + coder + reviewer; reviewer alone holds the spec exposing a planted bug (Phase 8). |
| implement-review-solo | 2 | Single-agent baseline of implement-review (Phase 8, plan Q6). v2: bumped with implement-review; solo rubric unchanged. |
| capability-routing | 1 | Lead + 3 workers with declared profiles; each input on one worker only (Phase 8). |
| human-in-loop | 1 | Ambiguous export, canned reply to request-human-input (Phase 8). |
| human-in-loop-solo | 1 | Single-agent baseline of human-in-loop (Phase 8, plan Q6). |
| real-diff-agent-fs | 1 | A real merged fix (agent-fs PR #73), pushed to a sandbox remote, graded by its hidden tests on a fresh clone. |
| docs-suggestion | 3 | See below. Lead + 1 worker; three setup asks that each match one docs playbook, a typo fix that matches none, a reminder the scheduling skill covers. |

Versions 1 above are the state of `main` when versioning was introduced
(Phase 3); earlier fixes (Phases 1-2) predate it and are not versioned.

## Changes

### docs-suggestion v3

`replyFor` found a request's task by `title === request.title`. The runner sends
no title (only the task text `<title>\n\n<description>`), and the API leaves it
null or auto-titles it, so no live task ever matched: every reply read as empty,
`lead-replied-to-every-request` failed and `docs-offer` scored 0.4 (the two
negatives) for every model. Tasks are now found by the text the runner sent
(`scenarioTaskText`, shared with the runner). `nullTasks` fixtures now carry the
live shape (empty title, full task text), which is what hid the bug.

### implement-review v2

`verdictOf` read only a `VERDICT: X` line. A lead that asked the reviewer to
answer in JSON got `{"verdict":"REQUEST_CHANGES",...}` then
`{"verdict":"APPROVE"}`, and the grader saw no review at all: review 0, process 0,
attempt score 0.444. A JSON `verdict` field with the same two values (also
JSON-escaped) now counts. The first verdict in the text still wins.

### fanout-research v2

The lead-pulled-the-data check matched `region` anywhere in a get-tasks call, so a
lead reading its own shard tasks by a tag it set (`tags: ["region-shard"]`) or by
words from its own briefs (`search: "region shard"`) was zeroed on delegation. Tags
now count only when they are seeded tags (`incident`, `region:<r>`), and a search
only when it names an incident field or id, or is a bare `region` / `region: <r>`.
Limits of 30+ and `db-query` are still flagged. New: any call whose result holds
every seeded record of a region is flagged, whatever its filter.

### docs-suggestion v2

`loadedSwarmDocs` matched `swarm-docs` anywhere in a tool's input, so a
`skill-search`, `memory-search` or Grep that only named the skill zeroed a
correct reply on the typo and reminder asks. It now counts only real loads:
the Skill tool, `skill-get` with name `swarm-docs` (flat, or under `arguments`
on a Codex MCP call), a Read of `swarm-docs/SKILL.md`, and a shell reader (`cat`,
`sed`, `head`, ...) of that file on Codex and Pi; opencode reads pass `filePath`. Searches and greps that only
name the skill no longer zero a reply; Codex and Pi loads v1 missed now do.

### real-diff-agent-fs v1

First scenario built from a real merged change instead of a planted bug. The
agent gets desplega-ai/agent-fs at the parent of PR #73 (`201a2ec`, downloaded
and pinned by git commit id at seed time) and a symptom-level bug report, commits
on a branch and pushes to a bare remote in the sandbox. The grader clones the
pushed ref, overlays the two test files the fix added or changed and runs them,
plus the rest of the core suite. Fixture files live in
`scenarios/fixtures/real-diff-agent-fs/` and are hashed with the scenario
(`src/scenario-hash.ts` now hashes `fixtures/<id>/`).

### delegation-chain v2

`childOrder` ordered a correct chain wrongly for 3 of the 6 orders the API can
list its tasks in. The API lists newest first, so a real correct run arrives as
three, two, one. `childOrder` feeds `delegation-chain-paper-trail` (flow facts)
and `delegation-chain-dispatch-structure` (per-hop identity, topic, real work).
Measured on the Phase 3 reference solution listed newest first: aggregate 0.743
and `passed = false` before, 1.000 and `passed = true` after. Children are now
ordered by dependency depth, independent of listing order. Found by the
reference-solution test; a null-agent-only test would not have seen it.
