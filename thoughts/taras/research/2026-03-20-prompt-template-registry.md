---
date: 2026-03-20T16:00:00-04:00
researcher: Claude
git_commit: cb464bc94af8f65b0adf25973cf2fe1bf02c781b
branch: main
repository: desplega-ai/agent-swarm
topic: "Prompt Template Registry — Codebase Analysis"
tags: [research, prompts, templates, events, registry, config]
brainstorm: thoughts/taras/brainstorms/2026-03-20-prompt-template-registry.md
status: complete
autonomy: critical
last_updated: 2026-03-20
last_updated_by: Claude
---

# Research: Prompt Template Registry — Codebase Analysis

**Date**: 2026-03-20
**Researcher**: Claude
**Git Commit**: cb464bc
**Branch**: main
**Brainstorm**: [`thoughts/taras/brainstorms/2026-03-20-prompt-template-registry.md`](../brainstorms/2026-03-20-prompt-template-registry.md)

## Research Question

Validate and deepen the brainstorm at `thoughts/taras/brainstorms/2026-03-20-prompt-template-registry.md` by cataloging all hardcoded prompts, understanding system prompt assembly, mapping the existing config/scope system, and identifying template-like patterns already in the codebase.

## Summary

The agent-swarm codebase contains **~70 distinct hardcoded prompt strings** spread across **13 source files**, producing six categories of output: task descriptions, system prompt constants, hook-injected messages, external platform messages, memory content templates, and session prompts (Linear thoughts, Slack messages). The system prompt is assembled by `getBasePrompt()` in `src/prompts/base-prompt.ts` from 12 named constants using single-brace `{placeholder}` replacement, while event handlers use JS template literals with `${variable}` interpolation. The existing `swarm_config` table provides a proven three-tier scope hierarchy (`global → agent → repo`) with the same resolution pattern proposed in the brainstorm. Two `{{...}}` interpolation engines already exist in the codebase — one for workflows (dot-path, replaces unresolved with empty) and one for workflow templates (flat keys, leaves unresolved in place) — either could serve as the foundation for the prompt template resolver.

## Detailed Findings

### 1. Hardcoded Prompt Catalog

#### 1.1 GitHub Event Handlers (`src/github/handlers.ts`)

**12 task description templates** covering all webhook event types:

> **Design note (Taras):** Templates could separate a static header (e.g. `[GitHub PR #{{pr.number}}] {{pr.title}}`) from a variable content body — the header pattern is shared across many PR events while the body differs per event type. This suggests a two-part template structure: `title` + `body`.

| Event | Line | Template Title Pattern | Key Variables |
|-------|------|----------------------|---------------|
| PR assigned | 103 | `[GitHub PR #${pr.number}] ${pr.title}` | `pr.*`, `sender.login`, `repository.full_name`, `GITHUB_BOT_NAME` |
| PR review requested | 183 | `[GitHub PR #${pr.number}] ${pr.title}` | Same as above |
| PR closed/merged | 261 | `${emoji} [GitHub PR #${pr.number}] ${status}` | `pr.*`, `wasMerged`, `pr.merged_by.login`, `task.id` |
| PR synchronize | 298 | `🔄 [GitHub PR #${pr.number}] New commits pushed` | `pr.*`, `task.id` |
| PR mention | 342 | `[GitHub PR #${pr.number}] ${pr.title}` | `pr.*`, `extractMentionContext(pr.body)` |
| Issue assigned | 397 | `[GitHub Issue #${issue.number}] ${issue.title}` | `issue.*`, `sender.login` |
| Issue mention | 475 | `[GitHub Issue #${issue.number}] ${issue.title}` | `issue.*`, `extractMentionContext(issue.body)` |
| Comment mention | 547 | `[GitHub ${targetType} #${targetNumber} Comment]` | `comment.*`, `targetType`, `existingTask.id` |
| PR review submitted | 653 | `${emoji} [GitHub PR #${pr.number} Review] ${label}` | `review.*`, `getReviewStateInfo()` |
| Check run failed | 767 | `${emoji} [GitHub PR #${prNumber} CI] ${check_run.name}` | `check_run.*`, `relatedTask.id` |
| Check suite failed | 841 | `${emoji} [GitHub PR #${prNumber} CI Suite] ${label}` | `check_suite.*`, `relatedTask.id` |
| Workflow run failed | 917 | `${emoji} [GitHub PR #${prNumber} Workflow] ${workflow_run.name}` | `workflow_run.*`, `relatedTask.id` |

