---
id: step-10
name: Review changes
depends_on: [step-7]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-10: Review changes

**Repo:** agent-swarm. Uses the step-7 comment rail (`threadActions` mount point) and the step-5 file header. Works against agent-fs v0.14.0 (`log`, `diff`, `revert`, `comment-resolve` exist).

## Overview

After an agent writes a new version, the human reviews what changed. A thread whose `fileVersion` is older than the file's current version shows "Review changes (vX → vY)". It opens a diff view (agent-fs `diff`, rendered by a port of `live/`'s `DiffViewer`) with the thread next to it and three actions: Resolve, Reopen, and "Revert to vX" (confirm dialog). The file header gets a version menu (agent-fs `log`) and "Compare with…". The Resolved tab shows who resolved each thread, so an agent that resolved a comment itself is visible (brainstorm Q6).

When done: the loop "agent edits → human reviews diff → resolves or reverts" runs entirely in Comb.

## Changes Required:

#### 1. Data
**File**: `apps/ui/src/api/hooks/use-agent-fs.ts`
**Changes**: `useAgentFsLog(path)` → `log {path}`. `useAgentFsDiff(path, from, to)` → `diff {path, v1, v2}` (`staleTime: Infinity`, same key shape as step-7 so cached diffs are shared). `useRevertFile()` → `revert {path, version, expectedVersion: currentVersion}` (the op rejects a stale head). `useResolveComment()` already exists from step-7; reuse it.

#### 2. Diff viewer
**File**: `apps/ui/src/components/comb/review/diff-viewer.tsx` (new)
**Changes**: port `$AFS/live/src/components/viewers/DiffViewer.tsx` (65 lines; props `{changes, className}`; client-side line numbers at :10-32). Replace the green/red literals with design tokens (`status-*` / CSS variables) so `bun run check:tokens` passes. Header comment names the source.

**File**: `apps/ui/src/lib/comb/diff-lines.ts` (new)
**Changes**: extract the line-number computation from the port into a pure function for testing. Collapse long unchanged runs ("Show 24 unchanged lines").

#### 3. Review view
**File**: `apps/ui/src/components/comb/review/review-panel.tsx` (new)
**Changes**:
- URL state `?diff=<from>..<to>` (and optional `&comment=<id>`), so a review link is shareable and back/forward works.
- Layout: diff on the left, the thread on the right (reusing `comment-thread.tsx`), header "Changes v<from> → v<to> by <author of to>" from `log`.
- Actions: Resolve / Reopen (`comment-resolve {id, resolved}`), and "Revert to v<from>" behind an `AlertDialog` ("This writes a new version with the content of v<from>. Agents' later edits stay in history."). A 409/conflict from `expectedVersion` shows "The file changed, reload the diff". Viewers without editor rights see the actions disabled with a reason.
- Exit returns to the normal file view at the same path.

**File**: `apps/ui/src/components/comb/review/review-changes-button.tsx` (new), mounted through `threadActions`
**Changes**: shown when `thread.fileVersion < currentVersion`. Label "Review changes (v<fileVersion> → v<current>)".

**File**: `apps/ui/src/components/comb/file-header.tsx`
**Changes**: a "Versions" menu listing `log` entries (version, author, time, message). Picking one opens `?diff=<picked>..<current>`. Keep the change to this file small.

#### 4. Resolved-by visibility
**File**: `apps/ui/src/components/comb/comment-thread.tsx`
**Changes**: in the Resolved tab, show "Resolved by <name>". Build the name from a map of `author → authorDisplayName` over the comments and replies already loaded for the file (the resolver almost always replied or authored in the thread). Fall back to "another member". Do not depend on step-8's `useDriveMembers` (this step must work without it). A follow-up can add an "agent" badge once member emails are available.

