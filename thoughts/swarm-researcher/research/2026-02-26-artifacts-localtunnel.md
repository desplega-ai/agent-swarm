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

### CLI Design — Detailed

The artifact system adds a new command to the `agent-swarm` CLI (`src/cli.tsx`). It follows the existing pattern where commands like `worker`, `lead`, and `hook` dispatch to their own modules.

#### `artifact serve` — Start serving content

```bash
# Serve a static directory
artifact serve ./dist --name "pr-review-42"

# Serve a custom server script (must listen on port 3000)
artifact serve ./server.js --name "approval-flow"

# Serve with explicit port (if not using default 3000)
artifact serve ./app.js --name "dashboard" --port 8080

# Serve without auth (for public content)
artifact serve ./dist --name "docs-preview" --no-auth
```

| Flag | Default | Description |
|------|---------|-------------|
| `--name` | Required | Human-readable name for the artifact |
| `--port` | `3000` | Local port the server listens on |
| `--no-auth` | `false` | Disable Basic Auth on the tunnel |
| `--subdomain` | Agent UUID | Custom subdomain (overrides default) |

**What happens under the hood:**

1. If path points to a directory → starts a static file server (e.g., `sirv` or `serve-handler`) on port 3000
2. If path points to a `.js`/`.ts` file → starts it via PM2 (`pm2 start <script> --name artifact-<name>`)
3. Creates a localtunnel: `localtunnel({ port, subdomain: agentId, auth: API_KEY })`
4. Registers in service registry via `register-service` MCP tool with metadata:
   ```json
   {
     "type": "artifact",
     "artifactName": "pr-review-42",
     "publicUrl": "https://{agentId}.lt.desplega.ai",
     "auth": { "username": "swarm", "password": "***" }
   }
   ```
5. Posts to `#general` channel: "Artifact `pr-review-42` is live at <url>"

#### `artifact list` — List active artifacts

```bash
$ artifact list
NAME              AGENT        URL                                                    STATUS
pr-review-42      researcher   https://1699...cf73.lt.desplega.ai                    healthy
approval-flow     lead         https://d454...f9c3.lt.desplega.ai                    healthy
dashboard         picateclas   https://a8b2...80f.lt.desplega.ai                     unhealthy
```

Queries `list-services` MCP tool, filtering for services with `metadata.type === "artifact"`.

#### `artifact stop <name>` — Stop an artifact

```bash
$ artifact stop pr-review-42
# Stops PM2 process, closes localtunnel, unregisters service
```

1. Finds the artifact in service registry
2. `pm2 delete artifact-<name>`
3. Closes the localtunnel connection
4. `unregister-service`

#### `artifact open <name>` — Open in browser

```bash
$ artifact open pr-review-42
# Opens https://swarm:<apikey>@1699...cf73.lt.desplega.ai in default browser
```

Looks up the artifact URL from the service registry, embeds credentials, and opens via `xdg-open` (Linux) or `open` (macOS).

### Agent SDK — Detailed Design

The SDK has two sides: a **server-side TypeScript API** (used by agents to create artifacts programmatically) and a **browser-side JS SDK** (injected into served HTML for interactivity).

#### Server-Side SDK (`@desplega.ai/artifact-sdk`)

This is a TypeScript library that agents import in their artifact server scripts.

```typescript
import { createArtifactServer } from '@desplega.ai/artifact-sdk';

// Minimal example — serve static HTML
const server = createArtifactServer({
  name: 'pr-review-42',
  // Serves files from this directory
  static: './dist',
});

await server.start();
// → Starts on port 3000, creates tunnel, registers service
// → Logs: "Artifact live at https://{agentId}.lt.desplega.ai"
```

```typescript
// Advanced example — custom Hono app with swarm API proxy
import { createArtifactServer } from '@desplega.ai/artifact-sdk';
import { Hono } from 'hono';

const app = new Hono();

app.get('/', (c) => c.html(`
  <h1>PR Review #42</h1>
  <button id="approve">Approve</button>
  <script src="/@swarm/sdk.js"></script>
  <script>
    const swarm = new SwarmSDK();
    document.getElementById('approve').onclick = () =>
      swarm.createTask({ task: 'Merge PR #42 — approved' });
  </script>
`));

// Custom API routes (agent-specific logic)
app.post('/api/approve', async (c) => {
  const { prNumber, comment } = await c.req.json();
  // Agent logic here...
  return c.json({ ok: true });
});

const server = createArtifactServer({
  name: 'pr-review',
  app,  // Pass Hono app instead of static dir
});

await server.start();
```

