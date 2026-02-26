# Agent Swarm Dashboard

React-based monitoring dashboard for Agent Swarm. Displays agents, tasks, channels, and services in real-time.

## Quick Reference

```bash
cd ui
bun install               # Install dependencies (or pnpm)
bun run dev               # Dev server at localhost:5174
bun run build             # Production build
bun run typecheck         # TypeScript check
```

## Tech Stack

- **Framework**: React 19 + Vite
- **UI Library**: MUI Joy
- **Styling**: Tailwind CSS + Emotion
- **Data**: TanStack React Query
- **Markdown**: react-markdown + remark-gfm

## Project Structure

```
src/
  App.tsx           # Root component with config modal
  main.tsx          # Entry point
  components/
    Dashboard.tsx   # Main layout
    AgentsPanel.tsx # Agent list
    TasksPanel.tsx  # Task list
    ChatPanel.tsx   # Channel messaging
    ServicesPanel.tsx # Service registry
  hooks/            # React Query hooks
  lib/              # API client, config
  types/            # TypeScript definitions
```

## Development

- API proxy configured to `localhost:3013` (MCP server)
- Start MCP server first: `bun run start:http` (from root)
- Uses `@/` path alias for imports from `src/`

## Related

- [Root CLAUDE.md](../CLAUDE.md) - Backend MCP server
- [UI.md](../UI.md) - Additional UI documentation
