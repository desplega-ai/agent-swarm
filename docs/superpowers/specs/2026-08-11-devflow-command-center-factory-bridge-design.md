# DevFlow to Command Center Factory Bridge Design

Status: Proposed for specification review  
Date: 2026-08-11  
Repositories: `desplega-ai/agent-swarm`, `RebarHQ/sequencer_v3`

## 1. Decision

DevFlow will send approved product intent into the Command Center Factory through
a durable, repository-specific execution bridge. The three systems retain distinct
authority:

```text
DevFlow       owns product intent, scope, approved spec, and lifecycle truth
Agent Swarm   owns bounded workers, retries, isolation, and execution telemetry
Factory       owns repository intake, contracts, sign-offs, proof, merge, and receipts
```

The bridge creates an immutable implementation intent from an approved DevFlow
spec, invokes an Agent Swarm coordinator, and reconciles the result against the
Factory's canonical files. Agent output is never accepted as repository truth
without that reconciliation.

This bridge does not create a second implementation queue, contract format, merge
path, or finalizer. It enters the Factory using its canonical writers and observes
the Factory state machine through its persisted artifacts.

## 2. Smallest complete slice

The first bridge slice includes:

- organization-scoped repository targets;
- immutable implementation intents derived from approved spec versions;
- a Command Center Factory execution adapter backed by Agent Swarm tasks;
- canonical upstream-authority fields in Factory contracts;
- reconciliation of queue items, contracts, sign-offs, artifacts, pull requests,
  and finalizer receipts;
- an Implementation panel in the DevFlow Spec Workbench;
- API, persistence, tenancy, adapter, security, and UI tests;
- a local end-to-end fixture that exercises the real bridge without modifying a
  production repository.

The slice deliberately does not implement sizing, sprint planning, GitHub review,
deployment, monitoring, or automatic completion. It proves the product-to-factory
boundary end to end while keeping later DevFlow lifecycle states honest.

## 3. Authority and lifecycle

### 3.1 DevFlow authority

An implementation intent may be created only when:

- the work item belongs to the caller's organization;
- the selected spec version belongs to that work item;
- the spec is approved by Gate 2;
- the repository target is active and belongs to the same organization; and
- no active intent already exists for the same work item, spec version, and target.

Creation snapshots the spec and computes a SHA-256 digest over canonical JSON.
Later edits or a new spec version require a new implementation intent. Existing
intents and their receipts remain immutable audit evidence.

In this slice, sending an intent to the Factory does not advance the work item from
`specced`. Size and Plan will own the future transitions to `sized` and `planned`.
Likewise, a Factory merge receipt does not mean `deployed`, `monitoring`, or `done`.

### 3.2 Factory authority

The Command Center Factory remains authoritative for:

- queue item identity, revision, priority, dependencies, and status;
- repository surfaces, impacted surfaces, and architecture units;
- implementation contracts and surface sign-offs;
- required checks and focused proof;
- pull request and exact-head finalization;
- merge and closure handoff receipts.

DevFlow records these values as observations. It cannot directly mark a Factory
contract signed off, a pull request admitted, or a change merged.

### 3.3 Agent Swarm authority

Agent Swarm owns the execution attempt: task identity, worker assignment, retry
history, timestamps, logs, and terminal result. A successful task means only that
the coordinator completed its assigned procedure. The adapter must still verify
the referenced Factory records.

## 4. DevFlow domain model

### 4.1 Repository target

`DevFlowRepositoryTarget` identifies an administrator-approved checkout in which a
bridge may operate:

```text
id
organizationId
name
repositoryFullName
defaultBranch
executionProfile       command_center_factory
checkoutPath
isActive
createdAt
lastUpdatedAt
```

`checkoutPath` is server configuration. Starting an execution accepts a target ID,
never an arbitrary path or command from the request. The repository layer enforces
organization isolation.

### 4.2 Implementation intent

`DevFlowImplementationIntent` is append-only product authority:

```text
id
organizationId
workItemId
specId
specVersion
specDigest
repositoryTargetId
desiredOutcome
priority
riskSummary
intentSnapshotJson
createdByUserId
createdAt
```

`intentSnapshotJson` contains the work-item summary, scope, approved spec,
acceptance criteria, NFR declarations, explicit exclusions, dependencies, threat
model, rollback requirements, and Gate 2 evidence. Serialization uses sorted object
keys and stable array order before hashing.

