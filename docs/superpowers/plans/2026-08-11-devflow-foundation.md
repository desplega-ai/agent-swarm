# DevFlow Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a usable tenant-isolated DevFlow Capture→Triage→Scope→Spec lifecycle with deterministic Gates 1 and 2, Agent Swarm task execution, audit evidence, and three product views.

**Architecture:** DevFlow is an additive bounded context inside Agent Swarm. Dedicated repositories and a transition service own lifecycle truth; an adapter links versioned structured tasks from the existing Swarm execution plane. The existing Bun API server and React dashboard expose `/api/devflow/v1/*` and `/devflow/*` without changing generic task/workflow semantics.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, Zod, existing `route()` HTTP framework, React, React Router, TanStack Query, Tailwind/shadcn components, Bun test.

## Global Constraints

- The API server is the sole SQLite owner; no worker-side DevFlow code imports `src/be/db` or `bun:sqlite`.
- Every DevFlow query takes an organization ID and fails closed when tenant context is absent.
- Agent output is untrusted structured evidence; it never approves a gate or directly mutates lifecycle state.
- Every state-changing operation commits its audit event in the same transaction.
- Use the existing prompt/output-schema task mechanism; do not add a second agent runtime.
- Add only forward migration `130_devflow_foundation.sql`; never edit an applied migration.
- Register every new HTTP handler in `src/http/all-routes.ts`, give non-GET routes an explicit RBAC posture, and declare schemas for all JSON 2xx responses.
- UI work must finish with the exact `qa-use` verification path required by `LOCAL_TESTING.md` and screenshots.
- Slice completion is not full DevFlow v1.0 completion; later lifecycle states remain stable but disabled until their slices ship.

---

### Task 1: Persistence and Domain Schemas

**Files:**
- Create: `src/be/migrations/130_devflow_foundation.sql`
- Create: `src/devflow/domain/types.ts`
- Create: `src/devflow/repository.ts`
- Test: `src/tests/devflow-repository.test.ts`
- Modify: `.non-audit-tables`

**Interfaces:**
- Produces: `DevFlowRepository`, `DevFlowContext`, `DevFlowWorkItem`, `DevFlowScope`, `DevFlowSpec`, `DevFlowAgentRun`, `DevFlowAuditEvent`.
- Repository entry point: `createDevFlowRepository(db: Database): DevFlowRepository`.
- Every repository read signature begins with `organizationId: string`.

- [ ] **Step 1: Write repository and tenant-isolation tests**

```ts
test("lists only the requested organization's work items", () => {
  const orgA = repo.createOrganization({ id: crypto.randomUUID(), name: "A", slug: "a" });
  const orgB = repo.createOrganization({ id: crypto.randomUUID(), name: "B", slug: "b" });
  repo.createWorkItem({ organizationId: orgA.id, title: "Visible", description: "A", createdVia: "manual", pmOwnerId: userA.id });
  repo.createWorkItem({ organizationId: orgB.id, title: "Hidden", description: "B", createdVia: "manual", pmOwnerId: userB.id });
  expect(repo.listWorkItems(orgA.id, {}).items.map((item) => item.title)).toEqual(["Visible"]);
});

test("cannot resolve a foreign-organization item", () => {
  expect(repo.getWorkItem(orgB.id, itemA.id)).toBeNull();
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `bun run test:root -- src/tests/devflow-repository.test.ts`  
Expected: FAIL because the migration, schemas, and repository do not exist.

- [ ] **Step 3: Add the forward-only schema**

Create the ten tables from the design with explicit foreign keys and indexes:

```sql
CREATE TABLE devflow_organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  settingsJson TEXT NOT NULL DEFAULT '{}',
  isActive INTEGER NOT NULL DEFAULT 1 CHECK (isActive IN (0, 1)),
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  lastUpdatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT REFERENCES users(id),
  updated_by TEXT REFERENCES users(id)
);
```

Apply the same conventions to memberships, work items, scopes, specs, acceptance criteria, NFR declarations, gate decisions, agent runs, and audit events. Add `devflow_audit_events` to `.non-audit-tables` because it is itself append-only audit evidence; every other mutable table has `created_by` and `updated_by`.

- [ ] **Step 4: Implement Zod domain schemas and repository mapping**

```ts
export const DevFlowStateSchema = z.enum([
  "captured", "triaged", "scoped", "specced", "sized", "planned",
  "building", "in_review", "deployed", "monitoring", "done", "blocked", "archived",
]);

