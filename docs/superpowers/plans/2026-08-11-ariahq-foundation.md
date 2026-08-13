# AriaHQ Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a testable AriaHQ foundation in which Aria can create versioned engines from natural-language briefs, answer against permission-filtered organizational evidence, and capture client Slack issues into governed DevFlow cases without exposing internal context.

**Architecture:** AriaHQ is an additive bounded context in the Agent Swarm API server. It owns engine drafts/versions, authoritative knowledge records, Slack trust-surface configuration, and client-intake projections; existing Workflows execute published engine contracts, existing Agent Swarm tasks draft contracts and synthesize answers, and DevFlow remains the product lifecycle authority. A client Slack surface is consumed at the Slack ingress boundary before generic agent routing, while internal surfaces may retrieve organization-scoped evidence.

**Tech Stack:** Bun, TypeScript, Zod, `bun:sqlite`, Slack Bolt, existing Agent Swarm workflow/task APIs, React dashboard, Biome.

**Execution record (2026-08-11):** The foundation and production-hardening slices were implemented. In addition to the six tasks below, AriaHQ now has agent-scoped OpenAPI source provisioning, a reusable scheduled connector script, cursor-safe sync journals, secure webhook ingestion, fail-closed Slack surface verification, internal Slack Ask Aria routing with canonical-user membership checks, and a Sources & Surfaces operator page. The final root suite passed 7,564 tests with 7 intentional skips and 0 failures across 498 files. The 70 focused AriaHQ/DevFlow tests, root and UI lint/type checks, database/API-key/audit boundaries, dependency graph, RBAC coverage, OpenAPI response coverage, SDK registration, generated SDK idempotence, OpenAPI generation, and rendered UI inspection also passed. Live credential activation, provider backfills, deployment, and deployed multi-tenant validation remain external and are not claimed complete.

## Global Constraints

- The API server is the sole SQLite owner; worker-side modules never import `src/be/db` or `bun:sqlite`.
- Every AriaHQ query is organization-scoped, and client reads additionally require an exact `clientKey` match.
- Natural language creates a draft engine contract only; publishing requires explicit validation and creates an immutable engine version plus a workflow.
- Agent Swarm memory remains experience memory. Organizational records preserve source, revision, visibility, verification, effective time, expiry, and checksum.
- A client Slack surface never falls through to generic Agent Swarm routing, even when an intake message is ignored by its capture policy.
- Client-facing responses are projections, not direct views of internal DevFlow records.
- New HTTP handlers use `route()`, typed 2xx schemas, RBAC declarations on mutations, and registration in `src/http/all-routes.ts`.
- Database changes use a new forward-only migration and include audit columns or an explicit audit exemption.
- Implementation follows red-green-refactor; each production behavior is preceded by a test that fails for the missing behavior.

---

### Task 1: Persist AriaHQ contracts, knowledge, trust surfaces, and intakes

**Files:**
- Create: `src/be/migrations/132_ariahq_foundation.sql`
- Create: `src/ariahq/domain/types.ts`
- Create: `src/ariahq/repository.ts`
- Test: `src/tests/ariahq-repository.test.ts`

**Interfaces:**
- Produces: `AriaHqRepository`, `createAriaHqRepository(db)`, `EngineContractSchema`, `KnowledgeRecordSchema`, `SlackSurfaceSchema`, and `ClientIntakeSchema`.
- Engine draft lifecycle: `queued | running | ready | failed`; engine version lifecycle: `draft | published | retired`.
- Knowledge audience: `internal | client`; client records require `clientKey`.

- [ ] **Step 1: Write repository tests for organization isolation, immutable engine versions, idempotent source ingestion, client ACL filtering, Slack-surface uniqueness, and Slack-message intake deduplication.**

  The mutation checks are: removing `organizationId` from any query leaks a fixture; removing the unique source revision key creates a duplicate; removing `clientKey` filtering exposes another client's record; removing the Slack message unique key creates a second work item link.

- [ ] **Step 2: Run the new repository suite and verify it fails because the migration and repository do not exist.**

  Run: `bun run test:root -- src/tests/ariahq-repository.test.ts`

- [ ] **Step 3: Add migration 132 and focused Zod domain types.**

  Persist these tables with `created_by` and `updated_by`: `ariahq_engine_drafts`, `ariahq_engine_versions`, `ariahq_knowledge_records`, `ariahq_slack_surfaces`, and `ariahq_client_intakes`. Use composite uniqueness on `(organizationId, engineKey, version)`, `(organizationId, sourceKind, sourceRef, sourceRevision)`, `(workspaceId, channelId)`, and `(slackSurfaceId, messageTs)`.

