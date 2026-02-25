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

## API Proxy

Dev server proxies `/api/*` and `/health` to `http://localhost:3013` (the API server).
In production, configure `apiUrl` in the config panel or pass `?apiUrl=...&apiKey=...` in URL.

## Theme

The UI uses a "beehive" theme with amber/gold/honey colors.
Dark mode is default. Toggle via theme button.
CSS variables are defined in `src/styles/globals.css`.