**Cross-cutting fragments:**
- `DELEGATION_INSTRUCTION` (line 19): `"⚠️ As lead, DELEGATE this task to a worker agent - do not tackle it yourself."`
- `getCommandSuggestions(taskType, targetType)` (line 25): Returns 4 variants based on task type (PR, issue, comment)
- `getReviewStateInfo(state)` (line 582): Returns `{emoji, label}` for review states
- `getCheckConclusionInfo(conclusion)` (line 689): Returns `{emoji, label}` for CI conclusions

**Structural pattern:** All templates follow the same layout: `[Header line]\n\nMetadata lines\n\n---\n${DELEGATION_INSTRUCTION}\n${suggestions}`. Related tasks add `🔀 Consider routing to the same agent working on the related task.`

#### 1.2 GitLab Event Handlers (`src/gitlab/handlers.ts`)

**4 task description templates** mirroring the GitHub ones:

| Event | Line | Key Variables |
|-------|------|---------------|
| MR opened with mention | 94 | `mr.iid`, `mr.title`, `user.username`, `mr.source_branch`, `mr.target_branch` |
| Issue opened/assigned | 175 | `issue.iid`, `issue.title`, `user.username` |
| Comment with mention | 253 | `entityLabel`, `user.username`, `existingTask.id` |
| Pipeline failed | 311 | `pipeline.id`, `mrIid`, `event.merge_request.*` |

**Notable divergence from GitHub:** GitLab's `DELEGATION_INSTRUCTION` (line 33) is different text — uses markdown bold and names the `send-task` tool explicitly. This is an inconsistency the brainstorm's unified registry would fix.

#### 1.3 Slack Handlers (`src/slack/handlers.ts`)

Not a traditional task template — Slack extracts task text from user messages. Key prompt patterns:

| Pattern | Lines | Description |
|---------|-------|-------------|
| Thread context wrapping | 448-449 | `<thread_context>\n${threadContext}\n</thread_context>\n\n${taskDescription}` |
| Thread message formatting | 204-218 | `"[Agent]: ${truncatedText}"` or `"${userName}: ${m.text}"` per message |
| Rate limit warning | 424-428 | Static: `":satellite: _You're sending too many requests..._"` |
| Empty task warning | 433-436 | Static: `":satellite: _Please provide a task description..._"` |
| No agents online | 461-463 | Static: `":satellite: _No agents are online right now..._"` |
| File attachment | 241-244 | `"[File: ${f.name} (${f.mimetype}, ${formatFileSize(f.size)}) id=${f.id}]"` |

#### 1.4 Slack Assistant (`src/slack/assistant.ts`)

| Pattern | Line | Description |
|---------|------|-------------|
| Greeting | 18 | `"Hi! I'm your Agent Swarm assistant. How can I help?"` |
| Suggested prompts | 20-27 | Static 3-item prompt array |
| Channel context | 84 | `"\n\n[User is viewing channel <#${ctx.channel_id}>]"` |
| Offline message | 96-98 | `"No agents are available right now..."` |
| Status messages | 53, 68, 73 | `"Queuing follow-up..."`, `"Processing follow-up..."`, `"Processing your request..."` |

#### 1.5 AgentMail Handlers (`src/agentmail/handlers.ts`)

**5 task description templates** for email-to-task conversion:

| Variant | Line | Title | Trigger |
|---------|------|-------|---------|
| Follow-up in thread | 112 | `[AgentMail] Follow-up email in thread` | Existing thread task found |
| New email → lead | 138 | `[AgentMail] New email received` | Mapped inbox, lead agent |
| New email → worker | 156 | `[AgentMail] New email received` | Mapped inbox, worker agent |
| Unmapped inbox → lead | 177 | `[AgentMail] New email received (unmapped inbox)` | No inbox mapping |
| No agent available | 195 | `[AgentMail] New email received (no agent available)` | No agent online |