- [ ] **Step 4: Implement the repository with explicit organization/client parameters on every read.**

  The repository must expose:

  ```ts
  createEngineDraft(input: CreateEngineDraftInput): AriaEngineDraft;
  updateEngineDraft(orgId: string, id: string, patch: EngineDraftPatch): AriaEngineDraft;
  createEngineVersion(input: CreateEngineVersionInput): AriaEngineVersion;
  listEngineVersions(orgId: string, engineKey?: string): AriaEngineVersion[];
  ingestKnowledge(input: IngestKnowledgeInput): AriaKnowledgeRecord;
  searchKnowledge(input: KnowledgeSearchInput): AriaKnowledgeSearchResult[];
  createSlackSurface(input: CreateSlackSurfaceInput): AriaSlackSurface;
  findSlackSurface(workspaceId: string, channelId: string): AriaSlackSurface | null;
  createClientIntake(input: CreateClientIntakeInput): AriaClientIntake;
  getClientIntakeByMessage(surfaceId: string, messageTs: string): AriaClientIntake | null;
  ```

- [ ] **Step 5: Run the repository suite until green.**

  Run: `bun run test:root -- src/tests/ariahq-repository.test.ts`

### Task 2: Draft, validate, compile, and publish engines

**Files:**
- Create: `src/ariahq/prompts.ts`
- Create: `src/ariahq/services/engine-compiler.ts`
- Create: `src/ariahq/services/engine-builder.ts`
- Test: `src/tests/ariahq-engine-builder.test.ts`

**Interfaces:**
- Consumes: `AriaHqRepository`, existing task runtime, existing `createWorkflow` boundary.
- Produces: `compileEngineContract(contract): WorkflowDefinition`, `startDraft(context, brief)`, `reconcileDraft(context, draftId)`, and `publishDraft(context, draftId)`.

- [ ] **Step 1: Write failing tests for a natural-language draft task, strict contract parsing, invalid authority rejection, linear agent/HITL compilation, and publish idempotency.**

  Assert real compiled nodes: agent stages become `agent-task`; approval stages become `human-in-the-loop`; each node points only at its declared next stage; a rejected/malformed task output marks the draft failed without creating an engine version or workflow.

- [ ] **Step 2: Run the engine-builder suite and verify the missing-module failure.**

  Run: `bun run test:root -- src/tests/ariahq-engine-builder.test.ts`

- [ ] **Step 3: Register the engine-builder task prompt through `src/prompts/` and require JSON matching `EngineContractSchema`.**

  The prompt must explicitly prohibit invented permissions, require unresolved material questions in `openQuestions`, and state that the result is a draft rather than executable authority.

- [ ] **Step 4: Implement the compiler and validate its output with the existing workflow definition validator and executor registry.**

- [ ] **Step 5: Implement draft start/reconcile/publish with injected task and workflow runtimes.**

  Publishing accepts only a `ready` draft with no open material questions, writes the next immutable version, creates one workflow, and records its ID. Repeated publish returns the same published version.

- [ ] **Step 6: Run the engine-builder and workflow-definition suites until green.**

  Run: `bun run test:root -- src/tests/ariahq-engine-builder.test.ts src/tests/workflow-definition-validation.test.ts`

### Task 3: Add the organizational knowledge answer boundary

**Files:**
- Create: `src/ariahq/services/knowledge-service.ts`
- Test: `src/tests/ariahq-knowledge-service.test.ts`

**Interfaces:**
- Consumes: `AriaHqRepository.searchKnowledge` and an injected answer-task runtime.
- Produces: `buildEvidenceBundle(context, question)` and `startAnswer(context, question)`.

- [ ] **Step 1: Write failing tests for internal retrieval, client-exact retrieval, expired insight suppression, conflict surfacing, canonical-fact precedence, citation rendering, and abstention with no evidence.**

- [ ] **Step 2: Run the suite and verify it fails for the missing service.**

  Run: `bun run test:root -- src/tests/ariahq-knowledge-service.test.ts`

- [ ] **Step 3: Implement deterministic evidence ranking and answer instructions.**

  Verified canonical facts rank before current evidence, which ranks before derived insights. Expired insights are excluded. Conflicting verified records remain in the bundle and force explicit conflict language. Each citation includes record ID, source kind, source reference, source URL when present, effective time, and verification state.

- [ ] **Step 4: Make empty evidence return an abstention without dispatching an answer task.**

- [ ] **Step 5: Run the knowledge suite until green.**

  Run: `bun run test:root -- src/tests/ariahq-knowledge-service.test.ts`

### Task 4: Capture client Slack messages before generic routing

**Files:**
- Create: `src/ariahq/services/client-intake.ts`
- Create: `src/ariahq/slack.ts`
- Modify: `src/slack/handlers.ts`
- Test: `src/tests/ariahq-client-slack.test.ts`

**Interfaces:**
- Consumes: `AriaHqRepository`, `DevFlowRepository`, Slack message identity, and configured `AriaSlackSurface`.
- Produces: `handleAriaSlackIngress(input): Promise<{ recognized: boolean; handled: boolean; intake?: AriaClientIntake }>`.

- [ ] **Step 1: Write failing tests proving that client surfaces never reach generic routing, mention-only surfaces ignore unmentioned messages, designated channels capture without mention, duplicate Slack deliveries reuse one intake, and captured evidence is tenant-scoped.**

