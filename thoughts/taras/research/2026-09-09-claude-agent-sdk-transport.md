---
date: 2026-09-09T02:32:53+02:00
researcher: Codex
git_commit: 98a86c41f4244a678ae8781994233686c081cd83
comparison_commit: 5d3be83d1c92551440efbdbe3fe8d2d6cc68b7b1
branch: detached HEAD
repository: agent-swarm
topic: "Optional Claude Agent SDK transport with CLI configuration parity"
tags: [research, claude, agent-sdk, harness-providers, steering]
status: complete
autonomy: critical
last_updated: 2026-09-09
last_updated_by: Codex
---

# Research: Optional Claude Agent SDK transport

## Research question

Can Agent Swarm select Claude CLI execution or Claude Agent SDK execution?
Both paths must support an Anthropic API key and a Claude setup token.
Existing CLI configuration must retain its behavior.
What benefits does the SDK provide, and can we choose its internal Claude executable?

## Summary

**Yes. An optional SDK transport is technically feasible.**
Keep `HARNESS_PROVIDER=claude` and introduce a separate transport choice, such as `CLAUDE_TRANSPORT=cli|sdk`.
This setting does not exist today.
Keep `cli` as the initial default.

The Agent SDK still launches Claude Code.
It provides typed events and a control interface around that process.
It does not replace Claude Code with direct Messages API calls.
We can select the installed executable with `pathToClaudeCodeExecutable`.
We can control process creation through `spawnClaudeCodeProcess`.
The local spike verified both controls.

**Configuration parity needs explicit implementation and tests.**
Normal settings, hooks, MCP servers, permissions, environment variables, and plugins have corresponding SDK mechanisms.
The bridge and arbitrary CLI wrappers need special treatment.
Do not silently discard their configuration when the operator selects SDK execution.

## Evidence and repository baseline

This worktree is at `98a86c41` and diverged from the observed `origin/main`.
It has three local-only commits, while `origin/main` has five commits absent here.
Their merge base is `bb250363`.
The merged Codex app-server implementation is at `5d3be83d`, PR #1393.
The Claude adapter and provider types are unchanged between those revisions.
No production code changed during this research.

The spike used Bun `1.4.0` and `@anthropic-ai/claude-agent-sdk@0.3.266`.
That SDK bundled Claude Code `2.1.266`.
The executable override used the installed Claude Code `2.1.263`, matching this checkout's worker image pin.

### Live checks

| Check | Result | Evidence |
|---|---|---|
| OAuth setup token | Passed | Fresh Claude configuration directory, OAuth token only, successful response |
| Anthropic API key | Passed | Separate configuration directory, API key only, successful response |
| API-key spending | $0.000521 reported | Haiku response, configured $0.20 estimated budget limit |
| Installed executable override | Passed | Requested `/Users/taras/.local/bin/claude`, init reported `2.1.263` |
| Streaming conversation | Passed | Later turn recalled the first turn's random marker |
| Interrupt and recovery | Passed | Interrupted a Bash turn, then completed another turn in the same query |
| Interrupt receipt | Received | `still_queued: []`, control response arrived in 1 ms |
| Session resume | Passed | A new query recalled the marker using the previous session ID |
| Context API | Passed | `getContextUsage({ detail: "summary" })` returned usage and capacity |
| Custom process callback | Passed without model call | Callback received the requested executable and SDK arguments |
| Large appended prompt | Passed argument inspection | A 150 KB append did not appear in the process arguments |
| Real Swarm MCP | Passed with both executables | Called `my-agent-info` and `store-progress`, then verified progress through HTTP |
| Project configuration | Passed with both executables | Loaded `CLAUDE.md`, appended prompt, SessionStart command hook, and local plugin skill |
| Programmatic callbacks | Passed with both executables | PreToolUse and PostToolUse callbacks observed Read calls |
| Strict MCP isolation | Passed with installed CLI | Ignored stale project and plugin servers, retained project hooks and the supplied HTTP server |

The interrupt latency measures the receipt, not complete termination of every descendant process.
The interrupted turn returned `error_during_execution`.
The next turn returned success.
The adapter must distinguish an intentional interruption from a failed task.

The controls query reported cumulative costs of $0.004203, $0.008544, $0.017458, and $0.0186662.
Summing those results would overcount usage.
OAuth cost fields are estimates, not evidence of additional subscription billing.

The initial MCP checks reported $0.0461628 with bundled Claude and $0.0240958 with installed Claude.
Both used the OAuth setup token.
The test supplied configuration markers through files and settings, rather than including the expected values in the task prompt.
It checked the command hook's output file and verified both MCP calls.
The strict-isolation variant reported $0.020477 and listed only the connected `agent-swarm` server.
Sentinel MCP commands in project and plugin files did not execute.

