---
id: step-9
name: "Integration: e2e scenario, docs, drift checks"
depends_on: [step-3, step-4, step-5, step-6, step-7]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-9: Integration: e2e scenario, docs, drift checks

## Overview
After this step the whole feature is exercised end to end by the black-box runner, documented for operators and for future contributors, and every CI drift check is green. This is the stitch step; it adds no new behavior.

## Changes Required:

#### 1. Black-box e2e scenario
**File**: `scripts/e2e/scenarios/extensions.ts` (new; follow the existing scenario file layout under `scripts/e2e/`), scenario registry in `scripts/e2e/run.ts` or its index
**Changes**: One scenario named `extensions` that, against the booted API and the in-process Slack mock: installs and enables the `block-tasks-from-source` bundle (blocks `source: "rest"`), asserts `POST /api/tasks` returns 422; disables it; enables `route-channel-to-agent` for the mock channel and a simulated worker, sends a mention through `ctx.slack`, asserts the created task's `agentId` via `ctx.db`; enables `no-exclamation-marks`, calls `store-progress` over MCP with `"done!"` and asserts `isError`; enables `throws`, creates 5 tasks, asserts `status: "auto-disabled"`; activates version 1 of one extension and asserts `activeVersion`. Seed everything through the API, use `ctx.db` only for reads. Also add the `extension-install` and `extension-list` tools to the tool-coverage expectations if the runner tracks them.

#### 2. Operator docs
**File**: `docs-site/content/docs/(documentation)/guides/extensions.mdx` (new), `docs-site` nav/meta file for guides
**Changes**: What extensions are (bundles: manifest + files, hooks-only in v1, reserved asset kinds), the trust model, the v1 events table (copy from the brainstorm), the contract sketch, the `ctx` surface, ordering / fail-open / auto-disable rules, the `ext:<name>` identity, REST + MCP + dashboard surfaces, and the five examples as snippets pulled from `src/tests/fixtures/extensions/`. State the known limits: agent-facing tool calls only, message handler only for Slack, remediation only for heartbeat, single-process reload with the 30 s poll.

#### 3. Contributor docs
**File**: `CLAUDE.md`, `runbooks/extensions.md` (new), `MCP.md`
**Changes**: Add an `<important if="you are modifying the extension system (src/extensions/*, src/be/extensions/*, src/http/extensions.ts, src/tools/extension-*.ts) or adding a pre/post event">` block to `CLAUDE.md` with: dispatch only at entry points outside transactions (`isInTransaction()` guard), how to add an event (contract entry, `bundle-extension-types`, one `dispatchPre` call, fixture, docs table row), the `callOrigin: "extension"` bypass, and the test command `bun run test:root -- src/tests/extensions-*.test.ts`. `runbooks/extensions.md` holds the full flow (load, dispatch, failure handling, identity) with a mermaid diagram. Add the two tools to `MCP.md`.

#### 4. Drift checks and regenerated artifacts
**File**: `openapi.json`, `docs-site/content/docs/api-reference/**`, `src/scripts-runtime/types/*.d.ts`, `src/be/seed-skills/bundled-files.generated.json` (only if a skill file changed)
**Changes**: Run every regenerator and commit outputs. Run the full merge-gate mirror from `CLAUDE.md` § preparing a commit.

### Success Criteria:

#### Automated Verification:
- [x] `bun run e2e --only extensions`
- [x] `bun run e2e` (full, no regressions)
- [x] `bun run test:root -- --parallel=4`
- [x] `bun run tsc:check && bun run lint`
- [x] `bun run check:rbac-coverage && bun run check:openapi-response-coverage && bun run check:script-types && bun run check:dep-graph`
- [x] `bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh && bash scripts/check-audit-columns.sh && bash scripts/check-migration-conflicts.sh && bash scripts/check-test-spawn-sync.sh`
- [x] `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts && bun scripts/check-sdk-tool-registration.ts`
- [x] `bun run docs:openapi && git diff --exit-code openapi.json docs-site/content/docs/api-reference`
- [x] `bun run check:bun-version`

