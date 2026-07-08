---
date: 2026-07-08T03:10:00Z
topic: "QA report — Script Connections MVP (OpenAPI-by-URL, OAuth bindings, ctx.mcp, GraphQL)"
status: complete
author: Claude (orchestrator)
tags: [qa, scripts-runtime, script-connections, credential-broker, oauth, mcp, graphql]
---

# QA Report — Script Connections MVP

**Branch:** `feat/script-connections-mvp` (worktree `/Users/taras/Documents/code/agent-swarm-cdx-connections`)
**Plan:** `thoughts/shared/plans/2026-07-08-script-connections-mvp.md`
**Commits:** `250433ca` (P1) → `eb2ddf97` (P2) → `6aee065c` (P3) → `ee2c3434` (P4) → `8f4ed60c` (P5) → `605b2d47` (E2E fix)

## Automated verification (CI mirror, run independently by orchestrator)

| Check | Result |
|---|---|
| `bun run lint` | PASS (1111 files) |
| `bun run tsc:check` | PASS |
| `bun test` (full) | PASS — 5930+ pass, 0 branch-caused failures¹ |
| `check-db-boundary.sh` / `check-api-key-boundary.sh` | PASS |
| `check:dep-graph` | PASS (warnings pre-existing) |
| `check:rbac-coverage` | PASS (40 verbs, 163 non-GET routes) |
| `check-sdk-tool-registration` | PASS (104 registered / 15 excluded) |

¹ Two full-suite failures (`agentmail-filters`, `seed-scripts` 5s-timeout + knock-on idempotency assert) reproduced as load-induced flakes: both pass in isolation, the involved files have zero diff vs main, and the branch runs the seed-scripts file *faster* than main (28.7s vs 41.8s). Codex's own full-suite rerun was fully green.

## Manual E2E (live server, scratch DB, worktree build)

All via real MCP tool calls (`/mcp`, bearer + `X-Agent-ID`, lead agent created over REST `POST /api/agents`).

1. **OpenAPI by URL** — `script-connections upsert-openapi` with `openapiSpecUrl: petstore3.swagger.io/api/v3/openapi.json` → `sourceKind: url`, 19 typed operations generated, `generationError: null`; `refresh` action succeeds (server returns no ETag, so the 304 path is unit-tested only). Script run `ctx.api.petstore.getInventory({})` → **live inventory JSON** (`approved/placed/delivered`).
2. **OAuth bindings** — `oauth-app-upsert` (provider `github-e2e`) + `oauth-authorize-url` returns a correct authorize URL with server-computed redirect_uri. Binding `{configKey: GH_OAUTH_E2E, authKind: oauth}` shows `tokenStatus: ok` after a token row exists; script sending `Authorization: Bearer [REDACTED:GH_OAUTH_E2E]` reached a local echo API with the **real token substituted at egress** (`authSuffix` matched, placeholder never left the machine unsubstituted). Generic callback route is live (`GET /api/oauth/github-e2e/callback` → 400 `Invalid or expired OAuth state` on bogus input).
   *Security note:* the auto-mode classifier (correctly) refused persisting a live GitHub PAT into `oauth_tokens`, so the token used was a fake seeded row — the resolution path exercised is identical; only "GitHub accepts the token" is unverified (covered by the OAuth wrapper's existing tests).
3. **ctx.mcp** — registered the swarm itself as an external MCP server (`headerConfigKeys` secret auth). `upsert-mcp` dialed it, discovered **116 tools**, generated typed methods from real inputSchemas. Script run `ctx.mcp.swarmself.getSwarm({})` returned live data through the server-side proxy — credentials never entered the script subprocess.
4. **GraphQL** — `upsert-graphql` for `countries.trevorblades.com`; script `ctx.api.countries.graphql('query { country(code: "UA") { name capital } }')` → `{country: {name: "Ukraine", capital: "Kyiv"}}`.
5. **Existing-DB migration** — built a genuine pre-branch DB by booting main's server (migrations → 108), seeded a `script_connections` row + binding, booted the worktree server: applied exactly `109_oauth_credential_bindings` + `110_script_connections_graphql`, rows survived, rebuilt CHECK accepts `graphql`, binding defaulted `auth_kind='config'`.
6. **Secret hygiene** — a script that `console.log`s the raw token literal gets it scrubbed in returned stdout: `[REDACTED:GH_OAUTH_E2E]` (volatile-secret scrubber path).

## Bug found & fixed during E2E

`ctx.api` operation URLs dropped the base path prefix (`new URL("/store/inventory", ".../api/v3/")` → `/store/inventory`), breaking every OpenAPI connection whose baseUrl has a path. Latent since PR #838 — unit fixtures used root-based baseUrls. Fixed in `605b2d47` with a regression test.

## Known gaps / follow-ups (deliberate MVP scope)

- `oauth_tokens` remain plaintext at rest (parity with Linear); `TODO(secrets-cipher)` left in code.
- OpenAPI specs must be JSON (YAML rejected with a clear error; `Bun.YAML` fallback when available).
- `agent_fs` spec source kind still dormant.
- GraphQL results untyped (no introspection codegen).
- ctx.mcp tool results returned as raw MCP envelopes (`{content, structuredContent}`).
- Browser-based OAuth authorize→callback round-trip not exercised live (route + exchange covered by unit tests).
