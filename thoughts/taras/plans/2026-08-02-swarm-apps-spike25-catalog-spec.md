---
date: 2026-08-02T00:30:00Z
author: claude (orchestrator session)
topic: "Swarm Apps — Spike 2.5 Spec (layout + search catalog), FROZEN"
status: frozen
branch: spike/swarm-apps
---

# Spike 2.5 (FROZEN): layout primitives + client-side search/filtering + Notes Mini showcase

Extends spike 2 (spec: ./2026-08-01-swarm-apps-spike2-spec.md, PR #1066). Same branch,
same never-merge rule. Delivers UI-catalog gap №1 (layout primitives) and №3/№4
(search + user-driven filtering) from the progress doc — the exact gap the finale
worker complained about ($state-bindable filters).

**Design call — client-side filtering, not query overrides**: `SearchInput`/`Select`
write into a NEW json-render state root `/ui/<id>`; `Table` gains bindable
`search`/`filters` props and filters the polled rows client-side. Honest at spike scale
(row cap 1000, 5s poll), zero server query machinery; server-side overrides stay a
platform-version concern.

## Slice order (sequential — server consumes the regenerated artifact)
1. **UI slice (Opus workflow)**: apps/ui/** only + regenerate `src/apps/catalog.generated.json`.
2. **Server slice (Codex terra)**: `src/apps/page-validator.ts` + tests +
   `templates/skills/apps/content.md`. No apps/ui writes.
3. **Orchestrator**: Notes Mini showcase via MCP `app-patch` (dogfood), browser verify,
   commit, push to PR #1066.

## 1. Catalog additions (apps/ui/src/lib/json-render/catalog.ts)

Shared token: `spacing = z.enum(["none","xs","sm","md","lg","xl"])`.
All components join `swarmCatalogSpec`; regenerate artifact after.

| Component | Props (zod) | Slots / children convention |
|---|---|---|
| `Stack` | `direction?: "column"\|"row"` (default column), `gap?: spacing` (default md), `align?: "start"\|"center"\|"end"\|"stretch"`, `justify?: "start"\|"center"\|"end"\|"between"`, `wrap?: boolean`, `padding?: spacing` | `["default"]` — THE primary layout primitive (skill steers here; `Container` stays for backcompat) |
| `Grid` | `columns?: int 1..6 \| { base?, sm?, md?, lg?: int 1..6 }` (default `{base:1, md:2, lg:3}`), `gap?: spacing` (default md) | `["default"]` — responsive via Tailwind grid-cols per breakpoint |
| `Split` | `ratio?: "1-1"\|"1-2"\|"2-1"\|"1-3"\|"3-1"` (default "2-1"), `gap?: spacing`, `collapseBelow?: "sm"\|"md"\|"lg"` (default md), `reverse?: boolean` | `["default"]` — POSITIONAL: children[0] = first pane, children[1] = second pane; extra children append to the second pane. Below `collapseBelow` panes stack vertically (`reverse` flips stacking order only) |
| `Divider` | `label?: string` | none |
| `Tabs` | `id: string`, `tabs: [{key, label?}] min 1`, `defaultTab?: string` | `["default"]` — POSITIONAL: children[i] pairs with tabs[i]; active tab's child rendered (others keep mounted but hidden, so polling tables stay warm); active key mirrored to state `/ui/<id>/tab` |
| `SearchInput` | `id: string`, `placeholder?`, `label?` | none — writes debounced (~200ms) string to `/ui/<id>/value` |
| `Select` | `id: string`, `options: (string \| {value, label?})[]` min 1, `placeholder?`, `label?`, `clearable?: boolean` (default true) | none — writes `/ui/<id>/value` (string; clearing writes `null`) |
| `Markdown` | `content: string` | none — renders via Streamdown (repo markdown rule) |

`Table` gains two OPTIONAL props (both binding-friendly):
- `search?: z.string()` — case-insensitive substring match across the row's string/number
  cell values (all columns listed in `columns`); empty/undefined = no-op.
- `filters?: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]).nullable())`
  — per-column equality; `null`/`""`/undefined value disables that column's filter.
Filtering is applied client-side to `data` before render; `emptyMessage` still applies
when filters produce zero rows (append a "no matches" default variant when data was
non-empty pre-filter).

React impls: compose repo primitives per apps/ui/CLAUDE.md (tokens only — check:tokens
gate; Select/Input/Tabs shadcn primitives; Streamdown for Markdown). Positional children:
`React.Children.toArray(children)` — VERIFY the Renderer delivers children as an
indexable array early; if it fragments them, adapt (this is the one integration risk).
SearchInput/Select/Tabs write state through the runtime's StateStore (`useStateStore`),
NOT local component state, so `$state` bindings resolve (`/ui/<id>/...`).
Runtime note: `/ui` is a normal state subtree — no page.tsx changes should be needed
beyond what the components do themselves; keep the ctxRef/action patterns untouched.

Then: `cd apps/ui && bun run generate:catalog-schema` (artifact regenerated + biome-formatted).
Gates: `bun run lint && bun run check:tokens && bunx tsc -b` (from apps/ui) + root `bun run lint`.

## 2. Server slice: validator + skill (src/** + templates/skills/apps/**)

`src/apps/page-validator.ts`:
- New `$state` root: `/ui/<id>[/...]` is valid iff some element has `props.id === id`
  AND its `type` ∈ {`SearchInput`, `Select`, `Tabs`} (collect ids the same way Form ids
  are collected for `/forms`). Everything else about state-ref checking unchanged.
- No other validator changes — new components/props validate via the regenerated artifact
  automatically.

`src/tests/apps-spike2.test.ts` (extend): a page using Stack/Split/Tabs/SearchInput/
Select/Markdown + Table `search`/`filters` bound to `/ui/...` passes; `/ui/unknownId/value`
binding → path-bearing issue; Tabs props.id counts as a `/ui` provider; Bookmarks +
APP_SEED regressions still green.

`templates/skills/apps/content.md`: new "Layout & interactivity" section — Stack as the
primary layout (Container = legacy alias), Grid responsive columns, Split/Tabs POSITIONAL
children conventions (spell them out), Divider, Markdown; `/ui/<id>` state root; the
client-side search/filter pattern with one compact example (SearchInput + Select wired
into Table.search/Table.filters); update the component catalog table + valid `$state`
roots list. Keep the existing style (tables, escaped pipes).

Gates: `bun run lint && bun run tsc:check && bun run test:root -- src/tests/apps-spike2.test.ts
&& bun run check:skill-sources` + full `bun run test:root`.

## 3. Notes Mini showcase (orchestrator, via MCP app-patch — dogfoods the loop)

App bae5343b-119b-47e4-915f-ba3ced9073f1. Model grows to
`note { title (string, required), content (string), tag (enum: idea|todo|reference|journal,
default idea), pinned (boolean, default false) }` (drop the old bare `text` column — 0 rows);
queries `all` (updatedAt desc) + `pinnedOnly` (filter pinned=true). Page: Stack root →
Heading + intro → Grid (3 Cards intro strip) → Split(1-2): left = New-note Form card +
Divider + Filters card (SearchInput `q`, Select `tagFilter` over tags); right = Tabs
(`view`): "All notes" Table (search+filters bound, tag badge with tones, pinned bool,
updatedAt date; rowActions Pin/Unpin/Delete), "Pinned" Table (filters {pinned: true}),
"About" Markdown. Seed ~6 varied rows via the bulk endpoint. Browser-verify incl. a
narrow-viewport pass (Split collapse, Grid reflow).

## Out of scope
`repeat`/$item card lists (List/Inbox), server-side query overrides, multi-page apps,
record detail drawer, date picker, field-level validation display.
