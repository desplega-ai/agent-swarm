# Agent Swarm - New UI

New dashboard UI built with Vite + React 19 + react-router v7 + shadcn/ui + Tailwind CSS v4 + AG Grid Community.

## Quick Reference

```bash
pnpm install              # Install dependencies
pnpm dev                  # Dev server on port 5274
pnpm build                # Production build (tsc + vite build)
pnpm tsc --noEmit         # Type check only
pnpm preview              # Preview production build
```

## Tech Stack

- **Build**: Vite 7 + pnpm
- **Framework**: React 19 + TypeScript (strict)
- **Routing**: react-router-dom v7 (lazy-loaded routes)
- **Styling**: Tailwind CSS v4 + shadcn/ui (new-york style)
- **Data Grid**: AG Grid Community (Quartz theme)
- **Server State**: TanStack React Query (5s polling)
- **Charts**: Recharts
- **Icons**: Lucide React

## Project Structure

```
src/
  api/            # API client, types, and React Query hooks
    hooks/        # Domain-specific hooks (use-agents, use-tasks, etc.)
    client.ts     # ApiClient singleton
    types.ts      # Backend type mirrors
  app/            # App shell (App, providers, router)
  components/     # Reusable components
    layout/       # Sidebar, header, breadcrumbs
    shared/       # Shared components (skeletons, etc.)
    ui/           # shadcn/ui primitives
  hooks/          # Generic hooks (theme, config, auto-scroll)
  lib/            # Utilities (cn, formatRelativeTime, etc.)
  pages/          # Route pages (one folder per route)
  styles/         # Global CSS (theme, AG Grid overrides)
```

## Theme

Uses beehive/honeycomb visual identity with custom CSS variables:
- Dark mode (default): warm amber tones on dark background
- Light mode: `.light` class on `<html>`
- Colors: `--color-hive-amber`, `--color-hive-honey`, etc.
- Fonts: Space Grotesk (sans), Space Mono (mono), Graduate (display)

## API Connection

- Dev: Vite proxies `/api` and `/health` to `localhost:3013`
- Production: Uses configured API URL from localStorage
- Config stored in localStorage key `agent-swarm-config`
- Auto-connect via URL params: `?apiUrl=...&apiKey=...`
