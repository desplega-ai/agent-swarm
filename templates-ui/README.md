# Agent Swarm Templates UI

Next.js app for browsing and configuring agent swarm worker templates.

## Features

- **Template Gallery** — Browse all available templates with search and filters
- **Template Detail** — View template files with placeholder highlighting
- **Docker Compose Builder** — Interactive UI to configure a swarm and generate docker-compose + .env files
- **API Routes** — JSON API for workers to fetch templates at boot time

## Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Build

```bash
npm run build
```

The `prebuild` script copies templates from `../templates/` into `src/data/templates/` for deployment.

## API

- `GET /api/templates` — List all templates (config only)
- `GET /api/templates/official/coder` — Full template with file contents
- `GET /api/templates/official/coder@1.0.0` — Specific version

All responses include CORS headers.

## Worker Integration

Workers use `TEMPLATE_ID` env var to fetch template content on first boot:

```env
TEMPLATE_ID=official/coder
TEMPLATE_REGISTRY_URL=https://templates.agent-swarm.dev
```

Templates are cached locally for 24 hours. If the registry is unreachable, the worker falls back to generic defaults.
