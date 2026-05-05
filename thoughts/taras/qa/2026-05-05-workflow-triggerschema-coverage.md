---
date: 2026-05-05
author: Claude (with Taras)
topic: "Workflow `triggerSchema` end-to-end coverage"
tags: [qa, workflows, triggerSchema, mcp-tools, frontend, validation]
status: in-progress
source_plan: thoughts/taras/plans/2026-05-05-workflow-triggerschema-coverage.md
source_verification: null
related_pr: null
environment: local
last_updated: 2026-05-05
last_updated_by: Claude (phases 4+5 scaffold)
---

# Workflow `triggerSchema` end-to-end coverage — QA Report

## Context

This QA doc captures **functional evidence** for the `triggerSchema` end-to-end coverage feature. Three plan phases write into it:

- **Phase 3** — appends the verbatim formatted `TriggerSchemaError` from `mcp:trigger-workflow`, plus the input payload and the workflow's `triggerSchema`, so reviewers can judge whether the message is self-correcting.
- **Phase 4** — appends UI scenarios for the `triggerSchema` editor in the Triggers tab (edit-and-save, invalid-JSON guard, clear-schema), with screenshots.
- **Phase 5** — appends UI scenarios for the payload tester (failing payload with inline error, passing payload with run link, no-schema fallthrough), with screenshots.

Plan: `thoughts/taras/plans/2026-05-05-workflow-triggerschema-coverage.md`

## Scope

### In Scope

- MCP `trigger-workflow` error formatting against a `triggerSchema`-gated workflow (Phase 3)
- FE Triggers tab editor: edit, save, invalid JSON, clear (Phase 4)
- FE Triggers tab payload tester: failing, passing, no-schema (Phase 5)

### Out of Scope

- Engine-level validation correctness (already covered by `src/tests/workflow-trigger-schema.test.ts` and `src/tests/workflow-integration-io.test.ts`)
- HTTP `PUT/POST/PATCH` round-trips (covered by Phase 1/2 unit tests, not this QA doc)
- Documentation accuracy (Phase 6 — caught by automated grep checks)

## Test Cases

### TC-1: MCP `trigger-workflow` surfaces field-level error (Phase 3)

**Setup**: Create a workflow with `triggerSchema = { type: "object", required: ["foo"], properties: { foo: { type: "string" } } }`.

**Steps:**
1. Call `mcp:trigger-workflow` with `triggerData: {}`.
2. Capture the returned message verbatim.
3. Repeat with `triggerData: { foo: 42 }` (type mismatch).

**Expected Result:** Both responses name the failing field (`foo`) and the failure mode (missing required, then type mismatch). No stack trace or generic `Failed: Error:` prefix.

**Actual Result:** Both calls return a structured error from the MCP `trigger-workflow` tool. `content[0].text` is a human-facing bulleted list naming the failing field (`foo`) plus the workflow's `triggerSchema` for self-correction. `structuredContent` carries `success: false`, the validator's exact strings under `validationErrors: string[]`, and the schema under `triggerSchema`. No stack trace, no `Failed:` prefix, no leading `Error:`. See verbatim capture under `## Phase 3 — TriggerSchemaError formatting` and Logs & Output below.

**Status:** PASS

### TC-2: FE editor — edit, save, persist (Phase 4)

**Steps:**
1. Open a workflow → Triggers tab → click Edit.
2. Enter a valid `triggerSchema` (e.g. `{ "type": "object", "required": ["pr"] }`) → Save.
3. Reload page → verify schema visible in `JsonTree`.

**Expected Result:** Schema persists across reload. PUT `/api/workflows/{id}` shows `triggerSchema` in payload (Network tab).

**Actual Result:** _[fill in during implementation]_

**Status:** _[in-progress]_

### TC-3: FE editor — invalid JSON guard (Phase 4)

**Steps:**
1. Click Edit → enter `{ "type": }` (malformed) → Save.

**Expected Result:** Inline JSON error displayed; no network request fired (verify Network tab shows nothing).

**Actual Result:** _[fill in during implementation]_

**Status:** _[in-progress]_

### TC-4: FE editor — clear schema (Phase 4)

**Steps:**
1. On a workflow with `triggerSchema` set, click "Clear schema" → confirm.
2. Reload page.

