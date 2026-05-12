# Pages — DB-backed Static Artifacts

DB-backed static content (HTML or JSON) served by the API directly. Cheap,
versioned, share-able by URL. The lighter-weight cousin of `artifacts` —
no PM2, no tunnels, no port allocation, no `services` registry row.

> **Capability gate**: the `create_page` MCP tool is only available when the
> agent's `CAPABILITIES` env var includes `pages`
> (e.g. `CAPABILITIES=core,task-pool,pages`). If the tool is missing from
> your MCP list, this is why.

## When to use Pages vs Artifacts

| You need… | Use |
|---|---|
| A static HTML report / dashboard | **Pages** |
| A JSON status payload + a few buttons that call swarm APIs | **Pages** (`contentType: 'application/json'`) |
| To share an output via a URL with no server logic | **Pages** |
| Custom routes, websockets, server-side logic | **Artifacts** (`plugin/skills/artifacts/skill.md`) |
| File uploads or per-request computation | **Artifacts** |

Rule of thumb: if the content is a snapshot (you can write the full HTML/JSON
in a single call), use pages. If the content is a *running program*, use
artifacts.

## Quick Start

### Public HTML report
```jsonc
// Tool call: create_page
{
  "title": "Q2 Status Report",
  "description": "Roll-up of in-flight tasks across the swarm",
  "contentType": "text/html",
  "authMode": "public",
  "body": "<!doctype html><html><body><h1>Q2 Status</h1>...</body></html>"
}
// → { id, version: 1, app_url, api_url }
```

Share `app_url` (the SPA route) for the general case; share `api_url` for a
no-SPA-required direct link.

### Authed JSON dashboard
```jsonc
// Tool call: create_page
{
  "title": "Agent Inbox",
  "description": "Live tasks for me",
  "contentType": "application/json",
  "authMode": "authed",
  "body": "{\"$schema\":\"...\",\"type\":\"page\",\"children\":[{\"type\":\"text\",\"value\":\"Hello\"},{\"type\":\"button\",\"label\":\"Refresh\",\"action\":{\"swarm.call\":{\"method\":\"GET\",\"endpoint\":\"/api/tasks?status=in_progress\"}}}]}"
}
// → { id, version: 1, app_url, api_url }
```

`authed` pages require a viewer to be signed in to the SPA (or to mint a
page-session cookie via the launch endpoint) before the page can call the
swarm API.

## Auth Modes

