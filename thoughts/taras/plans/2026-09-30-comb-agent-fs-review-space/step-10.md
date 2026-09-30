---
id: step-10
name: Review changes
depends_on: [step-7]
status: ready
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
- [ ] UI unit tests pass: `bun run test:root -- apps/ui/src/lib/comb/diff-lines.test.ts`
- [ ] Typecheck: `bun run tsc:check`
- [ ] Dashboard: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`

#### Automated QA:
- [ ] Local Comb loop (local storage adapter supports versions, so `diff` returns real line changes). As the QA human, comment on a passage of `comb-qa/notes.md` (v1). With the CLI under a second key, edit that passage (v2) and reply to the comment.
- [ ] `agent-browser` reloads the file: the thread shows "Review changes (v1 → v2)". Clicking it opens `?diff=1..2` with the removed and added lines. Screenshot.
- [ ] Resolve from the review panel: the thread moves to Resolved and shows "Resolved by <QA human>". Reopen: it moves back.
- [ ] "Revert to v1": after confirm, `agent-fs log comb-qa/notes.md` shows v3 with operation `revert`, and the file content equals v1.
- [ ] Stale revert: open the review, edit the file again from the CLI, then click Revert: the UI shows the "file changed" message and writes nothing.
- [ ] Versions menu: pick v1 → the diff against the current version opens. Browser back returns to the file view.
- [ ] Screenshots + recording of the review flow, uploaded per LOCAL_TESTING.md.

#### Manual Verification:
- [ ] Taras reviews one real agent edit on a long file and judges diff readability.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.
