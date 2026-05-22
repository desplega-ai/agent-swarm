---
date: 2026-05-22T00:00:00Z
topic: "Sidebar Trim & Cleanup — Implementation Plan"
author: taras
tags: [plan, ui, navigation, sidebar, ia]
status: completed
related_brainstorm: thoughts/taras/brainstorms/2026-05-21-sidebar-trim-cleanup.md
last_updated: 2026-05-22
last_updated_by: claude (phase-running, phase 6)
---

# Sidebar Trim & Cleanup — Implementation Plan

## Overview

Trim the Agent Swarm dashboard sidebar from **21 items / 5 groups** to **13 items / 3 groups**
(WORK / SWARM / RESOURCES), unify Home + Dashboard into one minimal full-bleed page, move the
5 admin destinations into a `/settings` shell reached from an avatar account menu, merge
Usage + Budgets into one tabbed page, and add a backward-compat redirect table so no old URL
404s.

- **Motivation**: The sidebar grew organically to 21 items across 5 ad-hoc groups; the IA no
  longer fits product direction (RBAC, humans-as-users, client-side MCP). Full IA rethink per
  the brainstorm.
- **Scope**: **One PR**, implemented in 6 sequential commit-checkpoint phases.
- **Related**: `thoughts/taras/brainstorms/2026-05-21-sidebar-trim-cleanup.md`,
  `ui/src/components/layout/app-sidebar.tsx`, `ui/src/app/router.tsx`

## Current State Analysis

All paths below are under `ui/`.

**Sidebar** — `src/components/layout/app-sidebar.tsx`
- `navGroups` is a module constant at `app-sidebar.tsx:51-98`, typed `{ label: string; items: NavItem[] }[]`.
  Current groups: Core (6), AI (3), Operations (5), Configuration (4), System (3) = 21 items.
- `NavItem` interface — `app-sidebar.tsx:43-49`: `{ title; path; icon: typeof Home; gate?: { minVersion } }`.
- Feature gating: `useFeatureGate` (`src/api/hooks/use-feature-gate.ts:20-33`) + `useApiVersion`
  (`src/api/hooks/use-stats.ts:29-39`). A gated-out item is dropped (`return null`,
  `app-sidebar.tsx:168,195`). Gates: Sessions `1.76.0`, Pages `1.79.0`, People `1.80.0`.
- `homeAvailable = status !== null` (`app-sidebar.tsx:113`) hides the Home item, re-points the
  logo to `/dashboard` (`:122`), and filters the `path === "/"` item (`:151`) when `GET /status`
  404s (older API servers).
- Icons: `lucide-react`, named imports (`app-sidebar.tsx:1-23`).

**CollapsibleSection** — `src/components/shared/collapsible-section.tsx:11-79`
- Props include `defaultOpen?: boolean` (default `false`). State is local `useState(defaultOpen)`
  (`:34`). **No persistence of any kind** — resets on remount.
- The shadcn `Sidebar` primitive persists only its own collapsed state, via a **cookie**
  (`src/components/ui/sidebar.tsx:22,80`), unrelated to per-group state.

**Router** — `src/app/router.tsx`
- React Router v7 data-router (`createBrowserRouter`), single central config (`router.tsx:47-95`),
  all pages lazy-loaded children of one `/` → `<RootLayout/>` route.
- Redirects today use the `<Navigate>` component (`config-guard.tsx:19-24`, `home/page.tsx:161`).
  No loaders are used anywhere. `<Navigate to="/x?tab=y">` accepts a path+query string directly.
- `/integrations/slack` has no literal route — it matches the dynamic `integrations/:id`
  (`router.tsx:74` → `IntegrationDetailPage`).

**Home / Dashboard / AgentCanvas**
- `/` index → `HomePage` (`src/pages/home/page.tsx`): WelcomeCard, NewSessionShortcut, Activity
  tiles, `SetupChecklist`, `FirstStepsCard`, Storage card — all `/status`-derived. Redirects to
  `/dashboard` when `/status` 404s/errors (`home/page.tsx:160-162`).
- `/dashboard` → `DashboardPage` (`src/pages/dashboard/page.tsx`): feature-gated `1.76.0`;
  renders `NewDashboard` (Canvas/Table toggle + `AgentCanvas` + `InboxPanel`) or `LegacyDashboard`.
- `AgentCanvas` (`src/components/dashboard/agent-canvas.tsx:132-175`): outer container hard-coded
  `h-[clamp(280px,38vh,460px)] rounded-lg border bg-card` (`:140,:156`). Props: `{ rows, className? }`.
