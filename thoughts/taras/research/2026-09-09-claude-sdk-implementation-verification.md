# Optional Claude SDK transport: implementation verification

Date: 2026-09-09
Branch: `codex/claude-sdk-research`
PR: https://github.com/desplega-ai/agent-swarm/pull/1404
Starting commit: `af5dd4886e56e68d4d7619fb568d78e051288d37`

## Approved scope

Taras approved keeping bridge sessions on CLI and rejecting SDK selection when bridge is effective.
This implementation does not add an SDK protocol to Claude Bridge.
The existing API-key-only fallback and legacy bridge binary handling remain available.

## Implementation

- `CLAUDE_TRANSPORT` selects `cli` or `sdk` inside the Claude provider. CLI remains the default.
- The adapter shares credential selection, task configuration, MCP preparation, normalized events, and summary processing.
- SDK execution uses the installed Claude executable, including configured executable prefixes.
- SDK options preserve Claude Code's native system prompt. The staged Swarm prompt remains an appended file.
- Unsupported protocol and continuation arguments fail before temporary files are created.
- SDK sessions retain Swarm context preambles and do not use native resume.
- Task metadata records the actual transport as `providerMeta.transport`.
- Agent details offer CLI, SDK, and inheritance beneath the harness selector.
- Runtime updates distinguish omitted values, explicit values, and `null` for clearing an agent override.
- Configuration uses existing repository, agent, global, and deployment precedence. No agents column was added.
- SDK selection conflicts with effective bridge settings in the runtime API, UI, and worker.

The SDK dependency is pinned to `0.3.266`.
Its MCP peer requires `^1.29.0`, so the shared MCP SDK moved from `1.25.1` to `1.29.0`.
The lockfile has no removable duplicates.

Local summary execution exposed a schema compatibility error in the existing CLI summarizer.
Claude Code 2.1.263 rejected the default Draft 2020-12 schema before model execution.
The summarizer now emits Draft 7. A focused test verifies the schema identifier.

## Authenticated execution

All model tests used isolated fixtures and `claude-haiku-4-5`.
OAuth came from the authorized local environment file. Credentials were not included in this report or screenshots.
Exactly one API-key worker test was executed.

| Environment | Transport | Authentication | Result |
| --- | --- | --- | --- |
| macOS, Claude 2.1.263 | CLI | OAuth | Real worker task passed, with CLI metadata and cost records |
| macOS, Claude 2.1.263 | SDK | OAuth | Real worker task passed, with SDK metadata and cost records |
| macOS, Claude 2.1.263 | SDK | API key alone | Real worker task passed, with SDK metadata and cost records |
| Linux arm64, compiled worker, Claude 2.1.266 | CLI | OAuth | Real worker task passed, with CLI metadata and cost records |
| Same Linux image and fixture | SDK | OAuth | Real worker task passed, with SDK metadata and cost records |

An earlier Linux SDK task returned the expected marker in logs, then used `DONE` as its final text.
The final comparison passed expected-output checks for both transports. CLI cost was $0.0297 and SDK cost was $0.0446 in API pricing records.
Both Linux runs used the same worker fixture, compiled worker build, and executable pin.

## UI verification against a real local API

The API used a fresh SQLite database and dynamically allocated ports.
The worker and browser used the same agent, with a valid UUID.
Screenshots were captured with `agent-browser` and uploaded to `agent-fs`.

1. Saved CLI and reloaded the agent page. The runtime endpoint returned an explicit CLI override.
2. Assigned a real task. Task `cb721b20-a090-4212-810d-1da6a6254c94` completed with CLI metadata.
3. Saved SDK and reloaded. Task `0111ec22-61c8-43be-a870-deb508ea1745` completed with SDK metadata.
4. Selected Codex, saved a fixture model, and reloaded. The selector stayed hidden and the Claude SDK override remained stored.
5. Selected Claude again. The SDK setting reappeared.
6. Set the global default to SDK, selected Inherit, saved, and reloaded. The runtime endpoint returned `transport: null` and `effectiveTransport: sdk`.
7. Started task `dc1eb4e4-68ad-4525-ab3a-fcc453b18304`, then changed the global default to CLI.
8. The active task completed through SDK. Its stored context usage reached 18,297 tokens of a 200,000-token window.
9. Task `5379d3fe-3495-4748-a876-9e83b8320c44` then completed through CLI on the same worker.
10. Enabled bridge settings in the isolated API. Selecting SDK displayed a conflict and disabled Save.

The local fixture initially lacked API-visible credentials while the worker had OAuth.
The existing model availability gate blocked saving a known model in that configuration.
Adding the same OAuth credential as an agent-scoped secret made the fixture consistent.

Screenshot paths:

- `qa/agent-swarm/2026-09-09-claude-sdk/sdk.png`
- `qa/agent-swarm/2026-09-09-claude-sdk/inherited.png`
- `qa/agent-swarm/2026-09-09-claude-sdk/bridge-rejection.png`

## Verification status

Passing checks:

- Frozen root and UI dependency installs.
- Root lint and TypeScript checks.
- Full root suite: 8,504 passed, 14 skipped, zero failed across 556 files.
- Black-box E2E: 11 passed.
- Playwright UI E2E: 44 passed, 17 skipped.
- UI lint and project-reference TypeScript build.
- Documentation production build.
- API, worker-slim, and evals Docker builds.
- DB, API-key, RBAC, audit-column, test-spawn, and async DB boundaries.
- Floating-promise and promise-sink checks.
- RBAC and OpenAPI response coverage.
- Dependency graph check, with 16 existing warnings and no errors.
- Operator skill check, Bun version pin check, and lockfile deduplication check.
- OpenAPI and generated documentation regeneration.

Earlier full-suite runs found the expected route-count update, an asset API failure, and intermittent OpenCode five-second timeouts.
The route-count expectation now includes the new runtime GET endpoint.
The final complete suite passed without test retries or changes to the OpenCode tests, after competing builds and browser fixtures had stopped.

## Lifecycle and persistence

The production SDK adapter passed two opt-in tests inside the Linux worker image under `tini`.
One test delivered simultaneous queued messages after an explicit `/compact` command.
The adapter reported a manual compaction boundary with 18,754 prior tokens.
The other test cancelled a real Bash fixture and its child process.
Cancellation took 124 ms. Both processes stopped, and the result carried `errorCategory: cancelled`.

A deterministic test starts the real API and worker for each transport.
Its executable fixture implements the SDK initialization handshake and CLI output protocol.
The test checks persisted transport metadata, positive costs and tokens, context snapshots, compaction, and session-summary memory.
Both synthetic credential types reach the executable. The API records their usage and retains OAuth attribution when both types exist.
A second test keeps the SDK worker running across two tasks and applies cooldowns to the first selected OAuth and API pool entries.
The next task selects the remaining entry in each pool. Both tests pass with 36 assertions.
This test exposed a race in secondary usage reports, which could overwrite the task’s primary credential metadata.
Only the primary Claude credential report now includes the task ID.
The summary provider uses a local HTTP fixture. No model credentials are required.

The small authenticated tasks produced no stored summary because the summarizer returned `No significant learnings.`
The ledger task also produced no stored summary.
The deterministic worker test proves persistence through the real worker, API, and database.
It does not prove that a real summarizer will consider every task suitable for memory.

## Installed configuration through the production adapter

The optional `adapter-configuration.ts.example` runs CLI and SDK against matching isolated fixtures on macOS.
Both passed project instructions, installed plugin initialization, a denied Read, a command hook, and local metrics, logs, and traces export.
Neither transport exported the diagnostic prompt marker to the telemetry collector.
Both executed a harmless JavaScript snippet through the installed context-mode plugin and returned its expected marker.

The first SDK run lacked successful context execution evidence. A diagnostic rerun passed without an adapter change for context-mode.
The probe now records bounded, sanitized tool and MCP diagnostics. Model compliance remains part of this live test.
The installed plugin was version 1.0.162. The fixture disabled installer repair and did not update it.

## Review

Two fresh reviewers evaluated Standards and Spec separately.

**Standards:** fixed SDK interpreter handling for script executables, including prefixes.
Fixed transport controls against older APIs without disabling existing model or harness saves.
Updated lifecycle tests to use the repository's bounded subprocess helper and budget.
Removed a queue override that had masked the unknown-version assertion.

**Spec:** fixed credential selection when repository configuration names a different harness from the executing adapter.
Validated protocol and native-continuation flags inside executable prefixes as well as additional arguments.
Resolved the executable using the session PATH.
Intentional SDK interruption now emits `session.cancelled`, rather than `session.failure`.
Cancellation reasons are scrubbed before they reach worker diagnostics.
The review also identified verification limits for real credential rotation and installed configuration.
The sections above and below distinguish deterministic coverage from authenticated evidence.

## Evidence limits

Distinct authenticated accounts were not available for account-to-account credential rotation testing.
OAuth and API-key authentication passed independently. Synthetic tests cover simultaneous credentials and selection precedence.
The Linux live compaction test uses `/compact`. It does not establish automatic threshold-triggered compaction under sustained load.
The earlier hook, heartbeat, permission, telemetry, and context-mode probes remain documented separately.
They do not establish every worker shutdown path or context restoration behavior.

Authentication success does not establish account billing behavior.
Anthropic's current guidance says the separate SDK credit-pool change remains paused.
Source: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
