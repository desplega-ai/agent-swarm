---
date: 2026-03-17T12:00:00Z
topic: "Multi API Config for Dashboard"
status: in-progress
autonomy: autopilot
---

# Multi API Config Implementation Plan

## Overview

Add support for multiple API configurations (swarm connections) in the new-ui dashboard. Users can store multiple API URL + API Key pairs in localStorage, give them optional names (random slug if left empty), and switch between them. This enables quickly checking different swarms — local, production, customer environments, etc.

## Current State Analysis

The dashboard currently supports a **single API connection** stored in localStorage under `agent-swarm-config`:

- **`src/lib/config.ts`** — `Config` type has `apiUrl` + `apiKey`, stored/loaded from a single localStorage key
- **`src/hooks/use-config.ts`** — React context providing `config`, `setConfig`, `resetConfig`, `isConfigured`. Also reads `?apiUrl=&apiKey=` from URL params on init
- **`src/api/client.ts`** — `ApiClient` singleton reads config via `getConfig()` on every request for headers and base URL. Dev mode proxies through Vite when URL is `localhost:3013`
- **`src/app/providers.tsx`** — `ConfigProvider` wraps the app, `QueryClient` is a module-level singleton
- **`src/pages/config/page.tsx`** — Config page with two views: unconfigured (connect card) and configured (connection settings + swarm config CRUD grid)
- **`src/components/layout/config-guard.tsx`** — Redirects to `/config` if not configured (`isConfigured = !!apiKey`)
- **`src/components/layout/app-header.tsx`** — Header with health indicator and theme toggle
- **`src/components/layout/app-sidebar.tsx`** — Sidebar with nav groups, logo in header

### Key Discoveries:
- `getConfig()` in `src/lib/config.ts:13` is called directly by `ApiClient` (not through React context) — this is the synchronous bridge between React state and the fetch layer
- `QueryClient` in `src/app/providers.tsx:7` is a module-level singleton — switching configs needs to invalidate all queries
- URL params (`?apiUrl=&apiKey=`) in `src/hooks/use-config.ts:21-38` overwrite the stored config — this should be preserved for deep-linking
- Dev proxy in `vite.config.ts:16` only activates when `apiUrl === "http://localhost:3013"` — multi-config needs to handle this correctly per-connection
- The `ConfigGuard` (`src/components/layout/config-guard.tsx:8`) checks `isConfigured = !!apiKey` — with multi-config, this means "has at least one connection with an apiKey"

## Desired End State

1. **Multiple saved connections** in localStorage, each with: `id`, `name`, `apiUrl`, `apiKey`
2. **Active connection** tracked by ID in localStorage
3. **Swarm switcher** in the sidebar header (below logo) — compact dropdown showing active swarm name, click to switch or manage
4. **Add/edit/delete connections** from the config page (replaces current single-connection card)
5. **URL param deep-linking** preserved — `?apiUrl=&apiKey=` creates/activates a temporary or named connection
6. **Query cache invalidation** on connection switch
7. **Random slug names** generated when user doesn't provide a name (e.g., "cool-panda", "swift-hawk")

## Backward Compatibility

Existing users with the old `agent-swarm-config` localStorage key must be seamlessly migrated:
- On first load, if `agent-swarm-config` exists but `agent-swarm-connections` does not, migrate the old config into a connection named `”default”` and set it as active
- After migration, remove the old `agent-swarm-config` key
- The old key is never written to again — all new reads/writes use the new schema
- `getConfig()` continues to return `{ apiUrl, apiKey }` from the active connection, so `ApiClient` works without changes

## Quick Verification Reference

Common commands to verify the implementation:
- `cd new-ui && pnpm lint` — Biome lint + format
- `cd new-ui && pnpm exec tsc --noEmit` — TypeScript type check
- `cd new-ui && pnpm dev` — Dev server for manual testing

Key files to check:
- `src/lib/config.ts` — Core config types and localStorage logic
- `src/hooks/use-config.ts` — React context and state management
- `src/api/client.ts` — API client consuming config
- `src/components/layout/app-sidebar.tsx` — Swarm switcher UI
- `src/pages/config/page.tsx` — Connection management UI

## What We're NOT Doing

