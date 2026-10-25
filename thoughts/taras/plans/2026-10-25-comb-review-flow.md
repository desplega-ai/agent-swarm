---
date: 2026-10-25T14:45:00Z
topic: "Comb: send any comment, bulk resolve, recent and favorites, clean layout"
status: done
autopilot: true
---

# Comb: send any comment, bulk resolve, recent and favorites, clean layout

## Goal

Taras could not find "Send to swarm" in Comb. The button showed only on comments with `@swarm`,
and none of his 506 open comments had it (0 comments were ever sent from Comb). This PR makes
every open comment sendable, gives a clear batch send, lets him resolve old comments in bulk,
adds Recent, Recently viewed and Favorites, and tightens the layout. One PR, not merged.

## Facts (2026-10-25, prod drive, read-only)

- 506 open root comments on 111 files. 392 are older than 30 days, 351 are under `thoughts/`.
  0 carry `@swarm`. 0 were sent.
- The server never required `@swarm` (`src/tests/comb-markers.test.ts`). Only the UI did
  (`canSendThread` in `apps/ui/src/lib/comb/batch.ts`).
- The composer's submit button says "Send". It only saves a comment.
- agent-fs: `comment-resolve` is one comment at a time and needs the editor role. The `recent`
  op lists file versions newest first (`write`, `edit`, `append`, `delete`, `revert`).
- Favorites already exist as Comb "Pinned" (swarm `favorites`, item type `agent-fs-path`).
- No Comb "recently viewed" and no "full width" mode exist.
- Space above the panels: 56 px shell bar + 24 px main padding + 44 px Comb header + 12 px gap.

## Decisions

- Any open, unsent root comment can be sent. `@swarm` stays as a chip and keeps its own paint
  in the document. (asked: "yes to 1")
- Inspired by page feedback (`src/pages/feedback-overlay.ts`): comments are drafts until sent.
  A footer bar at the bottom of the comment panel shows "N not sent" and a primary
  "Send to swarm". The dialog lists the comments (checked, at most 50) and takes an optional
  note for the lead. (asked: "inspire by that")
- The composer button says "Add comment" (root), "Reply" (reply), "Save" (edit). (asked)
- The "Pending" state becomes "Not sent" (filter label, footer count). Cards no longer show a
  "Pending" line: the footer says it once. (assumed)
- The send body gets an optional `note` (at most 4000 characters). The `comb.review.batch`
  template renders it in a fenced block. Older UIs do not send it. (assumed)
- Bulk resolve lives in the folder "Open comments" panel: checkboxes, select all, an age filter,
  and a selection bar with "Send to swarm" and "Resolve". Resolve runs 4 at a time, then a toast
  with Undo (reopen). (asked: "Bulk resolve in Comb")
