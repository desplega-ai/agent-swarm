# E2B Dispatch

Use E2B when you need Agent Swarm API/worker sandboxes in CI or in an
environment that cannot run Docker locally.

## Requirements

- `e2b` CLI available on `PATH` for local-checkout template builds.
- `E2B_API_KEY` in the environment, `.env.e2b`, `.env`, or passed with
  `--e2b-api-key-file`.
- A public swarm API URL for worker-only dispatch. Use ngrok/Cloudflare Tunnel
  for a local API, or use `start-stack` to launch the API in E2B first.
- Optional custom E2B endpoints can be supplied with `E2B_DOMAIN`,
  `E2B_API_URL`, `E2B_SANDBOX_URL`, or `--e2b-api-base`.

The dispatcher sends runtime secrets to E2B via sandbox creation `envVars` and
redacts token-like response fields from output. Runtime env precedence is
inherited allowlist, then `--env-file`, then repeated `--secret KEY=VALUE`, with
`--api-key` winning for the swarm API key. Prefer `--env-file` or inherited
environment values for real secrets so values do not appear in the local process
list. Template build env set with `setEnvs()` is intentionally not used for
secrets because E2B captures start commands at template build time.

The swarm API key has no built-in default for E2B dispatch. Pass `--api-key`,
set `AGENT_SWARM_API_KEY`, or set `API_KEY`; the dispatcher mirrors the resolved
key to both runtime variable names for API/worker compatibility.

## Build Templates

Build from the current checkout. This path uses the E2B CLI legacy Dockerfile
builder, so it requires local Docker:

```bash
bun run src/cli.tsx e2b build-template --role api
bun run src/cli.tsx e2b build-template --role worker
```

Build from an existing registry image. This path uses the E2B Template SDK
`fromImage()` builder and does not require local Docker:

```bash
bun run src/cli.tsx e2b build-template \
  --role worker \
  --source image \
  --image ghcr.io/desplega-ai/agent-swarm-worker:latest
```

Defaults:

- API template: `agent-swarm-api`, `Dockerfile`, 2 CPU, 2048 MB.
- Worker template: `agent-swarm-worker`, `Dockerfile.worker`, 4 CPU, 8192 MB.

Override with `--template`, `--api-template`, `--worker-template`,
`--cpu-count`, `--memory-mb`, or `--no-cache`.

## Start Sandboxes

Start only a worker against a reachable API:

```bash
bun run src/cli.tsx e2b start-worker \
  --api-url https://your-tunnel-or-api.example.com \
  --api-key "$SWARM_E2E_API_KEY" \
  --env-file .env.docker
```

Start API and one worker in E2B:

```bash
bun run src/cli.tsx e2b start-stack \
  --api-key "$SWARM_E2E_API_KEY" \
  --env-file .env.docker \
  --workers 1
```

Useful flags:

- `--secret KEY=VALUE` adds one runtime secret.
- `--inherit-env KEY[,KEY]` forwards extra local env keys.
- `--api-key <key>` sets the swarm API key passed to API/worker.
- `--agent-id <id>` overrides the worker ID; otherwise workers use
  `e2b-<sandbox-id>` to avoid collisions.
- `--timeout-sec <seconds>` sets sandbox TTL; default is `3600`.
- `--wait-ms <milliseconds>` controls API health and worker registration waits;
  `--no-wait` starts sandboxes without those post-start checks.
- `--json` prints CI-friendly output.

Clean up:

```bash
bun run src/cli.tsx e2b list
bun run src/cli.tsx e2b kill <sandbox-id>
bun run src/cli.tsx e2b delete-template <template-name>
```

Publish public templates:

```bash
bun run src/cli.tsx e2b publish-template agent-swarm-api-latest
bun run src/cli.tsx e2b publish-template agent-swarm-worker-latest
```

Publishing/unpublishing uses the E2B template update API and only requires
`E2B_API_KEY`.

## Native Log Capture & `swarms logs`

The entrypoint is launched as an **envd-tracked background command**
(`sandbox.commands.run('bash -lc "set -o pipefail; <entrypoint> 2>&1 | tee
/tmp/agent-swarm-e2b-<role>.log"', { background: true })`), not the old
`nohup … >file & sleep 2; kill -0` detach. Consequences:

- envd owns and streams the process, so it survives the controller (your laptop)
  disconnecting and is visible to E2B's native log surfaces / dashboard.
