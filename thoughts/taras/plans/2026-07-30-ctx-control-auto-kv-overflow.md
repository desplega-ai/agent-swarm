---
status: in-progress
owner: Picateclas
task: e9f43c59-0be9-438b-a9cb-a4a97f5d2238
follow_up_task: 05bef5e3-5e89-4fdf-962e-e434a420140c
last_updated: 2026-07-30
last_updated_by: Picateclas
---

# Ctx-Control Auto-KV Overflow Implementation Plan

## Overview

Implement the reserved MCP result-control middleware so every harness receives a bounded, retrievable result on both wire channels.

- **Motivation**: Codex corrupts oversized structured results via middle-out truncation, while pi, OpenCode, and claude-managed only consume text.
- **Related**: `src/tools/utils.ts`, `runbooks/mcp-tool-results.md`, PR #1030

## Current State Analysis

- PR #1030 is still open at `mcp-payload-channels` (`f83122ce`), so this branch is based on that head and the PR must remain stacked.
- `finalizeSwarmToolResult` currently runs only scrub + nudge middleware, then caps presentation strings while leaving structured data intact (`src/tools/utils.ts:206-311`). That cannot protect Codex because it consumes the unbounded structured channel.
- The pre-#1030 renderer kept an 8,000-character prefix for both prose and JSON. #1030 changed both paths to omission, even though the explicit-details and JSON-fallback paths are already distinguishable (`src/tools/utils.ts:273-290`).
- The KV table stores unconstrained SQLite `TEXT`; the public HTTP/MCP write boundary caps values at 2 MiB (`src/be/migrations/061_kv_store.sql`, `src/http/kv.ts:41-43`, `src/tools/kv/kv-set.ts`). Direct server-side `upsertKv` has no additional size cap (`src/be/db.ts:13660-13690`), and TTL is Unix-ms with lazy deletion on point reads.
- `kv-get` currently returns the whole decoded value and has no range inputs (`src/tools/kv/kv-get.ts:30-70`). Both REST GET variants likewise accept no query schema (`src/http/kv.ts:92-100`, `src/http/kv.ts:153-161`).
- Scripts bypass the MCP registrar: `ctx.swarm.kv_get` maps directly to REST (`src/scripts-runtime/swarm-sdk.ts:119-122`). Therefore bounded retrieval must be carried through REST and the generated `SwarmSdk` input type too (`src/be/scripts/typecheck.ts:64-79`); the MCP envelope itself remains absent from script returns (`Promise<unknown>`).

## Desired End State

Oversized MCP results are scrubbed, persisted with a short TTL, replaced on both channels with a bounded preview and literal bounded-retrieval call, and can be reassembled byte-completely.

## What We're NOT Doing

- Merging the PR.
- Changing unrelated HTTP API or script-runtime contracts unless inspection proves they share this envelope.
- Relying on channel separation to control context size.

## Implementation Approach

- Confirm #1030 state and base the worktree accordingly.
- Compose the full scrubbed wire result first and spill when `Buffer.byteLength(JSON.stringify(wireResult), "utf8")` exceeds 10,000 bytes. Tests assert the complete wire result and each independently consumed channel stay below that ceiling.
- Store the canonical scrubbed logical outcome under namespace `mcp:overflow`, key `v1/<tool>/<sha256>`, as a raw string with a refreshed 24-hour TTL. The content hash makes identical scrubbed results deterministic and collision-resistant; the version segment leaves room for contract changes.
- Add UTF-16-code-unit range retrieval (`offset`, bounded `limit`) to MCP `kv-get`, REST KV GET, and `ctx.swarm.kv_get`. The overflow pointer always includes a literal first-chunk call capped at 512 code units; this conservative ceiling keeps multi-byte chunks below the combined wire limit, while concatenating chunks preserves the exact original JS string.
- On overflow, remove the original structured data from the wire result. Explicit prose `details` retains a readable prefix plus marker/pointer; auto-rendered JSON is omitted as a complete unit because a prefix is invalid JSON.
- Expand the common `truncation` envelope with `retrieval`; regenerate MCP docs, OpenAPI/docs-site, and script types because the input surfaces genuinely change.

## Quick Verification Reference