- Current user name: `useCurrentUser().user?.name` (`src/contexts/current-user-context.tsx:166`).
- App shell `<main>` has hard-coded `p-4 md:p-6` (`src/components/layout/root-layout.tsx:22`).

**Usage / Budgets / Header**
- `/usage` → `UsagePage` (`src/pages/usage/page.tsx`), `/budgets` → `BudgetsPage`
  (`src/pages/budgets/page.tsx`). Both roots: `flex-1 min-h-0 overflow-y-auto space-y-{5,6}`.
  Neither uses `?tab=` internally.
- Tabs primitive: `src/components/ui/tabs.tsx` (shadcn/Radix, `variant: "default"|"line"`).
- DropdownMenu primitive: `src/components/ui/dropdown-menu.tsx`. Avatar primitive exists
  (`src/components/ui/avatar.tsx`) but is unused by the header.
- Header `AppHeader` (`src/components/layout/app-header.tsx:28-137`): right-side `div` at
  `:48-137` holds health badge, `<UserSwitcher/>` (`:94`), GitHub link, theme toggle.
  `UserSwitcher` (`src/components/identity/user-switcher.tsx`) is a `DropdownMenu` with an
  initials-circle trigger; contents = "Acting as" user list + "Create new user" + "Clear identity".
- **No `/settings` route exists.**

**The 5 settings-destined pages** (each renders its own `<PageHeader>`)
- `ConfigPage` (`src/pages/config/page.tsx`, 53 lines): root `flex flex-col flex-1 min-h-0 gap-6`;
  `<PageHeader title="Settings"/>`; **owns `?tab=` already** (values `connections`, `secrets`).
- `ApiKeysPage` (`src/pages/api-keys/page.tsx`): root `flex flex-col flex-1 min-h-0 gap-4`;
  `<PageHeader title="API Keys"/>`; no tabs.
- `IntegrationsPage` (`src/pages/integrations/page.tsx`): root `flex-1 min-h-0 overflow-y-auto
  space-y-6 p-2` (self-padded + self-scroll); `<PageHeader title="Integrations"/>`.
- `IntegrationDetailPage` (`src/pages/integrations/[id]/page.tsx`): root `flex-1 min-h-0
  overflow-y-auto space-y-6 p-2`; "← All integrations" back button → `/integrations`.
- `ReposPage` (`src/pages/repos/page.tsx`): root `flex flex-col flex-1 min-h-0 gap-4`;
  `<PageHeader title="Repos"/>`.
- `DebugPage` (`src/pages/debug/page.tsx`): root `flex flex-col flex-1 min-h-0 gap-0`;
  `<PageHeader icon={Bug} title="Debug — Database Explorer"/>`.

## Desired End State

- Sidebar = 13 items in 3 collapsible groups (WORK / SWARM / RESOURCES); each group's open/closed
  state persists per-group in `localStorage`.
- `NavItem` carries an optional declarative `minRole` field (unused until RBAC).
- `/` is a new minimal unified Home: a welcome `<h1>` (with user name when available) above a
  full-bleed `AgentCanvas`. Old Home/Dashboard preserved verbatim at `/old-home` / `/old-dashboard`.
- `/settings` is a shell with a left-rail sub-nav hosting Config, API Keys, Integrations, Repos,
  Debug as **nested routes** (`/settings/config`, `/settings/integrations/:id`, …).
- `/usage` is a tabbed page (Usage tab + Budgets tab) driven by `?tab=`.
- The header avatar menu exposes two new destinations: **Settings** (`/settings`) and **Usage**
  (`/usage`).
- Every moved old URL (`/dashboard`, `/budgets`, `/config`, `/keys`, `/integrations`,
  `/integrations/:id`, `/repos`, `/debug`) redirects — no 404s.

## What We're NOT Doing

- **Not building RBAC.** `minRole` is a declarative type field only — no role resolution, no
  conditional rendering. Every item stays visible to everyone.
- **Not redesigning the 5 settings pages' internals** — only relocating them into the `/settings`
  shell (plus minimal root-class normalization).
- **Not re-homing the onboarding `SetupChecklist`** — it stays on `/old-home`.
- **Not migrating the old Dashboard `InboxPanel` (action-items) into the Approvals page.** The
  brainstorm noted Approvals could "absorb" it as an *insight*, not a requirement — that re-homing
  is a separate effort. `InboxPanel` stays on `/old-dashboard`; Approvals is unchanged here.