#### Automated QA:
- [x] Run the root.md Manual E2E block end to end against a scratch DB and paste the outputs into the step notes.
- [x] `cd docs-site && bun run build` (or the docs-site build command in its package.json) succeeds with the new guide in the nav.

#### Manual Verification:
- [ ] Taras reads the operator guide once for accuracy against the brainstorm.

**Implementation Note**: This step is a vertical slice — QA-able on its own. After completing this step, pause for manual confirmation. Taras handles commits.

## Execution notes (2026-09-14)

- Executor: Codex gpt-5.6-sol (high), sequential in the main worktree. Report: /tmp/ext-impl/step-9-report.md. Two-axis Opus review: no Critical findings; one Important (MCP.md is generated, `bun run docs:mcp` now owns the two tool entries under Scripts Tools) and five Minor items fixed by the orchestrator (runbook `signal` and modify-validation wording, runbook link to the guide, CLAUDE.md runbooks index, no-op handler dropped from the docs example, e2e asserts the MCP draft lands `enabled: false` / `status: "disabled"`).
- Orchestrator fix: the e2e v2 install bumped only `manifest.version`, but the fixture hooks pin the manifest as a const literal, so the install typecheck rejected it. Version 2 is now produced by a changed hooks file (same as the step-2 live QA).
- Live runs (Codex sandbox denies listeners): `bun run e2e --only extensions` PASS (1.6 s); full `bun run e2e` PASS 17/17; `bun run test:root -- --parallel=4` 8781 pass / 0 fail with `ANTHROPIC_API_KEY=` unset (3 workflow-LLM credential tests fail only when the key is set; known env sensitivity).
- Docs site: `bun install --frozen-lockfile` fails in `docs-site/` (bun.lock drift vs pnpm-lock.yaml; pre-existing, CI does not build docs-site). `pnpm install --frozen-lockfile && bun run build` succeeds with the guide in the nav.
- `bun run check:operator-skill` fails only on remote `docs.agent-swarm.dev` link checks in the sandbox (no DNS); not related to this step.
- Deferred (out of diff): `EXTENSION_HANDLER_TIMEOUT_MS` and `EXTENSION_MAX_CONSECUTIVE_FAILURES` are validated in `swarm-config-guard.ts` but not registered in the dashboard configuration catalog; `scripts/e2e/scenarios/extensions.ts` duplicates the fixture loader from `src/tests/fixtures/extensions/load.ts` (the e2e tsconfig does not include `src/tests`).
- Manual E2E block (root.md steps 1-6) on a scratch DB, route-channel-to-agent installed with `config: { channelId, agentId }` (enable returns 400 without it, as designed):

```
1 install route-channel-to-agent: 200 id=1e3a5434-e96d-4a11-9e2c-c6e373e92880 version=1
2 enable: 200 status=enabled
3 ext agent: found status=offline; extension: {"status":"enabled","activeVersion":1,"consecutiveFailures":0}
4 create task: 201 id=9aaa843d-e384-4220-9bab-b0fc0290824e
4 post-logger runs[0]: {"id":"e291e980-8e6e-42a2-a8bf-be8e33631cfe","extensionId":"d7638f0b-5838-4f47-983c-7c1bcddfceea","version":1,"event":"post.task.created","action":"continue","durationMs":41,"message":null,"createdAt":"2026-09-14T17:37:59.869Z"}
5 install throws: 200 enable: 200
5 after 5 tasks: status=auto-disabled consecutiveFailures=5 autoDisabled=true
6 v2 install: 200 version=2 activeVersion=2
6 activate-version 1: 200 activeVersion=1 status=enabled
```

- Step 7 (dashboard) screenshots are the step-8 captures in agent-fs `qa/agent-swarm/2026-09-14-extensions-dashboard/`.
