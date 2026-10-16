# Cohesivity

Cohesivity (https://cohesivity.ai) provisions backend services for an app you are building: Postgres, Redis, object and vector storage, hosting, login, realtime, an email inbox and AI model APIs, all behind one HTTP API. A new project needs no account or API key. Index of every service: https://cohesivity.ai/llms.txt

Use it when a task needs a database, hosting or another backend for an app and the repo has not already picked a provider. If the repo uses Supabase, Firebase or its own cloud account, use that instead and stop here.

## Step 1. Reuse the swarm's tenant

A tenant is one Cohesivity project. The swarm shares one tenant, stored in swarm config, so every agent works against the same backend:

```bash
mcp__agent-swarm__get-config(key="COHESIVITY_TENANT_ID", includeSecrets=true)
```

| Key | Used for |
|---|---|
| `COHESIVITY_TENANT_ID` | Identifies the tenant in management calls |
| `COHESIVITY_MANAGEMENT_KEY` | Control plane: `https://cohesivity.ai/api/*`, sent as `Authorization: Bearer` |
| `COHESIVITY_APPLICATION_KEY` | Data plane: `https://cohesivity.ai/edge/*`, called from the app's server code |

If the keys exist, use them and skip Step 2. Rows saved with `set-config` reach your shell env from your next task; in the current task, read the values from `get-config`.

## Step 2. Create the tenant (once per swarm)

Creating a tenant changes external state. Do it only when the request asks for a backend or a human approves it. One call to Cohesivity's hosted MCP server returns the credentials:

```bash
curl -sS https://cohesivity.ai/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'User-Agent: agent-swarm' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_tenant","arguments":{"confirmed":true,"attribution":"gh-agent-swarm"}}}' \
  | jq -r '.result.structuredContent.credentials_file.content' > /tmp/cohesivity.env
```

The file holds `tenant_id=`, `coh_management_key=` and `coh_application_key=` lines. Save each one with `set-config` (`scope="global"`, `isSecret=true`) under the three keys above, then delete `/tmp/cohesivity.env`.

Each call creates a new tenant. If the result is unclear, check swarm config again before retrying. New tenants are ephemeral: they expire after 72 hours unless claimed (Step 5).

## Step 3. Provision a service

Read the service's live page before using it: `https://cohesivity.ai/offerings/<name>`, for example `/offerings/postgres`. It has the exact request, limits and quirks. Then provision with the management key:

```bash
curl -sS -X POST https://cohesivity.ai/api/resources/postgres \
  -H "Authorization: Bearer $COHESIVITY_MANAGEMENT_KEY" -H 'User-Agent: agent-swarm'
```

The response reports `"status": "active"` once the service is ready. Services include `postgres`, `redis`, `object-storage`, `vector-database`, `inbox`, `railway-hosting`, `cloudflare-workers`, `realtime`, `social-login` and `openai-api`.

## Step 4. Use it from the app

The app calls `https://cohesivity.ai/edge/<service>` from server-side code with the application key. For Postgres:

```bash
curl -sS -X POST "https://cohesivity.ai/edge/postgres?key=$COHESIVITY_APPLICATION_KEY" \
  -H 'Content-Type: application/json' -H 'User-Agent: agent-swarm' \
  -d '{"query":"SELECT now() AS ts","params":[]}'
```

Give the app its keys through a gitignored `.env` or `.cohesivity` file, or the host's env vars. Never commit them, and never put either key in browser or mobile code.

## Step 5. Keep the project

When a human wants to keep the backend past 72 hours, call `claim_tenant` and send them the approval URL it returns. Claiming is their decision, so ask first:

```bash
curl -sS https://cohesivity.ai/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'User-Agent: agent-swarm' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"claim_tenant\",\"arguments\":{\"tenant_id\":\"$COHESIVITY_TENANT_ID\",\"coh_management_key\":\"$COHESIVITY_MANAGEMENT_KEY\",\"confirmed\":true}}}"
```

## Quick gotchas

- Send an explicit `User-Agent` on every request. Cohesivity sits behind Cloudflare, which rejects Python `urllib`'s default with `HTTP 403` and the body `error code: 1010`.
- Paid actions and plan upgrades need a human's approval. Pricing: https://cohesivity.ai/pricing
- `/edge/*` calls belong in server code. For a static site, provision `cloudflare-workers` as the server tier.
- To report a Cohesivity problem, call the `give_feedback` tool the same way as `claim_tenant`, with a `feedback` string in place of `confirmed`.
