# Agent Swarm Dashboard (new-ui)

React + Vite + shadcn/ui + Tailwind + AG Grid + react-query dashboard for the Agent Swarm API.

<important if="you are running the new-ui dev server, building it, or setting up new-ui locally">

## Quick start

| Command | What it does |
|---|---|
| `pnpm install` | Install dependencies |
| `pnpm dev` | Dev server on http://localhost:5274 |
| `pnpm build` | Production build |
| `pnpm preview` | Preview production build |
| `pnpm lint` / `pnpm lint:fix` | Biome check / auto-fix |
| `pnpm exec tsc --noEmit` | Type check |

Dev server proxies `/api/*` and `/health` to `http://localhost:3013`.

</important>

<important if="you are creating a new file in new-ui/src/ and need to decide where it lives">

## Project structure

```
src/
  api/            # API client + react-query hooks
    hooks/        # One file per domain (use-agents, use-tasks, ...)
    client.ts     # ApiClient singleton
    types.ts
  app/            # App shell, providers, router
  components/
    ui/           # shadcn/ui primitives
    layout/       # Sidebar, header
    shared/       # Cross-page shared components (e.g. DataGrid)
  hooks/          # App-level hooks (theme, config, auto-scroll)
  lib/            # Utilities (cn, formatters, content-preview)
  pages/          # Route pages — one dir per route
  styles/         # Global CSS, AG Grid theme
```

- Pages use **default exports** (required for `React.lazy` in the router).
- Import via `@/` path alias.

</important>

<important if="you are adding or modifying react-query hooks, api calls, or fetch intervals in new-ui">

## Data fetching

- react-query with a **5s auto-polling** default on most list/detail hooks.
- Hooks live under `src/api/hooks/` — one file per domain (e.g. `use-agents.ts`, `use-tasks.ts`).
- API client singleton: `src/api/client.ts`.

</important>

<important if="you are adding or modifying a data table, list, or grid view in new-ui">

## Data tables (AG Grid)

- **Always use `DataGrid`** from `@/components/shared/data-grid`. **Never** use HTML `<Table>` components for data lists — this is a hard rule.
- Page wrapper for grid pages in the main layout: `flex flex-col flex-1 min-h-0 gap-4` (DataGrid fills remaining height).
- For config-style pages that scroll, set `domLayout="autoHeight"` on the DataGrid.
- Sizing: `width` for fixed columns, `flex: 1 + minWidth` for stretch. `DataGrid` calls `sizeColumnsToFit()` on grid ready.
- Interactive elements in cell renderers (buttons, links) MUST call `e.stopPropagation()` to prevent row-click.
- Delete actions use `AlertDialog` confirmation (not click-again patterns).

</important>

<important if="you are rendering a tag, status chip, pill, or small badge in new-ui">

## Tags / status chips

Use the `tag` size on `Badge` — the small-uppercase chip styling (`text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase`) is baked into the component:

```tsx
<Badge variant="outline" size="tag">PENDING</Badge>
<Badge variant="outline" size="tag" className="border-sky-500/30 text-sky-400">QUEUED</Badge>
```

The `variant` controls color/background (outline, default, secondary, destructive, ghost, link). `size="tag"` controls the chip sizing/casing. Combine them — do not re-inline the className.

</important>

<important if="you are rendering a destructive-outline icon or button in new-ui (delete, remove, disconnect)">

## Destructive-outline buttons

Use `variant="destructive-outline"` on `Button` for red-outlined destructive actions (delete, remove, disconnect). The red border/text/hover colors are baked in:

```tsx
<Button variant="destructive-outline" size="icon"><Trash2 /></Button>
<Button variant="destructive-outline" size="sm">Delete</Button>
```

Do not re-inline `border-red-500/30 text-red-400 hover:bg-red-500/10`. Pair with `AlertDialog` for confirmation.

</important>

<important if="you are copying a primitive from ~/Downloads/swarm-design-system or comparing new-ui's components/ui to the brand kit">

## Primitive parity with brand kit

new-ui's primitives in `src/components/ui/` are the **canonical implementation**. The brand kit at `~/Downloads/swarm-design-system/new-ui/src/components/ui/` is a snapshot of an earlier version of new-ui — it is a brand reference, not a build artifact.

Brand-kit divergences are tracked in [`thoughts/taras/research/2026-05-06-design-system-audit.md`](../thoughts/taras/research/2026-05-06-design-system-audit.md) (see "Phase 8 — Primitive parity") and reconciled deliberately. **Do not blindly copy from `~/Downloads/swarm-design-system`** — consult the audit first, especially for the `Button` `destructive-outline` variant where new-ui's status-token form (Phase 4) is canonical and adopting the brand kit's raw `red-*` literals would break the Phase 7 `check:tokens` lint gate.

</important>

<important if="you are writing Tailwind classes, picking colors, or styling components in new-ui">

## Theming