export interface DevFlowRepository {
  createOrganization(input: CreateOrganizationInput): DevFlowOrganization;
  addMembership(input: CreateMembershipInput): DevFlowMembership;
  createWorkItem(input: CreateWorkItemInput): DevFlowWorkItem;
  getWorkItem(organizationId: string, id: string): DevFlowWorkItem | null;
  listWorkItems(organizationId: string, filters: WorkItemFilters): WorkItemPage;
  transaction<T>(fn: () => T): T;
}
```

JSON parsing must occur in row mappers and validate through Zod before values cross the repository boundary.

- [ ] **Step 5: Run repository tests and schema checks**

Run: `bun run test:root -- src/tests/devflow-repository.test.ts`  
Expected: PASS.  
Run: `bash scripts/check-audit-columns.sh`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add .non-audit-tables src/be/migrations/130_devflow_foundation.sql src/devflow src/tests/devflow-repository.test.ts
git commit -m "feat(devflow): add tenant-isolated domain persistence"
```

### Task 2: Deterministic State Machine and Gates

**Files:**
- Create: `src/devflow/domain/transitions.ts`
- Create: `src/devflow/domain/errors.ts`
- Create: `src/devflow/services/transition-service.ts`
- Test: `src/tests/devflow-transition-service.test.ts`

**Interfaces:**
- Consumes: `DevFlowRepository` from Task 1.
- Produces: `createTransitionService(repo): DevFlowTransitionService`.
- Main method: `transition(context: DevFlowContext, itemId: string, request: TransitionRequest): TransitionResult`.

- [ ] **Step 1: Write table-driven state and gate tests**

```ts
test.each([
  ["captured", "triaged"],
  ["triaged", "scoped"],
  ["scoped", "specced"],
])("permits %s -> %s when evidence and role are valid", (from, to) => {
  const item = fixture.atState(from);
  fixture.satisfyPreconditions(item.id, to);
  expect(service.transition(pmOrLeadContext(to), item.id, { toState: to, rationale: "ready" }).toState).toBe(to);
});

test("rolls back state, gate decision, and audit together", () => {
  const before = fixture.counts();
  expect(() => service.transition(pmContext, item.id, { toState: "specced" })).toThrow(DevFlowError);
  expect(repo.getWorkItem(org.id, item.id)?.state).toBe("scoped");
  expect(fixture.counts()).toEqual(before);
});
```

Cover every legal Slice 1 edge, every disabled later-stage edge, blocked restoration, archived terminal behavior, insufficient roles, missing scope fields, untestable ACs, pending NFRs, missing security threat model, and missing blast radius.

- [ ] **Step 2: Run and confirm failure**

Run: `bun run test:root -- src/tests/devflow-transition-service.test.ts`  
Expected: FAIL because transition policy is absent.

- [ ] **Step 3: Implement the explicit transition graph and stable errors**

```ts
export const TRANSITIONS: Readonly<Record<DevFlowState, readonly DevFlowState[]>> = {
  captured: ["triaged", "archived"],
  triaged: ["scoped", "archived"],
  scoped: ["specced", "blocked", "archived"],
  specced: ["blocked", "archived"],
  sized: ["blocked", "archived"],
  planned: ["blocked", "archived"],
  building: ["blocked", "archived"],
  in_review: ["archived"], deployed: ["archived"], monitoring: ["archived"],
  done: [], blocked: [], archived: [],
};

export class DevFlowError extends Error {
  constructor(readonly status: 403 | 404 | 409 | 422, readonly errorCode: string, message: string, readonly details: Record<string, unknown> = {}) { super(message); }
}
```

