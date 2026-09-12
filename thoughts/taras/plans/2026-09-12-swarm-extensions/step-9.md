---
id: step-9
name: "Integration: e2e scenario, docs, drift checks"
depends_on: [step-3, step-4, step-5, step-6, step-7]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-9: Integration: e2e scenario, docs, drift checks

## Overview
After this step the whole feature is exercised end to end by the black-box runner, documented for operators and for future contributors, and every CI drift check is green. This is the stitch step; it adds no new behavior.

## Changes Required:

#### 1. Black-box e2e scenario
**File**: `scripts/e2e/scenarios/extensions.ts` (new; follow the existing scenario file layout under `scripts/e2e/`), scenario registry in `scripts/e2e/run.ts` or its index
**Changes**: One scenario named `extensions` that, against the booted API and the in-process Slack mock: upserts and enables `block-tasks-from-source` (blocks `source: "rest"`), asserts `POST /api/tasks` returns 422; disables it; enables `route-channel-to-agent` for the mock channel and a simulated worker, sends a mention through `ctx.slack`, asserts the created task's `agentId` via `ctx.db`; enables `no-exclamation-marks`, calls `store-progress` over MCP with `"done!"` and asserts `isError`; enables `throws`, creates 5 tasks, asserts `status: "auto-disabled"`; activates version 1 of one extension and asserts `activeVersion`. Seed everything through the API, use `ctx.db` only for reads. Also add the `extension-upsert` and `extension-list` tools to the tool-coverage expectations if the runner tracks them.

#### 2. Operator docs
**File**: `docs-site/content/docs/(documentation)/guides/extensions.mdx` (new), `docs-site` nav/meta file for guides
**Changes**: What extensions are, the trust model, the v1 events table (copy from the brainstorm), the contract sketch, the `ctx` surface, ordering / fail-open / auto-disable rules, the `ext:<name>` identity, REST + MCP + dashboard surfaces, and the five examples as snippets pulled from `src/tests/fixtures/extensions/`. State the known limits: agent-facing tool calls only, message handler only for Slack, remediation only for heartbeat, single-process reload with the 30 s poll.

#### 3. Contributor docs
**File**: `CLAUDE.md`, `runbooks/extensions.md` (new), `MCP.md`
**Changes**: Add an `<important if="you are modifying the extension system (src/extensions/*, src/be/extensions/*, src/http/extensions.ts, src/tools/extension-*.ts) or adding a pre/post event">` block to `CLAUDE.md` with: dispatch only at entry points outside transactions (`isInTransaction()` guard), how to add an event (contract entry, `bundle-extension-types`, one `dispatchPre` call, fixture, docs table row), the `callOrigin: "extension"` bypass, and the test command `bun run test:root -- src/tests/extensions-*.test.ts`. `runbooks/extensions.md` holds the full flow (load, dispatch, failure handling, identity) with a mermaid diagram. Add the two tools to `MCP.md`.

#### 4. Drift checks and regenerated artifacts
**File**: `openapi.json`, `docs-site/content/docs/api-reference/**`, `src/scripts-runtime/types/*.d.ts`, `src/be/seed-skills/bundled-files.generated.json` (only if a skill file changed)
**Changes**: Run every regenerator and commit outputs. Run the full merge-gate mirror from `CLAUDE.md` § preparing a commit.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run e2e --only extensions`
- [ ] `bun run e2e` (full, no regressions)
- [ ] `bun run test:root -- --parallel=4`
- [ ] `bun run tsc:check && bun run lint`
- [ ] `bun run check:rbac-coverage && bun run check:openapi-response-coverage && bun run check:script-types && bun run check:dep-graph`
- [ ] `bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh && bash scripts/check-audit-columns.sh && bash scripts/check-migration-conflicts.sh && bash scripts/check-test-spawn-sync.sh`
- [ ] `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts && bun scripts/check-sdk-tool-registration.ts`
- [ ] `bun run docs:openapi && git diff --exit-code openapi.json docs-site/content/docs/api-reference`
- [ ] `bun run check:bun-version`

#### Automated QA:
- [ ] Run the root.md Manual E2E block end to end against a scratch DB and paste the outputs into the step notes.
- [ ] `cd docs-site && bun run build` (or the docs-site build command in its package.json) succeeds with the new guide in the nav.

#### Manual Verification:
- [ ] Taras reads the operator guide once for accuracy against the brainstorm.

**Implementation Note**: This step is a vertical slice — QA-able on its own. After completing this step, pause for manual confirmation. Taras handles commits.
