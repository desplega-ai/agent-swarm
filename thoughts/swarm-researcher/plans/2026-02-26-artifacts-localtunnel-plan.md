---
date: 2026-02-26
author: Researcher (16990304-76e4-4017-b991-f3e37b34cf73)
topic: "Implementation Plan: Agent Artifacts via Localtunnel"
status: ready
related_research: thoughts/swarm-researcher/research/2026-02-26-artifacts-localtunnel.md
repo: desplega-ai/agent-swarm
---

# Implementation Plan: Agent Artifacts via Localtunnel

## Overview

This plan implements the "artifacts" feature — agents can serve HTML pages, interactive apps, and rich content via public URLs using localtunnel tunnels to `lt.desplega.ai`. The feature enables agents to produce visual deliverables (dashboards, approval flows, data viewers) beyond text-only Slack/task outputs.

**Repo:** `desplega-ai/agent-swarm` (all work is in this repo)

> **Upstream dependencies:** The `maxSockets` bug fix in `desplega-ai/localtunnel-server` has already been merged. The custom username feature in the localtunnel client (`"hi"` → `"swarm"`) is deferred to post-MVP — we'll use the default `"hi"` username for now.

**Implementation order:** Phase 1 → 2 → 3 → 4 → 5

All 5 phases are in agent-swarm. Each phase is independently deployable and testable.

---

## Current State

- Localtunnel infrastructure is live at `lt.desplega.ai` with wildcard DNS via Caddy
- Client (`@desplega.ai/localtunnel` v2.2.0) supports deterministic subdomains and `--auth` flag
- Server (`desplega-ai/localtunnel-server` v0.1.3) supports HTTP Basic Auth (timing-safe) and 409 conflict handling
- Agent IDs (UUIDs) work as subdomains — tested and confirmed (36-char with hyphens, 8-char prefix, 32-char no-hyphens all work)
- Auth uses hardcoded username `"hi"` — acceptable for MVP (deferred to post-MVP)
- ~~`maxSockets` bug in server~~ — **already merged** (fixed `ClientManager.js` to pass `maxTcpSockets`)
- No artifact-related code exists in agent-swarm yet

## Desired End State

- Agents can serve artifacts via `createArtifactServer()` from `src/artifact-sdk/`
- CLI provides `artifact serve|list|stop` commands
- Multiple artifacts per worker, each with dynamic port and unique subdomain (`{agentId}-{name}.lt.desplega.ai`)
- Browser SDK (`/@swarm/sdk.js`) enables HTML artifacts to call swarm API
- Proxy middleware (`/@swarm/api/*`) routes browser requests to MCP server
- `/artifacts` skill provides detailed usage docs, examples, and references (base prompt just mentions the skill)
- Artifact content stored in persisted paths (`/workspace/personal/artifacts/` by default)
- Stop hook auto-closes tunnels on session end
- Docker image includes `@desplega.ai/localtunnel` globally

## What We're NOT Doing

- No npm publishing of `artifact-sdk` — it lives in-repo
- No raw TCP/UDP tunneling — HTTP only
- No multi-agent artifact sharing (each agent owns its artifacts)
- No WebSocket support in the browser SDK (REST-only proxy for MVP)
- No HMAC-derived per-agent passwords (using shared API_KEY for MVP)
- No custom auth username for MVP — using default `"hi"` (deferred to post-MVP)
- No `artifact open` command — agents run headless in Docker, no browser to open

---

## Pre-MVP: Upstream Dependencies (Completed / Deferred)

### ~~Localtunnel Server — `maxSockets` Bug~~ ✅ MERGED

The property name mismatch (`maxSockets` → `maxTcpSockets`) in `desplega-ai/localtunnel-server` has already been fixed and merged. No action needed.

### Localtunnel Client — Custom Username ⏳ DEFERRED (post-MVP)

Adding a `username` option to `@desplega.ai/localtunnel` so we can use `"swarm"` instead of `"hi"` is deferred. For MVP, we use the default username `"hi"` — it works fine, just looks less polished in the auth prompt. Can be revisited after the core feature is working.

---

## Phase 1: Artifact SDK — Core Module

**Goal:** Create `src/artifact-sdk/` in the agent-swarm repo with `createArtifactServer()`, dynamic port allocation, localtunnel integration, and service registry. Artifact content defaults to the persisted path `/workspace/personal/artifacts/`.

**Repo:** `desplega-ai/agent-swarm`

### Persisted Artifact Storage

Artifact content (HTML, JS, static files) must be stored in a persisted directory so it survives container restarts. Default: `/workspace/personal/artifacts/<artifact-name>/`.

- `/workspace/personal/` is a Docker volume — persists across sessions
- Each artifact gets a subdirectory: `/workspace/personal/artifacts/pr-review-42/`
- Agents can also use `/workspace/shared/artifacts/` for cross-agent visibility
- The SDK and CLI default to `/workspace/personal/artifacts/` when no explicit path is given

### Dependencies to add

**`package.json`** — Add runtime dependencies:
```json
{
  "dependencies": {
    "hono": "^4.0.0",
    "@desplega.ai/localtunnel": "^2.2.0",
    "get-port": "^7.0.0"
  }
}
```

> **Note:** `get-port` is a tiny ESM module that finds available TCP ports. Alternative: use Bun's `Bun.serve({ port: 0 })` which auto-assigns a free port.

### Files to create

**`src/artifact-sdk/index.ts`** — Public exports
```typescript
export { createArtifactServer } from './server';
export type { ArtifactServerOptions, ArtifactServer } from './server';
```

