# Railway template

Everything needed to create the Agent Swarm Railway template in one pass. The template does not
exist yet: a person with the desplega Railway workspace creates and publishes it.

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

### `api`

| Setting | Value |
|---|---|
| Image | `ghcr.io/desplega-ai/agent-swarm:latest` |
| Volume | `/app/data` (SQLite database, encryption key) |
| Public networking | Generate a Railway domain, target port `3013` |
| Healthcheck path | `/health` |

| Variable | Value |
|---|---|
| `API_KEY` | `${{secret(32, "abcdef0123456789")}}` |
| `PORT` | `3013` |
| `MCP_BASE_URL` | `http://localhost:3013` |
| `PUBLIC_MCP_BASE_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` |
| `APP_URL` | `https://app.agent-swarm.dev` |
| `AGENT_FS_API_URL` | `http://${{agent-fs.RAILWAY_PRIVATE_DOMAIN}}:7433` |
| `AGENT_FS_PROXY` | `true` |
| `COMB_ENABLED` | `true` |
| `AGENT_FS_LINK_TARGET` | `dashboard` |
| `EMBEDDING_API_BASE_URL` | `http://${{tei.RAILWAY_PRIVATE_DOMAIN}}:80/v1` |
| `EMBEDDING_MODEL` | `nomic-ai/nomic-embed-text-v1.5` |
| `EMBEDDING_API_KEY` | `local-tei` |
| `EMBEDDING_QUERY_PREFIX` | `search_query: ` (keep the trailing space) |
| `EMBEDDING_DOCUMENT_PREFIX` | `search_document: ` (keep the trailing space) |
| `MEMORY_HYBRID_SEARCH` | `1` |
| `MEMORY_GRAPH_EXPANSION` | `1` |
| `MEMORY_RATERS` | `implicit-citation,explicit-self` |
| `MEMORY_DEMOTION_FLOOR` | `1.0` |

### `agent-fs`

| Setting | Value |
|---|---|
| Image | `ghcr.io/desplega-ai/agent-fs:0.18.9` (the pin in `src/commands/onboard/agent-fs-version.ts`) |
| Volume | `/data` |

| Variable | Value |
|---|---|
| `AGENT_FS_HOME` | `/data` |
| `AGENT_FS_STORAGE_PROVIDER` | `local` |
| `AGENT_FS_LOCAL_ROOT` | `/data/storage` |
| `HOST`, `SERVER_HOST` | `0.0.0.0` |
| `PORT`, `SERVER_PORT` | `7433` |
| `EMBEDDING_PROVIDER` | `local` |
| `AGENT_FS_PUBLIC_URL` | `https://${{api.RAILWAY_PUBLIC_DOMAIN}}/agentfs` |
| `AGENT_FS_APP_URL` | `https://app.agent-swarm.dev` |

### `tei`

| Setting | Value |
|---|---|
| Image | `ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.4` |
| Volume | `/data` (model cache, about 1.1 GB) |

TEI reads its flags from the environment, so no start command is needed.

| Variable | Value |
|---|---|
| `MODEL_ID` | `nomic-ai/nomic-embed-text-v1.5` |
| `MAX_BATCH_TOKENS` | `2048` (the default warm-up passed 5.4 GB of RAM) |
| `MAX_CLIENT_BATCH_SIZE` | `256` |
| `PORT` | `80` |
| `HOSTNAME` | `0.0.0.0` (the container sets `HOSTNAME` to its own name otherwise) |

### `lead`, `coder-1`, `coder-2`

| Setting | Value |
|---|---|
| Image | `ghcr.io/desplega-ai/agent-swarm-worker:latest` |
| Volume | `/workspace/personal` |

| Variable | `lead` | `coder-1`, `coder-2` |
|---|---|---|
| `AGENT_ROLE` | `lead` | `worker` |
| `AGENT_NAME` | `Lead` | `Coder 1`, `Coder 2` |
| `TEMPLATE_ID` | `official/lead` | `official/coder` |
| `MAX_CONCURRENT_TASKS` | `2` | `1` |

Shared by all three:

| Variable | Value |
|---|---|
| `API_KEY` | `${{api.API_KEY}}` |
| `MCP_BASE_URL`, `SWARM_URL` | `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:3013` |
| `YOLO` | `true` |
| `HARNESS_PROVIDER` | `claude` |
| `AGENT_FS_API_URL` | `http://${{agent-fs.RAILWAY_PRIVATE_DOMAIN}}:7433` |
| `APP_URL` | `https://app.agent-swarm.dev` |
| `AGENT_FS_LINK_TARGET` | `dashboard` |
| `MEMORY_RATERS` | `implicit-citation,explicit-self` |

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

## Post-deploy note (template description)

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
3. Publish it to the marketplace. Then replace the Railway placeholder in the
   [one-click deploy guide](https://docs.agent-swarm.dev/docs/guides/one-click-deploy) with the
   "Deploy on Railway" button for `https://railway.com/deploy/<code>`.
