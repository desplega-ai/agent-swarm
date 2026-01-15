# Agent Swarm MCP

Multi-agent orchestration layer for Claude Code, Codex, Gemini CLI. Enables task distribution, agent communication, and service discovery.

## Quick Reference

```bash
bun install               # Install dependencies
bun run start:http        # Run MCP HTTP server (port 3013)
bun run dev:http          # Dev with hot reload
bun run lint:fix          # Lint & format with Biome
bun run tsc:check         # Type check
```

## Tech Stack

- **Runtime**: Bun (not Node.js) - see Bun rules below
- **Language**: TypeScript (strict mode)
- **Linter/Formatter**: Biome (2-space indent, double quotes, 100 line width)
- **MCP SDK**: @modelcontextprotocol/sdk
- **CLI**: Ink (React for terminal)
- **Slack**: @slack/bolt

## Project Structure

```
src/
  http.ts       # Main HTTP server + MCP endpoints
  stdio.ts      # Stdio MCP transport
  cli.tsx       # CLI entry point (Ink)
  tools/        # MCP tool definitions
  be/           # Backend utilities (DB, storage)
  github/       # GitHub webhook handlers
  slack/        # Slack integration
ui/             # Dashboard (separate React app)
```

## Code Style

- Run `bun run lint:fix` before committing
- Use Bun APIs, not Node.js equivalents
- Prefer `Bun.$` over execa for shell commands

## Related

- [UI Dashboard](./ui/CLAUDE.md) - React monitoring dashboard
- [MCP.md](./MCP.md) - MCP tools reference
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Production deployment
- [CONTRIBUTING.md](./CONTRIBUTING.md) - Development setup

---

## Bun Rules

Use Bun instead of Node.js, npm, pnpm, or vite.

- `bun <file>` instead of `node` or `ts-node`
- `bun test` instead of jest/vitest
- `bun install` instead of npm/yarn/pnpm install
- `bun run <script>` instead of npm/yarn run
- Bun auto-loads .env - don't use dotenv

### Bun APIs

- `Bun.serve()` for HTTP/WebSocket. Don't use express/ws.
- `bun:sqlite` for SQLite. Don't use better-sqlite3.
- `Bun.file()` over node:fs for file I/O.
- `Bun.$` for shell commands. Don't use execa.
