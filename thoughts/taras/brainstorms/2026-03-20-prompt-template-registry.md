---
date: 2026-03-20T12:00:00-04:00
author: Taras & Claude
topic: "Prompt Template Registry for Agent Swarm Events"
tags: [brainstorm, prompts, templates, events, registry]
status: parked
exploration_type: idea
last_updated: 2026-03-20
last_updated_by: Claude
---

# Prompt Template Registry for Agent Swarm Events — Brainstorm

## Context

The agent swarm currently uses hardcoded prompt strings when creating tasks from various events (GitHub webhooks, Slack messages, new task creation, etc.). Taras wants to introduce a **template/prompt registry** that:

1. **Catalogs all events** in the system that produce prompts (task creation, PR review, issue triage, etc.)
2. **Exposes templates via API** so agents can define, modify, and disable them at runtime
3. **Supports variable interpolation** — each event type carries specific variables (e.g. `pr.number`, `sender.login`, `repo.full_name`) that templates can reference
4. **Replaces hardcoded prompts** with a central helper that resolves the appropriate template for a given event

This would make the system more configurable, allow different swarms to customize behavior without code changes, and make it easier to iterate on prompt quality.

### Current State (from codebase exploration)

Hardcoded prompts exist across **13 sources**:

| Source | File | What it produces |
|--------|------|-----------------|
| **System prompts** | `src/prompts/base-prompt.ts` | `BASE_PROMPT_LEAD`, `BASE_PROMPT_WORKER`, `BASE_PROMPT_FILESYSTEM`, etc. Assembled by `getBasePrompt()` |
| **GitHub** | `src/github/handlers.ts` | ~12 event types: PR assigned, review requested, review submitted, CI failed, issue assigned, mentions, etc. + delegation instructions + command suggestions |
| **GitLab** | `src/gitlab/handlers.ts` | MR, Issue, Comment, CI pipeline events (mirrors GitHub) + delegation instruction |
| **Slack** | `src/slack/handlers.ts` | Message extraction + thread context wrapping |
| **Slack Assistant** | `src/slack/assistant.ts` | Greeting, suggested prompts, offline message |
| **AgentMail** | `src/agentmail/handlers.ts` | Email-to-task (follow-up, mapped agent, unmapped inbox) |
| **Linear** | `src/linear/sync.ts` | Issue-to-task, follow-up messages |
| **Heartbeat** | `src/heartbeat/heartbeat.ts` | Triage/escalation tasks for stalled agents |
| **Task lifecycle** | `src/tools/store-progress.ts` | **Auto-created follow-up tasks for lead** on worker completion/failure + epic context instructions |
| **Task resumption** | `src/commands/runner.ts` | Resumption prompts ("continue from where you left off"), epic progress context injection |
| **Worker reminders** | `src/hooks/hook.ts` | Progress reminder: "Remember to call store-progress periodically..." |
| **Pi-mono reminders** | `src/providers/pi-mono-extension.ts` | Same progress reminder for pi-mono workers |
| **Docker entrypoint** | `docker-entrypoint.sh` | One-time agent-fs invitation task for lead |

**Common patterns found:**
- All use JS template literals with event data (`${pr.number}`, `${issue.title}`, etc.)
- Status-based emoji indicators (`✅`, `🔄`, `❌`, `🎉`)
- `DELEGATION_INSTRUCTION` constant injected into GitHub/GitLab tasks
- `getCommandSuggestions()` appends slash command hints based on event type
- Thread context wrapped in `<thread_context>...</thread_context>` tags
- Long text truncated to 500 chars
- Task completion/failure auto-generates lead follow-up tasks with hardcoded descriptions
- Progress reminders injected into worker sessions via hooks

## Exploration

### Q: Which sources are the highest priority pain points? Where does hardcoded-ness hurt most?
All of them — it's a universal problem. But there's a nuance: some things are always injected regardless (e.g. `DELEGATION_INSTRUCTION`, command suggestions), and those should remain but perhaps be configurable via a flag to override.