**Expected Result:** Schema is cleared (`JsonTree` no longer rendered, panel shows the empty/unset state).

**Actual Result:** _[fill in during implementation]_

**Status:** _[in-progress]_

### TC-5: FE payload tester — failing payload (Phase 5)

**Setup**: Workflow with `triggerSchema = { type: "object", required: ["pr"], properties: { pr: { type: "object", required: ["number"] } } }`.

**Steps:**
1. Triggers tab → enter `{}` in the Test trigger textarea → click Test.

**Expected Result:** Inline error mentions `pr` (or `required`). No run created.

**Actual Result:** _[fill in during implementation]_

**Status:** _[in-progress]_

### TC-6: FE payload tester — passing payload (Phase 5)

**Steps:**
1. Same workflow as TC-5. Enter `{ "pr": { "number": 42 } }` → click Test.

**Expected Result:** Success toast + link to the new run. Click link → run-detail page loads with the payload visible in the trigger context.

**Actual Result:** _[fill in during implementation]_

**Status:** _[in-progress]_

### TC-7: FE payload tester — no schema fallthrough (Phase 5)

**Steps:**
1. Open a workflow with `triggerSchema = null`.
2. Inspect Triggers tab.

**Expected Result:** Tester is hidden (only renders when `triggerSchema != null`). Read view shows the "No trigger schema set — accepts any payload" empty-state with an Edit button. Top-bar Trigger button still works (sends `{}`) — guard does not engage.

**Actual Result:** _[fill in during implementation]_

**Status:** _[in-progress]_

### TC-8: Top-bar Trigger button guard (Phase 5.3)

**Setup**: Workflow with `triggerSchema = { type: "object", required: ["pr"], properties: { pr: { type: "object" } } }`.

**Steps:**
1. Open the workflow detail page.
2. Inspect the top-bar Trigger button.
3. Hover the button to surface the tooltip.
4. Click the "Open the Triggers tab" link inside the tooltip.

**Expected Result:**
- Top-bar Trigger button is rendered disabled (`data-testid="top-bar-trigger-button-guarded"`).
- Tooltip names the required field(s) (e.g. "Trigger schema requires pr.") and offers a clickable link to the Triggers tab.
- Clicking the in-tooltip link switches the active tab to "triggers" via `setActiveTab`.
- For a workflow whose `triggerSchema.required` is empty or absent, the guard does NOT engage (button stays clickable, sends `{}`).

**Actual Result:** _[fill in during implementation]_

**Status:** _[in-progress]_

## Edge Cases & Exploratory Testing