Blocked restoration is handled as a special transition to `previousState`; it is never an arbitrary edge.

- [ ] **Step 4: Implement transactional gate enforcement**

Inside one `repo.transaction`: load tenant-scoped item and membership, validate edge, role, and preconditions, append `devflow_gate_decisions` if required, update the item, append audit, and return the committed result. Do not start an agent task inside this transaction.

- [ ] **Step 5: Run focused tests**

Run: `bun run test:root -- src/tests/devflow-transition-service.test.ts`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/devflow/domain src/devflow/services/transition-service.ts src/tests/devflow-transition-service.test.ts
git commit -m "feat(devflow): enforce lifecycle and approval gates"
```

### Task 3: Structured Scope and Spec Evidence

**Files:**
- Create: `src/devflow/domain/agent-contracts.ts`
- Create: `src/devflow/services/evidence-service.ts`
- Test: `src/tests/devflow-evidence-service.test.ts`

**Interfaces:**
- Consumes: repository and transition service.
- Produces: `IntakeEvidenceSchema`, `ScopeEvidenceSchema`, `SpecEvidenceSchema`, JSON Schema equivalents, and `applyAgentEvidence(context, agentRunId, output)`.

- [ ] **Step 1: Write evidence validation and application tests**

```ts
test("valid intake evidence advances captured item to triaged", () => {
  evidence.applyAgentEvidence(systemContext, run.id, intakeFixture({ classification: "feature" }));
  expect(repo.getWorkItem(org.id, item.id)?.state).toBe("triaged");
});

