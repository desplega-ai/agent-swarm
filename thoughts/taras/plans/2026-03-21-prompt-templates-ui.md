---
date: 2026-03-21
author: Claude
status: completed
tags: [plan, new-ui, prompt-templates, dashboard]
commit_after_phase: true
---

# Plan: Prompt Templates Tab in new-ui Dashboard

## Overview

Add a "Templates" tab under the Communication sidebar group in `new-ui/` that lets users browse, inspect, and edit prompt templates stored in the API server's `prompt_templates` table.

## Current State

- **API exists**: `GET /api/prompt-templates` (list w/ filters: eventType, scope, isDefault), `GET /api/prompt-templates/{id}` (detail + history), `PUT /api/prompt-templates` (upsert), `DELETE /api/prompt-templates/{id}`, `POST /api/prompt-templates/{id}/checkout` (restore version), `POST /api/prompt-templates/{id}/reset` (reset to code default), `POST /api/prompt-templates/preview` (dry-run render), `GET /api/prompt-templates/events` (all registered event definitions w/ variables)
- **DB schema**: `prompt_templates` (id, eventType, scope, scopeId, state, body, isDefault, version, createdBy, createdAt, updatedAt) + `prompt_template_history` (id, templateId, version, body, state, changedBy, changedAt, changeReason)
- **new-ui patterns**: Vite+React 19, react-router-dom v7, @tanstack/react-query, AG Grid for tables, shadcn/ui, ApiClient singleton in `src/api/client.ts`, hooks in `src/api/hooks/`, lazy-loaded pages in `src/app/router.tsx`
- **Already installed**: `@monaco-editor/react` (used in `pages/debug/page.tsx`), `react-markdown` + `remark-gfm` (used in `pages/chat/page.tsx`)

## Desired End State

1. `/templates` — List page with AG Grid: search by eventType substring + filter by scope + filter by isDefault. Columns: eventType, scope, state, version, isDefault badge, updatedAt
2. `/templates/:id` — Detail page with 3 tabs:
   - **Raw** — Monaco Editor (editable for overrides, read-only for defaults; "Customize" button to fork a default into an override)
   - **Rendered** — live preview via POST `/api/prompt-templates/preview` (with sample variables from the event definition), rendered with ReactMarkdown
   - **History** — AG Grid of version history (version, state, changedBy, changedAt, changeReason) with "Checkout" action per row
3. `/templates/:id/history/:version` — Version detail (read-only), 2 tabs: Raw + Rendered
4. Latest version on detail page is **editable** unless `isDefault` is true. Default templates show a "Customize" button that creates an override via upsert.

---

## Phase 1: API Layer + Types + Hooks

Add prompt template types, client methods, and react-query hooks.

### Files to Create

**`new-ui/src/api/hooks/use-prompt-templates.ts`** — react-query hooks:
- `usePromptTemplates(filters?)` — `GET /api/prompt-templates?eventType=&scope=&isDefault=`, select: `(data) => data.templates`
- `usePromptTemplate(id)` — `GET /api/prompt-templates/{id}` → returns `{ template, history }`
- `usePromptTemplateEvents()` — `GET /api/prompt-templates/events` → select: `(data) => data.events`
- `usePreviewTemplate()` — mutation: `POST /api/prompt-templates/preview` → returns `PreviewResponse`
- `useUpsertTemplate()` — mutation: `PUT /api/prompt-templates` → invalidates `["prompt-templates"]` and `["prompt-template"]`
- `useCheckoutTemplate()` — mutation: `POST /api/prompt-templates/{id}/checkout` with body `{ version: number }` → invalidates `["prompt-templates"]` and `["prompt-template", id]`
- `useResetTemplate()` — mutation: `POST /api/prompt-templates/{id}/reset` → invalidates `["prompt-templates"]` and `["prompt-template", id]`
- `useDeleteTemplate()` — mutation: `DELETE /api/prompt-templates/{id}` → invalidates `["prompt-templates"]`

### Files to Modify

