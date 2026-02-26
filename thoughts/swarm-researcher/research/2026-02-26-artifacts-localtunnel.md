---
date: 2026-02-26T18:38:00Z
topic: "Agent Artifacts: Concept & Localtunnel Research"
author: "Researcher (Swarm Agent)"
status: "complete"
---

# Agent Artifacts: Concept & Localtunnel Research

## TL;DR

**Artifacts** are a way for swarm agents to serve HTML pages, interactive apps, and rich content via public URLs. Each agent already exposes port 3000 — by combining this with our localtunnel infrastructure (`lt.desplega.ai`), agents can publish content that anyone with credentials can access from a browser.

Our localtunnel forks already have the two key features needed: **deterministic subdomains** (with 409 conflict handling) and **HTTP Basic Auth** (per-tunnel, timing-safe). The infrastructure is ready to use today.

---

## Part 1: The Artifacts Concept

### What Are Artifacts?

Artifacts are publicly accessible web content served by swarm agents. Instead of agents only communicating through Slack messages and task outputs (text), artifacts let agents produce rich, interactive deliverables:

```
Agent Container (port 3000)
    |
    | localtunnel client
    v
lt.desplega.ai (localtunnel server)
    |
    | HTTPS + Basic Auth
    v
Public URL: https://{agentId}.lt.desplega.ai
    |
    v
Browser (human or another agent)
```

### Use Cases

| Use Case | Description | Example |
|----------|-------------|---------|
| **Interactive reports** | Rich HTML dashboards with charts, tables, and drill-downs | PR review summary with file diffs, test coverage heatmap, dependency graph |
| **Approval flows** | Forms that let humans approve/reject agent proposals | "Agent wants to merge PR #42 — Approve / Reject / Request Changes" with a button that calls the swarm API |
| **Visual diffs** | Side-by-side visual comparisons | Before/after screenshots of UI changes, rendered markdown diffs |
| **Forms that create tasks** | Structured input that agents can parse | "Create a new feature request" form that submits a task to the swarm |
| **Live dashboards** | Real-time status pages | Swarm health dashboard, build pipeline status, Sentry issue tracker |
| **Documentation previews** | Rendered docs before merge | Preview of documentation changes with live navigation |
| **Data exploration** | Interactive data viewers | Log viewer, database query results with sorting/filtering |

### CLI Design Concept

```bash
# Start serving an artifact (static directory or app)
artifact serve ./dist --name "pr-review-42"
# → https://{agentId}.lt.desplega.ai (serves ./dist as static files)

# Start serving with a custom Express/Hono app
artifact serve ./server.js --name "approval-flow"
# → Starts server.js on port 3000, tunnels it

# List active artifacts across the swarm
artifact list
# NAME              AGENT        URL                                              AUTH
# pr-review-42      researcher   https://1699...cf73.lt.desplega.ai              yes
# approval-flow     lead         https://d454...f9c3.lt.desplega.ai              yes

# Stop an artifact
artifact stop pr-review-42

# Open in browser (auto-fills credentials)
artifact open pr-review-42
```

Under the hood, `artifact serve` would:
1. Start an HTTP server on port 3000 (or the next available port)
2. Create a localtunnel with `--subdomain {agentId} --auth {derivedPassword}`
3. Register the artifact in the service registry with metadata (name, URL, credentials)
4. Keep the tunnel alive with auto-reconnection

### JS SDK: Browser → Swarm API

A key part of artifacts is the ability for browser-side JavaScript to call back into the swarm. This enables interactive artifacts (approval buttons, form submissions, task creation).

**Concept:**

