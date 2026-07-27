---
id: step-11
name: Integration, docs, cross-provider E2E
depends_on: [step-2, step-4, step-5, step-6, step-7, step-8, step-9, step-10]
status: done
completed_at: 2026-07-28
---

# step-11: Integration, docs, and the cross-provider E2E matrix

## Overview

The stitching step. Reconciles the shared surfaces every parallel step was forbidden from touching (`runbooks/harness-providers.md`, `MCP.md`, `docs-site/`, the final `openapi.json` regen), runs the full CI mirror, and executes the cross-provider E2E matrix that proves the degradation ladder behaves as designed on every harness.

Owns all shared documentation. No feature logic lands here — if something is broken, fix it in the owning step's files and note it.

## Changes Required:

#### 1. Harness-provider docs (same-PR rule)
**Files**: `runbooks/harness-providers.md`, `docs-site/content/docs/(documentation)/guides/harness-providers.mdx`
**Changes**: The runbook's own same-PR doc-update rule fires for steps 4–7. Add a steering-capability table covering all six providers with what was **empirically confirmed**, not what was planned:

| Provider | steer | queue | Notes |
|---|---|---|---|
| pi-mono | ✅ native `steer()` | ✅ native `followUp()` | richest semantics |
| claude-managed | ✅ | ✅ | events processed in order |
| devin | *(per step-7's finding)* | *(per step-7's finding)* | resolve the `working` vs `waiting_for_user` question here |
| opencode | ⚠️ `abort` + `prompt` (lossy) | ✅ `promptAsync` | queue is the zero-loss path |
| claude | ❌ → degrades to queue | ✅ stdin stream-json | requires CLI ≥ 2.1.205 (decision 13) |
| codex | ❌ | ❌ | always promoted to a follow-up task (decision 4) |

#### 2. MCP + API docs
**Files**: `MCP.md`, `openapi.json`, `docs-site/content/docs/api-reference/**`
**Changes**: Document `steer-task` and `accept-steer`. Run the final `bun run docs:openapi` and commit both `openapi.json` and the regenerated api-reference pages.

#### 3. Config docs
**Files**: `runbooks/local-development.md` (or wherever Slack flags are listed)
**Changes**: Document `SLACK_THREAD_STEERING`, `SLACK_THREAD_STEERING_MODE`, and `HEARTBEAT_STEERING_GRACE_MIN` with their defaults.

#### 4. Version bump artifacts (only if bumping)
**Changes**: If this ships as a version bump, `bun run prepare-release` regenerates `sync-chart-version` + `docs:openapi`; commit **all** regenerated files alongside the bump (`charts/agent-swarm/Chart.yaml` `version`/`appVersion` must match `package.json`). Step-9's `useFeatureGate("1.122.0")` assumes `1.122.0`; reconcile if the actual release number differs.

#### 5. Reconciliation sweep
**Changes**: Verify the parallel steps didn't drift:
- `src/tools/tool-config.ts` — both `accept-steer` (step-3) and `steer-task` (step-8) present in `ALL_TOOLS`.
- `src/scripts-runtime/sdk-allowlist.ts` — `accept-steer` in `EXCLUDED_TOOLS` **and** `task_steer` in `SDK_TOOL_NAME_MAP`.
- All six adapters compile against step-3's `SteerDeliveryResult`, and every provider's traits match reality.
- **Decision 16 sync test** (new, owned by this step): assert every adapter's `traits.steerModes` equals `PROVIDER_STEER_CAPABILITIES[provider]` from step-1. Drift means the API advertises `supportedSteerModes` the adapter can't deliver, and `onUnsupported:"fail"` gates on a lie. Narrow devin's entry here if step-7's `working`-state finding requires it.
- The `outcome` vocabulary is rendered consistently by the HTTP route, the MCP tool, the UI, and Slack.

### Success Criteria:

#### Automated Verification:
*(This is the full CI mirror from `runbooks/ci.md`.)*
- [ ] `bun install --frozen-lockfile`
- [ ] `bun run lint` (NOT `lint:fix` — CI runs the read-only variant)
- [ ] `bun run tsc:check`
- [ ] `bun test`
- [ ] `bash scripts/check-db-boundary.sh`
- [ ] `bash scripts/check-api-key-boundary.sh`
- [ ] `bun run check:rbac-coverage`
- [ ] `bun run check:dep-graph`
- [ ] `bun run scripts/check-sdk-tool-registration.ts`
- [ ] OpenAPI fresh: `bun run docs:openapi && git diff --exit-code openapi.json docs-site/content/docs/api-reference/`
- [ ] Script types fresh: `bun run build:script-types && git diff --exit-code src/scripts-runtime/types/`
- [ ] UI: `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b`
- [ ] Images build: `docker build -f Dockerfile.worker .` and `docker build -f Dockerfile .`
- [ ] Fresh-DB boot creates the table; existing-DB boot applies migration `121` cleanly

#### Automated QA:
- [ ] Agent executes the **full cross-provider matrix** from root.md § "Manual E2E" step 2, one worker container per provider, and reports a table of actual vs expected `outcome` for `mode:"steer"` — pi-mono `steered`, claude-managed `steered`, devin *(per step-7)*, opencode `steered`, claude `queued`, codex `promoted`
- [ ] Agent runs root.md § "Manual E2E" step 3 (promotion on terminal status) and shows `status:"promoted"` with a real `promotedTaskId`
- [ ] Agent runs root.md § "Manual E2E" step 4 (MCP round-trip) and step 1 (HTTP round-trip) end-to-end
- [ ] Agent confirms **no regression on the unsteered happy path** for every provider — a plain task with no steering completes normally with correct cost and context accounting (this is the main risk from step-6's argv→stdin change)
- [ ] Agent confirms secret scrubbing: a steering body containing a token-shaped string never appears raw in `session_logs`, worker stdout, or `/workspace/logs/*.jsonl`
- [ ] Agent verifies decision 16 across the matrix: for every provider, `GET /api/tasks/{id}` reports `supportedSteerModes` matching that adapter's traits, and `onUnsupported:"fail"` with an unsupported mode returns `422` with **no** steering row created

#### Manual Verification:
- [ ] Taras reviews the provider capability table against what he expects to ship
- [ ] Taras runs the live Slack round-trip (step-10's manual check) if it wasn't completed there
- [ ] `qa-use` session with screenshots attached to the PR (merge-gate requirement for `apps/ui/` changes)

**Implementation Note**: Explicit integration node — stitching and evidence, not new behavior. Commit `[step-11] steering docs, openapi regen, and cross-provider E2E evidence`.
