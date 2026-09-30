---
id: step-3
name: agent-fs drive change stream
depends_on: [step-2]
status: claimed
assignee: orchestrator-codex-step-3
claimed_at: 2026-09-30T12:10:00Z
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-3: agent-fs drive change stream

**Repo:** agent-fs (`$AFS` = `/Users/taras/Documents/code/agent-fs`). Builds on step-1 and step-2 (`SERVER_FEATURES`, mention code in `comment.ts`).

## Overview

agent-fs gains a per-drive change stream. `GET /orgs/:orgId/drives/:driveId/events` returns Server-Sent Events to any drive member with a Bearer key. It emits `file.changed` for every committed file version and `comment.changed` for every comment mutation. The dashboard uses it to refresh files and comments live, including edits made by agents through the CLI, MCP, or FUSE. `/health` adds `change-stream`.

Facts this design relies on:
- Every file content or path change commits through `createVersion` (`packages/core/src/ops/versioning.ts:153-240`), from write, edit, append, rm, mv, cp, revert, the raw PUT route, and FUSE IPC (all in the server process).
- There is no in-process bus today. Prod runs one Fly machine (`fly-deploy.yml` uses `--ha=false`, one volume), so an in-process bus reaches every subscriber.
- Bun closes a connection after 10 s of inactivity by default (`idleTimeout`), including a streamed response. The stream needs a heartbeat under 10 s.
- Browsers cannot set headers on `EventSource`. The dashboard uses `fetch` with a Bearer header and parses the stream. So the route uses the normal auth middleware.

## Changes Required:

#### 1. In-process bus
**File**: `packages/core/src/events/bus.ts` (new)
**Changes**: minimal typed pub/sub keyed by drive id:
```ts
export type DriveEvent =
  | { type: "file.changed"; driveId: string; path: string; version: number; operation: "write"|"edit"|"append"|"delete"|"revert"; actor: string; at: string }
  | { type: "comment.changed"; driveId: string; path: string; commentId: string; parentId: string | null;
      action: "created"|"updated"|"resolved"|"reopened"|"deleted"; actor: string; at: string };
export function publishDriveEvent(e: DriveEvent): void;
export function subscribeDrive(driveId: string, fn: (e: DriveEvent) => void): () => void;
```
A listener that throws must not break publishing or other listeners. Export it from the core package entry the server already imports.

#### 2. Publish points
**File**: `packages/core/src/ops/versioning.ts` (`createVersion`, ~153-240)
**Changes**: publish `file.changed` AFTER the `ctx.db.transaction(...)` returns (never inside it, so a rolled-back write publishes nothing). Include `path`, the new `version`, `operation`, `actor = ctx.userId`. The dedup short-circuit in `write.ts:92-103` creates no version and publishes nothing, which is correct.

**File**: `packages/core/src/ops/comment.ts`
**Changes**: publish `comment.changed` after each successful mutation: add (`created`), update (`updated`), resolve (`resolved`), reopen (`reopened`), delete (`deleted`). Put one small helper next to `emitEvent` (:25-50) and call it at each site. Include `path` and `parentId` so a folder view can match by prefix.

