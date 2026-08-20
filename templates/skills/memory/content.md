# Memory

Swarm memory is a store of short texts with embeddings, searchable by meaning and by keyword. Recall is automatic: the runner puts the best matches for your task in the task message under "Relevant Past Knowledge". Everything else is a tool call.

## What is stored without you

| Source | When | Scope |
|---|---|---|
| `task_completion` | `store-progress` with status `completed` or `failed` | `agent`, or `swarm` for research tasks and tasks tagged `knowledge` or `shared` |
| `session_summary` | your session ends | `agent` |
| `file_index` | a file written under `/workspace/personal/memory/` or `/workspace/shared/memory/<agentId>/` on a harness with the file hook (claude, pi, opencode) | by path |

Automatic tasks (schedules, heartbeat, monitors) skip the `task_completion` write unless `store-progress` gets `persistMemory: true`.

Prefer `memory-store` over memory files. It works on every harness, including the remote ones.

## Tools

| Tool | Use |
|---|---|
| `memory-store` | create a memory: `content`, `name`, `scope`, optional `tags`, `taskId`, `intent` |
| `memory-search` | find memories: `query`, `intent` (required, why you search), `scope` (`all`, `agent`, `swarm`), `limit` |
| `memory-get` | the full content of one memory by ID |
| `memory-edit` | change a memory in place: mode `replace` (whole content) or `exact` (one unique substring), `intent` required |
| `memory-delete` | remove a memory by ID |
| `memory_rate` | mark a memory you used in this task as useful or misleading |
| `inject-learning` | lead only: push a learning into a worker's memory at swarm scope |

Seed scripts (`script-run` with `name` and `args`):

- `task-context-gathering` `{ taskId, queries: [...] }`: the task plus a deduplicated multi-query recall in one call.
- `smart-recall` `{ queries: [...] }`: multi-query recall without the task.
- `memory-dedup-check` `{ text, threshold? }`: near-duplicates of a candidate memory, default threshold 0.85.

## What makes a good memory

- One fact per memory: a fix, a pattern, a gotcha, a preference of a person, a fact about a repo or a host.
- The context it applies to: repo, host, tool, version.
- The evidence: what you saw, where.
- A searchable `name`: "Linear API rejects issue updates without teamId", not "notes".
- Under 2,000 characters stores as one chunk. Longer content splits on headings, one memory per chunk.

Skip what a tool returns on demand (paths, tool lists, task status), what the repo already records (README, CLAUDE.md, git history), and what only mattered for this one task.

A memory must not contain a token, password, key, or connection string. Remove the value and keep the reference ("the Linear token lives in config key LINEAR_API_KEY").

## Scope

- `agent` (default): only you recall it. Your own setup, your working notes, your mistakes.
- `swarm`: every agent recalls it. Facts about shared repos, hosts, people, and processes. Choose `swarm` when a second agent would hit the same thing.

## Before you store

1. Run `memory-dedup-check` with the text, or `memory-search` with one or two queries and `intent: "dedup before store"`.
2. A near-duplicate exists: `memory-edit` it. Mode `replace` for a rewrite, mode `exact` for a one-line correction. Say why in `intent`.
3. Nothing close exists: `memory-store`.

## Triage

- A memory is wrong: `memory-edit` with the correction.
- A memory is stale and nobody needs it: `memory-delete`.
- A recalled memory helped or misled you: `memory_rate` with `useful` true or false and a short `note`. The call needs a task context and counts once per memory per task. Ratings move the memory up or down in future searches.

## Lead: promote a learning

When a worker's output or failure holds a lesson other workers need, call `inject-learning` with the worker's `agentId`, the `learning`, and a `category`: `mistake-pattern`, `best-practice`, `codebase-knowledge`, or `preference`. It lands at swarm scope and every agent recalls it.