- Server-side config storage (stays in localStorage)
- Auto-discovery of swarms
- Health polling per-connection in the background (only active connection)
- Config import/export (can be added later)
- Encrypting API keys in localStorage (browser localStorage is inherently not secure)
- CORS proxy or server-side relay — switching between API servers at different origins from a deployed dashboard will only work if the target API has CORS headers allowing the dashboard's origin. This is a known limitation; documenting it is sufficient for now.

## Implementation Approach

**Bottom-up**: Start with the data layer (types + localStorage), then React context, then API client integration, then UI components. This lets each layer be tested in isolation before wiring up the UI.

The key architectural decision is keeping `getConfig()` as the synchronous bridge between React state and the `ApiClient` singleton. When the active connection changes, we update localStorage and React state, then invalidate the query cache. The `ApiClient` doesn't need to change — it already reads config on every request.

**URL param flow**: When the app is opened with `?apiUrl=&apiKey=` query params, instead of silently creating a connection, we show a **"Name this connection" modal** with a pre-filled random slug. The user can accept the slug, type a custom name, or pick an existing connection if the URL matches one. This ensures every connection gets a deliberate name and the user is aware a new entry is being saved. The modal blocks navigation until dismissed (connect or cancel).

---

## Phase 1: Data Layer — Multi-Connection Storage

### Overview
Replace the single-config localStorage schema with a multi-connection schema. Introduce types, CRUD helpers, and a migration path from the old single-config format.

### Changes Required:

#### 1. Config Types and Storage
**File**: `src/lib/config.ts`
**Changes**:
- Add `Connection` type: `{ id: string; name: string; apiUrl: string; apiKey: string }`
- Add `MultiConfig` type: `{ connections: Connection[]; activeId: string | null }`
- New storage key: `agent-swarm-connections` (keep old key readable for migration)
- Add CRUD functions: `getConnections()`, `addConnection()`, `updateConnection()`, `removeConnection()`, `getActiveConnection()`, `setActiveConnection(id)`
- Add `generateSlug()` — simple random two-word slug generator (adjective + noun, ~30 of each = 900 combos, no dependency needed)
- Migration: on first `getConnections()` call, if old `agent-swarm-config` exists and new key doesn't, migrate it to a single connection entry with name "default"
- Keep `getConfig()` working — it returns the active connection's `{ apiUrl, apiKey }` (or default values if none active). This preserves backward compatibility with `ApiClient`
- Handle orphaned `activeId`: if `activeId` points to a connection that no longer exists (corrupted state, cross-tab deletion), `getActiveConnection()` should auto-select the first available connection and update `activeId`. If no connections exist, return `null` (which makes `getConfig()` return defaults and `isConfigured` evaluate to false, triggering the ConfigGuard redirect)

#### 2. Slug Generator
**File**: `src/lib/slugs.ts`
**Changes**:
- Export `generateSlug(): string` — picks random adjective + noun (e.g., "swift-falcon")
- Two arrays: ~30 adjectives, ~30 nouns — small, no dependency

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `cd new-ui && pnpm exec tsc --noEmit`
- [x] Lint passes: `cd new-ui && pnpm lint`

#### Manual Verification:
- [ ] Open browser console, call `localStorage.getItem("agent-swarm-connections")` — verify structure
- [ ] If old `agent-swarm-config` existed, verify it was migrated into a "default" connection
- [ ] `getConfig()` still returns correct `{ apiUrl, apiKey }` for the active connection

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## localStorage Schema

### Old format (single connection):
```
Key: "agent-swarm-config"
Value: { "apiUrl": "http://localhost:3013", "apiKey": "123123" }
```

### New format (multi-connection):
```
Key: "agent-swarm-connections"
Value: {
  "connections": [
    {
      "id": "conn_a1b2c3d4",
      "name": "local",
      "apiUrl": "http://localhost:3013",
      "apiKey": "123123"
    },
    {
      "id": "conn_e5f6g7h8",
      "name": "swift-falcon",
      "apiUrl": "https://swarm.customer.com",
      "apiKey": "sk-prod-xxx"
    }
  ],
  "activeId": "conn_a1b2c3d4"
}
```

The `id` is a short random string prefixed with `conn_`. The `activeId` points to which connection is currently in use. When `getConfig()` is called (by `ApiClient` or anywhere), it reads this structure, finds the connection matching `activeId`, and returns `{ apiUrl, apiKey }`.

