---
date: 2026-03-10T10:45:00-04:00
topic: "Configurable Event Prompts"
author: Claude
status: draft
research: thoughts/taras/research/2026-03-10-configurable-event-prompts.md
tags: [plan, events, prompts, github, gitlab, agentmail, configuration]
---

# Configurable Event Prompts — Implementation Plan

## Context

<!-- review-line-start(91417d89) -->
External event prompts (GitHub webhooks, GitLab webhooks, AgentMail) are hardcoded as inline template literals across ~25 templates in 3 handler files. Users cannot customize how events are described to agents without modifying source code. This plan makes those prompts configurable while preserving all existing handler logic (dedup, mention detection, reactions, VCS metadata).
<!-- review-line-end(91417d89): are you sure? -->

## Overview

Add an `event_prompt_templates` table that maps event types to customizable prompt templates with `{{path.to.value}}` interpolation. Handlers check for a custom template before falling back to their hardcoded default. This is **Approach A** from the research — chosen because it:

- Preserves all handler logic (dedup, reactions, VCS metadata, findLeadAgent routing)
- Has the simplest mental model ("event X uses template Y")
- Requires no workflow knowledge from users
- Supports per-agent overrides naturally
- Works independently of (and alongside) the workflow system

## Current State Analysis

### Handler Pattern (repeated 12x in GitHub, 8x in GitLab, 5x in AgentMail)

Each handler follows the same flow:
1. Trigger condition check (action type, mention, assignee)
2. Dedup check (`isDuplicate(eventKey)` — in-memory 60s TTL)
3. `findLeadAgent()` — find an available lead agent
4. **Build taskDescription** (inline template literal) — THIS is what we're making configurable
5. `createTaskExtended(taskDescription, { vcsMetadata... })` — create task with VCS metadata
6. Side effects: log, add reaction (eyes emoji via GitHub/GitLab API)

### Key Discoveries:
- `findLeadAgent()` is duplicated 3x across handlers with slightly different logic (`src/github/handlers.ts:62`, `src/gitlab/handlers.ts:45`, `src/agentmail/handlers.ts:65`)
- Workflow `create-task` node does NOT support VCS metadata (`src/workflows/nodes/create-task.ts:22-29`) — confirms Approach B would lose metadata
- `interpolate()` already exists in `src/workflows/template.ts` — reusable for template rendering
- Event data is already structured in `src/http/webhooks.ts:134-179` (event bus emissions) — defines what variables are available per event type
- `DELEGATION_INSTRUCTION` differs between GitHub and GitLab (`src/github/handlers.ts:19`, `src/gitlab/handlers.ts:33`) — likely unintentional

## Desired End State

- Users can override any event prompt via MCP tools (`set-event-prompt-template`, `list-event-prompt-templates`, etc.)
- Templates use `{{path.to.value}}` syntax with event-specific context variables
- Per-agent overrides: a specific agent can have a different prompt for the same event type
- Hardcoded prompts remain as fallback defaults (never deleted, always available)
- All handler logic preserved: dedup, reactions, VCS metadata, lead routing
- `bun run tsc:check` and `bun test` pass

## Quick Verification Reference

Commands:
- `bun run tsc:check` — type check
- `bun run lint:fix` — lint + format
- `bun test` — unit tests

Key files:
- `src/be/migrations/NNN_event_prompt_templates.sql` — new migration
- `src/be/db.ts` — new DB functions
- `src/tools/event-prompt-templates.ts` — new MCP tools
- `src/github/handlers.ts` — template lookup integration
- `src/gitlab/handlers.ts` — template lookup integration
- `src/agentmail/handlers.ts` — template lookup integration

## What We're NOT Doing

- **Not making Slack prompts configurable** — Slack passes user message text, not system-generated prompts. Fundamentally different.
- **Not making `buildPromptForTrigger()` configurable** — Internal runner prompts (`src/commands/runner.ts:814-995`) are system-level, not user-facing events.
- **Not refactoring `findLeadAgent()` duplication** — Out of scope. Worth a separate cleanup PR.
- **Not solving the dual-path problem** — Workflows and handlers run independently today. If a user creates both a workflow AND a template for the same event, both fire. We'll document this clearly.
- **Not adding a UI** — MCP tools are sufficient for now.
- **Not extending workflow nodes with VCS metadata** — That's a separate enhancement for Approach B.

