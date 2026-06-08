---
name: composio
description: Use Composio from Agent Swarm via the `agent-swarm x composio` CLI route or the `swarm_x` MCP tool. Trigger when a task needs connected third-party app tools such as Gmail, GitHub, Slack, Notion, or HubSpot through Composio Tool Router sessions, Connect Links, or connected accounts. This is the HUB skill — for Google apps see the sibling skills `composio-gmail`, `composio-google-calendar`, `composio-google-docs`.
---

# Composio

Hub skill for Composio-managed third-party app access from the swarm.
The supported surface is the Agent Swarm `x` route:

- CLI: `agent-swarm x composio <METHOD> <path> [--body '<json>']`
- MCP: `swarm_x` with `target: "composio"`

`COMPOSIO_API_KEY` is deployment-scoped and injected by the CLI/API process — you
never pass or see it. All paths are **relative** Composio REST paths.

> **Per-app playbooks (verified slugs + argument shapes + gotchas):**
> [[composio-gmail]] · [[composio-google-calendar]] · [[composio-google-docs]].
> Read the sibling skill for the app you're touching — it lists the verified tool
> slugs so you don't have to `/search` blind.

## Core Model

- **`user_id`** is the app user whose connected accounts are used. We use the
  person's **email** as `user_id` (e.g. `t@desplega.ai`). There is **no explicit
  "create user" call** — a user is created implicitly the first time you reference
  its `user_id` (e.g. when you create a Connect Link). Don't look for a
  `POST /users` endpoint; it doesn't exist in this flow.
- **Auth config** (`ac_…`) = a project-level OAuth app config (one per toolkit,
  set up in the Composio dashboard). A project can have several.
- **Connected account** (`ca_…`) = a specific user's authorized connection to a
  toolkit. Persists across sessions under that `user_id`.
- **Connect Link** = the short-lived URL the user clicks to authorize OAuth.
- **Tool Router session** = a task/conversation runtime context that auto-resolves
  the right connected account for a toolkit set. Reuse its `session_id`; create a
  new one if the user, toolkit set, auth config, or pinned account changes.

## Two ways to call a tool — and when to use each

1. **Tool Router session** (`/tool_router/session…`) — best for multi-turn agent
   work over a toolkit set. Auto-resolves connections, supports in-session
   `/search`. **But** it can fail with `ToolRouterV2_NoActiveConnection` (code
   4302) when stale/duplicate accounts shadow the good one (see Gotchas).
2. **Direct execute** (`POST /tools/execute/<TOOL_SLUG>`) — best for one-off reads,
   verification, or when the session reports no active connection. Pin the account
   explicitly with `connected_account_id`. **This is the reliable path** when a
   user has exactly one good connection per toolkit.

```bash
agent-swarm x composio POST /tools/execute/GMAIL_FETCH_EMAILS \
  --body '{"user_id":"t@desplega.ai","connected_account_id":"ca_xlWpkPocZSGr","arguments":{"max_results":3,"include_payload":false,"verbose":false}}'
```

## Recipe A — Register a user + send Connect Links (one per toolkit)

1. **List the project's auth configs** to get the `ac_…` ids:
   ```bash
   agent-swarm x composio GET "/auth_configs" \
     | jq -r '.items[] | "\(.toolkit.slug)\t\(.id)\t\(.name)"'
   ```
2. **Create one Connect Link per auth config** (flat payload — the user is created
   implicitly here):
   ```bash
   agent-swarm x composio POST /connected_accounts/link \
     --body '{"auth_config_id":"ac_isRh2iU0Z0lM","user_id":"t@desplega.ai"}'
   # → returns { redirect_url / connect_url: "https://connect.composio.dev/link/lk_…" }
   ```
   - **Use `/connected_accounts/link`, NOT `POST /connected_accounts`.** The older
     path now returns 400 for Composio-managed OAuth configs.
   - **There is no single bundled URL** for multiple toolkits — Composio issues
     **one link per toolkit**. Send all of them, labelled per app.
3. **Links expire ~10 minutes** after creation (link-start token TTL).
   **Regenerate fresh links immediately before posting** to the user, and tell
   them the expiry. Offer to regenerate on request.
4. The user clicks each link and authorizes. Connections then show as `ACTIVE`.

## Recipe B — Verify connections / check status

