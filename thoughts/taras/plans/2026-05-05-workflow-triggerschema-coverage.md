---
date: 2026-05-05
planner: Claude (with Taras)
git_commit: a8fca0d206f4cc9b7262c484c4c4f006c2dd5c91
branch: main
repository: agent-swarm
topic: "Workflow `triggerSchema` end-to-end coverage"
tags: [workflows, triggerSchema, mcp-tools, frontend, validation]
status: draft
last_updated: 2026-05-05
last_updated_by: Claude
autonomy: critical
commit_per_phase: true
research: thoughts/taras/research/2026-05-05-workflow-triggerschema-coverage.md
---

# Workflow `triggerSchema` end-to-end coverage Implementation Plan

## Overview

Validation of `triggerSchema` is already wired through every workflow trigger path (HTTP manual, webhook, schedule, MCP), but **authoring** is broken: MCP tools don't expose the field, the HTTP `PATCH` endpoint can't change it, the FE can read it but not edit it, and there is no payload tester. This plan closes those gaps so an agent or a human can set, edit, clear, and live-test a workflow's `triggerSchema` without reaching for raw `PUT` requests.

- **Motivation**: Taras flagged that `triggerSchema` is "not used" in practice — the runtime supports it, but every authoring surface (MCP, PATCH, FE) treats it as if it doesn't exist, so agents and users cannot adopt it.
- **Related**:
  - `thoughts/taras/research/2026-05-05-workflow-triggerschema-coverage.md` (full as-is research)
  - Migration `src/be/migrations/012_trigger_schema.sql`
  - Engine validation `src/workflows/engine.ts:54-60`
  - Test suite `src/tests/workflow-trigger-schema.test.ts`

## Current State Analysis

Today (commit `a8fca0d`):

- **Persisted & validated end-to-end** ✅
  - DB column exists (`src/be/migrations/012_trigger_schema.sql:1`); CRUD layer reads / writes / nulls (`src/be/db.ts:5409,5468,5519,5554-5556`).
  - Snapshots include it (`src/workflows/version.ts:32`).
  - `startWorkflowExecution` validates `triggerData` against the schema and throws `TriggerSchemaError` (`src/workflows/engine.ts:29-36,54-60`). Manual trigger and webhook routes map that error to HTTP 400 (`src/http/workflows.ts:606-612, 351-352`).
  - HTTP `POST /api/workflows` and `PUT /api/workflows/{id}` accept `triggerSchema` in the body (`src/http/workflows.ts:59,96,415,560`).
  - Validator subset: `type` / `required` / `properties` / `enum` / `const` / `items` (recursive into arrays). No `oneOf` / `anyOf` / `$ref` / `pattern` / `format` / `additionalProperties` (`src/workflows/json-schema-validator.ts:11-93`). Unsupported keywords are silently ignored. The file's own JSDoc (lines 1–10) only documents 3 of 6 supported keywords — Phase 6 fixes that.

- **Authoring gaps** ❌
  - MCP `create-workflow` and `update-workflow` `inputSchema` does NOT include `triggerSchema`; handlers don't pass it through (`src/tools/workflows/create-workflow.ts:28-60,96-106`; `src/tools/workflows/update-workflow.ts:22-50,94-104`).
  - HTTP `PATCH /api/workflows/{id}` body is `WorkflowDefinitionPatchSchema` — DAG-only, no metadata fields (`src/http/workflows.ts:108,115,483-520`). MCP `patch-workflow` mirrors that scope (`src/tools/workflows/patch-workflow.ts:20-51,97`).
  - MCP `trigger-workflow` returns generic `Failed: ${err}` for `TriggerSchemaError`, hiding field-level diagnostics (`src/tools/workflows/trigger-workflow.ts:47,~88`).
  - FE: `useUpdateWorkflow` and `api.updateWorkflow` only accept `name | description | enabled` (`new-ui/src/api/hooks/use-workflows.ts:43-58`; `new-ui/src/api/client.ts:652-664`). `TriggersDetailPanel` renders the schema read-only via `JsonTree` (`new-ui/src/pages/workflows/[id]/page.tsx:1094-1158`); no editor.
  - FE: top-bar "Trigger" button sends `{}` always (`new-ui/src/pages/workflows/[id]/page.tsx:190-191`). No payload tester.
  - Docs: `runbooks/workflows.md`, `MCP.md`, `CLAUDE.md` don't mention `triggerSchema`.

## Desired End State

A workflow's `triggerSchema` is a first-class authoring concept across every surface:

