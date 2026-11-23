# Testing runbook

Hub for everything test-shaped in this repo. The canonical, up-to-date testing recipes live in [LOCAL_TESTING.md](../LOCAL_TESTING.md) — this file is just a router.

## When you're …

| You're … | Read |
|---|---|
| Writing or running unit tests (`bun run test:root` from the workspace root), the Docker smoke-test, the entrypoint round-trip checklist, the MCP handshake sequence | [LOCAL_TESTING.md](../LOCAL_TESTING.md) |
| Running the **full guided E2E flow** (tasks, session logs, UI verification) | Invoke the `swarm-local-e2e` skill |
| Running or extending the **black-box contract suite** (`bun run e2e --strict`: every route, MCP tool and workflow node type, mocked inference + Slack) | [e2e-blackbox.md](./e2e-blackbox.md) for operators and reviewers; [scripts/e2e/README.md](../scripts/e2e/README.md) for authors |
| Changing `apps/ui` behavior (routes, flows, selectors) or adding browser coverage | [LOCAL_TESTING.md § UI E2E](../LOCAL_TESTING.md#ui-e2e-bun-run-e2eui). `bun run e2e:ui` boots a seeded API per Playwright worker. Package contract in `packages/ui-e2e/README.md` |
| Drafting a plan with verification / E2E / QA steps | [LOCAL_TESTING.md](../LOCAL_TESTING.md) — copy command forms verbatim, don't paraphrase |
| Preparing a frontend PR (`apps/ui/`, `apps/templates-ui/`) | Screenshots of each visible change (static/layout changes included), and a recording only for a new or changed interaction or flow, uploaded as GitHub user attachments (`github-attach` skill; fallback for images only: `agent-fs signed-url --inline`) in the PR's `## Before / after` section. A new configuration-catalog entry that reuses an existing control: show its key and default as a table, not a screenshot. Nothing visible (a type-only refactor, a test fix): write `No visible change: <reason>` there. The PR Body check requires the section; the media is a reviewer convention. Commands in the `agent-browser` skill and [LOCAL_TESTING.md § When you need to verify a UI change](../LOCAL_TESTING.md#when-you-need-to-verify-a-ui-change). Per-package conventions in `apps/ui/CLAUDE.md` |
| Testing the Helm chart on a real cluster (HTTPS, cert-manager, agent-fs, the example values) | [k8s-test-cluster.md](./k8s-test-cluster.md) — throwaway single-node k3s on a VPS, verify list, teardown |
| Modifying memory-system code | [memory-system.md](./memory-system.md) — runs all four memory test files |
| Testing Slack integration / driving the **LOCAL** dev swarm | Dev channel `#swarm-dev-2` (`C0AR967K0KZ`), bot `@dev-swarm` (`U0ALZGQCF96`). Send via `slack_send_message` MCP tool to trigger task-assignment flow |
| Sending a task to the **PRODUCTION / deployed** swarm | Use `mcp__agent-swarm-user__send-task`. It queues work directly for the online Lead. The call fails without creating a task when no Lead is online. Read results with `mcp__agent-swarm-user__get-tasks`. **Not** the dev Slack channel. MCP may not be enabled every session. Check for `mcp__agent-swarm-user__*` first. |
| Driving a browser to verify UI | `agent-browser` only (`open`, `snapshot`, `screenshot`). Load the guide with `agent-browser skills get core`. Never `qa-use` unless explicitly asked |

## Hard rules

1. **PR evidence shows the surface the reviewer must verify.** A visible dashboard change needs screenshots (static/layout changes included), and a recording only for a new or changed interaction or flow (navigation, form, modal, drag, animation, or multi-step flow). A visible Slack change needs before and after frames from the Slack mock, from a `slack-*.ts` scenario in a visuals group ([LOCAL_TESTING.md § Black-box E2E](../LOCAL_TESTING.md#black-box-e2e-bun-run-e2e)). No visible change: write `No visible change: <reason>`. All of it goes in the PR's `## Before / after` section, with media as GitHub user attachments (`github-attach` skill; fallback for images only: `agent-fs signed-url --inline`). Commands: the `agent-browser` skill and [LOCAL_TESTING.md § When you need to verify a UI change](../LOCAL_TESTING.md#when-you-need-to-verify-a-ui-change). Reviewer convention. `.github/workflows/merge-gate.yml` does not check it. Merge Gate runs the Playwright suite on UI and API PRs and merge groups, as a required job. It reports every run to the UI E2E tracker. A failure on `main` or on the nightly cron opens an incident there.
2. **Plan-mode verification steps must reference real commands** from `LOCAL_TESTING.md` — invented commands break agent runs.
3. **Memory tests are not optional** when touching memory code — all four files in [memory-system.md](./memory-system.md).
4. **Never hard-code a test port.** CI runs `bun test --parallel=4` (one worker process per file), so two files with the same literal collide. Use `listenOnFreePort(server)` / `getFreePort()` / `waitForServer()` from `src/tests/test-net.ts`. Commands, the preload template cache, and the pre-push hook's nearest-affected-tests scoping are in [LOCAL_TESTING.md](../LOCAL_TESTING.md).
5. **Never `Bun.spawnSync` in a test, and never the 10 s default timeout for a test that spawns a child.** A blocked event loop cannot time a hung child out, and a cold `bun` boot under `--parallel=4` can take several seconds. Use `runChild()` / `expectChildOk()` from `src/tests/test-proc.ts` and pass `CHILD_PROCESS_TEST_BUDGET_MS` as the test's timeout argument. Enforced by `scripts/check-test-spawn-sync.sh`.
6. **No new unit tests for API or CLI code.** Prove a change with an e2e scenario in `scripts/e2e/scenarios/` (`bun run e2e --only <name>` before push; authoring: [scripts/e2e/README.md](../scripts/e2e/README.md)). A new test file (any name `bun test` runs: `*.test.ts`, `*.spec.ts`, `*_test.ts`, any JS/TS extension), or a new `test(` call in an old one, may import only the worker runtime, tooling, rule corpora, migrations and the dashboard listed in `scripts/unit-test-allowlist.txt`. `bun run check:unit-test-allowlist` (Lint job) enforces it on the diff; the escape hatch is a line with a reason in that file. Editing or deleting an existing unit test is fine.
7. **E2E and test agents use UUID agent IDs.** E2E/test agents MUST use valid UUID agent IDs (e.g. `AGENT_ID=$(uuidgen)`), never slugs like `e2e-lead`, several MCP tool *output* schemas pin `yourAgentId`/`task.agentId` to UUID, so slug-ID agents get `MCP error -32602: Output validation error` on `get-tasks`/`get-task-details`/`store-progress`/`memory-search` **after the write already landed** (retrying double-writes).

## Test-line budget

A cleanup PR primarily removes, consolidates, or repairs tests. Its default budget is zero net growth in test code.
Measure the total per PR. This is a review budget, not a deletion target.

Count all test trees, including root and package tests, scripts/e2e/scenarios, and packages/ui-e2e/specs.
Include their fixtures, mocks, and test helpers. Moving assertions into a helper does not reduce the total.
Do not compress formatting to meet the budget.

Growth is justified only when the PR names the behavior contract that needs it. Examples include a missing regression guard or a demonstrated flake repair.
Explain why retained coverage cannot protect that contract. Include the affected checks and a failing control when practical.
A control can temporarily introduce the relevant regression and show that the retained test detects it.

Justify each contract that grows, even when the PR total shrinks. Never remove an independent safety check to fund unrelated additions.
Preserve distinct platform, process, persistence, authentication, and integration boundaries.
Keep a necessary test when consolidation would weaken its contract, even when that means no deletion.

For feature and fix PRs, justify new coverage against the changed behavior. This policy does not override the unit-test allowlist or E2E requirements.
There is no required test count, deletion percentage, or test-to-production line ratio.

Each cleanup PR must identify:

- Added and deleted test lines, including fixtures, mocks, and helpers.
- Removed duplication and the retained checks that protect its contracts.
- Validation results, failing controls, and unresolved risks.