### 4.3 Factory execution

`DevFlowFactoryExecution` is the bridge attempt and observed receipt record:

```text
id
organizationId
implementationIntentId
agentRunId
status
queueItemId
queueItemRevision
contractId
canonicalContractPath
factoryStatus
surfacesJson
impactedSurfacesJson
architectureUnitsJson
signoffsJson
artifactsJson
pullRequestJson
finalizerReceiptJson
mergedCommitSha
lastObservedAt
failureCode
failureDetail
createdAt
lastUpdatedAt
```

Execution status is one of:

```text
queued
factory_intake
signoff_pending
ready
implementing
pr_open
finalizer_admitted
merged
failed
cancelled
```

Status is derived from verified Factory artifacts, except `queued`, `failed`, and
`cancelled`, which describe the bridge attempt itself. Updates never erase prior
IDs, receipts, or failure evidence.

## 5. Factory contract extension

The Factory contract gains an optional, structured `upstream_authority` object:

```yaml
upstream_authority:
  system: devflow
  work_item_id: <uuid>
  artifact_type: implementation_intent
  artifact_id: <uuid>
  artifact_version: 1
  artifact_digest: sha256:<hex>
```

The canonical Factory writer accepts these values as explicit arguments or a
validated JSON payload. It writes the object in canonical key order. Contract
amendment preserves it, validation rejects partial or malformed authority, and the
scope fingerprint includes it so silent substitution invalidates sign-offs.

The field is optional for existing non-DevFlow contracts. No compatibility mirror
is written into free-form notes. Factory tests cover creation, amendment,
fingerprinting, malformed input, and unchanged legacy contract creation.

## 6. Execution flow

```text
1. User selects an active Command Center repository target in DevFlow.
2. DevFlow validates Gate 2 and persists an immutable implementation intent.
3. DevFlow creates a queued factory execution and Agent Swarm task atomically.
4. A coordinator receives the immutable intent, target identity, and strict output schema.
5. The coordinator uses the repository's Factory skill and canonical CLI writers.
6. It creates or resumes one queue item and one contract carrying upstream_authority.
7. The coordinator returns only identifiers and candidate receipt locations.
8. DevFlow reads the canonical files beneath the approved checkout.
9. DevFlow validates IDs, digest, path containment, sign-offs, and receipts.
10. DevFlow updates the observed execution status and appends an audit event.
11. Reconciliation can be repeated safely until the Factory reports merge or failure.
```

Retries are idempotent. The upstream implementation-intent ID is the idempotency
key. Before creating anything, the coordinator searches the Factory queue and
contracts for the matching `upstream_authority.artifact_id`. A retry resumes the
existing records rather than creating duplicates.

## 7. Adapter boundaries

DevFlow depends on two injectable interfaces:

```ts
interface FactoryTaskRuntime {
  create(input: FactoryTaskInput): Promise<{ taskId: string }>;
  get(taskId: string): Promise<FactoryTaskResult>;
}

interface FactoryArtifactRuntime {
  inspect(input: FactoryInspectionInput): Promise<VerifiedFactorySnapshot>;
}
```

The task runtime wraps existing Agent Swarm task services. The artifact runtime
resolves only the configured target checkout and reads only allowed Factory paths.
Tests use in-memory task doubles and temporary fixture repositories.

The task contract requires structured output containing candidate queue, contract,
and receipt identifiers. Prompt instructions require the repository Factory skill,
canonical writers, one reviewed slice, required focused proof, and finalizer
ownership of merge. Free-form worker prose is retained as telemetry but is not
parsed into domain state.

## 8. Reconciliation rules

Reconciliation fails closed unless all applicable checks pass:

- the checkout resolves beneath the configured repository root;
- the contract path resolves beneath `.dev_harness/contracts`;
- queue and contract files are regular files, not escaping symlinks;
- the contract ID, queue item ID, and canonical path agree;
- `upstream_authority` matches the intent ID, work item ID, version, and digest;
- referenced sign-offs apply to the current scope fingerprint;
- a pull-request receipt agrees with the recorded repository and head SHA;
- a merge claim includes the Factory finalizer receipt and exact merged SHA.