All share variables: `from`, `subject`, `inbox_id`, `thread_id`, `preview` (body truncated to 500 chars). Slight inconsistency: mapped-to-lead variant includes `message_id`, worker variant doesn't.

#### 1.6 Linear Sync (`src/linear/sync.ts`)

| Pattern | Line | Type | Variables |
|---------|------|------|-----------|
| New issue task | 277 | Task description | `issueIdentifier`, `issueTitle`, `issueUrl`, `sessionUrl`, `issueDescription` |
| Acknowledgment thought | 305 | Linear activity | `task.id` |
| In-progress message | 481 | Linear activity | Static |
| Follow-up task | 494 | Task description | `issueIdentifier`, `issueTitle`, `issueUrl`, `userMessage` |
| Follow-up ack | 524 | Linear activity | `task.id` |
| Stop signal | 458 | Linear activity | Static: `"Task cancelled by user."` |

#### 1.7 Heartbeat (`src/heartbeat/heartbeat.ts`)

**1 escalation task template** (lines 259-278): Assembled from sections array. Lists each stalled task with `task.id.slice(0,8)`, `agentSlice`, `task.lastUpdatedAt`. Includes deterministic `escalationKey` to prevent duplicate escalations. Task type `"heartbeat"`, priority 70.

#### 1.8 Store Progress (`src/tools/store-progress.ts`)

| Pattern | Line | Type | Variables |
|---------|------|------|-----------|
| Completed task memory | 183 | Agent memory | `task.task`, `output` |
| Failed task memory | 184 | Agent memory | `task.task`, `failureReason` |
| Swarm-shared memory | 217 | Swarm memory | `requestInfo.agentId`, `taskContent` |
| Follow-up: completed | 250 | Task description | `agentName`, `taskDesc`, `outputSummary`, `taskId` |
| Follow-up: failed | 253 | Task description | `agentName`, `taskDesc`, `reason`, `taskId` |
| Epic context enrichment | 261-274 | Appended to above | `epic.*`, `result.task.epicId` |

#### 1.9 Runner (`src/commands/runner.ts`)

**Trigger-based prompts** spawned into provider sessions:

| Trigger Type | Lines | Key Variables |
|-------------|-------|---------------|
| `task_assigned` | 892-903 | `trigger.taskId`, `taskDesc` |
| `task_offered` | 906-917 | `trigger.taskId`, `taskDesc` |
| `unread_mentions` | 920-926 | `trigger.count` |
| `pool_tasks_available` | 928-936 | `trigger.count` |
| `epic_progress_changed` | 938-1035 | Full epic state: `epic.*`, task summaries, stats |
| Resume with progress | 455-468 | `task.id`, `task.task`, `task.progress` |
| Resume no progress | 470-483 | `task.id`, `task.task` |

**Context enrichment fragments:**
| Fragment | Lines | Trigger |
|----------|-------|---------|
| Relevant memories | 1071-1075 | Memory search returns results (similarity > 0.4) |
| Epic task context | 1124-1129 | Task belongs to epic, sibling tasks completed |
| Working directory annotation | 2176-2183 | Effective CWD differs from process.cwd() |
| CWD warning (system prompt) | 2189 | Task dir doesn't exist |

#### 1.10 Hook System (`src/hooks/hook.ts`)

**13 distinct prompt strings** injected via stdout or block responses:

| ID | Lines | Type | Trigger |
|----|-------|------|---------|
| Progress reminder (busy) | 670-672 | stdout | Every hook, busy worker |
| Progress reminder (post-tool) | 971-973 | stdout | PostToolUse, worker |
| Send-task confirmation | 966-968 | stdout | PostToolUse, lead + send-task |
| Unregistered agent | 675-681 | stdout | Every hook, no agentInfo |
| Registered agent status | 657-659 | stdout | Every hook, has agentInfo |
| Task cancelled (with file) | 541-543 | Block response | PreToolUse/UserPromptSubmit |
| Task cancelled (no file) | 558-560 | Block response | PreToolUse/UserPromptSubmit |
| Tool loop detected | 808-812 | Block response | PreToolUse |
| Polling limit | 827-829 | Block response | PreToolUse |
| Goal reminder | 770-778 | stdout | PreCompact |
| Shared disk write warning | 88-96 | stdout | PreToolUse/PostToolUse |
| Concurrent session awareness | 705-746 | stdout | SessionStart, lead |
| Session summarization | 1057-1074 | Piped to haiku → memory | Stop event |

#### 1.11 Pi-Mono Extension (`src/providers/pi-mono-extension.ts`)

**10 prompt strings** — mirrors a subset of hook.ts for the pi-mono provider. Of the 13 hook prompts cataloged in 1.10, 10 have pi-mono equivalents: task cancellation (2), tool loop, polling limit, progress reminders (2), send-task confirmation, shared disk write warning, concurrent session awareness, PreCompact goal reminder, and session summarization. The 3 hook-only prompts (unregistered agent, registered agent status, progress reminder on busy) have no pi-mono counterpart. Minor differences exist (e.g., send-task confirmation omits task ID in pi-mono).

#### 1.12 Docker Entrypoint (`docker-entrypoint.sh`)

**1 task template** (lines 241-248): Agent-fs invitation task for lead. Interpolates `AF_SHARED_ORG_ID` and `AGENT_ID` via shell `${}`. Created via `POST /api/tasks`.

---

### 2. System Prompt Assembly (`src/prompts/base-prompt.ts`)

#### 2.1 Architecture

`getBasePrompt(args: BasePromptArgs)` is the sole export. It assembles the system prompt from 12 module-scoped constants in a fixed order:

```
1. BASE_PROMPT_ROLE           — "{role}" and "{agentId}" replaced     (line 1)
2. [Identity block]           — name, description, soulMd, identityMd (lines 500-515)
3. [Repository Context]       — repo CLAUDE.md from VCS clone         (lines 518-533)
4. [Agent CLAUDE.md]          — truncatable, 20k char cap             (lines 580-600)
5. [Agent TOOLS.md]           — truncatable, remaining budget          (lines 601-611)
6. BASE_PROMPT_REGISTER       — join-swarm instruction                 (line 7)
7. BASE_PROMPT_LEAD or _WORKER — role-conditional                     (line 539)
8. BASE_PROMPT_FILESYSTEM     — "{agentId}" replaced                  (line 228)
9. [BASE_PROMPT_AGENT_FS]     — conditional on AGENT_FS_API_URL env   (line 306)
10. BASE_PROMPT_SELF_AWARENESS — static                               (line 365)
11. BASE_PROMPT_CONTEXT_MODE  — static                                (line 384)
12. BASE_PROMPT_GUIDELINES    — static                                (line 390)
13. BASE_PROMPT_SYSTEM        — static                                (line 397)
14. [BASE_PROMPT_SERVICES]    — conditional on capabilities           (line 421)
15. [BASE_PROMPT_ARTIFACTS]   — conditional on capabilities           (line 458)
16. [Capabilities list]       — conditional                           (line 572)
```

#### 2.2 Interpolation Pattern

Uses **single-brace** `{placeholder}` with `.replace()` / `.replaceAll()`:
- `BASE_PROMPT_ROLE.replace("{role}", role).replace("{agentId}", agentId)` (line 497)
- `BASE_PROMPT_FILESYSTEM.replaceAll("{agentId}", agentId)` (line 545)
- `BASE_PROMPT_AGENT_FS.replaceAll("{agentId}", agentId).replaceAll("{sharedOrgId}", sharedOrgId)` (line 550)
- `BASE_PROMPT_SERVICES.replace("{agentId}", agentId).replace("{swarmUrl}", swarmUrl)` (line 562)

