# KV Storage

Namespaced key/value store inside the swarm SQLite DB. Auto-scoped to your
calling context — same string used by `agent_tasks.contextKey`.

> **Capability gate**: the `kv-*` MCP tools are only available when your
> `CAPABILITIES` includes `kv` (default-on; check `my-agent-info`). The REST
> endpoints under `/api/kv/*` are always present on the API server.

## When to use KV

| You need… | Use this | Not this |
|---|---|---|
| Count something in this Slack thread / PR / Linear issue | **KV** (auto-scoped) | memory / agent-fs |
| Save a cursor / last-seen state for a recurring schedule | **KV** | swarm_config |
| Deduplicate ("have I already processed this message?") | **KV** + TTL | memory |
| Idempotency keys ("did I already send this email today?") | **KV** + TTL | memory |
| Routing / mapping tables ("which agent handles number X?") | **KV** | swarm_config |
| Page-internal counter / vote / state across reloads | **KV** via `swarmSdk.kv` | memory |
| Cross-task state in the same conversation | **KV** (auto-scoped to `task:slack:...`) | parentTaskId only |
| Secrets, API tokens, OAuth creds | `swarm_config` (`isSecret=true`, encrypted + masked) | **NOT KV** |
| Cross-session knowledge for this agent ("how do I…") | `memory_search` / `memory-get` | **NOT KV** |
| Files, binaries, long documents | `agent-fs` | **NOT KV** |
| Logs / audit trails | `agent-fs` or `store-progress` | **NOT KV** |
| Workflow run state | workflow vars (own KV) | **NOT KV** |

Rule of thumb:
- If a future invocation should *find this without knowing the key* → memory.
- If a future invocation will *know exactly which key to read* → KV.
- If it has secrets in it → `swarm_config`.
- If it's bytes (image, pdf, large doc) → agent-fs.

### Trade-offs

**KV vs agent-fs** — KV is fast and API-native (no file I/O), but values are
opaque blobs: no search, no versioning, no human browsing. Use KV for
machine-consumed state; use agent-fs for human-reviewable artifacts.

**KV vs swarm_config** — `swarm_config` is for operator-configured values (API
keys, account IDs, feature flags) and is encrypted at rest. KV is for dynamic
runtime state that tasks write and read themselves.

## Namespacing

Namespace is just a string. It mirrors the `contextKey` schema
(`src/tasks/context-key.ts`). When you don't pass one, the server resolves it
from request headers in this order:

1. `X-Page-Id` (only the page-proxy sets this) → `task:page:<id>`
2. `X-Source-Task-Id` → that task's `contextKey` (e.g. `task:slack:C123:1776...`)
3. `X-Agent-ID` → `task:agent:<id>` (per-agent scratchpad)

So **inside a session triggered by a Slack thread, KV is automatically scoped
to that thread** — your sibling tasks (re-runs, retries, follow-ups in the same
thread) read the same store with no setup. Same for PRs (`task:trackers:github:owner:repo:pr:N`),
Linear issues (`task:trackers:linear:DES-42`), schedules, workflows.

You can override the namespace explicitly when you need to — see "Explicit
override" below.

### Key naming inside a namespace

The namespace scopes *who* can see the key; the key itself should still say
*what* it is. Use `:`-delimited, prefix-friendly keys so `kv-list` can sweep a
family:

```
# Deduplication
integrations:slack:dedupe:<message-ts>
integrations:kapso:dedupe:<wamid>

# Routing / mapping
integrations:kapso:numbers:<phone-number-id>

# Schedule state
schedules:<schedule-id>:last-run-at
schedules:<schedule-id>:last-sha

# Workflow state
workflows:<workflow-id>:run:<run-id>:step-state

# Agent scratch
agent:<agent-id>:cache:<topic>
```

## Quick recipes

### MCP — inside any agent session

```
kv-set    key="vote-count" value=0 valueType="integer"     # → namespace = task:slack:...
kv-incr   key="vote-count"                                  # → 1
kv-incr   key="vote-count" by=5                             # → 6
kv-get    key="vote-count"                                  # → entry with value=6
kv-list   prefix="vote-"                                    # → all matching entries
kv-delete key="vote-count"                                  # → done
```

`kv-set` defaults to `valueType: 'json'` and JSON-encodes whatever you pass.
Use `'string'` to skip encoding (good for short tokens, URLs) and
`'integer'` for counters (required by `kv-incr`).

### REST — humans, scripts, external clients

```bash
# Header-resolved namespace (recommended for in-session calls)
curl -H "Authorization: Bearer $API_KEY" \
     -H "X-Agent-ID: $AGENT_ID" \
     "$MCP_BASE_URL/api/kv/last-cursor"

# Explicit namespace
curl -H "Authorization: Bearer $API_KEY" \
     "$MCP_BASE_URL/api/kv/_/task:trackers:linear:DES-42/last-comment-id"

# PUT a JSON value with a 10-minute TTL
curl -X PUT -H "Authorization: Bearer $API_KEY" -H "X-Agent-ID: $AGENT_ID" \
     -H "Content-Type: application/json" \
     -d '{"value":{"n":42},"valueType":"json","expiresInSec":600}' \
     "$MCP_BASE_URL/api/kv/snapshot"

# List with a prefix
curl -H "Authorization: Bearer $API_KEY" -H "X-Agent-ID: $AGENT_ID" \
     "$MCP_BASE_URL/api/kv?prefix=daily-&limit=50"
```

