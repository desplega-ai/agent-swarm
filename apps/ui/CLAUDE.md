# Agent Swarm Dashboard (ui)

React + Vite + shadcn/ui + Tailwind + AG Grid + react-query dashboard for the Agent Swarm API.

Provider key rows show compact limits, remaining percentages, and reset countdowns. Put quota explanations and account details in a popover, not expanded rows.

Keep this file small: with the root `CLAUDE.md` it must fit in the 32,768 bytes that Codex loads (`bun run check:agents-md-size`). Reference material lives in [docs/](./docs/).

## Design Context

Strategic design context lives in [PRODUCT.md](./PRODUCT.md) (register, users, positioning, brand personality, design principles) and the visual system in [DESIGN.md](./DESIGN.md) (tokens, typography, elevation, component doctrine). Read them before designing or restyling any UI surface.

<important if="you are building or changing UI in apps/ui">

Load the `dashboard-ui` maintainer skill ([.claude/internal-skills/dashboard-ui/SKILL.md](../../.claude/internal-skills/dashboard-ui/SKILL.md)): more primitives (`SegmentedControl`, `SecretInput`, `StatusIcon`, ...), autosave, motion and layout recipes, interaction rules, and the verification checklist.

</important>

<important if="you are building or changing UI in apps/ui: a page, a component, styles, motion, the session log viewer, or you process in-page review notes">

Before a page, component or style edit, read [docs/primitives.md](./docs/primitives.md) and [docs/theming.md](./docs/theming.md). For the other areas, read the reference before you write code. The last column is the rule that causes damage when missed, not the whole contract.

| Area | Read first | Do not miss |
|---|---|---|
| Pages, layout, components, tags and chips, destructive buttons | [docs/primitives.md](./docs/primitives.md) | Compose from the primitives in `src/components/ui/` and `src/components/shared/` instead of a hand-rolled `<div>` layout. A detail page uses `DetailPageBody` with its rail. Logic that appears at 2 or more call sites moves to `src/lib/` or `src/hooks/`. Chips use `<Badge size="tag">`. Destructive actions use `variant="destructive-outline"` with an `AlertDialog`. `src/components/ui/` is canonical: read the parity section before you copy from the brand kit (`~/Downloads/swarm-design-system`). |
| Tailwind classes, colors, tokens, theme presets | [docs/theming.md](./docs/theming.md) | Use semantic token classes (`bg-background`, `text-muted-foreground`, `bg-status-success`). Palette literals such as `bg-zinc-950` fail `bun run check:tokens`. |
| Animation, transitions, animated icons | [docs/motion.md](./docs/motion.md) | Under 300ms (sheets and drawers: 400ms in, 250ms out), exits faster than enters, `ease-swift` / `ease-snappy`, transform and opacity only, no animation on keyboard-driven or high-frequency interactions. |
| Session log parsing, `SessionLogViewer`, `src/logs-parser` | [docs/session-log-parser.md](./docs/session-log-parser.md) | Harness-specific logic stays inside adapters. Order records by `(createdAt, lineNumber, fileIndex)` before the adapter runs: OpenCode delta reassembly depends on it. After a parser change run `bun run build:claude-mod` from the repo root and commit the bundle. |
| In-page review notes, or a dev server that you start for a UI review (`DEV_NOTES=1 bun run dev`) | [docs/dev-notes.md](./docs/dev-notes.md) | Mark a note done only after the change is verified in the browser. |

</important>

<important if="you are running the ui dev server, building it, or setting up ui locally">

## Quick start

| Command | What it does |
|---|---|
| `bun install` | Install dependencies (run from the repo root: `ui` is a Bun workspace member) |
| `bun run dev` | Dev server on http://localhost:5274 |
| `bun run build` | Production build |
| `bun run preview` | Preview production build |
| `bun run lint` / `bun run lint:fix` | Biome check / auto-fix |
| `bunx tsc --noEmit` | Type check |

Dev server proxies `/api/*` and `/health` to `http://localhost:3013`.

</important>

<important if="you are creating a new file in ui/src/ and need to decide where it lives">

## Project structure

- Pages use **default exports** (required for `React.lazy` in the router).
- Import via `@/` path alias.

</important>

<important if="you are adding or modifying react-query hooks, api calls, or fetch intervals in ui">

## Data fetching

- react-query with a **5s auto-polling** default on most list/detail hooks.
- Hooks live under `src/api/hooks/`, one file per domain (e.g. `use-agents.ts`, `use-tasks.ts`).
- API client singleton: `src/api/client.ts`.

</important>

<important if="you are adding or modifying a data table, list, or grid view in ui">

## Data tables (AG Grid)

- Use `DataGrid` from `@/components/shared/data-grid` for every data list, not HTML `<Table>` components.
- **Phone exception (below `md`):** list pages render `MobileList` + `MobileListRow` from `@/components/shared/mobile-list` instead of the grid, gated with `useIsMobile()`. Keep the `DataGrid` from `md` up, and share filtering and search logic between both so a phone finds the same rows as the grid.
- Page wrapper for grid pages in the main layout: `flex flex-col flex-1 min-h-0 gap-4` (DataGrid fills remaining height).
- For config-style pages that scroll, set `domLayout="autoHeight"` on the DataGrid.
- Sizing: `width` for fixed columns, `flex: 1 + minWidth` for stretch. `DataGrid` calls `sizeColumnsToFit()` on grid ready.
- Interactive elements in cell renderers (buttons, links) call `e.stopPropagation()`, so that they do not trigger the row click.
- Delete actions use `AlertDialog` confirmation (not click-again patterns).

</important>

<important if="you are rendering any markdown content in ui (LLM output, task descriptions, comments, task prompts, etc.)">

## Markdown rendering

Use `<Streamdown>{text}</Streamdown>` from `streamdown` for all markdown rendering (LLM output, user-supplied descriptions, anything that may contain markdown), not `react-markdown`.

</important>

<important if="you are debugging API calls from ui, changing the dev proxy, or configuring production apiUrl/apiKey">

## API connection

- **Dev:** Vite proxies `/api/*` and `/health` to `http://localhost:3013`.
- **Prod:** configure `apiUrl` in the in-app config panel, or pass `?apiUrl=...&apiKey=...` in the URL.

</important>

<important if="you are preparing a PR that touches ui/, or running automated UI tests against ui">

## PR evidence

A PR that changes what the dashboard shows carries screenshots of the change running locally (static/layout changes included), as GitHub user attachments in the PR body's `## Before / after` section. Add a recording only for a new or changed interaction or flow. A new configuration-catalog entry that reuses an existing control shows its key and default as a table, not a screenshot. When nothing visible changes (a type-only refactor, a test fix), write `No visible change: <reason>` there. Capture with the `agent-browser` skill (`qa-use` only when asked). Recipe: [LOCAL_TESTING.md § When you need to verify a UI change](../../LOCAL_TESTING.md#when-you-need-to-verify-a-ui-change). Port conflicts: [LOCAL_TESTING.md § Dashboard UI](../../LOCAL_TESTING.md#dashboard-ui).

## UI E2E

`bun run e2e:ui` (repo root) runs the Playwright suite in `packages/ui-e2e` against a seeded API per worker. Package layout, fixtures, and the seed manifest: [../../packages/ui-e2e/README.md](../../packages/ui-e2e/README.md). Selectors use roles, accessible names, and link or row text (`getByRole`, `getByText`). Tasks, Pages, and Settings carry no `data-testid`; add one only on purpose, never as a shortcut. When a change moves a sidebar route or renames a control, update `packages/ui-e2e/specs/routes.ts` or the flow spec in the same PR.

</important>
