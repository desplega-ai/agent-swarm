---
date: 2026-05-20T14:00:00Z
topic: "PR #500 — Pass 2/3/4 UI QA"
status: in-progress
branch: feat-human-first
pr: 500
---

# PR #500 — Pass 2/3/4 UI QA

**Branch:** `feat-human-first` @ `e256cbf5` (v1.81.0) · **Date:** 2026-05-20
**Env:** API `:3013` (restarted, migration 065 applied) · UI `:5180` · DB = existing seeded fixtures

Legend per item — `Verdict:` filled by Claude (PASS / FAIL / UNCLEAR) · `Taras:` your UX feedback / gaps to fill.

---

## A — `/people` list layout (Pass 2 B)

### A1. Search box + People/Unmapped tabs share one row
- Verdict: **PASS** — search input + `People (14)` / `Unmapped 7` tabs measured on same row (top delta < 60px).
- Taras: _____

### A2. Tables are full-height + scrollable (no fixed clip, no double scrollbar)
- Verdict: **PASS (partial)** — table fills the panel, single layout, no double scrollbar. Only 14 rows so they fit without scrolling — actual overflow-scroll not exercised.
- Taras: _____

### A3. Subtitle present
- Verdict: **PASS** — subtitle present but text differs per tab. People tab: "Manage the humans who interact with this swarm — link their Slack, GitHub, Linear and GitLab accounts, set per-user budgets, and triage requests from accounts we haven't matched yet." Unmapped tab: "Operator surface for human users — identities, budgets, status, merge tool, and unmapped triage."
- Taras: _____

## B — Identity badges cap (Pass 4 K)

### B1. Identity chips in the list capped at **2**, overflow shows `+N`
- Verdict: **PASS** — Ada (4 identities) renders `GitHub` `GitLab` `+2 more`. Cap = 2, overflow label is `+N more`.
- Taras: _____

### B2. Chips don't wrap / don't push the row height (flex-nowrap, shrink-0)
- Verdict: **PASS** — all rows uniform height; Ada's chip cell stays single-line.
- Taras: _____

## C — Unmapped tab (Pass 2 B + Pass 3 F + Pass 4 K)

### C1. Filter is a **single row** — kind combobox with search, on same row as actions
- Verdict: **PASS** — single `Filter: All` button opens a combobox with a search input + options `All / Slack / Linear / GitHub / GitLab`. Sits on the search row.
- Taras: _____

### C2. Filter combobox actually filters by kind (All / Slack / Linear / GitHub / GitLab)
- Verdict: **PASS** — selecting `Slack` narrowed 7 rows → 2 Slack rows (@kova, @qatest). Reset to `All` restores.
- Taras: _____

### C3. Actions column right-aligned, "Link to user" / "Create user" don't wrap
- Verdict: **PASS** — every row's actions render right-side, single-line `Link to user` + `Create user` (visual).
- Taras: _____

### C4. Resolve **error** path shows a toast (not just success) — audit all toast call sites
- Verdict: **PASS (code-verified)** — `resolve-create-dialog.tsx:66` and `link-to-existing-dialog.tsx:58` both `toast.error(err.message)` in catch; create dialog also toasts validation errors (name/email). Copy has success+error toasts. Runtime error not force-triggered.
- Taras: _____

## D — Merge modal (Pass 2 C + Pass 3 G + Pass 4 J)

### D1. 3-step vertical layout (source -> target -> confirm), readable copy
- Verdict: **PASS** — 3 numbered steps confirmed: ① "Pick the account to delete" → ② "Pick the surviving account" → ③ "Confirm" (step 3 reveals after both picked, with a full before→after preview). Copy clear, "permanently deleted" bolded.
- Taras: _____

### D2. User picker dropdown scrolls when list is long (`max-h-260px overflow-y-auto`)
- Verdict: **PASS** — picker list measured `max-height: 260px`, `overflow-y: auto`, scrollable with 14 options; has a search input. `merge-modal.tsx:413`.
- Taras: _____

### D3. Modal itself caps at `max-h-85vh` and scrolls — no overflow off-screen
- Verdict: **PASS (code-verified)** — `merge-modal.tsx:140` `DialogContent` has `max-h-[85vh] flex flex-col overflow-hidden`. Not visually exercised (modal content short on this viewport).
- Taras: _____

### D4. Merge completes; source disappears; `manual_merge` event in target timeline
- Verdict: **PASS (with bug — see BUG-A)** — merged Cleo Park → Bryn Kovac. People count 14→13, Cleo gone, Bryn present. Bryn inherited Cleo's 3 identities (`U_CLEO_DEMO`, `U07XYZDEMO1`, linear `…cleo000000002`) + `cleo.park@example.com` as alias. `manual_merge` event created with complete before/after JSON snapshot (incl. nested sub-events). **BUG-A:** the event-row summary renders "Merged manually from **Bryn Kovac → Bryn Kovac**" — source name shows as target. Event payload's `before` is the *target's* pre-merge state; the source user's `{id,name}` is never stored, so the renderer can't show "Cleo Park → Bryn Kovac". Misleading audit trail.
- Taras: _____