- "Pinned" is renamed "Favorites" (the dashboard's word). Same storage. (assumed)
- Recently viewed is stored in this browser, per swarm and drive, at most 20 files. (asked)
- Recent and Favorites show both on the Comb home (drive root) and as left panel tabs. (asked:
  "Both")
- Layout: Comb routes drop the main top padding. A "Full width" toggle hides both side panels
  and widens the text. It is stored in this browser. (asked: "clean af", top whitespace, full width)

## Phase 1: Send any comment, batch send with a note

- `lib/comb/batch.ts`: `canSendThread` drops the `@swarm` check.
- `lib/comb/thread-status.ts`, `thread-filter.ts`: "pending" means "not sent" (any open,
  unsent root). Filter label "Not sent".
- `components/comb/rail-filters.tsx`: `PendingSummary` becomes a footer `SendBar`: "N not sent"
  (toggles the filter) and a primary "Send to swarm" button.
- `components/comb/send-to-swarm.tsx`: the dialog gets "Note for the lead (optional)". Copy drops
  `@swarm`.
- `components/comb/swarm-state.tsx`, `comment-thread.tsx`: no "Pending" line on cards.
- `components/comb/comment-highlights.tsx`: the pending paint applies to `@swarm` comments only.
- `components/comb/comment-composer.tsx`: submit label per mode.
- `lib/comb/mentions.ts`: the picker's swarm item detail reads "Flag for the swarm".
- Server: `src/http/comb.ts` (`note`), `src/comb/review-batch.ts`, `src/comb/templates.ts`
  (`note_block`). `bun run docs:openapi`.
- Tests: `batch.test.ts`, `thread-status.test.ts`, `thread-filter.test.ts`,
  `src/tests/comb-review-batch.test.ts` (note rendered, note too long is 400).

Verification:
- `bun run test:root -- apps/ui/src/lib/comb src/tests/comb-review-batch.test.ts src/tests/comb-markers.test.ts`
- `cd apps/ui && bunx tsc -b && bun run lint`

Manual E2E:
- Add a comment without `@swarm`. The footer shows "1 not sent". Send it with a note.
- `curl -s "http://localhost:$API_PORT/api/tasks?limit=1" -H "Authorization: Bearer $KEY"`: the
  task text has the note block.

## Phase 2: Bulk resolve in the folder panel

- `lib/comb/bulk.ts` (new): `runLimited(items, limit, worker, onProgress)` and
  `olderThan(thread, days, now)`. Tests in `bulk.test.ts`.
- `components/comb/folder-comments.tsx`: a checkbox per comment and per file, select all, an age
  filter (Any age, Older than 7 days, Older than 30 days), and a selection bar ("N selected",
  "Send to swarm" for at most 50, "Resolve", clear).
- `api/hooks/use-agent-fs.ts`: `useBulkResolve(drive)` runs `comment-resolve` 4 at a time and
  invalidates the comment queries once. Undo reopens the same ids.

Verification:
- `bun run test:root -- apps/ui/src/lib/comb/bulk.test.ts`
- `cd apps/ui && bunx tsc -b && bun run lint`

Manual E2E:
- Seed 30 comments, 10 backdated is not possible through the op, so check the age filter with
  the unit tests and with the newest/oldest split on a seeded drive. Select all, Resolve, Undo.

## Phase 3: Recent, Recently viewed, Favorites

- `lib/comb/recent.ts` (new): `rememberViewed(list, entry, max)` and `recentChanges(entries, max)`
  (newest per path, deletes dropped). Tests in `recent.test.ts`.
- `lib/agent-fs/types.ts`: `RecentResult`. `api/hooks/use-agent-fs.ts`: `useRecentChanges`
  (op `recent`, an unknown op hides the list).
- `components/comb/recent-lists.tsx` (new): `RecentlyViewedList`, `RecentChangesList`,
  `FavoritesList` (from `pinned-list.tsx`).
- `components/comb/comb-home.tsx` (new): three cards above the drive root listing.
- `lib/comb/panels.ts`, `components/comb/side-panels.tsx`: left tabs Files, Recent, Favorites,
  Outline. Recent has Viewed and Changed. Favorites moves out of the Files tab.
- Rename "Pinned" to "Favorites" (`pin-button.tsx`, `pinned-list.tsx`, `comb-sidebar-pins.tsx`).

Verification:
- `bun run test:root -- apps/ui/src/lib/comb/recent.test.ts apps/ui/src/lib/comb/panels.test.ts`
- `cd apps/ui && bunx tsc -b && bun run lint`

Manual E2E:
- Open 3 files, go to the drive root: Recently viewed lists them, newest first.
- Write a file with `bun op.ts write`: Recently changed shows it within a minute.
- Star a file: it shows in Favorites (home, tab, sidebar).

## Phase 4: Clean layout

- `components/layout/root-layout.tsx`: Comb routes (`/file`) get no top padding.
- `pages/comb/page.tsx`: tighter header and panel gap.
- `lib/comb/panels.ts`, `comb-layout.tsx`: `fullWidth` (stored per browser). Showing a panel
  ends it. A header button and the `f` shortcut toggle it.
- `components/comb/viewers/markdown-viewer.tsx`: wider text in full width.

Verification:
- `bun run test:root -- apps/ui/src/lib/comb/panels.test.ts`
- `cd apps/ui && bunx tsc -b && bun run lint && bun run check:tokens`

Manual E2E:
- Screenshot a file page at 1440x900 before and after. Toggle full width with the button and
  with `f`. Click a comment highlight: the comment panel comes back.

## Phase 5: Drive-wide send tray

Taras, mid-run: "would be nice to have a way to group the messages sent to the swarm in a single
one". He picked a drive-wide tray (asked).

- `lib/comb/batch.ts`: `myUnsent(threads, me, serviceUserId)` (the connected user's open, unsent
  root comments, by path) and `groupByFile(threads)`. Tests in `batch.test.ts`.
- `components/comb/send-tray.tsx` (new): a "Send N" header button on every Comb page while the
  connected user has unsent comments. It reads the drive's comment list (`useFolderThreads` on
  "/", the same cached query as the root's Open comments panel).
- `components/comb/send-to-swarm.tsx`: the dialog groups rows by file when it lists paths, with a
  checkbox per file.

Verification:
- `bun run test:root -- apps/ui/src/lib/comb/batch.test.ts`
- `cd apps/ui && bunx tsc -b && bun run lint`

Manual E2E:
- Comment on two files, then open a third. The header shows "Send 2". The dialog groups the two
  comments under their files. Send: one task with both.

## Round 2: Taras's PR feedback (2026-10-25, 16:55 BCN)

Feedback: "the full width i meant the content, not all", "what about the grouping of the
comments by task? no screenshot of that", "in the home having the sidebar and main page showing
files feels redundant?", "maybe show ongoing tasks related to file comments in home?".

Decisions:
- Full width widens the content only. The side panels stay as they are. The toggle shows only
  on a markdown file (the only viewer with a reading measure). (asked: "the content, not all")
- Home "In progress" card: each unfinished swarm task from Comb, with its comments grouped
  under it (file and comment, linked), and a link to the task. Covers "grouping by task" and
  "ongoing tasks". (asked: "Home In progress card")
- The card follows the "Processing" rule: open comments that were sent and not answered, and
  whose task is not finished. It hides when nothing is in progress. (assumed)
- On the drive root the left panel starts collapsed (the icon strip), for that page only. The
  tree comes back in folders and files. (asked: "Collapse left on home")

### Phase 6: Full width is the content only

- `comb-layout.tsx`: full width no longer hides panels. Showing a panel does not end it. The
  layout says whether the current file is markdown (`canWiden`).
- `side-panels.tsx`, `comment-rail.tsx`, `file-view.tsx`: drop the full-width hiding and exits.
  `FullWidthButton` shows only when `canWiden`.

Verification:
- `bun run test:root -- apps/ui/src/lib/comb/panels.test.ts`
- `cd apps/ui && bunx tsc -b && bun run lint`

Manual E2E:
- Open a markdown file at 1440x900: both panels stay when full width is on, and the text fills
  the pane. A folder and an image show no toggle.

### Phase 7: Left panel collapsed on the drive root

- `lib/comb/panels.ts`: `PanelTarget` gains `home`. Navigating to it collapses the panel for
  that page only (like a file without an outline). Tests in `panels.test.ts`.
- `comb-layout.tsx`: the drive root resolves to `home`.

Verification:
- `bun run test:root -- apps/ui/src/lib/comb/panels.test.ts`

Manual E2E:
- Open the drive root at 1440x900: the left panel is the icon strip. Open a folder: the tree is
  back. Expand the strip on the root: it opens.

### Phase 8: Home "In progress" card

- `lib/comb/thread-status.ts`: `threadsByTask(threads, serviceUserId)`, the open sent and
  unanswered threads grouped by task. Tests in `thread-status.test.ts`.
- `components/comb/use-thread-swarm-states.ts`: the task status queries move to
  `useWatchedTasks(taskIds)`, shared by the rail and the card.
- `components/comb/comb-home.tsx`: the card (`InProgressCard`, `TaskGroup`). One group per unfinished task, newest
  first: status, comment count, time, a link to the task, then its comments (file and text,
  linked to the comment).
- The card sits above the three list cards, full width.

Verification:
- `bun run test:root -- apps/ui/src/lib/comb/thread-status.test.ts`
- `cd apps/ui && bunx tsc -b && bun run lint && bun run check:tokens`

Manual E2E:
- Send 3 comments on 2 files as one task, and 1 comment as a second task (a lead row registered
  so the tasks stay pending). The home shows both tasks with their comments. Answer one thread
  as another user: it leaves the card. Finish the task: the group leaves the card.

## Docs

- `docs-site/content/docs/(documentation)/ui/comb.mdx`: send rule, note, bulk resolve, Recent,
  Favorites, full width.

## Manual E2E (whole feature, local stack)

```bash
# agent-fs from source, local storage, local nomic embeddings
AGENT_FS_HOME=/tmp/comb-flow/afs AGENT_FS_STORAGE_PROVIDER=local AGENT_FS_LOCAL_ROOT=/tmp/comb-flow/afs/storage \
  SERVER_PORT=$AFS_PORT SERVER_HOST=127.0.0.1 EMBEDDING_PROVIDER=local EMBEDDING_MODEL=nomic-embed-text-v1.5 \
  bun run ~/Documents/code/agent-fs/packages/cli/src/index.ts server
# API with a throwaway DB
DATABASE_PATH=/tmp/comb-flow/swarm.sqlite PORT=$API_PORT DESPLEGA_TELEMETRY_ENV=test \
  AGENT_FS_API_URL=http://127.0.0.1:$AFS_PORT COMB_ENABLED=true bun run start:http
# UI
cd apps/ui && VITE_PROXY_TARGET=http://127.0.0.1:$API_PORT bunx vite --port $UI_PORT
```

Walk Phases 1 to 4 at 1440x900 and 390x844 with agent-browser. Upload screenshots to
`qa/agent-swarm/2026-10-25-comb-review-flow/`. Record one video: add a comment, send it with a
note, bulk resolve, full width.

## Verification (whole PR)

- `bun run check:local`, `bun run lint`, `bun run lint:slop`, `bun run tsc:check:tsc`
- `bun run test:root -- --parallel=4`, `bun run e2e`, `bun run e2e:ui`
- `bash scripts/check-db-boundary.sh`, `bash scripts/check-api-key-boundary.sh`,
  `bash scripts/check-test-spawn-sync.sh`, `bash scripts/check-audit-columns.sh`, `bun run check:dep-graph`
- `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b`

## Todo

- [x] Phase 1: Send any comment, batch send with a note (c14ac64a1)
- [x] Phase 2: Bulk resolve (18d278a8b)
- [x] Phase 3: Recent, Recently viewed, Favorites (4b5a0cc99)
- [x] Phase 4: Clean layout (bd45bcafe)
- [x] Phase 5: Drive-wide send tray, with the review fixes (a13a093c8, 54d5107f2)
- [x] Docs (7ba9fa5e9, a13a093c8)
- [x] QA walk, screenshots, recording (agent-fs `qa/agent-swarm/2026-10-25-comb-review-flow/`)
- [x] Code review (Standards + Spec, Opus): Important and most Minor findings fixed in a13a093c8
- [x] Gates: all green except `script-executor-quickjs` ("caps the binary bodies"), which fails on clean main too (macOS). The Comb UI e2e flow passed against the local agent-fs (`E2E_COMB_AGENT_FS_URL`).
- [x] PR #2420, cleanup, df -h (30 to 29 GiB)
- [x] Phase 6: Full width is the content only (c31563d56)
- [x] Phase 7: Left panel collapsed on the drive root (a94703ba1)
- [x] Phase 8: Home In progress card (259aa9e7c)
- [x] Round 2 review (Standards + Spec, Sonnet): Minor findings only, fixed in bc8c2b73b
- [x] Round 2 QA, screenshots, recording (`in-progress-*`, `full-width-*`, `folder-tree-1`, `phone-home-2`, `flow-2.mp4`)
- [x] Round 2 gates: green except 2 root tests not from this branch (quickjs, the same on clean main on macOS; `helper-credentials` timed out at 5 s under load and passes alone). `e2e`, `e2e:ui` 91 passed, the Comb flow included.
- [x] Round 2 PR body, cleanup

## Log

- 15:45 BCN: plan written. Worktree `~/worktrees/agent-swarm/2026-10-25-comb-review-flow`,
  branch `feat/comb-review-flow` off `ef71532ed`. Disk before: 30 GiB free.
- 16:10 BCN: Phases 1 to 4 and docs committed. Local stack in `/tmp/comb-flow/` (agent-fs 47433,
  API 43013, UI 45274, main-branch UI 45275 from a detached worktree for before shots). Seeded
  12 comments, 5 backdated 40 days in the local agent-fs DB. Live checks passed: send with a
  note (task text has the fenced note), bulk resolve of the 5 old comments, Undo, Recent and
  Favorites tabs, home cards, full width and its exit on a comment link, 390 px.
- Fixes found in QA: the folder listing was squeezed by the home cards (the folder now scrolls
  as one page, the grid keeps `min-h-72`), the phone list collapsed to 0 (`flex-none`), the
  Recent toggle did not stretch, the Undo toast closed too soon (now 10 s).
- Gotcha: `bun test` over all apps/ui component tests in ONE process fails with "Happy DOM has
  already been globally registered". CI runs `--parallel=4`, one process per file.
- Gotcha: `git stash` in a worktree uses the shared stash list. Do not stash there.
- 16:45 BCN: review fixes and Phase 5 committed. Live: tray across 4 files, grouped dialog,
  viewer (403) bulk resolve stops early and keeps the selection, list tab stays open on a
  plain file. Recently viewed is now keyed per agent-fs user (QA showed two Comb accounts in
  one browser sharing it).
- 16:58 BCN: round 2 from Taras's PR feedback (full width content only, home tree collapsed,
  In progress card). Stack rebuilt in `/tmp/comb-flow/` from the recipe. Live: two sends show as
  two groups, a reply by another user and a cancelled task each leave the card, full width keeps
  both panels (visible at 1920: at 1440 with both panels open the pane is already under 72ch).

## Review notes (not fixed)

- An older agent-fs without `recent` shows "This agent-fs does not list changes." in the home
  card and the tab, instead of hiding them. Kept: it says why the list is empty.
- `useRememberViewed` and the send bar count have no automated test. They were checked live.
- The send bar and the tray both read open comments. The tray counts only your own comments,
  the bar counts everyone's on the file (the old "Send N" rule).
- Round 2: the In progress card's "hide a finished or unknown task" step has no unit test (it
  reuses `isTaskUnfinished`). Checked live. The Full width button appears once the markdown loads.