This is distinct from both the `{{...}}` workflow interpolation and the `${...}` JS template literals used by event handlers.

#### 2.3 Caller Chain

1. `runAgent()` in `src/commands/runner.ts` defines a `buildSystemPrompt()` closure (line 1519) that calls `getBasePrompt()`
2. Called **3 times** during lifecycle: initial (no identity), post-profile-fetch (identity populated), per-task (repo context set)
3. Result passed to `ProviderSessionConfig.systemPrompt` (line 1174)
4. Claude adapter: `--append-system-prompt` CLI flag (line 137 of `claude-adapter.ts`)
5. Pi-mono adapter: `ResourceLoader.appendSystemPrompt` (line 407 of `pi-mono-adapter.ts`)

#### 2.4 Truncation System

- `BOOTSTRAP_MAX_CHARS = 20_000` per section
- `BOOTSTRAP_TOTAL_MAX_CHARS = 150_000` total budget
- Protected content (prompt + staticSuffix) is measured first, remainder allocated to truncatable sections
- Agent CLAUDE.md gets priority, TOOLS.md gets leftover budget

#### 2.5 Dynamic Sections

| Section | Condition | Source |
|---------|-----------|--------|
| Identity block | `soulMd \|\| identityMd \|\| name` | Agent profile from `/me` API |
| Repo CLAUDE.md | Task has `vcsRepo` | Read from cloned repo |
| Agent CLAUDE.md | `args.claudeMd` truthy | Profile `claudeMd` field |
| Agent TOOLS.md | `args.toolsMd` truthy | Profile `toolsMd` field |
| Lead vs Worker | `role === "lead"` | Runner config |
| Agent-FS | `AGENT_FS_API_URL` env set | Environment |
| Services | capabilities includes `"services"` | `CAPABILITIES` env var |
| Artifacts | capabilities includes `"artifacts"` | `CAPABILITIES` env var |

---

### 3. Existing Config/Scope System

#### 3.1 Database Schema (`src/be/migrations/001_initial.sql:246-258`)

```sql
CREATE TABLE IF NOT EXISTS swarm_config (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK(scope IN ('global', 'agent', 'repo')),
    scopeId TEXT,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    isSecret INTEGER NOT NULL DEFAULT 0,
    envPath TEXT,
    description TEXT,
    createdAt TEXT NOT NULL,
    lastUpdatedAt TEXT NOT NULL,
    UNIQUE(scope, scopeId, key)
);
```

#### 3.2 Scope Resolution (`src/be/db.ts:5058-5084`)

`getResolvedConfig(agentId?, repoId?)` implements the overlay strategy:
1. Start with all `global` scope configs (keyed by `config.key`)
2. Overlay `agent`-scoped configs (same key overwrites global)
3. Overlay `repo`-scoped configs (same key overwrites both)

**Resolution priority: `repo > agent > global`** — most specific wins.

**NULL handling caveat:** SQLite treats `NULL != NULL` in UNIQUE constraints, so `UNIQUE(scope, scopeId, key)` doesn't fire for `scope=global` where `scopeId IS NULL`. The `upsertSwarmConfig()` function (line 4966) manually checks for existing entries instead of relying on `ON CONFLICT`.

#### 3.3 Access Paths

**MCP tools** (deferred, in `src/tools/swarm-config/`):
- `set-config` — validates scope/scopeId consistency, upserts
- `get-config` — calls `getResolvedConfig()`, masks secrets
- `list-config` — raw listing, no resolution
- `delete-config` — by UUID

**REST API** (`src/http/config.ts`):
- `GET /api/config/resolved` — merged config with scope resolution
- `GET /api/config/{id}` — single entry
- `GET /api/config` — raw list with filters
- `PUT /api/config` — upsert
- `DELETE /api/config/{id}` — delete

**Types** (`src/types.ts:460-480`): `SwarmConfigScopeSchema = z.enum(["global", "agent", "repo"])`, `SwarmConfigSchema` with Zod validation.

#### 3.4 Relevance to Prompt Template Registry