**`createArtifactServer(options)` internals:**

```typescript
interface ArtifactServerOptions {
  name: string;                    // Artifact name for registry
  static?: string;                 // Path to static directory (mutually exclusive with app)
  app?: HonoApp;                   // Custom Hono application
  port?: number;                   // Local port (default: 3000)
  auth?: boolean;                  // Enable Basic Auth (default: true)
  subdomain?: string;              // Custom subdomain (default: AGENT_ID env)
}

interface ArtifactServer {
  start(): Promise<void>;          // Start server + tunnel + register
  stop(): Promise<void>;           // Stop everything + unregister
  url: string;                     // Public URL (available after start)
  tunnel: LocaltunnelInstance;     // Raw tunnel object
}
```

**What `start()` does:**

1. Creates a Hono app wrapping the user's app or static handler
2. Injects middleware:
   - `/@swarm/sdk.js` → serves the browser SDK bundle
   - `/@swarm/api/*` → proxies to the swarm MCP server HTTP API (`$MCP_BASE_URL`)
   - `/@swarm/config` → returns `{ agentId, artifactName }` as JSON
3. Starts HTTP server on the specified port
4. Creates localtunnel with `{ port, subdomain: AGENT_ID, auth: API_KEY }`
5. Registers via `POST $MCP_BASE_URL/api/services` (or `register-service` tool)
6. Sets up SIGTERM handler for graceful shutdown

#### Browser-Side SDK (`/@swarm/sdk.js`)

Auto-served by the artifact server. Provides a clean API for HTML pages to interact with the swarm.

```html
<script src="/@swarm/sdk.js"></script>
<script>
  const swarm = new SwarmSDK();

  // Task management
  await swarm.createTask({ task: 'Do something', tags: ['from-artifact'] });
  const tasks = await swarm.getTasks({ status: 'in_progress', limit: 10 });
  const detail = await swarm.getTaskDetails(taskId);

  // Messaging
  await swarm.postMessage({ channel: 'general', content: 'Hello from artifact!' });
  const messages = await swarm.readMessages({ channel: 'general', limit: 20 });

  // Agent info
  const agents = await swarm.getSwarm();
  const myAgent = await swarm.getMyAgent();

  // Epics
  const epics = await swarm.listEpics({ status: 'active' });

  // Services
  const services = await swarm.listServices();
</script>
```

**How it works internally:**

```javascript
class SwarmSDK {
  constructor() {
    // Config is fetched from the artifact server on init
    this._configPromise = fetch('/@swarm/config').then(r => r.json());
  }

  async createTask(opts) {
    // Proxied through the artifact server to avoid CORS
    return this._post('/@swarm/api/tasks', opts);
  }

  async getTasks(filters) {
    const params = new URLSearchParams(filters);
    return this._get(`/@swarm/api/tasks?${params}`);
  }

  async postMessage(opts) {
    return this._post('/@swarm/api/messages', opts);
  }

  // ... other methods map to swarm HTTP API endpoints

  async _post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async _get(url) {
    const res = await fetch(url);
    return res.json();
  }
}
```

**Security model:**
- The tunnel's Basic Auth gates access to the artifact (only credentialed users can reach it)
- The SDK calls go through the artifact server (`/@swarm/api/*`), which proxies to `$MCP_BASE_URL` with the agent's `Authorization` and `X-Agent-ID` headers
- The browser never has direct swarm API access — the artifact server is the proxy
- The agent can add middleware to filter/validate SDK requests before forwarding

### Agent Developer Experience — Step by Step

Here's how an agent (e.g., Researcher) would create and serve an artifact:

#### Step 1: Write the artifact content

```javascript
// /workspace/personal/artifacts/pr-review/index.html
// or
// /workspace/personal/artifacts/pr-review/server.js
```

The agent generates HTML/JS as part of its normal task work. For example, after analyzing PRs, it generates a review dashboard.

#### Step 2: Serve it

**Option A — Static content (simplest):**
```bash
# Agent runs this via Bash tool
cd /workspace/personal/artifacts/pr-review
artifact serve . --name "pr-review-42"
```

**Option B — Programmatic (inside a task script):**
```javascript
// The agent writes and runs this script
import { createArtifactServer } from '@desplega.ai/artifact-sdk';

const server = createArtifactServer({
  name: 'pr-review-42',
  static: '/workspace/personal/artifacts/pr-review',
});

await server.start();
console.log(`Live at: ${server.url}`);
```

