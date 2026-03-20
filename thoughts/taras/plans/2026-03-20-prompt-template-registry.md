---
date: 2026-03-20
author: Claude
status: in-progress
autonomy: critical
branch: fet/template-registry
research: thoughts/taras/research/2026-03-20-prompt-template-registry.md
brainstorm: thoughts/taras/brainstorms/2026-03-20-prompt-template-registry.md
last_updated: 2026-03-20
last_updated_by: Claude
---

# Plan: Prompt Template Registry

## Overview

Replace ~70 hardcoded prompt strings across 13 source files with a centralized, scope-aware template registry. Templates are stored in SQLite, resolved via a three-tier scope chain (`agent > repo > global`), and managed through REST API + MCP tools. Existing prompts are seeded as read-only defaults; users/agents create overrides to customize.

## Current State

- **~70 hardcoded prompts** in JS template literals across `src/github/handlers.ts`, `src/gitlab/handlers.ts`, `src/slack/handlers.ts`, `src/agentmail/handlers.ts`, `src/linear/sync.ts`, `src/heartbeat/heartbeat.ts`, `src/tools/store-progress.ts`, `src/commands/runner.ts`, and `src/prompts/base-prompt.ts`
- **Three coexisting interpolation patterns**: `${var}` (JS literals), `{var}` (base-prompt `.replace()`), `{{var}}` (workflow engine)
- **Existing scope system**: `swarm_config` table with `global/agent/repo` scopes and `getResolvedConfig()` resolution — precedent for the template registry
- **Existing interpolation engine**: `interpolate()` in `src/workflows/template.ts` — `{{dot.path}}` with nested object traversal, unresolved → `""`, tracks unresolved tokens
- **No runtime customization**: Changing any prompt requires a code change and redeploy

## Desired End State

- Single `prompt_templates` table with scope-aware overrides
- All event→task descriptions and system prompt constants resolved from the registry
- Code-defined `header` (always-on essential event reference) + customizable `body` per template
- `{{@template[id]}}` recursive composition with depth limit and cycle detection
- REST API + MCP tools for CRUD, preview, version checkout
- Audit history table tracking every change
- Default templates seeded from code, read-only, re-upserted on startup

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Scope precedence | `agent > repo > global` | Agents are direct consumers; they should have final say on how they receive information |
| Template shape | Code-defined `header` + DB `body` | Header ensures essential event reference (e.g. PR number) is never lost even with custom templates |
| Interpolation engine | Wrap existing `interpolate()` from `src/workflows/template.ts` | Proven, tested, dot-path resolution already works |
| Unresolved handling | Replace with `""` (match existing engine) | Consistent with workflow interpolation; prevents `{{var}}` leaking into prompts |
| Template composition | `{{@template[event_type]}}` syntax | Any template can reference any other; no separate "fragment" type |
| Composition depth | Max 3 levels + cycle detection | Prevents infinite recursion; matches brainstorm recommendation |
| Three-state control | `enabled \| default_prompt_fallback \| skip_event` | Unambiguous per-scope behavior |
| Wildcard overrides | `github.pull_request.*`, `github.*` | Enables broad customization without N separate overrides |
| Seeding | Current prompts as `is_default: true` on startup | Discoverable in UI/API, no fallback-to-code path needed in handlers |
| Variable schemas | In code, not DB | Tightly coupled to handler code; exposed via API for UI autocomplete |
| Audit history | `prompt_template_history` table | Enables version checkout and attribution |

## Performance Strategy

Template resolution involves up to 3 DB queries per scope level (+ wildcard passes). For the initial implementation, this is acceptable — SQLite queries on indexed columns are sub-millisecond, and event handling is not latency-critical (webhook processing is async). No in-memory caching in Phase 1-5.

If performance becomes an issue (measurable via benchmarking), a follow-up can add:
- **In-memory cache** keyed by `(eventType, agentId, repoId)` with TTL or invalidation on upsert/delete
- The upsert/delete DB functions would call a `invalidateTemplateCache()` hook
- This is explicitly deferred — don't add caching until there's evidence it's needed

## Out of Scope

Per research review decisions:
- **Hook-injected messages** (progress reminders, cancellation blocks, goal reminders in `hook.ts`) — different delivery mechanism, don't benefit from runtime customization
- **Pi-mono extension prompts** (`pi-mono-extension.ts`) — mirrors hook.ts, not unifying through registry
- **Scheduled task templates** (`scheduled_tasks.taskTemplate`) — user/lead-defined, not system-defined
- **Memory content templates** (`store-progress.ts` memory strings) — tightly coupled to logic

## Scope of Work

**In scope (6 categories, ~50 templates):**
1. Event→task description templates (~30): GitHub, GitLab, AgentMail, Linear, heartbeat, store-progress follow-ups
2. System prompt constants (12): `BASE_PROMPT_ROLE` through `BASE_PROMPT_ARTIFACTS`
3. Reusable building blocks (~5): delegation instruction, command suggestions, thread context wrapper
4. Runner trigger prompts (7): task_assigned, task_offered, resume, epic progress, etc.
5. Composite session prompts (2): `system.session.lead`, `system.session.worker`
6. Slack assistant messages (4): greeting, suggested prompts, offline, channel context

---

## Phase 1: Database Schema, Types & CRUD

**Goal:** Create the storage foundation — migration, TypeScript types, and DB functions — with no behavior change.

### 1.1 Migration `013_prompt_templates.sql`

Create `src/be/migrations/013_prompt_templates.sql`:

```sql
CREATE TABLE IF NOT EXISTS prompt_templates (
    id TEXT PRIMARY KEY,
    eventType TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('global', 'agent', 'repo')),
    scopeId TEXT,
    state TEXT NOT NULL DEFAULT 'enabled' CHECK(state IN ('enabled', 'default_prompt_fallback', 'skip_event')),
    body TEXT NOT NULL,
    isDefault INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    createdBy TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    UNIQUE(eventType, scope, scopeId)
);

CREATE INDEX IF NOT EXISTS idx_prompt_templates_event_type ON prompt_templates(eventType);
CREATE INDEX IF NOT EXISTS idx_prompt_templates_scope ON prompt_templates(scope, scopeId);

CREATE TABLE IF NOT EXISTS prompt_template_history (
    id TEXT PRIMARY KEY,
    templateId TEXT NOT NULL,
    version INTEGER NOT NULL,
    body TEXT NOT NULL,
    state TEXT NOT NULL,
    changedBy TEXT,
    changedAt TEXT NOT NULL,
    changeReason TEXT
);

CREATE INDEX IF NOT EXISTS idx_prompt_template_history_template ON prompt_template_history(templateId);
```

**Deletion behavior:** No soft delete. Deleting an override hard-deletes from `prompt_templates` but **preserves** history rows in `prompt_template_history` (no `ON DELETE CASCADE` — history is orphaned but queryable for audit trail). The `isDefault: true` records cannot be deleted at all (guarded in code). Deleting a user override effectively reverts to the seeded default.

### 1.2 TypeScript Types

Add to `src/types.ts`:

```typescript
// Prompt template scopes (same values as config, different resolution order)
export const PromptTemplateScopeSchema = z.enum(["global", "agent", "repo"]);
export const PromptTemplateStateSchema = z.enum(["enabled", "default_prompt_fallback", "skip_event"]);

export const PromptTemplateSchema = z.object({
  id: z.string(),
  eventType: z.string(),
  scope: PromptTemplateScopeSchema,
  scopeId: z.string().nullable(),
  state: PromptTemplateStateSchema,
  body: z.string(),
  isDefault: z.boolean(),
  version: z.number(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PromptTemplate = z.infer<typeof PromptTemplateSchema>;

export const PromptTemplateHistorySchema = z.object({
  id: z.string(),
  templateId: z.string(),
  version: z.number(),
  body: z.string(),
  state: z.string(),
  changedBy: z.string().nullable(),
  changedAt: z.string(),
  changeReason: z.string().nullable(),
});
export type PromptTemplateHistory = z.infer<typeof PromptTemplateHistorySchema>;
```

### 1.3 DB CRUD Functions

Add to `src/be/db.ts` (following the config CRUD pattern):

- `rowToPromptTemplate(row)` — map SQLite row to `PromptTemplate` type (isDefault: int → bool)
- `getPromptTemplates(filters?)` — list with optional `eventType`, `scope`, `scopeId`, `isDefault` filters
- `getPromptTemplateById(id)` — single lookup by UUID
- `upsertPromptTemplate(data)` — manual NULL handling for `UNIQUE(eventType, scope, scopeId)` (same pattern as config), writes history entry in same transaction, bumps version on update. **Global override behavior:** when a user upserts at global scope and a seeded default occupies that slot, the upsert updates the existing record and flips `isDefault` from `true` to `false` (marking it as user-customized). The original body is preserved in the history table. Re-seeding (Phase 2.3) only updates records where `isDefault=true`, so user customizations are never overwritten.
- `deletePromptTemplate(id)` — delete by UUID, guard against deleting `isDefault: true` records. If a user-customized global record (`isDefault=false`) is deleted, seeding will re-create the default on next startup. This serves as a "reset to default" mechanism.
- `resetPromptTemplateToDefault(id)` — convenience function: looks up the `EventTemplateDefinition` from the code registry, replaces the record's body with `defaultBody`, sets `isDefault=true`, creates history entry with `changeReason: "Reset to default"`. Provides immediate revert without waiting for next startup.
- `getPromptTemplateHistory(templateId)` — list history entries ordered by version DESC
- `resolvePromptTemplate(eventType, agentId?, repoId?)` — scope chain resolution with exact-before-wildcard precedence:
  1. **Exact match pass** — try the exact eventType at each scope:
     - Check `(eventType, scope=agent, scopeId=agentId)` → if `enabled`, return; if `skip_event`, return `{ skip: true }`; if `default_prompt_fallback`, continue
     - Check `(eventType, scope=repo, scopeId=repoId)` → same logic
     - Check `(eventType, scope=global, scopeId=NULL)` → same logic
  2. **Wildcard pass** — if no exact match resolved, try progressively broader wildcards at each scope:
     - Try `github.pull_request.*` at agent → repo → global
     - Try `github.*` at agent → repo → global
  3. If nothing matched, return `null` (caller uses code-defined `defaultBody`)

  **Precedence rule:** Exact match at ANY scope always beats wildcard at ANY scope. An exact global match beats a wildcard agent match. Within the same match type (exact or wildcard), scope precedence is `agent > repo > global`.
- `checkoutPromptTemplate(id, targetVersion)` — find history entry at targetVersion, copy its body/state into the live record, bump version, create new history entry with `changeReason: "Checked out from version N"`. Works forward and backward through version history.

### 1.4 Unit Tests

Create `src/tests/prompt-templates-db.test.ts`:
- Test CRUD operations (create, read, update, delete)
- Test scope resolution order (`agent > repo > global`)
- Test three-state behavior (`enabled`, `default_prompt_fallback`, `skip_event`)
- Test `skip_event` at agent level stops resolution even if repo/global have templates
- Test `default_prompt_fallback` skips that scope and continues chain
- Test wildcard resolution (`github.pull_request.*` matches when exact not found)
- Test history creation on upsert
- Test checkout restores body/state from any target version (forward and backward)
- Test `isDefault: true` records can't be deleted (but `isDefault: false` can)
- Test global override: upsert at global scope flips `isDefault` from true to false, preserves original in history
- Test reset to default: `resetPromptTemplateToDefault()` restores code default body and sets `isDefault: true`
- Test delete + re-seed cycle: delete customized record → next seed recreates the default
- Test wildcard precedence: exact global match beats wildcard agent match
- Test NULL scopeId handling (same SQLite quirk as config)

