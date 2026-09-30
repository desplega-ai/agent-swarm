---
id: step-9
name: Send to swarm
depends_on: [step-7, step-1]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-9: Send to swarm

**Repo:** agent-swarm. Needs the step-7 comment rail (mount points `threadActions`, `railHeaderActions`, `lib/comb/markers.ts`) and agent-fs step-1 (`comment-list {pathPrefix}`) for the folder view. The single-file send works against agent-fs v0.14.0.

## Overview

Humans send comments to the swarm. "Send to swarm" on one thread, "Send N to swarm" on a file, or "Send N to swarm" on a folder calls a new API route with comment ids only. The server re-reads each comment from agent-fs with the bootstrap key, skips comments that are resolved, replies, or already sent, claims each comment id in KV (idempotent, race-safe), and creates ONE task for the lead from a registered prompt template. Then it replies `[comb:sent task=<id>] ...` on each comment as the swarm service account. "N" counts unresolved root comments that carry the `@swarm` marker and have no sent reply.

When done: a batch of comments turns into one lead task that carries every comment's id, path, version, lines, quote, body, and author, and a repeated send creates nothing.

## Changes Required:

#### 1. agent-fs access for the server
**File**: `src/fs/agent-fs-provider.ts` (private `ops` at ~259-277)
**Changes**: two public, typed methods that use the bootstrap key and the configured shared org/drive (no task scoping):
- `getComment(id)` → `comment-get {id}` → `{comment, replies}`.
- `replyToComment(parentId, body)` → `comment-add {parentId, body}`.
Reuse `ops()` and `responseToFilesError`. Add the result types next to the existing ones. Do not add a generic `callOp` (keeps bootstrap-key use narrow).

#### 2. Prompt templates
**File**: `src/comb/templates.ts` (new)
**Changes**: register two templates with `registerTemplate` (`src/prompts/registry.ts:33`), `category: "event"`, following `src/jira/templates.ts:39-65`:
- `comb.review.comment` (one comment). Variables: `comment_id`, `author`, `path`, `file_version`, `line_range`, `quote`, `body`, `comment_url`. Body:
  ```
  - Comment {{comment_id}} by {{author}} on {{path}} (version {{file_version}}, {{line_range}})
    Quote: {{quote}}
    Comment: {{body}}
    Open: {{comment_url}}
  ```
- `comb.review.batch`. Header `[Comb] Review {{comment_count}} comment(s) on {{scope_path}}`. Variables: `comment_count`, `scope_path`, `scope_url`, `requested_by`, `org_id`, `drive_id`, `comments_block`. Body:
  ```
  Source: Comb (agent-fs review batch)
  Requested by: {{requested_by}}
  agent-fs drive: org {{org_id}}, drive {{drive_id}}
  Scope: {{scope_path}} ({{scope_url}})

  Humans left {{comment_count}} comment(s) on agent-fs files for the swarm. Handle them as one piece of work, so only one agent edits these files at a time.
  For each comment:
  1. Read the file at its current version with `agent-fs cat <path>`. If the file changed since the comment's version, check `agent-fs diff <path> <comment version> <current version>`.
  2. Make the requested change with `agent-fs edit` or `agent-fs write`. Write a clear version message.
  3. Reply on the comment with what you changed: `agent-fs comment reply <comment id> --body "<what changed, and the new version>"`.
  4. Do not resolve the comment. Resolve it only when the comment asks for that or the change is trivially complete.
  If a comment needs a human decision, reply and mention its author (`--mention <author email>`, agent-fs CLI 0.15 or later).

  Comments:
  {{comments_block}}
  ```
Wording follows the agent-comms style of `src/prompts/` templates; adjust to match neighbors, keep the numbered rules.

**File**: registration side effects
**Changes**: `import "../comb/templates"` in `src/http/comb.ts` and in `src/be/seed-prompt-templates.ts` (next to the imports at :17-19). Add the module to `src/tests/template-registry-helpers.ts:17-29` and `scripts/dump-prompt-variants.ts:36`.

