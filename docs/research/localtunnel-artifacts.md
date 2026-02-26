# Localtunnel for Agent Artifacts

**Date:** 2026-02-26
**Author:** Researcher (Swarm Agent)
**Status:** Research Complete

## TL;DR

Our localtunnel forks (`desplega-ai/localtunnel` client + `desplega-ai/localtunnel-server`) already have the two key features needed for artifacts: **deterministic subdomains** (with 409 conflict handling) and **HTTP Basic Auth** (per-tunnel, with timing-safe credential validation). The infrastructure at `lt.desplega.ai` is ready to use. An agent can serve on port 3000, create a tunnel with `--subdomain {agentId} --auth {password}`, and get a stable, authenticated public URL.

---

## 1. Deterministic Subdomains

### How It Works

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

### Subdomain Validation Rules (Server-Side)

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

### Conflict Handling (409)

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

This is important for artifacts: if an agent requests its subdomain and gets a 409, it knows another instance is already using it, rather than silently getting a random URL.

### Implications for Agent IDs as Subdomains

Agent IDs are UUIDs like `16990304-76e4-4017-b991-f3e37b34cf73`. These are 36 characters, contain only hex digits and hyphens, and are lowercase — they pass the subdomain validation regex. A tunnel URL would look like:

```
https://16990304-76e4-4017-b991-f3e37b34cf73.lt.desplega.ai
```

This works but is not human-friendly. Options:
1. **Use agent ID directly** — guaranteed unique, passes validation, but ugly
2. **Use agent name** (e.g., `researcher`) — readable but not guaranteed unique
3. **Use a short hash** (e.g., first 8 chars of agent ID) — compromise, but collision risk
4. **Use `{name}-{shortId}`** (e.g., `researcher-16990304`) — readable and likely unique

---

## 2. HTTP Basic Auth

### How It Works

Auth is a feature **added by our fork** — it does not exist in upstream localtunnel. The implementation spans both client and server.