**`new-ui/src/api/types.ts`** — Add interfaces:
```typescript
export interface PromptTemplate {
  id: string;
  eventType: string;
  scope: "global" | "agent" | "repo";
  scopeId: string | null;
  state: "enabled" | "default_prompt_fallback" | "skip_event";
  body: string;
  isDefault: boolean;
  version: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PromptTemplateHistory {
  id: string;
  templateId: string;
  version: number;
  body: string;
  state: string;
  changedBy: string | null;
  changedAt: string;
  changeReason: string | null;
}

export interface EventDefinition {
  eventType: string;
  header: string;
  defaultBody: string;
  variables: { name: string; description: string; example?: string }[];
  category: "event" | "system" | "common" | "task_lifecycle" | "session";
}

// Input type for PUT /api/prompt-templates (matches API body schema)
export interface UpsertPromptTemplateInput {
  eventType: string;
  scope?: "global" | "agent" | "repo";
  scopeId?: string;
  state?: "enabled" | "default_prompt_fallback" | "skip_event";
  body: string;
  changedBy?: string;
  changeReason?: string;
}

// Response from POST /api/prompt-templates/preview
export interface PreviewResponse {
  rendered: string;
  unresolved: string[];
}
```

**`new-ui/src/api/client.ts`** — Add methods:
- `fetchPromptTemplates(filters?)` → `GET /api/prompt-templates` → `{ templates: PromptTemplate[] }`
- `fetchPromptTemplate(id)` → `GET /api/prompt-templates/{id}` → `{ template: PromptTemplate, history: PromptTemplateHistory[] }`
- `fetchPromptTemplateEvents()` → `GET /api/prompt-templates/events` → `{ events: EventDefinition[] }`
- `previewPromptTemplate(data: { eventType: string; body?: string; variables?: Record<string, unknown> })` → `POST /api/prompt-templates/preview` → `PreviewResponse`
- `upsertPromptTemplate(data: UpsertPromptTemplateInput)` → `PUT /api/prompt-templates`
- `checkoutPromptTemplate(id: string, version: number)` → `POST /api/prompt-templates/{id}/checkout` with body `{ version }`
- `resetPromptTemplate(id: string)` → `POST /api/prompt-templates/{id}/reset`
- `deletePromptTemplate(id: string)` → `DELETE /api/prompt-templates/{id}`

**`new-ui/src/api/hooks/index.ts`** — Re-export new hooks

### Verification

```bash
cd new-ui && pnpm exec tsc --noEmit
```

---

## Phase 2: List Page (`/templates`)

Only the list page and its route. Detail page routes are deferred to Phase 3 to avoid tsc errors from missing files.

### Files to Create

**`new-ui/src/pages/templates/page.tsx`** — default export, lazy-loaded:
- AG Grid with columns: eventType, scope, scopeId, state (badge), version, isDefault (badge), updatedAt (formatted)
- Search input filtering by eventType substring (client-side quick filter on AG Grid)
- Scope dropdown filter: All / global / agent / repo
- isDefault toggle filter
- Row click → navigate to `/templates/:id`
- Empty state when no templates
- Page icon: `FileText` from lucide

### Files to Modify

**`new-ui/src/app/router.tsx`**:
- Add lazy import for `TemplatesPage` only (detail pages added in Phase 3)
- Add route: `{ path: "templates", element: <TemplatesPage /> }`

**`new-ui/src/components/layout/app-sidebar.tsx`**:
- Add `FileText` to lucide imports
- Add `{ title: "Templates", path: "/templates", icon: FileText }` to the "Communication" nav group

### Verification

```bash
cd new-ui && pnpm exec tsc --noEmit && pnpm build
```

**Manual**: Open `/templates`, verify grid loads with data, search filters work, row click navigates (will 404 until Phase 3).

---

## Phase 3: Detail Page (`/templates/:id`)

### Files to Create

