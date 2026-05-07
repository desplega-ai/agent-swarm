---
description: How to read content from Notion via the swarm's MCP tools — KB lookup, project context, runbooks, customer docs. Phase 1 is read-only; no writes.
---

# Notion Interaction

Use this skill when the swarm needs to read from a connected Notion workspace — searching for pages, fetching content, querying databases, or discovering the schema of a database. Phase 1 of the Notion integration is **read-only**. Writes (page creation, block append, property updates) are scheduled for Phase 2 and **do not exist yet**.

## When to use

- Looking up a known page by title or topic ("find the runbook for X").
- Pulling page content into a task ("summarize the spec at this URL").
- Querying a Notion database that the team uses as a tracker, KB, or source-of-truth ("find all rows where Status = In Progress").
- Discovering what databases the integration has access to.

If the user hasn't connected Notion yet (no token in `oauth_tokens` for `provider='notion'`), the tools return a structured `not_connected` error pointing them at the OAuth flow. Surface that URL to the user; don't try to work around it.

## Auth-status check

Before calling any Notion tool, call `tracker-status`. If the `notion` entry shows `connected: false`, stop and tell the user to visit `<MCP_BASE_URL>/api/trackers/notion/authorize`.

## MCP tools

| Tool | What it returns |
|---|---|
| `notion-search` | Pages and/or databases matching a free-text query. Pass `filter: "page"` or `filter: "database"` to narrow. |
| `notion-get-page` | A single page by ID. Set `includeContent: true` to also flatten the block tree to plaintext (capped via `maxBlocks`). |
| `notion-query-database` | Database rows with the team's filters/sorts. The `filter` and `sorts` shapes match the [Notion API](https://developers.notion.com/reference/post-database-query) verbatim — no translation. |
| `notion-list-databases` | All databases the integration has access to, with a property-name → property-type schema preview. Useful before authoring a `notion-query-database` filter. |

## Common patterns

### Search by title

```
notion-search({ query: "auth runbook", filter: "page", pageSize: 10 })
```

### Fetch a page with body content

```
notion-get-page({ pageId: "<uuid>", includeContent: true, maxBlocks: 100 })
```

### Query a database (e.g. status = In Progress)

```
notion-query-database({
  databaseId: "<uuid>",
  filter: { property: "Status", status: { equals: "In Progress" } },
  sorts: [{ property: "Last edited time", direction: "descending" }],
  pageSize: 50,
})
```

If you don't know the property names, call `notion-list-databases` first to read the schema.

### Discover databases

```
notion-list-databases({ pageSize: 100 })
```

## Error handling

Each tool returns a structured `success: false` object on failure with a `reason` field. Branch on it:

| `reason` | What it means | What to do |
|---|---|---|
| `not_connected` | No OAuth token for Notion. | Tell the user to run OAuth at the URL in `howToFix`. |
| `rate_limited` | Notion 429. `retryAfterSeconds` populated when present. | Wait that many seconds and retry once. Don't hammer. |
| `api_error` | Non-2xx from Notion. `status` and `code` populated. | If `status: 404` → page/db deleted or never shared with the integration. If `status: 403` → integration lacks access; ask the user to share the page in Notion. |
| `unknown_error` | Something else (network, DNS, parse). | Surface the message and stop. |

## Anti-patterns — DO NOT

- **Don't try to write to Notion in Phase 1.** There are no `notion-create-page`, `notion-append-blocks`, or `notion-update-page` tools. They are explicitly Phase 2 work. If a task requires a write, escalate to Lead — don't fake it via a different mechanism.
- **Don't dump full block trees into context.** Pages can be enormous. Set `maxBlocks` to the smallest reasonable value (default 200; cap 500). Summarise instead of pasting.
- **Don't loop without backoff on 429s.** Rate limit is 3 req/sec average per integration. Respect `Retry-After` and consider whether the work can be batched into a single `notion-search` or `notion-query-database` call.
- **Don't use Notion as a tracker yet.** Phase 3 will add `tracker_sync` mappings for Notion DBs. Until then, treat Notion as a knowledge base — read, summarise, cite. Don't create swarm tasks from Notion DB rows.
- **Don't paste page IDs from URLs without dashes** without checking — Notion accepts both, but mixing styles in the same task is a bug magnet. Strip dashes consistently or keep them consistently.

## Connection setup

If the user is setting up Notion for the first time:

1. Create a public integration at https://www.notion.so/my-integrations → choose "Public integration" → set the redirect URI to `<MCP_BASE_URL>/api/trackers/notion/callback`.
2. Set capabilities to **Read content** (Phase 1 only — `Update content` and `Insert content` are recommended even now to avoid a re-consent round-trip when Phase 2 ships).
3. In the swarm, set `NOTION_CLIENT_ID` and `NOTION_CLIENT_SECRET` env vars and restart.
4. Visit `<MCP_BASE_URL>/api/trackers/notion/authorize` in a browser to grant access. Pick which pages to share at consent time.
5. Verify with `tracker-status` — the `notion` entry should show `connected: true`.

## References

- [Notion API intro](https://developers.notion.com/reference/intro)
- [Notion OAuth flow](https://developers.notion.com/docs/authorization)
- [Database query reference](https://developers.notion.com/reference/post-database-query)
- Swarm integration page: `/docs/integrations/notion`
