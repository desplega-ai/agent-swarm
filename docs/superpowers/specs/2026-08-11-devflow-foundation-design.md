# DevFlow Foundation Design

Status: Approved for specification review  
Date: 2026-08-11  
Sources: DevFlow PRD v1.0, DevFlow Functional Specification v1.0, Agent Swarm v1.131.0

## 1. Decision

DevFlow will be built as a bounded product context inside the Agent Swarm monorepo.
Agent Swarm is the execution plane: it owns agent harnesses, workflow execution,
retries, task isolation, human-in-the-loop waits, integrations, memory, and runtime
telemetry. DevFlow is the control plane: it owns lifecycle state, product-domain
records, transition policy, gate decisions, evidence, and customer-facing views.

The authoritative relationship is:

```text
DevFlow transition request
  -> deterministic policy and precondition validation
  -> committed DevFlow state transition and audit event
  -> optional Agent Swarm workflow invocation
  -> workflow evidence linked back to the DevFlow work item
  -> proposed next transition
  -> deterministic DevFlow validation and human gate when required
```

An Agent Swarm task or workflow run never determines lifecycle truth by itself.
An LLM may draft an artifact or propose a transition; only DevFlow's transition
service may change a work item's state.

## 2. Why this design

Three approaches were considered:

1. Embed a dedicated DevFlow domain, API, and UI in Agent Swarm. This reuses the
   runtime while preserving a clear product boundary. This is the selected approach.
2. Run a separate DevFlow service and database. This gives stronger physical
   isolation but immediately duplicates authentication, deployment, observability,
   API plumbing, and transactional coordination.
3. Represent DevFlow only with generic Swarm Apps, tasks, scripts, and workflows.
   This is fast for a demo but cannot reliably enforce lifecycle, tenant, spec,
   audit, and versioning invariants.

The selected design is the smallest complete architecture that preserves the
DevFlow product boundary and keeps Agent Swarm upstream changes adoptable.

## 3. Scope and delivery slices

The full product remains the 11-stage lifecycle and six-view experience defined by
the PRD. It will be delivered as independently verifiable vertical slices.

### Slice 1: Foundation and Spec Loop

This design's implementation milestone includes:

- organization and membership records for tenant isolation;
- WorkItem lifecycle infrastructure covering `captured`, `triaged`, `scoped`,
  `specced`, `blocked`, and `archived`;
- Scope, Spec, acceptance-criteria, NFR, gate-decision, agent-run-link, and audit
  records;
- manual/API capture followed by Intake, Scope, and Spec execution adapters;
- Gate 1 and Gate 2 role and precondition enforcement;
- Idea Inbox, Pipeline Board, and Spec Workbench product views;
- transition, API, tenancy, agent-adapter, and UI tests.

Production Slack/Fathom intake, sizing/planning, build/review, deploy/monitor, and
retrospective behavior remain required product slices but are not coupled to the
foundation implementation. Their domain states are reserved in the state enum so
the lifecycle contract remains stable.

### Later slices

1. Size and Plan: Sizing Agent, Sprint, Planning Game, Sprint Probability.
2. Build and Review: GitHub linkage, Review Agent, Gate 3.
3. Deploy and Monitor: canary evidence, rollback, Gates 4 and 5.
4. Retrospective and Learning: Retro Agent, outcome capture, estimator calibration.
5. Production intake and integrations: Slack, Fathom, Linear synchronization,
   PagerDuty, and email notifications.

## 4. Code boundaries

### Backend domain

New code lives under `src/devflow/`:

```text
src/devflow/
  domain/
    types.ts              domain schemas and enums
    transitions.ts        complete transition graph and gate metadata
    transition-policy.ts  deterministic permission and precondition checks
    errors.ts             stable machine-readable errors
  repositories/
    organizations.ts
    work-items.ts
    specs.ts
    gates.ts
    audit-events.ts
    agent-runs.ts
  services/
    work-item-service.ts   transactional domain operations
    agent-adapter.ts       DevFlow-to-Swarm invocation boundary
    evidence-service.ts    validates and applies structured agent evidence
  api/
    schemas.ts             request and response Zod schemas
    routes.ts              `/api/devflow/v1/*` route definitions
```

The existing API server remains the sole SQLite owner. DevFlow worker-side code
must not import `src/be/db` or `bun:sqlite`. Repository implementations execute
inside the API tier and follow the same database boundary as the rest of Agent
Swarm.

### Frontend

New UI code lives under `apps/ui/src/pages/devflow/` and
`apps/ui/src/components/devflow/`. Routes are grouped below `/devflow`:

```text
/devflow/inbox             Idea Inbox
/devflow/pipeline          Pipeline Board
/devflow/items/:id         Spec Workbench
```

The three routes consume only the DevFlow API. They do not derive state from the
generic task or workflow endpoints. Agent task and workflow links are displayed as
supporting evidence.

### Execution adapter

The adapter invokes versioned Agent Swarm workflows or tasks and persists a
`devflow_agent_runs` link containing the work item, agent mode, workflow/task IDs,
input/output contract version, and terminal outcome. The adapter depends on the
existing Agent Swarm public service functions or HTTP contracts, not on workflow
database internals.

## 5. Persistence model

Agent Swarm's established SQLite architecture remains the persistence engine for
this implementation. DevFlow persistence is hidden behind repositories so a later
PostgreSQL implementation can preserve the domain and API contracts.

All tables use forward-only migrations, UUID text primary keys, ISO-8601 timestamps,
foreign keys, explicit indexes, and the repository's audit-column conventions.

### Tables

`devflow_organizations`

- `id`, `name`, `slug`, `settingsJson`, `isActive`
- `slug` is globally unique.

`devflow_organization_memberships`

- `organizationId`, `userId`, `role`, `isActive`
- unique `(organizationId, userId)`.
- roles: `admin`, `pm_director`, `pm`, `engineering_lead`, `architect`,
  `senior_developer`, `execution_lead`, `qa`, `viewer`.

`devflow_work_items`

- identity and tenancy: `id`, `organizationId`;
- lifecycle: `state`, `previousState`, `blockerReason`, `archiveReason`;
- content: `type`, `title`, `description`, `priority`;
- ownership: `pmOwnerId`, `engineeringOwnerId`, `assignedToUserId`;
- intake: `createdVia`, `sourceMetadataJson`, `capturedAt`;
- planning/release fields reserved for later slices: `storyPoints`, `sprintId`,
  `sprintProbability`, `blastRadius`, `isSecuritySensitive`.

`devflow_scopes`

- one mutable current scope per work item;
- `problemStatement`, `targetUsersJson`, `successCriteriaJson`, `effortBand`,
  `openQuestionsJson`, `confidence`, `agentRunId`, `pmSignedOffAt`.

`devflow_specs`

- immutable versions with unique `(workItemId, version)`;
- structured problem, UX, data, integration, out-of-scope, threat-model,
  rollback, dependency, and open-question fields;
- `status` is `draft` or `approved`;
- material changes after Gate 2 create a new version.

`devflow_acceptance_criteria`

- belongs to a spec version;
- structured `given`, `when`, `then`, `isTestable`, `testStatus`, `linkedTestId`.

`devflow_nfr_declarations`

- one row for each of the nine required NFR categories per spec version;
- `status` is `addressed`, `not_applicable`, or `pending`;
- `statement` is required for `addressed` and `not_applicable`.

`devflow_gate_decisions`

- append-only decision evidence: work item, gate, decision, actor, role at decision
  time, rationale, precondition snapshot, approval-request ID, timestamp.

`devflow_agent_runs`

- work item, mode, status, workflow/task IDs, prompt/contract version, latency,
  cost, error, and structured evidence JSON.

`devflow_audit_events`

- append-only event envelope: organization, work item, actor kind and ID, action,
  before/after state, metadata, request correlation ID, timestamp.

Every domain query requires an organization ID. Cross-organization identifiers are
reported as not found. Foreign-organization associations are rejected before write.

## 6. State machine and gates

The complete stable state set is:

```text
captured -> triaged -> scoped -> specced -> sized -> planned
         -> building -> in_review -> deployed -> monitoring -> done
```

`blocked` is reachable from `scoped`, `specced`, `sized`, `planned`, and `building`
and returns only to the recorded prior state. `archived` is terminal and reachable
from any non-terminal state by an authorized role.

Slice 1 enables these forward transitions:

- `captured -> triaged`: Intake evidence has a non-noise classification, type,
  duplicate decision, and rationale.
- `triaged -> scoped` (Gate 1): a PM/admin approves; required scope fields exist;
  `pmSignedOffAt` is committed with the transition.
- `scoped -> specced` (Gate 2): an engineering lead/admin approves; acceptance
  criteria are non-empty and testable; all nine NFRs are resolved; threat model is
  present for security-sensitive items; blast radius is declared.

Transition execution occurs in one database transaction:

1. load the organization-scoped item and supporting records;
2. check the transition graph;
3. check actor membership and role;
4. check transition-specific preconditions;
5. append a gate decision when applicable;
6. update work-item state;
7. append the audit event;
8. commit;
9. trigger asynchronous execution only after commit.

Failures before commit change nothing.

## 7. API design

The initial API is namespaced under `/api/devflow/v1`:

- `GET /organizations/current`
- `GET /work-items`
- `POST /work-items`
- `GET /work-items/:id`
- `PATCH /work-items/:id`
- `POST /work-items/:id/transitions`
- `GET /work-items/:id/spec`
- `PUT /work-items/:id/spec`
- `GET /work-items/:id/agent-runs`
- `POST /work-items/:id/agent-runs`
- `GET /work-items/:id/audit`

Routes use the repository's `route()` factory, Zod input/output schemas, response
coverage, RBAC declarations, typed response helpers, and OpenAPI generation.

Errors use a stable envelope:

```json
{
  "error_code": "preconditions_not_met",
  "message": "Gate 2 requirements are incomplete.",
  "details": {
    "missing_fields": ["threat_model"],
    "untestable_acceptance_criteria_ids": []
  }
}
```

The first implementation supports cursor-ready filters but may use bounded offset
pagination internally while the tenant-zero dataset is small. The response contract
does not expose storage details.

## 8. Agent and workflow data flow

### Manual capture and triage

1. A user creates a captured work item.
2. The API commits the work item and an audit event.
3. The adapter starts an Intake workflow/task with the canonical input schema.
4. The run link records the Agent Swarm task/workflow identifiers.
5. Structured output is validated by Zod.
6. Valid non-noise evidence is applied and proposes `triaged`.
7. DevFlow validates and commits the transition.
8. Invalid or low-confidence output leaves the item captured and visible for manual
   triage, with the failure evidence attached.

### Scope and Gate 1

1. Triage completion starts the Scope workflow/task.
2. Valid output populates the current scope draft.
3. The PM edits the draft if needed.
4. Gate 1 approval is submitted through the DevFlow transition endpoint.
5. The deterministic transition service records approval and moves to `scoped`.

### Spec and Gate 2

1. `scoped` starts a Spec workflow that may fan out to Spec and Risk modes.
2. Valid evidence creates a draft spec version, AC rows, and nine NFR rows.
3. The workbench exposes unresolved ACs, NFRs, threat model, and blast radius.
4. Gate 2 approval succeeds only when deterministic preconditions pass.
5. The approved spec version and `specced` transition commit atomically.

## 9. UI behavior

### Idea Inbox

Shows captured and triaged items, source, classification, duplicate signal, priority,
agent status, and confidence. It supports manual capture and direct navigation to the
workbench. Agent failure is a visible state, not an empty result.

### Pipeline Board

Shows one column per lifecycle stage with counts and compact cards. Slice 1 can move
items only through enabled transitions; later-stage columns remain informative and
empty until their slices ship. Blocked and archived items are filtered views rather
than primary forward columns.

### Spec Workbench

Shows item context, scope, structured spec, AC checklist, nine NFR declarations,
threat model, blast radius, agent evidence, gate readiness, gate history, and audit
timeline. Approval controls explain missing preconditions before submission and the
API remains authoritative when the UI is stale.

## 10. Security and tenancy

- Organization context is derived from the authenticated user and active membership,
  never accepted as an arbitrary write-body field.
- Every repository method requires organization context.
- Reads for another organization return 404 semantics.
- Roles are checked at the service/API boundary; UI visibility is advisory.
- Agent output is untrusted data and must pass schemas before persistence.
- Agent output cannot approve gates.
- Secrets and raw integration credentials are not stored in DevFlow tables.
- Audit metadata excludes raw secrets and large prompt contents.

Tenant zero is seeded only through an explicit idempotent development/bootstrap path;
production must not silently create organizations or memberships.

## 11. Failure handling

- Illegal transition: `409 invalid_state_transition`, no state change.
- Missing gate input: `422 preconditions_not_met` with actionable field and row IDs.
- Unauthorized gate actor: `403 insufficient_permission`.
- Cross-tenant identifier: `404 not_found`.
- Invalid agent output: run is marked failed, evidence is retained, lifecycle does not
  advance, and manual recovery remains available.
- Workflow start failure after domain commit: work item remains valid; a failed run
  link is recorded and can be retried idempotently.
- Duplicate submission: request correlation/idempotency prevents repeated transitions
  and duplicate agent starts.
- Approval timeout/rejection: the item stays in its current state and the decision is
  appended to gate history.

## 12. Verification strategy

### Domain tests

- every legal transition;
- every illegal transition;
- Gate 1 and Gate 2 role matrices;
- each Gate 2 precondition independently and in combination;
- blocked return-state behavior and archive terminal behavior;
- spec version monotonicity;
- transaction rollback on any failed precondition.

### Tenancy tests

- list, retrieve, update, transition, spec, run, and audit endpoints never expose a
  second organization's rows;
- cross-organization foreign keys and membership use are rejected;
- missing organization context fails closed.

### Adapter tests

- canonical input construction;
- workflow/task ID linkage;
- valid evidence application;
- invalid schema, timeout, and execution failure behavior;
- idempotent retry and no duplicate lifecycle transition.

### API tests

- response schemas and error envelopes;
- RBAC posture;
- OpenAPI generation;
- audit row created for every successful mutation.

### UI tests

- inbox filtering and failure states;
- pipeline state grouping;
- workbench readiness explanations;
- gate controls by role and readiness;
- stale UI receives and renders authoritative API rejection.

### Repository gates

The implementation must pass the narrow DevFlow tests first, then the applicable
Agent Swarm merge-gate checks: lint, TypeScript, root tests, DB-boundary checks,
audit-column checks, dependency graph, OpenAPI freshness, UI lint/typecheck, and a
frontend `qa-use` session with screenshots.

## 13. Compatibility and upstream strategy

DevFlow code is additive and namespaced. Existing generic Agent Swarm task,
workflow, approval, and UI contracts remain intact. DevFlow references runtime
records through adapters and foreign IDs rather than changing their meaning.

The repository tracks Agent Swarm upstream. Upstream changes are merged into the
DevFlow branch; DevFlow-specific changes should avoid broad edits to generic runtime
code. A deep fork is acceptable only where a stable extension point cannot meet a
documented DevFlow invariant.

## 14. Explicit non-goals for Slice 1

- Replacing Agent Swarm's runtime or generic dashboard.
- Shipping all ten agent modes before their lifecycle slices exist.
- Production Slack, Fathom, Linear, PagerDuty, or email configuration.
- Sprint Probability, code generation, deployment control, or retrospective logic.
- Commercial multi-tenant SaaS, billing, public signup, white labeling, or SSO.
- Claiming the full DevFlow v1.0 PRD is shipped when only this foundation slice is
  complete.

## 15. Completion criteria

Slice 1 is complete only when a tenant-zero PM can create a work item, observe Intake
evidence, move through triage, review and approve Scope at Gate 1, review a structured
Spec, resolve all deterministic readiness requirements, approve Gate 2, and see the
complete agent/gate/audit history in the UI. A second test organization must be
present in automated tests, and no operation may expose or mutate its data from the
tenant-zero context.

Passing backend tests without the three usable views, or rendering views backed by
fixture-only data, does not satisfy completion.