- `bun run lint`
- `bun run tsc:check`
- `bun test`
- `bash scripts/check-db-boundary.sh`
- `bun run check:dep-graph`
- `bun run check:rbac-coverage`

---

## Phase 1: Contract and Storage Design

### Overview

Document the existing pipeline, KV constraints, base branch, and exact overflow/retrieval contract.

### Changes Required:

#### 1. Repository and PR analysis
**File**: `thoughts/taras/plans/2026-07-30-ctx-control-auto-kv-overflow.md`
**Changes**: Record load-bearing code paths, constraints, and the implementation decision.

### Success Criteria:

#### Automated Verification:
- [x] PR #1030 state and base branch are recorded.
- [x] KV schema/value-size and TTL behavior are verified from code.
- [x] MCP, HTTP, and script-runtime contract boundaries are traced.

#### Automated QA:
- [x] Proposed envelope stays reachable on both harness channel families.

#### Manual Verification:
- [x] None.

---

## Phase 2: Middleware and Bounded Retrieval

### Overview

Deliver the ctx-control middleware, KV spill path, safe retrieval contract, and type-aware text rendering.

### Changes Required:

#### 1. MCP result finalization
**File**: `src/tools/utils.ts`
**Changes**: Insert ctx-control after scrub/nudge and before the final transform; bound both channels.

#### 2. KV persistence and retrieval
**File**: `src/be/db.ts`, `src/types.ts`, `src/tools/kv/kv-get.ts`, `src/http/kv.ts`, `src/scripts-runtime/swarm-sdk.ts`, `src/be/scripts/typecheck.ts`, generated `src/scripts-runtime/types/*.d.ts`
**Changes**: Persist canonical scrubbed payloads with deterministic keys and 24-hour TTL; proactively sweep expired spill rows, and expose bounded chunks through MCP, REST, and scripts.

#### 3. Contract tests
**File**: `src/tests/swarm-tool-result-gate.test.ts`, `src/tests/kv-storage.test.ts`, `src/tests/kv-tool.test.ts`, `src/tests/kv-http.test.ts`, `src/tests/scripts-runtime.test.ts`
**Changes**: Add real UTF-8 byte ceilings, prose/JSON behavior, scrub-before-spill, details-only spill, bounded MCP/REST/SDK reads, and non-ASCII byte-complete reassembly coverage.

### Success Criteria:

#### Automated Verification:
- [x] Focused result-gate and KV tests pass.
- [x] Serialized UTF-8 output stays under the chosen ceiling for the combined wire result and both independently consumed channels.
- [x] Retrieval chunks reassemble to the exact persisted payload.

#### Automated QA:
- [x] Real oversized result reports measured before/after sizes.

#### Manual Verification:
- [x] None.

---

## Phase 3: Documentation, Full Validation, and PR

### Overview

Ship updated runbooks and generated surfaces, complete repository checks, and open one review-gated PR without merging.

### Changes Required:

#### 1. Documentation
**File**: `runbooks/mcp-tool-results.md`, `CLAUDE.md`, `MCP.md`, `openapi.json`, `docs-site/content/docs/api-reference/**`, generated `src/scripts-runtime/types/*.d.ts`
**Changes**: Document threshold, namespace/key/TTL, bounded retrieval, and both-channel rationale.

#### 2. Pull request
**File**: GitHub PR
**Changes**: Explain basing, deviations, measured sizes, and SDK/API surface analysis.

### Success Criteria:

#### Automated Verification:
- [x] `bun run build:script-types`
- [x] `bun run docs:mcp`
- [x] `bun run docs:openapi`
- [x] `bun run lint`
- [x] `bun run tsc:check`
- [x] `bun test`
- [x] `bash scripts/check-db-boundary.sh`
- [x] `bun run check:dep-graph`
- [x] `bun run check:rbac-coverage`
- [ ] PR CI is green.

#### Automated QA:
- [ ] PR body includes a before/after measurement and byte-complete retrieval result.

#### Manual Verification:
- [ ] Taras reviews and decides whether to merge.

---

## Phase 4: Script SDK Response-Boundary Follow-up

### Overview

Audit and complete the committed follow-up so the 10 KB context ceiling applies only at agent-facing boundaries, while in-sandbox SDK calls receive full results behind a separate loud 64 MiB memory guard.