### Success Criteria:

#### Automated Verification:
- [x] Migration applies cleanly on fresh DB: `rm -f agent-swarm-db.sqlite* && bun run start:http` (check for no errors, Ctrl+C)
- [x] Migration applies cleanly on existing DB: `bun run start:http` (check for no errors, Ctrl+C)
- [x] Types compile: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Unit tests pass: `bun test src/tests/prompt-templates-db.test.ts`

#### Manual Verification:
- [ ] Inspect `agent-swarm-db.sqlite` with `sqlite3` to confirm tables and indexes exist
- [ ] Verify `_migrations` table shows `013_prompt_templates` as applied

**Implementation Note**: Pause after this phase for review before proceeding to Phase 2.

---

## Phase 2: Template Resolver & Registry Core

**Goal:** Build the resolver that turns a stored template + variables into a final prompt string. This is the core engine that all handlers will call.

### 2.1 Event Template Interface

Create `src/prompts/registry.ts`:

```typescript
export interface EventTemplateDefinition {
  eventType: string;                              // e.g. "github.pull_request.review_submitted"
  header: string;                                 // Always-on prefix (code-defined, not overridable)
                                                  // Uses {{var}} interpolation for dynamic parts
  defaultBody: string;                            // Hardcoded fallback body
  variables: VariableDefinition[];                // Documented contract
  category: "event" | "system" | "common" | "task_lifecycle" | "session";
}

export interface VariableDefinition {
  name: string;                                   // e.g. "pr.number"
  description: string;                            // e.g. "Pull request number"
  example?: string;                               // e.g. "42"
}
```

The registry collects all `EventTemplateDefinition` instances:

```typescript
const templateDefinitions = new Map<string, EventTemplateDefinition>();

export function registerTemplate(def: EventTemplateDefinition): void { ... }
export function getTemplateDefinition(eventType: string): EventTemplateDefinition | undefined { ... }
export function getAllTemplateDefinitions(): EventTemplateDefinition[] { ... }
```

**Two-layer resolution model:**

The in-memory `Map` and the DB serve different purposes:

| Layer | What it stores | Mutability | Purpose |
|-------|---------------|------------|---------|
| **Code registry** (in-memory `Map`) | `header`, `defaultBody`, `variables`, `category` | Immutable at runtime (populated at module load) | Defines the contract: what variables exist, what the header is, what the fallback body is |
| **DB** (`prompt_templates` table) | `body`, `state`, `scope`, `scopeId` | Mutable via API/MCP | Stores overrides and seeded defaults |

**Resolution flow:**
1. Resolver calls `getTemplateDefinition(eventType)` → gets the code-defined `header` + `defaultBody` + `variables`
2. Resolver calls `resolvePromptTemplate(eventType, agentId, repoId)` → walks the DB scope chain to find the most specific override
3. If a DB override is found with `state: enabled` → use its `body` (replacing the code `defaultBody`)
4. If no override found (or all are `default_prompt_fallback`) → use the code `defaultBody`
5. The code `header` is **always** used — it cannot be overridden via DB

This means `getTemplateDefinition()` always returns the code-defined metadata (the "contract"), while DB overrides only replace the `body` content. The code defaults are the ultimate fallback — if the DB is empty or corrupted, the system still works with hardcoded prompts.

### 2.2 Template Resolver

Create `src/prompts/resolver.ts`:

```typescript
export interface ResolveOptions {
  agentId?: string;
  repoId?: string;
}

export interface ResolveResult {
  text: string;           // Final resolved text (header + body, interpolated)
  templateId?: string;    // Which DB template was used (null if hardcoded default)
  scope?: string;         // Which scope level matched
  skipped: boolean;       // true if skip_event was triggered
  unresolved: string[];   // Any {{var}} tokens that couldn't be resolved
}
```

`resolveTemplate(eventType, variables, options)`:

1. Look up `EventTemplateDefinition` from the in-memory registry → get `header` and `defaultBody`
2. Call `resolvePromptTemplate(eventType, agentId, repoId)` from DB → get template `body` (or null for default, or `{ skip: true }`)
3. If skipped, return `{ skipped: true, text: "" }`
4. Determine `body`: DB template body if found, otherwise `defaultBody` from code
5. **Expand `{{@template[id]}}` references** (recursive, max depth 3):
   - Regex: `/\{\{@template\[([^\]]+)\]\}\}/g`
   - For each match, recursively call `resolveTemplate(referencedId, variables, options)` with depth + 1
   - Track visited IDs for cycle detection — if cycle found, leave token as-is and log warning
   - If depth > 3, leave token as-is and log warning
6. Compose: `header + "\n\n" + body` (skip header join if header is empty)
7. Interpolate the **entire composed string** (header + body) using `interpolate()` from `src/workflows/template.ts` with the provided `variables` context. Both header and body use the same `{{var}}` syntax and the same variable context — the header's `{{pr.number}}` is resolved with the same variables as the body's `{{sender.login}}`.
8. Return `ResolveResult` with `unresolved` tokens from the interpolation

### 2.3 Template Seeding

Create `src/prompts/seed.ts`:

`seedDefaultTemplates()` — called from `initDb()` in `src/be/db.ts`, after `runMigrations(db)` completes. This ensures the tables exist before seeding. The call site is the same place where other post-migration initialization runs (e.g., compatibility guards, context version seeding).

