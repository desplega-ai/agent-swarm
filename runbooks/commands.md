# Commands

Every script an agent or a maintainer runs from the repo root. The root `CLAUDE.md` lists only the everyday ones.

| Command | What it does |
|---|---|
| `bun install` | Install deps |
| `bun run start:http` | MCP HTTP server (port 3013). Test or QA boot: prefix `DESPLEGA_TELEMETRY_ENV=test` |
| `bun run dev:http` | Hot reload, portless: `https://api.swarm.localhost:1355` |
| `bun run lint:fix` | Lint and format with Biome |
| `bun run lint:slop` | Anti-slop Oxlint rules (`oxlint.config.ts`) |
| `bun run check:local` | Check loop on your change: frozen install, Biome, `bun check`, drift, affected tests, scoped E2E (`--skip-e2e` skips it) |
| `bun run tsc:check` | Type check with `bun check` (`tsc:check:tsc` runs tsc 5, the CI authority) |
| `bun run test:root` | Root unit tests (`bun run test:root -- src/tests/<file>.test.ts` for one) |
| `bun run e2e:ui` | Playwright UI suite: builds `apps/ui` (`-- --grep @smoke`, `-- --no-build`) |
| `bun run docker:build:worker` | Worker image (full) |
| `bun run docker:build:worker:slim` | Slim worker image (`--target worker-slim`, for CI/E2E) |
| `bun run docker:build:api` | API server image |
| `bun run docker:build:ui` | Dashboard image (`Dockerfile.ui`, nginx) |
| `bun run docs:openapi` | Regenerate `openapi.json` |
| `bun run docs:business-use` | Regenerate `BUSINESS_USE.md` (needs the BU backend) |
| `bun run build:pi-skills` | Regenerate `plugin/pi-skills/` from `plugin/commands/*.md` |
| `bun run build:seed-skill-files` | Regenerate the bundled-file manifest from `templates/skills/*/files/` |
| `docker compose -f docker-compose.local.yml up --build` | Local compose (API + lead + worker, which run in Docker). Run again after a code change |
| `uvx business-use-core@latest server dev` | BU backend on :13370 |