**`src/artifact-sdk/port.ts`** — Dynamic port allocation
```typescript
import { createServer } from 'node:net';

export async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}
```

**`src/artifact-sdk/tunnel.ts`** — Localtunnel wrapper
```typescript
import localtunnel from '@desplega.ai/localtunnel';

interface TunnelOptions {
  port: number;
  subdomain: string;
  auth?: string;
  username?: string;
}

export async function createTunnel(opts: TunnelOptions) {
  const tunnel = await localtunnel({
    port: opts.port,
    subdomain: opts.subdomain,
    auth: opts.auth,
    username: opts.username || 'hi',  // default 'hi' for MVP (custom username deferred)
    // host defaults to lt.desplega.ai in our fork
  });
  return tunnel;
}
```

**`src/artifact-sdk/proxy.ts`** — `/@swarm/api/*` proxy middleware for Hono
```typescript
import { Hono } from 'hono';

export function swarmProxyMiddleware(mcpBaseUrl: string, apiKey: string, agentId: string) {
  const proxy = new Hono();

  proxy.all('/@swarm/api/*', async (c) => {
    const path = c.req.path.replace('/@swarm/api', '');
    const targetUrl = `${mcpBaseUrl}${path}`;
    const res = await fetch(targetUrl, {
      method: c.req.method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'X-Agent-ID': agentId,
        'Content-Type': 'application/json',
      },
      body: c.req.method !== 'GET' ? await c.req.text() : undefined,
    });
    return new Response(res.body, {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
    });
  });

  return proxy;
}
```

**`src/artifact-sdk/browser-sdk.ts`** — Browser SDK source (served as `/@swarm/sdk.js`)
```typescript
// This is a string template that gets served as JavaScript to the browser
export const BROWSER_SDK_JS = `
class SwarmSDK {
  constructor() {
    this._configPromise = fetch('/@swarm/config').then(r => r.json());
  }

  async createTask(opts) { return this._post('/@swarm/api/tasks', opts); }
  async getTasks(filters) { return this._get('/@swarm/api/tasks?' + new URLSearchParams(filters)); }
  async getTaskDetails(id) { return this._get('/@swarm/api/tasks/' + id); }
  async postMessage(opts) { return this._post('/@swarm/api/messages', opts); }
  async readMessages(opts) { return this._get('/@swarm/api/messages?' + new URLSearchParams(opts)); }
  async getSwarm() { return this._get('/@swarm/api/agents'); }

  async _post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  }
  async _get(url) {
    const res = await fetch(url);
    return res.json();
  }
}

window.SwarmSDK = SwarmSDK;
`;
```

**`src/artifact-sdk/server.ts`** — Main `createArtifactServer()` implementation
```typescript
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { getAvailablePort } from './port';
import { createTunnel } from './tunnel';
import { swarmProxyMiddleware } from './proxy';
import { BROWSER_SDK_JS } from './browser-sdk';

export interface ArtifactServerOptions {
  name: string;
  static?: string;
  app?: Hono;
  port?: number;
  auth?: boolean;
  subdomain?: string;
}

export interface ArtifactServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  url: string;
  port: number;
  tunnel: any;
}

export function createArtifactServer(opts: ArtifactServerOptions): ArtifactServer {
  const agentId = process.env.AGENT_ID || 'unknown';
  const apiKey = process.env.API_KEY || '';
  const mcpBaseUrl = process.env.MCP_BASE_URL || 'http://localhost:3013';

  const app = new Hono();

  // Inject swarm middleware
  app.get('/@swarm/sdk.js', (c) => {
    c.header('Content-Type', 'application/javascript');
    return c.body(BROWSER_SDK_JS);
  });

  app.get('/@swarm/config', (c) => {
    return c.json({ agentId, artifactName: opts.name });
  });

  // API proxy
  app.all('/@swarm/api/*', async (c) => {
    const path = c.req.path.replace('/@swarm/api', '/api');
    const targetUrl = `${mcpBaseUrl}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${apiKey}`,
      'X-Agent-ID': agentId,
    };
    if (c.req.method !== 'GET') {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      body: c.req.method !== 'GET' ? await c.req.text() : undefined,
    });
    return new Response(res.body, { status: res.status });
  });

  // User app or static serving
  if (opts.app) {
    app.route('/', opts.app);
  } else if (opts.static) {
    app.use('/*', serveStatic({ root: opts.static }));
  }

  let server: ReturnType<typeof Bun.serve> | null = null;
  let tunnel: any = null;
  let actualPort = 0;

  const artifact: ArtifactServer = {
    url: '',
    port: 0,
    tunnel: null,

    async start() {
      actualPort = opts.port || await getAvailablePort();
      server = Bun.serve({ port: actualPort, fetch: app.fetch });
      artifact.port = actualPort;

      const subdomain = opts.subdomain || `${agentId}-${opts.name}`;
      const authPassword = opts.auth === false ? undefined : apiKey;

      tunnel = await createTunnel({
        port: actualPort,
        subdomain,
        auth: authPassword,
      });

      artifact.url = tunnel.url;
      artifact.tunnel = tunnel;

      // Register in service registry
      try {
        await fetch(`${mcpBaseUrl}/api/services`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'X-Agent-ID': agentId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            script: `artifact-${opts.name}`,
            metadata: {
              type: 'artifact',
              artifactName: opts.name,
              port: actualPort,
              publicUrl: tunnel.url,
            },
          }),
        });
      } catch (e) {
        console.warn('Failed to register artifact in service registry:', e);
      }

      console.log(`Artifact "${opts.name}" live at ${tunnel.url} (port ${actualPort})`);
    },

    async stop() {
      if (tunnel) {
        await tunnel.close();
        tunnel = null;
      }
      if (server) {
        server.stop();
        server = null;
      }
    },
  };

  return artifact;
}
```

