# Agent Swarm Tool Output Schema Alignment Implementation Plan

## Overview
Align the MCP tool `outputSchema` definitions with the actual `structuredContent` payloads so OpenCode no longer fails with "additional properties" errors when calling tools like `agent-swarm_get-swarm`.

## Current State Analysis
Many tools return `structuredContent` that includes `yourAgentId`, but their `outputSchema` only lists other keys (e.g., `agents`, `success`, `message`). The validator rejects those responses, causing the `McpError -32602` observed when calling `agent-swarm_get-swarm`. `my-agent-info` additionally returns `yourAgentInfo` while its schema only defines `agentId`.

## Desired End State
Every tool that embeds `yourAgentId` (and similar metadata) in `structuredContent` declares that key in its `outputSchema`, and `my-agent-info`’s schema matches the keys it actually returns. MCP requests succeed without schema validation issues.

### Key Discoveries:
- `src/tools/get-swarm.ts:16` defines `outputSchema` as `{ agents }`, yet `structuredContent` includes `yourAgentId` (and that key is also present in many other tools).
- `src/tools/my-agent-info.ts:13` expects `agentId`, but returns `yourAgentId` and `yourAgentInfo`, so both the schema and the response need to align.

## Quick Verification Reference

Common commands to verify the implementation:
- Type check: `bun run tsc:check`
- Lint and formatting: `bun run lint:fix`

Key files to review:
- `src/tools/get-swarm.ts` and other swarm/task tools
- `src/tools/my-agent-info.ts` and agent/profile utilities
- `src/tools/schedules/**/*.ts`

## What We're NOT Doing
- Changing the actual `structuredContent` values beyond schema alignment.
- Refactoring tool registration utilities or response helpers.
- Adding new functionality beyond schema alignment.

## Implementation Approach
For each tool that currently returns `yourAgentId` (and `yourAgentInfo` in `my-agent-info`), update `outputSchema` to include those keys with the appropriate types. Keep existing fields (e.g., `agents`, `success`, `message`) untouched to avoid breaking clients.

---

## Phase 1: Align Tool Schemas with Structured Responses

### Overview
Add `yourAgentId` (and `yourAgentInfo` where applicable) to the output schemas of swarm, task, messaging, channel, service, and schedule tools so their structured responses validate cleanly.

### Changes Required:

#### 1. Swarm/task/messaging tools
Update `outputSchema` in each of these files to include `yourAgentId`:
- `src/tools/get-swarm.ts`
- `src/tools/get-tasks.ts`
- `src/tools/get-task-details.ts`
- `src/tools/poll-task.ts`
- `src/tools/store-progress.ts`
- `src/tools/send-task.ts`
- `src/tools/task-action.ts`
- `src/tools/cancel-task.ts`
- `src/tools/read-messages.ts`
- `src/tools/get-inbox-message.ts`

#### 2. Agent registration/profile tools
- `src/tools/my-agent-info.ts`: extend the schema with `yourAgentId` and `yourAgentInfo` while keeping the existing `success`/`message` fields.
- `src/tools/join-swarm.ts`
- `src/tools/update-profile.ts`

#### 3. Channel and messaging utilities
- `src/tools/list-channels.ts`
- `src/tools/create-channel.ts`
- `src/tools/post-message.ts`

#### 4. Service registry tools
- `src/tools/register-service.ts`
- `src/tools/unregister-service.ts`
- `src/tools/list-services.ts`
- `src/tools/update-service-status.ts`

#### 5. Scheduler tools
- `src/tools/schedules/create-schedule.ts`
- `src/tools/schedules/update-schedule.ts`
- `src/tools/schedules/delete-schedule.ts`
- `src/tools/schedules/run-schedule-now.ts`
- `src/tools/schedules/list-schedules.ts`

### Success Criteria:

#### Automated Verification:
- [ ] Type check: `bun run tsc:check`
- [ ] Lint & format: `bun run lint:fix`

#### Manual Verification:
- [ ] Run `agent-swarm_get-swarm` via OpenCode and confirm there is no schema error.
- [ ] Run `agent-swarm_my-agent-info` via OpenCode and confirm the response validates.

**Implementation Note**: After these schema adjustments, pause for manual confirmation. No commits requested per your preference.

---

## Testing Strategy
Leverage `bun run tsc:check` and `bun run lint:fix` for automated coverage, and manually invoke the impacted tools through OpenCode to confirm the structured responses pass validation.

## References
- Planning template: `~/.claude/plugins/cache/desplega-ai-toolbox/desplega/1.4.0/skills/planning/template.md`