The config system is a **structural precedent** for the proposed prompt template registry:
- Same scope values (`global`, `agent`, `repo`)
- Same `NULL` handling issue will apply to prompt templates
- Same dual-access pattern (MCP tools + REST API)
- The `envPath` + `writeEnvFile()` pattern shows config values can sync to external systems — analogous to how prompt templates would sync to the resolver cache

**⚠️ Resolution order discrepancy:** The existing config system resolves **`repo > agent > global`** (repo overlaid last, wins over agent — `db.ts:5076`). However, the brainstorm proposes **`agent > repo > global`** (agent checked first, most specific). These are inverted. The plan needs to decide which precedence to adopt:
- **Config precedent (repo > agent > global):** A repo-level override beats an agent-level one. Makes sense when repo conventions should be enforced regardless of agent.
- **Brainstorm proposal (agent > repo > global):** An agent-level override beats a repo-level one. Makes sense when individual agents should be able to opt out of repo defaults.

#### 3.5 Task Metadata Available at Resolution Time

All event handlers call `createTaskExtended(task, options)` (`db.ts:1777`). The `CreateTaskOptions` interface (`db.ts:1707-1740`) provides the following metadata that would be available to the template resolver for scope resolution:

| Field | Type | Relevance to resolver |
|-------|------|----------------------|
| `agentId` | `string?` | Agent scope lookup |
| `vcsRepo` | `string?` | Repo scope lookup (e.g. `"desplega-ai/agent-swarm"`) |
| `vcsProvider` | `"github" \| "gitlab"?` | Could differentiate GitHub vs GitLab templates |
| `vcsEventType` | `string?` | Maps to event type taxonomy |
| `taskType` | `string?` | Template selection key |
| `source` | `AgentTaskSource?` | Origin (github, gitlab, slack, linear, etc.) |
| `epicId` | `string?` | Epic context enrichment |
| `tags` | `string[]?` | Could influence template selection |
| `parentTaskId` | `string?` | For follow-up context inheritance |
| `creatorAgentId` | `string?` | Who created the task |
| `dir` | `string?` | Working directory context |

The resolver would need at minimum `agentId` + `vcsRepo` for scope resolution, and `source` + `vcsEventType` (or `taskType`) for template selection.

---

### 4. Existing Template-Like Patterns

#### 4.1 Workflow Interpolation (`src/workflows/template.ts`)

**General-purpose `{{path.to.value}}` engine:**
- `interpolate(template, context)` — regex `/\{\{([^}]+)\}\}/g`, dot-path resolution, replaces unresolved with empty string, tracks unresolved tokens
- `deepInterpolate(value, context)` — recursive tree walk for objects/arrays
- Returns `{ result: string, unresolved: string[] }`

**Used by:** Agent profile template interpolation in `runner.ts:1700-1719` with context `{ agent: { name, role, description, capabilities } }`.

**Gap for prompt template registry:** The brainstorm proposes `{{@template[event_type]}}` syntax for recursive template embedding (e.g., `{{@template[common.delegation_instruction]}}`). The existing `interpolate()` function does **not** support this — its regex `/\{\{([^}]+)\}\}/g` would match `@template[common.delegation_instruction]` as a dot-path and try to resolve it against the context object (failing silently, returning `""`). To support recursive embedding, the resolver would need to either:
1. **Extend `interpolate()`** with a pre-pass that detects `{{@template[...]}}` tokens, resolves them from the registry, and substitutes before variable interpolation
2. **Wrap `interpolate()`** in a resolver function that handles template references in a loop (with depth limit of 3 and cycle detection per the brainstorm)

Option 2 (wrapping) is cleaner — keeps `interpolate()` unchanged and adds template-specific logic in a new `resolveTemplate()` function.

#### 4.2 Workflow Template Instantiation (`src/workflows/templates.ts`)

**Separate system for `WorkflowTemplate` objects:**
- `validateTemplateVariables(variables, provided)` — checks required vars with defaults
- `instantiateTemplate(template, variables)` — validates + deep-clones + replaces
- `replaceStringPlaceholders(str, vars)` — regex `/\{\{(\w+)\}\}/g`, flat keys only, leaves unresolved as-is

