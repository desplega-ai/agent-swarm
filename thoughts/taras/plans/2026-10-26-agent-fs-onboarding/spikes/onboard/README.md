# Spike: onboard (render a fresh install without Docker)

Run date: 2026-10-26 (BCN). Worktree: `/Users/taras/worktrees/agent-swarm/2026-10-26-afo-run` at 860dd9cb9. No repo file was edited.

## What I ran

1. `bun src/cli.tsx onboard --yes --preset=solo --container-engine docker` and the same with `--preset=full`.
   cwd = `/tmp/afo-spike-onboard/out*` (no `--dir` flag exists), `PATH` without `docker`, fake harness credential, random `API_KEY`, `HOME` in tmp.
   Files are written by `generate` before `prereq_check`, so the three files appear even with no engine.
   The process then dies with `Raw mode is not supported on the current process.stdin` (no TTY in my shell). This is an Ink limit, not a code bug. In CI use `--dry-run` (writes nothing) or `generateCompose()` directly.
2. `splice.ts` (this dir) inserts the proposed additions into the generated compose. This prototypes what `generateCompose()` emits with the new flag on.
3. `docker compose -f proposed-{solo,full}.compose.yml config --quiet`: rc=0 for both (only a warning for an unset `INSTALL_METHOD`, which `.env` sets). `config --services`: solo 2 -> 4 services, full 12 -> 14. `AGENT_FS_API_URL` appears 12 times in full (api + 11 agents).
4. With `TEI_IMAGE=...:cpu-arm64-1.9.4`, `config --images` resolves the arm64 tag. This confirms the "tag via .env variable" design.
5. Checked the TEI image already in the local cache (`cpu-arm64-1.9.4`, no pull, 343 MB): it ships `curl` and `sh`, but no `wget`, `nc` or `python3`. Entrypoint is `text-embeddings-router`. So `curl -f http://localhost:80/health` is a valid healthcheck. This answers the open question from the research.

I did not `up` anything, did not pull, and did not run agent-fs or TEI. The agent-fs healthcheck (`node -e fetch`) is copied from `docker-compose.example.yml:171-187`, where it is already used. The agent-fs image has no `curl`/`wget`, although its own Dockerfile `HEALTHCHECK` (agent-fs `Dockerfile:40-41`) uses `curl`. That Dockerfile healthcheck is therefore broken in the image. Compose overrides it.

## Files here

- `generated-solo.compose.yml`, `generated-full.compose.yml`, `generated-solo.env`, `generated-full.env`, `generated-solo.config.json`: real output of today's onboard (secrets redacted; the compose files only hold `${VAR}` references).
- `proposed-solo.compose.yml`, `proposed-full.compose.yml`: generated + new services (valid per `docker compose config`).
- `splice.ts`: the diff as code. It is the exact text the generator should emit.
- `onboard-agent-fs.test.sketch.ts`: unit test sketch.

## Findings the plan must use

Baseline (today):
- solo compose = `swarm-api` + `worker-coder`, volumes `swarm_data`, `swarm_logs`, `swarm_shared`, `swarm_worker_coder`. `.env` = 21 lines (core, MEMORY_*, auth, integrations flags, agent ids). `.agent-swarm/config.json` has no feature flags.
- My fake `CLAUDE_CODE_OAUTH_TOKEN` (prefix `sk-fake-`) was emitted as `ANTHROPIC_API_KEY` in the generated `.env`. I did not trace why (likely the credential type is chosen from the token prefix in `non-interactive.ts`). Test fixtures should use realistic prefixes.

Edit sites (all line numbers on 860dd9cb9):
| What | Where |
|---|---|
| New state field `bundleAgentFs: boolean` (default `false`) | `src/commands/onboard/types.ts` OnboardState (~54-98) and `INITIAL_STATE` (~177-216) |
| Set it `true` only in the `--yes` branch | `src/commands/onboard.tsx:232-252`, inside the `goToStep("generate", {...})` object |
| swarm-api env + `depends_on` | `src/commands/onboard/compose-generator.ts`: env after line 158 (`APP_URL`), `depends_on` between 171 and 172 (before `ports:`) |
| agent env (`AGENT_FS_API_URL`) | `compose-generator.ts:218` (after `SWARM_URL`) |
| `agent-fs` and `tei` services | `compose-generator.ts` after the agent loop (line 254), before the volumes section (256) |
| volumes `agent_fs_data`, `tei_data` | `compose-generator.ts:258-264` |
| `.env` values (`TEI_IMAGE` on arm64, `AGENT_FS_PUBLIC_URL`, link target) | `src/commands/onboard/env-generator.ts` after the MEMORY_* block (line 44) |
| host port 7433 conflict check | `src/commands/onboard/steps/prereq-check.tsx:36` (`portsToCheck = [3013]`) |
| arch probe | `src/commands/onboard/container-engine.ts` (new `docker info --format '{{.Architecture}}'` through `CommandRunner`; `os.arch()` fallback) |
| pin bump | `scripts/bump-agent-fs.ts` PINS (34-56): add a quote-safe pattern for `export const AGENT_FS_VERSION = "..."` in a new constant file |