test("invalid spec evidence is retained but cannot change lifecycle", () => {
  expect(() => evidence.applyAgentEvidence(systemContext, run.id, { acClauses: [] })).toThrow();
  expect(repo.getAgentRun(org.id, run.id)?.status).toBe("failed");
  expect(repo.getWorkItem(org.id, item.id)?.state).toBe("scoped");
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `bun run test:root -- src/tests/devflow-evidence-service.test.ts`  
Expected: FAIL because contracts and evidence service do not exist.

- [ ] **Step 3: Implement canonical contracts**

Copy the PRD Functional Specification field semantics into strict Zod objects. Convert them to JSON Schema with the repository's existing Zod/OpenAPI tooling or a small explicit JSON Schema constant; do not maintain differently named fields.

```ts
export const IntakeEvidenceSchema = z.strictObject({
  classification: z.enum(["feature", "bug", "idea", "task", "architecture", "ops", "noise"]),
  title: z.string().min(1).max(120),
  description: z.string().min(1),
  suggestedPriority: DevFlowPrioritySchema.nullable(),
  duplicateOf: z.string().nullable(),
  duplicateConfidence: z.number().min(0).max(1),
  okrLinks: z.array(z.string()),
  isSecuritySensitiveSignal: z.boolean(),
  customerSignalPresent: z.boolean(),
  rationale: z.string().min(1),
});
```

- [ ] **Step 4: Apply evidence transactionally**

Intake updates classification fields then calls the transition service. Scope upserts exactly one current draft. Spec creates version 1, AC rows, and all nine NFR rows. Any validation failure marks the agent-run link failed with a scrubbed error and does not mutate domain artifacts.

- [ ] **Step 5: Run evidence and transition tests**

Run: `bun run test:root -- src/tests/devflow-evidence-service.test.ts src/tests/devflow-transition-service.test.ts`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/devflow/domain/agent-contracts.ts src/devflow/services/evidence-service.ts src/tests/devflow-evidence-service.test.ts
git commit -m "feat(devflow): validate and apply agent evidence"
```

### Task 4: Agent Swarm Execution Adapter

**Files:**
- Create: `src/devflow/services/agent-adapter.ts`
- Create: `src/devflow/prompts.ts`
- Test: `src/tests/devflow-agent-adapter.test.ts`

**Interfaces:**
- Consumes: `createTaskExtended`, `getTaskById`, structured output schemas, repository.
- Produces: `startAgentRun(context, itemId, mode): DevFlowAgentRun` and `reconcileAgentRun(context, runId): DevFlowAgentRun`.

- [ ] **Step 1: Write adapter tests with injected task-runtime fakes**

```ts
test("starts an unassigned Swarm task with bounded context and output schema", () => {
  const run = adapter.startAgentRun(context, item.id, "intake");
  expect(runtime.created[0]).toMatchObject({ source: "api", taskType: "devflow-intake" });
  expect(runtime.created[0].outputSchema.required).toContain("classification");
  expect(run.swarmTaskId).toBe(runtime.created[0].id);
});

test("reconciliation applies completed structured output once", () => {
  runtime.complete(taskId, JSON.stringify(intakeFixture()));
  adapter.reconcileAgentRun(context, run.id);
  adapter.reconcileAgentRun(context, run.id);
  expect(repo.listAuditEvents(org.id, item.id).filter((e) => e.action === "work_item.triaged")).toHaveLength(1);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `bun run test:root -- src/tests/devflow-agent-adapter.test.ts`  
Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement injected runtime boundary and prompt registry**

```ts
export interface SwarmTaskRuntime {
  create(task: string, options: CreateTaskOptions): AgentTask;
  get(id: string): AgentTask | null;
}

export type DevFlowAgentMode = "intake" | "scope" | "spec";
```

Prompts contain the minimum domain context, state that input is data rather than instructions, require the canonical output schema, and never contain gate-approval authority. Keep prompt assembly in `src/devflow/prompts.ts`, not inline in routes.

- [ ] **Step 4: Implement reconciliation**

Map queued/running/failed/completed Swarm states into DevFlow agent-run states. Parse `AgentTask.output` only when completed. Call evidence application once, guarded by the run's terminal/applied state. Store task ID and contract version before returning from `startAgentRun`.

- [ ] **Step 5: Run adapter tests**

Run: `bun run test:root -- src/tests/devflow-agent-adapter.test.ts`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/devflow/services/agent-adapter.ts src/devflow/prompts.ts src/tests/devflow-agent-adapter.test.ts
git commit -m "feat(devflow): connect lifecycle to Swarm tasks"
```

### Task 5: DevFlow REST API, RBAC, and OpenAPI

**Files:**
- Create: `src/http/devflow.ts`
- Create: `src/devflow/api/schemas.ts`
- Modify: `src/http/index.ts`
- Modify: `src/http/all-routes.ts`
- Modify: `src/rbac/permissions.ts`
- Modify: `src/rbac/legacy-policy.ts`
- Modify: `src/be/rbac-roles.ts`
- Modify: `openapi.json`
- Test: `src/tests/devflow-http.test.ts`

**Interfaces:**
- Produces the `/api/devflow/v1` surface from the design.
- Request identity comes from `getCurrentRequestUserId()`; local operator requests may provide `X-DevFlow-User-ID`, but user-token identity always wins and the header must not override it.

- [ ] **Step 1: Write real HTTP route tests**

Cover current organization, create/list/get/patch, transition success, 403 role denial, 404 cross-tenant, 409 illegal edge, 422 gate precondition error, scope get/put, spec get/put, agent-run start/reconcile/list, and audit list.

```ts
const response = await api("POST", `/api/devflow/v1/work-items/${item.id}/transitions`, {
  userId: pm.id,
  body: { toState: "scoped", rationale: "Gate 1 approved" },
});
expect(response.status).toBe(200);
expect(await response.json()).toMatchObject({ fromState: "triaged", toState: "scoped" });
```

- [ ] **Step 2: Run and confirm failure**

Run: `bun run test:root -- src/tests/devflow-http.test.ts`  
Expected: FAIL with missing routes.

- [ ] **Step 3: Add DevFlow permission verbs and policies**

Add `devflow.work-item.write`, `devflow.gate.approve`, and `devflow.agent-run.start`. Legacy policy permits authenticated users through to the domain role check; the domain service remains responsible for organization membership and gate roles.

- [ ] **Step 4: Implement typed routes and handler**

Use `route()` for every route, typed Zod response schemas, `rbac` on mutations, and `DevFlowError` mapping to the stable `{ error_code, message, details }` envelope. Add `handleDevFlow` to the HTTP dispatch chain and side-effect import to `all-routes.ts`.

Implement these exact routes: `GET /api/devflow/v1/organizations/current`, `GET|POST /api/devflow/v1/work-items`, `GET|PATCH /api/devflow/v1/work-items/{id}`, `POST /api/devflow/v1/work-items/{id}/transitions`, `GET|PUT /api/devflow/v1/work-items/{id}/scope`, `GET|PUT /api/devflow/v1/work-items/{id}/spec`, `GET|POST /api/devflow/v1/work-items/{id}/agent-runs`, `POST /api/devflow/v1/agent-runs/{id}/reconcile`, and `GET /api/devflow/v1/work-items/{id}/audit`.

- [ ] **Step 5: Run focused HTTP and coverage checks**

Run: `bun run test:root -- src/tests/devflow-http.test.ts`  
Expected: PASS.  
Run: `bun run check:rbac-coverage`  
Expected: PASS.  
Run: `bun run check:openapi-response-coverage`  
Expected: PASS.

- [ ] **Step 6: Regenerate OpenAPI and commit**

Run: `bun run docs:openapi`  
Expected: `openapi.json` and API reference outputs contain DevFlow routes.

```bash
git add src/http/devflow.ts src/http/index.ts src/http/all-routes.ts src/devflow/api src/rbac openapi.json docs-site/content/docs/api-reference
git commit -m "feat(devflow): expose lifecycle API"
```

### Task 6: UI API Client, Identity, Navigation, and Shared Components

**Files:**
- Modify: `apps/ui/src/api/types.ts`
- Modify: `apps/ui/src/api/client.ts`
- Create: `apps/ui/src/api/hooks/use-devflow.ts`
- Modify: `apps/ui/src/app/router.tsx`
- Modify: `apps/ui/src/components/layout/app-sidebar.tsx`
- Create: `apps/ui/src/components/devflow/state-badge.tsx`
- Create: `apps/ui/src/components/devflow/agent-run-status.tsx`
- Test: `apps/ui/src/components/devflow/state-badge.test.tsx`

**Interfaces:**
- Produces `useDevFlowWorkItems`, `useDevFlowWorkItem`, `useCreateDevFlowWorkItem`, `useTransitionDevFlowWorkItem`, `useSaveDevFlowSpec`, `useStartDevFlowAgentRun`.
- Every mutation passes the current-user ID only when the API is using operator authentication; user-bound tokens remain server-authoritative.

- [ ] **Step 1: Write shared component and hook contract tests**

```tsx
render(<DevFlowStateBadge state="specced" />);
expect(screen.getByText("Specced")).toBeVisible();
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/ui && bun test src/components/devflow/state-badge.test.tsx`  
Expected: FAIL because DevFlow UI types and components do not exist.

- [ ] **Step 3: Add exact API types, client methods, and TanStack Query hooks**

Use query keys rooted at `['devflow']`. Successful mutations invalidate item, list, and audit keys. Convert non-2xx error envelopes into `DevFlowApiError` with `status`, `errorCode`, and `details` so workbench readiness failures are actionable.

- [ ] **Step 4: Add routes and primary navigation**

Add `/devflow/inbox`, `/devflow/pipeline`, and `/devflow/items/:id` lazy routes. Add a `DEVFLOW` sidebar group with Idea Inbox and Pipeline. Use existing icon components and layout primitives.

- [ ] **Step 5: Run UI unit/type checks**

Run: `cd apps/ui && bun test src/components/devflow/state-badge.test.tsx`  
Expected: PASS.  
Run: `cd apps/ui && bunx tsc -b`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/api apps/ui/src/app/router.tsx apps/ui/src/components/devflow apps/ui/src/components/layout/app-sidebar.tsx
git commit -m "feat(devflow): add dashboard API foundation"
```

### Task 7: Idea Inbox and Manual Capture

**Files:**
- Create: `apps/ui/src/pages/devflow/inbox/page.tsx`
- Create: `apps/ui/src/components/devflow/capture-dialog.tsx`
- Test: `apps/ui/src/pages/devflow/inbox/page.test.tsx`

**Interfaces:**
- Consumes Task 6 hooks.
- Produces the usable capture and triage queue surface.

- [ ] **Step 1: Write inbox behavior tests**

Test captured/triaged filtering, source/classification/confidence display, agent failure display, manual capture validation, create success, and navigation to workbench.

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/ui && bun test src/pages/devflow/inbox/page.test.tsx`  
Expected: FAIL because the page does not exist.

- [ ] **Step 3: Implement capture dialog and inbox states**

The capture form requires title, description, and PM owner. On creation it shows the captured item immediately, then offers `Run Intake`. Empty, loading, API-error, and failed-agent states have distinct visible treatments.

- [ ] **Step 4: Run page tests**

Run: `cd apps/ui && bun test src/pages/devflow/inbox/page.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/pages/devflow/inbox apps/ui/src/components/devflow/capture-dialog.tsx
git commit -m "feat(devflow): ship idea inbox and capture"
```

### Task 8: Pipeline Board

**Files:**
- Create: `apps/ui/src/pages/devflow/pipeline/page.tsx`
- Create: `apps/ui/src/components/devflow/pipeline-column.tsx`
- Test: `apps/ui/src/pages/devflow/pipeline/page.test.tsx`

**Interfaces:**
- Consumes the work-item list hook and stable lifecycle enum.
- Produces a read-focused lifecycle board; it does not implement drag-to-bypass transitions.

- [ ] **Step 1: Write pipeline grouping tests**

Test that every forward state column renders in order, cards appear only in their current state, blocked/archived filters work, counts are correct, and card links open the workbench.

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/ui && bun test src/pages/devflow/pipeline/page.test.tsx`  
Expected: FAIL because the page does not exist.

- [ ] **Step 3: Implement responsive board**

Use horizontally scrollable columns on desktop and stacked state sections on narrow screens. Disabled later stages remain visible with zero counts to communicate the full lifecycle without enabling invalid actions.

- [ ] **Step 4: Run page tests and commit**

Run: `cd apps/ui && bun test src/pages/devflow/pipeline/page.test.tsx`  
Expected: PASS.

```bash
git add apps/ui/src/pages/devflow/pipeline apps/ui/src/components/devflow/pipeline-column.tsx
git commit -m "feat(devflow): add lifecycle pipeline board"
```

### Task 9: Spec Workbench and Gate Actions

**Files:**
- Create: `apps/ui/src/pages/devflow/items/[id]/page.tsx`
- Create: `apps/ui/src/components/devflow/scope-editor.tsx`
- Create: `apps/ui/src/components/devflow/spec-editor.tsx`
- Create: `apps/ui/src/components/devflow/gate-panel.tsx`
- Create: `apps/ui/src/components/devflow/evidence-timeline.tsx`
- Test: `apps/ui/src/pages/devflow/items/[id]/page.test.tsx`

**Interfaces:**
- Consumes all Task 6 hooks and error types.
- Produces the complete Slice 1 review/edit/approval experience.

- [ ] **Step 1: Write workbench behavior tests**

Test scope edit, low-confidence warning, Gate 1 enabled/disabled reasons, structured AC and nine-NFR editing, security threat-model requirement, blast-radius requirement, Gate 2 API rejection rendering, run history, gate decisions, and audit timeline.

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/ui && bun test 'src/pages/devflow/items/[id]/page.test.tsx'`  
Expected: FAIL because workbench components do not exist.

- [ ] **Step 3: Implement the workbench**

Use focused cards for Scope, Spec, Readiness, Agent Evidence, and Audit. The readiness panel computes advisory missing fields from current data but submits through the transition endpoint; server 409/422 details replace stale local assumptions. Approval requires an explicit rationale.

- [ ] **Step 4: Run workbench tests**

Run: `cd apps/ui && bun test 'src/pages/devflow/items/[id]/page.test.tsx'`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/pages/devflow/items apps/ui/src/components/devflow
git commit -m "feat(devflow): deliver spec workbench and gates"
```

### Task 10: Bootstrap, End-to-End Proof, Documentation, and Merge Gates

**Files:**
- Create: `src/devflow/bootstrap.ts`
- Create: `src/tests/devflow-e2e.test.ts`
- Create: `runbooks/devflow-local.md`
- Modify: `.env.example`
- Modify: `docs/superpowers/plans/2026-08-11-devflow-foundation.md` (check completed tasks)

**Interfaces:**
- Produces an idempotent explicit tenant-zero development bootstrap and a real API-to-Swarm-task-to-evidence-to-gate verification path.

- [ ] **Step 1: Write the end-to-end backend test**

The test creates two organizations, captures an item, starts/reconciles Intake, applies Scope and Spec evidence, approves Gates 1 and 2, asserts final `specced` state, checks gate/audit history, and proves the second organization cannot read any record.

- [ ] **Step 2: Run and confirm failure**

Run: `bun run test:root -- src/tests/devflow-e2e.test.ts`  
Expected: FAIL until bootstrap and all integration points are complete.

- [ ] **Step 3: Add explicit development bootstrap and runbook**

Bootstrap only when `DEVFLOW_BOOTSTRAP_TENANT_ZERO=true`. Require `DEVFLOW_TENANT_ZERO_ADMIN_USER_ID`, create the organization/membership idempotently, and log only IDs/slugs. Document API/UI URLs, required environment, how to run a worker, and how to recover failed agent runs.

- [ ] **Step 4: Run the complete DevFlow verification set**

Run: `bun run test:root -- src/tests/devflow-repository.test.ts src/tests/devflow-transition-service.test.ts src/tests/devflow-evidence-service.test.ts src/tests/devflow-agent-adapter.test.ts src/tests/devflow-http.test.ts src/tests/devflow-e2e.test.ts`  
Expected: PASS.

- [ ] **Step 5: Run applicable repository merge gates**

Run these exact repository commands:

```bash
bun install --frozen-lockfile
bun run lint
bun run tsc:check
bun run test:root
bash scripts/check-db-boundary.sh
bash scripts/check-audit-columns.sh
bun run check:dep-graph
cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b
```

Expected: every command exits 0.

- [ ] **Step 6: Start the local product and perform UI verification**

Follow `LOCAL_TESTING.md` and the `swarm-local-e2e` skill to start API/workers/UI. Then run `/qa-use:verify` against Idea Inbox, Pipeline Board, and Spec Workbench. Capture screenshots showing manual capture, triaged evidence, Gate 1 readiness, Gate 2 missing-precondition feedback, and final specced state.

- [ ] **Step 7: Final requirement audit**

Check every Slice 1 completion criterion in `docs/superpowers/specs/2026-08-11-devflow-foundation-design.md` against a test, HTTP response, task record, or screenshot. Record any incomplete evidence as incomplete and continue work; do not infer completion from a green narrow test.

- [ ] **Step 8: Commit delivery evidence**

```bash
git add .env.example runbooks/devflow-local.md src/devflow/bootstrap.ts src/tests/devflow-e2e.test.ts docs/superpowers/plans/2026-08-11-devflow-foundation.md
git commit -m "test(devflow): prove foundation end to end"
```
