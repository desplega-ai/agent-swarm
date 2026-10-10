---
id: step-11
name: Live updates
depends_on: [step-7, step-3]
status: done
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
- [x] UI unit tests pass: `bun run test:root -- apps/ui/src/lib/agent-fs/`
- [x] Typecheck: `bun run tsc:check`
- [x] Dashboard: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`

#### Automated QA:
- [x] Local Comb loop with agent-fs from `$AFS` including step-3 (`/health` lists `change-stream`). `agent-browser` opens `comb-qa/notes.md`. The header shows "Live".
- [x] From the CLI under a second key: edit the file, add a comment, reply, resolve. Each change appears in the open tab within 2 s without a reload (`agent-browser snapshot` before/after, and `agent-browser eval` that the network log shows no comment-list poll while live).
- [x] Folder: `comb-qa/` folder view open, a CLI write of `comb-qa/new.md` adds a grid row within 2 s.
- [x] Kill the local agent-fs server: the header switches to "Polling" / retrying. Restart it: back to "Live" within 30 s, and data refreshes.
- [x] Point at agent-fs v0.14.0 (compose image): header shows "Polling", comments still refresh every 10 s, no console errors.
- [ ] Screenshots + recording of a live update, uploaded per LOCAL_TESTING.md.

#### Manual Verification:
- [ ] After rollout, Taras keeps a prod Comb tab open for 10 min and confirms it stays "Live" through the Fly proxy.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.

## Implementation Notes

Commit `fb05d4f10` on `comb/s11` (worktree `/Users/taras/worktrees/agent-swarm/2026-09-30-comb-s11`, on the wave-3 tip `d88c49629`). Evidence in `/tmp/comb-run/step-11/` (screenshots `01-*.png` to `14-*.png`, recording `live-updates.webm`, HARs `idle-live.har` and `idle-v014.har`). The upload box stays open: the orchestrator uploads the evidence.

Verification notes:
- Tests: 53 pass across the 7 files in `apps/ui/src/lib/agent-fs/` (sse 6, stream 11, invalidation 6 are new). `lib/comb` + `components/comb`: 179 pass. `tsc:check`, `apps/ui` lint (plain `bun run lint`, no Biome crash), `tsc -b`, `check:tokens`, and both promise checks pass. `stream.test.ts` uses bun's `jest.useFakeTimers()` + `advanceTimersByTime` (works in Bun 1.4) and a duck-typed fetch `Response`, so every read stays in microtasks.
- QA (API 3310, UI 3311, agent-fs 7411, session `comb-s11`): a human key in the browser and a second "agent" key on the CLI. The agent's edit, comment add, reply, reopen, and resolve each showed in the open tab about 110 ms after the CLI returned (the time is mostly the `agent-browser wait` call). `comb-qa/new.md` and a new subfolder `comb-qa/sub/` appeared in the folder grid and tree the same way.
- No poll while live: a 25 s idle HAR had zero requests to agent-fs (no `comment-list`, `stat`, or `ls`). The harness blocks `agent-browser eval`, so the HAR replaced the eval check.
- Kill agent-fs: "Polling" at once, tooltip "The change stream dropped...". Restart, then an edit before the stream reconnected: "Live" 4.4 s after the edit, the edited text 13 ms after "Live" (the `ready` refetch).
- v0.14.0: the compose image is not local, so the check ran the `v0.14.0` tag from source (`git archive` of the agent-fs worktree into `/tmp/comb-run/step-11/afs-014`, read-only) on the same agent-fs home. `/health` listed only `share-links`. The header showed "Polling" with "This agent-fs server has no change stream...", a CLI comment showed after 2.7 s, a 31 s HAR showed `stat`, `ls`, and both `comment-list` path forms at +0, +10, +20 s, and no `/events` request. `agent-browser console` and `errors` had no errors.
- The human's own CLI edit refreshed the content with no chip. 390 px and light mode checked (`13-*.png`, `14-*.png`).
- Not browser-tested: the 5 min hidden-tab pause (it needs a hidden tab for 5 min), and "stopped" through a real removed member or reset key (unit tests cover 401 and 404).

Decisions and deviations:
- `openDriveStream({client, orgId, driveId, onEvent, onState, signal})`, not `{endpoint, apiKey, ...}`: the key stays in `AgentFsClient` (new `openEvents(orgId, driveId, {signal})`, which returns the body; `send` gained an `accept` option).
- The stream follows the drive in the route (`useMatch("/file/~/:orgId/:driveId/*")` in the provider), and opens only on Comb pages. Other dashboard pages hold no stream, so a user with many dashboard tabs does not hit the 8-stream cap. One stream per tab.
- Polling while live: `stat`, `ls`, and comment queries use `refetchInterval: drivePoll(access, target)` (false while `access.liveDriveId === target.driveId`, else 10 s). The plan named only comments. `stat` and `ls` also stop, because the events refresh them. `AgentFsAccess` gained optional `liveDriveId`.
- `file.changed` invalidates `stat` and `ls` only (every ancestor folder, not just the parent: a new or emptied subfolder changes the grandparent's listing). Content, media, and log keys end with the `stat` revision, so invalidating them too would refetch the old revision's bytes (or mint a new media URL) before `stat` moves. Diff keys name two fixed versions. The plan listed content, media, and log.
- `ready` (first connect and every reconnect) invalidates every `stat`, `ls`, and `comments` query of the drive (`LIVE_QUERY_KINDS`), not every `["agent-fs", endpoint, userId]` query. Those three kinds are exactly the ones that stop polling. A full-prefix invalidation would re-download revision-keyed bytes and restart videos and PDFs on each reconnect. It runs on the first `ready` too, because the queries fetched before the stream opened can miss events.
- Batching is a fixed 50 ms window from the first event (bounded latency), coalesced by `hashKey`.
- Any 4xx other than 429 stops the stream (a superset of 401/404, like `agentFsRetry`). 429 waits `backoffDelay(cap)`, 15-30 s. Jitter picks a point in the upper half of each step, so a delay never passes 30 s.
- `liveState` adds `off` (no stream: not ready, no drive in view, or no `change-stream`) and `paused` (hidden more than 5 min) to the four stream states. The indicator says "Live" only for `live`.
- The "Updated to vN" chip listens through `subscribeLive` (a context callback), so an event re-renders only the chip, not every context reader. It skips `delete` events and the user's own actor id.
- The provider does not recheck `me` on a stream 401. The `stopped` state brings polling back, and the next poll's 401 moves Comb to `invalid-key` through the existing recheck.

Notes for later steps and the merge:
- Context (`useAgentFs()`): `liveState: LiveState` (`"off" | "paused" | "connecting" | "live" | "retrying" | "stopped"`), `liveDriveId: string | null`, `subscribeLive(listener) => unsubscribe` (`AgentFsLive` in `hooks/use-agent-fs-live.ts`). `LiveState` is also exported from `contexts/agent-fs-context.tsx`.
- Step-9: the folder comment list key must be `agentFsCommentsKey(access, folder, "prefix", folder.path)` (folder path with a trailing "/") for `comment.changed` to refresh it. It should also pass `refetchInterval: drivePoll(...)` (the helper is private in `use-agent-fs.ts`; export it or inline the rule) so it stops polling while live.
- Step-8: mentions and notifications are user-targeted and not in the drive stream. They keep their own poll.
- Step-10: `useAgentFsLog` / `useAgentFsDiff` need nothing: log keys move with `stat`, diffs never go stale.
- Merge spots: `file-header.tsx` (one import + the `UpdatedChip` line after `<time>` in the facts `<p>`, marked `step-11`), `pages/comb/page.tsx` (one import + the first item of the header action div, marked `step-11`), `use-agent-fs.ts` (`AgentFsAccess.liveDriveId`, `drivePoll`, one `refetchInterval` line in `agentFsLsQuery`, `useAgentFsStat`, `agentFsCommentsQuery`). `file-view.tsx` is unchanged.
- Event types (`DriveEvent`, `FileChangedEvent`, `CommentChangedEvent`, `DriveReadyEvent`) live in `lib/agent-fs/stream.ts`, not `types.ts`. `combEventPath(path)` in `lib/agent-fs/invalidation.ts` gives the Comb path form.
- Observed, not caused here: files written with the `write` op have no `currentVersion` in `stat` on this local setup (the header shows no "vN", the author reads "unknown", and `FileView` runs its folder probe `ls <file>/`). The chip shows the event's version, so it still reads "Updated to v2".

### Review fixes

Commit `6aec5599f` on `comb/s11`, on top of `fb05d4f10`. Evidence in `/tmp/comb-run/step-11/`: `fix-01-*.png` to `fix-09-*.png`, `fix-qa-log.txt` (the summary), `fix-burst-cli.txt`, `fix-burst-fast.txt`, `fix-reload-race.txt`.

Verification: 260 tests pass across `lib/agent-fs`, `lib/comb`, `components/comb`, and `hooks` (the new async test files passed 5 runs in a row). `tsc:check`, `apps/ui` lint (plain `bun run lint`, no Biome crash), `tsc -b`, `check:tokens`, and both promise checks pass.

Per review item:
1. and 2. One rule, in `createLiveBatcher` (`lib/agent-fs/live-batcher.ts`): a fetch that is in flight when a batch flushes can have started before the event, so it is stale. The batcher refetches after it and never cancels it. It invalidates the idle matching queries (`predicate: fetchStatus !== "fetching"`), lets the in-flight fetch land, then invalidates that query again (`exact`, `cancelRefetch: false`, in a microtask after the settling dispatch). The same rule covers the first `ready` (no data yet: react-query joins the first fetch, which clears `isInvalidated`). I chose "refetch after it" over cancel-then-invalidate, because cancel-then-invalidate starves under the fix-1 burst too. Cost: one extra fetch per query when the in-flight fetch started after the event. Unit tests: 20 events 60 ms apart with a 100 ms fetch (the data moves 11 times during the burst), an event during the first fetch, an event during a refetch. The old invalidate path fails all three.
3. The full version. Every tab closes its stream after 10 s hidden (`watchHidden`, `HIDDEN_CLOSE_MS`). The `ready` resync covers the gap. For `http:` endpoints, `openSharedDriveStream` with `browserStreamShare(name)` (`lib/agent-fs/stream-share.ts`) elects one tab per drive with `navigator.locks` (name `comb-live <endpoint> <userId> <orgId>/<driveId>`). The lock holder opens the stream and relays its states and events through a `BroadcastChannel` of the same name. Followers apply the relayed events. They poll unless the relayed state is `live`, and they resync with a local `ready` when it turns `live`. A `stopped` leader keeps the lock, so the other tabs do not retry a refused stream. A refused lock falls back to an own stream. The indicator tooltip on a follower says "Another Comb tab holds the change stream for this drive and sends its changes to this tab." Limits: Web Locks need a secure context (`http://localhost` is one). A dashboard served over plain http from another host has no `navigator.locks`, so each tab streams alone there (plus the 10 s hidden close). Tabs on different drives of one `http:` host still hold one stream each.
4. The stream state is keyed by the stream name (endpoint, user, org, drive) and reset on teardown. A new drive starts at `connecting`, and `liveDriveId` never names a drive whose stream is not live.
5. `createLiveBatcher.add` drops a key that a pending key covers (equal, or under a pending prefix such as the `ready` resync's `(..., "stat")`) and removes the pending keys a new prefix covers.
6. A 429 waits exactly `STREAM_BACKOFF_CAP_MS`. agent-fs sends no `Retry-After` for its stream cap (only its rate-limit middleware does), so the client does not parse one. The 429 test does not mock `Math.random`. Only the two backoff-schedule tests pin it.
7. The SSE parser scans only the new chunk and keeps the unfinished line as pieces that it joins once. A CR at the end of a chunk ends its line at once, and a LF at the start of the next chunk is skipped. A pending event (its data lines plus the unfinished line) over `SSE_MAX_PENDING` (1 MiB of characters) throws `SseOverflowError`. `connectOnce` then closes the connection and the stream reconnects with the backoff. Tests: chunk-final CR (no trailing ping), CR then LF across chunks (with an empty chunk between), a 1 MB line in 64-byte chunks within 2 s (the old parser took 20 s), both overflow forms, and an overflow that reconnects.
8. `drivePoll(access, target, kind)` and `COMB_POLL_MS` moved to `lib/agent-fs/invalidation.ts`. `drivePoll` returns false only for a `LIVE_QUERY_KINDS` kind of the live drive. `agentFsFolderCommentsKey(access, folder)` there too. It equals `agentFsCommentsKey(access, folder, "prefix", folder.path)`, and `keysToInvalidate` builds the folder keys with it. Both live in lib (not in `use-agent-fs.ts`), so the pure invalidation module can import the builder and the root test runner can test `drivePoll`.
9. The batcher is in `lib/agent-fs/live-batcher.ts` with injected `LiveTimers` and tests (batch window, coalescing, burst, first fetch, refetch, dispose, and `watchHidden` for the visibility pause). `stream.test.ts` has no microtask loop: the fetch mock resolves `called(n)` per call, a stream `push()` resolves when the reader asks for the next chunk, and `flush()` is a `setImmediate` macrotask (bun's fake timers leave it real). New tests: 503 retries with the backoff, and an oversized event reconnects.
10. The "Updated to vN" chip is `Badge variant="outline" size="tag"` with `border-status-info/30 text-status-info-strong` only. The live indicator is `StatusIcon` plus the visible word: `success` for live, `busy` for connecting and retrying, `warning` for stopped, `saved` (the quiet check) for off and paused, because polling still refreshes the view. The reason is the `StatusIcon` label, so it owns the tooltip, the focus stop, and the polite live region. Not `StatusLine`: a tooltip needs a focusable trigger, and a `tabIndex` on a `span` or `output` fails Biome `noNoninteractiveTabindex`. The dashboard-ui skill puts a status explanation in the `StatusIcon` label.

Found in the re-QA and fixed (outside the step-11 files, marked `step-11`): the burst QA froze on "Burst edit 10 of 20" while agent-fs served edit 20. Streamdown 2.5.0 memoizes every block (paragraph, headings, list items, code) by `className` and source position only. An edit that keeps a block's line and columns (edits 10 to 20 have the same length) never rendered. This also hit polling before step-11, for example a typo fix of the same length. `CombMarkdown` now passes `key={text}` to `Streamdown`, so a new text remounts it. `components/comb/viewers/comb-markdown-update.test.tsx` renders two same-length versions in happy-dom (red before the fix, green after). The comment rail's `useDomTextSpace` rebuilds through its MutationObserver.

Re-QA (API 3310, UI 3311, agent-fs 7411 on `http:`):
- Burst: 20 CLI edits in 3.2 s. The tab showed each edit about 60 to 70 ms after its write. 20 HTTP writes 60 ms apart: the view changed 15 times during the 1.4 s burst and showed the last edit 72 ms after it.
- First load: reload while the agent writes every 60 ms (3 rounds of 40 edits, 4 rounds of 8 edits with the last one during page load). Every round ended on the last edit.
- Hidden tab, measured by the free stream slots of the human key (agent-fs allows 8 per user): the browser held 1 stream while visible and at 5 s hidden, 0 at 12 s hidden, and 1 again after return. An edit made while hidden showed on return.
- Two tabs on `http:`: the browser held 1 stream with two Comb tabs open. The follower showed an edit 114 ms after the write, with the relayed tooltip and the "Updated to vN" chip. After the leader was hidden 10 s, the follower took over (own-stream tooltip, still 1 stream) and showed the next edit after 114 ms. The first tab then followed again.
- agent-fs stopped: "Polling" with the busy spinner. Restarted: "Live". No console errors.

Updated exports for the merge (all under `apps/ui/src/`):
- `lib/agent-fs/invalidation.ts`: `LIVE_QUERY_KINDS` (now `readonly string[]`), `COMB_POLL_MS`, `drivePoll(access, target, kind)`, `agentFsFolderCommentsKey(access, folder)`, `keysToInvalidate`, `combEventPath`, `LiveKeyContext`.
- `lib/agent-fs/live-batcher.ts` (new): `createLiveBatcher({queryClient, windowMs?, timers?})`, `LiveBatcher`, `LIVE_BATCH_MS`, `LiveTimers`, `watchHidden({doc, ms, onChange, timers?})`, `VisibilitySource`.
- `lib/agent-fs/stream-share.ts` (new): `openSharedDriveStream`, `browserStreamShare`, `SharedStreamOptions`, `StreamShare`, `LockRequester`, `RelayChannel`.
- `lib/agent-fs/sse.ts`: `SSE_MAX_PENDING`, `SseOverflowError`.
- Context (`useAgentFs()`): adds `liveRelayed: boolean` (true while `live` comes from another tab).
- `api/hooks/use-agent-fs.ts`: the private `drivePoll` and `COMB_POLL_MS` are gone. It imports `drivePoll` from `@/lib/agent-fs/invalidation`, and the three call sites pass `"ls"`, `"stat"`, and `"comments"`.
- Step-9's folder comment panel: `queryKey: agentFsFolderCommentsKey(access, folder)` and `refetchInterval: drivePoll(access, folder, "comments")`, both from `@/lib/agent-fs/invalidation`. `folder.path` ends with "/".
- `components/comb/viewers/comb-markdown.tsx`: one `key={text}` line plus its comment, marked `step-11`.
