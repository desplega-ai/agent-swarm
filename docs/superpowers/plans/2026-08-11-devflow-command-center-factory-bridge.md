# DevFlow to Command Center Factory Bridge Implementation Plan

> **Execution rule:** implement one task at a time with test-driven development. Do not accept Agent Swarm output as Factory truth; reconcile against canonical repository artifacts.

**Goal:** Let an approved DevFlow spec create one immutable implementation intent, dispatch one repository-aware Agent Swarm Factory coordinator, and display a cryptographically linked, independently verified Command Center Factory binding.

**Repositories:**

- DevFlow and execution plane: `/Users/marklerner/Documents/ChatGPT/Dev Harness_Agent_Swarm`
- Command Center Factory: `/Users/marklerner/Documents/ChatGPT/sequencer_v3_devflow_bridge`

**Architecture:** DevFlow owns product authority and immutable spec snapshots. Agent Swarm owns execution attempts and provides the coordinator a `vcsRepo`. Command Center owns queue, contract, sign-off, proof, and merge truth. The DevFlow API verifies Factory files from an administrator-approved local mirror at an exact Git revision; task output supplies candidate identifiers only.

**Completion bar:** A local end-to-end fixture starts with a Gate 2-approved spec, dispatches a `RebarHQ/sequencer_v3` task, produces a canonical Factory contract carrying the matching digest, reconciles it from an exact Git revision, and renders the verified binding in the Workbench. Invalid digests, paths, revisions, tenants, or receipts fail closed.

## Global constraints

- Use forward migration `131_devflow_factory_bridge.sql`; never edit migration 130.
- The Agent Swarm API server remains the sole SQLite owner.
- Repository requests accept target IDs, never arbitrary paths or commands.
- Process execution uses argv arrays with no shell and bounded output/time.
- Factory repository files are written only by canonical Factory writers.
- DevFlow remains `specced`; Factory merge is not deployment or completion.
- No production deploy, merge, CRM write, or message send is authorized.

## Task 1: Extend canonical Factory contracts

**Command Center files:**

- Modify `dev_harness/factory_cli_constants.py`
- Modify `dev_harness/impact.py`
- Modify `dev_harness/checks.py`
- Modify `scripts/factory_orchestrate.py`
- Test `dev_harness/tests/test_orchestrate_contract.py`
- Test `dev_harness/tests/test_checks.py`

- [ ] Write failing tests for complete authority creation, partial/unknown/malformed rejection, amendment preservation, fingerprint change, and legacy parity.
- [ ] Add a centralized validator for exactly `system`, `work_item_id`, `artifact_type`, `artifact_id`, `artifact_version`, and `artifact_digest`.
- [ ] Add explicit `contract-new` arguments for those fields; emit the object only when all are supplied.
- [ ] Put `upstream_authority` in canonical key order and contract scope fields.
- [ ] Preserve the object unchanged in `contract-amend`.
- [ ] Run:

```bash
/opt/homebrew/bin/python3.13 -m unittest \
  dev_harness.tests.test_orchestrate_contract \
  dev_harness.tests.test_checks
/opt/homebrew/bin/python3.13 scripts/factory validate --run-checks --tier fast
```

- [ ] Commit the verified Factory slice.

## Task 2: Add DevFlow bridge persistence and types

**Agent Swarm files:**

- Create `src/be/migrations/131_devflow_factory_bridge.sql`
- Modify `src/devflow/domain/types.ts`
- Modify `src/devflow/repository.ts`
- Test `src/tests/devflow-factory-repository.test.ts`

- [ ] Write failing tenant-isolation, foreign-association, uniqueness, immutability, and status-update tests.
- [ ] Add repository targets, implementation intents, and Factory executions with foreign keys and indexes.
- [ ] Keep target checkout paths server-only and omit them from public schemas.
- [ ] Store snapshots, observed receipts, and failures as validated JSON.
- [ ] Run `bun run test:root -- src/tests/devflow-factory-repository.test.ts` and `bash scripts/check-audit-columns.sh`.
- [ ] Commit the persistence slice.

## Task 3: Create canonical implementation intents

**Agent Swarm files:**

- Create `src/devflow/services/implementation-intent-service.ts`
- Create `src/devflow/domain/factory-contracts.ts`
- Test `src/tests/devflow-implementation-intent-service.test.ts`

- [ ] Write failing tests for missing Gate 2, unapproved/current mismatches, stable canonical JSON, stable SHA-256, duplicate active intent, and changed spec version.
- [ ] Snapshot the work item, scope, approved spec, ACs, NFRs, exclusions, dependencies, threat model, rollback requirements, and Gate 2 decision.
- [ ] Canonicalize recursively with sorted object keys and preserved domain array order.
- [ ] Persist the immutable snapshot and `sha256:<64 hex>` digest transactionally with audit evidence.
- [ ] Run the focused intent and transition suites.
- [ ] Commit the intent slice.

## Task 4: Dispatch and verify Factory execution

