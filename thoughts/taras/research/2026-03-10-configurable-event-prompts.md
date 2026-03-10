---
date: 2026-03-10T12:00:00-04:00
researcher: Claude
git_commit: 5447af8
branch: main
repository: agent-swarm
topic: "Configurable event prompts for GitHub, GitLab, Slack, and other external event sources"
tags: [research, codebase, events, prompts, github, gitlab, slack, configuration, workflows]
status: complete
autonomy: autopilot
last_updated: 2026-03-10
last_updated_by: Claude
---

# Research: Configurable Event Prompts

**Date**: 2026-03-10
**Researcher**: Claude
**Git Commit**: 5447af8
**Branch**: main

## Research Question

External event prompts (GitHub webhooks, GitLab webhooks, Slack messages, AgentMail) are hardcoded as inline template literals. What's the cleanest way to make them configurable? Options include workflows, a new DB table, or extending the existing config system.

## Summary

Agent-swarm currently has **~25 hardcoded prompt templates** spread across 3 event handler files (`src/github/handlers.ts`, `src/gitlab/handlers.ts`, `src/agentmail/handlers.ts`), plus 6 trigger-type prompts in `src/commands/runner.ts`. Slack (`src/slack/handlers.ts`) is structurally different — it passes through user message text with thread context, not system-generated prompts. Each handler builds a task description string inline using template literals and passes it to `createTaskExtended()`. There is no shared prompt template registry or interpolation layer — each handler owns its own formatting.

The codebase already has two systems that deal with configurable text: the **workflow engine** (DAG-based, with `{{path.to.value}}` interpolation in `create-task` and `delegate-to-agent` nodes) and the **scheduler** (stores a `taskTemplate` string in the DB). The **config system** (`swarm_config`) is a scoped key-value store used for operational settings, not prompt templates.

Three approaches are evaluated below: (A) a new `event_prompt_templates` table, (B) leveraging the existing workflow system, and (C) extending the config system. Each has different trade-offs around simplicity, flexibility, and user experience.

## Detailed Findings

### 1. Current State: Hardcoded Event Prompts

All prompts are inline template literals in handler files. They share a common structure but are not abstracted.

#### GitHub (`src/github/handlers.ts`) — 12 prompt templates

| Event | Action | Line | Template Pattern |
|-------|--------|------|-----------------|
| `pull_request` | assigned | 103 | `[GitHub PR #N] title` + metadata + body + delegation instruction |
| `pull_request` | review_requested | 183 | Same as assigned, "Review requested from" |
| `pull_request` | opened/edited (mention) | 342 | Same structure, uses `extractMentionContext()` |
| `pull_request` | closed | 261 | Emoji + status + merge info + related task hint |
| `pull_request` | synchronize | 298 | New commits notification + related task hint |
| `issues` | assigned | 397 | `[GitHub Issue #N] title` + metadata + delegation |
| `issues` | opened/edited (mention) | 475 | Same structure with mention context |
| `issue_comment` / `pr_review_comment` | created (mention) | 547 | Comment content + related task hint |
| `pull_request_review` | submitted | 653 | Review state emoji/label + reviewer + related task |
| `check_run` | completed (failure) | 767 | CI failure + output summary (500 chars) |
| `check_suite` | completed (failure) | 841 | CI suite failure notification |
| `workflow_run` | completed (failure) | 917 | Workflow failure + logs URL |

**Shared constants:**
- `DELEGATION_INSTRUCTION` (line 19): `"⚠️ As lead, DELEGATE this task to a worker agent - do not tackle it yourself."`
- `getCommandSuggestions()` (lines 25-38): Returns context-specific hints like `"💡 Suggested: /review-pr or /respond-github"`

#### GitLab (`src/gitlab/handlers.ts`) — Mirrors GitHub pattern

Same inline template style. Slightly different `DELEGATION_INSTRUCTION` wording (line 33-34): `"\n\n**Delegation instruction:** As the lead agent, analyze this and decide whether to handle it yourself or delegate to a worker agent."`

Events: MR opened, MR assigned, MR mention, MR comment mention, Issue assigned, Issue mention, Issue comment mention, Pipeline failed.

#### Slack (`src/slack/handlers.ts`) — No system prompts

Slack is different: prompts come from user message text, not hardcoded templates. The handler adds XML-tagged thread context:
- Lead agents get: `<new_message>...</new_message>\n\n<thread_history>...</thread_history>`
- Worker agents get: `<thread_context>...</thread_context>\n\n{taskDescription}`

#### AgentMail (`src/agentmail/handlers.ts`) — 5 templates

Simple `[AgentMail] New email received` / `Follow-up email in thread` with From/Subject/Inbox/Thread metadata. Includes: follow-up in thread (line 111), new email to lead inbox (line 137), new email to mapped worker (line 151), unmapped inbox to lead (line 172), and no agent available/unassigned (line 186).

