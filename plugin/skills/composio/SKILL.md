---
name: composio
description: Use Composio from Agent Swarm via the `agent-swarm x composio` CLI route or the `swarm_x` MCP tool. Trigger when a task needs connected third-party app tools such as Gmail, GitHub, Slack, Notion, or HubSpot through Composio Tool Router sessions, Connect Links, or connected accounts.
---

# Composio

Use this skill when a task needs Composio-managed third-party app access.
The current supported surface is the Agent Swarm `x` route:

- CLI: `agent-swarm x composio <method> <path> [options]`
- MCP: `swarm_x` with `target: "composio"`

## Core Model

- `COMPOSIO_API_KEY` is deployment-scoped and injected by the CLI/API process.
- `user_id` is the app user whose connected accounts should be used.
- Connected accounts persist under that `user_id` across sessions.
- Tool Router sessions are task/conversation runtime contexts. Store and reuse
  the `session_id` for follow-up turns; create a new session if the user,
  toolkit set, auth config, or pinned connected account changes.
- Sessions do not expire, but Connect Links and incomplete connection attempts
  expire quickly. If a connection is missing or expired, initiate a new link.

## Workflow

1. Create or reuse a Tool Router session for the target user and toolkit set.
2. Search before executing. Use `/search` to get the current tool slug, schema,
   plan, pitfalls, and connection status.
3. If Composio reports no active connection, execute
   `COMPOSIO_MANAGE_CONNECTIONS` for the exact toolkit names it returned.
4. Share the returned Connect Link with the user and pause until they complete
   auth.
5. Retry the app tool only after the toolkit shows an active connected account.
6. Prefer metadata-first reads (`include_payload:false`, `verbose:false`) unless
   the user explicitly needs bodies, attachments, or full records.
7. Paginate when Composio returns `nextPageToken`, cursors, or continuation
   fields.

## CLI Examples

Create a Gmail-scoped session:

```bash
agent-swarm x composio POST /tool_router/session \
  --body '{"user_id":"swarm-user-id","toolkits":{"enable":["gmail"]},"workbench":{"enable":false}}'
```

Search for the right Gmail tool:

```bash
agent-swarm x composio POST /tool_router/session/$SESSION_ID/search \
  --body '{"queries":[{"use_case":"Check recent emails in Gmail and return metadata only."}]}'
```

Connect Gmail if needed:

```bash
agent-swarm x composio POST /tool_router/session/$SESSION_ID/execute \
  --body '{"tool_slug":"COMPOSIO_MANAGE_CONNECTIONS","arguments":{"toolkits":["gmail"]}}'
```

Fetch lightweight email metadata after connection:

```bash
agent-swarm x composio POST /tool_router/session/$SESSION_ID/execute \
  --body '{"tool_slug":"GMAIL_FETCH_EMAILS","arguments":{"user_id":"me","max_results":5,"include_payload":false,"verbose":false}}'
```

## MCP Example

```jsonc
// Tool call: swarm_x
{
  "target": "composio",
  "method": "POST",
  "path": "/tool_router/session/$SESSION_ID/execute",
  "body": {
    "tool_slug": "GMAIL_FETCH_EMAILS",
    "arguments": {
      "user_id": "me",
      "max_results": 5,
      "include_payload": false,
      "verbose": false
    }
  }
}
```

## Guardrails

- Never invent tool slugs or argument shapes. Use `/search` and returned schemas.
- Never pass absolute URLs as Composio paths. Use relative API paths only.
- Do not expose `COMPOSIO_API_KEY`; server-side code injects it.
- Do not fetch email bodies, attachments, or destructive tool actions unless the
  task explicitly requires them.
- If multiple accounts exist for a toolkit, ask which account to use or pin the
  specific connected account/session account according to the task.
