# sql-admin-only

Blocks `db-query` tool calls made on a task whose creator (`requestedByUserId`) is not an admin. Every other tool call passes untouched.

| Task creator | `db-query` |
|---|---|
| Not set, or the call has no task | Allowed |
| Set, holds an admin role | Allowed |
| Set, no admin role | Blocked |
| Set, but the lookup fails, times out, or the task row is missing | Blocked |

No config. "Admin" means the user holds the RBAC role named `admin` (`principal_roles` joined to `roles`). It is not the free-text `users.role` label. Every new user gets the built-in `admin` role by default, so the gate only blocks users whose admin role was removed, for example users moved to `requester` or `viewer`.

The task comes from the call's `X-Source-Task-Id` header. The lookup gets 60% of `EXTENSION_HANDLER_TIMEOUT_MS` (default 5s), because the dispatcher lets a call through when a hook times out.

Coverage limits:

- Only agent MCP tool calls run `pre.tool.call`. Scripts calling `ctx.swarm.db_query`, extensions, and direct `POST /api/db-query` requests skip the hook.
- A call without an `X-Source-Task-Id` header has no task, so it is allowed.