**`new-ui/src/pages/templates/[id]/page.tsx`** — default export:
- Header: eventType as title, scope/state/version badges, isDefault badge, Delete button (non-default only, with AlertDialog confirmation)
- 3 tabs (shadcn Tabs): **Raw**, **Rendered**, **History**
- **Raw tab** — uses **Monaco Editor** (`@monaco-editor/react`, pattern from `pages/debug/page.tsx`):
  - If `!isDefault`: Monaco in editable mode (`language="markdown"`, theme from `useTheme()`) with:
    - **State dropdown** (Select): enabled / default_prompt_fallback / skip_event
    - **Save** button → calls `useUpsertTemplate` with `UpsertPromptTemplateInput`
    - **Reset** button → calls `useResetTemplate` (with AlertDialog confirmation)
  - If `isDefault`: Monaco in read-only mode (`options={{ readOnly: true }}`), "Default" badge, and a **"Customize"** button that:
    - Copies the default body into an upsert call with `isDefault: false` (the API creates an override implicitly)
    - After success, the page reloads showing the new editable override
  - Monaco height: use `flex-1 min-h-0` container with explicit `height="100%"` on the Editor component
- **Rendered tab** — uses **ReactMarkdown** (`react-markdown` + `remark-gfm`):
  - On mount + on body change (debounced 500ms), calls `usePreviewTemplate` mutation
  - Constructs sample variables from event definition: `usePromptTemplateEvents()` → find matching eventType → build `{ [v.name]: v.example ?? v.name }` for each variable
  - If no event definition found for the eventType, renders preview with empty variables (still works, just shows unresolved placeholders)
  - Shows rendered output via `<ReactMarkdown remarkPlugins={[remarkGfm]}>{rendered}</ReactMarkdown>` in a styled prose container
  - Shows unresolved variables (if any) as amber badges below
  - "Variables" collapsible section showing event definition variables (name, description, example)
- **History tab**:
  - AG Grid: version, state (badge), changedBy, changedAt (formatted), changeReason
  - "Checkout" button per row → calls `useCheckoutTemplate(id, version)`, confirms via AlertDialog
  - Row click → navigate to `/templates/:id/history/:version` (read-only detail)

**`new-ui/src/pages/templates/[id]/history/[version]/page.tsx`** — read-only version detail:
- Shows version number + changedAt + changedBy + changeReason in header
- 2 tabs: Raw (Monaco read-only) + Rendered (ReactMarkdown preview with sample vars)
- Back link to parent template detail

### Files to Modify

**`new-ui/src/app/router.tsx`**:
- Add lazy imports for `TemplateDetailPage` and `TemplateVersionDetailPage`
- Add routes: `{ path: "templates/:id", element: <TemplateDetailPage /> }` and `{ path: "templates/:id/history/:version", element: <TemplateVersionDetailPage /> }`

**`new-ui/src/components/layout/breadcrumbs.tsx`**:
- Add `templates: "Templates"` to the `routeLabels` map
- Add `history: "History"` to handle the version detail breadcrumb segment

### Verification

```bash
cd new-ui && pnpm exec tsc --noEmit && pnpm build
```

**Manual**:
- Open `/templates/:id` for a non-default template → verify Monaco is editable, state dropdown works, save works
- Open `/templates/:id` for a default template → verify Monaco is read-only, "Customize" button appears
- Click "Customize" on a default → verify override is created and page becomes editable
- Check rendered tab shows preview with ReactMarkdown
- Check history tab loads versions in AG Grid
- Click checkout on an older version → verify body reverts
- Navigate to `/templates/:id/history/:version` → verify read-only Raw + Rendered tabs
- Test error case: navigate to `/templates/bogus-id` → verify graceful error state (not blank page)

---

## Phase 4: Polish + Edge Cases

### Files to Modify

**`new-ui/src/pages/templates/page.tsx`**:
- Add loading skeleton (use `PageSkeleton` pattern from other pages) when `isLoading` is true
- Add error state when query fails

**`new-ui/src/pages/templates/[id]/page.tsx`**:
- Add loading skeleton for detail page
- Add error state for 404 (template not found)
- Toast notifications via `sonner` on save/checkout/reset/delete success and failure
- Keyboard shortcut: `Cmd+S` / `Ctrl+S` to save when Monaco is focused (non-default only), with `e.preventDefault()` to block browser save dialog
- Debounced preview: already described in Phase 3, ensure 500ms debounce on body changes

