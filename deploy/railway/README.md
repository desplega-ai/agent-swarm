# Railway template

Everything needed to create the Agent Swarm Railway template in one pass. The live template is
[`railway.com/deploy/agent-swarm`](https://railway.com/deploy/agent-swarm):

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/agent-swarm)

## Why there is no template file

Railway templates are authored in the dashboard: from scratch under workspace **Templates**, or
with **Generate Template from Project** on an existing project
([Create a template](https://docs.railway.com/guides/create)). No repository file defines a template.

Railway's newer [Infrastructure as Code](https://docs.railway.com/infrastructure-as-code)
(`.railway/railway.ts`) defines a project, not a template. It is applied with
`railway config apply` to a linked project, and it leaves out what a template needs most:
generated Railway domains are "not included in `.railway/railway.ts`", and secret generation
(`${{secret()}}`) is a template variable function. A project file would add a second source to
keep in sync without saving the dashboard step, so this directory holds the specification instead.

## Plan and size

- **Hobby plan or higher.** Trial and Free cap images at 4 GB, and the worker image is about 8 GB
  unpacked. Hobby allows 10 volumes per project, so this roster (6 volumes) fits.
- **Roster:** api, agent-fs, tei, a lead and 2 coders (the `dev` onboard preset). The `full`
  preset (a lead and 10 workers, 14 volumes) needs the Pro plan; add one worker service per agent.
- **Cost:** usage based. Estimate $30-60 a month for this roster, most of it RAM.
- **Network:** create the template in a new environment. Since 2025-10-16, new environments
  resolve private names to IPv4 and IPv6, and agent-fs and TEI listen on IPv4
  ([private networking](https://docs.railway.com/networking/private-networking/how-it-works)).

## Services

All images are public on GHCR, so no registry credentials are needed. Leave every service
without a public domain except `api`. Service names matter: the variables reference them.
Railway requires a description on every required template variable before it publishes the
template; the Description columns below hold that text.

### `api`

| Setting | Value |
|---|---|
| Image | `ghcr.io/desplega-ai/agent-swarm:latest` |
| Volume | `/app/data` (SQLite database, encryption key) |
| Public networking | Generate a Railway domain, target port `3013` |
| Healthcheck path | `/health` |

| Variable | Value | Description |
|---|---|---|
| `API_KEY` | `${{secret(32, "abcdef0123456789")}}` | Swarm API key, generated on deploy. Paste it on /setup. |
| `PORT` | `3013` | HTTP port the API listens on. Leave as is. |
| `MCP_BASE_URL` | `http://localhost:3013` | API address inside its own container. Leave as is. |
| `PUBLIC_MCP_BASE_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | Public URL of this api service, from its Railway domain. Leave as is. |
| `APP_URL` | `https://app.agent-swarm.dev` | Dashboard that setup and file links open. Leave as is. |
| `AGENT_FS_API_URL` | `http://${{agent-fs.RAILWAY_PRIVATE_DOMAIN}}:7433` | Private address of the agent-fs service. Leave as is. |
| `AGENT_FS_PROXY` | `true` | Serves agent-fs through the API public domain. Leave as is. |
| `COMB_ENABLED` | `true` | Turns on the Comb review space in the dashboard. Leave as is. |
| `AGENT_FS_LINK_TARGET` | `dashboard` | Opens agent-fs file links in the dashboard. Leave as is. |
| `EMBEDDING_API_BASE_URL` | `http://${{tei.RAILWAY_PRIVATE_DOMAIN}}:80/v1` | Private address of the tei embedding service. Leave as is. |
| `EMBEDDING_MODEL` | `nomic-ai/nomic-embed-text-v1.5` | Embedding model served by the tei service. Leave as is. |
| `EMBEDDING_API_KEY` | `local-tei` | Placeholder key for tei, which needs none. Leave as is. |
| `EMBEDDING_QUERY_PREFIX` | `search_query: ` (keep the trailing space) | Text added before search queries for the model. Keep the trailing space. |
| `EMBEDDING_DOCUMENT_PREFIX` | `search_document: ` (keep the trailing space) | Text added before stored documents for the model. Keep the trailing space. |
| `MEMORY_HYBRID_SEARCH` | `1` | Combines keyword and vector memory search. Leave as is. |
| `MEMORY_GRAPH_EXPANSION` | `1` | Turns on graph-based expansion of memory search. Leave as is. |
| `MEMORY_RATERS` | `implicit-citation,explicit-self` | Memory quality signals to record. Leave as is. |
| `MEMORY_DEMOTION_FLOOR` | `1.0` | Memory demotion strength; 1.0 means none. Leave as is. |

### `agent-fs`

| Setting | Value |
|---|---|
| Image | `ghcr.io/desplega-ai/agent-fs:0.18.9` (the pin in `src/commands/onboard/agent-fs-version.ts`) |
| Volume | `/data` |

| Variable | Value | Description |
|---|---|---|
| `AGENT_FS_HOME` | `/data` | Folder on the volume where agent-fs keeps its data. Leave as is. |
| `AGENT_FS_STORAGE_PROVIDER` | `local` | Where agent-fs stores files; local uses the volume. Leave as is. |
| `AGENT_FS_LOCAL_ROOT` | `/data/storage` | Folder where agent-fs stores files on its volume. Leave as is. |
| `HOST` | `0.0.0.0` | Address the file server listens on. Leave as is. |
| `SERVER_HOST` | `0.0.0.0` | Server bind address. Leave as is. |
| `PORT` | `7433` | Port the file server listens on. Leave as is. |
| `SERVER_PORT` | `7433` | Server port. Leave as is. |
| `EMBEDDING_PROVIDER` | `local` | Embedding provider for agent-fs search; local needs no key. Leave as is. |
| `AGENT_FS_PUBLIC_URL` | `https://${{api.RAILWAY_PUBLIC_DOMAIN}}/agentfs` | Public URL of agent-fs, served through the api domain. Leave as is. |
| `AGENT_FS_APP_URL` | `https://app.agent-swarm.dev` | Dashboard that agent-fs links open. Leave as is. |

### `tei`

| Setting | Value |
|---|---|
| Image | `ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.4` |
| Volume | `/data` (model cache, about 1.1 GB) |

TEI reads its flags from the environment, so no start command is needed.

| Variable | Value | Description |
|---|---|---|
| `MODEL_ID` | `nomic-ai/nomic-embed-text-v1.5` | Embedding model the server loads. Keep it equal to api EMBEDDING_MODEL. |
| `MAX_BATCH_TOKENS` | `2048` (the default warm-up passed 5.4 GB of RAM) | Cap on tokens per batch, tuned to limit RAM. Leave as is. |
| `MAX_CLIENT_BATCH_SIZE` | `256` | Cap on inputs per request. Leave as is. |
| `PORT` | `80` | Port the embedding server listens on. Leave as is. |
| `HOSTNAME` | `0.0.0.0` (the container sets `HOSTNAME` to its own name otherwise) | Bind address; the container hostname would break it. Leave as is. |

### `lead`, `coder-1`, `coder-2`

| Setting | Value |
|---|---|
| Image | `ghcr.io/desplega-ai/agent-swarm-worker:latest` |
| Volume | `/workspace/personal` |

| Variable | `lead` | `coder-1`, `coder-2` | Description |
|---|---|---|---|
| `AGENT_ROLE` | `lead` | `worker` | `lead`: Agent role: lead plans and delegates work. Leave as is.<br>`coder-1`, `coder-2`: Agent role: worker executes tasks from the lead. Leave as is. |
| `AGENT_NAME` | `Lead` | `Coder 1`, `Coder 2` | Name this agent shows in the dashboard. Change it if you like. |
| `TEMPLATE_ID` | `official/lead` | `official/coder` | Agent profile this agent starts from. Leave as is. |
| `MAX_CONCURRENT_TASKS` | `2` | `1` | Tasks this agent runs at once. Raise it for more parallel work. |

Shared by all three:

| Variable | Value | Description |
|---|---|---|
| `API_KEY` | `${{api.API_KEY}}` | Linked from the api service; leave as is. |
| `MCP_BASE_URL` | `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:3013` | Private address of the api service. Leave as is. |
| `SWARM_URL` | `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:3013` | Private address of the api service. Leave as is. |
| `YOLO` | `true` | Lets the agent run tools without asking. Leave as is. |
| `HARNESS_PROVIDER` | `claude` | Agent harness: claude, codex or pi. Add its credential on /setup. |
| `AGENT_FS_API_URL` | `http://${{agent-fs.RAILWAY_PRIVATE_DOMAIN}}:7433` | Private address of the agent-fs service. Leave as is. |
| `APP_URL` | `https://app.agent-swarm.dev` | Dashboard that setup and file links open. Leave as is. |
| `AGENT_FS_LINK_TARGET` | `dashboard` | Opens agent-fs file links in the dashboard. Leave as is. |
| `MEMORY_RATERS` | `implicit-citation,explicit-self` | Memory quality signals to record. Leave as is. |

Leave `AGENT_ID` unset: each agent generates a UUID on first boot and keeps it in its volume.
Leave harness credentials out of the template. Without one, agents wait until the user adds a
credential on `/setup`.

## `/workspace/shared` on Railway

A Railway volume attaches to one service, so the agents cannot share the `/workspace/shared` volume
the Compose stack uses. A worker still starts cleanly without it. This is a static check of the
code, not a Railway run:

- The worker image creates `/workspace/shared` (`Dockerfile.worker`, the "Workspace directories" step).
- The entrypoint runs as root and creates each agent's `thoughts`, `memory`, `downloads` and `misc`
  directories there with `mkdir -p` (`docker-entrypoint.sh`, "Set up per-agent directories").
  Nothing in that block requires a mount.

The cost: `/workspace/shared` lives in the container's writable layer, so it is per agent and lost
on every redeploy. Agents cannot read each other's `thoughts/`. They share files through agent-fs,
which has its own volume. Memory entries are indexed in the API database, so they survive.

## Template name and description

- **Name:** `Agent Swarm`. Railway's Overview headings embed the template name.
- **Description** (Railway caps it at 75 characters):

  > Self-hosted AI agent swarm: a lead, two coders, memory and a shared drive

## Post-deploy note (Marketplace Overview)

The description is too short for this note, so put it in the template's Marketplace Overview:

> When the `api` service is healthy, open
> `https://app.agent-swarm.dev/setup?apiUrl=https://<api domain>&apiKey=<API_KEY>`.
> The domain is on the `api` service's Settings tab, and `API_KEY` is on its Variables tab.
> Add your Claude, OpenAI or OpenRouter credential on `/setup`.

## Updates

Railway does not follow a moving tag on its own: redeploy a service to pull `latest` again. To get
updates without a manual redeploy, pin a release tag (for example `ghcr.io/desplega-ai/agent-swarm:<version>`)
and turn on automatic image updates in each service's settings. Railway supports them for GHCR images.

## Human steps

1. In the desplega Railway workspace, create the template from this page.
2. Deploy it once on a Hobby workspace. Check that `api` is healthy, that the `/setup` link connects,
   and that the lead and both coders appear in the dashboard.
3. Publish it to the marketplace. The template URL is `https://railway.com/deploy/agent-swarm`; the
   [one-click deploy guide](https://docs.agent-swarm.dev/docs/guides/one-click-deploy), the root
   README and the dashboard `/setup` step link to it.