Steps:
1. Iterate all registered `EventTemplateDefinition`s
2. For each, check if a `(eventType, scope=global, scopeId=NULL, isDefault=true)` record exists in DB
3. If not, insert with `isDefault: true, state: enabled, createdBy: "system"`
4. If it exists and `body` differs from `defaultBody` in code, update the body (re-upsert) — defaults track code changes
5. Never touch records where `isDefault: false` (user customizations)

### 2.4 Unit Tests

Create `src/tests/prompt-template-resolver.test.ts`:
- Test basic resolution: eventType + variables → interpolated string
- Test header + body composition
- Test `{{@template[id]}}` expansion (including nested references)
- Test depth limit (3 levels)
- Test cycle detection
- Test scope override: agent-level body replaces global default
- Test `skip_event` returns `{ skipped: true }`
- Test `default_prompt_fallback` falls through to next scope
- Test wildcard resolution in resolver context
- Test unresolved variable tracking
- Test seeding: fresh DB gets all defaults, re-seeding updates defaults without touching customizations

### Success Criteria:

#### Automated Verification:
- [x] Types compile: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Resolver tests pass: `bun test src/tests/prompt-template-resolver.test.ts`

#### Manual Verification:
- [ ] Start server, verify seeding happens on startup (check logs for seed count)
- [ ] Query DB to confirm default templates were inserted: `sqlite3 agent-swarm-db.sqlite "SELECT eventType, scope, isDefault FROM prompt_templates LIMIT 10"`

**Implementation Note**: Pause after this phase for review before proceeding to Phase 3.

---

## Phase 3: REST API + MCP Tools

**Goal:** Expose template management to humans (REST API) and agents (MCP tools).

### 3.1 REST API Endpoints

Create `src/http/prompt-templates.ts` following the `src/http/config.ts` pattern:

| Route | Method | Path | Description |
|-------|--------|------|-------------|
| `listTemplates` | GET | `/api/prompt-templates` | List all templates, filterable by `eventType`, `scope`, `scopeId`, `isDefault` |
| `getTemplateById` | GET | `/api/prompt-templates/{id}` | Get single template with its history |
| `getResolvedTemplate` | GET | `/api/prompt-templates/resolved` | Resolve a template for given `eventType` + `agentId` + `repoId` (shows what would be used) |
| `listEventTypes` | GET | `/api/prompt-templates/events` | List all registered event types with available variables (from code registry) |
| `previewTemplate` | POST | `/api/prompt-templates/preview` | Dry-run render: accept `eventType` + `body` + sample `variables`, return interpolated result |
| `upsertTemplate` | PUT | `/api/prompt-templates` | Create/update override (validate body, create history entry) |
| `deleteTemplate` | DELETE | `/api/prompt-templates/{id}` | Delete override (guard against deleting defaults) |
| `checkoutTemplate` | POST | `/api/prompt-templates/{id}/checkout` | Checkout a specific version (forward or backward) |
| `resetTemplate` | POST | `/api/prompt-templates/{id}/reset` | Reset a customized template back to its code-defined default |

**Route ordering** (specific before wildcard):
1. `/api/prompt-templates/resolved` (3-segment literal)
2. `/api/prompt-templates/events` (3-segment literal)
3. `/api/prompt-templates/preview` (3-segment literal)
4. `/api/prompt-templates/{id}/checkout` (4-segment with param)
5. `/api/prompt-templates/{id}/reset` (4-segment with param)
6. `/api/prompt-templates/{id}` (3-segment with param)
6. `/api/prompt-templates` (2-segment, GET list + PUT upsert + DELETE)

**Checkout mechanics:**
- `POST /api/prompt-templates/{id}/checkout` with body `{"version": N}` copies the `body` and `state` from history version N into the live record, bumps the version counter, and creates a new history entry with `changeReason: "Checked out from version N"`.
- Works in both directions — you can go back to version 2 from version 5, or forward to version 4 from version 2.
- To revert to the seeded default: simply `DELETE` the user override — the seeded `isDefault: true` record becomes the active template again.

Register in `src/http/index.ts` handler chain and add import to `scripts/generate-openapi.ts`.

### 3.2 MCP Tools

Create `src/tools/prompt-templates/` with one file per operation:

| Tool | File | Description | Annotations |
|------|------|-------------|-------------|
| `list-prompt-templates` | `list.ts` | List templates (filterable) | `readOnlyHint: true` |
| `get-prompt-template` | `get.ts` | Get template details + variables + history | `readOnlyHint: true` |
| `set-prompt-template` | `set.ts` | Create/update override | `idempotentHint: true` |
| `delete-prompt-template` | `delete.ts` | Remove override | `destructiveHint: true` |
| `preview-prompt-template` | `preview.ts` | Render with sample data | `readOnlyHint: true` |

Follow the config tool pattern: barrel `index.ts`, register in `src/server.ts`, guard on `requestInfo.agentId`, return both `content` (text) and `structuredContent`.

### 3.3 OpenAPI Spec

Run `bun run docs:openapi` to regenerate `openapi.json` with the new endpoints.

### Success Criteria:

#### Automated Verification:
- [ ] Types compile: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] All existing tests still pass: `bun test`
- [ ] OpenAPI spec generated: `bun run docs:openapi`

#### Manual Verification:
- [ ] Start server (`bun run start:http`), test endpoints with curl:
  - `curl -H "Authorization: Bearer 123123" http://localhost:3013/api/prompt-templates` → lists seeded defaults
  - `curl -H "Authorization: Bearer 123123" http://localhost:3013/api/prompt-templates/events` → lists event types with variables
  - `curl -X PUT -H "Authorization: Bearer 123123" -H "Content-Type: application/json" http://localhost:3013/api/prompt-templates -d '{"eventType":"github.pull_request.assigned","scope":"repo","scopeId":"test/repo","body":"Custom: PR #{{pr.number}} assigned"}'` → creates repo-scope override
  - `curl -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" http://localhost:3013/api/prompt-templates/preview -d '{"eventType":"github.pull_request.assigned","variables":{"pr.number":"42","pr.title":"Fix bug"}}'` → renders preview