- **Not touching `/chat`** — legacy/backward-compat, already absent from the new nav.
- **Not changing the feature-gate logic** for Sessions / Pages / People.
- **Not redesigning `AgentCanvas` internals** (dagre layout, nodes) — only adding a full-bleed variant.
- **Not building the future "Settings vs Usage vs Resources" top-level split** beyond the avatar
  menu's two entries.
- **Not deleting** the old Home/Dashboard implementations or the 5 settings page components.

## Implementation Approach

- **One PR, 6 sequential commit-checkpoint phases, implemented autopilot end-to-end.** Each phase
  is independently verifiable; on passing its Automated Verification + Automated QA a commit is
  made and implementation continues straight to the next phase **without pausing**. Manual QA is
  a single joint pass with Taras after Phase 6 — no per-phase manual gates, no separate QA doc.
  The per-phase `#### Manual Verification:` items are collected and run together in that final pass.
- **Phase ordering avoids intermediate 404s/regressions**: the redirect table is the *last* phase,
  so every redirect target (`/` unified Home, tabbed `/usage`, `/settings/*`) already exists when
  redirects are introduced.
- **Reuse existing primitives** — shadcn `Tabs`, `DropdownMenu`, `CollapsibleSection`, React
  Router `NavLink`/`Navigate`. No new dependencies.
- **`/settings` uses path-based nested routes**, *not* `?tab=` — because `ConfigPage` already
  binds `?tab=` to its own internal tabs; a shared `tab` key would collide. (The brainstorm's
  `/settings?tab=config` suggestion is superseded for this reason; brainstorm explicitly left
  sub-nav style to implementation.)
- **Old Home/Dashboard preserved verbatim** at `/old-home` / `/old-dashboard`; the new unified
  Home is a brand-new component, leaving the old files untouched.
- **The `/status` gate on Home is dropped** — the new Home renders no `/status`-derived content.
  The implicit `1.76.0` shield that `AgentCanvas` enjoyed via `NewDashboard` is **re-applied
  explicitly** on the new Home so older API servers degrade gracefully.

## Quick Verification Reference

Run from `ui/`:
- Lint: `cd ui && pnpm lint`
- Type-check (CI parity): `cd ui && pnpm exec tsc -b`
- Build: `cd ui && pnpm build`
- Dev server for QA: `cd ui && pnpm dev` → `http://localhost:5274`

---

## Phase 1: navGroups rewrite + collapse persistence + minRole

### Overview

The sidebar renders 13 items in 3 groups (WORK / SWARM / RESOURCES), each group's collapsed
state survives reload via `localStorage`, and `NavItem` gains a declarative `minRole` field.

### Changes Required:

#### 1. NavItem type + navGroups rewrite
**File**: `ui/src/components/layout/app-sidebar.tsx`
**Changes**:
- Extend the `NavItem` interface (`:43-49`) with `minRole?: <RoleType>` — import the role type
  from `ui/src/api/types.ts` (`User.role`). If `role` is a bare `string`, introduce a small
  `UserRole` union there from the observed values and use it. Field is optional and **unused by
  render logic** — purely declarative for future RBAC. Document this with a code comment.
- Replace the `navGroups` constant (`:51-98`) with 3 groups / 13 items:
  - **WORK**: Home `/` (`Home`), Tasks `/tasks` (`ListTodo`), Sessions `/sessions`
    (`MessageSquare`, `gate: 1.76.0`), Approvals `/approval-requests` (`ClipboardCheck`).
  - **SWARM**: Agents `/agents` (`Users`), People `/people` (`Contact`, `gate: 1.80.0`),
    Workflows `/workflows` (`Workflow`), Schedules `/schedules` (`Clock`).
  - **RESOURCES**: Skills `/skills` (`BookOpen`), MCP Servers `/mcp-servers` (`Cable`),
    Memory `/memory` (`Brain`), Pages `/pages` (`Globe`, `gate: 1.79.0`), Templates
    `/templates` (`FileText`).
- Give each group a stable `id` (`work` / `swarm` / `resources`) for the persistence key.
- Remove now-unused icon imports (`LayoutDashboard`, `BarChart3`, `Wallet`, `Plug`,
  `GitBranch`, `Settings`, `Key`, `Bug`).
