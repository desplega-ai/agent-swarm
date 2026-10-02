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
| `memory-store` | create a memory: `content`, `name`, `scope`, optional `tags`, `taskId`, `intent`, `key` (a logical path, see Logical paths) |
| `memory-search` | find memories: `query`, `scope` (`all`, `agent`, `swarm`), `limit`, optional `intent` (why you search), `source`, `keyPrefix` (only memories whose key starts with it) |
| `memory-get` | the full content of one memory by ID |
| `memory-edit` | change a memory in place: mode `replace` (whole content) or `exact` (one unique substring), `intent` required. `newKey` alone moves it to another logical path |
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

## Logical paths (`key`)

Every memory has a `key`. By default it is an auto key (`<scope>/<source>/<id>`, or the file path for `file_index`), and the memory is **inbox material**: it keeps the lifecycle of its `source` and expires. Give it a path under `/longterm` and it becomes curated memory: findable by folder, ranked higher, and kept.

`name` is a title. `key` is the address. Use a key only for what should outlive the task: a durable fact, a decision, a person or customer. Leave working notes and task results without one; expiring is the right outcome for them.

### The `/longterm` roots

The list is closed. A key under `/longterm` whose second segment is not in it is refused, and the error lists the roots.

| Root | Holds | Rank weight | Who may write |
|---|---|---|---|
| `/longterm/company-story` | what the company is and does | 1.4 | lead only |
| `/longterm/entities/people/<slug>`, `/longterm/entities/customers/<slug>` | one doc per person or customer | 1.3 | lead only |
| `/longterm/facts/<topic>/<slug>` | a durable fact about a repo, host, tool, or process | 1.2 | any agent |
| `/longterm/decisions/<slug>` | a decision and why | 1.1 (0.3 with the tag `superseded`) | any agent |
| `/longterm/workstreams/<slug>` | an ongoing effort | 1.0 | any agent |
| `/longterm/timeline/<period>/<slug>` | dated events | 0.8 | lead only |

Agents and repos are not entity types: agent profiles and `get-repos` own them, so `/longterm/entities/agents/...` is refused.

Key shape: lowercase letters, digits, `-`, and `.` or `_` after the first segment; segments joined by `/`; starts with `/`; no trailing `/`; at most 200 characters. A key outside `/longterm` is not root-checked but must still have this shape.

### Write, move, find

```
memory-store key="/longterm/facts/swarm-runtime/sqlite-busy-retry" scope="swarm"
  name="SQLite BUSY_SNAPSHOT needs BEGIN IMMEDIATE" content="..."

memory-edit memoryId="<id>" newKey="/longterm/decisions/sqlite-busy-retry" intent="promote the fact to a decision"

memory-search query="busy retry" keyPrefix="/longterm/facts/swarm-runtime/"
```

- `memory-store`: one key per owner and scope. A second memory under a key you already use fails: `memory-edit` that one. If you pass no `key` and the `name` starts with `/longterm/`, the name is the key, so you set one field. An invalid name of that form is refused, never stored under an auto key.
- `memory-edit` `newKey`: pass it alone for a pure move. Every chunk of the document moves in one step. The ID, usefulness rating, access counts, and author stay. A key that is already taken is refused. Address the memory with `memoryId`, or with `key` plus `scope`.
- `memory-search` `keyPrefix`: a literal, case-sensitive prefix, applied before the top results are cut, not after. End a folder with `/` (`/longterm/entities/`, not `/longterm/entities`) to stay inside it.

### What a `/longterm` key changes

`source` stays provenance: there is no `longterm` source. The key is the tier. A memory under `/longterm` follows a `manual` memory's lifecycle whatever its `source`:

- It never expires. Storing under a `/longterm` key sets no expiry. Moving a memory in with `newKey` clears the expiry it had, on every chunk. Moving it back out does not restore one.
- It has no recency decay, and its source-quality multiplier is 1.5.
- Automated cleanup skips it.

A memory under any other key keeps its `source` lifecycle: `task_completion` expires after 7 days, `session_summary` after 3, `file_index` after 30, `manual` never.

Ranking multiplies similarity by recency decay, access boost, source quality, **path weight** (the table above, by longest matching root; any other key weighs 1.0), and usefulness. Path weight is one factor: a weak match under `/longterm/company-story` does not beat a strong match elsewhere on weight alone.

### Lead-only roots

Only the lead may write or move a key under `/longterm/company-story`, `/longterm/entities`, or `/longterm/timeline`. The check is the permission `memory.write.consolidated`. It applies to a `key`, to a `newKey`, to a `/longterm/` name, and to a `sourcePath` sent to `POST /api/memory/index`, so there is no side door. A worker that tries gets an error naming the lead-only paths. A worker puts durable knowledge under `/longterm/facts` or `/longterm/decisions`, or leaves the key off, and the lead consolidates the rest.

## Before you store

1. Run `memory-dedup-check` with the text, or `memory-search` with one or two queries and `intent: "dedup before store"`.
2. A near-duplicate exists: `memory-edit` it. Mode `replace` for a rewrite, mode `exact` for a one-line correction. Say why in `intent`.
3. Nothing close exists: `memory-store`. For a keyed memory, `memory-search` with `keyPrefix` set to the folder you will write into shows what is already there.

## Triage

- A memory is wrong: `memory-edit` with the correction.
- A memory is stale and nobody needs it: `memory-delete`.
- A recalled memory helped or misled you: `memory_rate` with `useful` true or false and a short `note`. The call needs a task context and counts once per memory per task. Ratings move the memory up or down in future searches.

## Lead: promote a learning

When a worker's output or failure holds a lesson other workers need, call `inject-learning` with the worker's `agentId`, the `learning`, and a `category`: `mistake-pattern`, `best-practice`, `codebase-knowledge`, or `preference`. It lands at swarm scope and every agent recalls it. It is stored as `manual`, so it never expires, but it takes no key: it has no path weight and `keyPrefix` does not find it. To file a learning by path, `memory-store` it with a `/longterm` key, or `memory-edit` it with `newKey`.
