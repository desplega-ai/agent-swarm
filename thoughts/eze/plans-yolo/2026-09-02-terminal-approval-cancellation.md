---
date: 2026-09-02T10:21:00Z
topic: "Make workflow approvals terminal with their gated run"
status: completed
---

# Make workflow approvals terminal with their gated run

## Goal

Ship a review-gated PR that closes pending approval requests when their workflow run or HITL step is cancelled, rejects late responses, and updates the existing Slack approval thread. Separately, diagnose the duplicated wrong-branch execution in release v1.136.0 and provide the exact proposed patch without changing the global workflow or scripts.

## Decisions

- Keep the approval fix inside the existing workflow/HITL subsystem and use the current approval status model where possible — assumed from the requested minimal scope.
- Do not mutate historical approval rows, post to Slack manually, trigger workflows, retry runs, or promote global scripts — required by the task boundaries.
- Preserve the existing user change in `CLAUDE.md` and isolate work on a task branch — required by repository hygiene.
- The v1.136.0 wrong-branch execution is a retry-frontier defect, not a bad `property-match`: retry reconstruction called `findReadyNodes` without the completed steps' stored `nextPort` edges. The exact engine correction already exists in PR #1298 at commit `f0038a61f2977b6fc815bdaff5f2fac7ba1d0609`; this task must report that artifact rather than duplicate it in the approval PR.
- The format-gate failure is separate: `unified-release-prepare-content` emitted the full PR URL before the retry wave, so it is not caused by the retry-frontier bug.

## Todo

- [x] Verify the supplied workflow, step, and approval rows and locate cancellation/response code paths.
- [x] Add cancellation lifecycle behavior, late-response rejection, Slack-thread update, and focused tests.
- [x] Diagnose v1.136.0 duplicate/wrong-branch execution from step rows and retry/redrive engine code.
- [x] Run focused and repository verification, quick review, commit, push, and open a PR.
- [x] Report the PR and exact defect-2 proposed patch through task progress.

## Verification

- `bun test src/tests/approval-requests.test.ts src/tests/workflow-http-v2.test.ts src/tests/approval-cancellation-migration.test.ts`
- `bun run lint`
- `bun run tsc:check`
- `bun run test:root`
- `bun run check:audit-columns`
- `bun run check:db-boundary`
- `bun run check:openapi-response-coverage`
- `bun run check:dep-graph`
- `bun run check:vendored-openapi`
- `cd apps/ui && bun run build`
- `qa-use browser`: loaded the local approval list, verified a cancelled approval renders as `CANCELLED`, and saved `/tmp/approval-cancelled-ui.png`.
- `git diff --check`
