# Claude SDK parity probes

These probes extend the [initial spike](../2026-09-09-claude-agent-sdk-spike/README.md).
The [follow-up report](../2026-09-09-claude-sdk-parity-follow-up.md) explains the results and their limits.

## Stage

Run from the repository root. Templates use a repository-path placeholder to avoid machine-specific imports.

```sh
bun -e '
const source = "thoughts/taras/research/2026-09-09-claude-sdk-parity";
for (const name of ["hooks", "environment", "lifecycle", "permissions", "telemetry", "context-mode", "bridge"]) {
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