#### 5. Tests
**File**: `apps/ui/src/lib/comb/diff-lines.test.ts` (new)
**Changes**: line numbers for add/remove/context sequences (compare with the `live/` component's behavior on the same input), collapse thresholds, the no-content fallback (one remove + one add from `diffSummary`).

### Success Criteria:

#### Automated Verification:
- [x] UI unit tests pass: `bun run test:root -- apps/ui/src/lib/comb/diff-lines.test.ts`
- [x] Typecheck: `bun run tsc:check`
- [x] Dashboard: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`

#### Automated QA:
- [x] Local Comb loop (local storage adapter supports versions, so `diff` returns real line changes). As the QA human, comment on a passage of `comb-qa/notes.md` (v1). With the CLI under a second key, edit that passage (v2) and reply to the comment.
- [x] `agent-browser` reloads the file: the thread shows "Review changes (v1 → v2)". Clicking it opens `?diff=1..2` with the removed and added lines. Screenshot.
- [x] Resolve from the review panel: the thread moves to Resolved and shows "Resolved by <QA human>". Reopen: it moves back.
- [x] "Revert to v1": after confirm, `agent-fs log comb-qa/notes.md` shows v3 with operation `revert`, and the file content equals v1.
- [x] Stale revert: open the review, edit the file again from the CLI, then click Revert: the UI shows the "file changed" message and writes nothing.
- [x] Versions menu: pick v1 → the diff against the current version opens. Browser back returns to the file view.
- [ ] Screenshots + recording of the review flow, uploaded per LOCAL_TESTING.md.

#### Manual Verification:
- [ ] Taras reviews one real agent edit on a long file and judges diff readability.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.

## Implementation Notes

Commit `213299351` on `comb/s10` (worktree `/Users/taras/worktrees/agent-swarm/2026-09-30-comb-s10`, on the wave-3 tip `d88c49629`). Evidence in `/tmp/comb-run/step-10/` (21 screenshots, `review-flow.webm`). The upload box stays open until the orchestrator uploads the evidence.

Verification notes:
- Tests: 226 pass across the 23 Comb UI test files (new: `diff-lines.test.ts`, `review.test.ts`, and a `commentAuthorNames` case in `comments.test.ts`). `tsc:check`, `apps/ui` lint (plain `bun run lint`, no Biome crash), `tsc -b`, and `check:tokens` pass.
- QA ran in this order: comment on v1, agent edit (v2) and reply through the CLI, Review changes (1..2), Resolve (card shows "Resolved by QA Human"), Reopen, then the stale revert (the agent appended v3 while the review was open; the click got a 409, the toast and the "The file changed" callout showed, the log still ended at v3), "Reload the diff" (1..3), then "Revert to v1". So the revert is v4, not v3: `log` shows v4 `revert` "Reverted to version 1", and `diff v1..v4` has 0 changes (`/tmp/comb-run/step-10/revert-check.txt`).
- Versions menu: v1 opened `?diff=1..4` ("No changes", since v4 = v1), and Back returned to the file view. The recording also picks v2 (`?diff=2..5`).
- Viewer (drive `viewer` role): Resolve and Revert both got 403. The toast, the "You have view-only access" line, and disabled actions showed. The log did not change.
- Two hunks (`comb-qa/long.ts`): a gap row "36 unchanged lines" between hunks, and the right line numbers after it (46/46).

Decisions and deviations:
- The review replaces the viewer in the viewer pane (`FileBody`), and the comment rail stays on the right with the thread selected through `?comment=`. So "the thread on the right" is the rail's own `CommentThread` card, not a second copy. The rail's text space is null during a review (the diff has no `data-line-start`), so there is no selection button and no highlight, and anchors hold no entries (no false "Lost").
- `expectedVersion` is the reviewed head (`to` of `?diff=`), not the live `stat.currentVersion`. A stat poll can move `currentVersion` while the human looks at an older diff; the plan's form would then let a revert pass over a version the human never saw. A stat that is already ahead of `to` also shows the "The file changed" callout with "Reload the diff" (moves `to` to the head, replace navigation).
- Review changes button: `event.stopPropagation()`. react-router's functional `setSearchParams` reads the URL of the current render, so the card's own click (it writes `?comment=` with replace) would drop `diff`. The button sets `comment` itself.
- Line numbers: agent-fs 0.15.0 sends `oldLine`/`newLine` per hunk, which live/'s DiffViewer ignores (it counts from 1, wrong for later hunks). `diffLines` uses agent-fs's numbers when present, else live/'s count (tested for parity on the same inputs). Gap rows mark the lines between hunks. Folds ("Show N unchanged lines") keep 3 lines next to each change and fold at 4 hidden lines. agent-fs uses 4 lines of context, so folds show only for other diff shapes (unit tested, not seen in QA).
- Port changes: `break-words` instead of `break-all` (live/ breaks words in the middle), screen-reader "Added:"/"Removed:" text, and the "\ No newline at end of file" note renders as a muted italic row without numbers.
- Revert is hidden when the diff has no changes (a revert would only add a copy).
- Resolved by: names from the file's loaded comments (`useCommentAuthorNames`, a `select` on the rail's comment query, no extra call), then drive members (`useDriveMembers`, degrades without the feature), else "another member". Shown with the relative `resolvedAt`.
- Read-only is learned from a 403 in the review panel (separate from the rail's own read-only state). agent-fs has no call that tells a member its role.
- New `RevertParams`/`RevertResult` in `lib/agent-fs/types.ts` (copied from agent-fs `ops/types.ts`).

Author "unknown" (orchestrator question, also the step-11 report): an agent-fs bug, not a Comb bug. Comb reads the right fields (`stat.author`, `stat.currentVersion`). agent-fs keys file metadata by the exact path string that the op received, and the JSON ops do not normalize it. Evidence (`/tmp/comb-run/step-10/probe-author.ts`, output `probe-author.txt`, screenshot `17-bare-path-author-unknown.png`):
- `POST /orgs/<org>/ops {op: "write", path: "comb-qa/bare.md", content}` answers 200 `{"version":1,"path":"comb-qa/bare.md"}`.
- `stat {path: "/comb-qa/bare.md"}` (the Comb form) answers `author: "unknown"`, no `currentVersion`. `stat {path: "comb-qa/bare.md"}` answers the author id and `currentVersion: 1`.
- `ls {path: "/comb-qa/"}` and `ls {path: "comb-qa"}` both list `bare.md` with no author.
- `log {path: "/comb-qa/bare.md"}` answers 0 versions. `log {path: "comb-qa/bare.md"}` answers 1.
- Control: `write {path: "/comb-qa/notes.md"}` has the author and `currentVersion` on `stat "/comb-qa/notes.md"`.
- Code: `stat.ts` looks up `files` by the exact `params.path` (`author: dbFile?.author ?? "unknown"`). `write.ts` and `createVersion` (`versioning.ts`) store `params.path` as sent. `ls.ts` normalizes its prefix to "/comb-qa/" and maps rows by "/comb-qa/<name>", so `ls` never shows the author of a bare-path row. The raw PUT route (`server/src/routes/files.ts`) calls `normalizePath`, which is why raw-PUT files work. agent-fs's own convention (`ops/paths.ts`) says file paths start with "/".
- Impact: any file an agent writes with a bare path (the plan's own QA recipe runs `agent-fs write comb-qa/notes.md`) has no version in Comb, so the header has no "vN", `FileView` runs its folder probe, and "Review changes" and the Versions menu do not show. QA for this step wrote `/comb-qa/notes.md` with the leading "/".
- Upstream fix (agent-fs): normalize `path` with `normalizePath` for every file op (at dispatch or per op), and migrate existing bare rows in `files` and `file_versions`. A Comb-side stopgap is possible (stat the bare form when the "/" form has no version, and send that stored form to `log`, `diff`, and `revert`), but it touches `useAgentFsStat` for every view and cannot fix `ls`, so it is not in this step.

Notes for later steps:
- Hooks (`api/hooks/use-agent-fs.ts`): `useAgentFsLog(file, currentVersion, {enabled?})`, `useAgentFsDiff(file, from, to)` (both reuse `agentFsLogQuery` / `agentFsDiffQuery` keys), `useRevertFile(file)` (mutate `{version, expectedVersion}`, invalidates `(..., "stat", path)` on settle), `useCommentAuthorNames(file)`.
- `lib/comb/review.ts`: `DIFF_PARAM = "diff"`, `DiffRange`, `parseDiffRange` (orders the pair, null on bad input), `formatDiffRange`, `reviewRange(thread, currentVersion, logVersions?)`. `lib/comb/diff-lines.ts`: `diffLines`, `diffRows`, `diffHasChanges`, `DIFF_CONTEXT_LINES`, `DIFF_FOLD_MIN_LINES`. `lib/comb/comments.ts`: `commentAuthorNames(FileThreads)`.
- Components (`components/comb/review/`): `DiffViewer({changes, className})`, `ReviewPanel({file, stat, range})` (keyed by range in `FileBody`), `ReviewChangesButton({file, stat, thread})`, `VersionsMenu({file, stat})`, `STALE_REVIEW_MESSAGE`.
- Mount points used: `file-view.tsx` `FileBody` (the viewer pane swaps `FileViewer` for `ReviewPanel` on `?diff=`, and the `threadActions` prop on the one `<CommentRail>` line, marked `// step-10`). Step-9 also passes `threadActions`: compose both, for example `threadActions={(thread) => (<><SendToSwarmButton ... /><ReviewChangesButton file={file} stat={stat} thread={thread} /></>)}`. `file-header.tsx`: one line in the "File actions" slot (`<VersionsMenu />`, marked `step-10`). `comment-thread.tsx`: `ResolvedBy` after the replies (step-8 edits `CommentBody` in the same file).
- Step-11: a new version invalidates `stat`, which moves the log key; nothing else to invalidate for the review. A review open on an old head shows the "The file changed" callout by itself.
- Known gap: on narrow layouts the rail sheet stays open over the diff after "Review changes" (the button stops the card click that would close it). Also, "Review changes" stays on a thread after a revert back to its version (the diff then says "No changes").

### Review fixes

Commit `31dfe90ae` on `comb/s10` (on top of `213299351`). It applies the 13 code-review findings. Evidence: `/tmp/comb-run/step-10/fix-01..13-*.png`.

What changed:
- Safe revert (1, 6, 13): `canRevert({changes, currentVersion, to, stale})` in `lib/comb/review.ts`. Revert shows only when the diff loaded and has changes, `to` is the current version, and no 409 is pending. `revertToFrom` returns early while `revert.isPending`, and the dialog action is `disabled` while in flight. Success leaves the review with `replace: true` (Back skips the review).
- No dead ends (2): `FileBody` checks `?diff=` with `reviewRangeNotice(range, path, stat)`. A `to` past the head, a file without versions, or a non-text file opens the normal file view with a notice (`ReviewRangeNotice`, `data-comb-skip`, a Close button that removes `diff`). The review opens by itself when `stat` catches up. A 409 while `stat` still shows the reviewed head shows the server message ("Expected version 3 but file is at version 4") and a Reload that refetches `stat` and then clears the failed revert. The "Reload the diff" button (newer head known) is unchanged.
- Limits (3): `showReviewEntry(path, stat)` gates "Review changes" and the Versions menu (markdown, text, and table kinds with a version). `diffRows` caps at `DIFF_MAX_ROWS = 5000` rows and ends with a `cap` row: "Diff too large: the last N lines are not shown. Download both versions, or open the file in agent-fs."
- `?comment=` tied to the range (4): the Versions menu deletes `comment`. The panel resolves only a thread where `reviewsThread(thread, range, currentVersion, logVersions)` holds, and names it ("Resolve this thread" / "Reopen this thread" next to its quote excerpt, or its body for a file comment). Decision for the card click during a review: it leaves the review. `CommentRail` has a new `viewerParams` prop (`[DIFF_PARAM]` from `FileBody`). `activate()` deletes those params in the same `setSearchParams` call, closes the sheet, and lets the deep-link effect scroll to the passage once the file renders. The rail also closes its sheet when a viewer param appears, and a deep link with one does not open the sheet. This fixes the "sheet stays open over the diff" gap.
- The `stopPropagation` on "Review changes" stays. The button is its own push navigation. A bubbling card click is a second navigation that react-router computes from the URL of the same render, and it now leaves the review. So without `stopPropagation` the card click would replace the new entry and drop `diff`. The comment in the button says this.
- Tested decisions (5): `lib/comb/review.ts` has `showReviewEntry`, `reviewRangeNotice`, `reviewsThread`, `newerVersion`, `canRevert`, and `revertOutcome(error, currentVersion, to)` (`reverted | read-only | stale {newer, message} | failed {message}`). `review.test.ts` covers 403, 409 with and without a known newer head, success, network errors, an unchanged diff, a diff that has not loaded, and a missing `currentVersion`.
- One read-only source (7, 8): `FileBody` owns the flag (`useReducer(() => true, false)`) and passes `readOnly` and `onReadOnly` to `CommentRail` (new required props, its own `useState` is gone) and to `ReviewPanel`. Blocked actions hide in both, like the rail already did (no disabled buttons with reasons).
- Names (9, 10): `ResolvedBy` uses `authorNames` from the comment context (built once in the rail with `commentAuthorNames(threads)`), then `useAuthorLabel(file)` with a new `fallback` argument ("another member"). `useCommentAuthorNames` is removed. `commentFileVersion(comment, versions)` in `comments.ts` is shared by `anchorInputs` and `reviewRange`.
- Folds (11): removed. agent-fs sends 4 unchanged lines around each change, so an unchanged run inside a hunk is at most 8 lines, which is under the fold threshold. The plan's fold request is not applicable. Gap rows between hunks stay.
- A11y (12): the two line-number columns are `aria-hidden` (the +/- column already was). The diff is a `section` named by a new `label` prop ("Changes from v1 to v3").

Verification: `bun run test:root -- apps/ui/src/lib/comb/ apps/ui/src/components/comb/ apps/ui/src/api/` (234 pass, 21 files), `bun run tsc:check`, and in `apps/ui` `bun run lint` (plain run, no Biome crash), `bunx tsc -b`, `bun run check:tokens` all pass.

Browser re-QA (API 3300, UI 3301, agent-fs 7410, session `comb-s10`, the step-10 scratch DB and users; seed `/tmp/comb-run/step-10/fix-seed.ts`):
- Review from the quote thread (`?diff=1..2&comment=...`): thread row with "Resolve this thread" (fix-01). Resolve, then "Resolved by QA Human" in the rail and "Reopen this thread" in the panel (fix-02), then Reopen.
- Stale revert: dialog open, agent wrote v3, confirm. 409 toast, "It is now at v3" callout with "Reload the diff", no Revert, no thread row (the thread's range is now 1..3), and `log` ends at v3 (fix-03). Reload the diff (1..3), Revert to v1: `log` shows v4 `revert`, the URL drops `diff` with replace, and Back goes to the file view before the review (fix-04).
- `?diff=1..99`: the file view with "This file has no v99. The latest version is v4." and Close. Anchors still highlight (fix-05).
- Versions menu with `?comment=` set, pick v2: URL `?diff=2..4` with no `comment`, and no Resolve (fix-06).
- Card click during a review: URL drops `diff` in one replace navigation, and the passage is emphasized (fix-07).
- PNG with a thread on an older version: no Versions menu and no "Review changes" (fix-08). `pixel.png?diff=1..3` shows "Comb compares versions of text files only."
- `big.txt` (6,000 lines, every line changed): 5,000 rows, then "Diff too large: the last 7,000 lines are not shown..." (fix-09). agent-fs 0.15.0 takes about 10.6 s to compute this diff (measured with a direct `diff` op), so the skeleton shows for that long.
- 390 px: open the sheet, click "Review changes": the sheet closes and the diff shows (fix-10, fix-11). Open the sheet during the review and click a card: the review closes, the sheet closes, and the passage is emphasized (fix-12).
- Viewer key: one Resolve click (403) shows "You have view-only access" in both the panel and the rail. Revert, Resolve, Reply, and "Comment on file" are hidden in both (fix-13).
- Not seen in the browser: the 409 branch where `stat` still shows the reviewed head. `useRevertFile` refetches `stat` before the per-call `onError` runs, so in QA the newer head was always known. `revertOutcome` unit tests cover the branch.

Notes for later steps (changes to the list above):
- `CommentRail` now requires `readOnly` and `onReadOnly`, and takes optional `viewerParams`. `CommentContextValue` has `authorNames`. Merges into `file-view.tsx` keep the union of props on the one `<CommentRail>` line.
- `useCommentAuthorNames` is gone. `commentAuthorNames(threads)` takes the thread array. `DIFF_CONTEXT_LINES` and `DIFF_FOLD_MIN_LINES` are gone; `DIFF_MAX_ROWS` is new. `DiffViewer` needs `label`. `ReviewPanel` takes `readOnly` and `onReadOnly`. `useAuthorLabel(...)(userId, fallback?)`.
- The known gap "Review changes stays on a thread after a revert back to its version" remains (the diff says "No changes", and Revert is hidden for it).
