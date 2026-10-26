---
id: step-4
name: Bundle agent-fs and TEI in new installs
depends_on: [step-1, step-2, step-3]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-4: Bundle agent-fs and TEI in new installs

## Overview

`agent-swarm onboard --yes` (what `install.sh` runs) generates two more services, `agent-fs` (local disk, no MinIO, no public port) and `tei` (nomic-embed-text-v1.5), and writes the env that turns on the proxy (step-2), Comb, dashboard links (step-1) and local memory with prefixes (step-3). `--no-agent-fs` turns the bundle off. The interactive wizard and every existing install are unchanged: the flag defaults to off, and `install.sh` skips onboarding when `docker-compose.yml` already exists.

Evidence: the box spike ran this exact bundle on a 4 vCPU, 8 GB x86 box with the `full` preset. All 14 containers were healthy 80 s after `compose up`. The bundle added about 1.0 GB RAM at idle (`thoughts/taras/plans/2026-10-26-agent-fs-onboarding/spikes/box-x86/README.md`). The onboard spike rendered today's output and the edit sites (`spikes/onboard/README.md`). Note: `spikes/onboard/proposed-*.compose.yml` predate the plan decisions. Where they differ (768 dims, `ALLOW_PRIVATE_NETWORK_URLS`, published port 7433, TEI flags), this step wins.

## Changes Required:

#### 1. State flag and CLI flag
**Files**: `src/commands/onboard/types.ts` (`OnboardState` about 54-98, `INITIAL_STATE` 177-216), `src/commands/onboard.tsx` (`--yes` branch, 232-252), `src/cli.tsx` (`parseArgs` 55-141, `COMMAND_HELP.onboard` 177-198, props passed to `Onboard` near 699-712)
**Changes**: Add `bundleAgentFs: boolean` (default `false` in `INITIAL_STATE`) and `teiImage: string | null`. In the `--yes` branch set `bundleAgentFs = !noAgentFs` and `teiImage = teiImageForArch(os.arch())`. Parse `--no-agent-fs` in `parseArgs`, pass it as a prop, and add it to the help text.

#### 2. TEI tag per arch
**File**: new `src/commands/onboard/tei-image.ts`
**Changes**: A pure `teiImageForArch(arch: string): string | null`. `arm64` or `aarch64` gives `ghcr.io/huggingface/text-embeddings-inference:cpu-arm64-1.9.4`. Anything else gives `null`, and the compose default `cpu-1.9.4` (amd64) applies. Use `os.arch()`: `install.sh` runs on the Docker host, and in `--yes` mode `generate` runs before the engine is resolved (`src/commands/onboard/steps/generate.tsx:20-21`), so an engine probe has no call site. TEI publishes separate tags per arch, so Compose `platform:` cannot choose it.

#### 3. Compose output (flag on only)
**File**: `src/commands/onboard/compose-generator.ts`
**Changes**: Keep the flag-off output byte-identical (existing tests count service headers and `pull_policy` lines). With the flag on, emit:

```yaml
  swarm-api:
    environment:
      # ...existing lines, then:
      - AGENT_FS_API_URL=http://agent-fs:7433
      - AGENT_FS_PROXY=true
      - COMB_ENABLED=true
      - AGENT_FS_LINK_TARGET=dashboard
      - EMBEDDING_API_BASE_URL=http://tei:80/v1
      - EMBEDDING_MODEL=nomic-ai/nomic-embed-text-v1.5
      - EMBEDDING_API_KEY=local-tei
      - "EMBEDDING_QUERY_PREFIX=search_query: "
      - "EMBEDDING_DOCUMENT_PREFIX=search_document: "
    depends_on:
      agent-fs:
        condition: service_healthy
      tei:
        condition: service_started

  <each agent>:
    environment:
      # ...existing lines, then:
      - AGENT_FS_API_URL=http://agent-fs:7433
      - APP_URL=<same value the API gets>
      - AGENT_FS_LINK_TARGET=dashboard

  agent-fs:
    image: "ghcr.io/desplega-ai/agent-fs:<AGENT_FS_VERSION>"
    container_name: swarm-agent-fs
    pull_policy: <state pull policy>
    environment:
      - AGENT_FS_HOME=/data
      - AGENT_FS_STORAGE_PROVIDER=local
      - AGENT_FS_LOCAL_ROOT=/data/storage
      - HOST=0.0.0.0
      - SERVER_HOST=0.0.0.0
      - PORT=7433
      - SERVER_PORT=7433
      - EMBEDDING_PROVIDER=local
      - AGENT_FS_PUBLIC_URL=${PUBLIC_MCP_BASE_URL:-http://localhost:<api port>}/agentfs
      - AGENT_FS_APP_URL=<same value the API gets as APP_URL>
    volumes:
      - agent_fs_data:/data
    healthcheck:
      # The agent-fs image has no curl or wget.
      test: ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:7433/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))\""]
      interval: 10s
      timeout: 5s
      retries: 30
      start_period: 10s
    restart: unless-stopped

  tei:
    image: "${TEI_IMAGE:-ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.4}"
    container_name: swarm-tei
    pull_policy: <state pull policy>
    command: ["--model-id", "nomic-ai/nomic-embed-text-v1.5", "--max-batch-tokens", "2048", "--max-client-batch-size", "256"]
    mem_limit: 2g
    volumes:
      - tei_data:/data
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://127.0.0.1:80/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 30
      start_period: 180s
    restart: unless-stopped

volumes:
  agent_fs_data:
  tei_data:
```

Rules the YAML needs:
- Quote the two prefix lines. Unquoted, `KEY=search_query: ` parses as a YAML mapping, and the trailing space is lost.
- `--max-batch-tokens 2048` is required: TEI's default warmup reached more than 5.4 GB and was OOM-killed on the 8 GB box. `--max-client-batch-size 256` stops the 422 drop for documents with more than 32 chunks.
- `tei` is `service_started`, not `service_healthy`. A first boot downloads 1.1 GB of weights, and a failing TEI must not block the API. Memory falls back to keyword search until TEI is ready.
- No `platform:` key (agent-fs 0.18.5 is multi-arch, checked with `docker buildx imagetools inspect`). No host port on `agent-fs` or `tei`: the browser goes through `/agentfs`.
- Do not write `EMBEDDING_DIMENSIONS` (root decision 2).
- Lines with `${...}` need the `// biome-ignore lint/suspicious/noTemplateCurlyInString` comment, as at `compose-generator.ts:148-155`.

#### 4. `.env` output (flag on only)
**File**: `src/commands/onboard/env-generator.ts` (after the `MEMORY_*` block, line 44)
**Changes**: Write `TEI_IMAGE=<arm64 tag>` only when the probe returned one. Write a comment line that names the bundle and `--no-agent-fs`. Every other value is inline in the compose.

#### 5. Pinned agent-fs version
**Files**: new `src/commands/onboard/agent-fs-version.ts` with `export const AGENT_FS_VERSION = "0.18.5";`, `scripts/bump-agent-fs.ts` (`PINS`, lines 34-56)
**Changes**: Add a `PINS` entry with the quote-safe pattern `/^(export const AGENT_FS_VERSION = ")([^"]+)/m`. The shared `COMPOSE_IMAGE_PATTERN` would eat the closing quote. Add a unit test that the constant equals the chart tag: `readAgentFsImageTag(await Bun.file("charts/agent-swarm/values.yaml").text(), "values.yaml")` (`scripts/agent-fs-version-utils.ts:127`).

#### 6. `install.sh`
**File**: `install.sh`
**Changes**:
- Pass `--no-agent-fs` through to `onboard` (flag parsing and usage text, lines 35-90 and 207-217).
- In the `--tunnel` path (lines 341-360), recreate `agent-fs` too when the service exists (`compose_up swarm-api agent-fs`), so its `AGENT_FS_PUBLIC_URL` picks up the tunnel URL. Keep the `docker-compose.override.yml` logic as is.

