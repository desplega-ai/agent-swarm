---
date: 2026-08-06T17:12:12Z
topic: "Host-agnostic MCP registry publication"
status: done
---

# Host-agnostic MCP registry publication

## Goal

Add a schema-valid `server.json` with a user-templated remote endpoint and a localhost npm-package endpoint, mark the npm package with its MCP registry name, and add a GitHub OIDC publication workflow. Open a PR without merging it.

## Decisions

- Use a fresh worktree from `origin/main` because the main checkout contains an unrelated user-owned `CLAUDE.md` edit. (assumed)
- Use `https://{swarm_host}/mcp` for the remote leg and `http://localhost:{--port}/mcp` for the package leg so no client endpoint points at Desplega infrastructure. (approved)
- Invoke the official `mcp-publisher` CLI directly from GitHub Actions and skip publication when OIDC authentication is unavailable. (approved)

## Todo

- [x] Confirm the live schema, current package version, CLI flags, and repository workflow conventions.
- [x] Add `server.json`, the `mcpName` ownership marker, and the publication workflow.
- [x] Validate endpoint host neutrality, schema conformance, workflow syntax, and every locally available repository check.
- [x] Run the two-axis review, commit, push, open the PR, and check CI without merging.

## Verification

- `grep -nEi 'desplega|agent-swarm\.dev' server.json`
- `/tmp/mcp-publisher validate`
- `bun install --frozen-lockfile`
- `find . -maxdepth 1 -type f \( -name 'test-*.sqlite' -o -name 'test-*.sqlite-wal' -o -name 'test-*.sqlite-shm' \) -delete`
- Root lint, typecheck, tests, boundary checks, and generated-file freshness checks from `AGENTS.md`
- `(cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b)`
- Actual pre-push hook during `git push`

## Review

- Standards axis: no findings.
- Spec axis: no acceptance violations. The manifest intentionally keeps the approved `--port` default of `3000`; the CLI fallback is `3013`, but the package launch explicitly supplies `--port 3000`, so its command and transport URL agree.
- Local Docker image builds could not start because the worker has no Docker-compatible executable or socket; CI is authoritative for those builds.