- **Never hardcode dark-mode colors** (no `bg-zinc-950`, `text-zinc-400`, etc.). Use CSS variable classes: `bg-background`, `bg-muted`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-accent`.
- **Amber** is brand `--primary` — use it for interactive / active states only.
- **Status colors come from named semantic tokens** — `bg-status-success`, `text-status-error`, `bg-status-active`, etc. — defined in `src/styles/globals.css` (light + dark). Action-type colors (workflow nodes) come from `bg-action-*` tokens. **Do not** use raw Tailwind palette literals (`bg-emerald-500`, `text-amber-400`, `border-red-500/30`, etc.) in app code. Translucent fills use the standard Tailwind opacity syntax: `bg-status-success/10`, `border-action-script/50`.
- **Color literal lint gate.** `pnpm run check:tokens` (also runs in CI via `merge-gate.yml`'s `new-ui-lint` job) fails the build on any raw Tailwind color palette literal, `dark:` palette variant, arbitrary color literal (e.g. `bg-[#0d1117]`), or hardcoded hex in `src/`. To use a new color, add a token to `src/styles/globals.css`. Monaco editor themes are exempt and live in `src/lib/monaco-themes.ts`.
- CSS variables defined in `src/styles/globals.css`; AG Grid themed via `src/styles/ag-grid.css`.
- Use `cn()` from `@/lib/utils` for conditional class merging.

### Semantic token reference

Status tokens (cover the 18 statuses in `status-badge.tsx`'s `statusConfig` map plus a few extras used by integrations and workflow runs).

`-strong` variants exist for text emphasis on neutral surfaces (one Tailwind stop darker in light mode for contrast). Use `bg-status-X` for fills, `text-status-X-strong` for emphasis text on cards/pages. In dark mode the `-strong` variant collapses to the same `*-400` stop as the canonical token — pixel parity preserved across the existing `bg-{color}-500 + text-{color}-600 dark:text-{color}-400` literal pattern.

| Token | Usage | Light source | Dark source |
|---|---|---|---|
| `status-success` | idle, completed, healthy, approved (fill) | emerald-500 | emerald-400 |
| `status-success-strong` | success-state text emphasis | emerald-600 | emerald-400 |
| `status-active` | busy, offered, in_progress, running (fill) | amber-500 | amber-400 |
| `status-active-strong` | active-state text emphasis | amber-600 | amber-400 |
| `status-error` | failed, unhealthy, rejected (fill) | red-500 | red-400 |
| `status-error-strong` | error-state text emphasis | red-600 | red-400 |
| `status-info` | informational chips (fill) | sky-500 | sky-400 |
| `status-info-strong` | info-state text emphasis | sky-600 | sky-400 |
| `status-pending` | pending, waiting, starting (fill) | yellow-500 | yellow-400 |
| `status-pending-strong` | pending-state text emphasis | yellow-600 | yellow-400 |
| `status-warning` | timeout, threshold-warning (fill) | orange-500 | orange-400 |
| `status-warning-strong` | warning-state text emphasis | orange-600 | orange-400 |
| `status-paused` | paused, reviewing (fill) | blue-500 | blue-400 |
| `status-paused-strong` | paused-state text emphasis | blue-600 | blue-400 |
| `status-neutral` | offline, backlog, unassigned, cancelled, stopped, skipped | zinc-500 | zinc-400 |

Action-type tokens (workflow node types from `components/workflows/action-node.tsx` and `condition-node.tsx`):

| Token | Workflow node type | Light source | Dark source |
|---|---|---|---|
| `action-agent-task` | `agent-task` | violet-500 | violet-400 |
| `action-script` | `script` | cyan-500 | cyan-400 |
| `action-notify` | `notify` | teal-500 | teal-400 |
| `action-human-in-the-loop` | `human-in-the-loop` | orange-500 | orange-400 |
| `action-create-task` | `create-task` | indigo-500 | indigo-400 |
| `action-send-message` | `send-message` | pink-500 | pink-400 |
| `action-delegate-to-agent` | `delegate-to-agent` | purple-500 | purple-400 |
| `action-default` | unknown action fallback | blue-500 | blue-400 |
| `action-property-match` | `property-match` (condition) | amber-500 | amber-400 |
| `action-code-match` | `code-match` (condition) | yellow-500 | yellow-400 |
| `action-raw-llm` | `raw-llm` (condition) | sky-500 | sky-400 |

Each status token has a paired `-foreground` for legible text on the colored fill (e.g. `text-status-success-foreground`). Action tokens do not — workflow nodes pair the colored token with `bg-action-X/10` (translucent fill) and `text-action-X` (text + border).

</important>

<important if="you are rendering any markdown content in new-ui (LLM output, task descriptions, comments, task prompts, etc.)">

## Markdown rendering

Use `<Streamdown>{text}</Streamdown>` from `streamdown` for **all** markdown rendering — LLM output, user-supplied descriptions, anything that may contain markdown. Do not use `react-markdown`.

</important>

<important if="you are debugging API calls from new-ui, changing the dev proxy, or configuring production apiUrl/apiKey">

## API connection

- **Dev:** Vite proxies `/api/*` and `/health` to `http://localhost:3013`.
- **Prod:** configure `apiUrl` in the in-app config panel, or pass `?apiUrl=...&apiKey=...` in the URL.

</important>

<important if="you are preparing a PR that touches new-ui/, or running automated UI tests against new-ui">

## qa-use & PR screenshot requirement

Use `qa-use` for browser automation: `/qa-use:test-run`, `/qa-use:verify`, `/qa-use:explore`. Any PR touching `new-ui/` MUST include a `qa-use` session with screenshots of the changes running locally — enforced by the merge gate. Port-conflict handling: [../LOCAL_TESTING.md § Dashboard UI](../LOCAL_TESTING.md#dashboard-ui).

</important>
