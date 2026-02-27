# Changelog

All notable changes to Agent Swarm are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