```bash
agent-swarm x composio GET "/connected_accounts?user_id=t@desplega.ai" \
  | jq -r '.items[] | "\(.toolkit.slug)\t\(.id)\t\(.status)"'
```
Look for `status: ACTIVE`. Anything `INITIALIZING`/`FAILED`/`EXPIRED` is not
usable. Pin the `ca_…` of the ACTIVE account when calling tools directly.

## Recipe C — Link a Composio connection to a swarm user identity

"Add the composio connection to my user as identity" → `manage-user` with
`action: update` and the `identities` array.

> **CRITICAL: `identities` is declarative (the desired *full* set).** You MUST
> pass every existing externalId PLUS the new one, or the omitted ones get
> removed. First read the current identities (`resolve-user` / get the user),
> then write the full list back.

```jsonc
// manage-user action:update
{
  "userId": "4dacc65cdab044a6805b2aa0342331b7",
  "identities": [
    { "kind": "github",   "externalId": "tarasyarema" },
    { "kind": "slack",    "externalId": "U08NR6QD6CS" },
    { "kind": "linear",   "externalId": "…" },
    { "kind": "kapso",    "externalId": "…" },
    { "kind": "composio", "externalId": "t@desplega.ai" }   // ← the new one
  ]
}
```
Confirm with `resolve-user(kind:composio, externalId:"t@desplega.ai")`.

## Workflow (Tool Router session path)

1. Create or reuse a Tool Router session for the user + toolkit set.
2. `/search` before executing — get the current slug, schema, plan, pitfalls,
   and connection status. (The sibling skills list verified slugs so you can
   often skip the search.)
3. If Composio reports no active connection, run `COMPOSIO_MANAGE_CONNECTIONS`
   for the exact toolkit names, share the Connect Link, and pause for auth.
4. Retry only after the toolkit shows an ACTIVE connected account.
5. Prefer metadata-first reads (`include_payload:false`, `verbose:false`) unless
   the user explicitly needs bodies/attachments/full records.
6. Paginate on `nextPageToken` / cursors.

```bash
# Create a Gmail-scoped session
agent-swarm x composio POST /tool_router/session \
  --body '{"user_id":"t@desplega.ai","toolkits":{"enable":["gmail"]},"workbench":{"enable":false}}'

# Search for the right tool
agent-swarm x composio POST /tool_router/session/$SESSION_ID/search \
  --body '{"queries":[{"use_case":"Check recent emails and return metadata only."}]}'

# Connect a toolkit if needed
agent-swarm x composio POST /tool_router/session/$SESSION_ID/execute \
  --body '{"tool_slug":"COMPOSIO_MANAGE_CONNECTIONS","arguments":{"toolkits":["gmail"]}}'
```

## Discovering tools for any toolkit

The sibling skills cover the Google apps. For any other toolkit, list its tools:
```bash
agent-swarm x composio GET "/tools?toolkit_slug=<slug>&limit=100" \
  | jq -r '.items[] | "\(.slug)\t\(.name)"'
```
Inspect a tool's arguments before calling:
```bash
agent-swarm x composio GET "/tools?toolkit_slug=<slug>&limit=200" \
  | jq '.items[] | select(.slug=="<SLUG>") | {required:.input_parameters.required, props:(.input_parameters.properties|keys)}'
```

## Gotchas

- **`ToolRouterV2_NoActiveConnection` (4302) despite an ACTIVE account.** Cause:
  stale `INITIALIZING` duplicate accounts (leftover from regenerated Connect
  Links) shadow the good one; the session auto-resolves the wrong account and
  in-session `/search` returns empty. **Fix:** use direct
  `POST /tools/execute/<SLUG>` with the ACTIVE `connected_account_id` pinned
  (Recipe B → the `ca_…`). Long-term fix is deleting the stale duplicates — but
  **ask the user before deleting any connection.**
- **Calendar "from a year ago" trap** — `GOOGLECALENDAR_EVENTS_LIST` has **no
  default `timeMin`**, so it returns old events. Always pass `timeMin` (now,
  RFC3339), `singleEvents:true`, `orderBy:"startTime"`. See [[composio-google-calendar]].

## Guardrails

- Never invent tool slugs or argument shapes. Use the sibling skills, `/search`,
  or `GET /tools?toolkit_slug=…`.
- Never pass absolute URLs as Composio paths — relative API paths only.
- Do not expose `COMPOSIO_API_KEY`; server-side code injects it.
- Do not fetch email bodies/attachments or run destructive/write tools unless the
  task explicitly requires them.
- If multiple accounts exist for a toolkit, ask which to use or pin the specific
  connected account per the task. **Ask before deleting any connection.**
