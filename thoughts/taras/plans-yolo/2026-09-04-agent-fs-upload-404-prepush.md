---
date: 2026-09-04T10:47:00Z
topic: "Close the worker-only agent-fs upload 404 pre-push blocker"
status: done
---

# Close the worker-only agent-fs upload 404 pre-push blocker

## Goal

Identify why attachment uploads return 404 in worker containers but 201 in CI, then land the smallest evidence-backed fix or environment gate so full-suite pre-push runs are reliable without hiding CI regressions.

## Decisions

- Start from a fresh `origin/main` worktree and run the exact isolated reproduction before changing code — the task's contradiction clause makes this a hard gate (required).
- Treat the cause as open and trace the request past RBAC into task lookup and storage before choosing a product fix or environment-only skip (required).
- Keep the diff outside `templates/`, `src/be/migrations/`, `bunfig.toml`, `bun.lock`, and `package.json` — touching those paths would force the known-blocked full suite (required).

## Todo

- [x] Reproduce the 9-pass/2-fail `rbac-wire-e2e` result on clean `origin/main`.
- [x] Trace the upload request and prove the worker/CI divergence mechanism with controls.
- [x] Implement the smallest product/test fix, or the specified explicit environment gate if no real defect exists.
- [x] Run focused tests, typecheck/lint gates, diff review, and commit the implementation.

## Verification

- `bun test src/tests/rbac-wire-e2e.test.ts`
- Focused affected test files identified during diagnosis
- `bun run lint`
- `bun run tsc:check`
- Repository pre-push hook on ordinary `git push`

## Findings

- The worker exports `AGENT_FS_API_URL`, `AGENT_FS_API_KEY`, and default org/drive IDs. `selectProvider()` therefore chose `agent-fs`, even though the affected suites set `AGENT_FS_LOCAL_DIR` for isolated local storage.
- With the inherited worker environment, the three affected files produced 9/2, 0/1, and 166/1 pass/fail counts. Removing only the agent-fs URL/API-key selectors changed provider selection from `agent-fs` to `local-fs` and produced 11/0, 1/0, and 167/0.
- The fix clears the remote provider selectors in the spawned server environment. This corrects test isolation and keeps the assertions active; it does not introduce an environment skip.

## Review

- Standards axis: no findings.
- Spec axis: implements the spec as stated; no forbidden paths or PR #1337-owned files changed.
- Full-suite control: 8039 pass / 140 skip / 6 fail. The remaining failures are exactly the six sandbox-spawn assertions owned by PR #1337; the four agent-fs upload failures are gone.
