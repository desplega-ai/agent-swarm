# Claude SDK follow-up and implementation handoff

Date: 2026-09-09
Baseline: `726da4a7`, branch `codex/claude-sdk-research`, PR #1404.
Scope: additional feasibility tests and requirements for the next implementation session.
No production SDK adapter or UI control exists yet.

## Bridge: confirmed protocol incompatibility

The stock executable override does not establish bridge support.
The real SDK `query()` invocation against Claude Bridge `0.2.2` fails before a model request.
Bridge rejects the SDK arguments because its output mode requires `-p` or `--print`.

Adding `-p` does not supply the missing protocol.
Bridge reads stdin once as a prompt and reconstructs one result from an interactive tmux session.
The SDK requires initialization, streaming input, control responses, and interruption support.
The SDK's custom process callback still requires those messages.
Supporting this combination requires a protocol proxy or changes to the bridge, beyond choosing a binary.

Source locations in the bridge repository:

- [`src/args.ts`](https://github.com/desplega-ai/claude-bridge/blob/c93215166ee0c504f4f0c58fdd5c02b864f274fb/src/args.ts): print-mode argument validation.
- [`src/cli.ts`](https://github.com/desplega-ai/claude-bridge/blob/c93215166ee0c504f4f0c58fdd5c02b864f274fb/src/cli.ts): stdin handling, result termination, and interactive child arguments.
- [`src/claude-compat.ts`](https://github.com/desplega-ai/claude-bridge/blob/c93215166ee0c504f4f0c58fdd5c02b864f274fb/src/claude-compat.ts): reconstructed CLI events and missing metadata.

### Billing update

The existing Swarm bridge guide describes a separate SDK credit pool starting June 15.
Anthropic's current [support update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says that change was paused.
It states that SDK and `claude -p` usage still uses subscription limits.
Some Claude Code documentation still displays the older announcement.
The dated support correction is the stronger evidence for the current policy.
Successful OAuth authentication alone does not establish account billing behavior.

The implementation session should correct the stale billing rationale in the Swarm bridge guide and harness runbook.
This update does not justify silently changing existing bridge sessions.

### Open scope decision

Taras received a choice between these scopes:

1. Keep bridge sessions on CLI and reject SDK selection when bridge is effective.
2. Include a new SDK-to-bridge protocol implementation.

No answer was received when this handoff was written.
The first scope is recommended. Do not interpret elapsed time as approval.
Preserve both the supported bridge flag and legacy bridge binary handling.
Preserve the existing API-key-only fallback when a bridge flag has no OAuth credential.

## Additional test results

All authenticated probes used the OAuth setup token and installed Claude `2.1.263`.
The SDK version was `0.3.266`.
The prior isolated API-key success remains valid evidence for that earlier test.
This follow-up made no new API-key model calls.

| Area | New evidence | Remaining limit |
|---|---|---|
| Swarm hooks | SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, and Stop executed through the actual hook CLI | No full container hook matrix |
| Heartbeat | The active session heartbeat advanced in the local API | Concurrent worker behavior remains untested |
| Summary ownership | Stop skipped summary generation because the adapter-owned flag was set | Adapter summary generation and persistence need implementation |
| Shutdown effect | Stop marked the fixture agent offline | PM2 was isolated with a harmless command |
| Permissions | Tool filtering passed. Allowed Write succeeded. A project `Edit(...)` deny rule blocked the matching Write under bypass mode | Other permission modes remain unproven |
| Cancellation | Abort closed the SDK iterator and stopped a Bun fixture plus its sleep child in about 2.1 seconds | macOS descendant pair only, no Linux crash/OOM coverage |
| Telemetry | A local collector received metrics, logs, and traces. The supplied trace ID appeared. The diagnostic prompt did not | No assertion of the complete production span hierarchy |
| Context-mode | Plugin `1.0.162` loaded, strict MCP connected only the supplied server, and `ctx_execute` returned the expected marker | No compaction/restoration proof. Installer repair was disabled |
| Environment | Synthetic pool selections, runtime flags, effort flags, task identity, privacy flags, and a single extra argument reached SDK process creation | No live credential rotation or repeated-argument precedence proof |
| Bridge | Direct SDK invocation reproduced the protocol failure without credentials | SDK bridge support requires new work |

The permission probe exposed a reporting detail that the adapter must preserve.
A denied file write returned a tool error, while `result.permission_denials` and `system/permission_denied` were empty.
The final test correlates the failed tool result with the Write call and checks its permission error.
It also confirms the denied file was absent and the allowed control file existed.

An exploratory `dontAsk` allow-write control failed.
The final passing test targets the worker's actual bypass mode.
Do not claim these probes validated every SDK permission mode.

The [probe directory](./2026-09-09-claude-sdk-parity/README.md) contains the reproducible scripts and scrubbed results.
Final probe cost fields exclude earlier exploratory runs and the aborted query's missing terminal cost.
Do not present their sum as the total test cost or an OAuth surcharge.

## Next session brief

Implement optional SDK execution inside the existing Claude provider.
Continue the work on PR #1404 and keep the production implementation in that PR.
Start from `codex/claude-sdk-research` and inspect the latest branch before making changes.
Read the initial [research report](./2026-09-09-claude-agent-sdk-transport.md) and this follow-up.
Resolve the bridge scope above before implementing that combination.

### User requirements

- Keep the CLI as the default.
- Support both `ANTHROPIC_API_KEY` and the OAuth setup token.
- Reuse existing credential selection and configuration preparation.
- Preserve normal CLI configuration, hook effects, context-mode, permissions, telemetry, summaries, costs, and continuation behavior.
- Use the existing pinned Claude executable where compatible.
- Keep native resume disabled because Swarm uses context preambles.
- Do not silently discard bridge configuration or arbitrary CLI arguments.

### Agent details UI

Add a Claude-only transport selector immediately beneath the harness selector in the agent runtime editor.
Expose CLI and SDK choices and an explicit way to inherit the configured default.
Show the effective value when the agent inherits it.
Switching harnesses must preserve saved Claude configuration and hide irrelevant controls.
Apply changes to future sessions. Do not replace the transport of an active task.
Explain an effective bridge conflict beside the selector and validate it in the worker too.
Do not rely on browser validation alone.

Use an agent-scoped `swarm_config` key such as `CLAUDE_TRANSPORT`.
The existing runtime endpoint can accept a `claude` sub-object beside its current `acp` sub-object.
Preserve the existing omit/clear/set contract: omitted leaves the setting unchanged, null clears the override, and a value sets it.
No new `agents` table column is needed.
Reuse resolved configuration precedence rather than adding an independent settings system.
Keep the server and worker interpretations consistent, including repository scope where the caller supplies it.

Relevant files:

- `apps/ui/src/components/shared/agent-runtime-settings.tsx`: editor, persisted-state synchronization, and save payload.
- `apps/ui/src/pages/agents/[id]/page.tsx`: Runtime row containing the editor.
- `apps/ui/src/api/client.ts` and `apps/ui/src/api/hooks/use-agents.ts`: runtime mutation contract.
- `src/http/agents.ts`: runtime schema and transactional scoped configuration writes.
- `src/be/swarm-config-guard.ts`: value validation.
- `src/commands/runner.ts`: resolved environment and reloadable keys.
- `src/providers/claude-adapter.ts`: configuration preparation and session creation.
- `apps/ui/src/lib/configuration-catalog.ts`: operator setting catalog.

### Acceptance checks

Compare both transports under the same worker image and configuration fixtures.
Verify real credential rotation, task completion, cost/context persistence, queued input during tool execution, cancellation, and descendant cleanup.
Exercise task failures and intentional interruption separately.
Verify bridge validation, wrapper arguments, repeated flags, and configuration precedence.
Verify the agent UI save, reload, inheritance, next-session effect, and harness-specific visibility.
Capture the implemented UI with agent-browser and include its uploaded screenshot in the PR.

Run the repository CI checks required by `runbooks/ci.md`.
The basic commands are:

```sh
bun install --frozen-lockfile
bun run lint
bun run tsc:check
bun run test:root -- --parallel=4
bun run e2e
bun run e2e:ui
```

Regenerate OpenAPI when changing the runtime endpoint schema.
Update harness, configuration, and bridge documentation in the same PR.
Run the UI package and Docker gates required by touched manifests and worker files.

### Manual E2E

The existing harness command comes from `LOCAL_TESTING.md`:

```sh
E2E_MODEL_CLAUDE=claude-haiku-4-5 bun run e2e --only health --harness claude
bun run e2e:ui -- --headed specs/pages.spec.ts
```

Extend the harness leg to select and assert each transport, then run it once per transport.
The current command alone does not prove SDK selection because no SDK adapter exists yet.
Use the root environment's OAuth token for the live SDK worker test.
Use one cheap API-key test after the adapter exists.
Verify the real agent-details selector against a seeded local API, then assign a task and inspect its reported transport.