**Key difference:** Flat keys (`{{key}}`) vs dot-paths (`{{a.b.c}}`), and unresolved handling differs.

#### 4.3 Base Prompt Interpolation (`src/prompts/base-prompt.ts`)

**Single-brace `{placeholder}` with `.replace()`** — a third, distinct interpolation pattern. No regex, no unresolved tracking, simple string replacement.

#### 4.4 Scheduled Tasks (`001_initial.sql:222`)

`scheduled_tasks.taskTemplate` is a `TEXT NOT NULL` column storing task description strings. In `src/scheduler/scheduler.ts:35,125,285`, this value is passed directly to `createTaskExtended()` as the task description — **no interpolation performed**. This is the closest existing concept to "stored task description templates" but lacks any variable substitution.

#### 4.5 Template Registry Types (`templates/schema.ts`)

`TemplateConfig` and `TemplateResponse` types define the agent profile template system. Files (`claudeMd`, `soulMd`, `identityMd`, `toolsMd`, `setupScript`) contain `{{agent.*}}` tokens interpolated at registration time via the workflow `interpolate()` function.

---

## Code References

| File | Lines | Description |
|------|-------|-------------|
| `src/github/handlers.ts` | 19-20, 25-38, 103-917 | GitHub event handler templates, DELEGATION_INSTRUCTION, getCommandSuggestions |
| `src/gitlab/handlers.ts` | 33-34, 54-63, 94-311 | GitLab event handler templates, separate DELEGATION_INSTRUCTION |
| `src/slack/handlers.ts` | 204-218, 424-499 | Thread context wrapping, user-facing messages |
| `src/slack/assistant.ts` | 18-98 | Greeting, suggested prompts, offline message |
| `src/agentmail/handlers.ts` | 112-197 | 5 email-to-task templates |
| `src/linear/sync.ts` | 277-524 | Linear issue tasks and thought activities |
| `src/heartbeat/heartbeat.ts` | 259-296 | Escalation task template |
| `src/tools/store-progress.ts` | 183-279 | Memory content + follow-up task templates + epic context |
| `src/commands/runner.ts` | 455-1129, 2176-2197 | Trigger prompts, resume prompts, context enrichment |
| `src/hooks/hook.ts` | 88-1074 | 13 hook-injected messages (stdout + block responses) |
| `src/providers/pi-mono-extension.ts` | 173-594 | 10 pi-mono mirror prompts |
| `docker-entrypoint.sh` | 241-248 | Agent-fs invitation task |
| `src/prompts/base-prompt.ts` | 1-638 | 12 system prompt constants + getBasePrompt() assembly |
| `src/be/db.ts` | 4845-5084 | Config CRUD + scope resolution |
| `src/be/migrations/001_initial.sql` | 246-258 | swarm_config table schema |
| `src/http/config.ts` | 16-191 | Config REST API endpoints |
| `src/tools/swarm-config/` | — | Config MCP tools (set, get, list, delete) |
| `src/types.ts` | 460-480 | SwarmConfigSchema, SwarmConfigScopeSchema |
| `src/workflows/template.ts` | 13-74 | `{{path.to.value}}` interpolation engine |
| `src/workflows/templates.ts` | 7-86 | Workflow template instantiation + `{{key}}` replacement |
| `templates/schema.ts` | 1-35 | Agent profile template types |

## Architecture Documentation

### Three Interpolation Patterns Coexisting

| Pattern | Syntax | Engine | Unresolved Handling | Used By |
|---------|--------|--------|-------------------|---------|
| JS template literals | `${var}` | JavaScript runtime | N/A (compile-time) | Event handlers (GitHub, GitLab, Slack, etc.) |
| Single-brace | `{var}` | `.replace()` / `.replaceAll()` | Left as-is | `getBasePrompt()` system prompt constants |
| Double-brace (dot-path) | `{{a.b.c}}` | Regex + object walk | Replaced with `""` | Workflow interpolation, agent profile templates |
| Double-brace (flat) | `{{key}}` | Regex + map lookup | Left as-is | Workflow template instantiation |