Design points proven by the render:
- Generated style is plain `lines.push` strings. Compose vars need the `// biome-ignore lint/suspicious/noTemplateCurlyInString` comment on the line before each (see lines 148-155). Alternatively keep new blocks as module constants of string arrays with one biome-ignore for the file.
- Flag off must be byte-identical to today. Today's tests count headers (`/^ {2}[a-z][\w-]+:$/`) and `pull_policy` lines, so the flag must default off in `INITIAL_STATE`.
- `agent-fs` with local storage needs no MinIO and no `minio-init`. Env set: `AGENT_FS_HOME=/data`, `AGENT_FS_STORAGE_PROVIDER=local`, `AGENT_FS_LOCAL_ROOT=/data/storage`, `HOST/SERVER_HOST=0.0.0.0`, `PORT/SERVER_PORT=7433` (agent-fs `config.ts:240-262`). One volume `agent_fs_data:/data`. No `platform:` key (the example forces `linux/amd64`, which would run under emulation on Apple Silicon. The research says agent-fs images are multi-arch; I did not verify that for 0.18.5, so verify with `docker buildx imagetools inspect` in the build step).
- `agent-fs` embedding stays on `EMBEDDING_PROVIDER=local` (agent-fs has only `local|openai|gemini`, `config.ts:297`). First boot downloads a model, hence `retries: 30`. The real TEI wiring for agent-fs needs an agent-fs release first. The swarm memory embedding does use TEI today via `EMBEDDING_API_BASE_URL=http://tei:80/v1` (OpenAI SDK appends `/embeddings`; `openai-embedding.ts:71`).
- `swarm-api` needs `depends_on` agent-fs `service_healthy`, otherwise the boot seeder fails once (logged only).
- `tei` has no host port. It uses a `${TEI_IMAGE:-...cpu-1.9.4}` image variable. `.env` gets the arm64 value. `command: ["--model-id", "${EMBEDDING_MODEL:-nomic-ai/nomic-embed-text-v1.5}"]`, volume `tei_data:/data`. Healthcheck `curl -f http://localhost:80/health`, `retries: 60` for the first-boot download.
- `EMBEDDING_API_KEY` must be non-empty (dummy `local-tei`), otherwise the provider reads as unconfigured.
- Memory dimension 768 is restart-only (`EMBEDDING_DIMENSIONS` read at module load). Fine for a new install with an empty DB. Not for any existing DB, which is why only new-install tooling writes it.

Unverified (needs the Manual E2E): TEI honors the `dimensions` request field for nomic (Matryoshka); nomic task prefixes (the swarm has no prefix code); the `ALLOW_PRIVATE_NETWORK_URLS=true` scope in prod; agent-fs image arch list.

## Unit test approach

Onboard tests need no fs or prompt stubs. The three generators are pure functions of state. Existing pattern: `makeState = {...INITIAL_STATE, ...overrides}` plus string assertions (`onboard-compose.test.ts:7-9`, `onboard-env.test.ts:6-8`). The CLI test (`onboard-non-interactive.test.ts:62-95`) uses `runChild` with a `mkdtemp` cwd and `--dry-run`. The only mock code is `mockRunner` for `CommandRunner` in `onboard-container-engine.test.ts:18`; copy it for the arch probe. The sketch asserts: flag default false; flag off gives only `swarm-api` + agents and none of the new strings; flag on gives `agent-fs` + `tei` headers, local-storage env, `AGENT_FS_API_URL` on api and every agent, no `minio`, no TEI host port; the compose agent-fs tag equals the chart tag via `readAgentFsImageTag(text, source)` (`scripts/agent-fs-version-utils.ts:127`); `.env` block; a `--yes --dry-run` child exits 0 with nothing written.

## Corrections to the research doc

- TEI image does ship `curl` (open question answered). It has no `wget`.
- agent-fs's own Dockerfile `HEALTHCHECK` uses `curl`, which the image lacks. Always override the healthcheck in Compose.
- `onboard --yes` (non-dry) exits with an Ink raw-mode error when stdin is not a TTY. Files are still written first. A scripted install over pipes (for example `curl | bash`) should be checked in the install.sh dry run and the Manual E2E.
- `readAgentFsImageTag` takes `(valuesYamlText, sourceLabel)`, not a path.
- A container named `afo-spike-tei` was already running on this host from another spike. I did not touch it.

## Cleanup

`/tmp/afo-spike-onboard` removed. No process or container of mine is running.
