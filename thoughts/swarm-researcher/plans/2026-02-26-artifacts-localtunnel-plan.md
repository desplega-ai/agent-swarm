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

**Repos involved:**
- `desplega-ai/agent-swarm` — SDK, CLI, capability gate, prompt, hooks (bulk of work)
- `desplega-ai/localtunnel` — client patch (add `username` option)
- `desplega-ai/localtunnel-server` — bug fix (`maxSockets` → `maxTcpSockets`)

**Implementation order:** Phase 1 → 2 → 3 → 4 → 5 → 6 → 7

Phases 1-2 are upstream dependency fixes in the localtunnel repos. Phases 3-7 are the core implementation in agent-swarm. Each phase is independently deployable and testable.

---

## Current State

- Localtunnel infrastructure is live at `lt.desplega.ai` with wildcard DNS via Caddy
- Client (`@desplega.ai/localtunnel` v2.2.0) supports deterministic subdomains and `--auth` flag
- Server (`desplega-ai/localtunnel-server` v0.1.3) supports HTTP Basic Auth (timing-safe) and 409 conflict handling
- Agent IDs (UUIDs) work as subdomains — tested and confirmed (36-char with hyphens, 8-char prefix, 32-char no-hyphens all work)
- Auth uses hardcoded username `"hi"` — needs patching to support custom username
- `maxSockets` bug in server: `ClientManager.js` passes `maxSockets` but `TunnelAgent.js` reads `maxTcpSockets`
- No artifact-related code exists in agent-swarm yet

## Desired End State

- Agents can serve artifacts via `createArtifactServer()` from `src/artifact-sdk/`
- CLI provides `artifact serve|list|stop|open` commands
- Multiple artifacts per worker, each with dynamic port and unique subdomain (`{agentId}-{name}.lt.desplega.ai`)
- Browser SDK (`/@swarm/sdk.js`) enables HTML artifacts to call swarm API
- Proxy middleware (`/@swarm/api/*`) routes browser requests to MCP server
- `artifacts` capability gates the feature (prompt section + tools)
- Stop hook auto-closes tunnels on session end
- Docker image includes `@desplega.ai/localtunnel` globally

## What We're NOT Doing

- No npm publishing of `artifact-sdk` — it lives in-repo
- No raw TCP/UDP tunneling — HTTP only
- No multi-agent artifact sharing (each agent owns its artifacts)
- No persistent artifact storage (artifacts live as long as the server process)
- No WebSocket support in the browser SDK (REST-only proxy for MVP)
- No HMAC-derived per-agent passwords (using shared API_KEY for MVP)

---

## Phase 1: Localtunnel Client — Add `username` Option

**Goal:** Patch `@desplega.ai/localtunnel` to accept a custom `username` option so we can use `swarm` instead of the hardcoded `"hi"`.

**Repo:** `desplega-ai/localtunnel`

### Files to modify

**`lib/Tunnel.js`** — Tunnel class constructor and `_init` method

Currently the client hardcodes username as `"hi"` when building the registration URL. We need to:

1. Accept `username` in the options object (alongside existing `auth` option)
2. Pass `username` as a query parameter during tunnel registration
3. Include the custom username in the returned URL

```javascript
// In the constructor or _init method:
const opts = this._opt;
const username = opts.username || 'hi';  // backward compatible default

// When building registration URL query params:
params.append('username', username);

// When constructing the returned URL with embedded credentials:
// Instead of: `https://hi:${password}@${subdomain}.${host}`
// Use: `https://${username}:${password}@${subdomain}.${host}`
```

**`bin/lt.js`** (or CLI entry) — Add `--username` CLI flag

```javascript
// Add to yargs config:
.option('username', {
    describe: 'Username for Basic Auth (default: hi)',
    type: 'string',
    default: 'hi',
})
```

### Success Criteria

#### Automated Verification
- [ ] `bun test` (or existing test suite) passes
- [ ] TypeScript types updated if applicable

#### Manual Verification

**Test 1: Custom username via programmatic API**
```bash
# Clone and prepare
cd /workspace/repos
git clone https://github.com/desplega-ai/localtunnel.git localtunnel-client
cd localtunnel-client
npm install