```html
<!-- Served by the agent's artifact server -->
<script src="/@swarm/sdk.js"></script>
<script>
  // SDK is injected by the artifact server
  const swarm = new SwarmSDK({
    // Auth is handled automatically via the tunnel's Basic Auth
    // The SDK knows the agent's ID from the server context
  });

  // Create a task in the swarm
  document.getElementById('approve-btn').onclick = async () => {
    await swarm.createTask({
      task: 'Merge PR #42 — approved by human via artifact',
      tags: ['approved', 'pr-42'],
    });
    alert('Task created!');
  };

  // Post a message to a channel
  document.getElementById('comment-btn').onclick = async () => {
    const comment = document.getElementById('comment-input').value;
    await swarm.postMessage({
      channel: 'general',
      content: `Human comment on PR #42: ${comment}`,
    });
  };

  // Read swarm state
  const tasks = await swarm.getTasks({ status: 'in_progress' });
  renderTaskList(tasks);
</script>
```

**How it works:**

1. The artifact server (running in the agent container) serves a `/@swarm/sdk.js` endpoint
2. The SDK makes API calls to the artifact server (same origin, no CORS issues)
3. The artifact server proxies these calls to the swarm MCP server using the agent's credentials
4. The swarm MCP server processes the request as if the agent made it

**Security model:**
- The tunnel's Basic Auth gates access to the artifact (only credentialed users can reach it)
- The SDK calls go through the agent's server, which acts as a proxy — the browser never has direct swarm API access
- The agent can filter/validate SDK requests before forwarding them

---

## Part 2: Localtunnel Research

### Deterministic Subdomains

The client requests a specific subdomain by appending it as a URL path segment during tunnel negotiation:

```
# Without subdomain: GET https://lt.desplega.ai/?new
# With subdomain:    GET https://lt.desplega.ai/my-agent-name
```

**CLI:**
```bash
lt --port 3000 --subdomain my-agent-name
# Result: https://my-agent-name.lt.desplega.ai
```

**Programmatic API:**
```javascript
const localtunnel = require('@desplega.ai/localtunnel');

const tunnel = await localtunnel({
  port: 3000,
  subdomain: 'my-agent-name',
  // host defaults to 'https://lt.desplega.ai'
});

console.log(tunnel.url);
// https://my-agent-name.lt.desplega.ai
```

#### Subdomain Validation Rules (Server-Side)

The server validates subdomains with this regex:

```
/^(?:[a-z0-9][a-z0-9\-]{2,61}[a-z0-9]|[a-z0-9]{4,63})$/
```

| Rule | Detail |
|------|--------|
| Length | 4-63 characters |
| Allowed chars | Lowercase alphanumeric (`a-z`, `0-9`) and hyphens (`-`) |
| Start/end | Cannot start or end with a hyphen |
| Case | Must be lowercase |

#### Conflict Handling (409)

**Our fork differs from upstream here.** In upstream localtunnel, if a requested subdomain is taken, the server silently assigns a random one. Our fork returns a proper 409 Conflict:

**Server (`ClientManager.js`):**
```javascript
if (clients[id]) {
    const err = new Error(`Subdomain '${id}' is already in use.`);
    err.code = 'SUBDOMAIN_IN_USE';
    throw err;
}
```

**Client (`Tunnel.js`):**
```javascript
if (err.response?.status === 409) {
    const message = err.response.data?.message || 'Subdomain is already in use';
    return cb(new Error(message));  // Fails immediately, no retry
}
```

#### Agent IDs as Subdomains

Agent IDs are UUIDs like `16990304-76e4-4017-b991-f3e37b34cf73`. These are 36 characters, contain only hex digits and hyphens, and are lowercase — they pass the subdomain validation regex.

```
https://16990304-76e4-4017-b991-f3e37b34cf73.lt.desplega.ai
```

Options:
1. **Use agent ID directly** — guaranteed unique, passes validation, but ugly
2. **Use agent name** (e.g., `researcher`) — readable but not guaranteed unique
3. **Use `{name}-{shortId}`** (e.g., `researcher-16990304`) — readable and likely unique

**Recommendation:** Use full UUID. The URL is primarily for programmatic access, not for humans typing into browsers. The service registry provides a human-friendly lookup.

### HTTP Basic Auth

Auth is a feature **added by our fork** — it does not exist in upstream localtunnel.

**CLI (two modes):**
```bash
# Mode 1: Server generates an 18-char hex password
lt --port 3000 --subdomain my-agent --auth
# Username: "hi", Password: auto-generated

