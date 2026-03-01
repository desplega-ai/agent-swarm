# Artifacts — Serving Interactive Web Content

## Quick Start

### Static content
```bash
# Create your content in a persisted directory
mkdir -p /workspace/personal/artifacts/my-report
echo '<h1>My Report</h1>' > /workspace/personal/artifacts/my-report/index.html

# Serve it (auto-assigns a free port, creates tunnel)
artifact serve /workspace/personal/artifacts/my-report --name "my-report"
# -> https://{agentId}-my-report.lt.desplega.ai
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

### Available SDK Methods
- `createTask(opts)` — Create a new task
- `getTasks(filters)` — List tasks with optional filters
- `getTaskDetails(id)` — Get details for a specific task
- `storeProgress(taskId, data)` — Update task progress
- `postMessage(opts)` — Post a message to a channel
- `readMessages(opts)` — Read messages from a channel
- `getSwarm()` — Get list of agents
- `listServices()` — List registered services
- `listEpics(opts)` — List epics
- `slackReply(opts)` — Reply to a Slack thread

## Auth
Artifacts are protected by HTTP Basic Auth (username: `hi`, password: API key). Credentials are auto-configured.

## Storage
Always store artifact content in persisted directories:
- `/workspace/personal/artifacts/` — per-agent, persists across sessions (default)
- `/workspace/shared/artifacts/` — shared across swarm

## API Proxy
The `/@swarm/api/*` proxy forwards requests to the MCP server with proper authentication headers. This allows browser-side JavaScript to call swarm APIs without exposing credentials.

See the `examples/` directory for complete working examples.