- [ ] **Step 2: Run the suite and verify it fails because AriaHQ Slack ingress is absent.**

  Run: `bun run test:root -- src/tests/ariahq-client-slack.test.ts`

- [ ] **Step 3: Implement client intake creation as one database transaction.**

  Create one DevFlow work item, one client intake projection, one source-evidence record, and one audit event. The configured internal PM owner—not the external Slack user—owns the DevFlow item. Security-keyword messages set `isSecuritySensitive` and return a protected-channel response.

- [ ] **Step 4: Wire the ingress immediately after bot/delivery filtering and before generic Slack user authorization or agent routing.**

  A recognized client surface always returns from the generic handler. A handled intake posts a client-safe receipt with case ID and status; an ignored mention-only message posts nothing.

- [ ] **Step 5: Run AriaHQ Slack plus existing Slack routing suites until green.**

  Run: `bun run test:root -- src/tests/ariahq-client-slack.test.ts src/tests/slack-router.test.ts src/slack/handlers.test.ts`

### Task 5: Expose governed AriaHQ APIs and operator UI

**Files:**
- Create: `src/ariahq/api/schemas.ts`
- Create: `src/http/ariahq.ts`
- Modify: `src/http/all-routes.ts`
- Modify: `src/rbac/permissions.ts`
- Modify: `src/rbac/legacy-policy.ts`
- Modify: `src/be/rbac-roles.ts`
- Test: `src/tests/ariahq-http.test.ts`
- Create: `apps/ui/src/pages/ariahq/page.tsx`
- Create: `apps/ui/src/pages/ariahq/engines/page.tsx`
- Create: `apps/ui/src/pages/ariahq/knowledge/page.tsx`
- Modify: `apps/ui/src/app/router.tsx`
- Modify: `apps/ui/src/components/layout/app-sidebar.tsx`
- Modify: `apps/ui/src/api/client.ts`
- Modify: `apps/ui/src/api/hooks/use-devflow.ts`

**Interfaces:**
- Produces: `/api/ariahq/v1/engines`, `/engine-drafts`, `/knowledge/records`, `/knowledge/search`, `/slack-surfaces`, and `/client-intakes`; UI routes `/ariahq`, `/ariahq/engines`, and `/ariahq/knowledge`.

- [ ] **Step 1: Write failing HTTP tests for organization scoping, RBAC denial, draft lifecycle, publish, knowledge ingest/search, and Slack-surface administration.**

- [ ] **Step 2: Run the HTTP suite and verify route absence.**

  Run: `bun run test:root -- src/tests/ariahq-http.test.ts`

- [ ] **Step 3: Add named Zod schemas, route definitions, RBAC verbs, legacy policy entries, and requester-role grants.**

  Use `ariahq.engine.manage`, `ariahq.knowledge.write`, and `ariahq.surface.manage`; knowledge search remains an authenticated GET/POST read whose client visibility is enforced by the service context.

- [ ] **Step 4: Implement handlers and register `src/http/ariahq.ts` in `all-routes.ts`.**

- [ ] **Step 5: Run HTTP, RBAC coverage, response coverage, and OpenAPI generation.**

  Run: `bun run test:root -- src/tests/ariahq-http.test.ts`

  Run: `bun run check:rbac-coverage`

  Run: `bun run check:openapi-response-coverage`

  Run: `bun run docs:openapi`

- [ ] **Step 6: Add an AriaHQ dashboard, Engine Studio draft/publish flow, knowledge search with visible citations, and an ARIAHQ sidebar group that nests DevFlow as an engine.**

- [ ] **Step 7: Run UI lint/typecheck and a screenshot-backed `qa-use` session.**

  Run: `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b`

### Task 6: Verify the complete foundation

**Files:**
- Modify: `docs/superpowers/specs/2026-08-11-ariahq-foundation-design.md`
- Modify: `openapi.json` and generated API reference files from `bun run docs:openapi`

**Interfaces:**
- Produces: a reproducible verification record and an explicit statement of what remains outside this foundation.

- [x] **Step 1: Run all AriaHQ and DevFlow tests.**

  Run: `bun run test:root -- src/tests/ariahq-*.test.ts src/tests/devflow-*.test.ts`

- [x] **Step 2: Run repository gates.**

  Run: `bun run lint`

  Run: `bun run tsc:check`

  Run: `bash scripts/check-db-boundary.sh`

  Run: `bash scripts/check-audit-columns.sh`

  Run: `bun run check:dep-graph`

- [x] **Step 3: Re-run the full root suite and compare failures with the recorded baseline of 7,394 pass / 123 script-runtime failures.**

  Run: `bun run test:root`

- [x] **Step 4: Document shipped capabilities and remaining connectors.**

  The local code boundary is complete only when engine authoring, source-backed answers, scheduled/webhook ingestion, internal questions, and client Slack capture are testable end to end. Live Slack, Google Drive, call-recording, and CRM activation remains deployment configuration and must not be represented as connected until credentialed syncs, backfills, and cross-tenant deployed checks have passed.