# Start a test HTTP server
python3 -c "
from http.server import HTTPServer, SimpleHTTPRequestHandler
import os
os.chdir('/tmp')
open('/tmp/index.html', 'w').write('<h1>Username test</h1>')
HTTPServer(('', 9901), SimpleHTTPRequestHandler).serve_forever()
" &
TEST_PID=$!

# Create tunnel with custom username
node -e "
const localtunnel = require('./');
(async () => {
  const tunnel = await localtunnel({
    port: 9901,
    subdomain: 'test-username-$(date +%s)',
    host: 'https://lt.desplega.ai',
    auth: 'test-password-123',
    username: 'swarm',
  });
  console.log('URL:', tunnel.url);
  // Expected: URL contains 'swarm:test-password-123@'
  // NOT 'hi:test-password-123@'
})();
"

# Verify auth works with custom username
curl -u "swarm:test-password-123" -H "Bypass-Tunnel-Reminder: true" \
  "https://test-username-TIMESTAMP.lt.desplega.ai"
# Expected: HTTP 200, body contains "<h1>Username test</h1>"

# Verify wrong username is rejected
curl -u "wrong:test-password-123" -H "Bypass-Tunnel-Reminder: true" \
  "https://test-username-TIMESTAMP.lt.desplega.ai"
# Expected: HTTP 401 Unauthorized

# Cleanup
kill $TEST_PID
```

**Test 2: Default username backward compatibility**
```bash
# Same setup but without username option
node -e "
const localtunnel = require('./');
(async () => {
  const tunnel = await localtunnel({
    port: 9901,
    subdomain: 'test-default-$(date +%s)',
    host: 'https://lt.desplega.ai',
    auth: 'test-password-456',
    // No username specified — should default to 'hi'
  });
  console.log('URL:', tunnel.url);
  // Expected: URL contains 'hi:test-password-456@'
})();
"
```

**Test 3: CLI flag**
```bash
./bin/lt.js --port 9901 --subdomain test-cli-$(date +%s) \
  --host https://lt.desplega.ai --auth test-pass --username swarm
# Expected: URL printed with 'swarm' in credentials
```

---

## Phase 2: Localtunnel Server — Fix `maxSockets` Bug

**Goal:** Fix the property name mismatch where `ClientManager.js` passes `maxSockets` but `TunnelAgent.js` reads `maxTcpSockets`.

**Repo:** `desplega-ai/localtunnel-server`

### Files to modify

**`lib/ClientManager.js`** — Line ~43-46

```javascript
// Current (buggy):
const agent = new TunnelAgent({ clientId: id, maxSockets: 10 });

// Fix:
const agent = new TunnelAgent({ clientId: id, maxTcpSockets: 10 });
```

**Or alternatively, `lib/TunnelAgent.js`** — Constructor

```javascript
// Current: reads opts.maxTcpSockets
// Alternative fix: also accept opts.maxSockets as fallback
const maxSockets = opts.maxTcpSockets || opts.maxSockets || 10;
```

The first approach (fix in ClientManager) is cleaner — fix the caller, not the callee.

### Success Criteria

#### Automated Verification
- [ ] Existing test suite passes
- [ ] E2E tests pass (if available in CI)

#### Manual Verification

**Test 1: Verify fix via code inspection**
```bash
cd /workspace/repos
git clone https://github.com/desplega-ai/localtunnel-server.git
cd localtunnel-server

# Before fix: confirm the bug exists
grep -n "maxSockets" lib/ClientManager.js
# Expected: line with `maxSockets: 10` (should be `maxTcpSockets`)

grep -n "maxTcpSockets" lib/TunnelAgent.js
# Expected: constructor reads `opts.maxTcpSockets`

# After fix: verify property names match
grep -n "maxTcpSockets" lib/ClientManager.js
# Expected: line with `maxTcpSockets: 10`
```

**Test 2: Verify max connections respected (integration)**
```bash
# Start a local test server instance
npm install
PORT=9902 node server.js &
SERVER_PID=$!

# Create a tunnel against local server
cd /workspace/repos/localtunnel-client
node -e "
const lt = require('./');
(async () => {
  const tunnel = await lt({ port: 8888, host: 'http://localhost:9902' });
  console.log('Tunnel URL:', tunnel.url);
  // Now make >10 concurrent requests to test maxTcpSockets is respected
  const promises = Array.from({length: 15}, (_, i) =>
    fetch(tunnel.url.replace('https://', 'http://'), {
      headers: { 'Bypass-Tunnel-Reminder': 'true' }
    }).then(r => console.log('Request', i, r.status))
      .catch(e => console.log('Request', i, 'failed:', e.message))
  );
  await Promise.all(promises);
  tunnel.close();
})();
"
# Expected: All 15 requests should complete (queued, not rejected)
# With the bug, maxTcpSockets defaults to undefined → falls back to Node default

