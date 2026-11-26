# Scripts runtime runbook

Read this before you change `src/scripts-runtime/*`, `src/be/scripts/*`, `src/tools/script-*.ts` or `src/http/scripts.ts`.
The root `CLAUDE.md` keeps only the rules that cause damage when missed. This file has the full contract.

## Architecture

API server owns the `scripts` + `script_versions` tables. Workers + the runtime invoke via HTTP. The runtime evaluates user-supplied TS in a `Bun.spawn` subprocess wrapped in `ulimit -v 524288 -t 60 -u 32 -f 65536 -n 64`, launched as `bun --no-orphans` (the harness dies with the API and SIGKILLs its whole descendant tree on exit; added by `buildSandboxedCommand` in `src/utils/sandboxed-process.ts`), a wall-clock AbortController (30s default; up to 5m where exposed), and a 1 MB stdout cap.

## Config injection

Agent identity + bearer + mcpBaseUrl flow as a JSON `SwarmConfigPayload` over the subprocess **stdin**, NOT env vars. Bearer is wrapped in `Redacted<string>` inside the script; user code never unwraps. `process.env` carries only Node/Bun defaults. Api-side callers run scripts through `runScriptWithRunCredential` (`src/be/scripts/run-credential.ts`): it mints a per-run token bound to the executing agent, passes it to `runScript` as `apiKey`, and revokes it when the run ends. Runs with no real agent (sentinel ids) get no token, and the loader falls back to `getApiKey()` from `src/utils/api-key.ts` (never raw env).

## FS modes

 `'none'` = per-run tmpdir (v1 only); `'workspace-rw'` returns 501 in v1 (worker dispatch is v2).

## `ctx.fs` / `ctx.sh` (`src/scripts-runtime/script-fs.ts`)

Just-bash over a `MountableFs`. `/afs` is the invoking agent's default agent-fs drive. It mounts only with the agent's own agent-scoped `AGENT_FS_API_KEY` (never a global or repo row, never `API_AGENT_FS_API_KEY`), and the key rides as a credential-broker placeholder. Every other path is `InMemoryFs`. Both executors run this host-side (under quickjs, that is the API process), so keep its limits: `SCRIPT_FS_MAX_BYTES` (scratch bodies, each shell command, each drive response) and `ScratchFs` in `scratch-fs.ts` (metadata budget, name limits, and `/afs` reserved in scratch, also through symlinks and cp / mv). just-bash and the adapter stay out of the native harness bundle: lazy import plus the Dockerfile externals. Durable script workflows and extensions do not get it.

## SDK surface

Derived from MCP tool registry at build time via `scripts/bundle-script-types.ts`. Curated allowlist in `src/scripts-runtime/sdk-allowlist.ts`.

Failed calls that throw use `SwarmToolError` (`src/scripts-runtime/swarm-tool-error.ts`): a `code`, the SDK method in `tool`, and `status` for HTTP failures. Keep existing message text when you add a throw site. One JS source defines the class for the native SDK, the QuickJS prelude and the QuickJS `swarm-sdk` module, cached on a `Symbol.for` global so `instanceof` holds across bundle copies. `quickjs-runner.ts` carries `code`, `tool`, `status` and `suggestions` across the boundary. An unknown `ctx.swarm` name is `unknown_tool` with suggestions; a tool in `ALL_TOOLS` but not in `SDK_TOOL_NAME_MAP` is `not_exposed`.

## Typecheck

 `script_upsert` runs `tsc --noEmit` against the generated `.d.ts`; rejects on diagnostics. Inline `script_run` skips typecheck (scratch hot path). The ambient `.d.ts` is assembled per call from a static base plus N **type contributors** (`src/be/scripts/type-contributors.ts`, connections API, MCP tools, per-app types); adding one is a parameter on `scriptSdkTypesWithGeneratedApis` / `scriptStdlibTypesWithGeneratedApis`, never a compiler-host change. Staleness posture: stored scripts are **not** re-typechecked when an app or connection changes.

## Boundaries

 `src/scripts-runtime/` is on both `check-db-boundary.sh` (no `src/be/db` imports) and `check-api-key-boundary.sh` (must use `getApiKey()`) allowlists.

## Tests

 `bun run test:root -- src/tests/scripts-*.test.ts` runs the existing units. Sandbox + timeout + abort + stdin-config + env-hygiene paths are the highest-risk surfaces, keep coverage tight, with new cases as e2e scenarios (`scripts/e2e/scenarios/script-*.ts`), not new unit tests.

## New MCP tools

When adding a tool, register it in `SDK_TOOL_NAME_MAP` (`src/scripts-runtime/sdk-allowlist.ts`) to expose it to scripts, or add it to `EXCLUDED_TOOLS` in `scripts/check-sdk-tool-registration.ts` with a reason. Enforced by CI.