## What we gain

| Area | Current raw CLI path | SDK path |
|---|---|---|
| Protocol | Swarm constructs CLI arguments and parses JSONL | SDK manages the protocol and supplies typed messages |
| Steering | Swarm writes user frames to persistent stdin | SDK accepts streamed user messages and exposes controls |
| Interruption | Current Claude adapter advertises queue only | `interrupt()` can stop a turn while preserving the query |
| Hooks | Installed command hooks | Command hooks plus TypeScript callbacks |
| MCP | Swarm stages a merged configuration file | Same merged configuration, plus typed status and management methods |
| Context inspection | Swarm derives usage from events | SDK also exposes an explicit context inspection method |
| Executable selection | `CLAUDE_BINARY` | Explicit executable path or a custom process callback |

The clearest benefit is less custom control-protocol code.
These capabilities remain Claude Code capabilities underneath.
We could implement the same protocol ourselves, but we would own its compatibility work.

The SDK does not inherently improve model quality, reduce token cost, or remove the child process.
It adds a package dependency and an SDK/CLI compatibility requirement.
We must still normalize events into Swarm's existing interfaces.
We also retain responsibility for credential selection, cancellation, hooks, logging, and task completion.

Use the current documented `query()` interface.
Do not build this adapter around an experimental session helper or an explicitly experimental usage API.
These API choices follow the [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript).

## Selecting the internal executable

The preferred first implementation should use the same installed Claude binary as the CLI transport.
This keeps transport selection separate from Claude version changes.

```ts
const session = query({
  prompt: inputMessages,
  options: {
    pathToClaudeCodeExecutable: resolvedClaudeExecutable,
    env: resolvedClaudeEnvironment,
    settingSources: ["user", "project", "local"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  },
})
```

This is a configuration sketch, not a complete adapter.
The live smoke passed with SDK `0.3.266` and external CLI `2.1.263`.
That does not establish compatibility with arbitrary older or modified executables.

`spawnClaudeCodeProcess` provides deeper control over command, arguments, environment, and the returned process handle.
It can preserve wrapper arguments and Swarm's process lifecycle requirements.
Its handle contract uses Node-style streams and process events.
A `Bun.Subprocess` cannot be passed directly without adapting that interface.

The custom callback inspection also preserved `--append-system-prompt-file` through `extraArgs`.
`extraArgs` is a key/value map, while existing `additionalArgs` is an ordered array.
Repeated flags and precedence therefore need deliberate handling.
Do not convert the array to an object without checking those semantics.

## Configuration parity inventory

The following table defines implementation requirements.
A documented mapping is not a passing production parity test.

| Existing configuration | Required SDK behavior | Current evidence |
|---|---|---|
| `ANTHROPIC_API_KEY` | Pass the selected task credential | Live authentication passed |
| `CLAUDE_CODE_OAUTH_TOKEN` | Pass the selected setup token | Live authentication passed |
| Credential pools and precedence | Preserve selection from both pools and OAuth-first validation/tracking | Existing code mapped, rotation and dual-credential behavior not tested |
| `config.env` and `CLAUDE_CONFIG_DIR` | Preserve the resolved per-task environment and configuration directory | Isolated directory tested |
| `CLAUDE_BINARY` | Resolve the same executable and wrapper prefix | Single executable override tested |
| Bridge flag and legacy bridge binary | Preserve tmux, trust initialization, auth fallback, and transcript behavior | SDK compatibility not established |
| Model and reasoning effort | Preserve model selection, `CLAUDE_CODE_EFFORT_LEVEL`, and `MAX_THINKING_TOKENS=0` | Model passed, effort parity not tested |
| `additionalArgs` | Preserve ordering, repeated flags, and precedence where compatible | SDK passthrough inspected, full parity not tested |
| System prompt | Append the registered Swarm prompt to Claude Code's normal prompt | Large prompt argument inspection passed |
| `CLAUDE.md` and settings | Load the same user, project, and local sources | Synthetic project configuration passed with both executables |
| Worker permissions | Preserve bypass mode and configured denied tools | Bypass execution passed, deny rules not tested |
| Worker style and feature settings | Preserve Concise style and disabled bundled skills, remote control, and connectors | Configuration mapping only |
| Native skills, commands, agents, plugins | Preserve image-installed content and native skill discovery | Local plugin discovery and skill invocation passed |
| Command hooks | Preserve SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, and Stop | Production hook behavior not tested |
| Hook identity and summaries | Preserve `TASK_FILE`, task/agent IDs, summary ownership, and OAuth token mirror | Existing code mapped |
| Runtime controls | Reuse `buildClaudeCodeRuntimeEnv()` | Existing code mapped |
| Prompt cache duration | Preserve default `ENABLE_PROMPT_CACHING_1H=1` and the later environment override | Existing code mapped |
| OTel controls | Reuse trace propagation and privacy defaults | Exporter parity not tested |
| MCP configuration | Reuse existing ancestor-file merge and fresh server resolution | Merged HTTP configuration passed, ancestor and refresh cases remain untested |
| MCP headers | Preserve authorization, agent, source task, context, and runtime identity | Supplied through the existing merge helper and exercised against the real API |
| Context-mode | Preserve MCP injection, plugin hooks, disable flag, and nudge interval | Full plugin behavior not tested |
| Queue settings | Preserve `CLAUDE_QUEUE_STEERING` policy and delivery acknowledgements | Sequential conversation passed, active queue race not tested |
| Continuation | Preserve Swarm prompt preambles | SDK resume works, but Swarm intentionally disables native resume |
| Costs and context | Normalize to current Swarm fields and the unified context formula | SDK fields observed, persistence parity not tested |
| Shutdown and cleanup | Preserve cancellation, process cleanup, final summary, and secret scrubbing | Query close exercised, process-group failure cases not tested |

