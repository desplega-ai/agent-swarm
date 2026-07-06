---
name: download-task-attachment
description: Fetch a file attached to your current task in ONE call. Use whenever a task carries an attachment (an image, PDF, or other file the requester uploaded) and you need its bytes on disk — the dispatch prompt lists attachments with a ready-to-run curl command, but if you're improvising (resumed session, follow-up task, or the recipe scrolled out of context) use this skill instead of reaching for the `agent-fs` CLI directly.
---

# Download a Task Attachment

Task attachments (files uploaded via the UI or API onto a task) are served
through a single **provider-agnostic** REST route — regardless of whether the
backing storage is `local-fs` or `agent-fs`. You do not need to know or care
which provider is active, and you do not need `agent-fs org`/`agent-fs drive`
discovery.

## The one-call recipe

```bash
curl "$MCP_BASE_URL/api/fs/tasks/$AGENT_SWARM_TASK_ID/files/<attachmentId>/raw" \
  -H "X-Agent-ID: $AGENT_ID" \
  -H "Authorization: Bearer ${AGENT_SWARM_API_KEY:-$API_KEY}" \
  -o /tmp/<name>
```

- `$MCP_BASE_URL`, `$AGENT_ID`, `$AGENT_SWARM_TASK_ID` (or `$AGENT_SWARM_AGENT_ID`/`TASK_FILE`-derived taskId), and `$AGENT_SWARM_API_KEY`/`$API_KEY` are already present in every worker container's env — no new plumbing needed.
- `<attachmentId>` and `<name>`/`mimeType` come from the task's attachment list (see below).
- The route resolves the active file-storage provider (`local-fs` in dev, `agent-fs` in prod) server-side and streams the raw bytes back with the correct `Content-Type` — you get one call no matter which provider is behind it.

## Finding the attachment ID

If the dispatch prompt already injected an `## Attachments` section with the
curl command pre-filled, just run it — that's the fast path (see
`buildAttachmentsSection()` in `src/commands/runner.ts`).

Otherwise, pull it from the task:

```
get-task-details taskId=<your task id>
```

The response includes an `attachments` array: `{id, name, mimeType, sizeBytes}`.
Use `id` as `<attachmentId>` in the curl above.

## Why not the `agent-fs` CLI directly?

`agent-fs` is a general-purpose CLI for the swarm's own agent-fs filesystem —
it requires you to already know the org/drive a file lives in, and task
attachments don't always carry that (older rows, or attachments stored via
`local-fs` in dev have no org/drive at all). Reaching for `agent-fs cat` /
`agent-fs download` on a task attachment means guessing subcommand names,
discovering the right org via `agent-fs org list`, and re-trying — several
tool calls where one `curl` suffices. This was root-caused from a real
session that burned 7 tool calls (~64s) doing exactly that detour before
succeeding; see `runbooks/harness-providers.md` and PR that added
`buildAttachmentsSection()` for the full trace.

## Gotchas

- The route requires `X-Agent-ID` + bearer auth like any other swarm API call — same headers you'd use for any MCP-adjacent REST call.
- `mimeType` on the attachment record reflects the real upload `Content-Type` (not a filename-extension guess) — trust it when deciding how to handle the downloaded bytes (image vs PDF vs text).
- If you get a 404, double-check you're using the **attachment ID** (from `attachments[].id`), not the display `name`.