#### 3. Review-batch service + route
**File**: `src/comb/review-batch.ts` (new)
**Changes**: `sendReviewBatch({orgId, driveId, commentIds, scopePath, requestedByUserId})`:
1. `getCombConfig()` (step-4): not enabled → `NotFound` (route answers 404). `orgId`/`driveId` differ from the configured shared ids → 400.
2. For each id (dedup, max 50): `getComment(id)`. Skip with a reason when: not found, a reply (`parentId` set), resolved, or any reply matches the sent marker `^\[comb:sent task=` (same regex as `apps/ui/src/lib/comb/markers.ts`; keep one copy in `src/comb/markers.ts` and import the UI copy's pattern in a test to prevent drift).
3. Claim: `claimKv({namespace: "comb:sent", key: <commentId>, value: {status: "pending"}, valueType: "json", expiresAt: now + 30 days})` (`src/be/db.ts:13348-13370`). A lost claim → skip "already sent".
4. Nothing left → throw a conflict with the skipped list (route answers 409).
5. Resolve `comb.review.comment` per comment and `comb.review.batch` for the task text with `resolveTemplate` (`src/prompts/resolver.ts:158-172`). If the template is `skipped`, release the claims and answer 409 "template disabled".
6. `const lead = await getLeadAgent()` (`src/be/db/agents.ts:305-313`). `createTaskWithSiblingAwareness(text, {agentId: lead?.id ?? "", routingReason: lead ? "skill" : undefined, routingSource: lead ? "engine_default" : undefined, source: "comb", taskType: "comb-review", tags: ["comb"], requestedByUserId}, {origin: "rest"})` (`src/tasks/sibling-awareness.ts:168-179`, precedent `src/jira/sync.ts:634-646`). On failure, `deleteKv` every claim and rethrow.
7. `upsertKv` each claim to `{status: "sent", taskId}`. Then `replyToComment(id, "[comb:sent task=<taskId>] Sent to the swarm: <APP_URL>/tasks/<taskId>")` for each. A failed reply is logged through `scrubSecrets` and does not fail the call (the KV row still blocks a re-send).
8. Return `{taskId, sent: string[], skipped: Array<{id, reason}>}`.
Links: `comment_url` / `scope_url` use `getAppUrl()` + `/file/~/<org>/<drive>/<path>?comment=<id>`.

**File**: `src/comb/markers.ts` (new)
**Changes**: `SENT_MARKER_PREFIX`, `sentMarker(taskId)`, `SENT_MARKER_RE`.

**File**: `src/http/comb.ts` (new) + `src/http/all-routes.ts` import + the handler list in `src/http/index.ts` (~340-384, next to `handleFs` at :349)
**Changes**: `route()` def `POST /api/comb/review-batches`, `tags: ["Comb"]`, `rbac: { permission: "task.create.own" }`, body `{orgId: string, driveId: string, commentIds: string[] (1..50), scopePath: string}`, responses 201 `{taskId, sent, skipped}` (zod schema), 400, 404, 409. Requester via `resolveHttpAuditUserId(req, myAgentId)` (`src/be/audit-user`). Respond with `.respond(res, 201, ...)`.

**File**: `src/types.ts` (`AgentTaskSourceSchema`, ~334-347) and the UI mirror in `apps/ui/src/api/types.ts` if it enumerates sources
**Changes**: add `"comb"`. The SQL CHECK on `agent_tasks.source` was dropped in `056_drop_agent_tasks_source_check.sql`; confirm no later migration re-added one (`grep -n "source IN" src/be/migrations/*.sql`).

**File**: `openapi.json` + `docs-site/content/docs/api-reference/**`
**Changes**: regenerate with `bun run docs:openapi`.

#### 4. Dashboard
**File**: `apps/ui/src/api/client.ts`
**Changes**: `api.sendCombReviewBatch({orgId, driveId, commentIds, scopePath})`.

**File**: `apps/ui/src/lib/comb/batch.ts` (new)
**Changes**: `eligibleForBatch(threads)` → unresolved roots with `hasSwarmMarker(body)` and not `isSentToSwarm(thread)`.

**File**: `apps/ui/src/components/comb/send-to-swarm.tsx` (new)
**Changes**:
- Thread action (via `threadActions`): "Send to swarm" on any unresolved, unsent root, with a confirm popover.
- File action (via `railHeaderActions`): "Send N to swarm" when N > 0. A dialog lists the N comments with checkboxes (all checked), then sends.
- After success: toast "Sent N comment(s) · task <short id>" linking to `/tasks/<id>`. Invalidate comment queries. Show skipped reasons if any.

**File**: `apps/ui/src/components/comb/folder-comments.tsx` (new), mounted in `folder-view.tsx` (step-5) in one marked place
**Changes**: when `features.has("comment-path-prefix")`, an "Open comments" panel under the grid: `comment-list {pathPrefix: <folder>}` grouped by file, with the same "Send N to swarm" for the folder (`scopePath` = folder). Hidden when the feature is missing.

#### 5. Tests
**File**: `src/tests/comb-review-batch.test.ts` (new)
**Changes**: temp DB (`initDb`), a mocked agent-fs via the provider's `fetchImpl` option (`src/fs/agent-fs-provider.ts:19,71`), `COMB_ENABLED=true` + `AGENT_FS_*` env. Cases:
- Happy path: 3 comments → one task with `source "comb"`, `taskType "comb-review"`, assigned to the lead; the task text contains every comment id, path, quote, and body; 3 sent replies posted.
- Second call with the same ids → 409, no new task.
- Two concurrent calls with overlapping ids → exactly one task; the loser skips the overlap.
- Resolved, reply, and already-marked comments are skipped with reasons.
- Task creation throws → claims released (a retry succeeds).
- Flag off → 404. Wrong drive → 400. More than 50 ids → 400.
- Reply posting fails → still 201, KV row prevents re-send.
**File**: `src/tests/comb-markers.test.ts` (new)
**Changes**: server and UI sent-marker regexes agree on the same fixtures.
**File**: `apps/ui/src/lib/comb/batch.test.ts` (new)
**Changes**: `eligibleForBatch` cases.

Template tests: after tests that clear the registry, call `restoreAllTemplateDefinitions()`. Run the prompt template suites to be sure the new templates pass their global checks.

### Success Criteria:

#### Automated Verification:
- [ ] Server tests pass: `bun run test:root -- src/tests/comb-review-batch.test.ts src/tests/comb-markers.test.ts src/tests/prompt-template-session.test.ts src/tests/prompt-template-remaining.test.ts`
- [ ] UI tests pass: `bun run test:root -- apps/ui/src/lib/comb/batch.test.ts`
- [ ] Typecheck: `bun run tsc:check`
- [ ] Route checks: `bun run check:rbac-coverage && bun run check:openapi-response-coverage`
- [ ] OpenAPI committed: `bun run docs:openapi && git diff --exit-code openapi.json`
- [ ] Promise checks: `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`
- [ ] DB boundary: `bash scripts/check-db-boundary.sh`
- [ ] Dashboard: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`

#### Automated QA:
- [ ] Local Comb loop with agent-fs from `$AFS` including step-1. A registered lead agent exists (`docker compose -f docker-compose.local.yml up` for lead + worker, or register a lead through the API as in `src/tests/kv-http.test.ts` seeding for a no-LLM check).
- [ ] As the QA human, add three comments with `@swarm` on `comb-qa/notes.md` and one without. The rail header shows "Send 3 to swarm". Send. The toast links to a task. `GET /api/tasks/<id>` shows `source: "comb"`, the lead as assignee, and all three comment ids in the text. Each of the three threads shows "Sent to the swarm · task ...". The unmarked one does not.
- [ ] Press send again on the same file: the button is gone (N = 0). `curl -X POST /api/comb/review-batches` with the same ids answers 409.
- [ ] Folder: comments on `comb-qa/a.md` and `comb-qa/sub/b.md` → the `comb-qa/` folder view's "Open comments" lists both, "Send 2 to swarm" creates one task.
- [ ] `COMB_ENABLED=false` → the route answers 404.
- [ ] Screenshots + recording of the send flow, uploaded per LOCAL_TESTING.md.

#### Manual Verification:
- [ ] Taras reads the rendered task prompt (`GET /api/tasks/<id>`) for one real batch and approves the wording.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.
