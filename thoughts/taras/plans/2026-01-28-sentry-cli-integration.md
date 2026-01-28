---
date: 2026-01-28T15:30:00+00:00
author: Claude
git_commit: 1699caad0908ad26de3fc72c19600ce6789f27e3
branch: main
repository: agent-swarm
topic: "Sentry CLI Integration for Agent Workers"
tags: [plan, sentry, cli, workers, monitoring, debugging]
status: implemented
based_on: thoughts/taras/research/2026-01-28-sentry-cli-integration.md
---

# Sentry CLI Integration Implementation Plan

## Overview

Add `sentry-cli` to the Docker worker image so agents can investigate and triage Sentry issues. Workers will use the CLI directly through bash commands, leveraging environment variables `SENTRY_AUTH_TOKEN` and `SENTRY_ORG` that are already configured in the deployment.

This enables agents to:
1. Receive Sentry issue links from Slack alerts and investigate them
2. Query issue details, events, and stacktraces
3. Manage issues (resolve, mute, unresolve)

## Current State Analysis

**What exists now:**
- Workers have a comprehensive dev environment in `Dockerfile.worker:21-117`
- Environment variables are passed through `docker-entrypoint.sh`
- Tools like `gh` CLI already demonstrate the pattern of env-based auth (`docker-entrypoint.sh:121-142`)
- Slack integration routes messages to agents (`src/slack/handlers.ts:266-434`)
- `SENTRY_AUTH_TOKEN` and `SENTRY_ORG` are available in the deployment environment

**What's missing:**
- `sentry-cli` is not installed in the worker image
- No documentation for agents on how to use Sentry CLI

### Key Discoveries:
- Tool installation pattern: `Dockerfile.worker:104-117` shows npm/pip global installs
- Environment auth pattern: `docker-entrypoint.sh:124-129` shows gh uses `GITHUB_TOKEN` env var automatically
- Agent commands live in: `plugin/commands/` directory
- sentry-cli automatically uses `SENTRY_AUTH_TOKEN` and `SENTRY_ORG` env vars (no explicit auth setup needed)

## Desired End State

Workers can investigate Sentry issues by running CLI commands like:
```bash
sentry-cli issues list --query "is:unresolved"
sentry-cli info  # Verify authentication
```

Verification:
1. Build the Docker image successfully
2. Container starts and `sentry-cli info` shows authenticated connection
3. Agents can query issues when given a Sentry alert

## Quick Verification Reference

Common commands to verify the implementation:
- Build image: `bun run docker:build:worker`
- Run worker: `bun run docker:run:worker` (requires `.env.docker` with Sentry vars added)
- Lint: `bun run lint:fix`

**Environment setup for testing**: Add to `.env.docker`:
```
SENTRY_AUTH_TOKEN=your-token-here
SENTRY_ORG=your-org-slug
```

Key files to check:
- `Dockerfile.worker` - Primary implementation
- `plugin/commands/investigate-sentry-issue.md` - Agent documentation (new)

## What We're NOT Doing

- **NOT creating an MCP tool** - Agents can use the CLI directly via bash
- **NOT building a Sentry webhook handler** - Slack integration already routes alerts to agents
- **NOT implementing full API coverage** - CLI + curl covers the use cases
- **NOT handling self-hosted Sentry** - Using cloud version only

## Implementation Approach

Minimal, focused changes following existing patterns:
1. Add `sentry-cli` installation to `Dockerfile.worker`
2. Create agent command documentation explaining Sentry CLI usage
3. No changes to entrypoint - sentry-cli auto-uses env vars

---

## Phase 1: Install sentry-cli in Docker Worker Image

### Overview
Add `@sentry/cli` to the Docker worker image using npm global install, following the same pattern as other tools.

### Changes Required:

#### 1. Dockerfile.worker
**File**: `Dockerfile.worker`
**Changes**: Add sentry-cli installation after the other npm global installs (around line 111)