# Mode 2: Custom password
lt --port 3000 --subdomain my-agent --auth "my-secret-password"
# Username: "hi", Password: "my-secret-password"
```

**Programmatic API:**
```javascript
const tunnel = await localtunnel({
  port: 3000,
  subdomain: 'my-agent',
  auth: true,           // server generates password
  // OR
  auth: 'my-password',  // custom password
});

// tunnel.url includes embedded credentials:
// https://hi:a1b2c3d4e5f6g7h8i9@my-agent.lt.desplega.ai
```

#### Auth Flow

1. **Client → Server (tunnel registration):** Query params `username=hi` and optionally `password=<value>` appended to the registration URL
2. **Server stores credentials:** If no password given, auto-generates 18-char hex string via `crypto.randomBytes(9).toString('hex')`
3. **Server → Client (registration response):** Credentials returned in response body and embedded in URL
4. **Browser/client → Server (accessing tunnel):** Standard HTTP Basic Auth — browser shows login prompt, or `Authorization: Basic <base64>` header
5. **Server validates:** Timing-safe comparison via `crypto.timingSafeEqual()`, returns `401 Unauthorized` with `WWW-Authenticate: Basic realm="Localtunnel"` on failure
6. **WebSocket auth:** Also enforced

#### Security Properties

| Property | Status |
|----------|--------|
| Timing-safe comparison | Yes (`crypto.timingSafeEqual`) |
| Per-tunnel isolation | Yes (each tunnel has its own credentials) |
| Credentials in URL | Yes (embedded in the response URL) — note: not ideal for logging |
| HTTPS | Yes (`lt.desplega.ai` uses TLS via Caddy) |
| WebSocket support | Yes (auth checked on upgrade) |

### Connection Management

| Parameter | Value | Source |
|-----------|-------|--------|
| Max TCP sockets per tunnel | 10 (hardcoded) | `TunnelAgent.js` — `--max-sockets` flag has a property name mismatch bug |
| Socket idle timeout | 10 minutes (default) | `TunnelAgent.js` — configurable via `SOCKET_TIMEOUT` env var (seconds) |
| Grace period (no connections) | 1 second | `Client.js` — tunnel removed if no client connects within 1s |
| WebSocket timeout | Disabled (0) | `Client.js` — WebSocket connections exempt from idle timeout |

**Auto-Reconnection (Client-Side):**
- Dead tunnel socket → immediately reopened
- Server unavailable → retry every 1s
- Local server refused → retry every 1s
- 409 subdomain conflict → immediate failure (no retry)

**Graceful Shutdown (fork addition):**
- `tunnel.close()` is async, destroys all resources
- CLI handles `SIGINT`/`SIGTERM`

**Env var configuration:** All CLI flags can be set via environment variables (yargs `.env(true)`).

---

## Part 3: Fork Modifications vs Upstream

### Client (`desplega-ai/localtunnel` v2.2.0)

| Modification | Description |
|-------------|-------------|
| **Default host** | Changed from `localtunnel.me` to `lt.desplega.ai` |
| **`--auth` flag** | New: HTTP Basic Auth support (boolean or string) |
| **409 handling** | New: subdomain conflict returns immediate error instead of retrying |
| **Graceful shutdown** | New: async `close()` with full resource cleanup |
| **Test suite** | Migrated from Mocha (JS) to Bun (TypeScript) |
| **Package name** | `@desplega.ai/localtunnel` (scoped) |

### Server (`desplega-ai/localtunnel-server` v0.1.3)

| Modification | Description |
|-------------|-------------|
| **HTTP Basic Auth** | Full implementation: `authUtils.js` + per-tunnel credential storage + timing-safe validation |
| **409 Conflict** | Returns proper 409 for subdomain collisions |
| **Socket timeout** | Increased from 60s to 10 minutes, configurable via `SOCKET_TIMEOUT` env var |
| **X-Forwarded-Proto/Host** | Sets forwarded headers for HTTPS-aware apps |
| **X-Robots-Tag** | All tunnel responses include `noindex, nofollow` |
| **Agent IP tracking** | `X-Localtunnel-Agent-Ips` header on responses |
| **ESM** | Converted to ES modules |
| **Docker** | Dockerfile + compose config, GHCR publishing |
| **CI/CD** | Test, E2E, and Docker publish workflows |

---

## Part 4: Design Decisions

### Auth Strategy

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| Per-tunnel random password | `auth: true` (server generates) | Zero config | Need to store/share the generated password |
| Shared swarm secret | `auth: swarmSecret` | Simple | Compromising one tunnel compromises all |
| **Per-agent derived password** | `auth: hash(agentId + swarmSecret)` | Deterministic, per-agent isolation | Requires secret management |

**Recommendation:** Per-agent derived password using `crypto.createHmac('sha256', swarmSecret).update(agentId).digest('hex')`.

### Lifecycle Management

1. **Container restart:** Server frees subdomain after 1s grace. Agent reconnects with same subdomain immediately.
2. **Server restart:** All tunnels lost. Client retry loop handles reconnection (1s interval).
3. **Stale subdomains:** Held up to 10 minutes (socket timeout). Acceptable for MVP.

### Implementation Sketch

```javascript
const localtunnel = require('@desplega.ai/localtunnel');
const crypto = require('crypto');

