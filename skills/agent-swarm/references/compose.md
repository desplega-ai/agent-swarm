# Docker Compose

Re-fetch the [Compose example](https://github.com/desplega-ai/agent-swarm/blob/main/docker-compose.example.yml) and [environment example](https://github.com/desplega-ai/agent-swarm/blob/main/.env.docker.example) before acting.

## Prepare

```bash
git clone https://github.com/desplega-ai/agent-swarm.git
cd agent-swarm
cp .env.docker.example .env
openssl rand -base64 32 > encryption_key
chmod 600 .env encryption_key
openssl rand -hex 32
```

Use the last command's output as `API_KEY` in `.env`. Replace the example credential with your selected harness credential.
For Claude OAuth, obtain it with `claude setup-token`. Remove the placeholder token when using `ANTHROPIC_API_KEY`.

All twelve Compose agent ID variables are optional overrides in `.env`. Leave them blank to generate a UUID on first boot and reuse it across restarts. Each service stores its ID in `/workspace/personal/.agent-id` on its own personal volume. An explicit `.env` value takes precedence and is persisted; keep existing overrides to retain identity. Removing personal volumes also removes generated IDs.

To set explicit overrides, generate a different UUID for each agent with `uuidgen` and save it in the corresponding variable:

```text
LEAD_AGENT_ID
WORKER_1_AGENT_ID
WORKER_2_AGENT_ID
CONTENT_WRITER_AGENT_ID
CONTENT_REVIEWER_AGENT_ID
CONTENT_STRATEGIST_AGENT_ID
UX_PRINCIPLES_AGENT_ID
DISCOVERABILITY_AGENT_ID
RESEARCHER_AGENT_ID
REVIEWER_AGENT_ID
TESTER_AGENT_ID
FORWARD_DEPLOYED_ENGINEER_AGENT_ID
```

Set `MCP_BASE_URL=http://localhost:3013` in `.env`. The API container uses this address for internal calls.
Workers in the example already use `http://api:3013` for `MCP_BASE_URL`.
External clients need their own reachable API URL. Set `APP_URL` to the admin UI URL.
For public callbacks and the hosted dashboard, set `PUBLIC_MCP_BASE_URL=<public-https-api-url>` in `.env`. The example passes it to the API service.
For automatic certificates, use the Caddy `tls` profile described in the [HTTPS procedure](https://github.com/desplega-ai/agent-swarm/blob/main/skills/agent-swarm/references/https.md).
Read the [URL definitions](https://github.com/desplega-ai/agent-swarm/blob/main/src/utils/constants.ts) for internal calls, OAuth redirects, and webhooks.
Apply the [component minimums](https://github.com/desplega-ai/agent-swarm/blob/main/skills/agent-swarm/references/components.md) before starting services.
Remove unused example values from `.env`. Keep non-boot configuration in swarm config where supported.

The example includes MinIO credentials for development. Replace them consistently in `minio`, `minio-init`, and `agent-fs` before external access.
Set `AGENT_FS_S3_PUBLIC_ENDPOINT` to a URL reachable by clients when they use signed downloads.

## Start and verify

```bash
docker compose -f docker-compose.example.yml --env-file .env config --quiet
docker compose -f docker-compose.example.yml --env-file .env up -d
docker compose -f docker-compose.example.yml --env-file .env ps
curl -fsS http://localhost:3013/health
```

The example starts a lead, coder workers, content workers, and other specialist workers. Remove unwanted services before starting.
Do not share personal volumes between agents. Preserve the API, worker, and agent-fs volumes described in [component minimums](https://github.com/desplega-ai/agent-swarm/blob/main/skills/agent-swarm/references/components.md).

Continue with the authenticated agent check and first task in [API usage](https://github.com/desplega-ai/agent-swarm/blob/main/skills/agent-swarm/references/usage.md).
