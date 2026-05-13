---
id: step-8
name: Listing UI + skill doc
depends_on: [step-3]
status: done
---

# step-8: Listing UI + skill doc

## Overview

Two adjacent deliverables that share no dependencies with the auth-mode or renderer steps: (a) a `/pages` route in the SPA showing a table of pages (title, description, agent, updated_at, auth_mode) with links to `/artifacts/:id`; (b) `plugin/skills/pages/SKILL.md` — the agent-facing contract documenting the MCP tool, URL semantics, versioning behavior, blast-radius warnings, and concrete examples. Mirrors `plugin/skills/artifacts/skill.md`'s section structure.

## Changes Required:

#### 1. Listing API confirmation
**File**: `src/http/pages.ts` (verify step-3's `GET /api/pages` is suitable)
**Changes**: Confirm `GET /api/pages` returns `{ pages: Page[], total: number }` with optional `agentId` query filter for per-agent inbox view. Add the filter if missing.

#### 2. SPA listing route
**File**: `ui/src/app/router.tsx`
**Changes**: Add `<Route path="/pages" element={<PagesListing />} />` as a child of `RootLayout`.

**File**: `ui/src/pages/pages-listing.tsx` (new)
**Changes**: React-query table:
- `useQuery({ queryKey: ['pages', filters], queryFn: () => apiClient.listPages(filters) })`
- shadcn `Table` (already used in the SPA — pattern-match from `ui/src/pages/*-listing.tsx` if a similar page exists).
- Columns: title (link to `/artifacts/:id`), description, agentId (short hash), authMode (badge), updatedAt (relative time).
- Empty state with CTA: "Pages are created via the `create_page` MCP tool. See the docs."
- Optional filter: by current user's agent (toggle "My pages only" — checks `currentUserContext.agentId === page.agentId`).

#### 3. Sidebar nav entry
**File**: `ui/src/components/layout/sidebar.tsx` (or wherever the side nav is defined — locate by grep `Sidebar` / nav items)
**Changes**: Add a "Pages" entry between "Workflows" and "Services" (or wherever fits the existing nav order). Icon: `FileText` from lucide-react.

#### 4. API client method
**File**: `ui/src/api/client.ts`
**Changes**: Add `listPages({ agentId?, limit?, offset? }): Promise<{ pages: Page[], total: number }>` calling `GET /api/pages` with the bearer.

#### 5. Skill doc
**File**: `plugin/skills/pages/SKILL.md` (new — mirrors `plugin/skills/artifacts/skill.md` shape; note the **uppercase `SKILL.md`** filename — current skill-format convention, not the legacy lowercase used by the older artifacts skill)
**Changes**: Full doc, ~150 lines, covering:
- `# Pages — DB-backed Static Artifacts`
- `## When to use Pages vs Artifacts`
  - Pages = static HTML/JSON content, no server logic. Cheap.
  - Artifacts = full Hono app, custom routes, websockets, port allocation. Expensive.
- `## Quick Start` — two subsections:
  - `### Public HTML report` — single `create_page` call returning `app_url` + `api_url`.
  - `### Authed JSON dashboard` — `create_page` with `contentType: 'application/json'`, `authMode: 'authed'`, sample json-render spec with a `swarm.call` button.
- `## Auth Modes` — table with `public` / `authed` / `password`, when to use each, the URL behavior.
- `## URL Shapes`
  - `api_url` = `${API_URL}/p/:id` — works for HTML (all auth modes); JSON 302s to app_url.
  - `app_url` = `${UI_URL}/artifacts/:id` — works for both content types and all auth modes.
  - Default recommendation: share `app_url` unless you specifically want a no-SPA-required link.
- `## Versioning` — every overwrite versions the prior content. `GET /api/pages/:id/versions` lists; `GET /api/pages/:id/versions/:v` reads.
- `## Browser SDK` — for HTML pages, `window.SwarmSDK` is auto-injected (same SDK as artifacts). Note: `public` pages can't call authed endpoints (no cookie).
- `## JSON Renderer` — schema points to `@json-render/core` docs + the `swarm.call` action shape with example.
- `## Security & Blast Radius` — declared actions on `authed` pages have the same blast radius as the viewing user. Treat agent-generated HTML/JSON like trusted code, since the agent already has equivalent MCP access. Sandboxed iframe (`sandbox="allow-scripts allow-forms allow-same-origin"`) limits HTML pages somewhat.
- `## Limits` — body size cap (default 1 MB per version), no TTL (manual delete).
- `## See Also` — `plugin/skills/artifacts/skill.md` for full custom apps.

#### 5b. Task-template pointers
**Files**: scan `templates/` and `templates-ui/` for task templates whose capability sets include relevant slices (e.g. anything touching `services`, `workflows`, or general "report-out" workflows). Where appropriate, add a small pointer line like `- See \`plugin/skills/pages/SKILL.md\` for sharing reports / dashboards as DB-backed pages.` Mirrors how other capability-gated skills are referenced from templates. Be sparing — only templates where pages are a natural fit (status reporting, summary outputs, dashboards). Skim with `grep -rn "skills/artifacts" templates/ templates-ui/` and add a pages pointer adjacent to existing artifacts pointers, if any.

#### 6. Skill build
**File**: `plugin/pi-skills/pages.md` (regenerated)
**Changes**: Run `bun run build:pi-skills` to regenerate from `plugin/commands/`. Commit the output.

#### 7. Tests
**File**: `ui/src/pages/pages-listing.test.tsx` (new — vitest)
**Changes**: Mock `apiClient.listPages` → render table → assert rows render with title links pointing at `/artifacts/:id` and auth-mode badges.

**File**: `src/tests/pages-list-endpoint.test.ts` (new)
**Changes**: Pre-seed three pages under two different agentIds. `GET /api/pages` returns all three. `GET /api/pages?agentId=<X>` returns only pages owned by X. Pagination works.

### Success Criteria:

#### Automated Verification:
- [x] New backend test passes: `bun test src/tests/pages-list-endpoint.test.ts` (4 tests, 18 expects). UI vitest test skipped — `ui/` has no vitest infrastructure (see Deviations).
- [x] `cd ui && pnpm exec tsc -b && pnpm lint`
- [x] `bun run lint && bun run tsc:check`
- [x] `bun run build:pi-skills` produces a clean diff (no pi-skill emitted for pages — `pages` is not in SKILLS_TO_CONVERT and the build script reads `plugin/commands/*.md`, not `plugin/skills/*`). The `plugin/skills/pages/SKILL.md` is consumed directly by Claude Code's skill loader.
- [x] OpenAPI regenerated for the new `agentId` query param: `bun run docs:openapi`.

#### Automated QA:
- [ ] qa-use scenario `pages-listing.yaml` (new):
  1. Pre-create three pages under the current agent.
  2. Navigate to `/pages` in the SPA.
  3. Assert three rows visible with expected titles.
  4. Click first row's title → land on `/artifacts/:id`.
  5. Screenshot of listing page.

#### Manual Verification:
- [ ] Read `plugin/skills/pages/SKILL.md` end-to-end as if you were an agent encountering it for the first time. Confirm the Quick Start examples copy-paste cleanly into an agent's tool call.
- [ ] Visual check of the listing table layout in the SPA (alignment, badge colors, empty state copy).

**Implementation Note**: Skill doc is the agent contract — be deliberate. Commit as `[step-8] pages listing UI + skill doc`.
