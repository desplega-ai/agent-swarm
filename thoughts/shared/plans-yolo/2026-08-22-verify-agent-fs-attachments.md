---
date: 2026-08-22T14:32:39Z
topic: "Verify agent-fs attachments at registration"
status: done
---

# Verify agent-fs attachments at registration

## Goal

Make `store-progress` reject an agent-fs attachment before any task or attachment write when its path cannot be resolved in the registering agent's explicitly selected org and drive.

## Decisions

- Use the internal `AgentFsProvider.head()` API with an explicit org/drive scope — the repository already owns this integration and shell defaults are unsafe. (assumed)
- Hard-fail the whole `store-progress` call before its transaction — this preserves task state and prevents unreachable pointers from being recorded. (assumed)
- Resolve API credentials and org/drive values through the caller-aware config precedence, with process environment only as a deployment fallback. (assumed)

## Todo

- [x] Locate the authoritative attachment registration path and internal agent-fs read API.
- [x] Add pre-registration resolution checks for every agent-fs attachment.
- [x] Cover existing, absent, wrong-drive, and mixed-scope batch cases at handler level.
- [x] Run focused tests, typecheck, lint, and required pre-push checks.
- [x] Resolve the independent Standards and Spec review findings.
- [ ] Commit, push, and open a review-gated PR.

## Verification

- `bun test src/tests/store-progress-attachments-handler.test.ts src/tests/store-progress-attachments.test.ts src/tests/fs-provider.test.ts`
- `bun run lint:fix`
- `bun run tsc:check`
- `bash scripts/check-db-boundary.sh`
- repository pre-push hook on `git push`
