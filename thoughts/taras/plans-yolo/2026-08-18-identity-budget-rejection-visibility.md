---
date: 2026-08-18T15:59:00Z
topic: "Surface and audit identity-field budget rejections"
status: done
---

# Surface and audit identity-field budget rejections

## Goal

Keep the existing identity-field budgets and ratchet semantics unchanged while making rejected disk-to-DB profile syncs persistent, visible to the affected agent at SessionStart, and queryable as disk-versus-DB divergence across all five profile markdown fields.

## Decisions

- Reuse an existing persisted surface if its semantics fit; add no table unless the codebase has no suitable queryable record — smallest-diff requirement (assumed).
- Surface a durable warning at SessionStart and preserve the immediate stderr error — the hook process cannot retroactively fail an already-successful edit tool call (assumed).
- Include `heartbeatMd` only in divergence detection, never in budget enforcement — required by the verified premise (specified).

## Todo

- [x] Verify every stated premise against `origin/main` and inspect persistence/session-hook patterns.
- [x] Implement persisted rejection metadata and SessionStart warning without weakening the budget ratchet.
- [x] Add a reusable five-field disk-versus-DB divergence check for audits.
- [x] Add focused tests for rejection persistence, warning delivery, and divergence detection.
- [x] Run the full repository pre-push gate, review the diff, commit, push, and open a review-gated PR.

## Verification

- `rm -f test-*.sqlite test-*.sqlite-wal test-*.sqlite-shm`
- `bun install --frozen-lockfile`
- `bun run lint:fix`
- `bun run tsc:check`
- `bash scripts/check-db-boundary.sh`
- `bash scripts/check-api-key-boundary.sh`
- `bash scripts/check-rbac-boundary.sh`
- `bash scripts/check-audit-columns.sh`
- `bun run check:rbac-coverage`
- `bun run check:openapi-response-coverage`
- `bun run check:dep-graph`
- `bun test src/tests/identity-field-budget.test.ts src/tests/profile-sync.test.ts`
- `bun test`