**`new-ui/src/pages/templates/[id]/history/[version]/page.tsx`**:
- Add loading skeleton
- Add error state for invalid version

### Verification

```bash
cd new-ui && pnpm lint && pnpm exec tsc --noEmit && pnpm build
```

---

## Post-Implementation Fixes

### Fix 1: Use `/render` endpoint instead of `/preview` for Rendered tab
The `/preview` endpoint only interpolates `{{variable}}` syntax. Template composition references (`{{@template[...]}}`) were stripped to empty strings, leaving the Rendered tab blank for composed templates. Switched to `/render` which does full scope-aware resolution including recursive `@template[...]` expansion. Added `RenderResponse` type, `renderPromptTemplate` client method, and `useRenderTemplate` hook.

### Fix 2: Customize navigates to new template ID
After clicking "Customize" on a default template, the upsert creates a new override with a different ID. The page now navigates to the new override's ID so Monaco switches to editable mode.

### Fix 3: Reset button disabled when no changes
The Reset button is now disabled when `body` and `state` match the saved template values, preventing unnecessary confirmation dialogs.

### Fix 4: Use `prose-chat` for markdown rendering
The project uses a custom `prose-chat` CSS class (in `globals.css`) — not `@tailwindcss/typography`. The `prose prose-sm dark:prose-invert` classes were non-functional. Replaced with `prose-chat` on both the detail page and version detail page for proper heading, code, list, table, and blockquote styling.

---

## Manual E2E Verification

> **Port check first**: Run `lsof -i :3013` and `lsof -i :5274` to verify ports are free. If occupied by another worktree, adjust ports in `.env`.

```bash
# 1. Start API server (root)
bun run start:http &
API_PID=$!

# 2. Start UI dev server
cd new-ui && pnpm dev &
UI_PID=$!
cd ..

# 3. Seed some templates if DB is fresh
# (templates get auto-seeded on server startup from code-defined event definitions)

# 4. Test list page
# Open http://localhost:5274/templates
# → Verify AG Grid shows templates
# → Type in search box → filters by eventType
# → Change scope dropdown → filters
# → Toggle isDefault filter
# → Click a row → navigates to detail

# 5. Test detail page (non-default override)
# Create one via API:
curl -X PUT http://localhost:3013/api/prompt-templates \
  -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{"eventType":"github.push","scope":"global","body":"Custom: {{branch}}"}'
# → Open its detail page
# → Raw tab: verify Monaco is editable
# → Change state dropdown to "skip_event" → Save → verify toast + state updates
# → Edit body, click Save → verify toast + version bumps
# → Rendered tab: verify ReactMarkdown preview renders
# → History tab: verify multiple versions appear in AG Grid
# → Click Checkout on an older version → confirm dialog → verify body reverts
# → Click Reset → confirm dialog → verify body returns to code default

# 6. Test detail page (default template)
# → Open a template where isDefault=true
# → Raw tab: verify Monaco is read-only
# → Verify "Default" badge shown
# → Click "Customize" → verify override created, page becomes editable

# 7. Test version detail page
# → From history tab, click a row
# → Verify /templates/:id/history/:version loads
# → Verify Raw (Monaco read-only) + Rendered (ReactMarkdown) tabs work
# → Click back → returns to parent detail

# 8. Test error states
# → Navigate to /templates/bogus-id → verify error state shown
# → Navigate to /templates/:id/history/999 → verify error state shown

# 9. Verify sidebar
# → "Templates" appears under Communication section
# → Active state highlights correctly on /templates and /templates/:id

# 10. Verify breadcrumbs
# → On /templates → shows "Templates"
# → On /templates/:id → shows "Templates > {eventType}"
# → On /templates/:id/history/:version → shows "Templates > {eventType} > History > v{version}"

# 11. Build check
cd new-ui && pnpm build
# → No errors

# 12. Cleanup
kill $UI_PID $API_PID 2>/dev/null
```