### 2. Existing Systems That Handle Configurable Text

#### 2a. Workflow Engine (`src/workflows/`)

The workflow system already has:
- **Template interpolation**: `interpolate()` in `src/workflows/template.ts` using `{{path.to.value}}` syntax
- **Event triggers**: `trigger-github-event`, `trigger-gitlab-event`, `trigger-slack-message`, `trigger-email` — already matching the same events
- **Task creation nodes**: `create-task` and `delegate-to-agent` with configurable `template`/`taskTemplate` fields
- **Condition nodes**: `property-match`, `llm-classify`, `code-match` for branching logic

The webhook endpoint at `src/http/webhooks.ts:134-179` already emits raw GitHub/GitLab events to the `workflowEventBus`, enabling workflows to react to the same events as the hardcoded handlers.

**Key insight**: The system currently has **two parallel paths** for every webhook event:
1. The hardcoded handler creates a task with a hardcoded prompt
2. The event bus emits the raw event, which workflows can react to with custom prompts

#### 2b. Config System (`swarm_config`)

- Scoped key-value store: `global`, `agent`, `repo` scopes with hierarchical resolution (repo > agent > global)
- Currently used for operational settings like `MODEL_OVERRIDE`
- Schema at `src/be/migrations/001_initial.sql:246-258`
- No templating or interpolation — just raw string values

#### 2c. Scheduler

- Stores a `taskTemplate` string in the DB, uses it verbatim as task description
- No interpolation at execution time
- Simple but inflexible: the template can't reference dynamic event data

### 3. The Event Flow (Webhook → Task)

```
HTTP Request → src/http/webhooks.ts
  ├── Signature verification
  ├── Event routing by header/field
  │
  ├── Path 1: Hardcoded handler (src/github/handlers.ts)
  │   ├── Deduplication check (in-memory, 60s TTL)
  │   ├── Trigger conditions (action type, mention, assignee)
  │   ├── findLeadAgent()
  │   ├── Build taskDescription (inline template literal)
  │   ├── createTaskExtended(taskDescription, vcsMetadata)
  │   └── Add reaction (👀) via GitHub API
  │
  └── Path 2: Event bus (after handler returns)
      ├── workflowEventBus.emit("github.pull_request.opened", {...})
      ├── evaluateWorkflowTriggers() matches against workflow definitions
      └── startWorkflowExecution() for matched workflows
```

### 4. Approach Analysis

#### Approach A: New `event_prompt_templates` Table

A dedicated table mapping event types to prompt templates with interpolation.

```sql
CREATE TABLE event_prompt_templates (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('github', 'gitlab', 'slack', 'agentmail')),
  eventType TEXT NOT NULL,       -- e.g. 'pull_request.assigned', 'issues.opened'
  template TEXT NOT NULL,         -- prompt template with {{}} interpolation
  enabled INTEGER DEFAULT 1,
  priority INTEGER DEFAULT 50,   -- for ordering when multiple templates match
  agentId TEXT,                   -- optional: override for specific agent
  description TEXT,
  createdAt TEXT NOT NULL,
  lastUpdatedAt TEXT NOT NULL,
  UNIQUE(provider, eventType, agentId)
);
```

**How it would work:**
1. Handlers check for a matching template before using the hardcoded default
2. If found, interpolate `{{}}` tokens with event data (reuse `interpolate()` from workflows)
3. If not found, fall back to current hardcoded behavior

**Pros:**
- Simple mental model: "event X uses template Y"
- Easy to query, update, and manage via MCP tools (`set-event-template`, `get-event-template`)
- Per-agent overrides via the `agentId` column
- Clear migration path: hardcoded templates become the seed data / defaults
- Works independently of the workflow system — lower cognitive overhead for users

**Cons:**
- New table + new MCP tools + new migration
- No branching/conditions — same template for all instances of an event type
- Duplicates some workflow capability (the workflow system can already do this)
- Need to define the interpolation context schema per event type (what variables are available)

#### Approach B: Leverage Existing Workflow System

Instead of a new table, make the hardcoded handlers "opt-out-able" when a workflow exists for that event type.

**How it would work:**
1. Before creating a task in the hardcoded handler, check if any enabled workflow has a trigger matching this event type + action
2. If a matching workflow exists, **skip** the hardcoded task creation (the workflow will handle it via the event bus path)
3. If no workflow matches, proceed with the hardcoded default

This requires minimal code changes — just adding a guard check at the top of each handler.

**Pros:**
- Reuses existing infrastructure entirely — no new tables, no new tools
- More powerful than templates: workflows can branch, classify with LLM, delegate to specific agents
- Users already have `create-workflow` / `update-workflow` tools
- Consistent with the existing dual-path architecture

