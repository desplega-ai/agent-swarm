# Claude Agent SDK spike

These scripts support the [research report](../2026-09-09-claude-agent-sdk-transport.md).
They use `@anthropic-ai/claude-agent-sdk@0.3.266` under Bun.
The `.ts.example` suffix keeps research fixtures outside the repository's normal TypeScript build.

## Stage the scripts

Run this command from the repository root.
It writes executable copies with resolved repository imports into the temporary spike directory.

```sh
bun -e '
const source = "thoughts/taras/research/2026-09-09-claude-agent-sdk-spike";
for (const name of ["auth.ts", "controls.ts", "spawn.ts", "swarm.ts"]) {
  const text = await Bun.file(`${source}/${name}.example`).text();
  await Bun.write(`/tmp/claude-sdk-spike-20260909/${name}`, text.replaceAll("../../../../", `${process.cwd()}/`));
}
'
```

Run `bun install --frozen-lockfile` if repository dependencies are absent.
Bun resolves the pinned Agent SDK package in the isolated spike directory.
The scripts do not add it to the root package manifest.

## Run the checks

Replace the environment file path when necessary.
Keep the working directory shown below.

```sh
cd /tmp/claude-sdk-spike-20260909

# OAuth setup token, bundled Claude executable.
bun --env-file=/Users/taras/Documents/code/agent-swarm/.env auth.ts oauth

# API key, one Haiku turn, estimated budget limit of $0.20.
bun --env-file=/Users/taras/Documents/code/agent-swarm/.env auth.ts api-key

# OAuth setup token, explicitly selected Claude executable.
bun --env-file=/Users/taras/Documents/code/agent-swarm/.env auth.ts oauth /Users/taras/.local/bin/claude

# OAuth conversation, interrupt, recovery, context inspection, and resume.
bun --env-file=/Users/taras/Documents/code/agent-swarm/.env controls.ts

# Capture process creation arguments without starting a model request.
bun spawn.ts

# OAuth plus real Swarm MCP, settings, hooks, plugin, and strict isolation.
bun --env-file=/Users/taras/Documents/code/agent-swarm/.env swarm.ts /Users/taras/.local/bin/claude
```

The authentication script forwards exactly one Claude credential.
The other live scripts forward only `CLAUDE_CODE_OAUTH_TOKEN`.
They isolate Claude configuration from personal settings.

The Swarm check creates an agent and an assigned task in a fresh local API database.
It verifies `my-agent-info`, `store-progress`, and persisted progress.
It verifies project instructions, an appended prompt, a command hook, SDK callbacks, and a local plugin skill.
It supplies conflicting MCP definitions through project and plugin files.
The check fails if either inherited MCP command executes.

The Swarm check uses a 120-second timeout and a $1 estimated budget limit.
The controls check uses a 90-second timeout and a $0.50 estimated budget limit.
Budget limits use SDK estimates and do not constitute exact billing limits.

## Recorded evidence

[evidence.json](./evidence.json) contains the scrubbed results from this research session.
The tests write fresh results under `/tmp/claude-sdk-spike-20260909`.
Claude fixtures and transcripts remain there for inspection.
The Swarm check removes its temporary API database, API logs, and temporary API storage.

The evidence proves SDK feasibility for the tested versions.
It does not prove production hook behavior, credential rotation, OTel export, context-mode, or full worker lifecycle parity.