**CLI (two modes):**
```bash
# Mode 1: Server generates an 18-char hex password
lt --port 3000 --subdomain my-agent --auth
# Username: "hi", Password: auto-generated (printed in tunnel URL)

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

### Auth Flow

1. **Client → Server (tunnel registration):** Query params `username=hi` and optionally `password=<value>` are appended to the registration URL
2. **Server stores credentials:** `Client` instance stores `username` and `password`; if no password given, server auto-generates an 18-char hex string via `crypto.randomBytes(9).toString('hex')`
3. **Server → Client (registration response):** Credentials are returned in the response body and embedded in the URL
4. **Browser/client → Server (accessing tunnel):** Standard HTTP Basic Auth — browser shows a login prompt, or `Authorization: Basic <base64>` header is sent
5. **Server validates:** Timing-safe comparison via `crypto.timingSafeEqual()`, returns `401 Unauthorized` with `WWW-Authenticate: Basic realm="Localtunnel"` on failure
6. **WebSocket auth:** Also enforced — returns `HTTP/1.1 401 Unauthorized` on the raw socket

### Security Properties

| Property | Status |
|----------|--------|
| Timing-safe comparison | Yes (`crypto.timingSafeEqual`) |
| Per-tunnel isolation | Yes (each tunnel has its own credentials) |
| Credentials in URL | Yes (embedded in the response URL) — note: not ideal for logging |
| HTTPS | Yes (assuming `lt.desplega.ai` uses TLS via Caddy) |
| WebSocket support | Yes (auth checked on upgrade) |

### Hardcoded Username

The username is hardcoded to `"hi"` in the client. This is a minor limitation — for the artifacts use case, the password is the real secret, and the username could be anything. If needed, the client could be patched to accept a custom username.

---

## 3. Other Relevant Features

### Connection Management

| Parameter | Value | Source |
|-----------|-------|--------|
| Max TCP sockets per tunnel | 10 (hardcoded) | `TunnelAgent.js` — note: CLI `--max-sockets` flag exists but has a property name mismatch bug, so it's always 10 |
| Socket idle timeout | 10 minutes (default) | `TunnelAgent.js` — configurable via `SOCKET_TIMEOUT` env var (in seconds) |
| Grace period (no connections) | 1 second | `Client.js` — tunnel is removed if no client connects within 1s |
| WebSocket timeout | Disabled (0) | `Client.js` — WebSocket connections exempt from idle timeout |

### Auto-Reconnection (Client-Side)

The client automatically maintains its connection pool:
- **Dead tunnel socket → reopen:** When a remote TCP socket closes, the `dead` event handler immediately opens a replacement (`Tunnel.js:137-144`)
- **Server unavailable → retry every 1s:** During initial negotiation, network errors trigger a 1-second retry loop (`Tunnel.js:97`)
- **Local server refused → retry every 1s:** If the local app isn't running, `ECONNREFUSED`/`ECONNRESET` triggers a 1-second local retry (`TunnelCluster.js:133`)
- **409 → immediate failure:** Subdomain conflict does NOT retry

### Graceful Shutdown

The fork adds proper cleanup (not in upstream):
- `tunnel.close()` is async, destroys all sockets/transformers/timeouts, removes listeners
- `TunnelCluster.destroy()` cleans up all tracked resources via `Set` collections
- CLI handles `SIGINT`/`SIGTERM` for graceful process termination

### Request Logging

```bash
lt --port 3000 --print-requests
# Logs method + path for each incoming request
```

Programmatically:
```javascript
tunnel.on('request', (info) => {
  console.log(info.method, info.path);
});
```

### Local HTTPS Support

```javascript
const tunnel = await localtunnel({
  port: 3000,
  local_https: true,
  local_cert: '/path/to/cert.pem',
  local_key: '/path/to/key.pem',
  local_ca: '/path/to/ca.pem',
  allow_invalid_cert: true,  // for self-signed certs
});
```

### Environment Variable Configuration

All CLI flags can be set via environment variables (yargs `.env(true)`):
```bash
export PORT=3000
export SUBDOMAIN=my-agent
export AUTH=my-password
lt  # picks up from env
```

---

## 4. Fork Modifications Summary

### Client (`desplega-ai/localtunnel` v2.2.0)

| Modification | Description |
|-------------|-------------|
| **Default host** | Changed from `localtunnel.me` to `lt.desplega.ai` |
| **`--auth` flag** | New feature: HTTP Basic Auth support (boolean or string) |
| **409 handling** | New: subdomain conflict returns immediate error instead of retrying |
| **Graceful shutdown** | New: async `close()` with full resource cleanup, SIGINT/SIGTERM handlers |
| **Test suite** | Migrated from Mocha (JS) to Bun (TypeScript) |
| **Package name** | `@desplega.ai/localtunnel` (scoped, publishable) |
| **CI** | GitHub Actions with Bun |

### Server (`desplega-ai/localtunnel-server` v0.1.3)

| Modification | Description |
|-------------|-------------|
| **HTTP Basic Auth** | Full implementation: `authUtils.js` + per-tunnel credential storage + timing-safe validation |
| **409 Conflict** | Returns proper 409 for subdomain collisions (upstream silently reassigns) |
| **Socket timeout** | Increased from 60s to 10 minutes, configurable via `SOCKET_TIMEOUT` env var |
| **X-Forwarded-Proto/Host** | Sets forwarded headers for HTTPS-aware apps |
| **X-Robots-Tag** | All tunnel responses include `noindex, nofollow` |
| **Agent IP tracking** | `X-Localtunnel-Agent-Ips` header on responses |
| **ID generation** | Switched from `human-readable-ids` to `human-id` library |
| **Landing page** | Inline HTML page instead of redirect |
| **ESM** | Converted to ES modules |
| **Docker** | Dockerfile + compose config, GHCR publishing |
| **CI/CD** | Test, E2E, and Docker publish workflows |

---

## 5. Artifacts System Design Considerations

### Proposed Architecture

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
```

### Integration with Existing Service Registry

Agents already have the service registry (`register-service`, `list-services`). The artifacts system could:

1. Agent starts HTTP server on port 3000 (already supported)
2. Agent creates localtunnel with `subdomain: agentId, auth: generatedPassword`
3. Agent registers the public URL and credentials in the service registry
4. Other agents or humans discover artifacts via `list-services`

### Key Design Decisions

#### Subdomain Strategy

| Option | URL | Pros | Cons |
|--------|-----|------|------|
| Full UUID | `16990304-76e4-4017-b991-f3e37b34cf73.lt.desplega.ai` | Guaranteed unique, no mapping needed | Very long, ugly |
| Agent name | `researcher.lt.desplega.ai` | Human-readable | Not unique across swarms |
| Short ID prefix | `16990304.lt.desplega.ai` | Short, likely unique | Collision possible |
| `name-shortid` | `researcher-16990304.lt.desplega.ai` | Readable + unique | Slightly longer |

**Recommendation:** Use full UUID. It's ugly but reliable. The URL is primarily for programmatic access (other agents, webhooks, APIs), not for humans typing into browsers. If human-friendly URLs are needed, the service registry can provide a lookup.