- **Schema with unsupported keyword (e.g. `oneOf`):** verify the editor accepts it (no client-side rejection — we don't duplicate validator logic), but document somewhere visible (helper text) that it'll be silently ignored at runtime.
- **Very large `triggerSchema` (>10KB):** confirm editor textarea performance is acceptable (no UI freeze).
- **Concurrent edits**: open editor in two tabs, save in one, save in the other — last-write-wins is acceptable; verify no crash.

## Evidence

### Screenshots

_[populate during Phase 4/5 implementation]_

- `triggerSchema-editor-save.png` — TC-2 success state
- `triggerSchema-editor-invalid-json.png` — TC-3 inline error
- `triggerSchema-editor-clear.png` — TC-4 cleared state
- `triggerSchema-tester-failing.png` — TC-5 inline 400 error
- `triggerSchema-tester-passing.png` — TC-6 success toast
- `triggerSchema-no-schema.png` — TC-7 fallthrough
- `triggerSchema-topbar-guard.png` — TC-8 disabled top-bar button + tooltip with link

### Logs & Output

#### Phase 3 — captured `mcp:trigger-workflow` error (missing required)

`content[0].text` (verbatim from `src/tools/workflows/trigger-workflow.ts` handler):

```
Trigger payload did not match the workflow's triggerSchema:
- root: missing required property "foo"

Expected triggerSchema:
```json
{
  "type": "object",
  "required": [
    "foo"
  ],
  "properties": {
    "foo": {
      "type": "string"
    }
  }
}
```
```

`structuredContent`:

```json
{
  "success": false,
  "message": "Trigger payload did not match the workflow's triggerSchema (1 error).",
  "validationErrors": [
    "root: missing required property \"foo\""
  ],
  "triggerSchema": {
    "type": "object",
    "required": ["foo"],
    "properties": { "foo": { "type": "string" } }
  }
}
```

#### Phase 3 — captured `mcp:trigger-workflow` error (type mismatch)

`content[0].text`:

```
Trigger payload did not match the workflow's triggerSchema:
- foo: expected type "string", got number

Expected triggerSchema:
```json
{
  "type": "object",
  "required": [
    "foo"
  ],
  "properties": {
    "foo": {
      "type": "string"
    }
  }
}
```
```

`structuredContent`:

```json
{
  "success": false,
  "message": "Trigger payload did not match the workflow's triggerSchema (1 error).",
  "validationErrors": [
    "foo: expected type \"string\", got number"
  ],
  "triggerSchema": {
    "type": "object",
    "required": ["foo"],
    "properties": { "foo": { "type": "string" } }
  }
}
```

### External Links

_[fill in once PR is opened]_

## Issues Found

- [ ] _[populate during implementation]_

## Verdict

**Status**: _[set to PASS / FAIL once all test cases are filled in]_
**Summary**: _[1–2 sentences after implementation]_

## Phase 3 — TriggerSchemaError formatting

This section consolidates the Phase 3 evidence required by the plan's Automated QA item 2 ("Sub-agent appends the captured error message verbatim, alongside the input payload and the workflow's `triggerSchema`, so future readers can judge whether the message is self-correcting").

**Workflow `triggerSchema`** (used for both cases below):

```json
{
  "type": "object",
  "required": ["foo"],
  "properties": { "foo": { "type": "string" } }
}
```

### Case A — missing required field

**Input payload** (`triggerData` arg to `mcp:trigger-workflow`):

```json
{}
```

**Returned `content[0].text`** (verbatim from the live handler in `src/tools/workflows/trigger-workflow.ts`):

```
Trigger payload did not match the workflow's triggerSchema:
- root: missing required property "foo"

Expected triggerSchema:
```json
{
  "type": "object",
  "required": [
    "foo"
  ],
  "properties": {
    "foo": {
      "type": "string"
    }
  }
}
```
```

**Returned `structuredContent.validationErrors`**:

```json
["root: missing required property \"foo\""]
```

**Self-correcting checks** (per plan's Phase 3 Automated QA item 3):

- (a) Failing field name appears: `foo` is named explicitly in the bullet line and re-shown in the echoed schema. PASS
- (b) Type-mismatch info: not applicable to this case (covered by Case B).
- (c) No stack trace, no `Failed:` prefix, no leading `Error:` prefix. PASS

### Case B — type mismatch

**Input payload**:

```json
{ "foo": 42 }
```

**Returned `content[0].text`**:

```
Trigger payload did not match the workflow's triggerSchema:
- foo: expected type "string", got number

Expected triggerSchema:
```json
{
  "type": "object",
  "required": [
    "foo"
  ],
  "properties": {
    "foo": {
      "type": "string"
    }
  }
}
```
```

**Returned `structuredContent.validationErrors`**:

```json
["foo: expected type \"string\", got number"]
```

**Self-correcting checks**:

- (a) Failing field name `foo` appears in both the bullet line and the echoed schema. PASS
- (b) Expected vs actual type both appear: `expected type "string", got number`. PASS
- (c) No stack trace, no `Failed:` prefix, no leading `Error:` prefix. PASS

### How this evidence was produced

Captured by exercising the production tool handler directly via the MCP SDK's `_registeredTools` map (the same path the test harness uses) against a fresh in-process API + DB. The same wiring is asserted in `src/tests/workflow-mcp-trigger-schema.test.ts` tests `trigger-workflow with missing required field → structured TriggerSchemaError` and `trigger-workflow with type-mismatched payload → structured TriggerSchemaError`.

## Appendix

- **Plan**: `thoughts/taras/plans/2026-05-05-workflow-triggerschema-coverage.md`
- **Research**: `thoughts/taras/research/2026-05-05-workflow-triggerschema-coverage.md`
- **Related documents**:
  - Validator subset reference: `src/workflows/json-schema-validator.ts:1-10`
  - Engine validation: `src/workflows/engine.ts:54-60`
- **Notes**: Phase 6 (docs) does not write here — it's verified by automated grep checks in the plan.