#### 3. SSE route
**File**: `packages/server/src/routes/events.ts` (new), mounted in `packages/server/src/app.ts` next to `fileRoutes` (~103-107)
**Changes**:
- `GET /:orgId/drives/:driveId/events` under the `/orgs` prefix, behind `authMiddleware` (Bearer).
- Resolve membership with `resolveContext(db, {userId, orgId, driveId})` (`packages/core/src/identity/context.ts:14-50`), same as `files.ts:30`. Non-members get the same 404 as `/raw`.
- Use `streamSSE` from `hono/streaming`. First write an `event: ready` with `{driveId, at}`. Subscribe with `subscribeDrive`, write each event as `event: <type>` + JSON `data`. Write an SSE comment heartbeat (`: ping`) every 5 s (below Bun's 10 s idle timeout). Unsubscribe and stop the timer in `stream.onAbort`.
- Cap concurrent streams per user (for example 8) with an in-memory counter. Over the cap, answer 429.
- Confirm the global `bodyLimit`, request log, and rate-limit middlewares (`app.ts:35-64`) do not buffer or cut the stream. If the rate limiter counts a stream as one request, that is fine.

**File**: `packages/core/src/openapi.ts`
**Changes**: document the route (`text/event-stream`, event names, payload shapes). Regenerate `docs/openapi.json`.

**File**: `packages/server/src/features.ts`
**Changes**: append `"change-stream"`.

#### 4. CLI (debug aid)
**File**: `packages/cli/src/commands/` (new `watch.ts` or a subcommand of an existing drive command)
**Changes**: `agent-fs watch [--json]` streams events for the default drive to stdout until Ctrl+C. This gives step QA and agents a way to observe the stream. Keep it small.

#### 5. Skill + docs
**File**: `skills/agent-fs/SKILL.md`
**Changes**: one line for `agent-fs watch` and the stream endpoint.

#### 6. Tests
**File**: `packages/core/src/events/__tests__/bus.test.ts` (new)
**Changes**: subscribe/unsubscribe, drive isolation, a throwing listener does not stop others.

**File**: `packages/core/src/ops/__tests__/versioning-events.test.ts` (new)
**Changes**: each op (write, edit, append, rm, mv, cp, revert) publishes exactly the expected `file.changed` events after commit (mv publishes two). A write that fails with `EditConflictError` publishes nothing. A dedup write publishes nothing.

**File**: `packages/core/src/ops/__tests__/comment-events.test.ts` (new)
**Changes**: add, reply, update, resolve, reopen, delete each publish one `comment.changed` with the right `action`, `path`, and `parentId`.

**File**: `packages/server/src/__tests__/events-stream.test.ts` (new)
**Changes**: via `createApp(db, s3)`: a member receives `ready`, then a `file.changed` after a write through the ops route. A non-member gets 404. No key gets 401. The stream stays open across at least 12 s of silence and receives heartbeats (use a real `Bun.serve` on `port: 0`, not a hard-coded port). The 9th concurrent stream for one user gets 429. Closing the client unsubscribes (listener count back to 0).

### Success Criteria:

#### Automated Verification:
- [ ] Targeted tests pass: `cd "$AFS" && bun test packages/core/src/events packages/core/src/ops/__tests__/versioning-events.test.ts packages/core/src/ops/__tests__/comment-events.test.ts packages/server/src/__tests__/events-stream.test.ts`
- [ ] Full suite passes: `cd "$AFS" && bun run test`
- [ ] Typecheck passes: `cd "$AFS" && bun run typecheck`
- [ ] OpenAPI is fresh: `cd "$AFS" && bun run scripts/sync-openapi.ts && git diff --exit-code docs/openapi.json`
- [ ] Local e2e passes: `cd "$AFS" && bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only`

#### Automated QA:
- [ ] Local server (local storage). Terminal 1: `agent-fs watch --json` with user A's key. Terminal 2: user B writes a file, edits it, adds a comment, resolves it, and moves the file. Terminal 1 prints the matching `file.changed` / `comment.changed` events in order within 1 s each.
- [ ] `curl -N -H "Authorization: Bearer <A key>" http://localhost:7433/orgs/<org>/drives/<drive>/events` stays open for 60 s of silence and prints a `: ping` about every 5 s.
- [ ] A cross-origin browser `fetch` of the stream works: run a tiny page on another port (or `agent-browser eval` on any page) that fetches the stream with a Bearer header and logs the first event. CORS `*` allows it.
- [ ] `GET /health` lists `change-stream`.

#### Manual Verification:
- [ ] After merge (auto-deploy), Taras or the implementer runs the `curl -N` check against `https://agent-fs-taras.fly.dev` for 60 s to confirm the Fly proxy keeps the stream open.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes. Merging to agent-fs `main` deploys to prod Fly automatically.