- Keep the existing `useFeatureGate`/`isGated` machinery unchanged (Sessions/People/Pages gates).
- Leave the `homeAvailable` logic (`:102,113,122,151`) **untouched** in this phase — it is
  removed in Phase 2 alongside Home unification.
- Pass a `persistKey` prop to each group's `CollapsibleSection` (see change #2).

#### 2. localStorage-backed collapse persistence
**File**: `ui/src/components/shared/collapsible-section.tsx`
**Changes**:
- Add an optional `persistKey?: string` prop.
- When `persistKey` is set, lazily initialize `open` from `localStorage.getItem(persistKey)`
  (falling back to `defaultOpen` when absent/unparseable), via a `useState` lazy initializer.
- On every toggle, write the new state to `localStorage` under `persistKey`.
- Guard `localStorage` access in `try/catch` (private-mode / quota safety).
- When `persistKey` is absent, behavior is unchanged (pure `defaultOpen` local state).
- Sidebar passes keys `agent-swarm:sidebar-group:work` / `:swarm` / `:resources`.

### Success Criteria:

#### Automated Verification:
- [x] Type-check passes: `cd ui && pnpm exec tsc -b`
- [x] Lint passes: `cd ui && pnpm lint`
- [x] Build passes: `cd ui && pnpm build`

#### Automated QA:
*(Agent drives `http://localhost:5274` with the browser-use skill.)*
- [x] Sidebar shows exactly 3 group headers (WORK, SWARM, RESOURCES) and 13 items total (against
      a current API server — items behind unmet version gates are still dropped).
- [x] Config / API Keys / Integrations / Repos / Debug / Dashboard / Usage / Budgets are **absent**
      from the sidebar.
- [x] Collapsing the SWARM group, then reloading the page, leaves SWARM still collapsed
      (verify `localStorage` key `agent-swarm:sidebar-group:swarm` is written).
- [x] Each of the 13 items navigates to a non-404 route.

#### Manual Verification:
- [ ] Group ordering and labels read correctly; icon choices look right.

**Implementation Note**: Run Automated Verification + Automated QA; on pass, commit
`[phase 1] sidebar: 13-item / 3-group navGroups + collapse persistence + minRole` and continue to
the next phase without pausing (autopilot).

---

## Phase 2: Unified bare Home + /old-home & /old-dashboard

### Overview

`/` renders a new minimal Home (welcome `<h1>` + full-bleed `AgentCanvas`); the old Home and
Dashboard implementations are preserved verbatim at `/old-home` and `/old-dashboard`.

### Changes Required:

#### 1. New unified Home component
**File**: `ui/src/pages/home/unified-home.tsx` (new)
**Changes**:
- Export `UnifiedHome`. Layout: `UnifiedHome` root is `flex flex-col flex-1 min-h-0`; a
  `shrink-0` welcome header (carrying its own `px`/`pt` padding) with `<h1>` — "Welcome back,
  {user.name}" when `useCurrentUser().user?.name` is available, else a neutral "Welcome to
  Agent Swarm" — and below it a `flex-1 min-h-0` region rendering `<AgentCanvas fullBleed/>`.
  The `min-h-0` links are load-bearing: `AgentCanvas`'s `fullBleed` `h-full` and the inner
  ReactFlow need a definite-height parent or the canvas collapses to 0.
- Feed `AgentCanvas` from `useAgentActivity({ windowHours: 24 })` (same hook the old Dashboard
  used). Handle that hook's own `isLoading` / `isError` / `truncated` flags — at minimum a
  loading placeholder and a graceful error state (the truncation notice is optional on the
  minimal Home).
- Wrap the canvas in `useFeatureGate("1.76.0")`. **Note `supported` is `false` while the version
  query is still pending** — gate on the *resolved* state: render a skeleton/placeholder while
  `currentVersion` is `undefined`, the canvas when supported, and a small inline notice
  ("Agent activity view requires Agent Swarm API 1.76+") only on a *confirmed*-unsupported
  version. This re-applies the shield the canvas had implicitly via `NewDashboard` without
  flashing the notice on every load.
- No `/status` dependency, no `SetupChecklist`, no redirect-to-dashboard fallback.

#### 2. AgentCanvas full-bleed variant
**File**: `ui/src/components/dashboard/agent-canvas.tsx`
**Changes**:
- Add `fullBleed?: boolean` to `AgentCanvasProps` (`:34-37`).
- In both the empty-state container (`:140`) and the main container (`:156`), select classes:
  `fullBleed ? "h-full" : "h-[clamp(280px,38vh,460px)] rounded-lg border bg-card"` — then append
  `className`. Full-bleed = fills parent height, no border/radius/card-bg.

