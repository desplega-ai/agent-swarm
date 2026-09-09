---
status: completed
---

# Issue #1122 capability broker implementation plan

## Overview

Move durable script-workflow user modules into a credential-free Bun guest and expose their existing context through a JSON-marshaled host capability interface. The host harness retains the bearer, HTTP/error behavior, lifecycle callbacks, and 64 MiB response guard.

- **Motivation**: Issue #1122; `@tarasyarema` requested a PR implementing suggested direction 1.
- **Related**: [Issue #1122](https://github.com/desplega-ai/agent-swarm/issues/1122)

## Current State Analysis

`src/script-workflows/harness.ts:15-104` reads the bearer from stdin, imports the user module into that same realm, builds the authenticated workflow context, and sends heartbeat/status requests through mutable `globalThis.fetch`. `src/script-workflows/workflow-ctx.ts:163-410` centralizes every authenticated `ctx.step.*` and `ctx.swarm.*` request and already enforces `readScriptSdkJsonResponse` before returning values.

The sibling one-off path has the same shared-realm import (`src/scripts-runtime/eval-harness.ts:100-158`), but its public contract explicitly exposes `ctx.swarm.config.apiKey` and the public `Redacted.value()` unwrap escape hatch. `src/tests/script-executor-conformance.test.ts:110-118` requires plaintext extraction, and three seeded scripts rely on it. Exact compatibility and bearer absence are therefore mutually exclusive on that path.

The existing `src/scripts-runtime/credential-broker/` is a separate vendor-egress substitution layer. It deliberately sends resolved third-party credentials into the one-off guest and patches its fetch; durable workflows do not use it.

## Desired End State

The API-side executor is a trusted broker that alone retains the bearer and performs authenticated HTTP. It spawns one Bun process with a scrubbed, nonsecret environment; only that guest imports user source. Guest `ctx.step.*` and `ctx.swarm.*` calls cross a correlated JSON request/response capability interface over a Unix socket. The public durable workflow context and its current result/error semantics remain unchanged.

## What We're NOT Doing

- The one-off `script-run` migration is deferred because it requires an explicit SDK decision for `ctx.swarm.config.apiKey`, migration of bearer-authenticated `ctx.mcp`, and seed-script updates.
- External `ctx.api`/egress credentials remain governed by the existing credential substitution broker; isolating them requires marshaling `Response`, binary, and streaming semantics.
- Same-UID OS isolation remains issue #1122 direction 2.
- Bridge results remain buffered JSON, matching current behavior; streaming/back-pressure is deferred.

## Implementation Approach

- Add a transport-neutral `invokeTool(path, argsJson) -> resultJson` contract with correlated JSON envelopes, serialized error propagation, disconnect rejection, and a 64 MiB marshaled-result guard.
- Authenticate the randomized per-run socket before user import, cap host-side concurrency and queued response bytes, and honor socket backpressure.
- Run the capability host in the API-side executor. It builds the real context, owns heartbeat/status, and dispatches only allowlisted `step.*` and `swarm.*` capabilities. The existing harness becomes a credential-free guest and alone imports user code.
- Reuse the current `buildWorkflowCtx` in the host so REST mapping, retries, journaling, error strings, and HTTP response limits remain unchanged.

## Quick Verification Reference

- `bun run test:root -- src/tests/script-workflow-capability-bridge.test.ts src/tests/workflow-ctx.test.ts`
- `bun run test:root -- src/tests/script-workflows-runtime-e2e.test.ts`
- `bun run lint:fix`
- `bun run tsc:check`

---

## Phase 1: JSON capability transport

### Overview

Add the reusable correlated JSON request/response interface used by the workflow host and guest.

### Changes Required:

#### 1. Capability bridge
**File**: `src/script-workflows/capability-bridge.ts`
**Changes**: Define strict envelopes, guest pending-call correlation, host dispatch/error serialization, disconnect behavior, and marshaled result size enforcement.

#### 2. Transport tests
**File**: `src/tests/script-workflow-capability-bridge.test.ts`
**Changes**: Cover concurrency, value/error round-trips, malformed messages, disconnects, and response overflow.

### Success Criteria:

#### Automated Verification:

- [x] Focused bridge tests pass: `bun test src/tests/script-workflow-capability-bridge.test.ts`.
- [x] Existing workflow context tests pass with bridge coverage.

#### Automated QA:

- [x] Concurrent calls correlate responses independently and serialize only JSON strings across the socket.

#### Manual Verification:

- [ ] None.

---

## Phase 2: Credential-free workflow guest

### Overview

Move credential-bearing workflow operations into the API-side executor and run user source exclusively in the existing sandboxed harness process.

### Changes Required:

#### 1. Credential-free harness
**File**: `src/script-workflows/harness.ts`
**Changes**: Connect to the broker, build the public guest facade, import user code, and hand result/errors back through nonsecret files.

#### 2. Runtime wiring
**File**: `src/script-workflows/executor.ts`
**Changes**: Host the Unix-socket capability server, authenticated workflow context, heartbeat/status callbacks, and in-flight drain behavior; spawn exactly one sandboxed, credential-free harness.

#### 3. Security and compatibility coverage
**File**: `src/tests/script-workflows-runtime-e2e.test.ts`
**Changes**: Prove a user fetch replacement cannot observe the bearer while `ctx.swarm.*` and lifecycle callbacks still authenticate; retain env, bundle, and durable-step tests.

### Success Criteria:

#### Automated Verification:

- [x] Workflow unit tests pass: `bun test src/tests/workflow-ctx.test.ts`.
- [x] Workflow runtime E2E passes: `bun test src/tests/script-workflows-runtime-e2e.test.ts`.
- [x] Formatting passes: `bun run lint:fix`.
- [x] Type checking passes: `bun run tsc:check`.

#### Automated QA:

- [x] Guest `globalThis.fetch` replacement observes no authenticated host request or plaintext bearer.
- [x] Existing `ctx.swarm.*` result/error behavior remains host-backed and unchanged.
- [x] Host heartbeat and terminal status callbacks remain functional.

#### Manual Verification:

- [ ] None.

---

## Appendix

- **Follow-up plans**: One-off eval SDK migration; same-UID isolation; optional streaming bridge.
- **Derail notes**: The current one-off API-key unwrap behavior is the only premise that prevents closing both paths without an SDK change. No verified premise in the task was contradicted.
- **References**: Issue #1122 and its 2026-08-08 `just-bash` design refinement.