### Success Criteria

#### Automated Verification
- [ ] `bun run typecheck` passes (no TS errors in new files)
- [ ] `bun run lint` passes (biome lint)
- [ ] `bun test` passes (existing tests unaffected)

#### Manual Verification

**Test 1: Dynamic port allocation**
```bash
cd /workspace/repos/agent-swarm

# Create a test script
cat > /tmp/test-artifact-port.ts << 'EOF'
import { getAvailablePort } from './src/artifact-sdk/port';

const port1 = await getAvailablePort();
const port2 = await getAvailablePort();
console.log(`Port 1: ${port1}`);
console.log(`Port 2: ${port2}`);
console.assert(port1 !== port2, 'Ports should be different');
console.assert(port1 > 0 && port1 < 65536, 'Port 1 in valid range');
console.assert(port2 > 0 && port2 < 65536, 'Port 2 in valid range');
console.log('PASS: Dynamic port allocation works');
EOF

bun run /tmp/test-artifact-port.ts
# Expected output:
# Port 1: <some number, e.g. 49152>
# Port 2: <different number, e.g. 49153>
# PASS: Dynamic port allocation works
```

**Test 2: Artifact server starts and serves content**
```bash
# Create test content
mkdir -p /tmp/test-artifact
echo '<h1>Test Artifact</h1>' > /tmp/test-artifact/index.html

# Create test script
cat > /tmp/test-artifact-serve.ts << 'EOF'
import { createArtifactServer } from './src/artifact-sdk';

const server = createArtifactServer({
  name: 'test-artifact',
  static: '/tmp/test-artifact',
  auth: false,  // disable tunnel auth for local test
});

await server.start();
console.log(`Server running on port ${server.port}`);
console.log(`URL: ${server.url}`);

// Test local access
const res = await fetch(`http://localhost:${server.port}/`);
const body = await res.text();
console.log(`Status: ${res.status}`);
console.log(`Body: ${body}`);
console.assert(res.status === 200, 'Expected HTTP 200');
console.assert(body.includes('Test Artifact'), 'Expected body to contain "Test Artifact"');

// Test /@swarm/config endpoint
const configRes = await fetch(`http://localhost:${server.port}/@swarm/config`);
const config = await configRes.json();
console.log(`Config: ${JSON.stringify(config)}`);
console.assert(config.artifactName === 'test-artifact', 'Expected artifactName');

// Test /@swarm/sdk.js endpoint
const sdkRes = await fetch(`http://localhost:${server.port}/@swarm/sdk.js`);
console.assert(sdkRes.status === 200, 'SDK endpoint returns 200');
console.assert(sdkRes.headers.get('content-type')?.includes('javascript'), 'SDK has JS content type');

await server.stop();
console.log('PASS: Artifact server starts and serves content');
EOF

cd /workspace/repos/agent-swarm
AGENT_ID=test-agent API_KEY=test-key bun run /tmp/test-artifact-serve.ts
# Expected output:
# Server running on port <dynamic>
# URL: https://test-agent-test-artifact.lt.desplega.ai
# Status: 200
# Body: <h1>Test Artifact</h1>
# Config: {"agentId":"test-agent","artifactName":"test-artifact"}
# PASS: Artifact server starts and serves content
```

**Test 3: Multiple artifacts on different ports**
```bash
cat > /tmp/test-multi-artifact.ts << 'EOF'
import { createArtifactServer } from './src/artifact-sdk';

const artifact1 = createArtifactServer({ name: 'app-one', static: '/tmp/test-artifact' });
const artifact2 = createArtifactServer({ name: 'app-two', static: '/tmp/test-artifact' });

await artifact1.start();
await artifact2.start();

console.log(`Artifact 1: port=${artifact1.port}, url=${artifact1.url}`);
console.log(`Artifact 2: port=${artifact2.port}, url=${artifact2.url}`);

console.assert(artifact1.port !== artifact2.port, 'Ports should differ');
console.assert(artifact1.url !== artifact2.url, 'URLs should differ');
console.assert(artifact1.url.includes('app-one'), 'URL 1 should contain artifact name');
console.assert(artifact2.url.includes('app-two'), 'URL 2 should contain artifact name');

// Both should serve content
const res1 = await fetch(`http://localhost:${artifact1.port}/`);
const res2 = await fetch(`http://localhost:${artifact2.port}/`);
console.assert(res1.status === 200, 'Artifact 1 serves content');
console.assert(res2.status === 200, 'Artifact 2 serves content');

await artifact1.stop();
await artifact2.stop();
console.log('PASS: Multiple artifacts on different ports');
EOF

cd /workspace/repos/agent-swarm
AGENT_ID=test-agent API_KEY=test-key bun run /tmp/test-multi-artifact.ts
# Expected:
# Artifact 1: port=<N>, url=https://test-agent-app-one.lt.desplega.ai
# Artifact 2: port=<M>, url=https://test-agent-app-two.lt.desplega.ai
# PASS: Multiple artifacts on different ports
```

**Test 4: Tunnel connectivity (end-to-end via lt.desplega.ai)**
```bash
cat > /tmp/test-artifact-e2e.ts << 'EOF'
import { createArtifactServer } from './src/artifact-sdk';
import { Hono } from 'hono';

const app = new Hono();
app.get('/', (c) => c.text('Hello from artifact E2E test!'));

const server = createArtifactServer({
  name: 'e2e-test',
  app,
  auth: false,  // simpler for testing
});

await server.start();
console.log(`Artifact URL: ${server.url}`);