**Option C — Custom server with interactivity:**
```javascript
import { createArtifactServer } from '@desplega.ai/artifact-sdk';
import { Hono } from 'hono';

const app = new Hono();
app.get('/', (c) => c.html(myGeneratedHtml));
app.post('/api/approve', async (c) => { /* handle approval */ });

const server = createArtifactServer({ name: 'approval-flow', app });
await server.start();
```

#### Step 3: Share the URL

The agent posts the URL to Slack or includes it in task output:

```javascript
await swarm.slackReply({
  taskId: currentTaskId,
  message: `PR review artifact ready: ${server.url}`,
});
```

#### Step 4: Automatic cleanup

When the agent's task completes or the container restarts:
- PM2 manages the artifact server process
- The `Stop` hook in `src/hooks/hook.ts` could auto-close tunnels
- The service registry entry is cleaned up
- On container restart, PM2 auto-restarts via `ecosystem.config.cjs` from `/ecosystem` endpoint

### Integration with agent-swarm Project

Here's where artifacts hooks into the existing codebase:

```
src/
├── cli.tsx                    # Add `artifact` command dispatch
├── commands/
│   ├── artifact.ts            # NEW: artifact serve/list/stop/open
│   └── runner.ts              # No changes (artifacts are independent processes)
├── hooks/
│   └── hook.ts                # Add tunnel cleanup to Stop hook
├── tools/
│   └── register-service.ts    # Already handles service registration (no changes)
├── prompts/
│   └── base-prompt.ts         # Add BASE_PROMPT_ARTIFACTS section
├── server.ts                  # Add 'artifacts' capability gate
└── http.ts                    # Add /@swarm/api proxy routes (or separate server)

packages/
└── artifact-sdk/              # NEW: @desplega.ai/artifact-sdk npm package
    ├── src/
    │   ├── server.ts          # createArtifactServer()
    │   ├── tunnel.ts          # Localtunnel wrapper
    │   ├── proxy.ts           # /@swarm/api/* proxy middleware
    │   └── browser-sdk.ts     # Browser SDK (bundled to sdk.js)
    └── package.json

Dockerfile.worker              # Install @desplega.ai/localtunnel globally
docker-entrypoint.sh           # Optional: auto-start tunnel on container boot
```

#### Specific integration points:

| Component | File | Change |
|-----------|------|--------|
| **CLI command** | `src/cli.tsx` | Add `case "artifact":` dispatch to `src/commands/artifact.ts` |
| **Capability** | `src/server.ts:72` | Add `"artifacts"` to default capabilities string |
| **Base prompt** | `src/prompts/base-prompt.ts` | Add `BASE_PROMPT_ARTIFACTS` with usage instructions, gated by `hasCapability("artifacts")` |
| **Stop hook** | `src/hooks/hook.ts` (Stop case) | Call `tunnel.close()` for any running artifact tunnels |
| **Service registry** | `src/tools/register-service.ts` | No changes — already supports metadata for custom service types |
| **Docker** | `Dockerfile.worker` | `npm install -g @desplega.ai/localtunnel` |
| **Entrypoint** | `docker-entrypoint.sh` | Optional: auto-create tunnel when PM2 starts a registered artifact service |
| **PM2 ecosystem** | `src/http.ts` (`/ecosystem`) | Already generates PM2 config from registered services — artifacts auto-restart on container boot |

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

#### Agent IDs as Subdomains — Tested

Agent IDs are UUIDs like `16990304-76e4-4017-b991-f3e37b34cf73`. These are 36 characters, contain only hex digits and hyphens, and are lowercase — they pass the subdomain validation regex.

**Tested against `lt.desplega.ai` on 2026-02-26:**

| Format | Example | Length | Result |
|--------|---------|--------|--------|
| Full UUID with hyphens | `16990304-76e4-4017-b991-f3e37b34cf73` | 36 | **Works** — tunnel created, HTTP 200 confirmed |
| Short UUID prefix | `16990304` | 8 | **Works** — tunnel created |
| UUID without hyphens | `1699030476e44017b991f3e37b34cf73` | 32 | **Works** — tunnel created |

```bash
# Actual test output:
$ lt --port 8787 --subdomain 16990304-76e4-4017-b991-f3e37b34cf73 --host https://lt.desplega.ai
your url is: https://16990304-76e4-4017-b991-f3e37b34cf73.lt.desplega.ai

$ curl -H "Bypass-Tunnel-Reminder: true" https://16990304-76e4-4017-b991-f3e37b34cf73.lt.desplega.ai
Hello from UUID subdomain test!  # HTTP 200
```

No issues with UUID length, hyphens, or character set. The server validates and accepts all three formats.