### Prompt Output Categories

| Category | Count | Examples |
|----------|-------|---------|
| Task descriptions | ~30 | GitHub/GitLab events, AgentMail, Linear, heartbeat, follow-ups |
| System prompt constants | 12 | BASE_PROMPT_ROLE through BASE_PROMPT_ARTIFACTS |
| Hook-injected messages | ~13 | Progress reminders, cancellation blocks, goal reminders |
| External platform messages | ~8 | Linear thoughts, Slack user messages, Slack status |
| Memory content templates | 3 | Task completion/failure memory strings |
| Session prompts (triggers) | 7 | task_assigned, task_offered, resume, epic progress, etc. |

### Hook/Extension Duplication

`src/hooks/hook.ts` and `src/providers/pi-mono-extension.ts` contain **near-identical prompt strings** — the pi-mono extension mirrors Claude Code hooks for the alternative provider. This means any prompt change needs to be made in both files, a maintenance burden the registry would eliminate.

## Historical Context (from thoughts/)

- `thoughts/taras/research/2026-03-10-configurable-event-prompts.md` — Earlier research on the same topic, likely a precursor to the brainstorm document
- `thoughts/taras/brainstorms/2026-03-20-prompt-template-registry.md` — The brainstorm this research validates, containing key decisions on scope hierarchy, three-state control, seeded defaults, and audit history

## Related Research

*(Earlier research at `2026-03-10-configurable-event-prompts.md` was a preliminary try — superseded by this document and the brainstorm.)*

## Resolved Questions (from review)

- **Interpolation syntax:** ✅ Reuse the existing `interpolate()` from `src/workflows/template.ts` with good test coverage. No need for a dedicated resolver.
- **Hook/extension prompts:** ✅ Out of scope — leave hook-injected messages (progress reminders, cancellation blocks, goal reminders) as hardcoded. They have different delivery mechanisms and don’t benefit from runtime customization.
- **Pi-mono duplication:** ✅ Out of scope — don’t unify hook.ts / pi-mono-extension.ts through the registry. Only thing to consider is skill mapping differences added recently (if any).
- **Scheduled task templates:** ✅ Out of scope — `scheduled_tasks.taskTemplate` is user/lead-defined, not system-defined. Could add interpolation later but not needed now.
- **Memory content templates:** ✅ Out of scope — store-progress memory strings are tightly coupled to their logic, not worth abstracting into the registry.

## Open Questions

- **Template structure:** Should templates separate a static `title` pattern (e.g. `[GitHub PR #{{pr.number}}] {{pr.title}}`) from a variable `body`? Many event types share the same header but differ in body content. This could simplify overrides — customize the body without touching the title.
- **Skill mapping differences (pi-mono):** Were any skill mapping differences between hook.ts and pi-mono-extension.ts added recently that would affect template scoping?

---

## Review Errata

_Reviewed: 2026-03-20 by Claude_

### Critical
- [x] **Scope resolution order mismatch** — Section 3.4 claimed "same resolution strategy." Fixed: now explicitly flags that config uses `repo > agent > global` while brainstorm proposes `agent > repo > global`, with pros/cons for each. Decision deferred to plan phase.

### Important
- [x] **Missing `createTaskExtended()` metadata analysis** — Added section 3.5 documenting all `CreateTaskOptions` fields available at resolution time, with relevance mapping for the template resolver.
- [x] **`{{@template[...]}}` recursive embedding not assessed** — Added gap analysis in section 4.1 explaining that `interpolate()` doesn't support `{{@template[...]}}` syntax. Recommends wrapping (not extending) `interpolate()` in a new `resolveTemplate()` function for template references + cycle detection.

### Minor (auto-fixed)
- [x] **Summary category count** — said "four categories" but table showed six. Fixed to "six categories."
- [x] **Pi-mono prompt count clarity** — "10 prompts" referenced "6A-6M" without explaining the mapping. Expanded to list which 10 of 13 are mirrored and which 3 are hook-only.
