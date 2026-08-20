---
date: 2026-08-20T00:00:00Z
topic: "Deterministic Surfaces Inventory for System Prompt v2"
---

# Deterministic Surfaces Inventory

**Goal:** Comprehensive inventory of tools, scripts, skills, and guidance for steering agents toward reusable, deterministic paths (scripts, workflows, schedules, pages, apps) instead of ad-hoc tool loops.

---

## 1. MCP Tools by Family

### Scripts (Enabled by default)
| Tool | File | Purpose |
|------|------|---------|
| `script-run` | script-run.ts | Run named or inline TypeScript script; auto-save scratch scripts |
| `script-upsert` | script-upsert.ts | Typecheck and persist script to swarm catalog |
| `script-search` | script-search.ts | Find scripts by name, description, intent |
| `script-delete` | script-delete.ts | Delete a script from catalog |
| `script-query-types` | script-query-types.ts | Introspect available types and SDK surface |
| `script-apis` | script-apis.ts | Expose a script as OpenAPI endpoint |
| `launch-script-run` | (workflow-step) | Durable workflow step with journaled steps |
| `get-script-run`, `list-script-runs` | script-runs.ts | Get/list script run results |

**Capability:** `scripts` (enabled by default)

### Workflows (Enabled by default)
| Tool | Purpose |
|------|---------|
| `run-workflow` | Execute workflow DAG; block until terminal state |
| `list-workflows` | List available workflows |
| `get-workflow` | Fetch workflow definition |
| `update-workflow` | Patch a workflow node or edge |

**Capability:** `workflows` (enabled by default)  
**Notes:** DAGs with nodes: `script` (inline TS), `swarm-script` (durable), `agent-task`, `condition`, `loop`. Max timeout: 5 minutes per step.

### Schedules (Enabled by default)
| Tool | Purpose |
|------|---------|
| `create-schedule` | Create recurring schedule (cron/interval) |
| `list-schedules`, `get-schedule` | Fetch schedule config |
| `pause-schedule`, `resume-schedule` | Manage schedule state |
| `delete-schedule` | Delete a schedule |

**Capability:** `scheduling` (enabled by default)  
**Notes:** Store intent as JSON schema. No cron expressions in prompts.

### Pages (Enabled by default)
| Tool | Purpose |
|------|---------|
| `create-page` | Create/update DB-backed page; upsert by `(agentId, slug)` |
| `delete-page`, `get-page`, `list-pages` | Page lifecycle |

**Capability:** `pages` (enabled by default)  
**Notes:** Serve HTML/Markdown; port 3000 exposed.

### Apps (Enabled by default)
| Tool | Purpose |
|------|---------|
| `app-upsert` | Create/update schema-backed app (models, queries, pages, elements) |
| `app-get`, `app-list` | Fetch app definition and surface |
| `app-patch` | Single-node/edge patch |
| `app-history`, `app-rollback` | Version management |
| `app-sync`, `app-query`, `app-diff` | Operations |

**Capability:** `apps` (enabled by default)  
**Notes:** Persistent internal tools with per-user config, theming, safe schema evolution.

### KV, Memory, Messaging, Tasks (All enabled by default)
- **KV:** `ctx.kv.*` in scripts; MCP: kv-set, kv-get, kv-delete, kv-list
- **Memory:** memory-search, memory-get, memory-edit, memory-delete, memory-rate, inject-learning
- **Coordination:** store-progress, request-human-input (HITL)
- **Slack:** post-message, slack-reply, slack-read, slack-post, slack-update, slack-delete, slack-start-thread, slack-upload-file, slack-download-file, slack-list-channels
- **Tasks:** send-task, get-task-details, get-tasks, poll-task, cancel-task, steer-task, accept-steer, task-action, task-dedup

---

## 2. Seed Scripts Catalog (26 scripts)

**Location:** `src/be/seed-scripts/catalog/`  
**Invoke:** `script-run("name", args)`