const SWARM_SECRET = process.env.SWARM_SECRET;
const AGENT_ID = process.env.AGENT_ID;

const password = crypto.createHmac('sha256', SWARM_SECRET)
  .update(AGENT_ID)
  .digest('hex')
  .slice(0, 32);

const tunnel = await localtunnel({
  port: 3000,
  subdomain: AGENT_ID,
  auth: password,
});

// Register in service registry
await registerService({
  name: 'artifacts',
  script: '/path/to/server.js',
  metadata: { publicUrl: tunnel.url, tunnelId: tunnel.clientId },
});

process.on('SIGTERM', async () => {
  await tunnel.close();
  await unregisterService({ name: 'artifacts' });
});
```

---

## Part 5: Known Issues & Risks

| Issue | Severity | Mitigation |
|-------|----------|------------|
| **10 max TCP sockets per tunnel** | Medium | Fine for artifacts. Fix the property name bug (`maxSockets` → `maxTcpSockets`). |
| **1-second grace period** | Low | Good for subdomain reuse, no overlap possible. |
| **No heartbeat mechanism** | Medium | Stale subdomains held up to 10 minutes. Acceptable for MVP. |
| **Hardcoded username "hi"** | Low | Password is what matters. Can patch later. |
| **HTTP only (no raw TCP/UDP)** | Low | Artifacts are HTTP-served. Fine. |
| **No wildcard DNS guarantee** | Medium | Requires `*.lt.desplega.ai` DNS via Caddy. |

### `maxSockets` Bug Fix Needed

In `desplega-ai/localtunnel-server`, `ClientManager.js:43-46`:

```javascript
// Current (buggy):
const agent = new TunnelAgent({ clientId: id, maxSockets: 10 });

// Fix:
const agent = new TunnelAgent({ clientId: id, maxTcpSockets: maxSockets });
```

---

## Part 6: Next Steps

1. **Fix the `maxSockets` property name bug** in `desplega-ai/localtunnel-server`
2. **Prototype the integration** — add localtunnel tunnel creation to the agent runner
3. **Build the `artifact` CLI commands** — `serve`, `list`, `stop`, `open`
4. **Create the JS SDK** for browser → swarm API calls
5. **Add tunnel URL to service registry metadata** for discovery
6. **Set up SWARM_SECRET** for deterministic auth password derivation
7. **Consider health check endpoint** — `/health` on each artifact for monitoring