### Exact environment and hook requirements

`buildClaudeCodeRuntimeEnv()` currently controls these values:

```text
ENABLE_TOOL_SEARCH=true
CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING=1
CLAUDE_CODE_SKIP_PROMPT_HISTORY=1
CLAUDE_CODE_DISABLE_ATTACHMENTS=1
DISABLE_TELEMETRY=1
DO_NOT_TRACK=1
DISABLE_FEEDBACK_COMMAND=1
DISABLE_BUG_COMMAND=1
```

The adapter also supplies `TASK_FILE`, `AGENT_SWARM_TASK_ID`, `AGENT_SWARM_AGENT_ID`, and `AGENT_SWARM_ADAPTER_SESSION_SUMMARY=1`.
It mirrors the selected OAuth token as `AGENT_SWARM_CLAUDE_OAUTH_TOKEN` for the internal summary path.
It supplies `CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY`.
Reuse this preparation instead of copying a partial list into another transport.

The installed hooks enforce cancellation, tool-loop checks, activity updates, heartbeats, compact reminders, identity synchronization, cleanup, and session summaries.
Loading a synthetic hook proves the mechanism.
It does not prove every production hook's effect or prevent duplicate callbacks.

`createSessionMcpConfig()` merges ancestor `.mcp.json` files and fresh installed servers.
It injects `X-Source-Task-Id`, `X-Context-Key`, and `X-Runtime-Instance-ID`.
It also injects context-mode so its tools survive strict MCP configuration.
Read the generated JSON and pass its `mcpServers` object with `strictMcpConfig: true`.
Keep settings and hooks enabled without allowing stale project or plugin MCP entries to enter the effective configuration.
The spike verified this combination with project MCP auto-approval enabled and conflicting project/plugin server entries.

The current helper reads `process.env.CONTEXT_MODE_DISABLED`, rather than the per-task `config.env` overlay.
Changing that source would alter current behavior.
Keep that distinction explicit during implementation.

### Settings defaults need an explicit choice

The installed SDK `0.3.266` declarations say omitted `settingSources` loads user, project, and local settings.
Older SDK guidance described different defaults.
Set the sources explicitly to preserve this project's behavior across SDK upgrades.
Include the project source for `CLAUDE.md` discovery.

The authentication smoke used `settingSources: []` only to isolate credentials and exclude personal hooks.
That isolation setting is not the proposed production configuration.
The [system prompt documentation](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts) describes the corresponding prompt and settings controls.

### Bridge limitation

The bridge launches interactive Claude through tmux and reconstructs transcript events.
The SDK expects a bidirectional stream and control protocol.
A configurable binary path does not make those protocols compatible.

Keep bridge sessions on the existing CLI transport until a dedicated compatibility test proves otherwise.
For an explicit `sdk` plus bridge combination, report the conflict clearly.
Do not silently disable the bridge.
If identical bridge behavior is mandatory under SDK selection, the research does not establish that requirement yet.

Apply this rule to both `SWARM_USE_CLAUDE_BRIDGE` and the legacy bridge name in `CLAUDE_BINARY`.
The current bridge flag falls back to stock Claude when no OAuth token exists.
Preserve that credential-dependent behavior explicitly.

## Relationship to the Codex app-server implementation

The merged Codex change launches an isolated session runner and a Codex app-server process.
It uses a persistent control channel for native steering and interruption.
That process lifecycle pattern is relevant to a Claude SDK adapter.
It is not an existing generic transport selector.

Codex app-server selection is unconditional in the merged implementation.
`SWARM_CODEX_APP_SERVER=1` suppresses the legacy steering-hook polling path.
It does not disable every Codex hook.
It does not choose between transports.

