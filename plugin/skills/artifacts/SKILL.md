---
name: artifacts
description: Serve interactive web content (HTML pages, dashboards, approval flows, static reports, custom Hono apps) to a public URL via localtunnel. Use when the user asks to "create an artifact for X", "host this for me", "make me a tunneled URL", "spin up a web server for X", "publish this report so I can see it", "share this file/page publicly", "expose this dashboard", "give me a live link", or anything that needs a browser-reachable URL pointing at agent-generated content. Wraps the `agent-swarm artifact` CLI plus the `createArtifactServer` SDK; covers static directories, custom Hono apps, daemonization (nohup / PM2), HTTP Basic auth, and the in-page swarm Browser SDK.
---

# Artifacts — Serving Interactive Web Content

Serve a directory or a Hono app to a public, auth-protected URL via localtunnel. Useful for sharing reports, dashboards, approval flows, or anything else a human needs to look at in a browser.

The CLI is a subcommand of `agent-swarm`. Always invoke as **`agent-swarm artifact <subcommand>`** — there is no top-level `artifact` binary.

## Quick Start

### Static content
```bash
# Create your content in a persisted directory
mkdir -p /workspace/personal/artifacts/my-report
echo '<h1>My Report</h1>' > /workspace/personal/artifacts/my-report/index.html

# Serve it (auto-assigns a free port, creates tunnel, registers in service registry)
agent-swarm artifact serve /workspace/personal/artifacts/my-report --name my-report
# -> Artifact "my-report" live at https://<agentId>-my-report.lt.desplega.ai (port <auto>)
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

You can also `agent-swarm artifact serve ./server.ts --name dashboard` if `server.ts` exports a Hono instance as its default export.

## CLI Commands

| Command | Description |
|---|---|
| `agent-swarm artifact serve <path> --name <name> [--port <port>] [--no-auth] [--subdomain <sub>]` | Start serving content. `<path>` is a directory (static) or a `.ts`/`.js` file exporting a default Hono app. |
| `agent-swarm artifact list` | List active artifacts (name, agent, port, URL, status) from the service registry. |
| `agent-swarm artifact stop <name>` | Stop an artifact: deletes the matching PM2 process and unregisters it from the service registry. See "Known limitation" below for non-PM2 processes. |

Flags accepted by `serve`:
- `--name <name>` — defaults to the basename of `<path>`. Used for the subdomain and PM2 process name.
- `--port <port>` — pin to a specific port. Default: auto-assigned ephemeral port.
- `--no-auth` — disable HTTP Basic auth on the tunnel (DANGEROUS — anyone with the URL can access).
- `--subdomain <sub>` — override the default `${agentId}-${name}` subdomain.

## Auth & URL Pattern

Tunnels are protected by **HTTP Basic auth** by default:
- **Username:** `hi` (hardcoded MVP default in `src/artifact-sdk/tunnel.ts`)
- **Password:** the agent's `API_KEY`

Two equivalent URL forms:

```
# Plain (browser will prompt for credentials)
https://<agentId>-<name>.lt.desplega.ai

# Auth-prefilled (works in curl, scripts, and most browsers without a prompt)
https://hi:<API_KEY>@<agentId>-<name>.lt.desplega.ai
```

Use `--no-auth` only for genuinely public content. Anyone who learns the subdomain can read it.

## Running it as a daemon

`agent-swarm artifact serve` blocks on a never-resolving promise to stay alive — you cannot inline it in a script that needs to do other work. Pick one of these:

### Option A — `nohup` (quick, throwaway)

Easiest for one-off "host this for the next 10 minutes" cases:

```bash
mkdir -p /workspace/personal/logs
nohup agent-swarm artifact serve /workspace/personal/artifacts/my-report \
  --name my-report \
  > /workspace/personal/logs/my-report.out 2>&1 &
echo $! > /workspace/personal/logs/my-report.pid

# Later, kill it manually:
kill "$(cat /workspace/personal/logs/my-report.pid)"
```

### Option B — PM2 (recommended for anything you'll come back to)

PM2 gives you auto-restart on crash, a process name, log management, and — crucially — **lets `agent-swarm artifact stop <name>` actually kill it** (see Known limitation below).

```bash
pm2 start agent-swarm \
  --name artifact-my-report \
  -- artifact serve /workspace/personal/artifacts/my-report --name my-report

# Stop it cleanly later:
agent-swarm artifact stop my-report
```

The PM2 process name **must** be `artifact-<name>` (matching `--name`) — that's exactly what `artifact stop` looks for.

### Known limitation — `artifact stop` only kills PM2-started processes

Today, `agent-swarm artifact stop <name>` runs `pm2 delete artifact-<name>` and then unregisters the entry from the service registry. If you started the artifact with `nohup` (or `&`, or any non-PM2 launcher), `pm2 delete` silently fails and the actual server keeps running and serving — even though the command prints `Artifact '<name>' stopped.` Tracked as a follow-up bug filed alongside PR #469; until it's fixed:

- Use **PM2** if you want `artifact stop` to actually do its job.
- For `nohup`/foreground processes, kill the PID yourself (`kill <pid>` or `pkill -f 'artifact serve.*<name>'`) **and then** run `agent-swarm artifact stop <name>` to clear the registry row.

## Multiple Artifacts

Each artifact gets its own port (auto-assigned) and subdomain (`<agentId>-<name>`). You can run several simultaneously — see `examples/multi-artifact.ts`.

## Browser SDK

HTML artifacts can call back into the swarm API via a server-side proxy that injects auth, so browser code never sees the API key:

```html
<script src="/@swarm/sdk.js"></script>
<script>
  const swarm = new SwarmSDK();
  await swarm.createTask({ task: 'Do something' });
  const agents = await swarm.getSwarm();
</script>
```

### Available SDK Methods
- `createTask(opts)` — Create a new task
- `getTasks(filters)` — List tasks with optional filters
- `getTaskDetails(id)` — Get details for a specific task
- `storeProgress(taskId, data)` — Update task progress
- `postMessage(opts)` — Post a message to a channel
- `readMessages(opts)` — Read messages from a channel
- `getSwarm()` — Get list of agents
- `listServices()` — List registered services
- `slackReply(opts)` — Reply to a Slack thread

## API Proxy

The `/@swarm/api/*` proxy forwards requests to the MCP server with proper authentication headers. This allows browser-side JavaScript to call swarm APIs without exposing credentials.

## Storage

Always store artifact content in persisted directories — the working dir is wiped between sessions:
- `/workspace/personal/artifacts/` — per-agent, persists across sessions (default)
- `/workspace/shared/artifacts/` — shared across the swarm

See the `examples/` directory for complete working examples.