kill $SERVER_PID
```

---

## Phase 3: Artifact SDK — Core Module

**Goal:** Create `src/artifact-sdk/` in the agent-swarm repo with `createArtifactServer()`, dynamic port allocation, localtunnel integration, and service registry.

**Repo:** `desplega-ai/agent-swarm`

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
    username: opts.username || 'swarm',
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
        username: 'swarm',
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

## Phase 4: CLI `artifact` Command

**Goal:** Add `artifact serve|list|stop|open` subcommands to the agent-swarm CLI.

**Repo:** `desplega-ai/agent-swarm`

### Files to create/modify

**`src/commands/artifact.ts`** — NEW: Artifact command module

Implements 4 subcommands:
- `serve <path> --name <name> [--port <port>] [--no-auth] [--subdomain <sub>]`
- `list` — queries service registry for `metadata.type === "artifact"`
- `stop <name>` — stops PM2 process, closes tunnel, unregisters service
- `open <name>` — looks up URL, opens in browser via `xdg-open`

```typescript
// Pattern follows existing commands — export an async function
export async function runArtifact(subcommand: string, args: Record<string, any>) {
  switch (subcommand) {
    case 'serve': return artifactServe(args);
    case 'list': return artifactList(args);
    case 'stop': return artifactStop(args);
    case 'open': return artifactOpen(args);
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

For `open`:
1. Look up artifact URL from service registry
2. Embed credentials: `https://swarm:${API_KEY}@<subdomain>.lt.desplega.ai`
3. Execute `xdg-open <url>` (Linux)

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

# Create test content
mkdir -p /tmp/cli-test-artifact
echo '<h1>CLI Artifact Test</h1>' > /tmp/cli-test-artifact/index.html

# Run the CLI command
AGENT_ID=test-cli-agent API_KEY=test-key \
  bun run src/cli.tsx artifact serve /tmp/cli-test-artifact --name cli-test

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

## Phase 5: Browser SDK + API Proxy

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

## Phase 6: Capability Gate + Base Prompt

**Goal:** Add `"artifacts"` capability that gates the artifact tools and injects usage instructions into the agent's system prompt.

**Repo:** `desplega-ai/agent-swarm`

### Files to modify

**`src/server.ts`** — Register artifact-related tools (if any MCP tools needed)

Currently, artifacts are served via CLI/SDK, not MCP tools. However, we may want to add:
- `artifact-serve` tool — allows agents to create artifacts from within Claude sessions
- `artifact-list` tool — query active artifacts
- `artifact-stop` tool — stop an artifact

For MVP, skip MCP tool registration and use CLI only. The capability gate is still needed for the prompt section.

**`src/prompts/base-prompt.ts`** — Add `BASE_PROMPT_ARTIFACTS` section

```typescript
const BASE_PROMPT_ARTIFACTS = `
### Artifacts — Serving Interactive Content

You can serve HTML pages, interactive apps, and rich content via public URLs using the artifact system.

**Quick start — static content:**
\`\`\`bash
# Create your HTML content
mkdir -p /workspace/personal/artifacts/my-report
echo '<h1>My Report</h1>' > /workspace/personal/artifacts/my-report/index.html

# Serve it via localtunnel (auto-assigns a free port)
artifact serve /workspace/personal/artifacts/my-report --name "my-report"
# → https://{your-agent-id}-my-report.lt.desplega.ai
\`\`\`

**Programmatic — custom server:**
\`\`\`typescript
import { createArtifactServer } from '../artifact-sdk';
import { Hono } from 'hono';

const app = new Hono();
app.get('/', (c) => c.html('<h1>Dashboard</h1>'));

const server = createArtifactServer({ name: 'dashboard', app });
await server.start();
// Share server.url via Slack or task output
\`\`\`

**Commands:**
- \`artifact serve <path> --name <name>\` — Start serving content
- \`artifact list\` — List active artifacts
- \`artifact stop <name>\` — Stop an artifact
- \`artifact open <name>\` — Open in browser

**Multiple artifacts:** You can serve multiple artifacts simultaneously. Each gets its own port and subdomain.

**Browser SDK:** HTML served via artifacts can use \`<script src="/@swarm/sdk.js"></script>\` to interact with the swarm API (create tasks, send messages, read data).

**Auth:** Artifacts are protected by HTTP Basic Auth (username: swarm, password: API key). Credentials are auto-configured.
`;
```

In `getBasePrompt()` function, add gating (around line 393-395 where services is gated):

```typescript
if (!args.capabilities || args.capabilities.includes("artifacts")) {
  prompt += BASE_PROMPT_ARTIFACTS;
}
```

### Success Criteria

#### Automated Verification
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] `bun test` passes

#### Manual Verification

**Test 1: Prompt includes artifacts section when capability enabled**
```bash
cd /workspace/repos/agent-swarm

# Create a test script that calls getBasePrompt
cat > /tmp/test-prompt.ts << 'EOF'
import { getBasePrompt } from './src/prompts/base-prompt';

const prompt = getBasePrompt({
  role: 'worker',
  agentId: 'test-agent-id',
  swarmUrl: 'https://test.swarm.example.com',
  capabilities: ['core', 'artifacts', 'services'],
});

// Check artifacts section is present
const hasArtifacts = prompt.includes('artifact serve');
const hasSDK = prompt.includes('/@swarm/sdk.js');
const hasCommands = prompt.includes('artifact list');

console.log(`Has artifact serve: ${hasArtifacts}`);
console.log(`Has SDK reference: ${hasSDK}`);
console.log(`Has artifact commands: ${hasCommands}`);
console.assert(hasArtifacts, 'Prompt should include artifact serve');
console.assert(hasSDK, 'Prompt should include SDK reference');
console.assert(hasCommands, 'Prompt should include artifact commands');

console.log('PASS: Artifacts section in prompt');
EOF

bun run /tmp/test-prompt.ts
# Expected: all assertions pass
```

**Test 2: Prompt excludes artifacts section when capability disabled**
```bash
cat > /tmp/test-prompt-no-cap.ts << 'EOF'
import { getBasePrompt } from './src/prompts/base-prompt';

const prompt = getBasePrompt({
  role: 'worker',
  agentId: 'test-agent-id',
  swarmUrl: 'https://test.swarm.example.com',
  capabilities: ['core', 'services'],  // No 'artifacts'
});

const hasArtifacts = prompt.includes('artifact serve');
console.log(`Has artifact serve: ${hasArtifacts}`);
console.assert(!hasArtifacts, 'Prompt should NOT include artifact serve without capability');
console.log('PASS: Artifacts section excluded when capability not set');
EOF

cd /workspace/repos/agent-swarm
bun run /tmp/test-prompt-no-cap.ts
# Expected: assertion passes — artifacts section not in prompt
```

---

## Phase 7: Hook Integration + Docker

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

# 1. Create content
mkdir -p /tmp/lifecycle-test
echo '<h1>Lifecycle Test</h1>' > /tmp/lifecycle-test/index.html

# 2. Start artifact
AGENT_ID=lifecycle-test API_KEY=test-key \
  bun run src/cli.tsx artifact serve /tmp/lifecycle-test --name lifecycle &
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
| 1 | Custom username in localtunnel client | auth header contains "swarm" instead of "hi" |
| 2 | maxSockets fix applied | property name matches what TunnelAgent reads |
| 3 | Dynamic port allocation | two artifacts get different ports |
| 3 | Static content serving | HTTP 200 with correct body |
| 3 | Multiple artifacts | independent ports and URLs |
| 3 | E2E tunnel connectivity | public URL returns correct response |
| 4 | CLI `artifact serve` | tunnel URL accessible |
| 4 | CLI `artifact list` | shows running artifacts |
| 4 | CLI `artifact stop` | tunnel closed, service unregistered |
| 5 | SDK endpoint | serves JavaScript with SwarmSDK class |
| 5 | API proxy | forwards requests to MCP server |
| 6 | Prompt with capability | artifacts section present |
| 6 | Prompt without capability | artifacts section absent |
| 7 | Stop hook cleanup | PM2 artifact processes deleted |
| 7 | Docker build | image builds, `lt` binary available |
| 7 | Full lifecycle | serve → access → list → stop → verify closed |

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
