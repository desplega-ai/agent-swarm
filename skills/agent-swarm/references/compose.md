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

Generate a different UUID for every active agent with `uuidgen`. Save each UUID once in `.env`.
The unmodified example requires these eight values, even when you start only selected services:

```text
LEAD_AGENT_ID
WORKER_1_AGENT_ID
WORKER_2_AGENT_ID
CONTENT_WRITER_AGENT_ID
CONTENT_REVIEWER_AGENT_ID
CONTENT_STRATEGIST_AGENT_ID
UX_PRINCIPLES_AGENT_ID
DISCOVERABILITY_AGENT_ID
```

Set `MCP_BASE_URL` to the API URL accessible to its clients. Set `APP_URL` to the admin UI URL.
Workers in the example already use `http://api:3013` for `MCP_BASE_URL`.
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

The example starts a lead, coder workers, content workers, and other specialist workers. Remove unwanted services and their identity requirements before starting.
Do not share personal volumes between agents. Preserve the API, worker, and agent-fs volumes described in [component minimums](https://github.com/desplega-ai/agent-swarm/blob/main/skills/agent-swarm/references/components.md).

Continue with the authenticated agent check and first task in [API usage](https://github.com/desplega-ai/agent-swarm/blob/main/skills/agent-swarm/references/usage.md).