| Script | Purpose | Args |
|--------|---------|------|
| `fetch-readable` | Fetch and normalize URL response | `url`, `selector?`, `format?` |
| `json-query` | Query JSON (JSONPath/jq-style) | `data`, `query`, `format?` |
| `text-diff` | Unified diff of two texts | `oldText`, `newText`, `context?` |
| `group-count` | Group and count array items | `items`, `groupBy`, `metrics?` |
| `tool-usage` | Analyze tool call patterns | `sessionId?`, `toolFilter?` |
| `task-context-gathering` | Fetch task, lineage, outputs, context | `taskId`, `includeMemory?` |
| `task-failure-audit` | Deep audit of failed task (stderr, logs) | `taskId`, `agentId?` |
| `get-child-outputs` | Flatten subtask outputs (workflow steps) | `taskIds`, `path?` |
| `wait-for-task` | Poll task to terminal with backoff | `taskId`, `timeoutMs?`, `pollIntervalMs?` |
| `report-progress` | Store progress + checkpoint | `taskId`, `message`, `checkpoint?` |
| `complete-task` | Mark task complete with output | `taskId`, `output`, `tags?` |
| `delegate` | Dispatch sub-task (don't block) | `task`, `agentId?` |
| `github-issues-pull` | Fetch GitHub issues (filter) | `owner`, `repo`, `labels?`, `state?` |
| `gh-pr-snapshot` | Snapshot PR (diff, comments, reviews) | `owner`, `repo`, `prNumber` |
| `linear-issue` | Fetch Linear issue | `issueId` or `key` |
| `smart-recall` | Semantic memory search + dedup | `query`, `limit?`, `threshold?` |
| `memory-dedup-check` | Check if memory exists (similarity) | `content`, `threshold?`, `tags?` |
| `memory-eval` | Score memory usefulness | `memoryId`, `criteria?` |
| `swarm-overview` | Fetch swarm status (tasks, agents, schedules) | (no args) |
| `catalog-report` | List scripts, agents, workflows, apps | `type?` |
| `schedule-health` | Audit schedules (next run, failures) | (no args) |
| `slack-thread-flatten` | Linearize Slack thread | `threadTs`, `channelId` |
| `boot-triage` | Startup: config, env, health | (no args) |
| `app-sync-run` | Trigger app data refresh | `appId` |
| `date-resolve` | Parse natural language dates | `text`, `now?` |
| `compound-insights` | Aggregate insights from tasks | `taskIds`, `template?` |

**Key insight:** Not enumerated in session prompts. Agents should `script-search` before building new logic.

---

## 3. Skills Teaching Deterministic Surfaces

| Skill | Size | Key Topics |
|-------|------|-----------|
| `swarm-scripts` | 12 KB | Decision rubric, inline vs named, connected APIs (`ctx.api`, `ctx.mcp`) |
| `script-builder` | 15 KB | Autonomy mode, scan existing, gather intent, step-by-step |
| `script-workflows` | 8 KB | Source shape, durable steps (`ctx.step.*`), labels, status |
| `workflow-iterate` | 9 KB | Read, diagnose, patch, re-read, test, watch. Prefer scripts for deterministic logic |
| `workflow-structured-output` | 6 KB | Schema validation, routing by verdict |
| `pages` | 23 KB | Markdown/HTML, versions, auth modes, public URLs |
| `apps` | 48 KB | Models, queries/actions, elements (pure/bound), per-user config, theming, rollback |
| `kv-storage` | 12 KB | State, caching, namespacing, script integration |
| `scheduled-task-resilience` | 7 KB | Cron, health monitoring, idempotent re-runs |

**Total:** 117 KB. **Overlaps:** swarm-scripts + script-builder (authoring); script-workflows + workflow-iterate (live ops); pages + apps (UI outputs).

---

## 4. Existing Guidance in Session Prompts

**File:** `src/prompts/session-templates.ts`

**Scripts Decision Rubric (Line 495-505):**
> "Use scripts when a task involves repetitive SDK calls, large data processing, or deterministic multi-step pipelines. Scripts run out-of-process and return only their final result."

**Workflows for multi-agent:**
> "Multi-agent fan-out, parallel work, deterministic pipeline: use Workflow"

**Scripts-Only Mode (Line 527-546):**
> "The ONLY swarm MCP tools: script-search, script-run, script-upsert, script-delete, script-query-types, launch-script-run, get-script-run, list-script-runs"

**Seed Scripts Block (Line 607-613):**
> "The swarm ships named scripts at global scope. See the swarm-scripts skill for the full catalog."

**Pages Block (Line 720-725):**
> "Use create_page MCP tool for interactive web content, dashboards, approval flows."

**Apps Block (Line 733-739):**
> "Use the /apps skill to build persistent internal apps with live models, queries, custom actions."

**Durable Workflow Context (Line 474-476):**
> "Durable workflow scripts get ctx.run, ctx.step.rawLlm / ctx.step.agentTask / ctx.step.swarmScript (journaled). Export argsSchema for every named script."

---

## 5. Documentation Pages

**API Reference:**
- scripts.mdx, workflows.mdx, schedules.mdx, pages.mdx, apps.mdx
- typescript.mdx (SDK), workflowevents.mdx, approvalrequests.mdx (HITL)

**Guides:**
- script-workflow-runs.mdx, script-connections.mdx, scripts-only-mode.mdx

**Concepts:**
- workflows.mdx, scheduling.mdx

**Apps Subsection:**
- index.mdx, concepts.mdx, build-an-app.mdx, recipes.mdx

**Playbook Patterns:**
- no-op-workflows.mdx, hitl-gates.mdx, drain-loops.mdx

---

## Key Findings

1. **Tool coverage complete:** 9 families, 50+ tools covering scripts, workflows, schedules, pages, apps, KV, memory, messaging, tasks.
2. **Skills thorough but unbalanced:** 117 KB total. Apps skill (48 KB) dominates. Schedule pedagogy thin.
3. **Session prompt guidance minimal:** 5 steering statements. No anti-patterns. No upgrade-path guidance (when to evolve script to workflow).
4. **Seed scripts underexposed:** 26 scripts exist; none enumerated in prompts. Prompt should encourage `script-search`.
5. **Docs complete, scattered:** 18+ pages. No single "deterministic paths" guide tying them together.

**Gaps for v2 prompt:** Explicit anti-patterns (avoid ad-hoc loops, chat summaries over pages), upgrade paths, when each surface beats the others.
