# API, coding agent, and admin UI

Re-fetch the [HTTP schema](https://github.com/desplega-ai/agent-swarm/blob/main/openapi.json) and [CLI help source](https://github.com/desplega-ai/agent-swarm/blob/main/src/cli.tsx).

## HTTP and first task

Export your deployment's API key as `API_KEY` in the current shell. Set the URL below to your deployment.
For Helm port forwarding, the default URL is appropriate.

```bash
export MCP_BASE_URL=http://localhost:3013
curl -fsS "$MCP_BASE_URL/health"
curl -fsS "$MCP_BASE_URL/openapi.json" -o /tmp/swarm-openapi.json
curl -fsS -H "Authorization: Bearer $API_KEY" "$MCP_BASE_URL/api/agents" \
  | jq '.agents[] | {id, name, status, isLead}'
TASK_ID=$(curl -fsS -X POST "$MCP_BASE_URL/api/tasks" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"task":"Return a short greeting and report which tools you can access."}' \
  | jq -er '.id')
curl -fsS -H "Authorization: Bearer $API_KEY" "$MCP_BASE_URL/api/tasks/$TASK_ID"
```

Repeat the final GET until the task completes. Confirm `status` and `output` in the response.
If it fails, inspect its failure reason and worker status before submitting another task.
The API serves interactive documentation at `/docs`. The task POST returns the task directly. The agent list uses an `agents` envelope.
When RBAC is enabled, use credentials with permission to create tasks. See the [API reference](https://docs.agent-swarm.dev/docs/api-reference).

## MCP and your coding agent

In the project you want to connect, set `MCP_BASE_URL` and `AGENT_SWARM_API_KEY` to your deployment's URL and key.

```bash
bunx @desplega.ai/agent-swarm connect --help
bunx @desplega.ai/agent-swarm connect
```

Review the interactive connection settings. The command writes `.mcp.json` and Claude's local settings.
Keep generated credentials out of Git. Restart the coding-agent session so it loads the MCP configuration.
Ask the agent to inspect the swarm, submit a task, and read its result.
To make your coding agent the lead, ask it to call `join-swarm` with `lead: true` and a name.
Use lead registration only if the deployment has no existing lead. Do not create a second lead beside the Compose or Helm lead.
Read the [registration tool](https://github.com/desplega-ai/agent-swarm/blob/main/src/tools/join-swarm.ts) before choosing the role.

Other MCP clients connect to `$MCP_BASE_URL/mcp` using HTTP transport and `Authorization: Bearer <api-key>`.
An agent client also supplies a stable UUID in `X-Agent-ID`. Read [getting started](https://docs.agent-swarm.dev/docs/getting-started).

## Admin UI

Open `https://app.agent-swarm.dev` and configure a connection to your API with its key.
For local development from the repository root:

```bash
bun install --frozen-lockfile
cd apps/ui
bun run dev
```

Use the URL printed by the development server. Configure its API connection in the UI.
The UI manages agents, tasks, integrations, secrets, and configuration. Read the [UI guide](https://docs.agent-swarm.dev/docs/ui).