**Cons:**
- Higher cognitive overhead: users must understand the DAG workflow model to customize a prompt
- Workflows are overkill for simple prompt customization ("I just want to change the delegation instruction")
- Workflow definitions are JSON blobs — harder to edit than a simple template string
- Risk of confusing behavior if both paths fire (need careful dedup logic)
- The workflow trigger system currently doesn't check "does a handler already exist for this?" — adding this coupling is non-trivial

#### Approach C: Extend Config System

Use `swarm_config` to store prompt templates as config values with a naming convention.

**How it would work:**
1. Convention: `event.prompt.{provider}.{eventType}` keys (e.g., `event.prompt.github.pull_request.assigned`)
2. Handlers call `getResolvedConfig()` to look up the template, falling back to hardcoded defaults
3. Templates use `{{}}` interpolation with event data

**Pros:**
- No new tables — extends existing system
- Hierarchical resolution already works: global default → agent-specific override
- Existing tools (`set-config`, `get-config`) work out of the box
- Lightweight to implement

**Cons:**
- Config system wasn't designed for large text blobs (prompt templates)
- No `envPath` relevance for prompts — field is misleading
- `isSecret` flag doesn't make sense for prompts
- Key naming conventions can get unwieldy: `event.prompt.github.pull_request_review.submitted.changes_requested`
- No built-in validation that templates use valid interpolation tokens
- Scope resolution (repo > agent > global) may not map well to event prompts — what does "repo scope" mean for a prompt template?

### 5. Comparison Matrix

| Criteria | A: New Table | B: Workflows | C: Config System |
|----------|-------------|-------------|-----------------|
| Implementation effort | Medium | Low-Medium | Low |
| User complexity | Low | High | Medium |
| Flexibility | Medium | High | Low |
| Branching/conditions | No | Yes | No |
| Per-agent overrides | Yes | Yes (via filters) | Yes (scope) |
| New tools needed | Yes (2-4) | No | No |
| New migration | Yes | No | No |
| Prompt editing UX | Good | Poor (JSON DAG) | Acceptable |
| Fallback to defaults | Clean | Needs guard logic | Clean |
| Future extensibility | Medium | High | Low |

### 6. Existing Precedent: How Workflows Already Handle This

The workflow engine already has working examples of configurable event-driven prompts. A workflow that replaces the hardcoded PR review handler would look like:

```json
{
  "nodes": [
    {
      "id": "trigger",
      "type": "trigger-github-event",
      "config": {
        "matchEventType": "pull_request",
        "actions": ["review_requested"]
      }
    },
    {
      "id": "create-task",
      "type": "create-task",
      "config": {
        "template": "[PR Review] {{trigger.pull_request.title}}\n\nReviewer requested by {{trigger.sender.login}}\nRepo: {{trigger.repository.full_name}}\nURL: {{trigger.pull_request.html_url}}\n\nPlease review this PR carefully.",
        "tags": ["github", "pr-review"]
      }
    }
  ],
  "edges": [
    { "id": "e1", "source": "trigger", "sourcePort": "default", "target": "create-task" }
  ]
}
```