// Wait for tunnel to stabilize
await new Promise(r => setTimeout(r, 2000));

// Test via public URL
const res = await fetch(server.url, {
  headers: { 'Bypass-Tunnel-Reminder': 'true' }
});
const body = await res.text();
console.log(`Public URL status: ${res.status}`);
console.log(`Public URL body: ${body}`);
console.assert(res.status === 200, 'Expected HTTP 200 via tunnel');
console.assert(body.includes('Hello from artifact E2E test'), 'Expected correct body via tunnel');

await server.stop();
console.log('PASS: End-to-end tunnel connectivity');
EOF

cd /workspace/repos/agent-swarm
AGENT_ID=$(cat /proc/sys/kernel/random/uuid | tr -d '-' | head -c 32) \
API_KEY=test-key \
bun run /tmp/test-artifact-e2e.ts
# Expected:
# Artifact URL: https://<uuid>-e2e-test.lt.desplega.ai
# Public URL status: 200
# Public URL body: Hello from artifact E2E test!
# PASS: End-to-end tunnel connectivity
```

---

## Phase 2: CLI `artifact` Command

**Goal:** Add `artifact serve|list|stop` subcommands to the agent-swarm CLI.

**Repo:** `desplega-ai/agent-swarm`

### Files to create/modify

**`src/commands/artifact.ts`** — NEW: Artifact command module

Implements 3 subcommands:
- `serve <path> --name <name> [--port <port>] [--no-auth] [--subdomain <sub>]`
- `list` — queries service registry for `metadata.type === "artifact"`
- `stop <name>` — stops PM2 process, closes tunnel, unregisters service

```typescript
// Pattern follows existing commands — export an async function
export async function runArtifact(subcommand: string, args: Record<string, any>) {
  switch (subcommand) {
    case 'serve': return artifactServe(args);
    case 'list': return artifactList(args);
    case 'stop': return artifactStop(args);
    default: console.error(`Unknown artifact subcommand: ${subcommand}`);
  }
}
```

For `serve`:
1. If path is a directory → create a Hono app with `serveStatic`
2. If path is a `.js`/`.ts` file → start via PM2 (`pm2 start <script> --name artifact-<name>`)
3. Create tunnel via artifact SDK
4. Register service

For `list`:
1. Call `GET /api/services` with auth headers
2. Filter for `metadata.type === "artifact"`
3. Format as table output

For `stop`:
1. Find artifact in service registry by name
2. `pm2 delete artifact-<name>` (via child_process)
3. Call `DELETE /api/services/:id` to unregister

**`src/cli.tsx`** — Add dispatch for `artifact` command

In the `App` component's command switch (around line 562-598):
```typescript
case "artifact":
  // artifact commands don't need Ink rendering
  const { runArtifact } = await import('./commands/artifact');
  await runArtifact(args.additionalArgs?.[0] || 'help', args);
  exit();
  break;
```

### Success Criteria

#### Automated Verification
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] `bun test` passes

#### Manual Verification

**Test 1: `artifact serve` with static directory**
```bash
cd /workspace/repos/agent-swarm

# Create test content in persisted path
mkdir -p /workspace/personal/artifacts/cli-test
echo '<h1>CLI Artifact Test</h1>' > /workspace/personal/artifacts/cli-test/index.html

# Run the CLI command
AGENT_ID=test-cli-agent API_KEY=test-key \
  bun run src/cli.tsx artifact serve /workspace/personal/artifacts/cli-test --name cli-test

# Expected output:
# Artifact "cli-test" live at https://test-cli-agent-cli-test.lt.desplega.ai (port <dynamic>)

# In another terminal, verify:
curl -H "Bypass-Tunnel-Reminder: true" \
  "https://test-cli-agent-cli-test.lt.desplega.ai"
# Expected: HTTP 200, body contains "<h1>CLI Artifact Test</h1>"
```

**Test 2: `artifact list`**
```bash
# While artifact from Test 1 is running:
AGENT_ID=test-cli-agent API_KEY=test-key MCP_BASE_URL=http://localhost:3013 \
  bun run src/cli.tsx artifact list

# Expected output (table format):
# NAME        AGENT           PORT   URL                                                STATUS
# cli-test    test-cli-agent  <N>    https://test-cli-agent-cli-test.lt.desplega.ai    healthy
```

**Test 3: `artifact stop`**
```bash
AGENT_ID=test-cli-agent API_KEY=test-key MCP_BASE_URL=http://localhost:3013 \
  bun run src/cli.tsx artifact stop cli-test

# Expected: "Artifact 'cli-test' stopped."

# Verify it's gone:
bun run src/cli.tsx artifact list
# Expected: empty list or "No active artifacts"

# Verify tunnel is closed:
curl -H "Bypass-Tunnel-Reminder: true" \
  "https://test-cli-agent-cli-test.lt.desplega.ai"
# Expected: connection error or 502 (tunnel no longer exists)
```

**Test 4: `artifact serve` with custom Hono app**
```bash
cat > /tmp/test-custom-server.ts << 'EOF'
import { Hono } from 'hono';
const app = new Hono();
app.get('/', (c) => c.text('Custom server works!'));
app.get('/api/data', (c) => c.json({ items: [1, 2, 3] }));
export default app;
EOF

AGENT_ID=test-cli-agent API_KEY=test-key \
  bun run src/cli.tsx artifact serve /tmp/test-custom-server.ts --name custom-app

# Verify custom routes work
curl -H "Bypass-Tunnel-Reminder: true" \
  "https://test-cli-agent-custom-app.lt.desplega.ai"
# Expected: "Custom server works!"