| Mode | URL behavior | When to use |
|---|---|---|
| `public` | No gate. Anyone with the URL sees the content. Browser SDK calls **return 401** (no viewer identity → no API access). | Static reports, marketing pages, anything safe to share externally. |
| `authed` | SPA `app_url` works for any signed-in dashboard user. Direct `api_url` requires a `page_session` cookie (mint via `POST /api/pages/:id/launch`). Browser SDK calls run as the viewing user. | Per-team dashboards, JSON pages with action buttons. |
| `password` | `?key=<password>` or HTTP Basic on `/p/:id` unlocks. Once unlocked, behaves like `authed` (cookie minted, SDK calls run as viewer's identity). | Pages shared with non-swarm users (clients, contractors). |

> Password unlock has to happen on `/p/:id` directly (the API origin) because
> the password isn't sent to the SPA. Sharing an `app_url` for a `password`
> page works but the SPA will redirect the iframe through `/p/:id` for the
> Basic prompt.

## URL Shapes

| URL | Shape | Notes |
|---|---|---|
| `app_url` | `${UI_URL}/artifacts/:id` | SPA route. Renders HTML in a sandboxed iframe, JSON via `@json-render/react`. Default share target. |
| `api_url` | `${API_URL}/p/:id` | Direct API render. HTML inlines and serves; JSON 302-redirects to `app_url`. Useful for no-SPA-required links. |

**Default**: share `app_url`. Only use `api_url` when you specifically need a
link that bypasses the SPA (e.g. embedding in Slack, where Slack's unfurl
preview only follows the API origin).

## Versioning

Every overwrite (update via `update_page` or `PUT /api/pages/:id`) snapshots
the **pre-update** state into `page_versions` and writes the new state to the
parent row. The wire `version` field is a monotonically-increasing
"edit counter" — version 1 is the initial create.

| Operation | Endpoint | Returns |
|---|---|---|
| List versions | `GET /api/pages/:id/versions` | `{ versions: PageVersion[] }` newest first |
| Read a version | `GET /api/pages/:id/versions/:version` | Single snapshot |

Snapshots are full body copies — keep this in mind for large pages (the
per-version body cap is 5 MiB).

## Browser SDK

For `text/html` pages, the same `window.SwarmSDK` from the artifact subsystem
is auto-injected. Methods: `createTask`, `getTasks`, `getTaskDetails`,
`storeProgress`, `postMessage`, `readMessages`, `getSwarm`, `listServices`,
`slackReply`. Inline usage:

```html
<script>
  const swarm = new SwarmSDK();
  const tasks = await swarm.getTasks({ status: 'in_progress' });
  // render...
</script>
```

> **`public` pages cannot call authed endpoints.** No cookie is minted on a
> public page load → SDK calls 401. If your page needs to call swarm APIs,
> use `authed` (or `password`).

The SDK talks to the swarm API via the `/@swarm/api/*` proxy on the API
origin. The proxy resolves the `page_session` cookie to a user identity and
forwards with proper auth headers — agent-side credentials are never exposed
to the browser.

## JSON Renderer

JSON pages are rendered via [`@json-render/react`](https://json-render.dev)
with a custom `swarm.call` action handler. Action shape:

```jsonc
{
  "type": "button",
  "label": "Reassign",
  "action": {
    "swarm.call": {
      "method": "POST",
      "endpoint": "/api/tasks/abc/reassign",
      "body": { "agentId": "xyz" }
    }
  }
}
```

`swarm.call` dispatches through the SPA's bearer (for `app_url` loads) or
the page-session cookie (for direct `api_url` loads). The endpoint must be
a valid swarm API path — there is no allowlist, but the viewer's identity
bounds what the call can do.

See the `@json-render/core` docs for the supported node types (`text`,
`button`, `input`, `card`, etc.).

## Security & Blast Radius

- Declared actions on `authed` / `password` pages run with the **viewer's**
  identity, not the page author's. A button that says "Delete all tasks"
  will delete the viewer's tasks if the viewer clicks it.
- Treat agent-generated HTML / JSON like trusted code — the agent already
  has equivalent MCP access, so a malicious page is no worse than a
  malicious tool call. But: don't ship pages to **external** users (via
  `password`) without reviewing the body first.
- HTML pages render inside a sandboxed iframe with
  `sandbox="allow-scripts allow-forms allow-same-origin"`. This limits
  some attack surface (no top-level navigation, no pointer-lock) but the
  page still has full access to the SwarmSDK if cookies are present.
- All page bodies pass through `scrubSecrets` at the egress boundary
  (`/p/:id`, `/p/:id.json`, listing endpoint) — accidental secrets in
  the body get masked at serve time, not at write time. Don't rely on
  scrubbing as a security boundary — keep secrets out of bodies.

## Limits

- **Body size**: 5 MiB per version (HTML or JSON). Bumping requires careful
  thought about SQLite write-amplification — full bodies are snapshotted on
  every update.
- **TTL**: none. Pages persist until explicitly deleted via `DELETE
  /api/pages/:id` (or the SPA listing UI when it gains a delete affordance).
- **Per-agent quota**: none in v1. Be considerate.
- **Slug uniqueness**: scoped to `(agentId, slug)`. Two agents can both
  have a `status-report` page without colliding.

## See Also

- `plugin/skills/artifacts/skill.md` — full custom Hono apps with PM2 +
  tunneled subdomain. Use for interactive servers, not static content.
- `runbooks/secret-scrubbing.md` — egress scrubbing details.
- SPA listing: `${UI_URL}/pages`.