Missing or contradictory evidence produces `failed` with a stable failure code and
an audit event. It never upgrades the DevFlow work-item state.

## 9. API

All endpoints are under `/api/devflow/v1` and require organization membership.

```text
GET    /repository-targets
POST   /repository-targets
PATCH  /repository-targets/:id

GET    /work-items/:id/implementation-intents
POST   /work-items/:id/implementation-intents

GET    /factory-executions/:id
POST   /factory-executions/:id/reconcile
POST   /factory-executions/:id/cancel
```

Creating and updating repository targets requires `admin`. Creating an intent
requires `pm`, `pm_director`, or `admin`. Reconciliation may be initiated by those
roles or by an authenticated system actor. Cancellation stops future bridge work;
it does not delete or mutate existing Factory records.

Responses expose verified snapshots, agent task links, timestamps, and stable
failure codes. They never expose absolute checkout paths or raw process output.

## 10. User experience

The Spec Workbench gains an Implementation panel after Gate 2 approval. It shows:

- selected repository target;
- immutable spec version and digest;
- Factory execution status and last observation time;
- queue item and contract identifiers;
- required surfaces, sign-off state, and proof artifacts;
- pull request, finalizer, and merge receipts when verified;
- explicit language that Factory merge is not deployment or DevFlow completion.

The primary action is `Send to Command Center Factory`. Once created, the intent
cannot be edited. A changed spec presents `Create new implementation intent` and
keeps the earlier execution history visible.

## 11. Security and operational constraints

- Process invocation uses argument arrays without a shell.
- Checkout paths and executable profiles are administrator-configured and
  allowlisted.
- Commands have timeouts and bounded stdout/stderr capture.
- Secrets and environment values are never copied into intent snapshots, task
  outputs, API responses, or audit metadata.
- Raw coordinator output is untrusted and schema-validated.
- File reads reject path traversal and symlink escape.
- Repository writes occur only through the Factory coordinator and canonical
  Factory tools; the DevFlow API does not edit repository files directly.
- This slice does not push, merge, deploy, or mutate production configuration
  outside the Factory's existing authorization model.

## 12. Failure and recovery

- Agent task creation failure leaves a persisted failed execution with evidence.
- Worker interruption is retryable using the implementation-intent idempotency key.
- Invalid task output is recorded but cannot create a verified Factory binding.
- Missing Factory files keep the execution at `factory_intake` or fail with a
  specific evidence code, depending on whether the task is still active.
- Scope fingerprint changes demote the observed status to `signoff_pending`.
- A superseded spec creates a new intent; it does not rewrite the old contract.
- Cancellation is append-only and does not attempt destructive cleanup in the
  Command Center repository.

## 13. Verification

Implementation follows test-driven development in two repositories.

DevFlow tests cover:

- tenant and role isolation;
- Gate 2 and approved-spec preconditions;
- stable canonical snapshots and digests;
- intent idempotency and immutability;
- Agent Swarm task input and strict output validation;
- path containment and symlink rejection;
- canonical artifact reconciliation and status derivation;
- contradictory or incomplete receipt failures;
- API contracts and Workbench behavior.

Factory tests cover:

- `upstream_authority` writer arguments and serialization;
- schema validation and canonical key ordering;
- preservation across contract amendment;
- inclusion in scope fingerprints;
- rejection of partial or invalid authority;
- unchanged behavior for contracts without upstream authority.

The local end-to-end test creates a temporary Factory fixture, launches a real
Agent Swarm server and worker, submits an approved DevFlow spec, creates canonical
queue and contract records, reconciles them, and verifies the UI/API readback. It
does not write to `RebarHQ/sequencer_v3` or require production credentials.

## 14. Delivery order

1. Extend and test the Factory contract schema and canonical writers.
2. Add DevFlow persistence and repository-target administration.
3. Add immutable intent creation and digesting.
4. Add the Agent Swarm coordinator task adapter.
5. Add canonical artifact reconciliation and status derivation.
6. Add APIs and the Spec Workbench Implementation panel.
7. Run focused tests, full affected suites, and the local end-to-end fixture.

Each step remains functional and testable. The bridge is complete only when a real
approved DevFlow spec can produce a verified Factory queue/contract binding through
Agent Swarm and the readback is visible in DevFlow.