#### 3. Conditional shell padding
**File**: `ui/src/components/layout/root-layout.tsx`
**Changes**:
- Read `useLocation()`; the `<main>` (`:22`) padding becomes conditional:
  `pathname === "/" ? "p-0" : "p-4 md:p-6"`. The unified Home owns its own internal padding for
  the welcome header so the canvas can reach the content-area edges.

#### 4. Remove the /status Home gate from the sidebar
**File**: `ui/src/components/layout/app-sidebar.tsx`
**Changes**:
- Remove `useStatusContext()` usage (`:102`), the `homeAvailable` const (`:113`), the
  conditional logo target (`:122` → always `/`), and the `path === "/"` filter (`:151`). Home is
  now an unconditional nav item.

#### 5. Routing: new index + preserved old routes
**File**: `ui/src/app/router.tsx`
**Changes**:
- Point the `index` route at `UnifiedHome` (lazy import the new component).
- Add `{ path: "old-home", element: <HomePage/> }` and
  `{ path: "old-dashboard", element: <DashboardPage/> }` reusing the existing lazy imports.
- Leave `/dashboard` → `DashboardPage` in place (it becomes a redirect in Phase 6).
- `/old-home` and `/old-dashboard` are intentionally **not** in the sidebar and **not** redirected.

### Success Criteria:

#### Automated Verification:
- [x] Type-check passes: `cd ui && pnpm exec tsc -b`
- [x] Lint passes: `cd ui && pnpm lint`
- [x] Build passes: `cd ui && pnpm build`

#### Automated QA:
*(Agent drives `http://localhost:5274` with the browser-use skill.)*
- [x] `/` shows the welcome `<h1>` and a full-bleed `AgentCanvas` reaching the content-area edges
      (no card border, no 24px gutter around the canvas).
- [x] `/old-home` renders the original Home (WelcomeCard + SetupChecklist + …).
- [x] `/old-dashboard` renders the original Dashboard (Canvas/Table toggle + InboxPanel).
- [x] The Home sidebar item is present and links to `/`.
- [x] Non-Home routes still show the standard `p-4 md:p-6` content padding.

#### Manual Verification:
- [ ] Welcome copy reads naturally with and without a current-user name.
- [ ] Full-bleed canvas looks intentional (not visually clipped/awkward) at narrow and wide widths.

**Implementation Note**: Run Automated Verification + Automated QA; on pass, commit
`[phase 2] home: unified full-bleed Home + /old-home & /old-dashboard` and continue to the next
phase without pausing (autopilot).

---

## Phase 3: /settings shell hosting Config / API Keys / Integrations / Repos / Debug

### Overview

A new `/settings` route renders a left-rail shell whose nested routes host the 5 admin pages
(`/settings/config`, `/settings/api-keys`, `/settings/integrations`, `/settings/integrations/:id`,
`/settings/repos`, `/settings/debug`).

### Changes Required:

#### 1. Settings shell layout
**File**: `ui/src/pages/settings/settings-layout.tsx` (new)
**Changes**:
- Export `SettingsLayout`: a two-column layout — a left rail of `NavLink`s (Config, API Keys,
  Integrations, Repos, Debug, each with a lucide icon, active-state styling) and a content area
  rendering `<Outlet/>`. The content area owns the scroll container (`overflow-y-auto`).
- The shell renders **no `<PageHeader>` of its own** — each embedded page keeps its own header
  as the section title.
- Responsive: below the `md` breakpoint the left rail must not crowd the content — collapse it
  to a horizontal scroll strip (or a `Select`) above the content area, consistent with how the
  rest of the app handles narrow viewports.

#### 2. Nested settings routes
**File**: `ui/src/app/router.tsx`
**Changes**:
- Add a `{ path: "settings", element: <SettingsLayout/>, children: [...] }` route with children:
  `{ index: true, element: <Navigate to="/settings/config" replace/> }`,
  `config` → `ConfigPage`, `api-keys` → `ApiKeysPage`, `integrations` → `IntegrationsPage`,
  `integrations/:id` → `IntegrationDetailPage`, `repos` → `ReposPage`, `debug` → `DebugPage`
  (reuse existing lazy imports).
- Leave the old top-level `/config`, `/keys`, `/integrations`, `/integrations/:id`, `/repos`,
  `/debug` routes in place — they become redirects in Phase 6.