This is already possible today — the only missing piece is the guard in the hardcoded handler to skip when a workflow covers the event.

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/github/handlers.ts` | 19-20 | `DELEGATION_INSTRUCTION` constant |
| `src/github/handlers.ts` | 25-38 | `getCommandSuggestions()` helper |
| `src/github/handlers.ts` | 103 | PR assigned prompt template |
| `src/github/handlers.ts` | 183 | PR review_requested prompt template |
| `src/github/handlers.ts` | 261 | PR closed/merged prompt template |
| `src/github/handlers.ts` | 298 | PR synchronize prompt template |
| `src/github/handlers.ts` | 342 | PR mention prompt template |
| `src/github/handlers.ts` | 397 | Issue assigned prompt template |
| `src/github/handlers.ts` | 475 | Issue mention prompt template |
| `src/github/handlers.ts` | 547 | Comment mention prompt template |
| `src/github/handlers.ts` | 653 | PR review submitted prompt template |
| `src/github/handlers.ts` | 767 | Check run failed prompt template |
| `src/github/handlers.ts` | 841 | Check suite failed prompt template |
| `src/github/handlers.ts` | 917 | Workflow run failed prompt template |
| `src/gitlab/handlers.ts` | 33-34 | GitLab delegation instruction (different wording) |
| `src/gitlab/handlers.ts` | 94 | MR opened prompt template |
| `src/gitlab/handlers.ts` | 311 | Pipeline failed prompt template |
| `src/slack/handlers.ts` | 402-407 | XML-tagged thread context templates |
| `src/agentmail/handlers.ts` | 111,137,151,172 | AgentMail prompt templates |
| `src/workflows/template.ts` | 1 | `interpolate()` function — `{{path.to.value}}` engine |
| `src/workflows/nodes/create-task.ts` | 19 | Workflow task creation with template interpolation |
| `src/workflows/nodes/delegate-to-agent.ts` | 18 | Workflow delegation with template interpolation |
| `src/workflows/triggers.ts` | 5 | `evaluateWorkflowTriggers()` — event matching |
| `src/http/webhooks.ts` | 134-179 | Event bus emission (parallel path to hardcoded handlers) |
| `src/be/db.ts` | 1736-1819 | `createTaskExtended()` — central task creation |
| `src/be/db.ts` | 4890-4967 | `upsertSwarmConfig()` — config upsert |
| `src/be/db.ts` | 4982-5008 | `getResolvedConfig()` — hierarchical scope resolution |
| `src/scheduler/scheduler.ts` | 125 | Scheduler uses stored `taskTemplate` |
| `src/commands/runner.ts` | 814-995 | `buildPromptForTrigger()` — runner prompt builder |

## Architecture Documentation

### Current Dual-Path Architecture

Every webhook event currently produces two independent outputs:
1. A task with a hardcoded prompt (via the handler)
2. A raw event emission on the workflow event bus (via `webhooks.ts` after the handler returns)

This means if a user creates a workflow for `github.pull_request.review_requested`, they'll get **two** tasks: one from the hardcoded handler and one from the workflow. This is the key problem that any approach needs to solve.

### Interpolation Context Available Per Event Type

The workflow event bus already passes structured data from each webhook. The GitHub events include: `action`, `pull_request` (full PR object), `issue` (full issue object), `comment`, `review`, `check_run`, `check_suite`, `workflow_run`, `sender`, `repository`. These would serve as the interpolation context for any template approach.

## Historical Context (from thoughts/)

- `thoughts/taras/research/2026-03-06-workflow-engine-design.md` — The workflow engine was designed recently (March 6), which explains why the dual-path architecture exists but isn't fully integrated yet. The workflows were added as a parallel system alongside existing handlers.

## Open Questions

- Should the hardcoded handlers be entirely replaceable, or should custom templates only modify the prompt text while keeping the handler's trigger logic (dedup, mention detection, assignee checks)?
- For Approach B (workflows): should there be a UI for composing workflow definitions, or is the `create-workflow` MCP tool sufficient?
- Should Slack prompts be configurable too? They're fundamentally different (user-provided text, not system-generated prompts).
- What about the `DELEGATION_INSTRUCTION` and `getCommandSuggestions()` — should these be independently configurable, or always bundled with the main template?
- The GitHub and GitLab handlers have slightly different `DELEGATION_INSTRUCTION` wording — is this intentional?

## Review Errata

_Reviewed: 2026-03-10 by Claude_

### Critical

_(none)_

### Important

- [ ] **`buildPromptForTrigger()` not analyzed in Detailed Findings** — `src/commands/runner.ts:814-995` contains 6 hardcoded prompt templates for trigger types (`task_assigned`, `task_offered`, `unread_mentions`, `pool_tasks_available`, `epic_progress_changed`, `slack_inbox_message`). These are listed in Code References but not discussed. They represent another category of hardcoded prompts that may benefit from configurability — or may intentionally be internal-only. The research should take a position on whether these are in scope.
- [ ] **Comparison matrix missing "handler logic preservation" row** — The handlers do more than build prompts: dedup (in-memory 60s TTL), mention detection (`extractMentionContext()`), assignee checks (`isBotAssignee()`), reaction posting (👀 emoji), VCS metadata attachment, and `findLeadAgent()` routing. Each approach handles this differently: (A) preserves all handler logic, just swaps the template; (B) bypasses the handler entirely, losing dedup/reactions/VCS metadata unless the workflow reimplements them; (C) preserves all handler logic like (A). This is a critical differentiator not reflected in the matrix.
- [ ] **Approach B underestimates the "skip handler" complexity** — The document says "just adding a guard check at the top of each handler," but skipping the handler also skips dedup, mention detection, assignee checks, reaction posting, and VCS metadata on the created task. A workflow-created task wouldn't have `vcsProvider`, `vcsRepo`, `vcsNumber`, etc. populated unless the workflow nodes are extended to support VCS metadata. This significantly increases the implementation effort for Approach B.
- [ ] **GitLab section lacks detail parity with GitHub** — GitHub has a 12-row table with line numbers and template patterns. GitLab just has a one-line "Mirrors GitHub pattern" note and a bullet list of event names without line numbers. Should be given equal treatment since it has its own handler file with distinct prompt wording.

### Resolved

- [x] AgentMail template count corrected from 4 to 5 — auto-fixed (added 5th template: "no agent available" at line 186)
- [x] Summary prompt count and Slack characterization corrected — auto-fixed (changed "~20 across 4 files" to "~25 across 3 files" and clarified Slack is structurally different)