- **MCP**: `create-workflow`, `update-workflow`, `patch-workflow` all accept `triggerSchema` (set / clear / leave-unchanged). Tool descriptions document the supported JSON-Schema subset. `trigger-workflow` surfaces field-level validation errors when a payload fails.
- **HTTP**: `PATCH /api/workflows/{id}` accepts `triggerSchema` (nullable) alongside DAG patches. Existing `POST` / `PUT` continue to work.
- **HTTP error contract** (frozen by this plan): `TriggerSchemaError` produces `400 Bad Request` with body `{ error: "TriggerSchemaError", message: string, details: string[] }` where `details` is the array returned by `validateJsonSchema()` (e.g. `["pr: missing required property \"number\""]`). Both `/api/workflows/{id}/trigger` and `/api/workflows/webhooks/{id}` return this shape; the FE tester in Phase 5 renders `details` as a bulleted list.
- **FE**: Triggers tab gains an inline JSON editor with "Save" + "Clear" affordances, plus a "Test trigger" panel that lets users send a payload and see validation errors inline.
- **Docs**: `runbooks/workflows.md` documents `triggerSchema` (purpose, supported subset, how errors surface, 400 body shape). `MCP.md` reflects the new tool fields. `CLAUDE.md` has an `<important if>` block routing agents to the runbook.
- **Tests**: MCP round-trip tests prove create / update / patch persist `triggerSchema`; a `qa-use` session proves the FE editor + tester work.

Verification:
- `bun run tsc:check && bun run lint && bun test src/tests/workflow-trigger-schema.test.ts src/tests/workflow-mcp-trigger-schema.test.ts src/tests/workflow-integration-io.test.ts`
- `qa-use` session screenshots show: editing `triggerSchema` from the UI, clearing it, and a "Test trigger" failure with field-level errors.
- MCP trace: `mcp:create-workflow` with `triggerSchema` → `mcp:get-workflow` returns it → `mcp:patch-workflow` with `triggerSchema:null` → field cleared.

## What We're NOT Doing