**Recommendation:** Use full UUID. The URL is primarily for programmatic access, not for humans typing into browsers. The service registry provides a human-friendly lookup. This also matches the existing URL pattern: `https://{agentId}.{SWARM_URL}` (see `src/tools/register-service.ts:76`).

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
| **user=`swarm`, pass=API key** | Use existing API key as tunnel password | Simple, no new secrets, already available in env | API key shared across all tunnels |
| Per-agent HMAC-derived password | `auth: hash(agentId + swarmSecret)` | Per-agent isolation, deterministic | Requires separate secret management |

**Recommendation:** Use `username=swarm`, `password=API_KEY` as the default. The API key (`API_KEY` env var) is already available in every worker container — it's set in `docker-entrypoint.sh` and used for MCP server auth. This means zero additional configuration.

For enhanced security in production, an HMAC-derived per-agent password (`crypto.createHmac('sha256', API_KEY).update(agentId).digest('hex')`) would provide per-agent isolation — if one tunnel's password leaks, others aren't compromised. But for MVP, the API key approach is simpler and sufficient.

> **Note:** The localtunnel client currently hardcodes `username="hi"`. To use `username="swarm"`, the client's `Tunnel.js` needs a minor patch to accept a custom username option. Alternatively, the server could be configured to only check the password (since the username is less important for security).

### Lifecycle Management

1. **Container restart:** Server frees subdomain after 1s grace. Agent reconnects with same subdomain immediately.
2. **Server restart:** All tunnels lost. Client retry loop handles reconnection (1s interval).
3. **Stale subdomains:** Held up to 10 minutes (socket timeout). Acceptable for MVP.

### Implementation Sketch

```typescript
// src/commands/artifact.ts — core artifact serve logic
import localtunnel from '@desplega.ai/localtunnel';

const AGENT_ID = process.env.AGENT_ID;
const API_KEY = process.env.API_KEY;
const MCP_BASE_URL = process.env.MCP_BASE_URL;

// Create tunnel with swarm auth
const tunnel = await localtunnel({
  port: 3000,
  subdomain: AGENT_ID,
  auth: API_KEY,  // username defaults to "hi", password = API key
  // TODO: patch client to support username: 'swarm'
});

console.log(`Artifact URL: ${tunnel.url}`);
// https://hi:<API_KEY>@<agentId>.lt.desplega.ai

// Register in service registry via HTTP API
await fetch(`${MCP_BASE_URL}/api/services`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${API_KEY}`,
    'X-Agent-ID': AGENT_ID,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    script: '/workspace/personal/artifacts/server.js',
    metadata: {
      type: 'artifact',
      artifactName: 'pr-review-42',
      publicUrl: tunnel.url,
    },
  }),
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await tunnel.close();
  // Service unregistered via Stop hook
});
```

---

## Part 5: Known Issues & Risks

| Issue | Severity | Mitigation |
|-------|----------|------------|
| **10 max TCP sockets per tunnel** | Medium | Fine for artifacts. Fix the property name bug (`maxSockets` → `maxTcpSockets`). |
| **1-second grace period** | Low | Good for subdomain reuse, no overlap possible. |
| **No heartbeat mechanism** | Medium | Stale subdomains held up to 10 minutes. Acceptable for MVP. |
| **Hardcoded username "hi"** | Medium | Need to patch client to support `username: 'swarm'` for cleaner auth. Alternatively, server could validate password only. |
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

### Phase 1: Foundation (MVP)
1. **Patch localtunnel client** — add `username` option to `@desplega.ai/localtunnel` so we can use `swarm` instead of `hi`
2. **Fix the `maxSockets` property name bug** in `desplega-ai/localtunnel-server`
3. **Create `@desplega.ai/artifact-sdk`** package with `createArtifactServer()`, static serving, and tunnel management
4. **Add `artifact` CLI command** to `src/cli.tsx` with `serve`, `list`, `stop` subcommands

### Phase 2: Interactivity
5. **Build the browser SDK** (`/@swarm/sdk.js`) for HTML → swarm API calls
6. **Add `/@swarm/api/*` proxy** middleware in the artifact server
7. **Add `BASE_PROMPT_ARTIFACTS`** section to `src/prompts/base-prompt.ts`

### Phase 3: Polish
8. **Add tunnel cleanup to Stop hook** in `src/hooks/hook.ts`
9. **Add `artifact open`** command that opens URL with embedded credentials
10. **Install `@desplega.ai/localtunnel`** globally in `Dockerfile.worker`
11. **Health check endpoint** — `/health` on each artifact for monitoring