Add after the wts installation (line 111):
```dockerfile
# Install sentry-cli for issue investigation
RUN npm install -g @sentry/cli
```

The exact insertion point should be between wts and qa-use installs for logical grouping of npm packages.

### Success Criteria:

#### Automated Verification:
- [x] Docker build succeeds: `bun run docker:build:worker`
- [x] sentry-cli is accessible: `docker run --rm agent-swarm-worker:latest sentry-cli --version` (v3.1.0)
- [x] Linting passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Add `SENTRY_AUTH_TOKEN` and `SENTRY_ORG` to `.env.docker`
- [ ] Run `bun run docker:run:worker`, then inside container: `sentry-cli info` - should show authenticated connection
- [ ] Image size increase is reasonable (sentry-cli is ~50MB)

**Implementation Note**: After completing this phase, pause for manual confirmation. The docker build and auth verification are critical before proceeding.

---

## Phase 2: Create Agent Command Documentation

### Overview
Create a command file that documents how agents should investigate Sentry issues. This follows the pattern of existing commands in `plugin/commands/`.

### Changes Required:

#### 1. Agent Command File
**File**: `plugin/commands/investigate-sentry-issue.md`
**Changes**: Create new file with Sentry investigation workflow

Content structure:
- Command purpose and when to use it
- Prerequisites (env vars already set)
- CLI commands for common operations:
  - `sentry-cli info` - verify auth
  - `sentry-cli issues list` - list/search issues
  - URL parsing from Slack alerts to extract issue IDs
  - curl commands for detailed event data (stacktraces)
- Example workflow for investigating an issue from a Slack alert

### Success Criteria:

#### Automated Verification:
- [x] File exists: `ls plugin/commands/investigate-sentry-issue.md`
- [x] No syntax errors (markdown linting if available)

#### Manual Verification:
- [x] Documentation is clear and follows the pattern of other command files
- [x] Contains all key CLI commands from the research document
- [x] Includes example of parsing Sentry URL from Slack message
- [x] Includes curl examples for getting full stacktraces

**Implementation Note**: After completing this phase, pause for manual confirmation. Review the documentation for completeness and clarity.

---

## Phase 3: End-to-End Verification

### Overview
Verify the complete integration works by building and testing with real Sentry credentials.

### Changes Required:

No code changes - this phase is verification only.

### Success Criteria:

#### Automated Verification:
- [x] Full Docker build succeeds: `bun run docker:build:worker`
- [x] Type check passes: `bun run tsc:check`

#### Manual Verification:
- [ ] Start container with `bun run docker:run:worker` and verify `sentry-cli info` works
- [ ] Test `sentry-cli issues list` returns results (if there are issues in Sentry)
- [ ] Verify the command documentation is accessible in the container at `/home/worker/.claude/commands/investigate-sentry-issue.md`

**Implementation Note**: After completing this phase, the feature is ready for deployment. Consider testing with a real Sentry alert via Slack.

---

## Testing Strategy

**Unit Tests**: Not applicable - this is infrastructure/documentation only

**Integration Tests**:
- Docker build verification
- sentry-cli authentication verification

**Manual Testing**:
1. Build worker image with sentry-cli
2. Run container with Sentry credentials
3. Verify CLI commands work
4. Optionally: Test with a real Sentry alert through Slack

## Risk Considerations

**Low Risk**:
- Adding a single npm package to an existing build process
- sentry-cli is a well-maintained Sentry official package
- No changes to runtime behavior or entrypoint

**Considerations**:
- Image size will increase by ~50MB (acceptable)
- If `SENTRY_AUTH_TOKEN` is not set, sentry-cli commands will fail gracefully with auth errors

## References
- Research document: `thoughts/taras/research/2026-01-28-sentry-cli-integration.md`
- Existing tool pattern: `Dockerfile.worker:104-117`
- Environment auth pattern: `docker-entrypoint.sh:121-142`
- Agent commands directory: `plugin/commands/`