See the [merged app-server implementation](https://github.com/desplega-ai/agent-swarm/blob/5d3be83d1c92551440efbdbe3fe8d2d6cc68b7b1/src/providers/codex-app-server.ts#L56),
[session runner](https://github.com/desplega-ai/agent-swarm/blob/5d3be83d1c92551440efbdbe3fe8d2d6cc68b7b1/src/commands/codex-session-runner.ts#L121),
and [adapter](https://github.com/desplega-ai/agent-swarm/blob/5d3be83d1c92551440efbdbe3fe8d2d6cc68b7b1/src/providers/codex-adapter.ts#L1894).

## Recommended scope

Add an opt-in SDK session implementation beneath `ClaudeAdapter`.
Share configuration preparation with the CLI implementation.
Use the installed, pinned Claude binary first.
Preserve the current provider event contract and continuation policy.

Use the SDK controls to implement queueing and interruption with explicit delivery acknowledgements.
Keep task cancellation separate from interrupting one turn.
Preserve bounded process termination and prevent duplicate summaries or hook effects.

Expose a validated transport setting through the existing configuration catalog.
Retain CLI as the default until configuration and lifecycle parity pass.
The prototype proves feasibility, not production readiness.

## Authentication scope

The local setup token worked through both the bundled and installed Claude executables.
The API key also worked independently.
This answers the technical authentication requirement for the tested versions.

The runner can supply a selected member from each credential pool when both variables exist.
OAuth takes precedence for validation and primary tracking.
The runner does not remove the API key in that case.
Claude Code determines the effective authentication method.
Our authentication tests isolated the variables and did not test that combined case.

Anthropic separately distinguishes personal automation from products that relay customer subscription credentials.
Product distribution requires checking its current terms independently of this technical result.
See [Claude authentication](https://code.claude.com/docs/en/authentication) and the [Agent SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart).

## Code references

| File | Lines | Role |
|---|---|---|
| `src/providers/types.ts` | 1, 56, 105 | Costs, normalized events, session interface |
| `src/providers/claude-adapter.ts` | 95, 168 | Executable resolution and bridge |
| `src/providers/claude-adapter.ts` | 324, 387 | MCP merge and configuration staging |
| `src/providers/claude-adapter.ts` | 482, 518, 624 | OTel and runtime environment |
| `src/providers/claude-adapter.ts` | 732, 942 | Arguments and event normalization |
| `src/providers/claude-adapter.ts` | 1214, 1231 | Provider traits and disabled native resume |
| `src/utils/credentials.ts` | 196, 264 | Credential choice and pools |
| `src/providers/reasoning-effort.ts` | 208 | Claude effort translation |
| `src/hooks/hook.ts` | 1025, 1154, 1310 | Hook lifecycle effects |
| `src/commands/runner.ts` | 3357, 3526, 5838 | Session configuration, persistence, cancellation |
| `src/commands/context-preamble.ts` | 1 | Existing continuation policy |
| `Dockerfile.worker` | 118, 194, 232 | CLI pin, context-mode, settings, and hooks |

## Remaining verification

Before release, compare both transports against the same worker image and configuration fixtures.
Verify real installed hooks, context-mode, denied tools, OTel, credential rotation, event persistence, cancellation, and descendant cleanup.
Test concurrent tasks and queued steering during active tool execution.
Test wrapper arguments and configuration precedence explicitly.

Do not enable SDK execution for bridge configurations without establishing protocol compatibility.
Do not treat the successful native-resume spike as permission to change Swarm's continuation model.

## Reproduce the spike

The [spike directory](./2026-09-09-claude-agent-sdk-spike/README.md) contains source templates and scrubbed evidence.
Its README provides staging commands and the exact run commands.
The scripts use a temporary API database and free ports.
They disable external Swarm integrations and delete the temporary API state after each run.

All four executable scripts passed TypeScript checking with the repository compiler settings and the pinned SDK declarations.
The source templates passed Biome checking before archival.
No existing tests, dependencies, lockfiles, or production implementations changed.

The SDK integration test runs directly against the API.
It does not run through a production `ClaudeSdkSession`, because that implementation does not exist yet.

## Appendix: related sources

- [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Agent SDK hosting](https://code.claude.com/docs/en/agent-sdk/hosting)
- [Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
- [Agent SDK MCP](https://code.claude.com/docs/en/agent-sdk/mcp)
- [Agent SDK cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
- [Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- `thoughts/taras/plans/2026-07-27-harness-steering/root.md`
- `thoughts/taras/plans/2026-07-27-harness-steering/step-6.md`
- `docs-site/content/docs/(documentation)/guides/claude-bridge-experimental.mdx`