curl -H "Bypass-Tunnel-Reminder: true" \
  "https://test-cli-agent-custom-app.lt.desplega.ai/api/data"
# Expected: {"items":[1,2,3]}
```

---

## Phase 3: Browser SDK + API Proxy

**Goal:** Build the browser-side SDK (`/@swarm/sdk.js`) and the `/@swarm/api/*` proxy middleware that allows HTML artifacts to call swarm API endpoints.

**Repo:** `desplega-ai/agent-swarm`

### Files to modify

This phase primarily refines `src/artifact-sdk/browser-sdk.ts` and `src/artifact-sdk/proxy.ts` created in Phase 3.

**`src/artifact-sdk/browser-sdk.ts`** — Expand with full swarm API coverage:
- `createTask(opts)` → `POST /@swarm/api/tasks`
- `getTasks(filters)` → `GET /@swarm/api/tasks`
- `getTaskDetails(id)` → `GET /@swarm/api/tasks/:id`
- `storeProgress(taskId, data)` → `POST /@swarm/api/tasks/:id/progress`
- `postMessage(opts)` → `POST /@swarm/api/messages`
- `readMessages(opts)` → `GET /@swarm/api/messages`
- `getSwarm()` → `GET /@swarm/api/agents`
- `listServices()` → `GET /@swarm/api/services`
- `listEpics(opts)` → `GET /@swarm/api/epics`
- `slackReply(opts)` → `POST /@swarm/api/slack/reply`

**`src/artifact-sdk/proxy.ts`** — Ensure correct header forwarding and error handling:
- Forward `Authorization` and `X-Agent-ID` headers
- Handle non-JSON responses (file downloads, etc.)
- Return proper CORS headers for browser requests
- Handle proxy errors gracefully (return 502 with error message)

### Success Criteria

#### Automated Verification
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes

#### Manual Verification

**Test 1: SDK serves correctly and is executable in browser context**
```bash
cat > /tmp/test-sdk-serve.ts << 'EOF'
import { createArtifactServer } from './src/artifact-sdk';
import { Hono } from 'hono';

const app = new Hono();
app.get('/', (c) => c.html(`
<!DOCTYPE html>
<html>
<head><title>SDK Test</title></head>
<body>
  <h1>SDK Test Page</h1>
  <div id="result"></div>
  <script src="/@swarm/sdk.js"></script>
  <script>
    const swarm = new SwarmSDK();
    document.getElementById('result').textContent = 'SDK loaded: ' + (typeof SwarmSDK);
  </script>
</body>
</html>
`));

const server = createArtifactServer({ name: 'sdk-test', app, auth: false });
await server.start();
console.log('SDK test server at', server.url);
console.log('Local: http://localhost:' + server.port);

// Verify SDK endpoint returns JavaScript
const sdkRes = await fetch(`http://localhost:${server.port}/@swarm/sdk.js`);
const sdkBody = await sdkRes.text();
console.assert(sdkRes.status === 200, 'SDK returns 200');
console.assert(sdkBody.includes('class SwarmSDK'), 'SDK contains SwarmSDK class');
console.assert(sdkBody.includes('createTask'), 'SDK contains createTask method');
console.log('SDK content length:', sdkBody.length, 'bytes');

// Verify config endpoint
const configRes = await fetch(`http://localhost:${server.port}/@swarm/config`);
const config = await configRes.json();
console.assert(config.artifactName === 'sdk-test', 'Config has correct artifact name');

await server.stop();
console.log('PASS: Browser SDK serves correctly');
EOF

cd /workspace/repos/agent-swarm
AGENT_ID=test-agent API_KEY=test-key bun run /tmp/test-sdk-serve.ts
```

**Test 2: API proxy forwards requests correctly**
```bash
cat > /tmp/test-proxy.ts << 'EOF'
import { createArtifactServer } from './src/artifact-sdk';
import { Hono } from 'hono';

const app = new Hono();
app.get('/', (c) => c.text('Proxy test'));

const server = createArtifactServer({ name: 'proxy-test', app, auth: false });
await server.start();

// Test proxy endpoint — this will try to reach MCP_BASE_URL
// In test env, MCP might not be available, so we check the proxy behavior
const proxyRes = await fetch(`http://localhost:${server.port}/@swarm/api/agents`);
console.log(`Proxy status: ${proxyRes.status}`);
// Expected: 200 (if MCP server is reachable) or 502 (if not)
// Either way, the proxy should not crash

const proxyRes2 = await fetch(`http://localhost:${server.port}/@swarm/api/tasks`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ task: 'test task from proxy' }),
});
console.log(`Proxy POST status: ${proxyRes2.status}`);

await server.stop();
console.log('PASS: API proxy handles requests');
EOF

cd /workspace/repos/agent-swarm
AGENT_ID=test-agent API_KEY=test-key MCP_BASE_URL=http://localhost:3013 \
  bun run /tmp/test-proxy.ts
# Expected: proxy returns status codes (200 if MCP available, 502 if not)
# Key check: no crashes, graceful error handling
```

**Test 3: End-to-end browser SDK via tunnel (live MCP server)**
```bash
# This test requires a running MCP server — run on a worker container
cat > /tmp/test-sdk-e2e.ts << 'EOF'
import { createArtifactServer } from './src/artifact-sdk';
import { Hono } from 'hono';

const app = new Hono();
app.get('/', (c) => c.html(`
<html>
<body>
<h1>E2E SDK Test</h1>
<script src="/@swarm/sdk.js"></script>
<script>
  (async () => {
    const swarm = new SwarmSDK();
    try {
      const agents = await swarm.getSwarm();
      document.body.innerHTML += '<p>Agents: ' + JSON.stringify(agents) + '</p>';
    } catch(e) {
      document.body.innerHTML += '<p>Error: ' + e.message + '</p>';
    }
  })();
</script>
</body>
</html>
`));

const server = createArtifactServer({ name: 'sdk-e2e', app });
await server.start();
console.log(`Test at: ${server.url}`);

// Verify proxy works through tunnel
await new Promise(r => setTimeout(r, 2000));
const res = await fetch(`${server.url}/@swarm/api/agents`, {
  headers: { 'Bypass-Tunnel-Reminder': 'true' }
});
console.log(`Proxy via tunnel: ${res.status}`);
const agents = await res.json();
console.log(`Agents count: ${agents.length || Object.keys(agents).length}`);

await server.stop();
console.log('PASS: E2E SDK via tunnel works');
EOF

cd /workspace/repos/agent-swarm
bun run /tmp/test-sdk-e2e.ts
# Expected: proxy returns agents list via tunnel
```

---

## Phase 4: Artifacts Skill + Base Prompt Mention

**Goal:** Create a `/artifacts` skill (Claude Code skill) that provides detailed artifact usage documentation, code examples, and reference files. The base prompt only mentions the skill exists — all detailed instructions live in the skill.

**Repo:** `desplega-ai/agent-swarm`

### Why a skill instead of a prompt section?

Putting all artifact documentation inline in `BASE_PROMPT_ARTIFACTS` would bloat the system prompt for every session, even when agents aren't using artifacts. A skill is loaded on-demand when the agent invokes `/artifacts`, keeping the base prompt lean.

### Files to create

**`skills/artifacts/skill.md`** — Skill definition (loaded when `/artifacts` is invoked)

```markdown
# Artifacts — Serving Interactive Web Content

## Quick Start

### Static content
```bash
# Create your content in a persisted directory
mkdir -p /workspace/personal/artifacts/my-report
echo '<h1>My Report</h1>' > /workspace/personal/artifacts/my-report/index.html

# Serve it (auto-assigns a free port, creates tunnel)
artifact serve /workspace/personal/artifacts/my-report --name "my-report"
# → https://{agentId}-my-report.lt.desplega.ai
```

### Programmatic (custom Hono server)
```typescript
import { createArtifactServer } from '../artifact-sdk';
import { Hono } from 'hono';

const app = new Hono();
app.get('/', (c) => c.html('<h1>Dashboard</h1>'));

const server = createArtifactServer({ name: 'dashboard', app });
await server.start();
console.log(`Live at: ${server.url}`);
```

## CLI Commands
- `artifact serve <path> --name <name>` — Start serving content
- `artifact list` — List active artifacts with ports and URLs
- `artifact stop <name>` — Stop an artifact and close its tunnel

## Multiple Artifacts
Each artifact gets its own port (auto-assigned) and subdomain. You can serve multiple simultaneously.

## Browser SDK
HTML artifacts can interact with the swarm API:
```html
<script src="/@swarm/sdk.js"></script>
<script>
  const swarm = new SwarmSDK();
  await swarm.createTask({ task: 'Do something' });
  const agents = await swarm.getSwarm();
</script>
```

## Auth
Artifacts are protected by HTTP Basic Auth (username: `hi`, password: API key). Credentials are auto-configured.

## Storage
Always store artifact content in persisted directories:
- `/workspace/personal/artifacts/` — per-agent, persists across sessions (default)
- `/workspace/shared/artifacts/` — shared across swarm

See the `examples/` directory for complete working examples.
```

**`skills/artifacts/examples/`** — Reference examples directory

```
skills/artifacts/
├── skill.md                              # Main skill documentation
└── examples/
    ├── static-report.sh                  # Minimal static HTML artifact
    ├── hono-dashboard.ts                 # Custom Hono app with API routes
    ├── approval-flow.ts                  # Interactive approval form with Browser SDK
    └── multi-artifact.ts                 # Multiple artifacts from one agent
```

Each example file is a complete, copy-pasteable script that agents can reference or adapt.

**Example: `skills/artifacts/examples/static-report.sh`**
```bash
#!/bin/bash
# Serve a static HTML report as an artifact
ARTIFACT_DIR="/workspace/personal/artifacts/my-report"
mkdir -p "$ARTIFACT_DIR"

cat > "$ARTIFACT_DIR/index.html" << 'HTML'
<!DOCTYPE html>
<html>
<head><title>Agent Report</title></head>
<body>
  <h1>Analysis Report</h1>
  <p>Generated by agent on $(date)</p>
</body>
</html>
HTML

artifact serve "$ARTIFACT_DIR" --name "my-report"
```

**Example: `skills/artifacts/examples/approval-flow.ts`**
```typescript
import { createArtifactServer } from '../artifact-sdk';
import { Hono } from 'hono';

const app = new Hono();
app.get('/', (c) => c.html(`
<!DOCTYPE html>
<html>
<head><title>Approval Required</title></head>
<body>
  <h1>PR #42 — Review Required</h1>
  <p>Agent wants to merge this PR. Please review.</p>
  <button id="approve">Approve</button>
  <button id="reject">Reject</button>
  <script src="/@swarm/sdk.js"></script>
  <script>
    const swarm = new SwarmSDK();
    document.getElementById('approve').onclick = async () => {
      await swarm.createTask({ task: 'Merge PR #42 — human approved' });
      document.body.innerHTML = '<h1>Approved! Task created.</h1>';
    };
    document.getElementById('reject').onclick = async () => {
      await swarm.createTask({ task: 'PR #42 rejected by human — needs changes' });
      document.body.innerHTML = '<h1>Rejected. Agent notified.</h1>';
    };
  </script>
</body>
</html>
`));

const server = createArtifactServer({ name: 'approval-pr-42', app });
await server.start();
console.log(`Approval artifact at: ${server.url}`);
```

### Files to modify

**`src/prompts/base-prompt.ts`** — Add a brief mention (not the full docs)

Add to `BASE_PROMPT_SERVICES` or as a separate small section:

```typescript
const BASE_PROMPT_ARTIFACTS_MENTION = `
### Artifacts

Agents can serve interactive web content (HTML pages, dashboards, approval flows) via public URLs using localtunnel.
Use the \`/artifacts\` skill for detailed instructions, examples, and API reference.
Artifact content should be stored in \`/workspace/personal/artifacts/\` (persisted across sessions).
`;
```

Gate it the same way as services:
```typescript
if (!args.capabilities || args.capabilities.includes("artifacts")) {
  prompt += BASE_PROMPT_ARTIFACTS_MENTION;
}
```

### Success Criteria

#### Automated Verification
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] Skill file validates (correct markdown format)

#### Manual Verification

**Test 1: Skill file exists and is properly formatted**
```bash
cd /workspace/repos/agent-swarm

# Verify skill structure
ls -la skills/artifacts/
# Expected: skill.md, examples/ directory

ls -la skills/artifacts/examples/
# Expected: static-report.sh, hono-dashboard.ts, approval-flow.ts, multi-artifact.ts

# Verify skill.md contains key sections
grep -c "Quick Start\|CLI Commands\|Browser SDK\|Storage\|Auth" skills/artifacts/skill.md
# Expected: 5 (all sections present)
```

**Test 2: Base prompt mentions artifacts skill (brief)**
```bash
cat > /tmp/test-prompt-skill.ts << 'EOF'
import { getBasePrompt } from './src/prompts/base-prompt';

const prompt = getBasePrompt({
  role: 'worker',
  agentId: 'test-agent-id',
  swarmUrl: 'https://test.swarm.example.com',
  capabilities: ['core', 'artifacts', 'services'],
});

// Check brief mention is present
const hasMention = prompt.includes('/artifacts');
const hasPersonalPath = prompt.includes('/workspace/personal/artifacts/');
console.log(`Has /artifacts skill mention: ${hasMention}`);
console.log(`Has persisted path mention: ${hasPersonalPath}`);
console.assert(hasMention, 'Prompt should mention /artifacts skill');
console.assert(hasPersonalPath, 'Prompt should mention persisted path');

// Check it does NOT contain the full detailed docs
const hasFullDocs = prompt.includes('createArtifactServer');
console.log(`Has full docs inline: ${hasFullDocs}`);
console.assert(!hasFullDocs, 'Prompt should NOT contain full artifact docs — those go in the skill');

console.log('PASS: Base prompt mentions skill without bloating');
EOF

cd /workspace/repos/agent-swarm
bun run /tmp/test-prompt-skill.ts
# Expected: all assertions pass
```

**Test 3: Base prompt excludes mention when capability not set**
```bash
cat > /tmp/test-prompt-no-artifact.ts << 'EOF'
import { getBasePrompt } from './src/prompts/base-prompt';

const prompt = getBasePrompt({
  role: 'worker',
  agentId: 'test-agent-id',
  swarmUrl: 'https://test.swarm.example.com',
  capabilities: ['core', 'services'],  // No 'artifacts'
});

const hasMention = prompt.includes('/artifacts');
console.assert(!hasMention, 'Prompt should NOT mention artifacts without capability');
console.log('PASS: Artifacts mention excluded without capability');
EOF

cd /workspace/repos/agent-swarm
bun run /tmp/test-prompt-no-artifact.ts
# Expected: assertion passes
```

---

## Phase 5: Hook Integration + Docker

**Goal:** Add tunnel cleanup to the Stop hook and install `@desplega.ai/localtunnel` in the Docker image.

**Repo:** `desplega-ai/agent-swarm`

### Files to modify

**`src/hooks/hook.ts`** — Stop hook handler (around line 911-1046)

Add tunnel cleanup before the existing Stop logic:

```typescript
case "Stop": {
  // NEW: Close any artifact tunnels managed by PM2
  try {
    const { execSync } = await import('child_process');
    // List PM2 processes matching artifact-* pattern
    const pm2List = execSync('pm2 jlist 2>/dev/null || echo "[]"', { encoding: 'utf-8' });
    const processes = JSON.parse(pm2List);
    const artifactProcesses = processes.filter((p: any) =>
      p.name?.startsWith('artifact-')
    );

    for (const proc of artifactProcesses) {
      try {
        execSync(`pm2 delete ${proc.name} 2>/dev/null`);
        log(`Stopped artifact process: ${proc.name}`);
      } catch {
        // Process might already be stopped
      }
    }

    if (artifactProcesses.length > 0) {
      log(`Cleaned up ${artifactProcesses.length} artifact process(es)`);
    }
  } catch (e) {
    // Non-fatal: PM2 might not be available
  }

  // ... existing Stop hook logic continues ...
}
```

**`Dockerfile.worker`** — Install localtunnel client globally

Add after the existing `npm install -g` commands (around line 55-60):

```dockerfile
# Install localtunnel client for artifact tunneling
RUN npm install -g @desplega.ai/localtunnel
```

### Success Criteria

#### Automated Verification
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] `bun test` passes
- [ ] Docker build succeeds: `docker build -f Dockerfile.worker -t agent-swarm-test .`

#### Manual Verification

**Test 1: Stop hook cleans up artifact processes**
```bash
cd /workspace/repos/agent-swarm

# Start a fake artifact process via PM2
echo 'setInterval(() => {}, 1000)' > /tmp/fake-artifact.js
pm2 start /tmp/fake-artifact.js --name artifact-test-cleanup

# Verify it's running
pm2 list | grep artifact-test-cleanup
# Expected: shows "artifact-test-cleanup" with status "online"

# Simulate Stop hook execution
echo '{"hook_event_name":"Stop","session_id":"test-session","transcript_path":"/dev/null"}' | \
  bun run src/cli.tsx hook

# Verify artifact process was cleaned up
pm2 list | grep artifact-test-cleanup
# Expected: not found (process deleted)

# If pm2 list still shows it, the hook didn't clean it up — debug needed
pm2 delete artifact-test-cleanup 2>/dev/null  # manual cleanup
echo "PASS: Stop hook cleans up artifact processes"
```

**Test 2: Localtunnel installed in Docker image**
```bash
cd /workspace/repos/agent-swarm

# Build the Docker image (this tests Dockerfile changes)
docker build -f Dockerfile.worker -t agent-swarm-artifact-test . 2>&1 | tail -5
# Expected: build succeeds

# Verify localtunnel is available
docker run --rm agent-swarm-artifact-test lt --version
# Expected: prints version number (e.g., "2.2.0")

docker run --rm agent-swarm-artifact-test which lt
# Expected: /usr/local/bin/lt or similar path
```

**Test 3: Full lifecycle — serve, access, stop, cleanup**
```bash
# This test runs inside a worker container (or locally with env vars)
cd /workspace/repos/agent-swarm

# 1. Create content in persisted path
mkdir -p /workspace/personal/artifacts/lifecycle
echo '<h1>Lifecycle Test</h1>' > /workspace/personal/artifacts/lifecycle/index.html

# 2. Start artifact
AGENT_ID=lifecycle-test API_KEY=test-key \
  bun run src/cli.tsx artifact serve /workspace/personal/artifacts/lifecycle --name lifecycle &
SERVE_PID=$!
sleep 3  # wait for tunnel

# 3. Verify it's accessible
AGENT_ID=lifecycle-test API_KEY=test-key \
  bun run src/cli.tsx artifact list
# Expected: shows "lifecycle" artifact with URL and port

# 4. Access via public URL
curl -H "Bypass-Tunnel-Reminder: true" \
  "https://lifecycle-test-lifecycle.lt.desplega.ai" 2>/dev/null
# Expected: HTTP 200, body contains "Lifecycle Test"

# 5. Stop artifact
AGENT_ID=lifecycle-test API_KEY=test-key \
  bun run src/cli.tsx artifact stop lifecycle
# Expected: "Artifact 'lifecycle' stopped."

# 6. Verify tunnel is closed
curl -H "Bypass-Tunnel-Reminder: true" \
  "https://lifecycle-test-lifecycle.lt.desplega.ai" 2>/dev/null
# Expected: connection error or 502

# 7. Cleanup
kill $SERVE_PID 2>/dev/null
echo "PASS: Full lifecycle test"
```

---

## Testing Strategy Summary

### Automated Tests (CI)

| Test | Command | What it Verifies |
|------|---------|-----------------|
| TypeScript compilation | `bun run typecheck` | All new code compiles without errors |
| Linting | `bun run lint` | Code style/formatting passes biome |
| Unit tests | `bun test` | Existing tests not broken by new code |

### Manual Tests (Agent-Executed)

| Phase | Test | Critical Path |
|-------|------|---------------|
| 1 | Dynamic port allocation | two artifacts get different ports |
| 1 | Static content serving | HTTP 200 with correct body from persisted path |
| 1 | Multiple artifacts | independent ports and URLs |
| 1 | E2E tunnel connectivity | public URL returns correct response |
| 2 | CLI `artifact serve` | tunnel URL accessible |
| 2 | CLI `artifact list` | shows running artifacts |
| 2 | CLI `artifact stop` | tunnel closed, service unregistered |
| 3 | SDK endpoint | serves JavaScript with SwarmSDK class |
| 3 | API proxy | forwards requests to MCP server |
| 4 | Skill file exists | skill.md + examples/ present with correct structure |
| 4 | Prompt mentions skill | brief `/artifacts` mention in prompt, no full docs inline |
| 4 | Prompt gated by capability | mention absent without `artifacts` capability |
| 5 | Stop hook cleanup | PM2 artifact processes deleted |
| 5 | Docker build | image builds, `lt` binary available |
| 5 | Full lifecycle | serve → access → list → stop → verify closed |

---

## References

- **Research document:** `thoughts/swarm-researcher/research/2026-02-26-artifacts-localtunnel.md`
- **CLI entry point:** `src/cli.tsx` (command dispatch in `App` switch, lines 562-598)
- **Command pattern:** `src/commands/worker.ts` (thin wrapper with `RunnerConfig`)
- **Capabilities:** `src/server.ts:72-83` (`hasCapability()`, `getEnabledCapabilities()`)
- **Prompt assembly:** `src/prompts/base-prompt.ts:347-406` (`getBasePrompt()`)
- **Hook system:** `src/hooks/hook.ts:911-1046` (Stop hook handler)
- **HTTP server:** `src/http.ts` (raw `node:http`, manual routing)
- **Docker:** `Dockerfile.worker` (multi-stage build, Ubuntu 24.04 runtime)
- **Entrypoint:** `docker-entrypoint.sh` (env var setup, PM2 init, repo cloning)
- **Dependencies:** `package.json` (no hono or localtunnel yet — need adding)