## E — New-user / add-identity dialogs (Pass 2 C + Pass 3 G/H)

### E1. Identity kind picker shows brand logos (not text-only)
- Verdict: **PASS** — both the New-user dialog and the Add-identity dialog show Slack/GitHub/Linear/GitLab as brand-SVG buttons (`svg[aria-label]`) + an "Other…" option.
- Taras: _____

### E2. Custom kind input — leading/trailing spaces trimmed on submit
- Verdict: **PASS (but see BUG-C)** — selecting the `Use "jira"` suggestion committed the kind as `jira` (no surrounding spaces) → trim works. **However** see BUG-C: if you don't select the suggestion, the typed kind is dropped entirely.
- Taras: _____

### E3. New-user dialog creatable identity rows work end-to-end
- Verdict: **PASS (partial)** — New-user dialog has an "Initial identities" section; "Add identity" adds a creatable identity row (kind picker + externalId input). Not submitted end-to-end (avoided creating a throwaway user); row mechanics verified.
- Taras: _____

## F — Detail page (Pass 2 D + Pass 3 H)

### F1. Notes field is full-width
- Verdict: **PASS** — Notes textarea width 1902px vs Name input 939px → spans the full card (both columns). Breadcrumb resolves to "Ada Sandoval" (name, not UUID). Save button disabled with no edits.
- Taras: _____

### F2. Identities + Events tabs are DataGrid (AG Grid) tables
- Verdict: **PASS** — both tabs render `.ag-root-wrapper`. Identities headers: Provider / External ID / Display name / Linked at / (actions). Events headers: Time / Event / Actor / Change.
- Taras: _____

### F3. Event row click opens detail in a side `<Sheet>` (not inline/modal)
- Verdict: **PASS** — clicking an event row opens a right-edge Sheet with event id, WHEN/ACTOR, and BEFORE/AFTER JSON blocks.
- Taras: _____

### F4. `?tab=` query param syncs with active tab (reload / back-button safe)
- Verdict: **PASS** — switching tabs updates URL to `?tab=identities` / `?tab=events` / `?tab=profile`; opening a URL with `?tab=` activates that tab.
- Taras: _____

## G — Events density + icons (Pass 3 H)

### G1. Events table denser spacing per Pass 3 H
- Verdict: **PASS** — events render as a compact AG Grid; rows readable, Change column shows brand icon + diff inline.
- Taras: _____

### G2. Distinct lucide icons per event type (identity_added / identity_removed / profile_changed / manual_merge)
- Verdict: **PASS** — distinct icons confirmed: `circle-dollar-sign` (budget_changed), `user-plus` (identity_added), `✎`/pencil (profile_changed), `⇄` (manual_merge). Change column also shows per-provider brand icons.
- Taras: _____

### G3. `profile_changed` event fires on profile edit (needs migration 065 — now live)
- Verdict: **PASS** — edited Ada's Name → Save ("Profile saved" toast) → `Profile Changed` event appeared "just now": `Profile name "Ada Sandoval" → "Ada Sandoval QA"`. Migration 065 live. Name reverted after test.
- Taras: _____

## H — Brand icons (Pass 2 A + Pass 3 I)

### H1. Slack / GitHub / Linear / GitLab render as real brand SVGs
- Verdict: **PASS** — all four render as monochrome brand SVGs (`<svg role=img aria-label=...>`) in the identities table and the events Change column.
- Taras: _____

### H2. Jira + AgentMail logos added and render
- Verdict: **PASS** — created a `jira`-kind identity → the Jira (Atlassian) glyph rendered in the identities table. AgentMail icon is code-confirmed (`integration-icons.tsx` `case "agentmail"` → `AgentMailIcon`, same render path) — not exercised live to avoid extra DB churn.
- Taras: _____

## I — Tasks table version gate (Pass 4 L)

### I1. "Requested by" column appears in the tasks table (server now >= 1.81.0)
- Verdict: **PASS** — "Requested by" column present (between Agent and Elapsed). Header bar reports `v1.81.0`, so the version gate is open.
- Taras: _____

### I2. Column shows the requesting user / blank gracefully when none
- Verdict: **PASS** — the one task (`[Linear DES-20] Example`, Linear-sourced) shows `Requested by: Taras Yarema` with a user icon — i.e. `requestedByUserId` is populated (Linear Q21.A fix in action). Only one task exists; the blank/no-requester case wasn't exercised.
- Taras: _____

---

