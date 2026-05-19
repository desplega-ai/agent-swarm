---
id: step-9
name: People page UI + Unmapped tab
depends_on: [step-8]
status: ready
---

# step-9: People page UI + Unmapped tab

## Overview

Build the operator-facing People page. List view (identity badges + budget + status), per-user detail view (edit profile / identities / budget / status / view events timeline), Unmapped tab (kv-backed list with filter chips + create-or-link CTAs), and operator merge tool (select two rows → preview → confirm). **No token-mint dialog** — deferred to the MCP plan, no endpoint to back it (Core Req #6). All operator-facing; gated by the existing API-key auth on the UI. Manual QA only (per feedback memory: Taras manual-QAs the SPA in this repo; skip qa-use YAML / UI unit-test infra).

## Changes Required:

#### 1. List view route

**File**: `ui/src/pages/people/` (new folder, mirroring existing `ui/src/pages/<feature>/` convention)

**Sub-files**: `index.tsx` (route entry), `People.tsx` (the list view), `usePeople.ts` (data hook), per feature-style of adjacent pages (cross-reference `ui/src/pages/agents/` or `ui/src/pages/api-keys/` for the project's conventions on data-fetching hooks, table components, etc.).

**Changes**:

- Fetch `GET /api/users` via existing fetcher util (`ui/src/api/*`).
- Render a table or card list with columns:
  - Name + email (with email-aliases tooltip).
  - Identity badges — one per `(kind, externalId)` from `user.identities`, color-coded by kind (slack/linear/github/gitlab/custom).
  - Budget badge: `"Unlimited"` when `dailyBudgetUsd == null`, else `$X.YY/day`. Tooltip: "Enforced once MCP user-tokens ship" per Q11.
  - Status pill: `invited` / `active` / `suspended` (color-coded).
  - Recent activity: latest 1–2 events from `user.recentEvents` (timestamps + event type icon).
- Row click → navigate to detail (`/people/:id`).
- Top-right CTA: "+ New user" → opens a modal that POSTs `/api/users` with name + email + optional initial identities.
- Top-right tab toggle: "People" / "Unmapped" (counter badge on Unmapped tab showing total unmapped count from `GET /api/users/unmapped`).
- Top-right secondary CTA: "Merge users" → opens the merge modal (#4 below).

#### 2. Detail view route

**File**: `ui/src/pages/people/[id]/PersonDetail.tsx` (and supporting hooks)

**Changes**:

- Fetch `GET /api/users/:id` (the existing route returns the user; ensure step-8 composes identities + events when the list is also calling this — or use the dedicated `GET /api/users/:id` if it exists). If not yet present, lean on `GET /api/users` + client-side filter for v1.
- Sections:
  - **Profile**: name, primary email, email aliases (add/remove buttons → PATCH `/api/users/:id` with new `emailAliases`). Inline edit on each field; explicit Save / Cancel.
  - **Identities**: list of `(kind, externalId)` badges with `[Remove]` per badge → DELETE `/api/users/:id/identities/:kind/:externalId`. "+ Add identity" → modal collecting `{kind, externalId}` → POST `/api/users/:id/identities`.
  - **Budget**: number input (with $ prefix) + "Unlimited" toggle. Save → PATCH `/api/users/:id` with `dailyBudgetUsd`.
  - **Status**: dropdown (invited/active/suspended). Save → PATCH `/api/users/:id` with `status`.
  - **Events timeline**: paginated list from `GET /api/users/:id/events`. Each row: icon for `eventType`, actor (truncate `op:<hex>` to first 8 chars with full on hover), timestamp (relative + absolute on hover), expand to show before/after JSON diff.
- All edits route through the existing API and rely on step-8's middleware to write events.

#### 3. Unmapped tab

**File**: `ui/src/pages/people/unmapped/UnmappedList.tsx`

**Changes**:

- Fetch `GET /api/users/unmapped`.
- Render a table:
  - Row = one `(kind, externalId)` group.
  - Columns: kind badge, externalId (clickable to copy), count, last-seen (relative), sampleEventType, sampleContext (truncated with full on hover).
- Filter chips: All / Slack / Linear / GitHub / GitLab — applies `?kind=` query param to the fetch.
- Sort: count DESC by default; secondary sort = last-seen DESC. Header click toggles.
- Per row, two CTAs:
  - **[Link to existing user]** → opens user picker (search by name/email, calling `GET /api/users` and filtering client-side) → confirm → POST `/api/users/unmapped/:kind/:externalId/resolve` with `{userId}`. On 200, remove row from list.
  - **[Create user from this]** → opens a modal: prompts for `name` + `email`. Submit → POST `/api/users/unmapped/:kind/:externalId/resolve` with `{name, email}`. On 200, remove row.

#### 4. Operator merge modal

**File**: `ui/src/pages/people/MergeModal.tsx`

**Changes**:

- Triggered from the People list top-right "Merge users" CTA.
- Two pickers: "Target user" (the row that survives) and "Source user" (the row to merge in). Each picker is a search-by-name-or-email select.
- Preview: show what will move (identities from source, email aliases) and what will be deleted (source row). Show a diff-style summary.
- Confirm → POST `/api/users/:targetId/merge` with `{sourceUserId}`. On 200, redirect to the merged user's detail page; show a toast: "Merged. Source user deleted. `manual_merge` event recorded."

#### 5. Router wiring

**File**: `ui/src/app/router.tsx` (or wherever routes are declared — check the existing nav)

**Changes**:

- Add `/people` route → People list view.
- Add `/people/:id` → Detail view.
- Add `/people/unmapped` route → Unmapped tab (or implement as a tab within `/people` per the design choice in #1).
- Add nav-bar entry "People" with the unmapped-count badge if non-zero.

#### 6. UI types sanity

**File**: `ui/src/api/types.ts` (already updated in step-1)

**Changes**: confirm the types match what step-8's endpoints actually return. If step-8 added/removed any fields not anticipated, update here.

#### 7. No token-mint dialog

**Decision**: per Core Req #6 the `POST/DELETE /users/:id/mcp-tokens` endpoints ship with the MCP plan. The token-mint dialog UI also ships there. **Do not add it in this step.** The detail page may show an empty `Tokens` section with text "Tokens land with the upcoming MCP integration" or omit the section entirely. Recommend omission — easier to add a complete section later than to add and then mutate a stub.

### Success Criteria:

#### Automated Verification:

- [ ] `cd ui && pnpm install --frozen-lockfile && pnpm lint && pnpm exec tsc -b` passes (CI mirror).
- [ ] No new dependencies pulled in unless absolutely required (note any in the PR description).

#### Automated QA:

- [ ] Per memory `feedback_ui_tests_qa_use.md`: **skip qa-use YAML / UI unit-test infra in this repo**. Manual QA only. (Documenting this explicitly so the implementer doesn't accidentally add framework scaffolding.)

#### Manual Verification:
*(Taras manual-QAs the SPA in this repo — feedback memory `feedback_ui_tests_qa_use.md` — so every flow below is a human-only check.)*

- [ ] Navigate to `/people`. List loads. Verify: identity badges colored per kind, budget "Unlimited" or `$X.YY` displayed, status pill colored. No console errors.
- [ ] Click a row → detail page loads. Edit name → Save. Refresh → name persists. Events timeline shows `identity_added` from the create.
- [ ] On detail, click "Add identity" → enter kind + externalId → Save. Identity badge appears. Events timeline gains `identity_added`. Click [Remove] on the new badge → it disappears. Timeline gains `identity_removed`.
- [ ] On detail, change daily budget to `5.00` → Save. Refresh → persists; events timeline gains `budget_changed`. Toggle "Unlimited" → budget cleared; new `budget_changed`.
- [ ] On detail, change status from `active` to `suspended` → Save. Refresh → persists; events timeline gains `status_changed`.
- [ ] On detail, add an email alias `alt@x.com` → Save. Events timeline gains `email_added`. Remove it → gains `email_removed`.
- [ ] Switch to Unmapped tab. Verify: at least one unmapped entry visible (you may need to seed one — trigger an unknown-Slack message during the manual QA per step-2's QA, or kv-insert manually). Filter chips work. Click "Create user from this" → enter name+email → user appears on the People list; Unmapped row disappears.
- [ ] Switch to Unmapped tab. Click "Link to existing user" on a row. Pick a user. Confirm. Identity linked, row gone, timeline on that user shows `identity_added`.
- [ ] Open the merge modal. Pick two users, preview, confirm. Verify: target gained source's identities + aliases, source page now 404s, target timeline shows `manual_merge`.
- [ ] No console errors across any flow.

**Implementation Note**: This is the last code step. After manual QA passes, commit with `[step-9] ui: People page + Unmapped tab + merge tool (no token mint — defers to MCP plan)`. Then the Global Verification block in `root.md` runs and the PR is opened.
