# Pages — DB-backed Static Artifacts

DB-backed static content (HTML or JSON) served by the API directly. Cheap,
versioned, share-able by URL. The lighter-weight cousin of `artifacts` —
no PM2, no tunnels, no port allocation, no `services` registry row.

A page should be a clean human-facing artifact, not a raw dump with a URL. This
skill covers both halves: **how to publish** a page, and **the taste baseline**
every page should meet.

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
| Analysis that should be linkable and bookmarkable | **Pages** |
| Custom routes, websockets, server-side logic | The **`artifacts`** skill |
| File uploads or per-request computation | The **`artifacts`** skill |

Rule of thumb: if the content is a snapshot (you can write the full HTML/JSON
in a single call), use pages. If the content is a *running program*, use
artifacts.

Do **not** use pages for:

- In-flight progress notes — use `store-progress.progress`
- Secrets, private credentials, or unapproved personal data
- Large binary files — use agent-fs for PNG/MP4
- Raw verbose logs — summarize, and link the raw file as an artifact

## Quick Start

### Authed HTML report

```jsonc
// Tool call: create_page
{
  "title": "Q2 Status Report",
  "description": "Roll-up of in-flight tasks across the swarm",
  "contentType": "text/html",
  "authMode": "authed",
  "body": "<!doctype html><html><body><h1>Q2 Status</h1>...</body></html>"
}
// → { id, version: 1, app_url, api_url }
```

Share `app_url` (the SPA route) for the general case; share `api_url` for a
no-SPA-required direct link.

Use `authMode: "public"` only when the page is intentionally safe for anyone
with the URL to view.

A complete, styled report body that follows the baseline below is bundled at
**`examples/report-page.html`** — copy it as your starting point rather than
writing CSS from scratch.

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

---

# Design baseline

Before creating a page, write a one-line design read for yourself:

> Reading this as: `<page kind>` for `<audience>`, using minimalist taste plus `<density needs>`.

## Universal baseline

The baseline is `taste-minimalist-skill`. Apply it to every page — reports,
dashboards, tables, audits, public explainers, data-heavy summaries.

- Use a warm monochrome canvas (`#FFFFFF`, `#FBFBFA`, `#F7F6F3`) with charcoal text and scarce muted accents.
- Build a clear type hierarchy with premium/system typography; use monospace for code, metadata, and `<kbd>`.
- Use macro-whitespace and strong alignment. Give summaries room to breathe and keep tables compact enough to scan.
- Prefer flat surfaces: crisp `1px` borders, `8px` or `12px` radii, and practically no shadows.
- Use restrained motion only where it clarifies hierarchy or interaction state.
- Keep visual language quiet and precise: no AI-purple gradient mesh, centered hero plus three equal cards, decorative glassmorphism, emojis as UI decoration, fake screenshots made from rectangles, oversized decorative art, nested cards, or low-contrast text.
- Make responsive behavior explicit: readable type, stable grids, horizontal table scroll where needed, and no overlapping content.

If the full minimalist source is available, use `taste-minimalist-skill` for the
deeper primitives: bento grids, status badges, `<kbd>` keys, flat tables, code
blocks, and the detailed anti-slop checks.

## Report density layer

Use this layer for reports, dashboards, data tables, and internal summaries.
Keep the minimalist style floor, then compress the information architecture
enough that busy readers can scan evidence quickly. Density is an
information-architecture layer, not a separate aesthetic.

Every dense page should be useful at a glance.

- Put the page's point in the first viewport: title, one-sentence summary, and 3-6 key numbers or statuses.
- Use a single-column reading spine with `max-width: 1120px`; keep prose measure around 65-75 characters and reserve denser grids for metrics/evidence.
- Use premium/system typography unless there is a clear brand reason not to: `"SF Pro Display", "Geist Sans", "Helvetica Neue", ui-sans-serif, system-ui, sans-serif`.
- Use the minimalist palette: warm off-white background, charcoal text, white or near-white panels, light borders, one scarce accent, and semantic colors for statuses only.
- Use a consistent spacing scale: `8, 12, 16, 24, 32, 48, 72`.
- Use clear type hierarchy: page title 36-48px desktop / 30-36px mobile, section titles 22-28px, body 15-16px, supporting text 13-14px.
- Keep tables readable: sticky/scannable headers where useful, padded cells, zebra-free or very subtle row borders, `tabular-nums` for numbers, horizontal scroll on narrow screens.
- Prefer flat bordered cards only for repeated records or metrics. Do not nest cards inside cards.
- Use shadows only when they solve a hierarchy problem; keep them ultra-diffuse and below `0.05` opacity.
- Hide raw JSON behind a collapsed `<details>` block at the bottom.
- Make mobile explicit with media queries: single-column grids, reduced padding, no overflow except intentional table scroll.

