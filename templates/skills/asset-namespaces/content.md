# Asset Namespaces

Use an asset `key` as directory-like grouping metadata across tasks, workflows, schedules, pages, apps, scripts, and mapped provider files. Keep identity separate: entity IDs remain authoritative, task `contextKey` remains routing context, and many assets may intentionally share one key.

## Choose a namespace

- Use `shared/` for general work and stable descendants such as `shared/releases/` or `shared/platform/migrations/` for team-visible groupings.
- Use `personal/<user-id>/` or a descendant only for work owned by the trusted resolved user in the current request or task context.
- Prefer durable organizational paths over temporary status labels. Put lifecycle state in task or workflow status fields, not paths such as `shared/in-progress/`.
- Supply canonical values: lowercase relative paths, forward slashes, and a trailing slash. The server trims, Unicode-normalizes, lowercases, and adds the trailing slash, but rejects empty segments, `.`, `..`, backslashes, absolute paths, NUL bytes, unknown roots, and values longer than 255 characters.

`personal/` is a write-ownership convention, **not** a privacy or read-visibility boundary. Continue to rely on each entity's authorization rules, and never place sensitive data under `personal/` merely because of the key.

## Set and inherit keys

Pass `key` when creating a task, workflow, schedule, or page. Omitting it creates a deterministic shared resource key such as `shared/task:<id>/`, `shared/workflow:<id>/`, `shared/schedule:<id>/`, `shared/page:<id>/`, or `shared/fs:agent-fs:<id>/`.

- Tasks sent from another task inherit the source task's key unless explicitly overridden.
- Tasks launched by a workflow inherit the workflow key unless the agent-task node supplies a key.
- Tasks launched by a schedule inherit the schedule key.
- Agent-fs task attachments receive logical file mappings and inherit their task key.

Use only a canonical user-registry ID in `personal/<user-id>/`. Do not substitute an agent ID, email address, Slack ID, or unverified caller-provided value. The API authorizes the destination against trusted request/task context and rejects mismatches.

## Find and manage assets

Use entity list tools with `key` for an exact namespace or `keyPrefix` for a subtree where those filters are exposed. For a lightweight cross-entity view, use `GET /api/assets` or the public page SDK:

```js
const result = await window.swarmSdk.assets.list({
  keyPrefix: "shared/releases/",
  types: "task,workflow,schedule,page,app,script,file",
  limit: 100,
});
```

Move an asset logically without changing its ID:

```js
await window.swarmSdk.assets.move("workflow", workflowId, "shared/platform/");
```

The full `swarmSdk.assets` domain is:

| Method | Purpose |
|---|---|
| `list(filters?)` | Return lightweight cross-entity summaries. |
| `move(entityType, id, key)` | Change local namespace metadata. |
| `registerMapping(body)` | Operator-only registration of a provider object under a logical key. |
| `audit()` | Operator-only structural and mapping-drift audit. |

Provider-backed moves are metadata-only: do not claim that a provider file, drive object, or agent-fs path was renamed or moved remotely. Repair audit warnings before retrying a blocked move.

## Before writing

1. Confirm whether the grouping is shared or owned by a resolved user.
2. Keep the key non-unique and separate from entity identity or routing context.
3. Pass the key at the highest-level parent so descendants inherit it.
4. Use exact and prefix filters instead of scanning unrelated records.
5. Treat personal namespaces and provider mappings according to their real authorization and remote-move limits.
