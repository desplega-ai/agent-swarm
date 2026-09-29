# QA harness for PR #1682 (heartbeat Reclaim / Unpin / attempt fence)

Boots the real API on a fresh DB, drives it with fake workers over HTTP + MCP, and backdates rows
through a second sqlite handle so the minute-scale stall timers do not have to elapse.

    bun scripts/qa/hb-e2e.ts [--multi=false]   # core scenarios S1-S12
    bun scripts/qa/hb-e2e2.ts                  # zombie writes, defer-task/wakeOn, supersede, recover-orphaned, Unpin edges
    bun scripts/qa/hb-e2e3.ts                  # workflow-step stall
    bun scripts/qa/hb-upgrade.ts               # old-shape rows built on origin/main (git worktree at /tmp/main-wt), then the branch on the same DB

Unit-level guards and confirmed gaps: `src/tests/heartbeat-qa-edge-cases.test.ts` (`test.failing` = open finding).