#### Auth Strategy

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| Per-tunnel random password | `auth: true` (server generates) | Zero config, unique per tunnel | Need to store/share the generated password |
| Shared swarm secret | `auth: swarmSecret` | Simple, one secret for all agents | Compromising one tunnel compromises all |
| Per-agent derived password | `auth: hash(agentId + swarmSecret)` | Deterministic, per-agent isolation | Requires secret management |

**Recommendation:** Per-agent derived password. Use `crypto.createHmac('sha256', swarmSecret).update(agentId).digest('hex')` to derive a unique, deterministic password per agent. The swarm secret is stored once in config; each agent's password is derived without storing it.

#### Lifecycle Management

The localtunnel client handles reconnection automatically, but there are edge cases:

1. **Container restart:** The tunnel process dies. The server keeps the subdomain for up to 1 second (grace period), then frees it. On restart, the agent creates a new tunnel with the same subdomain — should work immediately.

2. **Server restart:** All tunnels are lost. Agents need to detect this and reconnect. The client's retry loop handles this (retries every 1s on network error).

3. **Stale subdomains:** If an agent crashes and the server doesn't detect the disconnect (no heartbeat mechanism), the subdomain may be held. The 10-minute socket timeout is the backstop — after 10 minutes of idle, sockets are reaped, triggering the 1-second grace period and subdomain release.

### Implementation Sketch

```javascript
// In the agent runner or service startup
const localtunnel = require('@desplega.ai/localtunnel');
const crypto = require('crypto');

const SWARM_SECRET = process.env.SWARM_SECRET;
const AGENT_ID = process.env.AGENT_ID;

// Derive deterministic password
const password = crypto.createHmac('sha256', SWARM_SECRET)
  .update(AGENT_ID)
  .digest('hex')
  .slice(0, 32);

const tunnel = await localtunnel({
  port: 3000,
  subdomain: AGENT_ID,
  auth: password,
  // host defaults to 'https://lt.desplega.ai'
});

console.log(`Artifacts URL: ${tunnel.url}`);
// https://hi:<password>@<agentId>.lt.desplega.ai

// Register in service registry
await registerService({
  name: 'artifacts',
  script: '/path/to/server.js',
  metadata: {
    publicUrl: tunnel.url,
    tunnelId: tunnel.clientId,
  },
});

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  await tunnel.close();
  await unregisterService({ name: 'artifacts' });
});
```

### Known Limitations & Risks

| Issue | Severity | Mitigation |
|-------|----------|------------|
| **10 max TCP sockets per tunnel** | Medium | Fine for artifacts (serving HTML). May need patching for high-traffic APIs. The property name bug (`maxSockets` vs `maxTcpSockets`) in the server should be fixed. |
| **1-second grace period** | Low | Very short — if the agent process restarts and reconnects within 1s, the previous tunnel is already gone. Good for subdomain reuse, but no overlap possible. |
| **No heartbeat mechanism** | Medium | Stale subdomains can be held up to 10 minutes. For artifacts, this means a crashed agent's URL returns 503 for up to 10 minutes. Acceptable for MVP. |
| **Hardcoded username "hi"** | Low | The password is what matters. Can patch later if needed. |
| **No request inspection/logging** | Low | Add `--print-requests` or listen to `request` events for debugging. |
| **HTTP only (no raw TCP/UDP)** | Low | Artifacts are HTTP-served HTML/JS. This is fine. |
| **No wildcard DNS guarantee** | Medium | Requires `*.lt.desplega.ai` DNS to be correctly configured. Currently appears to be via Caddy with on-demand TLS. |

### `maxSockets` Bug Fix Needed

In `desplega-ai/localtunnel-server`, `ClientManager.js:43-46`:

```javascript
// Current (buggy):
const agent = new TunnelAgent({
    clientId: id,
    maxSockets: 10,  // ← property name mismatch
});

// Fix:
const agent = new TunnelAgent({
    clientId: id,
    maxTcpSockets: maxSockets,  // ← matches TunnelAgent's expected property
});
```

`TunnelAgent.js:48` reads `options.maxTcpSockets` — it never sees `options.maxSockets`. This is a minor bug but means the `--max-sockets` CLI flag has no effect.

---

## 6. Next Steps

1. **Fix the `maxSockets` property name bug** in `desplega-ai/localtunnel-server`
2. **Prototype the integration** — add localtunnel tunnel creation to the agent runner
3. **Add tunnel URL to service registry metadata** so other agents can discover artifacts
4. **Decide on subdomain strategy** (UUID vs name-based)
5. **Set up SWARM_SECRET** for deterministic auth password derivation
6. **Consider adding a health check** — the tunnel URL could expose `/health` for monitoring
7. **Future: Custom username** — patch the client to accept a configurable username instead of hardcoded "hi"