### Pages browser SDK — inside an authed page

Page proxy forces the namespace to `task:page:<id>` — no namespace argument is
exposed. Use it for page-local counters, vote tallies, multi-step form state,
"remember this number from last refresh" UX:

```js
// Inside a page's <script> tag
const count = await swarmSdk.kv.incr('clicks');           // → number-valued entry
await swarmSdk.kv.set('lastSeen', Date.now());            // → 'json' by default
const entry = await swarmSdk.kv.get('clicks');            // → { value, valueType, ... } or null
await swarmSdk.kv.del('clicks');
const all = await swarmSdk.kv.list({ prefix: 'click', limit: 50 });
```

Public pages (`authMode: 'public'`) cannot reach `/@swarm/api/*` and so cannot
use KV. Promote to `authed` or `password` mode if the page needs state.

## Explicit override

Pass `namespace` to read/write somewhere other than your auto-context:

```
kv-get key="seed" namespace="swarm:experiments"            # ad-hoc namespace
kv-set key="note" value="hi" namespace="task:agent:OTHER-AGENT-ID"
# → 403 unless caller is lead
```

Rules:
- **Reads:** any authenticated caller can read any namespace.
- **Writes to `task:agent:<X>`** where X ≠ caller agentId: **403** unless lead.
- **Writes to `task:page:<X>`** from anywhere except a page-proxy request: **403**.
- Everything else: writable by any authenticated caller.

## TTL & expiry

Default = **no expiry**. Opt in by passing `expiresInSec` (seconds).

```
kv-set key="lock-token" value="xyz" valueType="string" expiresInSec=60
```

> The parameter is `expiresInSec`, **not** `ttl`. There is no `ttl` argument on
> `kv-set` or on `PUT /api/kv/*`.

Common values:

| Use | `expiresInSec` |
|---|---|
| Deduplication window | `86400` (24h) or `3600` (1h) |
| Session / conversation state | `86400` (24h) |
| Short-lived flags, locks | `300`–`3600` (5 min–1h) |
| Persistent mappings, routing tables, last-known-good | *omit* (never expires) |

Expiry is *lazy*: reads on an expired key return null and delete the row;
`kv-list` filters expired rows out of the SELECT but doesn't delete them
(keeps cursor pagination stable). No background sweeper — expired rows that
never get touched stay on disk harmlessly.

## Value format

Store compact JSON objects, not large blobs. For idempotency and dedup records,
include enough to debug later:

```json
{
  "processedAt": "2026-05-28T10:00:00Z",
  "taskId": "173ca713-...",
  "source": "slack:C0AR967K0KZ:1748430000.000000"
}
```

Include a version or content hash when the value is a cache entry, so you can
invalidate without a key rename.

## Body cap

2 MiB per value. Over the cap returns 413. If you want to store something
larger, write it to `agent-fs` and stash the path in KV.

## Example — deduplication

```
# Before processing a message
kv-get key="integrations:slack:dedupe:1748430000.000000"
# → non-null? already handled, stop here.

# ... do the work ...

# Mark as processed, expire the marker after 24h
kv-set key="integrations:slack:dedupe:1748430000.000000" \
       value='{"processedAt":"2026-05-28T10:00:00Z","taskId":"173ca713-..."}' \
       valueType="json" \
       expiresInSec=86400
```

`kv-incr` is atomic and safe across concurrent tasks. `kv-set` is
last-write-wins — if several tasks may write the same key concurrently, either
use `kv-incr` with a sequence number or embed the writing task's ID in the
value so you can detect a clobber.

## Gotchas

- **Namespaces ARE contextKey strings.** The same string that lets the swarm
  find sibling tasks for a PR also indexes KV for that PR.
- **Reads return `null` for missing AND expired keys** — you can't tell the
  difference from one call. (If you need to know, list the key.)
- **INCR collides** if the existing row has `valueType` `'json'` or `'string'`
  (409 / `KvTypeCollisionError`). Delete and re-create as `'integer'` first,
  or use a different key.
- **JSON values round-trip** through `JSON.parse` on read. If you wrote
  `{a:1}`, you'll get back the object — not the raw string. Use
  `valueType: 'string'` if you want byte-exact storage.
- **No CAS / SETNX yet.** Use `kv-incr` for atomic counters; for
  "claim a token" patterns, set with a short TTL and re-check.
- **Page SDK has no `namespace` argument.** Pages are always scoped to
  `task:page:<id>`. Don't try to encode another namespace in the key path —
  the URL gets rewritten anyway.

## See also

- The **`pages`** skill — companion skill for authed pages and `swarmSdk.kv`.
- The **`artifacts`** skill — for anything too big or too binary for KV.
- `src/be/migrations/061_kv_store.sql` — schema (`kv_entries`)
- `src/http/kv.ts` — REST handler + namespace resolution
- `src/tools/kv/*` — MCP tool registrars
- `src/artifact-sdk/browser-sdk.ts` — `swarmSdk.kv` for pages
