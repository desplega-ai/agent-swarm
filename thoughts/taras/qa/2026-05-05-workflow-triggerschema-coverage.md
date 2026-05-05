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
last_updated_by: Claude
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

**Actual Result:** _[fill in during implementation — paste verbatim message in the Logs & Output section below]_

**Status:** _[in-progress]_

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

**Expected Result:** Tester is hidden, OR shows an "accept any payload" message. Top-bar Trigger button still works (sends `{}`).

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

### Logs & Output

#### Phase 3 — captured `mcp:trigger-workflow` error (missing required)

```
[paste verbatim during Phase 3 implementation]
```

#### Phase 3 — captured `mcp:trigger-workflow` error (type mismatch)

```
[paste verbatim during Phase 3 implementation]
```

### External Links

_[fill in once PR is opened]_

## Issues Found

- [ ] _[populate during implementation]_

## Verdict

**Status**: _[set to PASS / FAIL once all test cases are filled in]_
**Summary**: _[1–2 sentences after implementation]_

## Appendix

- **Plan**: `thoughts/taras/plans/2026-05-05-workflow-triggerschema-coverage.md`
- **Research**: `thoughts/taras/research/2026-05-05-workflow-triggerschema-coverage.md`
- **Related documents**:
  - Validator subset reference: `src/workflows/json-schema-validator.ts:1-10`
  - Engine validation: `src/workflows/engine.ts:54-60`
- **Notes**: Phase 6 (docs) does not write here — it's verified by automated grep checks in the plan.
