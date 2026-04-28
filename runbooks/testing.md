# Testing runbook

Hub for everything test-shaped in this repo. The canonical, up-to-date testing recipes live in [LOCAL_TESTING.md](../LOCAL_TESTING.md) — this file is just a router.

## When you're …

| You're … | Read |
|---|---|
| Writing or running unit tests, the Docker smoke-test, the entrypoint round-trip checklist, the MCP handshake sequence | [LOCAL_TESTING.md](../LOCAL_TESTING.md) |
| Running the **full guided E2E flow** (tasks, session logs, UI verification) | Invoke the `swarm-local-e2e` skill |
| Drafting a plan with verification / E2E / QA steps | [LOCAL_TESTING.md](../LOCAL_TESTING.md) — copy command forms verbatim, don't paraphrase |
| Preparing a frontend PR (`new-ui/`, `landing/`, `templates-ui/`) | qa-use session + screenshots required (merge gate). Per-package conventions in `new-ui/CLAUDE.md` |
| Modifying memory-system code | [memory-system.md](./memory-system.md) — runs all four memory test files |
| Testing Slack integration end-to-end | Dev channel `#swarm-dev-2` (`C0AR967K0KZ`), bot `@dev-swarm` (`U0ALZGQCF96`). Send via `slack_send_message` MCP tool to trigger task-assignment flow |
| Picking which qa-use slash command | `/qa-use:test-run` (run), `/qa-use:verify` (feature works), `/qa-use:explore` (open page) |

## Hard rules

1. **Frontend PRs require a qa-use session with screenshots.** Enforced by `.github/workflows/merge-gate.yml`.
2. **Plan-mode verification steps must reference real commands** from `LOCAL_TESTING.md` — invented commands break agent runs.
3. **Memory tests are not optional** when touching memory code — all four files in [memory-system.md](./memory-system.md).