- [ ] Test MCP tools via MCP session (see CLAUDE.md "MCP Tool Testing" section)

**Implementation Note**: Pause after this phase for review before proceeding to Phase 4.

---

## Phase 4: Refactor GitHub Event Handlers

**Goal:** Replace 12 hardcoded prompts in `src/github/handlers.ts` with registry resolution. This is the highest-impact refactor and validates the entire pipeline end-to-end.

### 4.1 Define GitHub Event Templates

Create `src/github/templates.ts`:

Register all 12 GitHub event types with their `EventTemplateDefinition`:

| Event Type | Header Pattern | Key Variables |
|------------|---------------|---------------|
| `github.pull_request.assigned` | `[GitHub PR #{{pr.number}}] {{pr.title}}` | `pr.*`, `sender.login`, `repository.full_name` |
| `github.pull_request.review_requested` | `[GitHub PR #{{pr.number}}] {{pr.title}}` | `pr.*`, `sender.login`, `requested_reviewer.login` |
| `github.pull_request.closed` | `{{status_emoji}} [GitHub PR #{{pr.number}}] {{status}}` | `pr.*`, `was_merged`, `merged_by_login` |
| `github.pull_request.synchronize` | `🔄 [GitHub PR #{{pr.number}}] New commits pushed` | `pr.*`, `existing_task_id` |
| `github.pull_request.mentioned` | `[GitHub PR #{{pr.number}}] {{pr.title}}` | `pr.*`, `mention_context` |
| `github.issue.assigned` | `[GitHub Issue #{{issue.number}}] {{issue.title}}` | `issue.*`, `sender.login` |
| `github.issue.mentioned` | `[GitHub Issue #{{issue.number}}] {{issue.title}}` | `issue.*`, `mention_context` |
| `github.comment.mentioned` | `[GitHub {{target_type}} #{{target_number}} Comment]` | `comment.*`, `target_type`, `existing_task_id` |
| `github.pull_request.review_submitted` | `{{review_emoji}} [GitHub PR #{{pr.number}} Review] {{review_label}}` | `review.*`, `sender.login` |
| `github.check_run.failed` | `{{conclusion_emoji}} [GitHub PR #{{pr_number}} CI] {{check_name}}` | `check_run.*`, `related_task_id` |
| `github.check_suite.failed` | `{{conclusion_emoji}} [GitHub PR #{{pr_number}} CI Suite] {{conclusion_label}}` | `check_suite.*`, `related_task_id` |
| `github.workflow_run.failed` | `{{conclusion_emoji}} [GitHub PR #{{pr_number}} Workflow] {{workflow_name}}` | `workflow_run.*`, `related_task_id` |

Also register common building blocks:
- `common.delegation_instruction` — `"⚠️ As lead, DELEGATE this task to a worker agent - do not tackle it yourself."`
- `common.command_suggestions.github_pr` — `"💡 Suggested: /review-pr or /respond-github"`
- `common.command_suggestions.github_issue` — `"💡 Suggested: /implement-issue or /respond-github"`
- `common.command_suggestions.github_comment` — PR variant vs issue variant

Each template's default body is extracted from the current handler code as-is to ensure byte-identical output.

### 4.2 Refactor Handlers

In `src/github/handlers.ts`:

**Multi-action dispatch:** `handlePullRequest()` is a single function with an `if/else` chain dispatching on `action` (assigned, review_requested, closed, synchronize). Each branch maps to a different `eventType`. The refactor keeps this dispatch structure — each branch calls `resolveTemplate()` with its own event type and variables. No structural change to the handler, only the prompt assembly within each branch.

1. Import `resolveTemplate` from `src/prompts/resolver.ts`
2. For each handler function (and each action branch within multi-action handlers):
   a. Prepare variables object from event data (the code that currently feeds `${...}` interpolation)
   b. Call `resolveTemplate(eventType, variables, { agentId: lead?.id, repoId: repository.full_name })`
   c. If `result.skipped`, return `{ created: false }` (event suppressed)
   d. Use `result.text` as the `taskDescription` passed to `createTaskExtended()`
3. Remove `DELEGATION_INSTRUCTION` constant, `getCommandSuggestions()` function, and `getReviewStateInfo()` / `getCheckConclusionInfo()` — these become variables or move to the template definitions
4. **Keep** the logic that determines _whether_ to create a task (deduplication, bot check, etc.) — only the prompt assembly changes

### 4.3 Backward Compatibility Test

Create `src/tests/prompt-template-github.test.ts`:
- For each of the 12 event types, verify that the resolved template produces **identical output** to the current hardcoded version
- Use snapshot-style testing: capture current output, then verify registry-resolved output matches
- Test skip_event: set an override with `state: "skip_event"` → verify handler returns `{ created: false }`
- Test custom override: set a custom body → verify it's used instead of default

### Success Criteria:

#### Automated Verification:
- [ ] Types compile: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Backward compat tests pass: `bun test src/tests/prompt-template-github.test.ts`
- [ ] All existing tests still pass: `bun test`

#### Manual Verification:
- [ ] Start server, create a test GitHub PR event via curl, verify the task description matches expected format
- [ ] Create a custom override via API, trigger same event, verify custom template is used
- [ ] Set `skip_event` override, trigger event, verify no task is created

**Implementation Note**: This is the riskiest phase — it touches the most-used event handlers. Pause for thorough review before proceeding.

---

## Phase 5: Refactor Remaining Event Handlers

**Goal:** Migrate all remaining event sources to the template registry.