## Content structure

Use this order unless the task gives a better domain-specific structure:

1. Header: title, short summary, timestamp/source context
2. Key metrics: 3-6 tiles that answer "how big / how bad / what changed?"
3. Findings or sections grouped by theme, owner, severity, or stage
4. Evidence tables or samples under each finding
5. Next actions or recommendations
6. Raw evidence links / collapsed JSON appendix

Write section headings as labels, not slogans. Favor "Critical Routing Gaps"
over "Things We Found".

## Design checklist

Before publishing:

- The first viewport states what the page is, why it matters, and the key numbers.
- The page has a clear hierarchy: `h1`, short lede, metrics, sections, evidence.
- Body text is readable on mobile and desktop.
- Tables scroll horizontally on mobile instead of crushing columns.
- Status colors are semantic and not the whole visual identity.
- Raw JSON/logs are collapsed or linked, not the primary experience.
- No nested cards, decorative gradients, oversized art, or cramped default browser styles.
- No text overlaps, clipped buttons, or unreadable low-contrast text.

---

# Reference

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
| `app_url` | `${APP_URL}/pages/:id` | SPA route. Renders HTML in a sandboxed iframe, JSON via `@json-render/react`. Default share target. |
| `app_url` (full mode) | `${APP_URL}/pages/:id?mode=full` | Same SPA route, maximized — hides the SPA sidebar/header so the page body gets the full viewport. Slim header with title + Exit-Full button. Useful for embeds + standalone dashboards. |
| `api_url` | `${MCP_BASE_URL}/p/:id` | Direct API render. HTML inlines and serves; JSON 302-redirects to `app_url`. Useful for no-SPA-required links. |

`${APP_URL}` is the deployment's SPA origin and `${MCP_BASE_URL}` is its API
origin. Both are surfaced as env vars to your agent — never hardcode hosts; read
them from `process.env`.

**Default**: share `app_url`. Append `?mode=full` when the recipient should
see ONLY the page (no surrounding swarm chrome). Use `api_url` only when you
specifically need a link that bypasses the SPA (e.g. embedding in Slack,
where the unfurl preview only follows the API origin).

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

Every HTML page automatically gets `window.SwarmSDK` (the class) and
`window.swarmSdk` (a ready-to-use singleton) injected. The SDK routes through
the `/@swarm/api/*` proxy, which resolves the `page_session` cookie to a user
identity and forwards with proper auth headers server-side — your page never
sees or handles tokens.

