# Pin a version and upgrade

Applies to Compose. For Kubernetes, the chart already pins and its day-2 upgrade steps are in the [Kubernetes operations procedure](https://github.com/desplega-ai/agent-swarm/blob/main/skills/agent-swarm/references/operate-k8s.md).

Two independent things make a Compose upgrade unsafe. Apply both. Pinning alone does not make upgrades safe while the API volume shadows `/app`, and narrowing the volume alone still leaves the version moving under you.

## Required: mount the API volume at `/app/data`, not `/app`

A named volume copies image content on first population and then shadows that path forever. An API service with `swarm_api:/app` freezes everything the image ships in `/app` at install time, including `migrations/` and `package.json`.
The compiled binary lives outside `/app`, so the **code upgrades while its migrations do not**. The API then queries schema that no migration in its frozen directory creates, and every affected write fails. `/health` reads the stale `/app/package.json`, so it reports the old version and stays green — nothing detects the split.

Check an existing install:

```bash
docker compose -f docker-compose.example.yml --env-file .env exec api \
  sh -c 'ls /app/migrations | wc -l; cat /app/package.json | grep \"version\"'
docker run --rm --entrypoint sh <api image>:<tag> \
  -c 'ls /app/migrations | wc -l; cat /app/package.json | grep \"version\"'
```

Different counts or versions mean the volume is shadowing the image. Fix it with the one-time move below.
Only `/app/data` must persist: the SQLite database at `DATABASE_PATH` and `.page-session-secret` beside it. The image already declares `VOLUME /app/data`.

### One-time move for an existing install

Do this before `up -d`, after taking the backup below. The new volume starts empty, so skipping the copy brings the API up against an empty database.

```bash
docker compose -f docker-compose.example.yml --env-file .env down
docker run --rm -v swarm_api:/old -v swarm_api_data:/new alpine \
  sh -c 'cp -a /old/data/. /new/ && ls -la /new'
```

Confirm `agent-swarm-db.sqlite` is listed in `/new` before starting. Keep the old `swarm_api` volume until the upgraded install is verified; delete it only afterwards.
Do not change the worker volumes. Those mount `/workspace/*` and `/logs`, which is intended agent state.

## Why pinning is required

`latest` is rebuilt and moved on every commit to `main`. It is a development tag, not a release; a version tag is published only when the release version changes.
The Compose example sets `pull_policy: always`, so an unpinned deployment can move to a newer build on any `up -d` or container restart — including a restart you did not intend as an upgrade.
The API applies SQL migrations at boot. When the API and the agents drift onto different builds, code can reach schema that its own image never created.
Pin the API and every agent service to the same published release. Read the [releases](https://github.com/desplega-ai/agent-swarm/releases).

## Pin

One variable drives the API and all agent services in the [Compose example](https://github.com/desplega-ai/agent-swarm/blob/main/docker-compose.example.yml). Set it in `.env`:

```bash
AGENT_SWARM_VERSION=<release version>
```

```bash
docker compose -f docker-compose.example.yml --env-file .env config --quiet
docker compose -f docker-compose.example.yml --env-file .env config \
  | grep -E 'image: .*(agent-swarm|agent-swarm-worker):'
```

Every resolved image must carry the same version. Leaving the variable blank resolves to `latest` and is unpinned.

## Back up before upgrading

Do this first, every time. Migrations are forward-only, so the backup is the only rollback.

```bash
docker compose -f docker-compose.example.yml --env-file .env stop api
# Use the volume your install currently has: `swarm_api` before the /app/data
# change, `swarm_api_data` after it. The database lives under `data/` either way.
docker run --rm -v swarm_api_data:/data -v "$(pwd):/backup" alpine \
  sh -c 'cp -a /data/. /backup/swarm-api-data-backup/'
cp encryption_key encryption_key.backup
```

Stopping the API first gives a consistent SQLite copy. Copy the whole directory so the WAL sidecars and `.page-session-secret` come with it. Store the backup and the encryption key together and off the host; an encrypted database without its actual key is unreadable. Read [secrets encryption](https://docs.agent-swarm.dev/docs/guides/secrets-encryption).
Never change `SECRETS_ENCRYPTION_KEY` during an upgrade.

## Upgrade

```bash
AGENT_SWARM_VERSION=<new release> \
  docker compose -f docker-compose.example.yml --env-file .env config --quiet
```

1. Read the release notes between your pinned version and the target. Check [releases](https://github.com/desplega-ai/agent-swarm/releases) and re-read the [environment example](https://github.com/desplega-ai/agent-swarm/blob/main/.env.docker.example) for new or renamed variables.
2. Back up as above.
3. Set the new `AGENT_SWARM_VERSION` in `.env`.
4. Pull explicitly, then start. Pull separately so a registry or authentication failure surfaces before any container is replaced:

```bash
docker compose -f docker-compose.example.yml --env-file .env pull
docker compose -f docker-compose.example.yml --env-file .env up -d
docker compose -f docker-compose.example.yml --env-file .env ps
```

A `pull_policy` other than `always` does not re-pull a tag that already exists locally, so a moved tag can leave a container on stale code. The explicit `pull` removes that case.
Upgrade the API and the agents together. Do not leave services on different versions.

5. Confirm what is actually running:

```bash
docker compose -f docker-compose.example.yml --env-file .env images
```

## Verify

A healthy API does not prove workers can execute tasks. Check both.

```bash
curl -fsS "$MCP_BASE_URL/health"
```

Then submit a task and read its result to completion with the [API verification procedure](https://github.com/desplega-ai/agent-swarm/blob/main/skills/agent-swarm/references/usage.md). A completed task with output is the passing signal.
Inspect API logs for migration errors when a task fails or an agent does not register:

```bash
docker compose -f docker-compose.example.yml --env-file .env logs api | tail -100
```

## Roll back

Re-pinning to the previous version is not a rollback once the upgrade applied a migration. There are no down migrations, so the older binary meets a newer schema.

1. Stop the stack.
2. Restore the backed-up database file into the `swarm_api` volume, with its matching encryption key.
3. Set `AGENT_SWARM_VERSION` back to the previous release.
4. Pull, start, and verify as above.

Restore the database and the encryption key as a pair. Read [component minimums](https://github.com/desplega-ai/agent-swarm/blob/main/skills/agent-swarm/references/components.md) for what else must be preserved.