### 5.1 GitLab Handlers (`src/gitlab/handlers.ts`)

Create `src/gitlab/templates.ts` with 4 event types:
- `gitlab.merge_request.assigned`
- `gitlab.issue.assigned`
- `gitlab.comment.mentioned`
- `gitlab.pipeline.failed`

**Note:** GitLab's `DELEGATION_INSTRUCTION` (line 33) uses different text from GitHub's. Unify to use `common.delegation_instruction` (or create `common.delegation_instruction.gitlab` if the difference is intentional).

### 5.2 AgentMail Handlers (`src/agentmail/handlers.ts`)

Create `src/agentmail/templates.ts` with 5 event types:
- `agentmail.email.followup`
- `agentmail.email.mapped_lead`
- `agentmail.email.mapped_worker`
- `agentmail.email.unmapped`
- `agentmail.email.no_agent`

### 5.3 Linear Sync (`src/linear/sync.ts`)

Create `src/linear/templates.ts` with 2 event types:
- `linear.issue.assigned`
- `linear.issue.followup`

### 5.4 Heartbeat (`src/heartbeat/heartbeat.ts`)

Register `heartbeat.escalation.stalled` template.

### 5.5 Store Progress Follow-ups (`src/tools/store-progress.ts`)

Register 2 task lifecycle templates:
- `task.worker.completed` — follow-up to lead on completion
- `task.worker.failed` — follow-up to lead on failure

### 5.6 Runner Trigger Prompts (`src/commands/runner.ts`)

Register 7 trigger prompt templates:
- `task.trigger.assigned`
- `task.trigger.offered`
- `task.trigger.unread_mentions`
- `task.trigger.pool_available`
- `task.trigger.epic_progress`
- `task.resumption.with_progress`
- `task.resumption.no_progress`

### 5.7 Slack Messages (`src/slack/handlers.ts`, `src/slack/assistant.ts`)

Register 4 Slack templates:
- `slack.assistant.greeting`
- `slack.assistant.suggested_prompts`
- `slack.assistant.offline`
- `slack.message.thread_context`

### 5.8 Backward Compatibility Tests

For each source, create or extend test files verifying identical output.

### Success Criteria:

#### Automated Verification:
- [ ] Types compile: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] All backward compat tests pass: `bun test`

#### Manual Verification:
- [ ] Verify GitLab delegation instruction is unified (or intentionally separate) with GitHub
- [ ] Test one handler from each source with a custom override via API
- [ ] Verify `skip_event` works across all sources

**Implementation Note**: This can be done incrementally — one source at a time. Each sub-section is independently committable.

---

## Phase 6: Refactor System Prompts (`base-prompt.ts`)

**Goal:** Replace the 12 hardcoded system prompt constants in `src/prompts/base-prompt.ts` with registry lookups.

### 6.1 Define System Prompt Templates

Register system prompt constants:
- `system.agent.role` — `{role}` and `{agentId}` placeholders (note: uses `{single-brace}` today, needs migration to `{{double-brace}}`)
- `system.agent.register`
- `system.agent.lead`
- `system.agent.worker`
- `system.agent.filesystem` — `{agentId}` placeholder
- `system.agent.agent_fs` — `{agentId}`, `{sharedOrgId}` placeholders
- `system.agent.self_awareness`
- `system.agent.context_mode`
- `system.agent.guidelines`
- `system.agent.system`
- `system.agent.services` — `{agentId}`, `{swarmUrl}` placeholders
- `system.agent.artifacts`

### 6.2 Composite Session Templates

Register 2 composite templates:
- `system.session.lead` — references `{{@template[system.agent.role]}}`, `{{@template[system.agent.register]}}`, `{{@template[system.agent.lead]}}`, `{{@template[system.agent.filesystem]}}`, etc.
- `system.session.worker` — same but with `system.agent.worker` instead of `system.agent.lead`

### 6.3 Refactor `getBasePrompt()`

The composite session templates (`system.session.lead` and `system.session.worker`) are the **single authoritative definition** of how the system prompt is assembled. They live in `src/prompts/session-templates.ts` — one file, one place for the meta-recipe.

**Composite template recipe (registered in code, stored in DB as default):**

```
system.session.lead:
  body: |
    {{@template[system.agent.role]}}

    {{@template[system.agent.register]}}
    {{@template[system.agent.lead]}}
    {{@template[system.agent.filesystem]}}
    {{@template[system.agent.self_awareness]}}
    {{@template[system.agent.context_mode]}}
    {{@template[system.agent.guidelines]}}
    {{@template[system.agent.system]}}

system.session.worker:
  body: |
    {{@template[system.agent.role]}}

    {{@template[system.agent.register]}}
    {{@template[system.agent.worker]}}
    {{@template[system.agent.filesystem]}}
    {{@template[system.agent.self_awareness]}}
    {{@template[system.agent.context_mode]}}
    {{@template[system.agent.guidelines]}}
    {{@template[system.agent.system]}}
```

Conditional sections (`system.agent.agent_fs`, `system.agent.services`, `system.agent.artifacts`) are **not** part of the composite template — they're appended by `getBasePrompt()` based on runtime conditions (env vars, capabilities). This keeps the composite template clean and the conditional logic in code.

**Refactor of `getBasePrompt()`:**

1. Resolve `system.session.lead` or `system.session.worker` (based on role) → this expands all `{{@template[...]}}` references and interpolates variables like `{{role}}`, `{{agentId}}`
2. The resolved string replaces the current concatenation of `BASE_PROMPT_*` constants
3. Conditional sections are still appended in code after the resolved composite template
4. Dynamic injected sections (identity block, repo CLAUDE.md, agent CLAUDE.md/TOOLS.md) remain as-is — they're not template content
5. The truncation/budgeting logic (`BOOTSTRAP_MAX_CHARS`, `BOOTSTRAP_TOTAL_MAX_CHARS`) stays in `getBasePrompt()` — the resolver returns full strings, truncation is the caller's responsibility