The SDK is **domain-grouped**. Each domain exposes idiomatic CRUD-ish methods
that map 1:1 to the public REST API documented at
[**docs.agent-swarm.dev/docs/api-reference**](https://docs.agent-swarm.dev/docs/api-reference).

| Domain | Methods | Maps to |
|---|---|---|
| `swarmSdk.tasks` | `create(body)`, `list(filters?)`, `get(id)`, `storeProgress(id, data)` | `/api/tasks*` |
| `swarmSdk.agents` | `list()`, `get(id)` | `/api/agents*` |
| `swarmSdk.events` | `create(body)`, `list(filters?)`, `batch(body)`, `counts(filters?)` | `/api/events*` |
| `swarmSdk.memory` | `search(body)`, `list(filters?)`, `get(id)`, `rate(body)` | `/api/memory*` |
| `swarmSdk.repos` | `list()`, `get(id)`, `create(body)`, `update(id, body)`, `delete(id)` | `/api/repos*` |
| `swarmSdk.schedules` | `list()`, `get(id)`, `create(body)`, `update(id, body)`, `delete(id)`, `run(id)` | `/api/schedules*` |
| `swarmSdk.approvalRequests` | `list(filters?)`, `get(id)`, `create(body)`, `respond(id, body)` | `/api/approval-requests*` |
| `swarmSdk.assets` | `list(filters?)`, `audit()`, `registerMapping(body)`, `move(entityType, id, key)` | `/api/assets*` |
| `swarmSdk.kv` | `get(key)`, `set(key, value, opts?)`, `incr(key, by?)`, `del(key)`, `list(opts?)` | `/api/kv*` (namespace forced to `task:page:<id>`) |

Inline usage:

```html
<script>
  // Singleton is ready immediately — no `new SwarmSDK()` needed.
  const tasks = await window.swarmSdk.tasks.list({ status: 'in_progress' });
  const agents = await window.swarmSdk.agents.list();

  // Create an event from a button click
  document.querySelector('#log-btn').onclick = async () => {
    await window.swarmSdk.events.create({ name: 'page.button.clicked', payload: { at: Date.now() } });
  };

  // Approve / reject an approval request
  await window.swarmSdk.approvalRequests.respond(reqId, { decision: 'approved' });
</script>
```

Every method returns the parsed JSON response. Errors throw with `.status`
and `.response` attached to the `Error` object so callers can branch on the
HTTP status.

> **`public` pages cannot call authed endpoints.** No cookie is minted on a
> public page load → SDK calls 401. If your page needs to call swarm APIs,
> use `authed` (or `password`).

### Full signature

This is the entire surface — copy it into your page if you want autocomplete
hints in an editor. The runtime version is auto-injected; you don't need to
include this in the page source.

```js
class SwarmSDK {
  tasks: {
    create(body)                       // POST /api/tasks
    list(filters?)                     // GET  /api/tasks
    get(id)                            // GET  /api/tasks/:id
    storeProgress(id, data)            // POST /api/tasks/:id/progress
  }
  agents: {
    list()                             // GET  /api/agents
    get(id)                            // GET  /api/agents/:id
  }
  events: {
    create(body)                       // POST /api/events
    list(filters?)                     // GET  /api/events
    batch(body)                        // POST /api/events/batch
    counts(filters?)                   // GET  /api/events/counts
  }
  memory: {
    search(body)                       // POST /api/memory/search
    list(filters?)                     // GET  /api/memory/list
    get(id)                            // GET  /api/memory/:id
    rate(body)                         // POST /api/memory/rate
  }
  repos: {
    list()                             // GET  /api/repos
    get(id)                            // GET  /api/repos/:id
    create(body)                       // POST /api/repos
    update(id, body)                   // PUT  /api/repos/:id
    delete(id)                         // DELETE /api/repos/:id
  }
  schedules: {
    list()                             // GET  /api/schedules
    get(id)                            // GET  /api/schedules/:id
    create(body)                       // POST /api/schedules
    update(id, body)                   // PUT  /api/schedules/:id
    delete(id)                         // DELETE /api/schedules/:id
    run(id)                            // POST /api/schedules/:id/run
  }
  approvalRequests: {
    list(filters?)                     // GET  /api/approval-requests
    get(id)                            // GET  /api/approval-requests/:id
    create(body)                       // POST /api/approval-requests
    respond(id, body)                  // POST /api/approval-requests/:id/respond
  }
  assets: {
    list(filters?)                     // GET   /api/assets
    audit()                            // GET   /api/assets/key-audit (operator only)
    registerMapping(body)              // POST  /api/assets/mappings (operator only)
    move(entityType, id, key)          // PATCH /api/assets/:entityType/:id/key
  }
}
```

For the full list of fields each endpoint accepts/returns, see
[**docs.agent-swarm.dev/docs/api-reference**](https://docs.agent-swarm.dev/docs/api-reference).
The SDK is a thin domain wrapper — anything documented there is reachable.

## Built-in primitives

Every HTML page automatically gets a small set of zero-dep web components
auto-injected alongside the Browser SDK. Drop them into your page body —
no `<script>` import, no bundling, no Tailwind required (though Tailwind
Play CDN is loaded, so utility classes work too).

### `<swarm-diff>` — unified diff renderer

Render a unified diff with a two-column gutter, severity annotations, and a
deterministic anchor id per hunk (so deep-linking + jump lists work). The
element reads its payload from its `textContent` as JSON of shape
`{ hunks: [{ old_start, old_lines, new_start, new_lines, lines, annotations? }] }`.

```html
<swarm-diff
  file="src/foo.ts"
  base-sha="abc123"
  head-sha="def456">
{ "hunks": [
    { "old_start": 10, "old_lines": 3, "new_start": 10, "new_lines": 4,
      "lines": [
        { "type": "context", "text": "  const x = 1;" },
        { "type": "del",     "text": "- console.log(x);" },
        { "type": "add",     "text": "+ logger.info({ x });" },
        { "type": "add",     "text": "+ return x;" }
      ],
      "annotations": [
        { "line": 12, "severity": "warn", "text": "Avoid raw console.log" }
      ]
    }
] }
</swarm-diff>
```

**Inputs**

| Attribute | Required | Notes |
|---|---|---|
| `file` | yes | Path label rendered in the hunk header. Used for the anchor id slug. |
| `base-sha` | no | Pre-change SHA. Rendered in the header next to `head-sha`. |
| `head-sha` | no | Post-change SHA. |

**Line shape**

| Field | Values | Notes |
|---|---|---|
| `type` | `context` \| `add` \| `del` | Drives row tint (green / red / neutral) and gutter line numbering. |
| `text` | string | Rendered verbatim (HTML-escaped). |

**Annotation shape** — attaches to a NEW-side line by line number; rendered
as a margin badge on that row.

| Field | Values | Notes |
|---|---|---|
| `line` | integer | New-side line number (falls back to old-side if no add for that line). |
| `severity` | `error` \| `warn` \| `info` | Drives badge color. |
| `text` | string | Badge body. |

**Anchor id**

Each hunk gets `id="swarm-diff-<file-slug>-<old_start>"` for deep-linking.
Use `<swarm-diff-jumps></swarm-diff-jumps>` anywhere in the page body to
render a tiny "Jump to" navigation of every diff hunk on the page —
handy when an agent ships a multi-file annotated PR.

**Programmatic form**

If you need to render a diff from a fetch response (rather than inline JSON),
use `window.swarmUi.renderDiff(rootEl, diffData)`:

```html
<div id="diff-target"></div>
<script>
  const data = await fetch('/some/diff.json').then(r => r.json());
  window.swarmUi.renderDiff(document.getElementById('diff-target'), data);
</script>
```

A full annotated-PR page using `<swarm-diff>` is bundled at
**`examples/annotated-pr.html`**.

## Print / PDF export

Every HTML page also gets a `@media print` rule baked into the head defaults:
- Light theme on print (white background, black text, underlined black links).
- Anything with the `.no-print` class is hidden (annotation badges and the
  jump list already carry this class — use it on agent-emitted chrome you
  want suppressed in PDF exports).
- `.swarm-card` and `<swarm-diff>` get `break-inside: avoid` so they don't
  split mid-element across pages.

Trigger the export from the SPA's "Export PDF" button on `/pages/:id` — it
opens the iframe's native print dialog (HTML pages) or the SPA's print
dialog (JSON pages). The browser's "Print → Save as PDF" handles the actual
file. No headless Chromium, no server-side rendering — zero infra weight.

> Want a custom print layout? Override the print styles in your page's own
> `<style>` block — agent CSS always wins over the head defaults.

## View counter

Every successful `200` from `GET /p/:id` (HTML inline) and `GET /p/:id.json`
(JSON metadata) bumps a `view_count` field on the page. `302` (JSON pages
redirecting to the SPA), `401`/`403` (auth gate), and `404` do NOT bump.
The count is exposed on `GET /api/pages` listing (`viewCount` field) and the
SPA `/pages` index renders it as a small eye-count badge per row.

No per-viewer dedup — this is a coarse popularity signal, not analytics.
Bumps are best-effort (wrapped in try/catch so a counter write never fails
the response).

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

## Pages vs agent-fs

| Use pages for | Use agent-fs for |
|---|---|
| Reports, dashboards, human-readable summaries | Markdown research notes, code files, recordings |
| Content that benefits from HTML layout | Searchable knowledge base entries |
| Quick share links to non-technical stakeholders | Binary artifacts such as PNG or MP4 |
| Time-bounded deliverables | Long-lived reference documentation |

For a research memo, write the source to agent-fs and create a page for the
human-facing summary.

## See Also

- The **`artifacts`** skill — durable storage (agent-fs, shared workspace) plus
  full custom Hono apps with PM2 + a tunneled subdomain. Use it for interactive
  servers, not static content.
- The **`kv-storage`** skill — page-scoped state via `swarmSdk.kv`.
- `runbooks/secret-scrubbing.md` — egress scrubbing details.
- SPA listing: `${APP_URL}/pages` — the same `APP_URL` used for share links above.
  Prefer the `app_url` that `create_page` returns; build URLs by hand only when
  you have no page id.
