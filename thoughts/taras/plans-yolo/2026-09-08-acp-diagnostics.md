---
date: 2026-09-08T12:24:00Z
topic: "Make ACP runs diagnosable"
status: done
---

# Make ACP runs diagnosable

## Goal

Persist sanitized ACP protocol evidence in `session_logs` and parse those rows through explicit ACP transcript adapters, then open a review-gated PR without changing empty-turn behavior.

## Decisions

- Reuse the repository's existing log sanitization and row shape rather than adding another redaction system — required by the task.
- Preserve ACP `messageId` boundaries when rendering streamed message and thought chunks.
- Queue notifications received during `session/new` and config application so early protocol evidence is not dropped.
- Strip Authorization headers structurally, cap individual string fields, and cap complete rows while retaining parseable normalized tool events.
- Keep the current ACP output accumulator, runner fallback, model configuration, UI, costs, Docker, docs, and harness assignments unchanged — required scope boundary.
- Use one focused commit and a review-gated PR — this is one logical observability change.

## Todo

- [x] Trace ACP notifications, normalized messages, session-log persistence, and both transcript parser registries.
- [x] Add persistence tests that prove useful ACP protocol traffic is stored and sensitive/large fields are sanitized.
- [x] Register and test ACP transcript parsing in both registries.
- [x] Run focused regressions, lint/type checks, and independent two-axis review.
- [x] Commit, push, open the review-gated PR, and inspect CI without merging.

## Verification

- `bun test src/tests/acp-adapter.test.ts src/tests/acp-swarm-events.test.ts src/tests/runner-fallback-output.test.ts`
- Focused persistence and transcript parser tests identified during implementation.
- `bun run lint`
- `bun run tsc:check`

## Results

- Required ACP regressions: 49 pass, 0 fail.
- ACP persistence and both transcript parser copies: 79 pass, 0 fail.
- Root lint and TypeScript checks pass; app UI lint and TypeScript checks pass.
- Independent spec and standards reviews found no remaining findings.