## Implementation Approach

1. **New migration** with `event_prompt_templates` table
2. **DB layer** with CRUD functions + template resolution (check agent-specific first, then global)
3. **Shared helper** `resolveEventTemplate()` that handlers call before building their inline prompt
4. **Handler integration** — each handler calls the helper; if a custom template exists, use it instead of the inline literal
5. **MCP tools** for users to manage templates
6. **Tests** for DB functions, template resolution, and handler integration

---

## Phase 1: Database Schema + Migration

### Overview
Create the `event_prompt_templates` table and DB layer functions.

### Changes Required:

#### 1. New Migration
**File**: `src/be/migrations/NNN_event_prompt_templates.sql` (next number after highest existing)
**Changes**:
```sql
CREATE TABLE IF NOT EXISTS event_prompt_templates (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('github', 'gitlab', 'agentmail')),
  eventType TEXT NOT NULL,
  template TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  agentId TEXT,
  description TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  lastUpdatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, eventType, agentId)
);
CREATE INDEX IF NOT EXISTS idx_event_prompt_templates_lookup
  ON event_prompt_templates(provider, eventType, enabled);
```

Note: `agentId` is nullable — NULL means "global template for this event type." The UNIQUE constraint on `(provider, eventType, agentId)` ensures one template per event type per agent (or one global).

#### 2. DB Layer Functions
**File**: `src/be/db.ts`
**Changes**: Add these functions:

- `getEventPromptTemplate(provider, eventType, agentId?)` — resolve template with fallback:
  1. Check for agent-specific template (if agentId provided)
  2. Fall back to global template (agentId IS NULL)
  3. Return null if no custom template exists
- `upsertEventPromptTemplate(data)` — create or update a template (upsert on UNIQUE constraint)
- `listEventPromptTemplates(filters?)` — list templates, filterable by provider
- `deleteEventPromptTemplate(id)` — delete a template

#### 3. TypeScript Types
**File**: `src/types.ts`
**Changes**: Add `EventPromptTemplate` interface and `EventPromptProvider` type.

### Success Criteria:

#### Automated Verification:
- [ ] Types compile: `bun run tsc:check`
- [ ] Migration runs on fresh DB: `rm agent-swarm-db.sqlite && bun run start:http` (verify table exists, then stop)
- [ ] Migration runs on existing DB: `bun run start:http` (verify no errors, then stop)

#### Manual Verification:
- [ ] Inspect the DB to confirm `event_prompt_templates` table and index exist
- [ ] Test DB functions manually via a quick script or REPL

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 2: Template Resolution Helper

### Overview
Create a shared utility that handlers call to resolve a custom template (or return null for the hardcoded default). Define the interpolation context schema per event type.

### Changes Required:

#### 1. Event Template Resolver
**File**: `src/events/template-resolver.ts` (new file)
**Changes**: Create a module with:

- `resolveEventTaskDescription(provider, eventType, eventData, agentId?)` — main entry point:
  1. Call `getEventPromptTemplate(provider, eventType, agentId)` from DB
  2. If no template found, return `null` (handler uses hardcoded default)
  3. If found, call `interpolate(template, contextForEvent(provider, eventType, eventData))`
  4. Return the interpolated string

- `buildInterpolationContext(provider, eventType, rawEventData)` — maps raw webhook payloads to a structured context object. Each event type has a defined set of available variables:

```typescript
// GitHub pull_request context example:
{
  pr: { number, title, body, url, head_branch, base_branch, author, merged, changed_files },
  repo: { full_name, url },
  sender: { login },
  action: string,
  delegation_instruction: string,  // always available as a convenience
  suggestions: string,             // always available
}
```

The context builder normalizes the raw webhook payload into a clean, documented structure. Template authors use `{{pr.title}}` not `{{pull_request.title}}`.