#### 3. Page normalization for embedding
**Files**: `ui/src/pages/config/page.tsx`, `ui/src/pages/integrations/page.tsx`,
`ui/src/pages/integrations/[id]/page.tsx`
**Changes**:
- `ConfigPage`: rename its `<PageHeader title="Settings"/>` (`:37`) to `title="Config"` so the
  shell doesn't read "Settings" twice. (`ConfigPage`'s own `?tab=connections|secrets` is left
  intact — path-based shell routing means no collision.)
- `IntegrationsPage` and `IntegrationDetailPage`: change the root container from
  `flex-1 min-h-0 overflow-y-auto space-y-6 p-2` to the no-padding / no-self-scroll pattern
  `flex flex-col flex-1 min-h-0 gap-6` (matching the other four pages) so the shell owns padding
  and scroll — avoids double padding + nested scrollbars.
- `IntegrationDetailPage`: update the "← All integrations" back button target from
  `/integrations` to `/settings/integrations`.

### Success Criteria:

#### Automated Verification:
- [x] Type-check passes: `cd ui && pnpm exec tsc -b`
- [x] Lint passes: `cd ui && pnpm lint`
- [x] Build passes: `cd ui && pnpm build`

#### Automated QA:
*(Agent drives `http://localhost:5274` with the browser-use skill.)*
- [x] `/settings` redirects to `/settings/config` and shows the left-rail shell.
- [x] Each rail entry navigates to `/settings/config|api-keys|integrations|repos|debug` and
      renders the corresponding page with **no doubled header**.
- [x] `/settings/integrations/slack` (deep link) resolves to the Slack integration detail page.
- [x] The Integrations detail "← All integrations" button returns to `/settings/integrations`.
- [x] `ConfigPage`'s internal Connections/Secrets tabs still work inside the shell.

#### Manual Verification:
- [ ] Left-rail active-state and spacing look correct; no nested scrollbar artifacts on the
      Integrations pages.

**Implementation Note**: Run Automated Verification + Automated QA; on pass, commit
`[phase 3] settings: /settings shell hosting the 5 admin pages` and continue to the next phase
without pausing (autopilot).

---

## Phase 4: Usage + Budgets tabbed merge

### Overview

`/usage` becomes a single tabbed page with a Usage tab and a Budgets tab, driven by `?tab=`.

### Changes Required:

#### 1. Extract the current Usage body
**File**: `ui/src/pages/usage/usage-content.tsx` (new)
**Changes**:
- Move the current `UsagePage` body (`pages/usage/page.tsx`) into `UsageContent` — unchanged
  internals (PageHeader, filters, `UsageSummary`, Cost-by-Agent block). Its existing
  `flex-1 min-h-0 overflow-y-auto space-y-5` root is kept; it drops cleanly into a `TabsContent`.

#### 2. New tabbed Usage page
**File**: `ui/src/pages/usage/page.tsx` (rewritten)
**Changes**:
- `UsagePage` renders `<Tabs>` (`TabsList variant="line"`) with triggers "Usage" and "Budgets".
- Active tab is bound to the `?tab=` search param via `useSearchParams` (`tab=budgets` selects
  Budgets; absent/anything-else selects Usage), written with `{ replace: true }`.
- `TabsContent` bodies: `<UsageContent/>` and `<BudgetsPage/>` (import the existing
  `BudgetsPage` component as-is — its `flex-1 min-h-0 overflow-y-auto space-y-6` root drops in).
- Leave `pages/budgets/page.tsx` in place (still the `/budgets` route until Phase 6).

### Success Criteria:

#### Automated Verification:
- [x] Type-check passes: `cd ui && pnpm exec tsc -b`
- [x] Lint passes: `cd ui && pnpm lint`
- [x] Build passes: `cd ui && pnpm build`

#### Automated QA:
*(Agent drives `http://localhost:5274` with the browser-use skill.)*
- [x] `/usage` shows two tabs (Usage, Budgets); Usage tab is active by default.
- [x] Clicking the Budgets tab updates the URL to `/usage?tab=budgets` and renders the budgets
      content (global budget, per-agent budgets, refusals, pricing, audit feed).
- [x] Loading `/usage?tab=budgets` directly opens on the Budgets tab.
- [x] Both tabs' data loads without console errors.

#### Manual Verification:
- [ ] Tab content scrolls independently and looks correct (no clipped sections).