**Migration note:** The `{single-brace}` interpolation in base-prompt.ts needs to be converted to `{{double-brace}}` to use the standard interpolation engine. This is a one-time change when extracting the default templates.

### 6.4 Tests

Extend existing tests or create new ones to verify `getBasePrompt()` produces identical output with registry-resolved templates vs the old hardcoded constants.

### Success Criteria:

#### Automated Verification:
- [ ] Types compile: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] All tests pass: `bun test`

#### Manual Verification:
- [ ] Start a Docker worker, verify system prompt in logs matches expected format
- [ ] Create a system prompt override via API (e.g. customize `system.agent.guidelines`), restart worker, verify the override appears in the system prompt
- [ ] Verify truncation still works correctly with long CLAUDE.md content

**Implementation Note**: This is the most complex phase due to the truncation system and the interpolation syntax migration. Take extra care with backward compatibility.

---

## Manual E2E Verification

**Template resolution happens at task creation time** (inside event handlers), not at worker execution time. This means we can test ALL event types by simulating webhook payloads against the running API server — no Docker lead/worker needed.

After all phases are complete, run these commands against a running server to verify end-to-end:

```bash
# 1. Start fresh
rm -f agent-swarm-db.sqlite*
bun run start:http &

# 2. Verify seeding happened
curl -s -H "Authorization: Bearer 123123" \
  http://localhost:3013/api/prompt-templates | jq '.templates | length'
# Expected: ~50 templates (all seeded defaults)

# 3. List event types with variables
curl -s -H "Authorization: Bearer 123123" \
  http://localhost:3013/api/prompt-templates/events | jq '.[0]'
# Expected: { eventType, header, variables: [...], category }

# 4. Preview a template with sample data
curl -s -X POST -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  http://localhost:3013/api/prompt-templates/preview \
  -d '{"eventType":"github.pull_request.review_submitted","variables":{"pr.number":"42","pr.title":"Fix auth bug","sender.login":"reviewer1","review_emoji":"✅","review_label":"APPROVED","review.html_url":"https://github.com/test/repo/pull/42#pullrequestreview-1","repository.full_name":"test/repo"}}'
# Expected: Rendered template with all variables substituted

# 5. Create a custom override
curl -s -X PUT -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  http://localhost:3013/api/prompt-templates \
  -d '{"eventType":"github.pull_request.assigned","scope":"repo","scopeId":"test/repo","state":"enabled","body":"Custom PR template for {{pr.title}} (#{{pr.number}})\nAssigned by {{sender.login}}"}'
# Expected: 200 OK with created template

# 6. Verify override resolves correctly
curl -s -H "Authorization: Bearer 123123" \
  "http://localhost:3013/api/prompt-templates/resolved?eventType=github.pull_request.assigned&repoId=test/repo"
# Expected: The custom override (scope=repo)

# 7. Set skip_event for an agent
curl -s -X PUT -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  http://localhost:3013/api/prompt-templates \
  -d '{"eventType":"github.check_run.failed","scope":"agent","scopeId":"test-agent-uuid","state":"skip_event","body":""}'
# Expected: 200 OK

# 8. Verify skip resolves
curl -s -H "Authorization: Bearer 123123" \
  "http://localhost:3013/api/prompt-templates/resolved?eventType=github.check_run.failed&agentId=test-agent-uuid"
# Expected: { skipped: true }

# 9. Checkout a previous version
# (Get the template ID from step 5, then)
curl -s -X POST -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  "http://localhost:3013/api/prompt-templates/<template-id>/checkout" \
  -d '{"version": 1}'
# Expected: 200 OK with checked-out template

# 10. Cleanup
kill $(lsof -ti :3013)
```

### E2E: Test ALL event triggers via webhook simulation

Template resolution happens inside event handlers when they call `resolveTemplate()` before `createTaskExtended()`. To verify ALL event types produce correct task descriptions, simulate webhook payloads:

```bash
# Start server with fresh DB
rm -f agent-swarm-db.sqlite* && bun run start:http &

# For each event type, POST a simulated webhook payload and verify the created task:

# GitHub PR assigned
curl -s -X POST -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  http://localhost:3013/api/github/webhook \
  -d '{"action":"assigned","pull_request":{"number":1,"title":"Test PR",...},...}'

# Then check the created task:
curl -s -H "Authorization: Bearer 123123" \
  http://localhost:3013/api/tasks | jq '.tasks[-1].task'
# Expected: Header "[GitHub PR #1] Test PR" + body from template

# Repeat for each event type:
# - github.pull_request.review_requested
# - github.pull_request.closed (merged + not-merged variants)
# - github.pull_request.synchronize
# - github.pull_request.mentioned
# - github.issue.assigned
# - github.issue.mentioned
# - github.comment.mentioned
# - github.pull_request.review_submitted (approved + changes_requested + commented)
# - github.check_run.failed
# - github.check_suite.failed
# - github.workflow_run.failed
# - gitlab.merge_request.assigned
# - gitlab.issue.assigned
# - gitlab.comment.mentioned
# - gitlab.pipeline.failed
# - (AgentMail, Linear, heartbeat — via their respective API endpoints)

# For each: verify task.task contains the expected header + body format
# Compare against snapshot of pre-refactor output to ensure byte-identical results

kill $(lsof -ti :3013)
```

