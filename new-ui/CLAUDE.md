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

<important if="you are writing Tailwind classes, picking colors, or styling components in new-ui">

## Theming

- **Never hardcode dark-mode colors** (no `bg-zinc-950`, `text-zinc-400`, etc.). Use CSS variable classes: `bg-background`, `bg-muted`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-accent`.
- **Amber** is brand `--primary` — use it for interactive / active states only.
- **Status colors** (semantic): emerald (success), amber (active/busy), red (error), zinc (inactive).
- CSS variables defined in `src/styles/globals.css`; AG Grid themed via `src/styles/ag-grid.css`.
- Use `cn()` from `@/lib/utils` for conditional class merging.

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