---

## Phase 2: React Context — Multi-Connection State Management

### Overview
Update the React context to expose multi-connection state and operations. The existing `useConfig()` hook API changes to support switching, adding, and removing connections.

### Changes Required:

#### 1. Config Hook
**File**: `src/hooks/use-config.ts`
**Changes**:
- Expand `ConfigContextValue` to include:
  - `connections: Connection[]`
  - `activeConnection: Connection | null`
  - `config: Config` (derived from active connection — backward compat)
  - `switchConnection(id: string): void`
  - `addConnection(conn: Omit<Connection, "id">): Connection` (returns created)
  - `updateConnection(id: string, updates: Partial<Omit<Connection, "id">>): void`
  - `removeConnection(id: string): void`
  - `isConfigured: boolean` (true if active connection has apiKey)
- URL param handling is **deferred to Phase 4** where the "Name this connection" modal is built. In this phase, simply strip URL params on init without acting on them (preserve backward compat by not breaking if params are present, but don't create connections yet).
- On `switchConnection`: update localStorage, update React state, call `queryClient.resetQueries()` to clear all cached data (not `invalidateQueries()` — switching servers means all cached data is from the wrong source, so we need clean loading states, not stale data)

#### 2. Providers — Query Cache Invalidation
**File**: `src/app/providers.tsx`
**Changes**:
- The `ConfigProvider` is inside `QueryClientProvider`, so `useQueryClient()` is available inside the config hook. Use it to call `queryClient.invalidateQueries()` on connection switch. No structural changes needed.

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `cd new-ui && pnpm exec tsc --noEmit`
- [x] Lint passes: `cd new-ui && pnpm lint`

#### Manual Verification:
- [ ] Temporarily add a `console.log` in the config provider — verify connections load on page refresh
- [ ] Verify `isConfigured` is true when active connection has an apiKey
- [ ] Verify React DevTools shows correct context value structure

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 3: Sidebar Swarm Switcher

### Overview
Add a compact swarm switcher to the sidebar header, below the logo. Shows the active connection name with a dropdown to switch between saved connections or go to config to manage them.

### Changes Required:

#### 1. Install DropdownMenu component
**Action**: `cd new-ui && pnpm dlx shadcn@latest add dropdown-menu`
**Why**: Need a dropdown for the switcher. shadcn/ui dropdown-menu is the standard pattern for this.

#### 2. Swarm Switcher Component
**File**: `src/components/layout/swarm-switcher.tsx` (new)
**Changes**:
- Compact component that shows: active connection name (truncated), health dot, chevron
- DropdownMenu with:
  - List of saved connections — click to switch (checkmark on active)
  - Separator
  - "Manage connections" link -> navigates to `/config`
- Uses `useConfig()` to get connections and switch
- When sidebar is collapsed (`collapsible="icon"` mode), show only the health dot or a small icon

#### 3. Sidebar Integration
**File**: `src/components/layout/app-sidebar.tsx`
**Changes**:
- Import and render `SwarmSwitcher` below the logo in `SidebarHeader`
- Adjust header height if needed (currently `h-14`)

#### 4. Header Health Indicator Update
**File**: `src/components/layout/app-header.tsx`
**Changes**:
- Show active connection name next to the health indicator (e.g., "local — Connected v1.2.3")

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `cd new-ui && pnpm exec tsc --noEmit`
- [ ] Lint passes: `cd new-ui && pnpm lint`

#### Manual Verification:
- [ ] Switcher shows active connection name in sidebar
- [ ] Dropdown lists all saved connections
- [ ] Clicking a different connection switches and reloads data
- [ ] "Manage connections" navigates to `/config`
- [ ] Sidebar collapsed mode shows reasonable compact view

**Implementation Note**: After completing this phase, pause for manual confirmation.

### QA Spec (optional):

**Approach:** manual
**Test Scenarios:**
- [ ] TC-1: Switch between connections
  - Steps: 1. Have 2+ connections saved, 2. Click switcher, 3. Select different connection
  - Expected: Dashboard reloads with data from new API, health indicator updates
- [ ] TC-2: Collapsed sidebar
  - Steps: 1. Collapse sidebar, 2. Observe switcher
  - Expected: Switcher degrades gracefully (icon only or hidden)

---

## Phase 4: Config Page — Multi-Connection Management

### Overview
Replace the single-connection card on the config page with a multi-connection management UI. Add/edit/delete connections, with the "connect" flow creating a new connection entry.

### Changes Required:

#### 1. Config Page Rewrite
**File**: `src/pages/config/page.tsx`
**Changes**:
- **Unconfigured state** (no connections): Show a "welcome" card with form to add first connection (name optional -> random slug, apiUrl, apiKey, connect button with health check)
- **Configured state**: Replace the single "Connection" card with a "Connections" section:
  - List of connection cards or a compact list, each showing: name, apiUrl, active badge, edit/delete buttons
  - "Add Connection" button opens a dialog with: name (optional, placeholder shows generated slug), apiUrl, apiKey
  - Edit dialog: same fields, pre-filled
  - Delete with confirmation (can't delete the active connection unless it's the last one — in that case, clear everything)
  - Each connection has a "Connect" / "Test" button that does a health check
- Keep the `SwarmConfigSection` (CRUD grid for server-side swarm config) below — it operates on the active connection's API

#### 2. Connection Form Dialog
**File**: `src/pages/config/page.tsx` (inline, same pattern as `ConfigEntryDialog`)
**Changes**:
- Reusable dialog for add/edit connection
- Fields: name (optional), apiUrl (required), apiKey (required)
- On submit: health check -> if ok, save connection -> if first connection, set active and navigate to dashboard

#### 3. URL Param "Name This Connection" Modal
**File**: `src/components/shared/name-connection-modal.tsx` (new), rendered from `src/components/layout/root-layout.tsx`
**Changes**:
- Add URL param detection to `useConfigProvider()`: on init, if `?apiUrl=&apiKey=` present:
  1. Check if a connection with matching URL+key already exists → if yes, activate it, strip params, done
  2. If no match, set `pendingConnection: { apiUrl, apiKey }` state and strip URL params
  3. While `pendingConnection` is set, `getConfig()` uses pending credentials as the active config (so the dashboard loads immediately)
- New `NameConnectionModal` component:
  - Shown when `pendingConnection` is non-null
  - Displays the detected apiUrl
  - Input for connection name, pre-filled with a random slug
  - "Save & Connect" button — saves the connection with chosen name, sets it active, clears pending state
  - "Skip" option — uses credentials for this session only without saving (clears on next refresh)
- Render the modal in `root-layout.tsx` at the layout level (appears regardless of current page)

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `cd new-ui && pnpm exec tsc --noEmit`
- [ ] Lint passes: `cd new-ui && pnpm lint`

#### Manual Verification:
- [ ] Can add a new connection with a custom name
- [ ] Can add a connection without a name -> random slug generated
- [ ] Can edit an existing connection's name, URL, and key
- [ ] Can delete a non-active connection
- [ ] Deleting the last connection shows unconfigured state
- [ ] URL params (`?apiUrl=x&apiKey=y`) still work — create a new connection or match existing
- [ ] SwarmConfigSection still works against the active connection

**Implementation Note**: After completing this phase, pause for manual confirmation.

### QA Spec (optional):

**Approach:** manual
**Test Scenarios:**
- [ ] TC-1: First-time setup
  - Steps: 1. Clear localStorage, 2. Open dashboard, 3. Fill in connection details, 4. Click Connect
  - Expected: Connection saved, redirected to dashboard, data loads
- [ ] TC-2: Add second connection
  - Steps: 1. Go to /config, 2. Click "Add Connection", 3. Fill in different API, 4. Save
  - Expected: New connection appears in list and in sidebar switcher
- [ ] TC-3: Delete connection
  - Steps: 1. Have 2+ connections, 2. Delete the non-active one
  - Expected: Connection removed from list and switcher
- [ ] TC-4: URL param deep-link
  - Steps: 1. Visit `/?apiUrl=http://localhost:3013&apiKey=123123`
  - Expected: Connection created/matched and set active, URL cleaned up

---

## Phase 5: Polish and Edge Cases

### Overview
Handle edge cases, ensure dev proxy works correctly with multi-config, and add finishing touches.

### Changes Required:

#### 1. Dev Proxy Handling
**File**: `src/api/client.ts`
**Changes**:
- The existing logic returns empty baseUrl in dev when apiUrl is `localhost:3013` (to use Vite proxy). This already works per-request via `getConfig()`, so no changes needed unless we want to support multiple localhost ports. Verify behavior is correct.

#### 2. ConfigGuard Update
**File**: `src/components/layout/config-guard.tsx`
**Changes**:
- Verify `isConfigured` logic works with multi-config (should already work since it derives from active connection)

#### 3. Connection Health Indicator in Switcher
**File**: `src/components/layout/swarm-switcher.tsx`
**Changes**:
- Show a colored dot next to the active connection in the dropdown (live health from existing `useHealth` hook)
- Non-active connections show neutral dot (no background polling)

#### 4. Keyboard Shortcut (optional)
**File**: `src/hooks/use-keyboard-shortcuts.ts` (if exists)
**Changes**:
- Consider adding a shortcut to open the switcher dropdown (only if it doesn't conflict with existing shortcuts like Cmd+K for command menu)

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `cd new-ui && pnpm exec tsc --noEmit`
- [ ] Lint passes: `cd new-ui && pnpm lint`

#### Manual Verification:
- [ ] Dev proxy works correctly when active connection is localhost:3013
- [ ] Switching to a non-localhost connection bypasses the proxy correctly
- [ ] Clearing all connections shows the unconfigured state
- [ ] Page refresh preserves active connection selection
- [ ] Multiple tabs sharing localStorage stay reasonably in sync (no crashes)

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Testing Strategy

- **No unit tests required** — this is pure UI/state logic with localStorage; manual verification is sufficient
- **TypeScript strict mode** is the primary automated safety net
- **Manual E2E** testing covers all user flows

### Manual E2E Verification:

```bash
# 1. Start API server
cd /Users/taras/Documents/code/agent-swarm && bun run start:http &

# 2. Start UI dev server
cd /Users/taras/Documents/code/agent-swarm/new-ui && pnpm dev

# 3. Clear state and test fresh setup
# Open browser, clear localStorage, navigate to localhost:5274
# Expected: Redirected to /config with connect card

# 4. Add first connection
# Fill: name="local", apiUrl="http://localhost:3013", apiKey="123123"
# Click Connect -> should redirect to dashboard with data

# 5. Add second connection
# Go to /config, add connection: name="" (leave empty), apiUrl="http://other:3013", apiKey="abc"
# Expected: Random slug generated for name

# 6. Switch connections via sidebar
# Click switcher in sidebar, select other connection
# Expected: Dashboard data changes (or shows error if other server is down)

# 7. URL deep-link
# Navigate to localhost:5274/?apiUrl=http://localhost:3013&apiKey=123123
# Expected: Matches existing "local" connection and activates it

# 8. Delete connection
# Go to /config, delete the non-active connection
# Expected: Removed from list and switcher
```

## References
- Current config implementation: `src/lib/config.ts`, `src/hooks/use-config.ts`
- shadcn/ui dropdown-menu: needed for Phase 3
- Existing config page patterns: `src/pages/config/page.tsx` (dialog patterns to reuse)

---

## Review Errata

_Reviewed: 2026-03-17 by Claude_

### Important (all resolved)
- [x] **`pendingConnection` crosses Phase 2→4 gap** — resolved: deferred URL param handling entirely to Phase 4. Phase 2 just strips params without acting on them.
- [x] **Use `resetQueries()` instead of `invalidateQueries()`** — resolved: Phase 2 now specifies `queryClient.resetQueries()` with rationale.
- [x] **Handle orphaned `activeId`** — resolved: added to Phase 1 `getActiveConnection()` logic (auto-select first connection or return null).
- [x] **Note CORS implications for production** — resolved: added to "What We're NOT Doing" section.

### Resolved
- [x] localStorage Schema section placed between Phase 1 and Phase 2 interrupts phase flow — acceptable as a reference section, no action needed
- [x] Frontmatter missing `planner` field — minor, not blocking
- [x] Phase 4 modal file location says "root-layout.tsx or name-connection-modal.tsx" — should be definitive during implementation (render in root-layout, component in separate file)