- The background handle returns the PID immediately; the launcher polls the
  handle's `exitCode` once after a short grace period (`undefined` = still
  running) and surfaces a non-zero early exit as a launch failure. `pipefail`
  makes the pipeline's exit reflect the entrypoint, not `tee`.
- `tee` keeps a deterministic file copy at `/tmp/agent-swarm-e2b-<role>.log`
  (E2B `role` is `api` or `worker` — a lead is `worker`). This file is the
  source of truth for **full history**, because the SDK's `commands.connect(pid)`
  only streams output forward from the connect instant (no historical replay).

Stream a swarm's logs by slug:

```bash
# History (last 200 lines) of the API sandbox (default --role api):
bun run src/cli.tsx e2b swarms logs my-swarm

# A worker's log, last 500 lines:
bun run src/cli.tsx e2b swarms logs my-swarm --role worker --tail 500

# Follow live (Ctrl-C to stop); needs a single target sandbox:
bun run src/cli.tsx e2b swarms logs my-swarm --role api --follow
```

- `--role api|lead|worker` selects which sandbox's tee'd log to read (default
  `api`). `lead` and `worker` map to the same on-disk path (`…-worker.log`) but
  are resolved to distinct sandboxes via the swarm grouping metadata.
- `--tail <n>` sets how many trailing history lines to emit (default 200).
- `--follow` tails live (`tail -F`); it refuses to run against multiple matching
  sandboxes (the two streams would interleave ambiguously) — omit `--follow` for
  history across all matches.
- No PID bookkeeping is used: reads key off the deterministic per-role log path,
  so logs survive a fresh CLI process and sandbox reconnects.
- **First-call race (known quirk):** the *native* `e2b sandbox logs <id>` stream can
  return header-only (~2 lines) on the very first call right after launch, due to a
  stream-flush timing race; an immediate re-run returns full history. The tee'd file
  (`/tmp/agent-swarm-e2b-<role>.log`) is the source of truth and is what `swarms logs`
  reads, so no history is lost — just re-run if a first native read looks truncated.
- **Secret hygiene:** entrypoint output is untrusted and can embed tokens, so
  every streamed chunk is routed through `redactWithEnv` (→ `scrubSecrets`)
  before it reaches your terminal. The redaction set covers: known token shapes
  (`scrubSecrets`), the controller env, and any launch secrets you re-supply on
  the `swarms logs` call (`--secret`, `--env-file`, `--inherit-env`, `--api-key`
  are resolved the same way the launch path does and folded into the redaction
  env). **Residual limitation:** an arbitrary secret that was only known to a
  prior launch — never re-supplied here and not matching a known shape — is
  unrecoverable and may stream raw. To scrub it, re-pass the same
  `--secret`/`--env-file`/`--api-key` to `swarms logs`, or treat the logs as
  sensitive.

## GitHub Actions Shape

Store `E2B_API_KEY` plus provider credentials as repository secrets, then run:

```yaml
- name: Build E2B worker template
  run: |
    bun run src/cli.tsx e2b build-template \
      --role worker \
      --source image \
      --image ghcr.io/desplega-ai/agent-swarm-worker:${{ github.sha }}
  env:
    E2B_API_KEY: ${{ secrets.E2B_API_KEY }}

- name: Start E2B worker
  run: |
    bun run src/cli.tsx e2b start-worker \
      --api-url "${SWARM_API_URL}" \
      --api-key "${SWARM_E2E_API_KEY}" \
      --json
  env:
    E2B_API_KEY: ${{ secrets.E2B_API_KEY }}
    SWARM_E2E_API_KEY: ${{ secrets.SWARM_E2E_API_KEY }}
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Provider keys such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and
`OPENROUTER_API_KEY` are forwarded from the dispatcher process by default.
Use `--inherit-env CUSTOM_KEY` for additional CI secrets.

## Release Templates

`.github/workflows/docker-and-deploy.yml` publishes public E2B templates on
version bumps after the Docker manifests have been pushed:

- `agent-swarm-api-<version-with-dashes>`
- `agent-swarm-api-latest`
- `agent-swarm-worker-<version-with-dashes>`
- `agent-swarm-worker-latest`

The workflow builds templates from the same GHCR images as the release, then
runs `publish-template` so E2B users can start API, lead, or worker sandboxes
directly from public template names. The worker template is also the lead
runtime; start it with `--agent-role lead`.
