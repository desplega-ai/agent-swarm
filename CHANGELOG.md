# Changelog

All notable changes to Agent Swarm are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.66.0] - 2026-04-13

### Added
- `swarmVersion` column on `agent_tasks` — each task is stamped with the current package.json version at creation time, enabling benchmarking agent performance (cost, duration, tokens) across releases (#332)
- Task detail page shows "Swarm version" metadata row in the dashboard (#332)

### Changed
- Version bump 1.65.0 → 1.66.0 to mark the benchmarking tracking boundary (#332)

## [1.65.0] - 2026-04-12

### Added
- Memory TTL support — memories can now have an `expiresAt` field; expired memories are automatically excluded from search results (#327)
- Memory staleness management with access tracking — `accessCount` field tracks how often a memory is retrieved, enabling recency-aware reranking (#327)
- `memory-delete` MCP tool for explicit memory removal (#327)
- Memory provider abstraction layer (`EmbeddingProvider`, `MemoryStore` interfaces) for pluggable storage and embedding backends (#327)
- Memory reranker combining vector similarity, recency decay, and access frequency into a unified relevance score (#327)

### Changed
- Memory system refactored from monolithic `db.ts` functions into modular `src/be/memory/` provider architecture with SQLite+sqlite-vec store and OpenAI embedding provider (#327)
- `memory-search` now uses the reranker pipeline for improved result quality (#327)
- `inject-learning` and `store-progress` updated to support new memory metadata fields (#327)

## [1.64.1] - 2026-04-11

### Added
- Anonymized telemetry integration — tracks high-level task lifecycle events (created, started, completed, failed, cancelled), server start, and worker session start/end. Opt-out via `ANONYMIZED_TELEMETRY=false` (#325)

### Fixed
- Rate limit detection now matches "hit your limit" error messages in addition to existing patterns (#324)
- Workflow `mustPass` validation failures now cancel only the failed branch's downstream nodes instead of the entire workflow run; parallel/sibling branches continue executing (#322)
- Published package now includes `tsconfig.json`

## [1.64.0] - 2026-04-10

### Changed
- Release cut after merging the latest `main`, carrying forward the Codex ChatGPT OAuth support, provider-auth documentation, and telemetry updates already landed on this branch.

## [1.63.1] - 2026-04-10

### Added
- `agent-swarm codex-login` now supports an interactive ChatGPT OAuth flow for Codex workers: it prompts for the target swarm API URL, uses best-effort masked API key input, stores credentials as the global `codex_oauth` config entry, and documents the laptop-to-Docker-Compose restore flow for deployed swarms.

### Fixed
- Codex Docker workers now convert stored `codex_oauth` credentials into the real `~/.codex/auth.json` format expected by the Codex CLI, so ChatGPT OAuth works after container boot without `OPENAI_API_KEY`.
- Codex tasks authenticated through ChatGPT OAuth now stamp `credentialKeyType=CODEX_OAUTH`, so the API Keys dashboard and cost tracking surfaces show OAuth-backed Codex usage alongside other credential types.

## [1.63.0] - 2026-04-09

### Added
- **Codex provider** — Run agents with OpenAI Codex via `HARNESS_PROVIDER=codex`. Wraps `@openai/codex-sdk` 0.118 to drive the `codex app-server` JSON-RPC protocol. Includes per-session MCP config (Streamable HTTP), slash-command skill inlining, AGENTS.md system-prompt injection, AbortController-based cancellation, tool-loop detection, heartbeat/activity reporting, and a typed model catalogue (gpt-5.4 default). Auth via `OPENAI_API_KEY` or `~/.codex/auth.json` (#100)
- Docker worker image installs the Codex CLI (`@openai/codex@0.118.0`) alongside Claude and pi-mono and ships a baseline `~/.codex/config.toml`; entrypoint validates codex auth, bootstraps `~/.codex/auth.json` from `OPENAI_API_KEY` via `codex login --with-api-key` at boot (idempotent), and mirrors slash-command skills into `~/.codex/skills/<name>/SKILL.md` (#100)
- Per-model pricing table for Codex models in `src/providers/codex-models.ts` (gpt-5.4, gpt-5.4-mini, gpt-5.3-codex, gpt-5.2-codex) sourced from developers.openai.com/api/docs/pricing — codex tasks now record real `totalCostUsd` in `session_costs` and contribute to dashboard cost summaries (#100)
- `name` and `provider` columns on the `api_key_status` table — pooled credentials now carry an auto-derived harness provider (claude/pi/codex) and an optional human-friendly label settable from the dashboard. New `PATCH /api/keys/name` endpoint and the API Keys page in the dashboard gains a Name column (click to rename via Dialog) and a Provider dropdown filter (#100)
- Provider-aware credential pooling — `resolveCredentialPools` accepts a `provider` hint and only pools env vars relevant to the active harness, so a codex worker no longer stamps a stale `CLAUDE_CODE_OAUTH_TOKEN` on its task records (#100)
- Codex `[context-overflow]` failure rewrite — when a codex turn hits the context window, the failure message is rewritten with a clear prefix and points users at Linear DES-143 for the auto-compaction follow-up. Codex `reasoning`, `todo_list`, and `agent_message` deltas now flow as `custom` ProviderEvents (`codex.reasoning`, `codex.todo_list`, `codex.message_delta`) so future UI surfaces can render them without raw_log scraping (#100)
- `scripts/e2e-docker-provider.ts` now supports `--provider codex` and `--provider all` (claude+pi+codex) for end-to-end Docker testing (#100)
- Codex log support in the dashboard's session log viewer — `parseSessionLogs` dispatches on `cli === "codex"` and maps Codex's `item.completed` events (`agent_message`, `mcp_tool_call`, `command_execution`, `reasoning`, `file_change`, `web_search`, `todo_list`) to the same ContentBlock schema used by claude/pi (#100)
- Slack message deduplication with `slackReplySent` flag — when agents post results via `slack-reply`, the task completion message shows a minimal one-liner instead of duplicating the full output (#314)
- Tree-based Slack status messages — parent tasks render child task progress in a visual tree with status icons, indentation, and overflow handling (#314)
- Slack thread buffer (`ADDITIVE_SLACK=true`) — non-mention thread replies are captured, debounced, and batched into a single follow-up task with dependency chaining (#314)
- `!now` command in Slack threads to flush the additive buffer immediately without dependency chaining (#314)
- `SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION` env var — when `true`, thread follow-up routing and additive buffering require an explicit @mention (#313)
- `slackChannelId`, `slackThreadTs`, `slackUserId` parameters on `send-task` MCP tool for explicit Slack context propagation (#314)
- GitHub eyes reaction (👀) automatically added when agents pick up GitHub-sourced tasks — supports issue comments, PR review comments, PR reviews, and issue/PR bodies (#310)
- Discoverability Optimizer agent template added to `docker-compose.example.yml` (#311)

### Fixed
- Codex adapter `peakContextPercent` no longer clamps to 100% on chatty turns — the SDK reports `input_tokens` as per-turn-cumulative across every model invocation (with cached portions counted at every roundtrip), which routinely exceeds the model's context window even when no individual call did. New formula uses `(input - cached + output) / window` as a peak proxy (#100)
- Codex adapter `contextPercent` is now emitted on the same 0-100 scale as claude/pi (was 0-1 fraction), so the dashboard's `Peak %` cell renders correctly via `.toFixed(0)` (#100)
- Dashboard `model` badge falls back to `costs[0]?.model` when `task.model` is null — codex tasks created without an explicit model in the POST body now display the actual model used (recorded by the runner in `session_costs`) (#100)
- DataGrid wrapper auto-detects editable columns and only suppresses cell focus when none are present — read-only tables are unaffected, editable columns can now take focus (#100)
- Codex SDK binary path resolved via `CODEX_PATH_OVERRIDE` env var (`/usr/bin/codex` in the Docker image) — the bundled SDK can no longer `require.resolve("@openai/codex")` from inside a Bun-compiled executable, so the override sidesteps the failure (#100)

### Changed
- Slack completion messages now conditionally show minimal or full output based on whether the agent already posted via `slack-reply` (#314)
- Buffer flush messages show dependency status ("queued pending completion" vs "batched into task") (#314)

## [1.59.3] - 2026-04-08

### Fixed
- Slack assistant thread: `file_share` messages now correctly route to the lead agent instead of being silently dropped (DES-138, #304)
- Slack assistant `setStatus`/`setTitle` calls wrapped with error handling to prevent crashes in non-assistant threads

### Changed
- `registerRegisterAgentMailInboxTool` renamed to `registerRegisterAgentmailInboxTool` for naming consistency
- Docker Compose example updated: content reviewer worker now uses `pi` harness provider with `moonshotai/kimi-k2.5` model via OpenRouter
- MCP.md regenerated to reflect tool registration changes

## [1.59.2] - 2026-04-07

### Changed
- Slack tools (`slack-reply`, `slack-read`) moved from core to deferred — only loaded when task has Slack context (#298)
- Slack prompt instructions now conditionally injected via `system.agent.worker.slack` template only for Slack-originated tasks (#298)
- New `system.agent.code_quality` template added to all session composites for repository guidelines enforcement (#298)
- Repository guidelines (PR checks, merge policy, review guidance) now injected into system prompt from per-repo configuration (#298)
- `get-repos` and `update-repo` tools added to deferred tools set (#294)

### Fixed
- Repos edit modal and added repository detail page in dashboard UI (#301)
- Task table sort state now preserved across data refreshes (#300)
- Schedule UI showing wrong "Runs At" time for future dates (#299)
- Slack template variables now use `VariableDefinition` type for proper validation (#298)

## [1.59.0] - 2026-04-04

### Added
- Unified user identity system — canonical user registry with cross-platform resolution across Slack, GitHub, GitLab, Linear, and email (DES-51, #287)
- `resolve-user` MCP tool for looking up user profiles by any platform identifier
- `manage-user` MCP tool for lead-only CRUD operations on user profiles
- Per-repo guidelines system — configurable PR checks, merge policy, and review guidance per repository (#294)
- `get-repos` and `update-repo` MCP tools for lead repo management with guidelines
- Requesting user identity surfaced in task details and agent prompts (#292)
- User management skill for creating and managing user profiles across platforms

### Changed
- Slack, GitHub, GitLab, and AgentMail handlers now resolve requesting user identity and attach it to tasks
- UX principles template generalized — replaced Desplega-specific references with placeholders

### Fixed
- Heartbeat system: aggressive reboot sweep and boot triage improvements
- `allowMerge` edge case in repo guidelines and removed type duplication
- `requestedBy` added to Trigger interface, removing double cast workaround

## [1.57.5] - 2026-04-02

### Added
- Auto-generated `llms.txt` for AI discoverability on the landing page (#283)

### Changed
- Runner structured output fallback refactored with discriminated union `FallbackResult` type for clearer error handling
- Dockerfile worker: updated plugin install commands and bumped `qa-use` to v2.11.0

### Fixed
- Workflow engine routes to correct port after validation instead of broadcasting to all ports (#280)
- Workflow script nodes now parse JSON stdout correctly for interpolation (#279)
- PostToolUse hook now validates minimum content length (100 chars) for SOUL.md/IDENTITY.md sync to prevent accidental profile corruption (#278)
- Bun test failure and typecheck error in test infrastructure (#281)

## [1.57.0] - 2026-03-31

### Added
- API key rate limit tracking and automatic rotation — tracks per-key rate limits, extracts reset times from Claude error messages, and rotates to available keys (#274)
- API Keys dashboard page with summary cards for monitoring rate limit status
- API key reference documentation and OpenAPI spec updates

### Changed
- `update-profile` tool now enforces minimum 200 character length for `soulMd` and `identityMd` fields to prevent accidental profile corruption (#272)
- Rate-limit availability fetch moved into `resolveCredentialPools` helper for cleaner code organization

### Fixed
- Profile min-length validation added server-side after repeated client-side failures (#272)
- Rate limit reset time extraction from Claude error messages

## [1.56.5] - 2026-03-30

### Changed
- GitHub event handling restricted to explicit human actions — PR closed/synchronize, reviews, CI checks are now suppressed by default to prevent cascade auto-merge behavior

## [1.56.3] - 2026-03-30

### Changed
- GitHub event handling restricted to explicit human actions — PR closed/synchronize, reviews, CI checks are now suppressed by default to prevent cascade auto-merge behavior
- New `GITHUB_EVENT_LABELS` env var (default: `swarm-review`) — label-based triggers for PR and issue events
- Heartbeat system rewritten with checklist-based approach and improved stall detection
- Session templates support added to hook system for dynamic prompt injection
- `maxTasks` schema limit increased to 100 in `get-swarm` output validation (DES-20)

## [1.55.0] - 2026-03-29

### Added
- `patch-workflow` MCP tool — partially update workflow definitions by creating, updating, or deleting individual nodes with automatic version snapshots
- `patch-workflow-node` MCP tool — partially update a single node in a workflow definition with automatic version snapshots
- `cancel-workflow-run` MCP tool — cancel running or waiting workflow runs, including all non-terminal steps and associated tasks (#265)
- Per-node `timeoutMs` support in workflow config — set custom timeouts for individual workflow nodes (#261)

### Removed
- Epics system deprecated — all epic MCP tools removed (`create-epic`, `get-epic-details`, `list-epics`, `update-epic`, `delete-epic`, `assign-task-to-epic`, `unassign-task-from-epic`, `tracker-link-epic`). Use workflows for multi-task orchestration instead
- `epicId` parameter removed from `send-task` and `store-progress` tools

### Fixed
- Workflow engine safeguards — cooldown periods, circuit breaker, and rate-limit detection to prevent runaway execution (#264)
- `validate` executor strict JSON schema disabled for OpenRouter compatibility (#263)
- `raw-llm` executor strict JSON schema disabled for OpenRouter compatibility (#262)

## [1.54.1] - 2026-03-27

### Added
- Stalled task auto-remediation and lead startup self-check — lead agent now triggers a heartbeat sweep on startup to detect and recover stalled tasks (DES-19, #256)
- `jq` added to API server Docker image for script node JSON parsing (#254)

### Fixed
- HITL loop resume — use successor routing instead of `findReadyNodes` for correct workflow loop re-entry (#257)
- Workflow engine loop support — iteration-aware idempotency keys allow workflows with cycles to re-execute nodes correctly (#255)
- HITL port-based routing for workflow resume — use port routing instead of direct node targeting (#253)
- Task details prompt expansion overflow — prevent large task descriptions from exceeding prompt limits (#258)
- Create follow-up tasks for already-tracked Linear issues (#252)
- Preserve context usage value on task completion (#251)
- Tool call progress normalization — handle case-insensitive tool names from different providers (pi-mono vs Claude)
- Store-progress dependency tracking for paused/resumed tasks

### Changed
- Deployment guide rewritten with step-by-step quick start, expanded volume architecture, and adding-workers instructions
- OpenAPI spec updated with HITL port-routing unit tests

## [1.53.0] - 2026-03-26

### Added
- MCP server management for agents — 7 new tools (`mcp-server-create`, `mcp-server-get`, `mcp-server-list`, `mcp-server-update`, `mcp-server-install`, `mcp-server-uninstall`, `mcp-server-delete`) with scope cascade (agent → swarm → global) and auto-injection into worker Docker containers (#248)
- Context usage tracking — monitor context window utilization and compaction events per task with `POST/GET /api/tasks/:id/context` endpoints, context extraction from Claude adapter and pi-mono, and visual indicators in task details (#247)
- Generic events table for tool/skill/session tracking (#246)
- Configurable DB seeding script with faker.js for realistic test data (DES-11, #245)
- Slack notifications dispatched when HITL approval requests are created (#241)
- Auto VCS PR number tracking for tasks
- Session log viewer UI redesign with markdown rendering, JSON tree, and visual polish
- Skill-check step added to `work-on-task` command (#249)

### Fixed
- `tracker-status` tool crash with undefined `req.requestInfo` (#243)
- Linear OAuth token auto-refresh (#244)
- Flaky CI test failures from shared mutable state race conditions
- Mock `slack/app` in workflow executor tests to prevent CI flake
- Use `tsc -b` for new-ui typecheck in CI and pre-push hook

### Changed
- Opus/Sonnet context window updated to 1M tokens

## [1.52.0] - 2026-03-25

### Added
- Skill system — full lifecycle for reusable procedural knowledge: create, install, publish, search, sync remote skills from GitHub repositories (#229)
  - Phases 1-6: data layer, API, filesystem bridge, system prompt injection, UI, and OpenAPI spec
  - 12 new MCP tools: `skill-create`, `skill-get`, `skill-list`, `skill-search`, `skill-install`, `skill-uninstall`, `skill-update`, `skill-publish`, `skill-delete`, `skill-install-remote`, `skill-sync-remote`
  - Scope resolution: agent → swarm → global
- Human-in-the-Loop (HITL) workflow executor — pause workflows for human approval or input via the dashboard (#228)
  - `request-human-input` MCP tool with support for approval, text, single-select, multi-select, and boolean question types
  - Approval requests UI at `/approval-requests/{id}`
  - Follow-up task auto-creation when approval requests are resolved (#234)
- Business-use instrumentation — track core system invariants across API + worker architecture via `@desplega.ai/business-use` (#237)
  - Task lifecycle, agent registration, and API boot flows
  - Optional: enters no-op mode when `BUSINESS_USE_API_KEY` is not set

### Fixed
- Server-side fallback for `sourceTaskId` on HITL approval requests (#238)
- Walk up directory tree to find `.mcp.json` for `X-Source-Task-Id` injection (#236)
- Explicit Slack metadata on HITL follow-up tasks (#235)
- Correct approval request URL path from `/requests/` to `/approval-requests/` (#233)
- Prevent runner crash when repo clone fails (#232)

## [1.51.0] - 2026-03-23

### Added
- Bot name aliases for GitHub @mentions via `GITHUB_BOT_ALIASES` env var — comma-separated list of alternative names that trigger the bot alongside `GITHUB_BOT_NAME` (#211)
- Channel activity poll trigger — lead agent can poll for new Slack channel messages since last cursor, enabling event-driven workflows (#218)
- Lead agents can now update any worker's profile via `update-profile` tool with the new `agentId` parameter (#225)
- Dynamic docs sitemap generation and 20 new documentation pages (#224)

### Fixed
- Session logs stored under wrong task ID after auto-claim pool task changes — removed redundant reassociation logic in `store-progress` (#226)
- Skip workflow-managed tasks from creating follow-up lead tasks — workflow engine handles sequencing via `resume.ts` (#226)

## [1.50.0] - 2026-03-23

### Added
- Workflow fan-out support — `next` field now accepts `string[]` for parallel execution of multiple nodes (#220)
- Configurable `onNodeFailure` on workflow definitions — `"fail"` (default) or `"continue"` to proceed with partial results (#220)
- Convergence gating — downstream nodes automatically wait for all fan-out predecessors to complete before executing (#220)
- Step deduplication — prevents duplicate steps when async tasks resume into convergence nodes (#220)
- Auto-claim for pool tasks — workers atomically claim unassigned tasks during poll instead of receiving notifications (#222)
- Session log reassociation for pool tasks — logs from pool trigger sessions are correctly linked to the real task ID (#222)
- `runnerSessionId` field on active sessions for session log tracking (#222)
- Active sessions API endpoint for updating provider session ID (`PUT /api/active-sessions/provider-session/{taskId}`) (#222)
- Schedule→Workflow triggering — when a schedule fires and an enabled workflow references that schedule in its `triggers` array, the workflow executes instead of creating a standalone task (#219)
  - Backward compatible: schedules without linked workflows still create tasks as before
  - Multiple workflows can reference the same schedule
  - `POST /api/schedules/:id/run` returns `workflowRunIds` when workflows are triggered
- Workflow-level `dir` and `vcsRepo` fields — all `agent-task` nodes that don't explicitly set these inherit the workflow-level defaults (#219)
  - Available for interpolation as `{{workflow.dir}}` and `{{workflow.vcsRepo}}`
- Prompt template registry — per-event customizable templates with scope resolution (global → agent → repo), wildcard matching, and version history (#208)
  - HTTP render endpoint for Docker workers to resolve templates via API
  - Templates UI (`templates-ui/`) with AG Grid list, Monaco editor, live preview, and template history
  - Seed runner/tool/session templates from code registry on API startup

### Fixed
- Workflow resume race condition — `finalizeOrWait` prevents stuck runs when no nodes are ready (#220)
- Retry logic uses convergence-aware node detection instead of blindly passing successors (#220)
- Worker/API DB boundary: moved `seed.ts` to `src/be/`, use DI pattern for resolver's DB access (#208)
- Test DB isolation for bun's single-process test model (#208)
- Migration version collision detection (#208)

## [1.49.0] - 2026-03-21

### Added
- `agent-swarm onboard` CLI wizard — interactive first-time setup that collects credentials, generates `docker-compose.yml` + `.env`, starts the stack, and verifies health (#206)
  - Presets: `dev`, `content`, `research`, `solo`
  - Progress indicator, `ANTHROPIC_API_KEY` support, Ctrl+C handling
  - Inline validation errors for integration steps (GitHub, GitLab, Sentry, Slack)
- `agent-swarm docs` command — show documentation URL with `--open` flag to launch in browser
- `agent-swarm claude` command — run Claude CLI with optional message and headless mode
- Workflow structured output support — agent-task nodes can define `config.outputSchema` for validated JSON responses (#207)
  - `store-progress` validates agent output against schema inline
  - Workspace scoping for agent-task executor via `vcsRepo`
- Workflow I/O schemas with explicit input mappings and data flow validation (#201)
- Fumadocs LLMs and OpenAPI integrations for docs site (#205)

### Changed
- CLI command renames: `setup` → `connect`, `mcp` → `api` (#206)
- `api` command gains `--db` flag for custom database file path
- CLI help rewritten as plain `console.log` with per-command `--help` support
- `connect` command auto-reads `API_KEY` from `.env`, uses random port, supports `APP_URL`

### Fixed
- Workflow validation: clear `nextRetryAt` when retries are exhausted (#207)
- Workflow validation: re-run validation after retry poller re-executes a step (#207)
- Workflow validation: normalize pass/fail across all executor types (#207)

## [1.48.0] - 2026-03-20

### Added
- Workflow I/O schemas with explicit input mappings and data flow validation (#201)
  - Node-level `inputs` mapping for cross-node data flow
  - Static data flow validation for input references
  - `triggerSchema` for validating trigger payloads
- Fumadocs LLMs and OpenAPI integrations for docs site (#205)
  - API Reference pages auto-generated from OpenAPI spec
  - Project selector for Documentation vs API Reference
  - `.md` extension support for LLM-friendly content
- CI merge gate for generated API docs drift detection
- SEO: automated inbound links to new documentation pages

### Changed
- API reference consolidated to single page with tag-based subsections
- Docs site sidebar navigation improved with API Reference visibility

### Fixed
- Docs site project selector visibility on all pages

## [1.47.0] - 2026-03-20

### Added
- Linear integration — bidirectional ticket tracker sync via OAuth + webhooks (#161)
  - OAuth 2.0 authorization flow with PKCE
  - Webhook handler for issue/comment events
  - `AgentSession` lifecycle tracking for Linear issues
  - Generic tracker abstraction layer (`tracker_sync` table) for future integrations
  - `.env.example` updated with Linear setup instructions
- Workflow engine redesign — DAG-based workflow automation with improved reliability (#196)
  - Executor registry architecture for extensible step types
  - Node I/O schemas with explicit input mappings and validation
  - Workflow-level `triggerSchema` validation
  - Static data flow validation for input mappings
  - Convergence deadlock fix with active edge tracking
  - Interpolation rewrite with unresolved variable tracking and deep config support
  - Slack notification executor for workflow steps
- Portless integration for local development — friendly URLs like `api.swarm.localhost:1355` (#200)
  - `dev:http` script uses portless by default
  - New `start:portless` script for production-like local runs
  - `.env.example` updated with portless configuration instructions
- `agent-fs` Claude plugin pre-installed in worker containers

### Changed
- Claude Code version pinned in Dockerfile.worker via `CLAUDE_CODE_VERSION` build arg (default: `2.1.80`) — replaces dynamic installer for reproducible builds (#202)
- Runner prompt generation is now provider-aware for pi skill prefix

### Fixed
- Corepack permissions — `COREPACK_HOME` redirected to user-writable directory to avoid "operation rejected by your operating system" errors (#202)
- `task.cancelled` outbound handler added for proper cancellation event propagation
- Follow-up tasks properly repoint `tracker_sync` for session lifecycle
- Read user message from `agentActivity` with proper stop signal handling
- Avoid duplicate responses — prefer `AgentSession` over issue comments
- [UI] Use node ID as graph label, remove schema sections from workflow inspector

## [1.45.1] - 2026-03-19

### Added
- Debug tab with database explorer — SQL query interface in the dashboard with Monaco editor, table browser sidebar, and AG Grid results display
- `db-query` MCP tool — lead-only read-only SQL queries against the swarm database (capped at 100 rows)
- `POST /api/db-query` REST endpoint for database inspection
- Agent-fs native integration — persistent, searchable filesystem shared across the swarm
  - Auto-registration on first container boot (idempotent)
  - Lead creates shared org, workers receive invitations automatically
  - System prompt conditionally includes agent-fs CLI usage instructions
  - `agent-fs` CLI and Claude plugin pre-installed in worker containers

### Changed
- Per-session MCP config — each Claude session gets its own `/tmp/mcp-{taskId}.json` config file instead of sharing `.mcp.json`, eliminating race conditions with concurrent sessions (#192)
- `--strict-mcp-config` flag ensures only per-session MCP servers are loaded (#192)
- Removed time-based `getAgentCurrentTask()` fallback — uses deterministic `sourceTaskId` only
- Slack metadata is now auto-inherited from the creator's current task via `X-Source-Task-Id` header — explicit `slackChannelId`/`slackThreadTs`/`slackUserId` params on `send-task` remain available as optional overrides (#191)

### Fixed
- Concurrency safety for Slack metadata auto-inheritance — pass `sourceTaskId` through MCP session context via `X-Source-Task-Id` header instead of guessing current task (#191)
- `send-task` now propagates `sourceTaskId` for accurate Slack metadata lookup

## [Unreleased]

### Added
- Multi-API-config UI for dashboard — connect to multiple swarm instances from a single browser (#189)
  - Slug-based connection data layer with localStorage persistence (Phase 1)
  - React context for multi-connection state management (Phase 2)
  - Sidebar swarm switcher and header connection name display (Phase 3)
  - Config page multi-connection management with URL param modal (Phase 4)
  - Health indicator dots in swarm switcher (Phase 5)

## [1.44.5] - 2026-03-17

### Added
- OpenAPI 3.1 spec at `/openapi.json` (~83KB, ~60 REST endpoints) generated from route registry (#184)
- Scalar interactive API docs at `/docs` — pre-authentication API explorer (#184)
- `MODEL_OVERRIDE` and `CAPABILITIES` env vars for content agents in `docker-compose.example.yml` (#165)
  - `content-writer`: `MODEL_OVERRIDE=opus`, capability: `content-writing`
  - `content-reviewer`: `MODEL_OVERRIDE=sonnet`, capability: `content-review` (uses Gemini via OpenRouter)
  - `content-strategist`: `MODEL_OVERRIDE=sonnet`, capability: `content-strategy`

### Changed
- `route()` factory replaces all raw `matchRoute()` calls — typed route definitions with Zod schemas for params, query, and body validation (#184)
- Lead agent now posts task results back to originating Slack threads (#183)
- Worker agents now post start/completion/failure updates to originating Slack threads (#183)

### Fixed
- Slack thread follow-ups route to lead when assigned agent is offline (#183)
- `parentTaskId` continuity preserved for follow-up tasks (#183)
- ARM compatibility for Docker Compose — added `platform: linux/amd64` to all services to fix `no matching manifest for linux/arm64/v8` on Apple Silicon Macs (#180)

### Added
- Rich Block Kit messages for all Slack responses — structured headers, context, sections, and action buttons (#177)
- Single evolving message per task — assignment, progress, and completion all update one message via `chat.update` (#177)
- Slack Assistant sidebar support with thread routing, suggested prompts, and typing status (#177)
- Interactive actions: follow-up modal for sending follow-up tasks, cancel with confirmation dialog (#177)
- Markdown-to-Slack format converter (`markdownToSlack`) for consistent formatting (#177)
- Per-agent write isolation on shared disk (#172)
  - Each agent can only write to its own subdirectory under `/workspace/shared/{category}/{agentId}/`
  - PreToolUse hook warns agents before writing to another agent's directory
  - PostToolUse hook detects "Read-only file system" errors and guides agents to use their own directory
  - Base prompt updated with per-agent directory convention and discovery commands
  - Slack download tool saves to per-agent download directory by default
- Claude credential validation — fail fast if no auth is set
- Pre-push hooks to match CI merge gate checks
- Working directory (`dir`) support for agent tasks (#159)
  - `send-task` and `task-action` accept `dir` parameter (absolute path) to set agent starting directory
  - Runner resolves `dir` for both new and resumed tasks with fallback chain: `task.dir` > `vcsRepo` clone path > default cwd
  - System prompt annotated with working directory context when non-default
- Content agent templates: writer, reviewer, strategist (#160, #162)
  - 3 new official templates: `official/content-writer`, `official/content-reviewer`, `official/content-strategist`
  - Docker-compose examples for all 3 content agents
  - Content reviewer configured with Gemini via OpenRouter (`HARNESS_PROVIDER=pi`)
- Template defaults applied during worker registration (#159)
  - Templates can now set `name`, `role`, `capabilities`, `maxTasks`, and `isLead` as fallback defaults
  - Template fetched before registration so defaults apply to the registration call itself
- Archil FUSE mount support for persistent workspace storage (#166, #168, #169)
  - `archil` CLI installed in both API and worker Docker images
  - FUSE3 and libfuse2 packages added to Docker images
  - Entrypoint-based mount logic for R2-backed persistent disks
  - Removed `VOLUME` directives for `/workspace/shared` and `/workspace/personal` to allow FUSE mounts
- Contribution guidelines (CONTRIBUTING.md) with templates linked in docs and landing page (#158)
- Templates registry for agent workers (#155, #156)
  - 6 official templates: lead, coder, researcher, reviewer, tester, forward-deployed-engineer
  - Templates UI (Next.js) with gallery, detail pages, and interactive docker-compose builder
  - `TEMPLATE_ID` env var for initial profile fetching on first boot (e.g., `official/coder`)
  - `TEMPLATE_REGISTRY_URL` env var for custom registry endpoints
  - Template idempotency: existing profile fields are never overwritten
  - GitHub issue/PR templates for community template submissions
- GitLab integration with Provider Adapter Pattern (#153)
  - `POST /api/gitlab/webhook` route with timing-safe secret verification
  - Handlers for merge_request, issue, note (comments), and pipeline events
  - Bot mention detection via `GITLAB_BOT_NAME` env var
  - GitLab trigger events for workflow engine (`gitlab.merge_request.*`, `gitlab.issue.*`, etc.)
  - `glab` CLI installed in worker Docker image
  - VCS provider detection for automatic `gh`/`glab`/`git` clone selection
  - New env vars: `GITLAB_TOKEN`, `GITLAB_URL`, `GITLAB_WEBHOOK_SECRET`, `GITLAB_BOT_NAME`, `GITLAB_EMAIL`, `GITLAB_NAME`
- ProviderAdapter abstraction with pi-mono support (#151)
  - `ProviderAdapter` interface decouples the runner from Claude CLI
  - `ClaudeAdapter` extracted from monolithic runner (~600 lines)
  - `PiMonoAdapter` with MCP tool discovery, event normalization, and cost tracking
  - All 6 swarm hook events mapped to pi-mono extension handlers
  - Selected via `HARNESS_PROVIDER=claude|pi` env var
  - Docker multi-provider support in Dockerfile.worker and entrypoint

### Changed
- API data disk switched from Archil FUSE to Fly volume for reliability
- Shared disk uses exclusive Archil mounts with `--force` for stale delegation recovery
- Template fetching refactored to run before agent registration (cached and reused for identity files)
- Docker workspace volumes replaced with FUSE mount points for Archil compatibility

### Fixed
- Thread follow-ups now route correctly after task completion — `getAgentWorkingOnThread` checks all statuses (#177)
- Docker entrypoint runs as root for FUSE mounts, then drops to worker user via `gosu` before exec
- Archil FUSE mount fixes: read-write mounts, per-agent subdirectory checkout, POSIX signal names in entrypoint, shared flag for mount calls
- `dir` validation added to MCP tool schemas with inner type cast fix
- Workspace `mkdir` made non-fatal for read-only Archil mounts
- VOLUME directives removed from Dockerfile.worker to unblock FUSE mounts on Fly.io

### Changed
- Memory system enhancements (#148)
  - Epic-linked task completions auto-promote to swarm scope (visible to all workers)
  - `inject-learning` creates swarm-scoped memories
  - Mandatory `memory-search` directive in base prompt
  - Follow-up tasks include epic context (goal, plan, progress, nextSteps)
  - Server-side memory injection enriched with epic name/goal and recent task summaries
  - New `nextSteps` column on epics (migration 005)
- Base prompt updated with VCS CLI comparison table (gh vs glab)
- DB migration 006: renames `github*` columns to `vcs*`, adds `vcsProvider` column

### Fixed
- Prevent duplicate review tasks and fix PR Lifecycle workflow (#150)
  - Dedup guard for review task creation
  - Action filtering fixes in webhook handlers
  - Webhook enrichment improvements

- Workflow automation engine with DAG-based node execution (#142)
  - Trigger nodes: task created/completed, GitHub events, Slack messages, email, webhooks
  - Condition nodes: property-match, code-match (sandboxed JS), LLM-classify
  - Action nodes: create-task, send-message, delegate-to-agent
  - Template interpolation with `{{variable}}` syntax in node configs
  - Async node support with pause/resume for long-running actions
  - Stuck run recovery and retry-from-failure support
  - 9 MCP tools for workflow CRUD, triggering, and run management
  - REST API endpoints for workflows and runs
- Workflows UI with React Flow graph visualization (#144)
  - Interactive DAG visualization with dagre auto-layout
  - Custom node components (TriggerNode, ConditionNode, ActionNode) with status overlays
  - Workflow runs table with execution status tracking
  - Step detail drill-down panel
  - Workflows section in dashboard sidebar under Operations
- E2E workflow test with Docker worker integration
- Database migration system with numbered `.sql` files and incremental runner (#133)
- Lightweight code-level heartbeat module for swarm triage without spinning up Claude sessions (#124)
  - 3-tier approach: preflight gate, code-level triage, Claude escalation
  - Auto-assignment of pool tasks to idle workers
  - Stall detection for in-progress tasks
  - Worker health status correction
  - Configurable via `HEARTBEAT_*` environment variables

### Changed
- Migrated inline `try { ALTER TABLE } catch {}` schema blocks to `src/be/migrations/` folder

### Fixed
- `property-match` workflow node crash when config uses flat format (`property`/`operator`/`value`) instead of `conditions` array (#146)
- API migration Dockerfile fix for workflow schema

## [1.43.0] - 2026-03-12

### Added
- Slack thread follow-up routing — @mentions in threads route directly to the worker already active in that thread, bypassing lead delegation
- Additive Slack buffer (`ADDITIVE_SLACK=true`) — non-mention thread replies are debounced and batched into a single follow-up task with dependency chaining
- `!now` command for instant buffer flush without dependency chaining
- `HEURISTICS.md` documenting all Slack routing rules and buffering behavior
- `reactions:write` Slack scope for visual buffer feedback (:eyes:, :heavy_plus_sign:, :zap:)

### Changed
- Eliminated inbox message system — all Slack and AgentMail messages now route directly as tasks
- Leads poll for tasks like workers (removed poll-task lead block)
- Child tasks auto-inherit Slack/AgentMail metadata from parent tasks
- Removed `inbox-delegate` and `get-inbox-message` MCP tools
- Removed fuzzy name matching from Slack router (replaced by task-based routing)

### Fixed
- AgentMail sender domain filter now correctly handles "Name \<email\>" format

## [1.36.0] - 2026-03-06

### Added
- One-time (delayed) scheduled tasks alongside recurring schedules
  - New `scheduleType` field: `recurring` (default) or `one_time`
  - `create-schedule` accepts `delayMs` (relative delay) or `runAt` (absolute ISO datetime) for one-time schedules
  - One-time schedules auto-disable after execution
  - `list-schedules` hides completed one-time schedules by default (`hideCompleted`)
  - UI shows type badges (amber=one-time, emerald=recurring)
- AgentMail webhook domain filters: `AGENTMAIL_INBOX_DOMAIN_FILTER` and `AGENTMAIL_SENDER_DOMAIN_FILTER` env vars to filter incoming webhooks by inbox and sender domain

### Changed
- Docker worker improvements: streamlined `Dockerfile.worker` and `docker-entrypoint.sh`

## [1.35.2] - 2026-03-05

### Fixed
- Avoid duplicate heartbeat triage task creation for the same stalled task set
- Run stale heartbeat resource cleanup even when preflight triage gate bails

## [1.35.1] - 2026-03-05

### Fixed
- Use unique port variables per service in `docker-compose.example.yml` to avoid conflicts (#137)
- Clarified that port variables are examples and that isolated network namespaces can share ports

### Changed
- Added internal cross-links across docs pages and blog/examples navigation (#135)
- Added canonical URLs and JSON-LD structured data to docs pages

## [1.34.0] - 2026-03-04

### Added
- Task cost tracking and display in task details page (#131)
- Schedule and epic HTTP API endpoints for CRUD operations
- Exhaustive HTTP API integration test suite (#132)
- `claude-context-mode` as default context management plugin for workers (#125)
- Base prompt test coverage

### Changed
- Refactored monolithic `src/http.ts` into modular route handlers under `src/http/` (#132)
- Abstracted route matching into `matchRoute` utility with dedicated tests
- Converted handler dispatch to registry-based for-loop pattern
- Improved system prompt assembly in `base-prompt.ts`

### Fixed
- Context-mode marketplace plugin ID in install command (#130)
- Lint warnings and type errors across HTTP route handlers

## [1.32.0] - 2026-03-03

### Added
- Model control per task, schedule, and global override — `model` parameter (`haiku`/`sonnet`/`opus`) on `send-task`, `task-action`, `create-schedule`, and `update-schedule` (#127)
- Schedule-to-task linking via `scheduleId` — tasks created by schedules have a direct back-reference and `get-tasks` supports filtering by `scheduleId` (#127)
- Multi-credential support — `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` accept comma-separated values for load balancing across subscriptions (#119)
- `ANTHROPIC_API_KEY` as alternative credential to `CLAUDE_CODE_OAUTH_TOKEN`
- x402 payments guide page and environment variables reference in documentation site

## [1.31.0] - 2026-02-28

### Added
- x402 payment capability for agents — automatic USDC micropayments for x402-gated APIs (#108)
- Dual signer support: Openfort (managed wallet in TEE) and viem (raw private key)
- Openfort backend wallet signer with v-value normalization for USDC settlement
- x402 CLI for testing payments (`check`, `fetch`, `status` commands)
- Spending tracker with per-request and daily limits
- Real testnet E2E tests with x402.org facilitator on Base Sepolia
- Landing site: x402 example page, blog section with Openfort hackathon post and swarm metrics post

### Fixed
- Openfort signature v-value normalization (v=0/1 to v=27/28) for on-chain USDC settlement
- Network chain passthrough to Openfort signer (was hardcoded to baseSepolia)

## [1.30.1] - 2026-02-28

### Added
- Agent `lastActivityAt` timestamp for stall detection (#105)
- Slack attachment handling — voice memos, images, and file uploads are now processed as messages (#103)
- `includeHeartbeat` filter for `get-tasks` — heartbeat/system tasks are excluded by default (#102)
- Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) on all 36 MCP tools for improved Tool Search discoverability (#95)

### Changed
- Pinned Dockerfile builder to `bun:1.3.9` for reproducible builds
- Dockerfile improvements: `pipefail`, consolidated `RUN` layers, `--no-install-recommends` for Node.js and GitHub CLI
- Removed `cc-ai-tracker` from worker image agent tools
- README optimized for GitHub star conversion: badges, hero, issue/PR templates (#104)

## [1.28.1] - 2026-02-27

### Added
- Fumadocs documentation site at docs.agent-swarm.dev (18 pages across architecture, concepts, guides, and reference sections)
- Agent-swarm.dev landing page
- Agent artifacts feature via localtunnel — SDK, CLI command, `/artifacts` skill, and Docker support
- Depot build system for Docker images
- Slack offline message queuing — @mentions when no agents are online are now queued as tasks
- `AGENTMAIL_DISABLE` env var to skip AgentMail integration

### Changed
- Server-side aggregation for usage pages (performance improvement)
- Removed old `ui/` directory in favor of `new-ui/`

### Fixed
- Usage pages performance issues (5 review fixes: full table scan, SQL parameterization, useMemo deps, groupBy validation, test coverage)
- CI path filtering to skip workflows for docs-site and landing directory changes

## [1.28.0] - 2026-02-17

### Added
- New dashboard UI ("Mission Control" theme) with AG Grid, command palette, and dark mode
  - Phase 1-6: project scaffolding, app shell, config page, agents/tasks/epics pages, chat/schedules/usage pages, polish
- Comprehensive env vars reference and agent configuration docs
- Active sessions table for lead concurrency tracking
- Concurrent context endpoint for lead session awareness
- Task deduplication guard to prevent concurrent lead duplicates
- Workers wake on in-app chat @mentions
- Delete-channel MCP tool (lead-only)

### Changed
- README and docs cleaned up for public launch
- Polished env examples and DEPLOYMENT.md

### Fixed
- New UI: CSS vars instead of hardcoded oklch in charts
- New UI: swapped theme and sidebar active state
- New UI: stale config dialog, chat URL params; removed dead code
- Zombie task revival — prevent completed tasks from being revived
- Task pool claiming made atomic to prevent race conditions

## [1.25.0] - 2026-02-07

### Added
- Agent self-improvement mechanisms (7 proposals implemented)
- Follow-up task creation for lead on worker task completion
- `/internal/reload-config` endpoint and config loader extraction
- Session error tracking with meaningful error reporting for failed worker sessions

### Fixed
- Graceful fallback when session resume fails with stale session ID
- Lead task completion polling prioritization and increased concurrency
- Slack initialized flag reset on stop
- AgentMail `from_` type fix

## [1.21.0] - 2026-01-28

### Added
- MCP tools for swarm config management and server config injection
- AgentMail webhook support
- Persistent memory system with vector search
- Centralized repo management
- Persistent setup scripts and TOOLS.md for agents
- Soul/identity editors in UI profile modal
- Session attachment with `--resume` logic in runner for session continuity

### Fixed
- Permanent notification loss from mark-before-process race
- 404 handling in task finalization
- Config upsert with NULL scopeId for global config

## [1.16.3] - 2026-01-14

### Added
- Epics feature for project-level task organization
- Lead-only authorization for epic tools
- Slack user filtering by email domain and user ID whitelist
- Scheduled tasks feature (cron-based recurring task automation)

### Fixed
- Task totals to show absolute counts

## [1.15.8] - 2026-01-07

_Initial tracked version. Earlier changes are not included in this changelog._