**Agent Swarm files:**

- Create `src/devflow/services/factory-adapter.ts`
- Create `src/devflow/services/factory-artifact-runtime.ts`
- Create `src/devflow/prompts/factory-coordinator.ts`
- Modify `src/devflow/prompts/index.ts`
- Test `src/tests/devflow-factory-adapter.test.ts`
- Test `src/tests/devflow-factory-artifact-runtime.test.ts`

- [ ] Write failing tests for exact task options, idempotent reuse, invalid output, traversal/symlink escape, mismatched authority, stale revision, and derived statuses.
- [ ] Dispatch a task with `vcsProvider: "github"`, the configured `vcsRepo`, a portable model tier, strict output schema, and an idempotency context key.
- [ ] Prompt the coordinator to use the repository Factory skill and canonical CLI writers, never hand-written contract files.
- [ ] Treat output as candidate `headSha`, queue item ID, contract ID, and path only.
- [ ] Verify files with `git cat-file`/`git show` at the exact SHA in the approved mirror; validate containment, IDs, authority digest, sign-offs, PR metadata, and finalizer receipt.
- [ ] Derive execution status from verified artifacts and append audit evidence.
- [ ] Run both adapter suites and the existing DevFlow agent-adapter suite.
- [ ] Commit the execution slice.

## Task 5: Expose tenant-safe APIs

**Agent Swarm files:**

- Modify `src/devflow/api/schemas.ts`
- Modify `src/http/devflow.ts`
- Modify `src/rbac/permissions.ts`
- Modify `src/rbac/legacy-policy.ts`
- Modify `openapi.json` through `bun run docs:openapi`
- Test `src/tests/devflow-factory-http.test.ts`

- [ ] Write failing API tests for target administration, intent creation, execution detail, reconciliation, role denial, and path redaction.
- [ ] Add target list/create/update, intent list/create, execution read/reconcile/cancel routes.
- [ ] Require admin for targets and product-authority roles for intent creation.
- [ ] Return verified snapshots and stable failure codes without raw process output or checkout paths.
- [ ] Run focused HTTP tests, RBAC coverage, OpenAPI response coverage, and regenerate OpenAPI.
- [ ] Commit the API slice.

## Task 6: Add the Workbench Implementation panel

**Agent Swarm files:**

- Modify `apps/ui/src/api/devflow-types.ts`
- Modify `apps/ui/src/api/client.ts`
- Modify `apps/ui/src/api/hooks/use-devflow.ts`
- Modify `apps/ui/src/pages/devflow/work-items/[id]/page.tsx`
- Test the nearest DevFlow UI test file or create `apps/ui/src/pages/devflow/work-items/[id]/page.test.tsx`

- [ ] Write failing component tests for approved-spec visibility, send action, immutable version/digest, verified receipt display, retry/cancel states, and explicit non-deployment language.
- [ ] Add the target selector and `Send to Command Center Factory` action only after Gate 2.
- [ ] Render verified queue/contract/sign-off/PR/finalizer fields and earlier intent history.
- [ ] Make loading, empty, failure, and stale-spec states explicit.
- [ ] Run focused UI tests and `bun run tsc:check`.
- [ ] Commit the UI slice.

## Task 7: End-to-end proof and handoff

**Agent Swarm files:**

- Create or extend a fixture under `scripts/e2e/` following `swarm-local-e2e` guidance
- Create `src/tests/devflow-factory-e2e.test.ts` if the fixture can remain hermetic

- [ ] Build a temporary Git repository containing the minimum real Factory writer/contract shape and a bare origin.
- [ ] Start isolated Agent Swarm API/lead/worker instances on dynamically allocated ports with a fresh database.
- [ ] Seed an organization, memberships, work item, scope, approved spec, and repository target.
- [ ] Dispatch the Factory task, wait for a bounded terminal state, reconcile the exact revision, and assert API/UI readback.
- [ ] Prove tampered digest, foreign tenant, and escaping path are rejected.
- [ ] Run:

```bash
bun run test:root -- src/tests/devflow-*.test.ts
bun run tsc:check
bun run lint
bash scripts/check-db-boundary.sh
bash scripts/check-api-key-boundary.sh
bun run check:rbac-coverage
bun run check:openapi-response-coverage
```

- [ ] In Command Center, run the focused Factory tests, `factory validate --run-checks --tier standard`, generate Factory assets/evidence, and run preflight.
- [ ] Commit both clean repositories and report verification evidence separately for DevFlow, Agent Swarm execution, and Factory truth.

## Not complete until

- An approved spec produces exactly one immutable intent and one idempotent Factory execution.
- The worker receives the correct repository context and canonical Factory procedure.
- DevFlow verifies exact-revision Factory artifacts independently of task prose.
- Tenant, path, digest, revision, sign-off, and receipt failures are covered.
- The Workbench displays verified status without claiming deployment or completion.
- Focused suites, affected full suites, type checks, policy checks, and local end-to-end proof pass.