**Insights:** Two layers emerging: (1) the task description template itself (event-specific), and (2) "always-injected" fragments that are appended to many templates (cross-cutting concerns like delegation instructions). The system needs to handle both — possibly with a concept of "base fragments" + "event templates" that compose together, where either layer can be overridden.

### Q: Who is the primary consumer of the template API — humans, agents, or both?
Both. Humans configure templates via API/dashboard, and agents (especially lead) can also adjust them via MCP tools at runtime.

**Insights:** This means we need dual access paths: REST API endpoints for human/dashboard consumption, AND MCP tools so agents can programmatically manage templates. The existing `set-config`/`get-config` pattern is a good precedent. Also implies we need good defaults that work out-of-the-box — agents shouldn't _need_ to configure templates, but they _can_.

### Q: What templating syntax — simple interpolation, conditionals, or full engine?
Simple interpolation only (`{{variable}}`). Keep it dead simple, handle logic in code.

**Insights:** This is a great call. Simple `{{var}}` replacement means: no runtime template engine dependency, easy to validate templates, easy for agents to author. Any conditional logic (like "if PR is draft, add a note") stays in the handler code that _prepares_ the variables — the template just receives a flat set of resolved values. This also means the variable contract per event type is well-defined and documentable.

### Q: Should templates be scoped with an override hierarchy?
Full hierarchy: **global → per-repo → per-agent** (most specific wins).

**Insights:** This mirrors how config scoping already works in the swarm (global vs agent-level configs). The resolution order would be: check agent-level override → repo-level override → global default → hardcoded fallback. This means:
- The DB schema needs a `scope` concept (global, repo, agent) on template records
- Resolution logic needs to try the most specific scope first and fall back
- For repo scope, the identifier is probably `repo.full_name` (e.g. `desplega-ai/agent-swarm`)
- For agent scope, the identifier is the agent UUID
- A template can be "disabled" at any scope level (e.g. agent X opts out of CI failure notifications)

### Q: When a template is disabled, what happens to the event?
Three explicit states per template record: `"enabled"` | `"default_prompt_fallback"` | `"skip_event"`.

- **`enabled`** — use this custom template
- **`default_prompt_fallback`** — ignore this override, fall through to the built-in hardcoded prompt
- **`skip_event`** — don't create a task at all, silently drop the event

**Insights:** This is cleaner than a boolean. The three states map to clear behaviors and there's no ambiguity. It also means the resolution chain is: find the most specific template → check its state → if `enabled`, render it; if `default_prompt_fallback`, skip this scope and try the next one up; if `skip_event`, bail out entirely. The `skip_event` at any scope level acts as a hard stop — if an agent says "skip CI failures", that's final even if there's a global template for it.

### Q: Storage — dedicated table or reuse config?
Dedicated `prompt_templates` table with typed columns. This enables building specific UI for template management in the dashboard.