- **Not extending the JSON-Schema validator.** Adding `oneOf`/`anyOf`/`$ref`/`pattern`/`format`/`additionalProperties` support is a separate effort. We document the subset; we don't expand it. (`items` is already supported recursively — research originally missed this; corrected during review.)
- **Not widening PATCH for other metadata fields.** This plan only adds `triggerSchema` to the PATCH surface. `name` / `description` / `enabled` remain PUT-only by design — widening them is a separate, additive change once we see authoring demand. Authors who need both DAG ops and metadata changes today still have PUT.
- **Not auto-deriving `triggerSchema` from `triggers`.** Schedule / webhook trigger configs and `triggerSchema` remain independent. (See research §10 follow-up #2.)
- **Not migrating existing workflows.** Existing rows have `triggerSchema = NULL`, which means "accept any payload" — no behavior change.
- **Not changing version-snapshot behavior.** Snapshots already include `triggerSchema`; no changes needed.
- **Not adding a JSON-Schema visual builder.** A raw JSON editor is sufficient for v1; a structured editor is a future enhancement.

## Implementation Approach

- **Bottom-up by surface**: contracts (MCP + HTTP PATCH) before UX (FE editor + tester), so each phase can ship independently.
- **One nullable field, three semantics**: `undefined`/omitted = leave unchanged, object = set/replace, `null` = clear. Mirror the existing `PUT /api/workflows/{id}` semantics across MCP `update-workflow`, MCP `patch-workflow`, and HTTP `PATCH`.
- **Document the validator subset everywhere `triggerSchema` is authored** (MCP tool descriptions, runbook, FE editor helper text) so users don't write keywords that get silently ignored.
- **Test each surface at its own boundary**: MCP tools get unit-style round-trip tests; FE gets `qa-use` coverage. Engine-level tests already exist — leave them alone.
- **Phases 4 and 5 ship in the same PR.** Phase 5.3 (top-bar Trigger button guard) MUST land alongside Phase 4's editor — without it, users can author a schema then break the top-bar Trigger button. Phases 1, 2, 3, 6 are independent and could be reordered.

## Quick Verification Reference

- Type-check: `bun run tsc:check`
- Lint (read-only, matches CI): `bun run lint`
- Auto-fix lint locally: `bun run lint:fix`
- Single test file: `bun test src/tests/<file>.test.ts`
- Full unit tests: `bun test`
- API server (dev, hot reload, portless): `bun run dev:http` → `https://api.swarm.localhost:1355`
- API server (PM2, port 3013): `bun run pm2-restart && bun run pm2-logs`
- new-ui dev: `cd new-ui && pnpm dev` (port 5274)
- new-ui type-check (matches CI): `cd new-ui && pnpm exec tsc -b`
- DB boundary: `bash scripts/check-db-boundary.sh`
- OpenAPI regen (after route or version changes): `bun run docs:openapi`

---

## Phase 1: MCP `create-workflow` + `update-workflow` accept `triggerSchema`

### Overview

Wire `triggerSchema` through the two existing "author from scratch / replace whole record" MCP tools so agents can set or clear it without falling back to raw HTTP.

### Changes Required:

#### 1. `create-workflow` MCP tool
**File**: `src/tools/workflows/create-workflow.ts`
**Changes**:
- Add `triggerSchema: z.record(z.string(), z.unknown()).optional()` to `inputSchema` (extend the existing block at lines 28–60).
- Pass `triggerSchema` through to `createWorkflow()` (extend the call at lines 96–106).
- Update the tool `description` to mention `triggerSchema` and call out the supported JSON-Schema subset (`type` / `required` / `properties` / `enum` / `const` / `items`); explicitly note that other keywords are silently ignored.

#### 2. `update-workflow` MCP tool
**File**: `src/tools/workflows/update-workflow.ts`
**Changes**:
- Add `triggerSchema: z.record(z.string(), z.unknown()).optional().nullable()` to `inputSchema` (extend lines 22–50). `null` = clear.
- Pass `triggerSchema` through to `updateWorkflow()` (extend the call at lines 94–104). When `null`, ensure DB layer writes `NULL` (already supported per `src/be/db.ts:5519,5554-5556`).
- Update tool `description` mirroring Phase 1.1 wording, plus a one-liner about `null` clearing.

#### 3. New test file: MCP round-trip
**File**: `src/tests/workflow-mcp-trigger-schema.test.ts` (new)
**Changes**:
- `create-workflow` with `triggerSchema` → `get-workflow` returns identical object.
- `create-workflow` without `triggerSchema` → returned `triggerSchema` is `undefined`.
- `update-workflow` with new `triggerSchema` → persisted.
- `update-workflow` with `triggerSchema: null` → DB column is `NULL`, returned as `undefined`.
- Reuse the test harness pattern from `src/tests/workflow-trigger-schema.test.ts` (boots an in-memory API + calls tool handlers directly).

### Success Criteria:

#### Automated Verification:
- [ ] `bun run tsc:check` passes
- [ ] `bun run lint` passes
- [ ] `bun test src/tests/workflow-mcp-trigger-schema.test.ts` passes
- [ ] `bun test src/tests/workflow-trigger-schema.test.ts` still passes (no regressions)
- [ ] `grep -n triggerSchema src/tools/workflows/{create,update}-workflow.ts` returns matches for both `inputSchema` and the call site

#### Automated QA:
- [ ] Sub-agent runs `mcp:create-workflow` with a sample `triggerSchema` (e.g. `{type:"object", required:["pr"], properties:{pr:{type:"object"}}}`), then `mcp:get-workflow`, asserts equality
- [ ] Sub-agent runs `mcp:update-workflow` with `triggerSchema: null`, then `mcp:get-workflow`, asserts the field is gone
- [ ] Sub-agent attempts `mcp:trigger-workflow` with an empty payload against the workflow created above and confirms it gets a validation error (proves end-to-end wiring still works)

#### Manual Verification:
- [ ] Read tool `description` output (via `mcp:list_tools` or by inspection) and confirm the supported-subset note is clear and useful

**Implementation Note**: After this phase, pause for manual confirmation. Commit with `[phase 1] MCP create/update workflow accept triggerSchema`.

---

## Phase 2: HTTP `PATCH` + MCP `patch-workflow` accept `triggerSchema`

### Overview

Extend the partial-update surface (`PATCH`) so agents can change `triggerSchema` without sending the entire workflow definition. Keeps DAG-patch semantics intact while adding optional metadata patching.

### Changes Required:

#### 1. HTTP `PATCH /api/workflows/{id}` route
**File**: `src/http/workflows.ts`
**Changes**:
- Locate `patchWorkflowRoute` at line 108 and the body schema `WorkflowDefinitionPatchSchema` referenced at line 115.
- Decide between (a) extending `WorkflowDefinitionPatchSchema` with optional `triggerSchema` or (b) wrapping the body in a discriminated object that splits "DAG ops" from "metadata ops". **Recommendation: (a)** — additive, single body, simpler. The new optional field is `triggerSchema: z.record(z.string(), z.unknown()).optional().nullable()`.
- **Rename `WorkflowDefinitionPatchSchema` → `WorkflowPatchSchema`** in the same change. Once the body holds a non-definition field (`triggerSchema`), the old name lies. Update all references (route file + any imports). This is purely a TS-level rename; the wire format is unchanged.
- In the handler (around lines 483–520), after applying DAG patches, if `body.triggerSchema !== undefined`, pass it to `updateWorkflow()` alongside the new `definition`. Treat `null` as clear.
- Confirm OpenAPI regenerates correctly. Existing `POST /api/workflows` and `PUT /api/workflows/{id}` already document `triggerSchema` (the field is present in their body schemas), so the regen diff should be **PATCH-only** — if `POST`/`PUT` entries also change, something else drifted; investigate before committing.

#### 2. MCP `patch-workflow` tool
**File**: `src/tools/workflows/patch-workflow.ts`
**Changes**:
- Add `triggerSchema: z.record(z.string(), z.unknown()).optional().nullable()` to `inputSchema` (extend lines 20–51).
- In the handler (line 97), after computing `patchResult.definition`, if `args.triggerSchema !== undefined`, include it in the `updateWorkflow()` payload.
- Update tool `description` to mention the new field and that it's independent from DAG ops.

#### 3. OpenAPI spec (auto-generated)
**Files**: `openapi.json`, `docs-site/content/docs/api-reference/**`
**Changes**:
- Run `bun run docs:openapi` after route changes.
- Commit regenerated spec alongside route changes (per CLAUDE.md drift rules).

#### 4. Tests
**File**: `src/tests/workflow-mcp-trigger-schema.test.ts` (extend Phase 1 file)
**Changes**:
- `mcp:patch-workflow` with `triggerSchema: { ... }` only (no DAG ops) → workflow persists schema, definition unchanged.
- `mcp:patch-workflow` with both DAG ops AND `triggerSchema` → both applied.
- `mcp:patch-workflow` with `triggerSchema: null` → cleared.
- HTTP-level test: `PATCH /api/workflows/{id}` with `{ triggerSchema: {...} }` body → 200, schema persisted.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run tsc:check` passes
- [ ] `bun run lint` passes
- [ ] `bun run docs:openapi` produces no unstaged diff after running (i.e., regenerated spec is committed)
- [ ] `bun test src/tests/workflow-mcp-trigger-schema.test.ts` passes (Phase 1 + Phase 2 cases)
- [ ] `grep -n triggerSchema src/http/workflows.ts | grep -i patch` returns the new field in the PATCH body schema and handler
- [ ] CI's `OpenAPI Spec Freshness Check` passes locally (re-run regen, expect no diff)

#### Automated QA:
- [ ] Sub-agent runs `mcp:create-workflow` (no schema) → `mcp:patch-workflow` with `triggerSchema` → `mcp:get-workflow`, asserts schema is set
- [ ] Sub-agent runs `mcp:patch-workflow` with both a DAG node delete AND `triggerSchema: null` → asserts both effects took
- [ ] Sub-agent issues `curl -X PATCH https://api.swarm.localhost:1355/api/workflows/{id} -H "Authorization: Bearer ${API_KEY}" -d '{"triggerSchema": {...}}'` and confirms 200
- [ ] Sub-agent reads the regenerated `docs-site/content/docs/api-reference/**` MDX for `PATCH /api/workflows/{id}` and asserts the new `triggerSchema` field appears with a description (capture the snippet path + line range as evidence)

#### Manual Verification:
- [ ] _None for this phase — all checks are automated above._

**Implementation Note**: After this phase, pause. Commit with `[phase 2] PATCH route + patch-workflow MCP accept triggerSchema`.

---

## Phase 3: MCP `trigger-workflow` formats `TriggerSchemaError`

### Overview

Replace the generic `Failed: ${err}` error path in the MCP `trigger-workflow` tool with a field-level message when the engine throws `TriggerSchemaError`, so agents can self-correct payload shapes.

### Changes Required:

#### 1. `trigger-workflow` MCP tool
**File**: `src/tools/workflows/trigger-workflow.ts`
**Changes**:
- Import `TriggerSchemaError` from `src/workflows/engine.ts`.
- In the catch block (currently around line 88, the `Failed: ${err}` path), add an `instanceof TriggerSchemaError` branch that returns a structured error message: validation errors as a bulleted list, plus the workflow's `triggerSchema` for reference.
- Keep the generic catch for non-validation errors.

#### 2. Test
**File**: `src/tests/workflow-mcp-trigger-schema.test.ts`
**Changes**:
- Create a workflow with `triggerSchema: { type:"object", required:["foo"], properties:{ foo:{type:"string"} } }`.
- Call `mcp:trigger-workflow` with `triggerData: {}` and assert the returned message contains the exact validator phrasing `root: missing required property "foo"` (`src/workflows/json-schema-validator.ts:39`).
- Call `mcp:trigger-workflow` with `triggerData: { foo: 42 }` and assert the message contains `foo: expected type "string", got number` (`src/workflows/json-schema-validator.ts:29`).
- The error string format is part of the contract that Phase 5's FE tester relies on — if validator phrasing changes, update both call sites.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run tsc:check` passes
- [ ] `bun run lint` passes
- [ ] `bun test src/tests/workflow-mcp-trigger-schema.test.ts` (Phase 3 cases) passes
- [ ] Existing tests in `src/tests/workflow-trigger-schema.test.ts` still pass

#### Automated QA:
- [ ] Sub-agent triggers a workflow with a mismatching payload via `mcp:trigger-workflow` and captures the exact error message; the message must name the failing field
- [ ] Sub-agent appends the captured error message (verbatim, in a fenced code block) to `thoughts/taras/qa/2026-05-05-workflow-triggerschema-coverage.md` under a `## Phase 3 — TriggerSchemaError formatting` heading, alongside the input payload and the workflow's `triggerSchema`, so future readers can judge whether the message is self-correcting
- [ ] Sub-agent re-reads the appended QA section and asserts: (a) the failing field name appears, (b) the expected vs actual type appears (for the type-mismatch case), (c) no stack trace or generic `Error:` prefix leaks through

#### Manual Verification:
- [ ] _None for this phase — all checks are automated above._

### QA Spec (optional):

Phase 3's evidence (formatted error message + payload + schema) feeds the same end-of-feature QA doc used by Phases 4 + 5.

**QA Doc**: `thoughts/taras/qa/2026-05-05-workflow-triggerschema-coverage.md` (generated via `desplega:qa` at handoff time; Phase 3 appends a `## Phase 3` section, Phases 4–5 append their UI scenarios).

**Implementation Note**: Commit `[phase 3] trigger-workflow surfaces TriggerSchemaError details`.

---

## Phase 4: FE Triggers tab — `triggerSchema` editor

### Overview

Make the existing read-only `TriggersDetailPanel` editable: widen the update hook + client typing, add an "Edit" affordance with a JSON editor, add a "Clear schema" button.

### Changes Required:

#### 1. Widen the update typing
**Files**:
- `new-ui/src/api/hooks/use-workflows.ts` (lines 43–58)
- `new-ui/src/api/client.ts` (lines 652–664)
**Changes**:
- Extend the `Partial<{ name; description; enabled }>` payload type to include `triggerSchema?: Record<string, unknown> | null`. Mirror the backend semantics: `undefined` = unchanged, object = set, `null` = clear.
- Make sure the `client.ts` PUT body forwards the field as-is (no JSON.stringify wrapping; it's already an object).

#### 2. Add JSON editor + actions to `TriggersDetailPanel`
**File**: `new-ui/src/pages/workflows/[id]/page.tsx` (lines 1094–1158)
**Changes**:
- After the existing `JsonTree` render (line 1151), add an "Edit" button. On click, swap the tree for a `<textarea>` (or an existing JSON editor primitive — see investigation note below) seeded with `JSON.stringify(triggerSchema ?? {}, null, 2)`.
- Validate the textarea's JSON on Save; if invalid, show inline error and don't submit. If valid, call `useUpdateWorkflow.mutate({ triggerSchema: parsed })`.
- Add a "Clear schema" button (only visible when `triggerSchema != null`) that calls `useUpdateWorkflow.mutate({ triggerSchema: null })` after a confirmation dialog.
- Add helper text: "Validator supports `type`, `required`, `properties`, `enum`, `const`, `items`. Other JSON-Schema keywords are silently ignored — see [runbooks/workflows.md]."

> Investigation needed during implementation: search `new-ui/src` for any existing code-editor primitive (`Monaco`, `CodeMirror`, `ReactJsonView` editable mode). If one is already used elsewhere in the app, prefer it; otherwise a styled `<textarea>` with `font-mono` is fine for v1.

#### 3. qa-use coverage (session, not YAML)
**Tooling**: `/qa-use:verify` slash command, screenshots stored under `thoughts/taras/qa/`.
**Scenarios** (run as a single session):
- Open a workflow → Triggers tab → click Edit → enter a valid schema → Save → reload page → assert schema persisted (visible in `JsonTree`).
- Click Edit → enter invalid JSON (e.g. `{ "type": }`) → Save → assert inline error, no network call.
- Click "Clear schema" → confirm → assert schema cleared from view.

> Frontend PRs (`new-ui/`) require a qa-use session with screenshots per `runbooks/testing.md` (merge-gate enforced).

### Success Criteria:

#### Automated Verification:
- [ ] `cd new-ui && pnpm exec tsc -b` passes (matches CI; not `--noEmit`)
- [ ] `cd new-ui && pnpm lint` passes
- [ ] `bun run tsc:check` passes (root)
- [ ] `bun run lint` passes (root)
- [ ] No raw `bun:sqlite` import added (DB boundary check: `bash scripts/check-db-boundary.sh`)

#### Automated QA:
- [ ] `/qa-use:verify` session covers the three scenarios above with screenshots stored under `thoughts/taras/qa/`
- [ ] qa-use evidence linked from the PR description (per `runbooks/testing.md` frontend rule)

#### Manual Verification:
- [ ] Open a workflow in dev UI (`cd new-ui && pnpm dev`, port 5274), edit `triggerSchema`, refresh, confirm persistence
- [ ] Try malformed JSON; confirm inline error UX feels correct
- [ ] Confirm "Clear schema" requires confirmation and is reversible by re-editing

### QA Spec (optional):

Phases 3, 4, and 5 share a single end-of-feature QA report (Phase 3 appends the formatted error evidence; Phases 4–5 append the UI scenarios with screenshots).

**QA Doc**: `thoughts/taras/qa/2026-05-05-workflow-triggerschema-coverage.md` (scaffolded via `desplega:qa` at planning handoff)

**Implementation Note**: Commit `[phase 4] FE triggerSchema editor with clear`.

---

## Phase 5: FE Triggers tab — payload tester

### Overview

Add a "Test trigger" panel on the Triggers tab so users can send a sample payload through `useTriggerWorkflow` and see validation errors inline. Replaces the top-bar "Trigger" button's hardcoded `{}` for the schema-aware path.

### Changes Required:

#### 1. Payload tester UI
**File**: `new-ui/src/pages/workflows/[id]/page.tsx` (within `TriggersDetailPanel`, lines 1094–1158)
**Changes**:
- When `triggerSchema != null`, render a "Test trigger" subsection with:
  - A `<textarea>` pre-seeded with `{}` (or, if you want to be fancy, an example object derived from `triggerSchema.required`).
  - A "Test trigger" button.
  - An inline result area (success or 400 error rendered as a bulleted list of validation messages).
- On click: parse the textarea, call `useTriggerWorkflow.mutate({ id, triggerData: parsed })`. On 400, render the response body's error details. On 2xx, show a success toast + the run ID + a link to the run.

#### 2. Wire `useTriggerWorkflow` to accept `triggerData`
**File**: `new-ui/src/api/hooks/use-workflows.ts`
**Changes**:
- Confirm `useTriggerWorkflow` signature accepts `{ id, triggerData?: Record<string, unknown> }`. Widen if currently `{ id }` only.
- Mirror the change on `api.triggerWorkflow` in `client.ts`.

#### 3. Tweak top-bar Trigger button (required, not optional)
**File**: `new-ui/src/pages/workflows/[id]/page.tsx:190-191`
**Changes**:
- When `triggerSchema != null` AND the schema has `required` fields, disable the top-bar Trigger button (with tooltip) and link to the Triggers tab tester. Otherwise sending `{}` is guaranteed to 400 — shipping the editor (Phase 4) without this fix would let users author a schema and then immediately break the button.
- When `triggerSchema == null`, OR when present but has no `required` fields, keep current behavior (the empty-payload trigger remains valid).
- This sub-phase ships in the same PR as Phase 4's editor; the broken-button window must not exist between merges.

#### 4. qa-use coverage (session, not YAML)
**Tooling**: `/qa-use:verify` slash command, screenshots stored under `thoughts/taras/qa/`.
**Scenarios** (extend the session from Phase 4):
- Workflow with `triggerSchema` requiring `pr.number` → enter `{}` in tester → click Test → assert inline error mentions `pr` (or `required`).
- Enter valid payload → click Test → assert success toast + run link visible.
- Workflow without `triggerSchema` → tester not shown (or shows accept-anything message).

### Success Criteria:

#### Automated Verification:
- [ ] `cd new-ui && pnpm exec tsc -b` passes
- [ ] `cd new-ui && pnpm lint` passes
- [ ] `bun run tsc:check` passes
- [ ] `bun run lint` passes

#### Automated QA:
- [ ] `/qa-use:verify` session covers the three scenarios above with screenshots
- [ ] qa-use evidence appended to `thoughts/taras/qa/2026-05-05-workflow-triggerschema-coverage.md` (single doc covers Phase 4 + Phase 5)

#### Manual Verification:
- [ ] Open a workflow with a non-trivial `triggerSchema`, send a failing payload, confirm error UX is clear
- [ ] Send a passing payload, confirm the success surface includes a link to the resulting run

**Implementation Note**: Commit `[phase 5] FE payload tester on Triggers tab`.

---

## Phase 6: Documentation

### Overview

Document `triggerSchema` everywhere agents and users would look: runbook (canonical), MCP tools reference, and a CLAUDE.md `<important if>` block.

### Changes Required:

#### 1. `runbooks/workflows.md`
**File**: `runbooks/workflows.md`
**Changes**:
- Add a new top-level section `## Trigger schema` with:
  - When to use one (gate triggers behind a payload contract)
  - Supported subset (`type`, `required`, `properties`, `enum`, `const`, `items`) and the silent-ignore caveat
  - How to set it: MCP `create-workflow` / `update-workflow` / `patch-workflow` with `triggerSchema`; HTTP `POST/PUT/PATCH /api/workflows[/{id}]`
  - How errors surface: HTTP 400 from `/trigger` and `/webhooks/{id}`; structured message from MCP `trigger-workflow`
  - Cross-reference: validator implementation at `src/workflows/json-schema-validator.ts`

#### 2. `MCP.md`
**File**: `MCP.md`
**Changes**:
- Update the `create-workflow`, `update-workflow`, `patch-workflow`, and `trigger-workflow` entries to document `triggerSchema` (and the structured error from `trigger-workflow`).

#### 3. `CLAUDE.md` `<important if>` block
**File**: `CLAUDE.md`
**Changes**:
- Add a NEW guard block (do not extend the existing workflows guard — its condition is too broad to consistently fire on `triggerSchema`-specific work):
  > `<important if="you are creating or modifying a workflow's triggerSchema, or writing tools/UI that author it">` → see `runbooks/workflows.md § Trigger schema` for the supported JSON-Schema subset and authoring paths.
- Place it immediately after the existing workflows guard so related guidance reads top-to-bottom.

#### 4. Validator JSDoc fix
**File**: `src/workflows/json-schema-validator.ts:1-10`
**Changes**:
- The file's JSDoc currently lists only `type`, `required`, `properties` — but the validator also implements `enum` (line 45), `const` (line 56), and `items` (line 82). Update the JSDoc to list all six supported keywords. This is the source of the original misclassification in earlier drafts of this plan.

#### 5. (Auto) OpenAPI doc-site
**File**: `docs-site/content/docs/api-reference/**` (auto-generated)
**Changes**:
- Already covered if Phase 2's `bun run docs:openapi` was committed. Re-run if anything drifted.

### Success Criteria:

#### Automated Verification:
- [ ] `grep -n triggerSchema runbooks/workflows.md` returns hits in the new section
- [ ] `grep -n triggerSchema MCP.md` returns hits for all four affected tools
- [ ] `grep -n triggerSchema CLAUDE.md` returns the new pointer
- [ ] `head -10 src/workflows/json-schema-validator.ts` shows JSDoc listing all six keywords (`type`, `required`, `properties`, `enum`, `const`, `items`)
- [ ] `bun run docs:openapi` produces no unstaged diff
- [ ] `bun run lint` passes (markdown lint if Biome is configured for `.md`; otherwise N/A)

#### Automated QA:
- [ ] Sub-agent reads `runbooks/workflows.md § Trigger schema` start-to-finish and confirms an agent could implement a workflow + `triggerSchema` end-to-end with no other reference
- [ ] Sub-agent verifies CLAUDE.md guard block triggers correctly by simulating a relevant prompt (the guard mentions `triggerSchema`)

#### Manual Verification:
- [ ] Read the runbook section as a new agent and confirm it answers: what / how to set / how it fails
- [ ] Confirm the `<important if>` condition matches realistic prompt phrasing

**Implementation Note**: Commit `[phase 6] docs: triggerSchema runbook + MCP.md + CLAUDE.md`.

---

## Manual E2E

End-to-end verification against a running stack. Run after all six phases land.

### Prerequisites

```bash
# 1. Start API + UI + lead/worker via PM2 (matches docker-compose-friendly local layout)
bun run pm2-restart
bun run pm2-status   # confirm api (3013), new-ui (5274), lead (3201), worker (3202) all "online"

# 2. Or, for portless dev mode (preferred while iterating):
bun run dev:http &
cd new-ui && pnpm dev &
# API at https://api.swarm.localhost:1355, UI at https://ui.swarm.localhost:1355

# 3. Confirm credentials
export API_KEY=123123                                     # default in CONTRIBUTING.md
export API_BASE=https://api.swarm.localhost:1355          # or http://localhost:3013 if PM2
export UI_BASE=https://ui.swarm.localhost:1355            # or http://localhost:5274 if PM2
```

### E2E flow

Replace `<WF_ID>` and `<RUN_ID>` placeholders with values returned by earlier steps.

```bash
# 1. MCP: create a workflow with triggerSchema (Phase 1)
#    Use Claude Code or any MCP client pointed at $API_BASE/mcp.
#    Tool: create-workflow
#    Args: { name: "triggerschema-e2e", definition: <minimal-DAG>,
#            triggerSchema: { type:"object", required:["pr"],
#                             properties:{ pr:{ type:"object", required:["number"],
#                                                properties:{ number:{type:"number"} } } } } }
#    Capture the returned id as <WF_ID>.

# 2. HTTP: confirm persistence
curl -sS -H "Authorization: Bearer $API_KEY" \
  "$API_BASE/api/workflows/<WF_ID>" | jq '.triggerSchema'
# Expect: the schema object set in step 1.

# 3. MCP: trigger with a BAD payload — expect TriggerSchemaError details (Phase 3)
#    Tool: trigger-workflow
#    Args: { id: "<WF_ID>", triggerData: {} }
#    Expect: response includes `pr: missing required property "number"` (or similar root-level required-property message)
#    AND no generic `Failed: Error:` prefix.

# 4. HTTP: trigger with a BAD payload — expect 400 with frozen error body (Phase 3)
curl -sS -i -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{}' "$API_BASE/api/workflows/<WF_ID>/trigger"
# Expect: HTTP/1.1 400, body { error: "TriggerSchemaError", message: "...", details: ["pr: missing required property \"number\""] }

# 5. HTTP: trigger with a GOOD payload — expect 2xx + run id
curl -sS -X POST -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"pr":{"number":42}}' "$API_BASE/api/workflows/<WF_ID>/trigger" | jq
# Capture `runId` as <RUN_ID>.

# 6. HTTP: PATCH triggerSchema only — leave DAG untouched (Phase 2)
curl -sS -X PATCH -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"triggerSchema":{"type":"object","required":["foo"],"properties":{"foo":{"type":"string"}}}}' \
  "$API_BASE/api/workflows/<WF_ID>" | jq '.triggerSchema'
# Expect: returned object reflects the patched schema.

# 7. MCP: patch-workflow with `triggerSchema: null` — clear it (Phase 2)
#    Tool: patch-workflow, Args: { id: "<WF_ID>", triggerSchema: null }
#    Then: GET /api/workflows/<WF_ID> and confirm triggerSchema is absent.

# 8. FE: open the Triggers tab in the browser (Phases 4 + 5)
echo "$UI_BASE/workflows/<WF_ID>?tab=triggers"
#    Manual checks:
#    - Click Edit, paste a schema, Save → reload, schema persists.
#    - Paste invalid JSON → inline error, no network call.
#    - Click Clear schema → confirm dialog → schema cleared.
#    - With a `required`-bearing schema set: top-bar Trigger button is disabled with tooltip.
#    - Test trigger panel: send `{}` → bulleted error list. Send a valid payload → success toast + run link.
#    - Capture screenshots into a /qa-use:verify session at thoughts/taras/qa/2026-05-05-workflow-triggerschema-coverage.md.

# 9. Docs sanity check (Phase 6)
grep -n triggerSchema runbooks/workflows.md MCP.md CLAUDE.md
head -10 src/workflows/json-schema-validator.ts   # confirm JSDoc lists all six keywords
```

### Pass/fail criteria

- All curl steps return the expected status + body (capture as evidence in the PR description).
- The MCP `trigger-workflow` failure message names the failing field; no `Failed: Error:` prefix.
- The FE editor round-trips a schema; the FE tester renders the frozen 400 body shape (`details: string[]`) as a bulleted list.
- The qa-use session covers the four UI scenarios in step 8 with screenshots.

### Cleanup

```bash
curl -sS -X DELETE -H "Authorization: Bearer $API_KEY" "$API_BASE/api/workflows/<WF_ID>"
```

---

## Appendix

- **Follow-up plans**:
  - Expanding the JSON-Schema validator (`oneOf`/`anyOf`/`$ref`/`pattern`/`format`/`additionalProperties`) — separate plan, gated on real demand.
  - Widening PATCH to accept `name` / `description` / `enabled` (currently PUT-only) — additive, gated on demand.
  - Auto-deriving `triggerSchema` from `triggers` (e.g., schedule triggers default to `{ scheduleId, scheduleName, firedAt }`) — design first, then plan.
  - JSON-Schema visual builder UI (instead of raw JSON textarea) — UX exploration.
- **Derail notes**:
  - The hand-rolled validator silently ignores unsupported keywords. Documenting this is the v1 mitigation; long-term we should either reject unknown keywords or actually support them.
  - `update-workflow` MCP and HTTP `PUT` already accept `triggerSchema: null`. If we add Phase 2's PATCH semantics, we have three paths to "clear" the schema — confirm test coverage hits all three.
  - The top-bar Trigger button (`page.tsx:190`) currently sends `{}` regardless of schema. Phase 5.3 mitigates by disabling it; longer term, consider unifying with the tester.
- **References**:
  - Research: `thoughts/taras/research/2026-05-05-workflow-triggerschema-coverage.md`
  - Validator implementation: `src/workflows/json-schema-validator.ts` (subset = `type` / `required` / `properties` / `enum` / `const` / `items`)
  - Existing tests: `src/tests/workflow-trigger-schema.test.ts`, `src/tests/workflow-integration-io.test.ts`
  - Workflows runbook: `runbooks/workflows.md`
  - CI guardrails: `runbooks/ci.md`

---

## Review Errata

_Reviewed: 2026-05-05 by Claude (autonomy: critical, output: auto-apply)_

### Applied

- [x] **C1** — Validator subset corrected to include `items` (recursive into arrays). Updated Current State (§ Persisted & validated), What We're NOT Doing, Phase 1.1 description, Phase 4.2 helper text, Phase 6.1 runbook subset list, Appendix follow-up plans, and Appendix References. Source: `src/workflows/json-schema-validator.ts:82-93` shows `items` is implemented.
- [x] **C2** — Added top-level `## Manual E2E` section between Phase 6 and Appendix with concrete commands (curl + MCP + FE) covering all six phases against a running stack, plus pass/fail criteria and cleanup. Required by `~/.claude/CLAUDE.md`.
- [x] **I1** — Froze the HTTP 400 error-body shape `{ error, message, details: string[] }` in Desired End State so Phase 5's FE tester isn't guessing at the response format.
- [x] **I2** — Phase 2.1 now renames `WorkflowDefinitionPatchSchema` → `WorkflowPatchSchema` once it holds a non-definition field; called out as a TS-level rename only.
- [x] **I3** — Added a `What We're NOT Doing` bullet acknowledging the asymmetric PATCH surface (no `name`/`description`/`enabled`) plus a follow-up entry in the Appendix.
- [x] **I4** — Phase 5.3 promoted from "(Optional)" to required; Phases 4 + 5 explicitly ship in the same PR; Implementation Approach updated to reflect the joint shipping constraint.
- [x] **m1** — Helper text and runbook keyword lists now include `items` (covered by C1).
- [x] **m2** — Phase 3 tests now reference the validator's exact error strings (`root: missing required property "foo"`, `foo: expected type "string", got number`) with file:line citations, rather than "verify by reading".
- [x] **m3** — Phase 2.1 OpenAPI regen note now warns that POST/PUT entries should NOT change in the diff (they already document `triggerSchema`); only the PATCH entry should drift.
- [x] **m4** — Phase 6.3 now picks one option (NEW guard block) with placement guidance.
- [x] **m5** — Added Phase 6 sub-section #4 to fix the validator's own JSDoc (`src/workflows/json-schema-validator.ts:1-10`), plus an Automated Verification grep.

### Remaining

_None — all findings auto-applied per output mode._
