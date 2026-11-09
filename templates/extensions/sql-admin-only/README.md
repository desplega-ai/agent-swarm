# sql-admin-only

Blocks `db-query` tool calls made on a task whose creator (`requestedByUserId`) is not an admin. Every other tool call passes untouched.

| Task creator | `db-query` |
|---|---|
| Not set, or the call has no task | Allowed |
| The header's id has no task row (a session with no task) | Allowed |
| Set, holds an admin role | Allowed |
| Set, no admin role | Blocked |
| Set, but the lookup fails or times out | Blocked |

No config. "Admin" means the creator's `users.role` is `admin` (case-insensitive), the role the swarm shows next to a requester's name. Only Lead (`manage-user`) and REST callers with `user.role.manage` can set it. RBAC roles are not used, because every user is created with the RBAC `admin` role. A creator whose user row is gone counts as non-admin.

The task comes from the call's `X-Source-Task-Id` header. The lookup gets 60% of `EXTENSION_HANDLER_TIMEOUT_MS` (default 5s), because the dispatcher lets a call through when a hook times out.

Coverage limits:

- Only agent MCP tool calls run `pre.tool.call`. Scripts calling `ctx.swarm.db_query`, extensions, and direct `POST /api/db-query` requests skip the hook.
- A call without an `X-Source-Task-Id` header has no task, so it is allowed.