Reuse `interpolate()` from `src/workflows/template.ts`.

#### 2. Context Schema Documentation
**File**: `src/events/template-context.ts` (new file)
**Changes**: Define TypeScript interfaces for each event type's interpolation context. These serve as documentation and type-safety for context building.

### Success Criteria:

#### Automated Verification:
- [ ] Types compile: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Review the context schema covers all variables currently used in hardcoded templates

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 3: Integrate Into Handlers

### Overview
Modify each handler to check for a custom template before using the hardcoded default. This is a minimal change — a single function call + conditional at each task creation point.

### Changes Required:

#### 1. GitHub Handlers
**File**: `src/github/handlers.ts`
**Changes**: At each of the 12 task creation points, add:

```typescript
// Before the existing taskDescription line:
const customDescription = resolveEventTaskDescription(
  "github", "pull_request.assigned", { pr, sender, repository, installation }
);

// Replace hardcoded taskDescription with:
const taskDescription = customDescription ?? `[GitHub PR #${pr.number}] ...existing hardcoded template...`;
```

The pattern is identical for all 12 handlers — just the event type string and context data change.

Event types to define:
- `pull_request.assigned`
- `pull_request.review_requested`
- `pull_request.mention` (opened/edited with @mention)
- `pull_request.closed`
- `pull_request.synchronize`
- `issues.assigned`
- `issues.mention` (opened/edited with @mention)
- `comment.mention` (issue_comment or pr_review_comment with @mention)
- `pull_request_review.submitted`
- `check_run.failed`
- `check_suite.failed`
- `workflow_run.failed`

#### 2. GitLab Handlers
**File**: `src/gitlab/handlers.ts`
**Changes**: Same pattern for ~8 event types:
- `merge_request.opened`
- `merge_request.assigned`
- `merge_request.mention`
- `merge_request.comment_mention`
- `issue.assigned`
- `issue.mention`
- `issue.comment_mention`
- `pipeline.failed`

#### 3. AgentMail Handlers
**File**: `src/agentmail/handlers.ts`
**Changes**: Same pattern for 5 event types:
- `message.follow_up`
- `message.new_to_lead`
- `message.new_to_worker`
- `message.unmapped_inbox`
- `message.no_agent`

### Success Criteria:

#### Automated Verification:
- [ ] Types compile: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Existing tests pass: `bun test`

#### Manual Verification:
- [ ] With NO custom templates in DB: handlers behave identically to before (hardcoded defaults)
- [ ] With a custom template in DB: handler uses the custom prompt text
- [ ] VCS metadata, reactions, dedup all still work correctly

**Implementation Note**: After completing this phase, pause for manual confirmation. This is the highest-risk phase — test thoroughly.

---

## Phase 4: MCP Tools

### Overview
Add MCP tools for users to manage event prompt templates.

### Changes Required:

#### 1. Tool Definitions
**File**: `src/tools/event-prompt-templates.ts` (new file)
**Changes**: Register 4 MCP tools:

- **`set-event-prompt-template`** — Create or update a prompt template
  - Params: `provider`, `eventType`, `template`, `agentId?`, `description?`, `enabled?`
  - Returns: the created/updated template
  - Validates: provider is valid, eventType is a known type, template is non-empty

- **`list-event-prompt-templates`** — List all custom templates
  - Params: `provider?` (filter)
  - Returns: array of templates with metadata

- **`get-event-prompt-template`** — Get a specific template by provider + eventType
  - Params: `provider`, `eventType`, `agentId?`
  - Returns: the resolved template (with fallback info), plus available `{{}}` variables for that event type

- **`delete-event-prompt-template`** — Delete a custom template (revert to hardcoded default)
  - Params: `id`
  - Returns: confirmation

#### 2. Tool Registration
**File**: `src/tools/index.ts` (or wherever tools are registered — follow existing pattern)
**Changes**: Import and register the new tool file.

#### 3. Available Event Types Documentation
The `set-event-prompt-template` tool should include a helpful description listing all valid event types and their available `{{}}` variables, so agents know what they can customize.

### Success Criteria:

#### Automated Verification:
- [ ] Types compile: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Tools appear in MCP tool list

#### Manual Verification:
- [ ] Via MCP: `set-event-prompt-template` creates a template
- [ ] Via MCP: `list-event-prompt-templates` shows it
- [ ] Via MCP: `get-event-prompt-template` resolves it
- [ ] Via MCP: `delete-event-prompt-template` removes it
- [ ] After setting a template, trigger the corresponding webhook and verify the custom prompt is used

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 5: Tests

### Overview
Add unit tests for the new functionality.

### Changes Required:

#### 1. DB Function Tests
**File**: `src/tests/event-prompt-templates.test.ts` (new file)
**Changes**:
- Test `upsertEventPromptTemplate` creates and updates
- Test `getEventPromptTemplate` resolution order (agent-specific > global > null)
- Test `listEventPromptTemplates` with filters
- Test `deleteEventPromptTemplate`
- Test UNIQUE constraint on (provider, eventType, agentId)

#### 2. Template Resolution Tests
**File**: `src/tests/event-template-resolver.test.ts` (new file)
**Changes**:
- Test `resolveEventTaskDescription` returns null when no template exists
- Test it returns interpolated string when template exists
- Test agent-specific override takes precedence over global
- Test disabled templates are skipped
- Test `buildInterpolationContext` produces correct structure for each provider

#### 3. Integration Test
**File**: `src/tests/event-prompt-integration.test.ts` (new file)
**Changes**:
- Test end-to-end: set a template via DB, simulate a webhook handler call, verify the created task uses the custom prompt
- Use isolated test DB (following existing test patterns with `initDb()`/`closeDb()` in `beforeAll`/`afterAll`)

### Success Criteria:

#### Automated Verification:
- [ ] All new tests pass: `bun test src/tests/event-prompt-templates.test.ts src/tests/event-template-resolver.test.ts src/tests/event-prompt-integration.test.ts`
- [ ] All existing tests still pass: `bun test`
- [ ] Types compile: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Review test coverage — are edge cases covered?

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Manual E2E Verification

After all phases pass, verify the full flow:

```bash
# 1. Start the server
bun run start:http

# 2. Initialize an MCP session (see CLAUDE.md for full handshake)
# ... (initialize + initialized notification)

# 3. List templates (should be empty)
# MCP tool call: list-event-prompt-templates

# 4. Set a custom template for GitHub PR assigned events
# MCP tool call: set-event-prompt-template
#   provider: "github"
#   eventType: "pull_request.assigned"
#   template: "Custom PR: {{pr.title}}\nRepo: {{repo.full_name}}\nURL: {{pr.url}}\n\nPlease review."
#   description: "Simplified PR assigned prompt"

# 5. Verify it was saved
# MCP tool call: get-event-prompt-template provider="github" eventType="pull_request.assigned"

# 6. Trigger a GitHub webhook (PR assigned event) via curl
# (requires valid signature — use test setup or disable verification locally)

# 7. Check the created task via: GET /api/tasks?limit=1
#    → its description should use the custom template text

# 8. Delete the template
# MCP tool call: delete-event-prompt-template id="<template-id>"

# 9. Trigger the same webhook again
#    → should use hardcoded default

# 10. Verify no regressions: other event types still work with hardcoded defaults
```

## Testing Strategy

- **Unit tests**: DB functions, template resolution, interpolation context building
- **Integration tests**: Handler + template resolution with isolated test DB
- **Manual E2E**: Full webhook → task creation flow with custom template

## References

- Research: `thoughts/taras/research/2026-03-10-configurable-event-prompts.md`
- Interpolation engine: `src/workflows/template.ts` (reused)
- Handler files: `src/github/handlers.ts`, `src/gitlab/handlers.ts`, `src/agentmail/handlers.ts`
- Webhook routing: `src/http/webhooks.ts`
- Task creation: `src/be/db.ts:1736` (`createTaskExtended`)
- Config system (reference, not used): `src/be/db.ts:4890` (`upsertSwarmConfig`)
