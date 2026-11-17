---
date: 2026-11-15T14:20:00Z
topic: "Reject non-positive heartbeat stall thresholds (#3170)"
status: in-progress
---

# Reject non-positive heartbeat stall thresholds (#3170)

## Goal

`HEARTBEAT_STALL_NO_SESSION_MIN` and `HEARTBEAT_STALL_STALE_HB_MIN` accept only a finite,
positive number of minutes (fractions included) and fall back to their documented defaults
(5 and 15) for zero, negative and non-finite values. A PR on `desplega-ai/agent-swarm`
resolves issue #3170 with CI green.

## Decisions

- **Fractions stay legal (`Number.isFinite && value > 0`)** — acceptance criteria name
  fractional minutes explicitly, and the repo's own E2E plans/QA notes run these thresholds
  at `0.1` minutes to shrink a sweep under a test's budget. The sibling
  `stallThresholdMinutes()` stays integer-only: #2838 pinned `1.5 → 30` in a merged test, so
  changing it is a different issue (assumed, noted in the PR body).
- **Coverage is a behavioral unit test, not an e2e scenario** — the bad value can only enter
  through the boot environment: `swarm_config`'s guard already rejects a negative or
  fractional value for both keys, and the e2e runner fixes the SUT env at boot, so no
  black-box scenario can reach the branch. Rule 1's escape hatch (a reason line in
  `scripts/unit-test-allowlist.txt`) is the sanctioned route, and it is how the eight test
  files added since #3032 landed did it.
- **No test-only exports** — the maintainer closed PR #2846 with "drop the `export` on the
  three `stallThreshold*` functions". The test drives `codeLevelTriage()` instead, which is
  the only public entry point that reads both thresholds.
- **Do not touch `swarm-config-guard.ts`** — its `integerValidators` governs DB-saved config,
  a separate path from the deployment env this issue is about.

## Todo

- [x] Fix the two parsers in `src/heartbeat/heartbeat.ts` (shared `positiveMinutes` helper)
- [x] Add `src/tests/heartbeat-stall-thresholds.test.ts` (behavioral, through `codeLevelTriage`)
- [x] Add the test file to `scripts/unit-test-allowlist.txt` with a checkable reason
- [x] Run the focused test, `src/tests/heartbeat.test.ts`, lint, `tsc:check:tsc`,
      `check:unit-test-allowlist`
- [x] PR body through `bun scripts/check-pr-body.ts`, open the PR
- [ ] Drive CI green — fork PR, so `Merge Gate` and `PR Body` sit in `action_required`
      until a maintainer approves the run

## Verification

- `bun test src/tests/heartbeat-stall-thresholds.test.ts`
- `bun test src/tests/heartbeat.test.ts` (no regression in the merged #2838 block)
- `bun run lint && bun run tsc:check:tsc`
- `bun run check:unit-test-allowlist --base origin/main`
- Control: the new tests fail against the unmodified parsers (`git stash` the fix)

## Outcome

PR https://github.com/desplega-ai/agent-swarm/pull/3173 — opened, body check green, CI held
for maintainer approval (fork PR). Local: focused 12/12 pass (5 fail on the pre-fix code),
heartbeat suite 74/74, `tsc:check:tsc`, biome, oxlint, floating-promises, promise-sinks,
konsistent and the Rule 1 allowlist check all clean.