### Changes Required:

#### 1. Origin-aware result finalization
**File**: `src/tools/utils.ts`, `src/http/mcp-bridge.ts`, `src/scripts-runtime/swarm-sdk.ts`, `src/script-workflows/workflow-ctx.ts`
**Changes**: Ensure script-runtime SDK dispatch bypasses context truncation by explicit call origin, without tool-name allowlists, and enforce the higher in-sandbox response guard.

#### 2. In-place collection truncation
**File**: `src/tools/utils.ts`
**Changes**: Preserve oversized array keys with the largest non-empty fitting prefix, keep `data.truncation`, and reconcile human-readable counts with surviving elements.

#### 3. Boundary regression tests and docs
**File**: `src/tests/slack-read-boundaries.test.ts`, `src/tests/swarm-tool-result-gate.test.ts`, `src/tests/scripts-runtime.test.ts`, `src/tests/scripts-mcp-e2e.test.ts`, `runbooks/mcp-tool-results.md`, `CLAUDE.md`
**Changes**: Cover complete in-sandbox reads, bounded direct reads, loud guard failure, per-agent overflow isolation, dead store-progress echo, and clean list/search surfaces.

### Success Criteria:

#### Automated Verification:
- [x] Focused result-boundary and script-runtime tests pass.
- [x] In-sandbox SDK responses remain complete below 64 MiB and fail loudly above it.
- [x] Agent-facing overflow keeps a non-empty array, truncation metadata, and an accurate human-readable count.

#### Automated QA:
- [x] Commit diff uses explicit call origin rather than tool-name exceptions.
- [x] Existing per-agent KV isolation and no-echo behavior remain covered.

#### Manual Verification:
- [ ] None.

---

## Phase 5: Live Acceptance, Repository Checks, and Review-Gated PR

### Overview

Exercise the behavior against the live service, run every repository PR check, push the branch, open the PR, and confirm CI without merging.

### Changes Required:

#### 1. Live boundary verification
**File**: Live agent-swarm MCP and script runtime
**Changes**: Compare `ctx.swarm.slack_read({limit:20})` with direct `slack-read` on the same busy channel, then sanity-check `task_list`, `memory_search`, per-agent overflow isolation, and store-progress echo behavior.

#### 2. Full repository validation and PR
**File**: GitHub PR
**Changes**: Run all mandated checks, document the behavior-widening/bug-fix asymmetry and 64 MiB rationale, assign review, and leave merge to Taras.

### Acceptance Evidence:

- Deployed pre-fix baseline on task `05bef5e3-5e89-4fdf-962e-e434a420140c`: both the script SDK and direct `slack_read({ limit: 20 })` paths spill a 33,484-byte result but omit `messages`; `task_list` and `memory_search` remain clean.
- Branch post-fix integration (`bun test src/tests/slack-read-boundaries.test.ts`): the real sandbox/MCP path returns all 20 requested messages to `ctx.swarm.slack_read`, while the direct agent-facing path stays below 10,000 bytes, keeps a non-empty message prefix, and preserves the per-agent overflow pointer.

### Success Criteria:

#### Automated Verification:
- [x] `bun run lint`
- [x] `bun run tsc:check`
- [x] `bun test`
- [x] `bash scripts/check-db-boundary.sh`
- [x] `bun run check:dep-graph`
- [x] `bun run check:rbac-coverage`
- [ ] PR CI is green.

#### Automated QA:
- [x] Deployed pre-fix script SDK failure is measured; the branch's real sandbox/MCP integration returns all requested Slack messages.
- [x] Deployed pre-fix direct failure is measured; the branch integration stays bounded and returns a non-empty truncated array plus overflow pointer.
- [ ] PR body calls out behavior widening, bug fix, guard rationale, compatibility audit, and live measurements.

#### Manual Verification:
- [ ] Taras reviews and decides whether to merge.

---

## Appendix

- **Follow-up plans**: None planned.
- **Derail notes**: Record any genuinely out-of-scope findings here.
- **References**:
  - `thoughts/taras/plans/2026-07-29-swarm-defaults-improvement-plan.md`
  - `runbooks/mcp-tool-results.md`
  - PR #1030
