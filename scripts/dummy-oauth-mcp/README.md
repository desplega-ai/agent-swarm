# Dummy OAuth MCP Server

A minimal, self-contained MCP server that speaks OAuth 2.1 (PKCE
authorization-code + RFC 7591 Dynamic Client Registration + RFC 8707 resource
indicator + RFC 9728 protected-resource metadata) for exercising the
agent-swarm OAuth MCP client in [PR #357](https://github.com/desplega-ai/agent-swarm/pull/357).

Everything is in-memory — no DB, no external deps beyond what the repo already
uses. Issued codes and tokens are printed to stdout for easy debugging.

## Quick start

```bash
# From the repo root:
bun run scripts/dummy-oauth-mcp/server.ts
# → listens on http://localhost:4455

# Or pick a custom port:
bun run scripts/dummy-oauth-mcp/server.ts 4600
```

Endpoints exposed:

| Endpoint | Purpose |
|---|---|
| `GET  /` | Pointer to discovery URLs |
| `GET  /.well-known/oauth-protected-resource` | RFC 9728 PRMD |
| `GET  /.well-known/oauth-authorization-server` | RFC 8414 AS metadata |
| `POST /register` | RFC 7591 Dynamic Client Registration |
| `GET  /authorize` | Auth-code + PKCE (adds `?auto_approve=1` to skip consent) |
| `POST /token` | `authorization_code` + `refresh_token` grants |
| `POST /revoke` | RFC 7009 revocation |
| `POST /mcp` | MCP streamable HTTP (requires `Authorization: Bearer <token>`) |

Tools exposed by the MCP endpoint:

- `ping` — returns `{ ok, timestamp, echoed, server }`.
- `whoami` — returns the OAuth client bound to the current bearer token.

## Exercising PR #357 against this server

1. **Start the agent-swarm API** as usual (port 3013). Make sure
   `MCP_OAUTH_ALLOW_PRIVATE_HOSTS=true` is set — the SSRF guard in
   `src/oauth/mcp-wrapper.ts` otherwise refuses `localhost` URLs.

   ```bash
   MCP_OAUTH_ALLOW_PRIVATE_HOSTS=true bun run start:http
   ```

2. **Start the dummy server** in a second shell:

   ```bash
   bun run scripts/dummy-oauth-mcp/server.ts
   ```

3. **Register the MCP server** in agent-swarm via the `mcp-server-create`
   tool (or the dashboard). Point it at the dummy's `/mcp` URL with
   `authMethod: "oauth"` and HTTP transport:

   ```bash
   curl -X POST http://localhost:3013/api/mcp-servers \
     -H "Authorization: Bearer 123123" \
     -H "Content-Type: application/json" \
     -d '{
       "name": "dummy-oauth",
       "url": "http://localhost:4455/mcp",
       "transport": "http",
       "authMethod": "oauth"
     }'
   # → {"id": "<mcpServerId>", ...}
   ```

4. **Probe discovery** (optional but reassuring):

   ```bash
   curl -H "Authorization: Bearer 123123" \
     http://localhost:3013/api/mcp-oauth/<mcpServerId>/metadata
   # → includes authorizeUrl=http://localhost:4455/authorize, tokenUrl=.../token,
   #   dcrSupported=true, registrationEndpoint=.../register
   ```

5. **Start the OAuth flow.** Visiting this URL in a browser sends you through
   DCR → `/authorize` (tap "Approve") → `/callback` (agent-swarm exchanges the
   code) → dashboard with `?oauth=success`:

   ```
   http://localhost:3013/api/mcp-oauth/<mcpServerId>/authorize
   ```

   To automate it without a browser (useful for scripts), point the `redirect`
   at a trivial catcher and add `auto_approve=1` by setting the env var
   `DUMMY_OAUTH_AUTO_APPROVE=1` _before_ starting the dummy server, or just
   manually click Approve.

6. **Check token status:**

   ```bash
   curl -H "Authorization: Bearer 123123" \
     http://localhost:3013/api/mcp-oauth/<mcpServerId>/status
   # → { "connected": true, "token": { "status": "connected", ... } }
   ```

7. **Call `ping` through the swarm's `resolveSecrets` path.** The simplest way
   is to fetch the resolved MCP server list for an agent and use the returned
   `Authorization` header to call the dummy `/mcp` directly:

   ```bash
   # Initialize (no Bearer for the first call is OK because agent-swarm's
   # resolveSecrets injects the Bearer for agents that have this MCP assigned).
   # For manual testing, grab the access token from the dummy server's stdout
   # (it prints "access token issued" with the full token) and call:
   TOKEN="at-...from-dummy-logs..."
   curl -X POST http://localhost:4455/mcp \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{
       "jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{
         "protocolVersion":"2025-06-18",
         "capabilities":{},
         "clientInfo":{"name":"curl","version":"0"}
       }
     }'
   # → 200 with "mcp-session-id" response header — use that for subsequent calls.
   ```

   To actually invoke `ping`:

   ```bash
   curl -X POST http://localhost:4455/mcp \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -H "mcp-session-id: $SESSION_ID" \
     -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ping","arguments":{"message":"hi"}}}'
   # → returns { ok: true, timestamp: "...", echoed: "hi", server: "dummy-oauth-mcp" }
   ```

8. **Refresh the token:**

   ```bash
   curl -X POST http://localhost:3013/api/mcp-oauth/<mcpServerId>/refresh \
     -H "Authorization: Bearer 123123"
   # Watch the dummy server's stdout — a new access/refresh pair gets issued.
   ```

9. **Disconnect (revoke + delete):**

   ```bash
   curl -X DELETE http://localhost:3013/api/mcp-oauth/<mcpServerId> \
     -H "Authorization: Bearer 123123"
   ```

## Notes

- Everything is in-memory. Restarting the dummy server drops all clients,
  codes, and tokens; your `mcp_oauth_tokens` rows in the swarm DB will then
  point at refresh tokens the dummy server no longer knows about and will flip
  to `status="error"` on next refresh. Delete + re-connect to recover.
- SSRF guard: the swarm rejects `localhost`/RFC1918 MCP URLs by default. Set
  `MCP_OAUTH_ALLOW_PRIVATE_HOSTS=true` when running locally. This is only
  meant for dev — production uses the default deny-list.
- PKCE method is hard-wired to `S256`; plain is not supported. PR #357's
  client always uses `S256` too.
- DCR-issued client secrets never expire (`client_secret_expires_at: 0`).
- Tokens: access token TTL is 1 hour; refresh token TTL is 24 hours.
  Refresh rotates both (old tokens become invalid).
- This server is strictly a development/testing artifact — it is **not** wired
  into `docker-compose`, `pm2`, or any startup script.
