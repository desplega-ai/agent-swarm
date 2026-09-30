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
| fanout-research | 1 | Lead + 3 workers, 45 seeded incidents in 3 region shards (Phase 7). |
| fanout-research-solo | 1 | Single-agent baseline of fanout-research (Phase 7, plan Q6). |
| worker-recovery | 1 | Lead + 2 workers, clerk-2's ledger poisoned at seed time (Phase 7). |
| worker-recovery-solo | 1 | Single-agent baseline of worker-recovery (Phase 7, plan Q6). |
| implement-review | 1 | Lead + coder + reviewer; reviewer alone holds the spec exposing a planted bug (Phase 8). |
| implement-review-solo | 1 | Single-agent baseline of implement-review (Phase 8, plan Q6). |
| capability-routing | 1 | Lead + 3 workers with declared profiles; each input on one worker only (Phase 8). |
| human-in-loop | 1 | Ambiguous export, canned reply to request-human-input (Phase 8). |
| human-in-loop-solo | 1 | Single-agent baseline of human-in-loop (Phase 8, plan Q6). |

Versions 1 above are the state of `main` when versioning was introduced
(Phase 3); earlier fixes (Phases 1-2) predate it and are not versioned.

## Changes

### delegation-chain v2

`childOrder` ordered a correct chain wrongly for 3 of the 6 orders the API can
list its tasks in. The API lists newest first, so a real correct run arrives as
three, two, one. `childOrder` feeds `delegation-chain-paper-trail` (flow facts)
and `delegation-chain-dispatch-structure` (per-hop identity, topic, real work).
Measured on the Phase 3 reference solution listed newest first: aggregate 0.743
and `passed = false` before, 1.000 and `passed = true` after. Children are now
ordered by dependency depth, independent of listing order. Found by the
reference-solution test; a null-agent-only test would not have seen it.
