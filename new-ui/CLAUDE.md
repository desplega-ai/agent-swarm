# Agent Swarm Dashboard (new-ui)

New dashboard UI built with Vite 6 + React 19 + react-router v7 + shadcn/ui + Tailwind CSS v4 + AG Grid.

## Quick Start

```bash
pnpm install
pnpm dev          # Dev server on http://localhost:5274
pnpm build        # Production build
pnpm preview      # Preview production build
```

## Tech Stack

- **Framework**: React 19 + TypeScript
- **Build**: Vite 6
- **Routing**: react-router-dom v7
- **Styling**: Tailwind CSS v4 + shadcn/ui (new-york style)
- **Data Fetching**: @tanstack/react-query (5s auto-polling)
- **Data Grid**: AG Grid Community (Quartz theme)
- **Charts**: Recharts
- **Icons**: Lucide React

## Project Structure

```
src/
  api/            # API client, types, and react-query hooks
    hooks/        # Domain-specific hook files (use-agents, use-tasks, etc.)
    client.ts     # ApiClient singleton
    types.ts      # TypeScript interfaces
  app/            # App shell, providers, router
  components/     # Reusable components
    ui/           # shadcn/ui components
    layout/       # Layout components (sidebar, header)
    shared/       # Shared components
  hooks/          # App-level hooks (theme, config, auto-scroll)
  lib/            # Utilities (cn, formatters, content-preview)
  pages/          # Route pages (one dir per route)
  styles/         # Global CSS, AG Grid theme
```

## Code Style

- Use `@/` path alias for imports
- Use shadcn/ui components from `@/components/ui`
- Use `cn()` for conditional class merging
- API hooks are in `@/api/hooks/`
- Pages use default exports for React.lazy compatibility

## Data Tables (AG Grid)

**Always use AG Grid** (`DataGrid` component from `@/components/shared/data-grid`) for tabular data. Never use HTML `<Table>` components for data lists.

**Key patterns:**
- Import types: `ColDef`, `ICellRendererParams`, `RowClickedEvent` from `ag-grid-community`
- The `DataGrid` wrapper calls `sizeColumnsToFit()` on grid ready — columns fill available width
- Set `width` on columns for initial sizing. Use `flex: 1` + `minWidth` for columns that should stretch
- For pages in the main layout, use `flex flex-col flex-1 min-h-0 gap-4` as the page wrapper — DataGrid fills remaining height
- For config-style pages that scroll, use `domLayout="autoHeight"` on the DataGrid
- Cell vertical centering is handled globally via CSS (`.ag-cell-value { display: flex; align-items: center; }` in `ag-grid.css`)

**Cell renderers:**
- Interactive elements (buttons, links) in cells MUST call `e.stopPropagation()` to prevent row click
- Use `variant="outline"` for action buttons so they're visually distinct/clickable
- Delete buttons: use `AlertDialog` popup for confirmation, not click-again patterns
- Style delete buttons: `border-red-500/30 text-red-400 hover:bg-red-500/10`

**Badge style (consistent across all chips/tags):**
```
text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase
```
Use `Badge variant="outline"` with this className for all tags, status indicators, and chips.

**Theme awareness:**
- Never hardcode dark-mode colors (e.g. `bg-zinc-950`, `text-zinc-400`). Always use CSS variable classes: `bg-background`, `bg-muted`, `text-foreground`, `text-muted-foreground`, `border-border`, etc.

## API Proxy

Dev server proxies `/api/*` and `/health` to `http://localhost:3013` (the API server).
In production, configure `apiUrl` in the config panel or pass `?apiUrl=...&apiKey=...` in URL.

## Theme

"Mission Control" design — clean, information-dense, professional.
- **Base:** Zinc-neutral palette (shadcn/ui v4 oklch tokens)
- **Accent:** Amber as brand `--primary` only — interactive elements, active states
- **Dark mode** is default. Toggle via header button.
- **Typography:** Space Grotesk (sans) + Space Mono (mono). No display fonts.
- **Status colors:** Semantic — emerald (success), amber (active/busy), red (error), zinc (inactive)
- CSS variables defined in `src/styles/globals.css`. AG Grid themed via `src/styles/ag-grid.css`.
