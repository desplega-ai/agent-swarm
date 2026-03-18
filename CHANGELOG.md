# Changelog

All notable changes to Agent Swarm are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Optional Slack metadata params (`slackChannelId`, `slackThreadTs`, `slackUserId`) on `send-task` tool for explicit Slack context propagation when delegating tasks (#190)
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
