---
id: step-10
name: UI — single-flow connection creation
depends_on: [step-6, step-7]
status: ready
---

# step-10: UI — single-flow connection creation

## Overview
Make connection creation a single dialog flow end to end: pick from the catalog (blessed entries first) or enter manually → baseUrl prefilled from the spec (server-side now, step-3 — remove the client-side apis.guru duplication where redundant) → embedded auth section (`bearer`/`header`/`query` with an inline secret field, or `oauth` with an app+authorization picker that can create the app from a preset and run the authorize dance inline via popup) → one submit. The Bindings tab is repositioned as "Advanced: raw fetch() credentials" and shows only unmanaged rows.

## Changes Required:

#### 1. AddConnectionDialog auth section
**File**: `apps/ui/src/pages/connections/page.tsx` (`AddConnectionDialog` `:638-1331`, replacing the `credentialMode` block `:1178-1312`)
**Changes**: Auth type radio (`none`/`bearer`/`header`/`query`/`oauth`). Inline secret input (password field, never echoed back on edit — server stores write-only under `connection.<slug>.secret`); optional "use existing config key" toggle for shared secrets; `header`/`query` expose name/param inputs; submit sends the step-7 `auth` object in the single upsert call — the separate binding-creation path disappears from this dialog.

#### 2. Inline OAuth sub-flow
**File**: same dialog + a new `apps/ui/src/pages/connections/components/oauth-inline-connect.tsx`
**Changes**: `oauth` type → app picker (existing apps) or "new from preset" (presetId + clientId/clientSecret, redirect URI shown — reuses step-9's dialog internals as a component) → authorization picker listing the app's authorizations, or "Authorize new" (label input → authorize-url → `window.open` popup → poll `GET /api/oauth-apps/{id}/authorizations` until the new label appears → auto-select). Replaces today's free-text provider `Input` + new-tab link (`page.tsx:1252-1284`).

#### 3. Catalog handoff + spec prefill cleanup
**Files**: `apps/ui/src/pages/connections/page.tsx` (`selectCatalogEntry` `:848-882`, `resolveApisGuruOpenApi` `:414-448`, `applySurfacePrefill` `:738-777`), `apps/ui/src/pages/connections/components/catalog-browser.tsx` (`curationBoost` `:72-80`: `feeds:["blessed"]` outranks everything; blessed entries render a badge)
**Changes**: Blessed entries prefill `vendoredSlug` (spec source `vendored`) + `presetId` (auto-suggest the oauth path). Since the server now extracts `servers[]` (step-3), the dialog may leave baseUrl empty for spec-backed connections and display the server-derived value + provenance after upsert; keep the apis.guru client-side fetch only as a preview nicety for non-blessed entries.

#### 4. Bindings tab repositioning
**File**: `apps/ui/src/pages/connections/page.tsx` (bindings tab + `CredentialBindingDialog` `:1333+`)
**Changes**: Tab renamed "Raw fetch credentials", moved last, description clarifying scope; lists only unmanaged bindings (server default from step-7); managed rows visible nowhere in the UI.

### Success Criteria:

#### Automated Verification:
- [ ] `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b`

#### Automated QA:
- [ ] agent-browser walkthrough with API + mock provider + UI dev server: (1) catalog → blessed github entry → auth `bearer` + inline secret → single submit → connection live, playground call succeeds; (2) catalog → blessed gmail entry → oauth path → create app from preset inline → authorize via popup (mock) → authorization auto-selected → submit → connection live; (3) bindings tab shows no managed rows; screenshots at each stage
- [ ] Edit an existing connection: secret field shows placeholder (not the value); changing auth type from bearer to query re-derives correctly (verify via API response)

#### Manual Verification:
- [ ] Taras visual + flow pass on the full single-flow dialog (manual SPA QA per repo convention)

**Implementation Note**: This step is a vertical slice — QA-able on its own. Pause for manual confirmation; commit `[step-10] UI single-flow connection creation` after verification passes.
