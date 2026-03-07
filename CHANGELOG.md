# Changelog

All notable changes to Agent Swarm are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Database migration system with numbered `.sql` files and incremental runner (#133)
- Lightweight code-level heartbeat module for swarm triage without spinning up Claude sessions (#124)
  - 3-tier approach: preflight gate, code-level triage, Claude escalation
  - Auto-assignment of pool tasks to idle workers
  - Stall detection for in-progress tasks
  - Worker health status correction
  - Configurable via `HEARTBEAT_*` environment variables

### Changed
- Migrated inline `try { ALTER TABLE } catch {}` schema blocks to `src/be/migrations/` folder

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