**Implementation Note**: Run Automated Verification + Automated QA; on pass, commit
`[phase 4] usage: merge Usage + Budgets into one tabbed page` and continue to the next phase
without pausing (autopilot).

---

## Phase 5: Avatar account menu (Settings + Usage entries)

### Overview

The header avatar dropdown gains two navigation entries — **Settings** (`/settings`) and
**Usage** (`/usage`) — alongside the existing identity-switcher contents.

### Changes Required:

#### 1. Extend the avatar dropdown
**File**: `ui/src/components/identity/user-switcher.tsx`
**Changes**:
- Add a `DropdownMenuGroup` with two `DropdownMenuItem`s near the top of the dropdown content
  (`:100-137`): **Settings** (lucide `Settings` icon, `onSelect` → `navigate("/settings")`) and
  **Usage** (lucide `BarChart3` icon, `onSelect` → `navigate("/usage")`), followed by a
  `DropdownMenuSeparator` before the existing "Acting as" identity section.
- Use `useNavigate` from `react-router-dom` (add the import).
- The existing identity-switching contents (user list, "Create new user", "Clear identity") are
  unchanged. Rationale: the avatar = the account; one dropdown carries both account navigation
  and identity switching rather than introducing a second header avatar.

### Success Criteria:

#### Automated Verification:
- [x] Type-check passes: `cd ui && pnpm exec tsc -b`
- [x] Lint passes: `cd ui && pnpm lint`
- [x] Build passes: `cd ui && pnpm build`

#### Automated QA:
*(Agent drives `http://localhost:5274` with the browser-use skill.)*
- [x] Opening the header avatar dropdown shows "Settings" and "Usage" entries plus the existing
      identity-switcher items.