**Note:** The exact webhook payload shapes depend on the handler's type definitions in `src/github/types.ts`, `src/gitlab/types.ts`, etc. Build minimal valid payloads from those types.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Template produces different output than hardcoded version | Medium | High | Snapshot tests comparing before/after output for every event type |
| Circular `{{@template[...]}}` references | Low | Medium | Depth limit (3) + cycle detection + log warning |
| Performance regression on event handling | Low | Medium | Template resolution is a few DB queries + string ops; benchmark if needed |
| SQLite NULL quirk in UNIQUE constraint | Known | Medium | Same manual handling as config (tested pattern) |
| Migration breaks existing DBs | Low | High | `IF NOT EXISTS` on all CREATE statements; test with both fresh and existing DB |
| System prompt truncation breaks with registry | Medium | Medium | Keep truncation in `getBasePrompt()` caller; resolver returns full strings |

---

## File Manifest

### New Files
| File | Phase | Description |
|------|-------|-------------|
| `src/be/migrations/013_prompt_templates.sql` | 1 | Migration for both tables |
| `src/tests/prompt-templates-db.test.ts` | 1 | DB CRUD + scope resolution tests |
| `src/prompts/registry.ts` | 2 | EventTemplateDefinition interface + in-memory registry |
| `src/prompts/resolver.ts` | 2 | Template resolver (scope chain + interpolation + composition) |
| `src/prompts/seed.ts` | 2 | Default template seeding logic |
| `src/tests/prompt-template-resolver.test.ts` | 2 | Resolver unit tests |
| `src/http/prompt-templates.ts` | 3 | REST API endpoints |
| `src/tools/prompt-templates/index.ts` | 3 | MCP tool barrel |
| `src/tools/prompt-templates/list.ts` | 3 | List templates tool |
| `src/tools/prompt-templates/get.ts` | 3 | Get template tool |
| `src/tools/prompt-templates/set.ts` | 3 | Set/upsert template tool |
| `src/tools/prompt-templates/delete.ts` | 3 | Delete template tool |
| `src/tools/prompt-templates/preview.ts` | 3 | Preview template tool |
| `src/github/templates.ts` | 4 | GitHub event template definitions |
| `src/tests/prompt-template-github.test.ts` | 4 | GitHub backward compat tests |
| `src/gitlab/templates.ts` | 5 | GitLab event template definitions |
| `src/agentmail/templates.ts` | 5 | AgentMail event template definitions |
| `src/linear/templates.ts` | 5 | Linear event template definitions |
| `src/prompts/session-templates.ts` | 6 | Composite session template definitions (lead + worker assembly recipe) |

### Modified Files
| File | Phase | Changes |
|------|-------|---------|
| `src/types.ts` | 1 | Add PromptTemplate + PromptTemplateHistory schemas |
| `src/be/db.ts` | 1 | Add CRUD + resolve + checkout functions |
| `src/http/index.ts` | 3 | Register prompt-templates handler |
| `scripts/generate-openapi.ts` | 3 | Import prompt-templates handler |
| `src/server.ts` | 3 | Register MCP tools |
| `src/github/handlers.ts` | 4 | Replace hardcoded prompts with resolveTemplate() |
| `src/gitlab/handlers.ts` | 5 | Replace hardcoded prompts |
| `src/agentmail/handlers.ts` | 5 | Replace hardcoded prompts |
| `src/linear/sync.ts` | 5 | Replace hardcoded prompts |
| `src/heartbeat/heartbeat.ts` | 5 | Replace hardcoded prompt |
| `src/tools/store-progress.ts` | 5 | Replace hardcoded prompts |
| `src/commands/runner.ts` | 5 | Replace trigger/resume prompts |
| `src/slack/handlers.ts` | 5 | Replace hardcoded prompts |
| `src/slack/assistant.ts` | 5 | Replace hardcoded prompts |
| `src/prompts/base-prompt.ts` | 6 | Replace constants with registry lookups |

---

## Review Errata

_Reviewed: 2026-03-20 by Claude (automated review, all fixes applied)_

### Resolved (Critical)
- [x] **Global-scope override collision** — `UNIQUE(eventType, scope, scopeId)` prevented having both a seeded default and user override at global scope. Fixed: upsert at global scope flips `isDefault` from true to false; re-seeding only touches `isDefault=true` records. Added `resetPromptTemplateToDefault()` for immediate revert. Added `POST /api/prompt-templates/{id}/reset` endpoint.

### Resolved (Important)
- [x] **Wildcard + scope chain interaction unspecified** — Added explicit precedence rule: exact match at any scope always beats wildcard at any scope. Within same match type, scope precedence is `agent > repo > global`. Two-pass resolution documented.
- [x] **Seeding invocation location missing** — Specified: `seedDefaultTemplates()` called from `initDb()` in `src/be/db.ts` after `runMigrations(db)`.
- [x] **Header interpolation not explicit** — Clarified in resolver step 7: header and body are composed first, then the entire string is interpolated with the same variable context.
- [x] **Performance/caching strategy missing** — Added "Performance Strategy" section: no caching initially (SQLite sub-ms queries are sufficient), deferred to follow-up if benchmarks show need.
- [x] **handlePullRequest multi-action dispatch** — Added note in Phase 4.2 clarifying that each action branch maps to a different eventType; handler dispatch structure stays the same.

### Resolved (Minor)
- [x] **Phase 3 curl example** created global override colliding with seeded default — changed to repo-scope override
- [x] **Deletion preserves history** — Removed `ON DELETE CASCADE`, documented orphaned history behavior (from Taras review)
- [x] **Rollback → Checkout rename** — Applied throughout (from Taras review)
- [x] **Two-layer resolution model** — Added table + flow documentation (from Taras review)
- [x] **Composite session template recipe** — Added explicit `{{@template[...]}}` assembly recipe for `system.session.lead/worker` (from Taras review)
- [x] **E2E webhook simulation** — Added section testing ALL event types via webhook payloads (from Taras review)
