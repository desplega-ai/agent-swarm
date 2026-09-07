---
date: 2026-09-07T14:15:00Z
topic: "Terminate provider subprocess trees with process groups"
status: done
---

# Terminate provider subprocess trees with process groups

## Goal

Provider and script-runtime subprocesses run in dedicated POSIX process groups, and every teardown path terminates the full group so MCP servers and other descendants cannot survive task completion or runner shutdown.

## Decisions

- Use one small process-group utility shared by every affected spawn site because group registration and two-stage teardown are the same lifecycle concern at multiple real callers. (assumed)
- Keep Windows behavior PID-based because negative-PID process-group signaling is POSIX-only. (assumed)
- Leave sandbox containment issue #1332 unchanged and link it from the PR. (required)

## Todo

- [x] Verify every reported spawn and teardown path against commit `20e53c14`.
- [x] Add registered detached spawning and SIGTERM-to-SIGKILL group teardown.
- [x] Drain registered groups during runner shutdown and uncaught failures.
- [x] Add a child-with-grandchild regression test through an adapter teardown path.
- [x] Run focused tests and repository gates.
- [x] Complete independent standards and specification reviews and prepare the branch for PR.

## Verification

- `bun test <focused process-group and adapter tests>`
- `bun run test:root -- --parallel=4`
- `bun run lint:fix`
- `bun run tsc:check`
- `bash scripts/check-db-boundary.sh`
- `bun run e2e`
- `bun run e2e:ui` (blocked before test execution by the missing Playwright 1.63 Chromium binary in `/opt/playwright`; self-install stalled without creating the required revision)
- `bun run check:bun-version`
- `bash scripts/check-test-spawn-sync.sh`
- `bash scripts/check-audit-columns.sh`
- `bun run check:dep-graph`
- `bunx pnpm@10.17.1 build` in `docs-site`