- [x] Clicking "Settings" navigates to `/settings` (→ `/settings/config`).
- [x] Clicking "Usage" navigates to `/usage`.
- [x] Identity switching still works (the new entries didn't break the existing menu).

#### Manual Verification:
- [ ] Dropdown grouping/separator reads cleanly; entries are visually distinct from the identity list.

**Implementation Note**: Run Automated Verification + Automated QA; on pass, commit
`[phase 5] header: avatar account menu with Settings + Usage entries` and continue to the next
phase without pausing (autopilot).

---

## Phase 6: Router backward-compat redirect table

### Overview

A centralized redirect table converts every moved old URL to its new location — no 404s — and
the old standalone routes are replaced by `<Navigate>` redirects.

### Changes Required:

#### 1. Param-aware redirect helper
**File**: `ui/src/app/route-redirect.tsx` (new)
**Changes**:
- Export a tiny `RouteRedirect` component that reads `useParams()` and renders
  `<Navigate replace to={...}/>` — used for the deep-link case `/integrations/:id` →
  `/settings/integrations/:id` (preserving the trailing segment, including `/integrations/slack`).

#### 2. Redirect table in the router
**File**: `ui/src/app/router.tsx`
**Changes**:
- Replace the old standalone route entries with redirects:
  - `/dashboard` → `<Navigate to="/" replace/>`
  - `/budgets` → `<Navigate to="/usage?tab=budgets" replace/>`
  - `/config` → `<Navigate to="/settings/config" replace/>`
  - `/keys` → `<Navigate to="/settings/api-keys" replace/>`
  - `/integrations` → `<Navigate to="/settings/integrations" replace/>`
  - `/integrations/:id` → `<RouteRedirect to={id => `/settings/integrations/${id}`}/>`
  - `/repos` → `<Navigate to="/settings/repos" replace/>`
  - `/debug` → `<Navigate to="/settings/debug" replace/>`
- Express the simple (non-param) redirects as a `REDIRECTS` record mapped into route objects, so
  the table is one readable block.
- `/old-home`, `/old-dashboard`, `/usage`, `/templates`, `/chat` are **not** redirected.
- The page components (`ConfigPage`, `ApiKeysPage`, etc.) are now reachable **only** via
  `/settings/*` — confirm no other code links to the old top-level paths (grep for
  `"/config"`, `"/keys"`, `"/integrations"`, `"/repos"`, `"/debug"`, `"/budgets"`,
  `"/dashboard"` across `ui/src` and update any in-app links/buttons found).

### Success Criteria:

#### Automated Verification:
- [x] Type-check passes: `cd ui && pnpm exec tsc -b`
- [x] Lint passes: `cd ui && pnpm lint`
- [x] Build passes: `cd ui && pnpm build`
- [x] No stale absolute links: `cd ui && grep -rn '"/\(config\|keys\|integrations\|repos\|debug\|budgets\|dashboard\)"' src` — every hit is either a redirect-table `to=` target in `router.tsx` or has been updated to the new `/settings/*` path. (Old route *definitions* use relative `path: "config"` and won't match this pattern.)

#### Automated QA:
*(Agent drives `http://localhost:5274` with the browser-use skill.)*
- [x] `/dashboard` → lands on `/`; `/budgets` → lands on `/usage?tab=budgets` (Budgets tab).
- [x] `/config` → `/settings/config`; `/keys` → `/settings/api-keys`; `/integrations` →
      `/settings/integrations`; `/repos` → `/settings/repos`; `/debug` → `/settings/debug`.
- [x] `/integrations/slack` → `/settings/integrations/slack` (deep link preserved).
- [x] `/old-home` and `/old-dashboard` still render directly (not redirected).
- [x] No old URL produces a 404 / blank error boundary.

#### Manual Verification:
- [ ] Spot-check that any in-app buttons/links that previously pointed at moved routes now land
      correctly (e.g. config-guard, "manage integrations" CTAs).

### Final Manual QA

Implement all 6 phases **autopilot, end-to-end** — do not pause between phases and do **not**
generate a separate QA doc. After Phase 6 commits, implementation is complete; hand back to Taras
for one joint manual QA pass over the full route matrix: all 13 sidebar items, `/old-home` &
`/old-dashboard`, the `/settings/*` nested routes (incl. the `/settings/integrations/:id` deep
link), the `/usage` Usage/Budgets tabs, and every redirect in the table.

**Implementation Note**: Run Automated Verification + Automated QA; on pass, commit
`[phase 6] router: backward-compat redirect table (no 404s)`. Implementation is then done —
proceed to the joint Final Manual QA with Taras.

---

## Appendix

- **Derail notes**:
  - The `gate` JSDoc on `NavItem` (`app-sidebar.tsx:47`) claims gated items render "disabled with
    a tooltip", but the code drops them (`return null`). Out of scope here; flagged for cleanup.
  - When RBAC lands, `minRole` needs (a) a current-user role source and (b) render-time filtering
    in `app-sidebar.tsx` — plus the actual end-user/admin item mapping (deferred per brainstorm).
  - A future Settings-area redesign likely wants a top-level Settings / Usage / Resources split
    rather than the current flat avatar-menu entries (brainstorm § "How should the account area
    be structured").
- **References**:
  - Brainstorm: `thoughts/taras/brainstorms/2026-05-21-sidebar-trim-cleanup.md`
  - Sidebar: `ui/src/components/layout/app-sidebar.tsx`
  - Router: `ui/src/app/router.tsx`

## Review Errata

_Reviewed: 2026-05-22 by Claude (`desplega:reviewing`)_

### Applied

- [x] **Important** — InboxPanel/Approvals scope was silent. The brainstorm said Approvals
  "absorbs" the old Dashboard `InboxPanel`; the plan didn't address it, leaving the autopilot
  implementer to guess. Added an explicit out-of-scope bullet to *What We're NOT Doing*.
- [x] **Important** — Feature-gate loading flash on the new Home. `useFeatureGate` returns
  `supported: false` while the version query is pending, so Phase 2 would have flashed the
  "requires 1.76+" notice on every load. Phase 2 §1 now specifies gating on the *resolved*
  state (skeleton while pending, notice only on confirmed-unsupported).
- [x] **Important** — `/settings` shell mobile behavior was unaddressed (a left rail crowds
  narrow viewports). Phase 3 §1 now specifies the rail collapses to a horizontal strip / `Select`
  below the `md` breakpoint.
- [x] **Important** — `AgentCanvas` full-bleed needs a definite-height parent chain or ReactFlow
  collapses to 0. Phase 2 §1 now spells out the `flex flex-col flex-1 min-h-0` chain on
  `UnifiedHome` and the `min-h-0` links.
- [x] **Minor** — Phase 6 grep verification claim was imprecise (old route definitions use
  relative `path: "config"`, not `"/config"`). Reworded to target stale *absolute* links.
- [x] **Minor** — Phase 1 Automated QA "13 items total" assumed a current API server; added the
  qualifier that version-gated items are still dropped.
- [x] **Minor** — `useAgentActivity`'s own `isLoading`/`isError`/`truncated` handling on the new
  Home was unmentioned; Phase 2 §1 now calls for a loading placeholder + graceful error state.

No Critical findings.