**Scope clarification (per Taras's follow-up):**

The `scope` + `scope_id` columns on the table define **who** this template applies to:

| scope | scope_id | Meaning |
|-------|----------|---------|
| `global` | `NULL` | Default for the entire swarm |
| `repo` | `"desplega-ai/agent-swarm"` | Override for a specific repository |
| `agent` | `"uuid-of-agent"` | Override for a specific agent |

**Resolution example** for event `github.pr.review_submitted` on repo `desplega-ai/agent-swarm` assigned to agent `abc-123`:

1. Look for `(event=github.pr.review_submitted, scope=agent, scope_id=abc-123)` → found? check state
2. Look for `(event=github.pr.review_submitted, scope=repo, scope_id=desplega-ai/agent-swarm)` → found? check state
3. Look for `(event=github.pr.review_submitted, scope=global, scope_id=NULL)` → found? check state
4. Fall through to hardcoded default in code

At each level, if state is `enabled` → use it. If `skip_event` → stop, no task. If `default_prompt_fallback` → skip this level, continue resolution.

**Insights:** This is essentially a cascading config system specifically for prompts. The dedicated table means we can add columns like `variables_schema` (documenting available vars), `description`, `created_by`, `updated_at` — things that make the dashboard UI richer. The scope hierarchy also means a lead agent could set repo-level templates for repos it manages.

### Q: Should system prompts (lead/worker base prompts) also live in this registry, or only event→task templates?
Everything in one registry. System prompts and event task templates all unified.

**Insights:** This is ambitious but clean — one place for all prompt management. The `source.entity.action` naming convention naturally extends:

**Event task templates:**
- `github.pull_request.assigned`
- `github.pull_request.review_submitted`
- `github.check_run.failed`
- `gitlab.merge_request.assigned`
- `slack.message.new`
- `agentmail.email.followup`
- `linear.issue.assigned`
- `heartbeat.escalation.stalled`

**System prompts:**
- `system.agent.role`
- `system.agent.lead`
- `system.agent.worker`
- `system.agent.filesystem`
- `system.agent.services`
- `system.agent.guidelines`

**Always-injected fragments:**
- `fragment.delegation_instruction`
- `fragment.command_suggestions.github_pr`
- `fragment.command_suggestions.github_issue`

This means `getBasePrompt()` would resolve system templates from the registry instead of hardcoded constants, and event handlers would resolve task description templates. Fragments can be referenced from templates or injected by the resolver.

### Q: How should fragments (sub-prompts) compose with final prompts?
Reference syntax (`{{@fragment.delegation_instruction}}`) — the template author controls placement. But this surfaced a bigger question: what exactly are the "final outputs" of this system?

**Taras's insight:** There are really two distinct concepts:
1. **Fragments / sub-prompts** — reusable building blocks (delegation instruction, command suggestions, filesystem rules, etc.)
2. **Final prompts** — the actual prompts sent in each context: the system prompt for a session, the task description for an event trigger

**Clarifying the two output contexts:**

**Context A: Session system prompt** (assembled by `getBasePrompt()`)
- Built from many fragments: `system.agent.role` + `system.agent.lead` + `system.agent.filesystem` + `system.agent.services` + ...
- The "final prompt" is the composition of multiple fragments with truncation/budgeting
- This is what goes into `--append-system-prompt`

**Context B: Event → task description** (created by each handler)
- A single template per event type (e.g. `github.pull_request.review_submitted`)
- May reference fragments inline: `{{@fragment.delegation_instruction}}`
- Variables filled from event data: `{{pr.number}}`, `{{sender.login}}`
- This is what goes into `task.description`

So the registry stores both fragments and "top-level" templates. A top-level template can reference fragments. The resolver's job is to: resolve scope → render variables → expand fragment references → return the final string.

**Insights:** This is actually a clean separation. The registry doesn't need a separate `type` column — instead, the naming convention distinguishes them: `fragment.*` entries are composable pieces, everything else (`github.*`, `system.*`, `slack.*`) is a top-level template. Top-level templates can embed `{{@fragment.name}}` references. The resolver recursively expands those before variable interpolation.

### Q: Should the system prompt assembly recipe itself be a template?
Yes — the composition is itself a template in the registry. And this collapses the "fragment" concept entirely: **any template can reference any other template**. No special fragment type needed.

**Naming refinement:** Instead of `{{@fragment.delegation_instruction}}`, use `{{@template[system.agent.lead]}}` — making it clear that we're including another template by its ID.

**Insights:** This is a recursive composition model:

```
system.session.lead (top-level)
├── {{@template[system.agent.role]}}        → "You are a {role} agent..."
├── {{@template[system.agent.lead]}}        → "As lead, you delegate..."
├── {{@template[system.agent.filesystem]}}  → "Workspace structure..."
└── {{@template[system.agent.services]}}    → "Available services..."
```

```
github.pull_request.review_submitted (top-level)
├── "{{review_state_emoji}} [GitHub PR #{{pr.number}} Review] {{review_state_label}}"
├── "Reviewer: {{sender.login}}"
├── {{@template[common.delegation_instruction]}}
└── {{@template[common.command_suggestions.github_pr]}}
```

**Key simplification:** There's only one entity — **templates**. Some templates are "leaf" (just text + variables), some are "composite" (reference other templates). The resolver handles recursive expansion with a depth limit to prevent cycles.

### Q: Should variable schemas be stored in the DB or defined in code?
In code, not DB. Define variable contracts as TypeScript constants/types, with a registry abstraction that each event handler implements.

**Insights:** This is the right call — variable definitions are tightly coupled to the code that produces them. The pattern would be:

```typescript
// src/prompts/registry.ts
interface EventTemplate {
  eventType: string;
  defaultTemplate: string;           // hardcoded fallback
  availableVariables: VariableDef[]; // documented contract
  resolveVariables(event: unknown): Record<string, string>; // extracts vars from event payload
}

// src/github/templates.ts
const githubPrReviewSubmitted: EventTemplate = {
  eventType: "github.pull_request.review_submitted",
  defaultTemplate: "{{review_emoji}} [GitHub PR #{{pr.number}} Review] {{review_label}}\n...",
  availableVariables: [
    { name: "pr.number", description: "Pull request number" },
    { name: "pr.title", description: "Pull request title" },
    { name: "sender.login", description: "GitHub username of reviewer" },
    { name: "review_state", description: "approved | changes_requested | commented" },
    // ...
  ],
  resolveVariables(event) {
    return { "pr.number": String(event.pull_request.number), ... };
  },
};
```

The registry abstraction collects all `EventTemplate` definitions and exposes them via API (so the UI can show available variables for each event type). But the DB only stores custom template bodies and overrides — the variable contracts live in code.

This also means the API can have a `GET /api/prompt-templates/events` endpoint that lists all registered event types with their available variables, powered by the code-defined registry.

### Q: Migration strategy — seed DB or start empty?
**Seed the DB with current prompts as read-only defaults.** Add an `is_default` boolean flag.

**Claude's recommendation (agreed by Taras):** Seeding is cleaner because:
1. Users see all existing prompts in the UI immediately — great for discoverability
2. The refactor is cleaner: event handlers don't need a "check DB, fallback to code" path, they _always_ read from the registry
3. Default templates are **read-only** (`is_default: true`) — users can't accidentally break them
4. To customize, the user **creates a new override** at global/repo/agent scope, which takes precedence

**The flow:**
- On startup/migration, the code-defined `EventTemplate.defaultTemplate` values get upserted into the DB as `scope=global, is_default=true, state=enabled`
- If a user wants to customize, they create a new record (same event_type, same or narrower scope, `is_default=false`)
- Resolution: find most specific non-default → then global non-default → then global default → then hardcoded fallback (safety net)
- If the codebase updates a default template (new version), the migration re-upserts it — since it's flagged `is_default`, it won't clobber user customizations
- The UI shows defaults grayed out / read-only, with a "Customize" button that clones it into an editable override

### Q: Should we version template edits for rollback capability?
Full audit log with a `prompt_template_history` table. Updates happen transactionally — insert into history, then update the live record, all in one transaction.

**Schema sketch:**

```sql
-- Live templates
CREATE TABLE prompt_templates (
  id TEXT PRIMARY KEY,         -- UUID
  event_type TEXT NOT NULL,    -- e.g. "github.pull_request.review_submitted"
  scope TEXT NOT NULL,         -- "global" | "repo" | "agent"
  scope_id TEXT,               -- NULL for global, repo name or agent UUID
  state TEXT NOT NULL DEFAULT 'enabled',  -- "enabled" | "default_prompt_fallback" | "skip_event"
  body TEXT NOT NULL,          -- the template text with {{vars}} and {{@template[...]}}
  is_default INTEGER NOT NULL DEFAULT 0,  -- 1 = seeded from code, read-only
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,             -- agent UUID or "system"
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(event_type, scope, scope_id)
);

-- Audit trail
CREATE TABLE prompt_template_history (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES prompt_templates(id),
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL,
  changed_by TEXT,             -- who made this change
  changed_at TEXT NOT NULL,
  change_reason TEXT           -- optional context
);
```

**Insights:** Transactional history means we can offer "rollback to version N" in the API/UI. The `changed_by` field tracks whether a human or an agent made the change. The `change_reason` field is optional but useful when agents explain why they modified a template.

## Synthesis

### Key Decisions

1. **Unified registry** — One `prompt_templates` table for everything: event→task descriptions, system prompts, and reusable building blocks. No separate "fragment" concept.

2. **Simple interpolation** — `{{variable}}` for data, `{{@template[event_type]}}` for embedding other templates. No conditionals/loops in templates; logic stays in handler code that prepares variables.

3. **Three-state control** — Each template record has `state: "enabled" | "default_prompt_fallback" | "skip_event"` — unambiguous behavior per scope level.

4. **Three-level scope hierarchy** — `global → repo → agent` (most specific wins). Resolution walks from agent → repo → global → code fallback.

5. **Seeded defaults** — Current hardcoded prompts are migrated into the DB as `is_default: true` (read-only) records. Users create overrides to customize.

6. **Full audit history** — Every edit logged to `prompt_template_history` in a transaction. Enables rollback and attribution (human vs agent).

7. **Variable contracts in code, not DB** — TypeScript `EventTemplate` interface defines available variables per event type. The resolver validates at runtime. API exposes them for UI autocomplete.

8. **Dual access** — REST API for dashboard/humans + MCP tools for agents. Same operations available to both.

### Open Questions (Resolved)

- ~~**Recursive depth limit**~~ → **Depth limit of 3 + self-reference prevention validated at API/core level** (both on create/update). Cycle detection at resolution time as a safety net.
- ~~**Budget/truncation for system prompts**~~ → **Caller / registry implementation handles this** — the resolver returns the full string, truncation logic stays in `getBasePrompt()` or equivalent caller.
- ~~**Template testing**~~ → **Yes — `POST /api/prompt-templates/preview` included** in the API surface.
- ~~**Bulk operations**~~ → **Not needed** — dropped from scope.
- ~~**UI editor**~~ → **Follow-up** — not in initial scope, can be added later.

### Constraints Identified

- **SQLite limitations** — No complex JSON queries. Template bodies are plain text, variable schemas live in code.
- **Migration safety** — Default templates are re-upserted on each startup (to pick up code changes), but must never overwrite user customizations.
- **Cycle prevention** — `{{@template[A]}}` referencing `{{@template[B]}}` referencing `{{@template[A]}}` must be caught and errored.
- **Performance** — Template resolution happens on every event. Must be fast — likely an in-memory cache with DB-change invalidation.
- **Backward compatibility** — Existing hardcoded prompts must produce identical output initially. The refactor should be invisible to end users until they customize.

### Core Requirements

1. **`prompt_templates` table** with columns: `id`, `event_type`, `scope`, `scope_id`, `state`, `body`, `is_default`, `version`, `created_by`, `created_at`, `updated_at`

2. **`prompt_template_history` table** with columns: `id`, `template_id`, `version`, `body`, `state`, `changed_by`, `changed_at`, `change_reason`

3. **TypeScript `EventTemplate` registry** — Each event handler registers its event type, default template body, available variables, and a `resolveVariables(event)` function

4. **Template resolver** — Given an event type + scope context (agent, repo): walks the scope chain, expands `{{@template[...]}}` references (with depth limit), substitutes `{{variables}}`, returns final string

5. **REST API endpoints:**
   - `GET /api/prompt-templates` — list all templates (filterable by event_type, scope)
   - `GET /api/prompt-templates/:id` — get single template with history
   - `POST /api/prompt-templates` — create override
   - `PUT /api/prompt-templates/:id` — update template (with audit)
   - `DELETE /api/prompt-templates/:id` — delete override (revert to default)
   - `GET /api/prompt-templates/events` — list all registered event types with available variables
   - `POST /api/prompt-templates/:id/rollback` — rollback to specific version
   - `POST /api/prompt-templates/preview` — dry-run render with sample data

6. **MCP tools:**
   - `list-prompt-templates` — list templates
   - `get-prompt-template` — get template details + variables
   - `set-prompt-template` — create/update override
   - `delete-prompt-template` — remove override
   - `preview-prompt-template` — render with sample data

7. **Migration:** Seed all current hardcoded prompts as `is_default: true, scope: global` on first run

8. **Refactor event handlers** to use `registry.resolve(eventType, variables, { agentId, repoName })` instead of inline template literals

### Event Type Taxonomy

```
# GitHub events
github.pull_request.assigned
github.pull_request.review_requested
github.pull_request.review_submitted
github.pull_request.closed
github.pull_request.synchronize
github.pull_request.mentioned
github.issue.assigned
github.issue.mentioned
github.comment.mentioned
github.check_run.failed
github.check_suite.failed
github.workflow_run.failed

# GitLab events
gitlab.merge_request.assigned
gitlab.issue.assigned
gitlab.comment.mentioned
gitlab.pipeline.failed

# Slack events
slack.message.new
slack.assistant.greeting
slack.assistant.suggested_prompts
slack.assistant.offline

# AgentMail events
agentmail.email.followup
agentmail.email.mapped
agentmail.email.unmapped
agentmail.email.no_lead

# Linear events
linear.issue.assigned
linear.issue.followup

# Heartbeat events
heartbeat.escalation.stalled

# System prompts
system.agent.role
system.agent.lead
system.agent.worker
system.agent.filesystem
system.agent.agent_fs
system.agent.self_awareness
system.agent.context_mode
system.agent.guidelines
system.agent.system
system.agent.services
system.agent.artifacts

# Composite session prompts
system.session.lead
system.session.worker

# Reusable building blocks
common.delegation_instruction
common.command_suggestions.github_pr
common.command_suggestions.github_issue
common.command_suggestions.github_comment
common.thread_context_wrapper

# Task lifecycle events
task.worker.completed            # Auto follow-up to lead on worker task completion
task.worker.failed               # Auto follow-up to lead on worker task failure
task.epic.context                # Epic progress/goal context injected into task
task.epic.completion_check       # Instructions to review output in epic context
task.resumption.with_progress    # "Continue from where you left off..."
task.resumption.no_progress      # "No progress was saved, start fresh..."

# Worker session prompts
worker.reminder.store_progress   # "Remember to call store-progress periodically..."

# Bootstrap / one-time tasks
bootstrap.agentfs.invitation     # Lead task to invite workers to agent-fs org
```

#### Wildcard Overrides

Templates support **wildcard scoping** via the `event_type` field. When resolving, the system tries exact match first, then progressively broader wildcards:

1. `github.pull_request.review_submitted` (exact)
2. `github.pull_request.*` (all PR events)
3. `github.*` (all GitHub events)

This allows overrides like: "for all GitHub PR events on this repo, prepend a custom instruction" without creating N separate overrides. Wildcards are only valid in the `event_type` field of override records (not defaults). Resolution order: **exact > narrower wildcard > broader wildcard > default**.

## Next Steps

- **Parked** — Brainstorm complete, ready for `/create-plan` when we pick this up
- Suggested next: `/desplega:create-plan` referencing this brainstorm doc as input