## Console errors sweep
- Verdict: **NOT CAPTURED** — `browser-use` doesn't surface the console buffer; no console errors were programmatically captured. No UI crashes / blank screens observed across People list, Unmapped, detail (Profile/Identities/Events), merge modal, dialogs, Tasks. Recommend a manual devtools pass.
- Taras: _____

## Summary

| Section | Result |
|---|---|
| A — list layout | PASS (A2 partial — scroll not exercised) |
| B — badge cap | PASS |
| C — Unmapped tab | PASS |
| D — Merge modal | PASS (D4 surfaced **BUG-A**) |
| E — dialogs | PASS (E2 caveat → **BUG-C**; E3 partial) |
| F — detail page | PASS |
| G — events density/icons | PASS |
| H — brand icons | PASS (AgentMail code-confirmed only) |
| I — tasks "Requested by" | PASS |

**3 bugs found — all fixed and pushed to PR #500** (`feat-human-first` @ `2ecd4cc7`):
- **BUG-A** — `manual_merge` event omits the source user (audit trail shows `target → target`). **FIXED** — commit `92f1e99b`.
- **BUG-B** — identity `kind` path param not URL-decoded (incomplete BUG-1 fix). **FIXED** — commit `92f1e99b`.
- **BUG-C** — custom identity kind silently falls back to `slack` if the `Use "X"` suggestion isn't clicked. **FIXED** — commit `2ecd4cc7`; verified end-to-end (typing `jira` + closing the popover now creates a `Jira` identity).

## Bugs found

### BUG-A — `manual_merge` event omits the source user → summary shows `target → target` — FIXED (`92f1e99b`)
- Where: People detail → Events tab, Manual Merge row. Renders "Merged manually from Bryn Kovac → Bryn Kovac".
- Root cause (`src/http/users.ts:566`): `recordIdentityEvent(targetId, "manual_merge", actor, targetBefore, targetAfter)` — both before & after are the **target**. `sourceBefore` is computed at line 516 and used to move identities/aliases, but is **never written into the event**. The "Merged manually from {X} → {Y}" renderer resolves both names from the target → identical names.
- Impact: misleading audit trail on an operator surface — you can't tell who was merged into whom from the event log. Source user identity is permanently lost (source row is deleted at line 562).
- Fix direction: persist `sourceBefore` (`{id, name, email}` at minimum) in the `manual_merge` event payload; update the events-table change renderer to read the source name from it.
- Repro: any merge. Reproduced on today's Cleo→Bryn merge and a prior 2026-05-19 Ada-QA→Bryn merge (same wrong label).

### BUG-B — identity `kind` path param not URL-decoded (incomplete BUG-1 fix) — FIXED (`92f1e99b`)
- The `fix/url-decode-identity-params` change added `decodeURIComponent` for the `externalId` path segment but **missed the `kind` segment** in the same two handlers:
  - `resolveUnmapped` (`src/http/users.ts:414`) — `const { kind } = parsed.params` is used raw at `linkIdentity(...)` (432) and to build the kv namespace `integration:unmapped:${kind}` (434). A custom kind with `;`/`@`/`+` arrives encoded → identity stored with encoded kind AND the kv-delete targets the wrong namespace → unmapped row won't clear (same failure mode as BUG-1, on `kind` instead of `externalId`).
  - `deleteIdentityRoute` (`src/http/users.ts:494`) — `unlinkIdentity(parsed.params.id, parsed.params.kind, externalId, actor)` passes `kind` raw/encoded → unlink can't match the stored decoded kind → delete silently fails.
- Live symptom: a 2026-05-19 `identity_removed` event shows `before.kind: "exdampl%3Be"` (encoded `;`) vs the `identity_added` 3s earlier showing `kind: "exdampl;e"`.
- Fix: `decodeURIComponent(parsed.params.kind)` in both handlers, mirroring the existing `externalId` decode. Add a regression test with a `kind` containing `;`/`@`.

### BUG-C — custom identity `kind` silently falls back to the default preset if not committed — FIXED (`2ecd4cc7`)
- Where: Add-identity dialog → "Other…" → custom-kind combobox.
- Repro: click "Other…", type a custom kind (e.g. `jira`), do NOT click the `Use "jira"` dropdown suggestion, fill External ID, click "Link identity". Result: an identity is created with kind **`slack`** (the default preset), not `jira` — silently. The typed text is visible in the input but never committed to form state.
- The "Link identity" button stays **enabled** while the custom kind is uncommitted, so there is no signal that the kind won't be used.
- Impact: silent wrong-kind data. An operator adding a `jira`/`agentmail`/custom identity can easily end up with a `slack` identity instead.
- Verified: reproduced on this branch — first attempt created `Slack · ADA-JIRA-QA`; only after selecting the `Use "jira"` option did it create `Jira · ADA-JIRA-QA`.
- Fix direction: either commit the typed value on blur / on submit, or disable "Link identity" until the custom kind is committed.

## Overall
- Taras: _____
