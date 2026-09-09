# Claude SDK parity probes

These probes extend the [initial spike](../2026-09-09-claude-agent-sdk-spike/README.md).
The [follow-up report](../2026-09-09-claude-sdk-parity-follow-up.md) explains the results and their limits.

## Implementation status

PR #1404 now includes the production adapter and agent transport selector.
Taras approved rejecting SDK selection when Claude Bridge is effective.
The [implementation verification report](../2026-09-09-claude-sdk-implementation-verification.md) separates production verification from these earlier probes.
The probes below remain historical evidence. Their results do not establish complete worker parity.

The new `adapter-configuration.ts.example` compares installed configuration through the production adapter.
Stage it with the same repository-path substitution shown below.
Run both transports with an isolated OAuth environment:

```sh
SPIKE_RUN_ADAPTER_CONFIGURATION=1 \
SPIKE_CONTEXT_MODE_PLUGIN=/absolute/path/to/context-mode/plugin \
  bun --env-file="$SPIKE_ENV_FILE" adapter-configuration.ts "$SPIKE_CLAUDE_EXECUTABLE"
```

Set `SPIKE_ADAPTER_TRANSPORT=cli` or `sdk` to run one transport.
Each transport uses Haiku, eight turns, a 90-second deadline, and an estimated $0.30 budget.
The script records sanitized tool diagnostics and deletes its fixture directories.
It checks project instructions, plugins, command hooks, permission tool errors, strict MCP, context-mode execution, and telemetry privacy.
It does not replace worker persistence, real account rotation, or lifecycle tests.

## Live Swarm queue acknowledgement

`worker-steering.ts.example` starts a real local API and worker with SDK transport and Haiku.
It sends two distinct messages through `POST /api/tasks/{id}/steer` while a Bash fixture remains active.
It requires both delivered rows before releasing that fixture.
It then checks two file changes, both `handled` rows, and actual `accept-steer` calls with matching message IDs.
The task must complete through SDK and persist positive token counts.

Stage it with the repository-path substitution below, then run:

```sh
SPIKE_RUN_WORKER_STEERING=1 \
  bun --env-file="$SPIKE_ENV_FILE" worker-steering.ts "$SPIKE_CLAUDE_EXECUTABLE"
```

The probe uses only the supplied OAuth credential for the worker. It gives no model credential to the API.
It uses fresh UUIDs, a free API port, isolated directories, and a 180-second worker deadline.
It creates the Swarm MCP configuration that `docker-entrypoint.sh` normally provides.
It deletes API state, temporary MCP configuration, worker logs, and fixture files after execution.
Set `SPIKE_STEERING_RESULT` to change the sanitized result path, which defaults to `/tmp/claude-sdk-worker-steering-result.json`.

The [recorded run](./worker-steering-result.json) passed on macOS with Claude 2.1.266 and Haiku.
Both messages reached `delivered` while the original tool was active, then reached `handled` through separate `accept-steer` calls.
Both unique file markers matched. The task completed with SDK metadata and $0.0515 in API pricing records.

An initial fixture omitted Swarm MCP and could not acknowledge messages. A second run acknowledged both but checked costs before session completion.
The final fixture includes MCP and waits for costs after the task becomes completed. No production change was required.
This verifies queued delivery and acknowledgement. It does not verify interrupt-and-redirect or every session-boundary race.

## Stage

Run from the repository root. Templates use a repository-path placeholder to avoid machine-specific imports.

```sh
bun -e '
const source = "thoughts/taras/research/2026-09-09-claude-sdk-parity";
for (const name of ["hooks", "environment", "lifecycle", "permissions", "telemetry", "context-mode", "bridge", "adapter-configuration", "worker-steering"]) {
  const text = await Bun.file(`${source}/${name}.ts.example`).text();
  await Bun.write(`/private/tmp/claude-sdk-parity-20260909/${name}.ts`, text.replaceAll("__SPIKE_REPO_ROOT__", process.cwd()));
}
'
```

Install repository dependencies with `bun install --frozen-lockfile` before running the hook probe.
Bun resolves the pinned `@anthropic-ai/claude-agent-sdk@0.3.266` import in the temporary directory.

## Run

Use a root environment file that contains the OAuth setup token.
Each authenticated query passes only that Claude credential into its isolated child environment.
The environment and bridge probes make no model calls.

```sh
cd /private/tmp/claude-sdk-parity-20260909
SPIKE_ENV_FILE=/absolute/path/to/agent-swarm/.env
SPIKE_CLAUDE_EXECUTABLE=/absolute/path/to/claude
SPIKE_BRIDGE_EXECUTABLE=/absolute/path/to/claude-bridge

bun environment.ts "$SPIKE_CLAUDE_EXECUTABLE"
bun bridge.ts "$SPIKE_BRIDGE_EXECUTABLE"
bun --env-file="$SPIKE_ENV_FILE" hooks.ts "$SPIKE_CLAUDE_EXECUTABLE"
bun --env-file="$SPIKE_ENV_FILE" lifecycle.ts "$SPIKE_CLAUDE_EXECUTABLE" > lifecycle-result.json
bun --env-file="$SPIKE_ENV_FILE" permissions.ts "$SPIKE_CLAUDE_EXECUTABLE" > permissions-result.json
bun --env-file="$SPIKE_ENV_FILE" telemetry.ts "$SPIKE_CLAUDE_EXECUTABLE"
SPIKE_CONTEXT_MODE_PLUGIN=/absolute/path/to/context-mode/plugin \
  bun --env-file="$SPIKE_ENV_FILE" context-mode.ts "$SPIKE_CLAUDE_EXECUTABLE"
```

The permissions probe uses three Haiku queries. Other authenticated probes use one query each.
Each query has an estimated budget of $0.30, except telemetry at $0.10.
These are SDK estimates, not exact billing limits or evidence of subscription surcharges.

## What each probe establishes

| Probe | Assertion |
|---|---|
| `environment` | Selected synthetic pool members, runtime flags, privacy flags, task identity, and one extra argument reach SDK process creation |
| `bridge` | The real SDK invocation triggers the known bridge protocol rejection before authentication |
| `hooks` | Actual Swarm hooks run, update the heartbeat, preserve summary ownership, and mark the fixture agent offline |
| `lifecycle` | Abort closes the iterator and stops the recorded Bun process and its sleep child within five seconds |
| `permissions` | SDK tool filtering works, an allowed write succeeds, and a project file deny rule blocks the matching write |
| `telemetry` | A local collector receives metrics, logs, and traces without the diagnostic prompt text |
| `context-mode` | An isolated copy of the installed plugin connects under strict MCP configuration and executes a harmless snippet |

The hook probe isolates HOME and substitutes a harmless PM2 command.
It does not prove cleanup of real artifact tunnels, identity-file synchronization, or the PreCompact effect.
The context-mode probe disables installer repair with `VITEST=1` and removes its staged plugin after the query.
It does not prove context restoration across compaction.
The lifecycle probe verifies one descendant pair on macOS, not every worker shutdown failure on Linux.

The scripts scrub diagnostic output. They delete temporary API state and the hook's credential-bearing MCP configuration.
Other local Claude fixtures and transcripts remain in the temporary directory for inspection.
[Recorded evidence](./evidence.json) omits fixture process IDs and includes only the final probe results.

All seven scripts passed the repository TypeScript settings against the pinned SDK declarations and passed Biome.
Keep declaration mappings in a separately named `tsconfig.check.json`.
Naming that file `tsconfig.json` makes Bun resolve the runtime package import to the declaration file.
