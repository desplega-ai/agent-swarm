---
id: step-11
name: Live updates
depends_on: [step-7, step-3]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-11: Live updates

**Repo:** agent-swarm. Needs agent-fs step-3 (`GET /orgs/:orgId/drives/:driveId/events`, feature `change-stream`) and the step-5/step-7 query keys (`agentFsKey(endpoint, userId, "stat" | "content" | "ls" | "comments" | "log" | "diff", ...)`). Local QA runs agent-fs from `$AFS` with steps 1-3 applied.

## Overview

Comb subscribes to the agent-fs change stream with the human's key. When an agent (or anyone) writes a file or changes a comment, the open views refresh within about a second, without a reload. The stream opens once per drive in `AgentFsProvider`, not per file. While it is connected, comment polling is off. When the stream is missing (older agent-fs) or down, Comb falls back to today's 10 s polling. A small indicator in the Comb header shows "Live" or "Polling". This replaces the brainstorm's Yjs room idea (amendment 2026-09-30). There is no presence.

When done: an agent's reply and new version appear in an open Comb tab on their own.

## Changes Required:

#### 1. Stream client
**File**: `apps/ui/src/lib/agent-fs/sse.ts` (new)
**Changes**: incremental SSE parser for a `ReadableStream<Uint8Array>`: handles chunk boundaries, `event:`, multi-line `data:`, `id:`, comment lines (`: ping`), CRLF and LF, and a blank line as the dispatch point.

**File**: `apps/ui/src/lib/agent-fs/stream.ts` (new)
**Changes**: `openDriveStream({endpoint, apiKey, orgId, driveId, onEvent, onState, signal})`:
- `fetch(<endpoint>/orgs/<org>/drives/<drive>/events, {headers: {Authorization: Bearer, Accept: "text/event-stream"}, signal})` (EventSource cannot send headers).
- States: `connecting | live | retrying | stopped`. Reconnect with backoff 1 s, 2 s, 4 s ... capped at 30 s, with jitter, reset after 60 s of healthy connection. Treat 60 s without any byte (no ping) as a dead stream and reconnect.
- 401 / 404 → `stopped` (no retry). 429 → retry at the cap.
- Never log the key.

#### 2. Wiring
**File**: `apps/ui/src/lib/agent-fs/invalidation.ts` (new)
**Changes**: pure `keysToInvalidate(event, ctx)` → list of query-key prefixes:
- `file.changed` → `stat`, `content`, `media`, `log` for `path`; `ls` for the parent folder (and old/new parents on `mv`, which arrives as two events).
- `comment.changed` → `comments` for `path`, plus any `comments` prefix query whose prefix contains `path` (step-9 folder panel).
- reconnect → every `["agent-fs", endpoint, userId]` query.

**File**: `apps/ui/src/hooks/use-agent-fs-live.ts` (new), called once in `apps/ui/src/contexts/agent-fs-context.tsx`
**Changes**: when state is `ready` and `features.has("change-stream")`, open the stream and apply `keysToInvalidate` through `queryClient.invalidateQueries`. Debounce bursts (50 ms) and coalesce by key. Expose `liveState` on the context. Close on disconnect, credential change, and tab hidden for more than 5 min (reopen and invalidate everything when visible again).

**File**: `apps/ui/src/api/hooks/use-agent-fs.ts`
**Changes**: comment queries use `refetchInterval: liveState === "live" ? false : 10_000`. Mentions (step-8) keep their own 30 s poll; they are user-targeted and not in the drive stream.

**File**: `apps/ui/src/components/comb/live-indicator.tsx` (new), placed in the Comb page header
**Changes**: "Live" dot when `live`, "Polling" otherwise, tooltip with the reason (feature missing, reconnecting, stopped).

**File**: `apps/ui/src/components/comb/file-header.tsx`
**Changes**: when a `file.changed` arrives for the open file from another actor, show a small "Updated to v<N>" chip for 10 s. Content refreshes through invalidation. Keep the change to this file small.

#### 3. Tests
**File**: `apps/ui/src/lib/agent-fs/sse.test.ts` (new)
**Changes**: split across chunks at every byte offset of a sample stream, multi-line data, CRLF, pings ignored, trailing partial event not emitted.

**File**: `apps/ui/src/lib/agent-fs/stream.test.ts` (new)
**Changes**: with a mocked `fetch` returning controllable streams: backoff schedule, 401 stops, dead-stream timeout reconnects (fake timers), abort closes cleanly.

**File**: `apps/ui/src/lib/agent-fs/invalidation.test.ts` (new)
**Changes**: key lists for each event type, nested folder prefixes, reconnect.

### Success Criteria:

#### Automated Verification:
- [ ] UI unit tests pass: `bun run test:root -- apps/ui/src/lib/agent-fs/`
- [ ] Typecheck: `bun run tsc:check`
- [ ] Dashboard: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`

#### Automated QA:
- [ ] Local Comb loop with agent-fs from `$AFS` including step-3 (`/health` lists `change-stream`). `agent-browser` opens `comb-qa/notes.md`. The header shows "Live".
- [ ] From the CLI under a second key: edit the file, add a comment, reply, resolve. Each change appears in the open tab within 2 s without a reload (`agent-browser snapshot` before/after, and `agent-browser eval` that the network log shows no comment-list poll while live).
- [ ] Folder: `comb-qa/` folder view open, a CLI write of `comb-qa/new.md` adds a grid row within 2 s.
- [ ] Kill the local agent-fs server: the header switches to "Polling" / retrying. Restart it: back to "Live" within 30 s, and data refreshes.
- [ ] Point at agent-fs v0.14.0 (compose image): header shows "Polling", comments still refresh every 10 s, no console errors.
- [ ] Screenshots + recording of a live update, uploaded per LOCAL_TESTING.md.

#### Manual Verification:
- [ ] After rollout, Taras keeps a prod Comb tab open for 10 min and confirms it stays "Live" through the Fly proxy.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.