#### 7. Docs
**Files**: `docs-site/content/docs/(documentation)/getting-started.mdx` (lines 55-60), `reference/cli.mdx` (onboard), `guides/agent-fs-co-deployment.mdx`
**Changes**: What a new install runs (agent-fs on local disk, TEI for memory, Comb on), the extra resources (about 1 GB RAM, 2.5 GB images, 1.5 GB volumes, a first boot that downloads about 1.5 GB), `--no-agent-fs`, and that existing installs do not change when `install.sh` runs again. Also say that local storage cannot make public signed URLs: on a bundled install, `agent-fs signed-url` returns a link that needs a login (`kind: "app"`, `<AGENT_FS_APP_URL>/file/~/...`, which opens Comb). For a file URL that works with no login, agents use `agent-fs share-create` (served through the swarm API at `/share/*`). Comb itself is not affected: it loads files through the proxy with the user's key.

### Success Criteria:

#### Automated Verification:
- [x] Onboard tests: `bun run test:root -- src/tests/onboard-compose.test.ts src/tests/onboard-env.test.ts src/tests/onboard-manifest.test.ts src/tests/onboard-non-interactive.test.ts src/tests/onboard-tei-image.test.ts` (the last one is new). New cases (start from `spikes/onboard/onboard-agent-fs.test.sketch.ts`):
  - flag off: output equals the output on main for every preset (snapshot the main output in the test);
  - flag on: `agent-fs` and `tei` headers, local storage env, no `minio`, no host port on either, `AGENT_FS_API_URL` on the API and on every agent, the quoted prefix lines, `depends_on` as above;
  - `teiImageForArch`: `arm64` and `aarch64` give the arm64 tag, `x64` gives `null`; `TEI_IMAGE` appears in `.env` only with the arm64 tag;
  - the agent-fs pin equals the chart tag;
  - `onboard --yes --preset=solo --dry-run --no-agent-fs` exits 0 and writes nothing.
- [ ] Rendered compose is valid: render `generateCompose()` with the flag on for `solo` and `full` into `/tmp/afo-step-4/`, then `docker compose -f /tmp/afo-step-4/full.yml config --quiet && docker compose -f /tmp/afo-step-4/solo.yml config --quiet`. Also `docker compose -f /tmp/afo-step-4/full.yml config | grep -c 'search_query: '` prints 1.
- [x] Installer dry run: `bash install.sh --dry-run --tunnel` and `bash install.sh --dry-run --no-agent-fs` print the expected onboard command and compose calls
- [x] Gates: `bun run check:local && bun run lint && bun run lint:slop && bun run tsc:check:tsc`

#### Automated QA:
- [ ] Local bundle run on a Docker host with released images: in `/tmp/afo-step-4/run`, write the flag-on `solo` output (not `full`: it pulls the worker image for 11 agents) plus a `.env` from `generateEnv()`, set `AGENT_SWARM_VERSION` to the latest release, `docker compose up -d`, and wait for health. Check the API log for `[seed:agent-fs-provision] created=1 failed=0`, `docker inspect --format '{{.State.Health.Status}}' swarm-agent-fs swarm-tei` prints `healthy` twice, and `docker stats --no-stream` stays under 4 GB in total. `docker stats --no-stream swarm-tei` stays under the 2 GB `mem_limit` after 50 memory writes (the box spike measured a 1.0 GiB peak with `--max-batch-tokens 2048`, without a limit). The released API image does not have steps 1 to 3 yet, so Comb proxy checks belong to root Manual E2E. Then `docker compose down -v`, remove the pulled images, and report `df -h /`.

#### Manual Verification:
- [ ] Root Manual E2E part B on a Hetzner box after the release.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing it, pause for manual confirmation. Commit as `[step-4] bundle agent-fs and TEI in new installs` after verification passes.
