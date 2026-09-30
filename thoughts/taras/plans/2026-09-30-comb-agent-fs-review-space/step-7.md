---
id: step-7
name: Comments with anchors
depends_on: [step-5]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-7: Comments with anchors

**Repo:** agent-swarm. Builds on the step-5 file page, the markdown and text viewers (which stamp `data-line-start` / `data-line-end`), and `use-agent-fs.ts`. Works against agent-fs v0.14.0 (comments already exist there).

## Overview

Humans comment on files in Comb. On markdown and text files they select a passage and comment on it. The comment stores the line range and a text-quote anchor, exactly like `live/`, so `live/`, the CLI, and agents see the same anchors. On every file type they can leave a file-level comment. A right-hand comment rail lists threads (Open / Resolved) with replies, reply, resolve, and reopen. Anchored comments are highlighted in the text with the CSS Custom Highlight API and re-anchor across versions through agent-fs `diff`. The text being typed and comments that failed to post survive a reload.

This step also adds `lib/comb/markers.ts`, shared by step-8 and step-9: the `@swarm` marker and the machine-readable "sent" reply marker.

When done: the full comment lifecycle works in the dashboard, and a comment made in Comb shows at the same passage in `live/`.

## Changes Required:

#### 1. Anchoring logic (ported from live/)
**File**: `apps/ui/src/lib/comb/comment-anchor.ts` (new)
**Changes**: copy `$AFS/live/src/lib/comment-anchor.ts` (553 lines, no imports) VERBATIM. Header comment: source path, agent-fs commit `08e7d89`, "Keep in sync with live/. Change logic upstream first." Only formatting changes needed for Biome are allowed. If Biome rules reject the file, add a file-level `biome-ignore` with a reason instead of rewriting logic.

**File**: `apps/ui/src/lib/comb/dom-text-space.ts` (new)
**Changes**: port `$AFS/live/src/lib/dom-text-space.ts` (`buildDomTextSpace`, `toRange`, `pointToOffset`, `lineRangeToOffsets`, highlight painting helpers). Adaptations only: the text walker skips any element with `data-comb-skip`, and Streamdown chrome (the `data-streamdown` values for code block header/actions, table toolbar, image fallback; confirm the exact values in `node_modules/streamdown/dist`). `rehypeSourceLines` already lives in `lib/comb/rehype-source-lines.ts` (step-5).

**File**: `apps/ui/src/hooks/use-comment-anchors.ts` (new)
**Changes**: port `$AFS/live/src/hooks/use-comment-anchors.ts`: inputs are the comments, the current version (`useAgentFsStat`), and the rendered root element. For stale comments that need it (`anchorNeedsDiff`), fetch `diff {path, v1: comment.fileVersion, v2: currentVersion}` with `useQueries` (`staleTime: Infinity`, `retry: false`, key `agentFsKey(..., "diff", path, v1, v2)`). Output a map `commentId → {status: anchored|moved|lost, range?}`. Replace `live/`'s `useAuth` with `useAgentFs()`.

**File**: `apps/ui/src/components/comb/comment-highlights.tsx` (new)
**Changes**: paint with `CSS.highlights` under names `comb-comment`, `comb-comment-moved`, `comb-comment-active`. Styles in the app stylesheet with `::highlight(...)` using CSS variables (no raw colors; `bun run check:tokens` enforces this). Fallback when `CSS.highlights` is missing: a class on the anchored block elements. Clean up the registry on unmount and path change.

#### 2. Creating comments
**File**: `apps/ui/src/components/comb/selection-comment-button.tsx` (new)
**Changes**: on `mouseup` / `selectionchange` inside the viewer root, show a small "Comment" button anchored at the selection rect (Radix `Popover` with a virtual anchor). On click, build the anchor with `commentAnchorInput` (lines from `data-line-*`, quote exact + 32-char prefix/suffix, like `live/` `MarkdownViewer.tsx:488-511,729-738`) and open the composer.

**File**: `apps/ui/src/components/comb/comment-composer.tsx` (new)
**Changes**:
- Textarea, Cmd/Ctrl+Enter to send, Escape to cancel. Calls `comment-add` with `{path, body, lineStart, lineEnd, quote}` (anchored), `{path, body}` (file-level), or `{parentId, body}` (reply).
- Draft persistence: every keystroke (debounced 300 ms) writes the draft to localStorage under `deriveStorageKey(apiUrl, "comb:draft:" + endpoint + ":" + orgId + "/" + driveId + ":" + path + ":" + (parentId ?? anchorKey ?? "file"))`. A successful send clears it. Drafts older than 7 days are dropped on read.
- Outbox: when `comment-add` fails with a network error or 5xx, keep `{params, createdAt, error}` in a localStorage outbox for this file. The rail shows it as "Not sent" with Retry and Discard. Retry all on the window `online` event. Validation errors (4xx) do not go to the outbox; they show inline.
- Viewers without editor rights (agent-fs 403 on add) see "You have view-only access" instead of the composer.
- A single mount point `renderComposerExtras?` prop (null in this step) where step-8 plugs the mention picker.

#### 3. Comment rail
**File**: `apps/ui/src/components/comb/comment-rail.tsx`, `comment-thread.tsx` (new)
**Changes**:
- Data: `useAgentFsComments(path, {resolved})` → `comment-list {path, resolved}` (unresolved roots by default; the Resolved tab asks `resolved: true` and filters resolved ones). Default react-query polling (10 s) stays on; step-11 turns it off while the change stream is live.
- Tabs Open / Resolved with counts. "Comment on file" button at the top.
- Thread card: author (`authorDisplayName`), relative time, anchor badge (`moved` / `lost`), quoted excerpt, body, replies, reply box, Resolve / Reopen (`comment-resolve {id, resolved}`). Clicking a card scrolls to the range and sets the active highlight. Hovering a highlight focuses the card.
- Deep link `?comment=<id>` opens the right tab, scrolls, and activates.
- Mutations invalidate the comment queries for the path (and step-9 prefix queries by key prefix `agentFsKey(..., "comments")`).
- Two mount points marked with comments: `threadActions` (step-9 adds "Send to swarm", step-10 adds "Review changes") and `railHeaderActions` (step-9 adds "Send N to swarm").
- Phone layout: the rail becomes a bottom sheet.

#### 4. Markers
**File**: `apps/ui/src/lib/comb/markers.ts` (new)
**Changes**:
- `SWARM_MARKER_RE = /(^|\s)@swarm\b/i`, `hasSwarmMarker(body)`.
- `SENT_MARKER_RE = /^\[comb:sent task=([0-9a-f-]{36})\]/`, `sentTaskIdOf(reply)`, `isSentToSwarm(thread)` (any reply matches).
- Rendering helpers used by `comment-thread.tsx`: `@swarm` renders as a chip, and a reply that starts with the sent marker renders as "Sent to the swarm · task <short id>" linking to `/tasks/<id>` instead of raw text.

#### 5. Tests
**File**: `apps/ui/src/lib/comb/comment-anchor.test.ts` (new)
**Changes**: a smoke test that the copied module resolves an exact quote, a moved quote through a diff, and a lost one (inputs built by hand).

**File**: `apps/ui/src/lib/comb/dom-text-space.test.ts` (new)
**Changes**: if the repo has a DOM for `bun:test` (check `apps/ui/tests/` setup), test that `data-comb-skip` content is excluded from the text space. If there is no DOM, extract the skip predicate as a pure function and test that instead.

**File**: `apps/ui/src/lib/comb/markers.test.ts` (new)
**Changes**: `@swarm` at start, middle, and inside a word (`me@swarm.local` must NOT match), sent marker parsing.

**File**: `apps/ui/src/lib/comb/drafts.test.ts` (new)
**Changes**: draft key shape, 7-day expiry, outbox add / retry / discard as pure functions.

### Success Criteria:

#### Automated Verification:
- [x] UI unit tests pass: `bun run test:root -- apps/ui/src/lib/comb/`
- [x] Typecheck: `bun run tsc:check`
- [x] Dashboard: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`

#### Automated QA:
- [x] Local Comb loop (root.md), QA human connected, `comb-qa/notes.md` open.
- [x] `agent-browser` selects the text "Second paragraph" (`agent-browser eval` with a DOM Range + `getSelection().addRange`), clicks "Comment", types "Tighten this", sends. The rail shows the thread. `agent-browser eval "CSS.highlights.has('comb-comment')"` is `true`. Screenshot shows the highlight.
- [x] `bun run "$AFS/packages/cli/src/index.ts" comment list comb-qa/notes.md --json` (as the QA human) shows the comment with `lineStart`, `lineEnd`, and `quote.exact = "Second paragraph."` or the selected text.
- [x] Re-anchoring: with the CLI, insert two lines at the top of `notes.md` (new version). Reload Comb: the highlight is on the moved passage and the card shows no "lost" badge. Replace the passage entirely: the card shows "lost".
- [x] Reply, resolve (moves to Resolved tab), reopen (back to Open). File-level comment on `comb-qa/media/pic.png` (if step-6 is merged) or on `blob.bin`.
- [x] Draft survives reload: type in the composer, reload, the text is back. Outbox: `agent-browser` sets the page offline (`agent-browser eval` cannot, so stop the local agent-fs server instead), send a comment, see "Not sent", restart agent-fs, click Retry, the comment posts.
- [ ] Cross-client check: open the same file in `live/` (`https://live.agent-fs.dev/?apiUrl=http://localhost:7433&apiKey=<qa key>` or a local `live/` dev server) and confirm the comment highlights the same passage.
- [ ] Screenshots + recording of select → comment → reply → resolve, uploaded per LOCAL_TESTING.md.

#### Manual Verification:
- [ ] Taras tries selection-to-comment on a long real markdown file and judges whether the highlight colors and rail layout are readable in light and dark themes.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.

## Implementation Notes

Commit `7de48fffa` on `comb/s7-comments` (worktree `/Users/taras/worktrees/agent-swarm/2026-09-30-comb-s7`, on the step-5 tip `7fefd492d`). Evidence in `/tmp/comb-run/step-7/` (screenshots `01-*.png` to `24-*.png`, plus `live-connect.png` for the failed hosted live/ connect, and `select-comment-reply-resolve.webm`). The last two Automated QA boxes stay open: the live/ highlight could not render locally (below), and the orchestrator uploads the evidence.

Verification notes:
- Tests: 92 pass across 13 files (`apps/ui/src/lib/comb/` and `apps/ui/src/lib/agent-fs/`). `tsc:check`, `apps/ui` lint (plain `bun run lint`, no Biome crash), `tsc -b`, `check:tokens`, and both promise checks pass.
- The harness blocks `agent-browser eval`. Selections used a real mouse drag (`agent-browser mouse move/down/up`). This also covers the `pointerup` path. The highlight check: the screenshot shows the painted passage, and `.comb-comment-fallback*` count is 0, so the Highlight API painted it.
- CLI `comment list comb-qa/notes.md` answers `lineStart: 5`, `lineEnd: 5`, `quote.exact: "Second paragraph."`, `quotedContent` set.
- Re-anchoring: two inserted lines keep the anchor (card reads L7, no badge). Deleting the passage shows "Lost" with the quote struck through. Rewriting the passage in place shows "Moved" (live/'s algorithm points at the replacement), so the QA used a deletion for "lost".
- Cross-client: live/ (a local copy of `live/` on this step's UI port, since hosted live/ on https cannot fetch `http://localhost`) lists the Comb comment and its reply with the same quote. live/ cannot show the file text here: it reads bytes only through presigned URLs, which the local storage backend lacks. So the live/ highlight is unverified locally. The anchor logic is the same module.
- Also checked: deep link `?comment=<id>` on a resolved thread (Resolved tab, card selected, passage emphasized), a text-file anchor (`app.ts` L6), passage hover tints the card, phone layout (bottom sheet at 390x844), light theme, and a drive viewer (403 on send shows "You have view-only access", Resolve and Reply hide).

Decisions and deviations:
- Comment paths: agent-fs stores a comment path exactly as sent and `comment-list {path}` matches exactly. live/, the CLI, and the swarm API send "comb-qa/notes.md" (no leading "/"). Comb writes that form and reads both forms (`lib/comb/comments.ts`), so live/ and the CLI see Comb comments and Comb sees agent comments that used `stat.path`.
- Missing `fileVersion`: agent-fs `comment-add` looks up the head version with the raw path, so comments in the live/ form (live/'s own included) get no `fileVersion`. Without it, a deleted passage re-anchored silently to whatever sat on the old line. `use-comment-anchors` now reads the version from `log` (`versionAt`, newest version at or before the comment). Upstream fix (agent-fs): normalize the path for the version lookup in `commentAdd` (`packages/core/src/ops/comment.ts`), and ideally store and match normalized comment paths.
- `fetchRaw` now sends `cache: "no-cache"`. agent-fs `/raw` answers `Cache-Control: private, max-age=60`, so a new version showed the old bytes for up to a minute even with the revision in the query key. A step-5 bug, fixed here because re-anchoring depends on it.
- The anchored composer opens in the selection popover (live/ does the same). The pending passage stays painted in the active style while typing.
- Cancel drops the draft. Escape and a click outside keep it. A saved file-level or reply draft reopens its composer after a reload. An anchored draft returns when the same passage is selected again (its key hashes the lines and quote).
- Anchoring is generic: `useDomTextSpace` builds the text space from any viewer DOM with `data-line-start` blocks (a MutationObserver rebuilds it). The Comment button shows only when a text space exists.
- `comment-anchor.ts`: a line-level `biome-ignore` (not file-level) for one `??=`, and one em dash in a comment became a colon (Taras's rule). The logic is token-identical to live/ (checked with a normalized compare).
- The rail is a side column from `lg` (1024 px) and a bottom sheet below, with a floating "Comments" button. The page's tree rail switches at 768 px, but tree + viewer + rail is too tight between 768 and 1024.
- `comment-list` calls pass `limit: 200` (agent-fs defaults to 50).
- The outbox retry invalidates the drive's comment queries, like the add mutation.

Notes for later steps:
- Query keys (Comb path, with leading "/"): comment lists `agentFsCommentsKey(access, drive, path, "open" | "resolved")` = `["agent-fs", endpoint, userId, orgId, driveId, "comments", path, "open" | "resolved"]`. Invalidate one file with `agentFsCommentsKey(access, drive, path)`, the whole drive with `agentFsCommentsKey(access, drive)`. Diff `(..., "diff", path, v1, v2)` via `agentFsDiffQuery(access, file, v1, v2)`. Log `(..., "log", path, currentVersion)` via `agentFsLogQuery(access, file, currentVersion)`. Step-11: agent-fs event paths for comments may lack the leading "/": add it before building keys.
- Hooks (`api/hooks/use-agent-fs.ts`): `useAgentFsComments(file, {resolved?})` → `CommentListEntry[]` (newest first, both path forms merged), `useAddComment(file)`, `useResolveComment(file)` (`{id, resolved}`), `addAgentFsComment(access, drive, params)`, `agentFsCommentsKey`, `agentFsDiffQuery`, `agentFsLogQuery`. Types added: `CommentAddParams` (includes `mentions?: string[]`), `CommentAddResult`, `CommentResolveResult`, `VersionEntry`, `LogResult`.
- Mount points on `<CommentRail>` (rendered in `file-view.tsx` `FileBody`):
  - `threadActions?: (thread: CommentListEntry) => ReactNode` (rendered in each card footer next to Reply).
  - `railHeaderActions?: (ctx: { file: DrivePath; open: CommentListEntry[] }) => ReactNode` (next to "Comment on file").
  - `renderComposerExtras?: (ctx: ComposerExtrasContext) => ReactNode`, passed to every composer (file-level, reply, selection). `ComposerExtrasContext = { textareaRef: RefObject<HTMLTextAreaElement | null>; body: string; setBody: (body: string, caret?: number) => void; sendParamsRef: MutableRefObject<((body: string) => Partial<CommentAddParams>) | null> }`. Step-8 sets `sendParamsRef.current = (body) => ({ mentions })`. The composer merges it into the `comment-add` params at send time (and into the outbox entry).
- Markers (`lib/comb/markers.ts`): `SWARM_MARKER_RE`, `hasSwarmMarker(body)`, `SENT_MARKER_RE`, `sentTaskIdOf(reply)`, `isSentToSwarm(thread)`, `splitSwarmMarkers(body)` → `{kind: "text" | "swarm", text}[]`. `comment-thread.tsx` renders `@swarm` chips and "Sent to the swarm · task <8 chars>" links to `/tasks/<id>`.
- Other exports: `lib/comb/comment-anchor.ts` (verbatim live/), `lib/comb/dom-text-space.ts` (`buildDomTextSpace`, `isSkippedElement`, `anchorFromRange`, `NewCommentAnchor`), `lib/comb/drafts.ts` (draft and outbox pure functions), `lib/comb/comments.ts` (`commentWritePath`, `commentReadPaths`, `mergeCommentLists`, `versionAt`), `hooks/use-comment-anchors.ts` (`useCommentAnchors(file, comments, space, currentVersion)` → `Map<id, AnchorResolution>`). `CommentThread` is reusable (step-10) inside a `CommentContextProvider` (`components/comb/comment-context.tsx`).
- Read-only: the rail learns it from a 403 on add or resolve (`markReadOnly`). It resets per file view.
- Step-5 fix agent: the new relative-image placeholder in `comb-markdown.tsx` should carry `data-comb-skip` so its text stays out of anchors.
- Viewer pane ref: `FileBody` owns `viewerRef` on the scroll pane. Keep new viewers inside that pane.

### Review fixes

Commit `be42dcd35` on `comb/s7-comments`, on top of `7de48fffa`. Evidence: `/tmp/comb-run/step-7/fix-*.png`. Tests: 133 pass across 15 files (`apps/ui/src/lib/comb/`, `lib/agent-fs/`, `components/comb/`, `hooks/`). `tsc:check`, `apps/ui` lint (plain `bun run lint`, no Biome crash), `tsc -b`, `check:tokens`, and both promise checks pass.

What changed, by review item:
1. User scope: `CommentScope.userId` (from `access.userId`). Keys: `comb:draft:<endpoint>:<userId>:<org>/<drive>:<path>:<slot>` and `comb:outbox:<endpoint>:<userId>:<org>/<drive>:<path>`. Outbox entries store `userId`. A retry claims only the current user's entries, and the rail shows only them. `disconnect()` leaves them in storage.
2. Outbox safety (`retryOutboxEntries` in `lib/comb/drafts.ts`): `navigator.locks.request(<outbox key>)` when available. Entries are claimed (taken out of storage) before sending. A failure goes back with its new error. A `pagehide` puts in-flight entries back, so a closed tab never loses a comment. Before sending, the file's threads are fetched fresh, and an entry is dropped when a comment with the same path (or parent), body, and author exists at or after its first attempt (60 s clock-skew allowance). If the fresh fetch fails, every entry stays (no resend without the dedupe check).
3. Read-only: a 403 on any composer shows the toast "You have view-only access" (`READ_ONLY_MESSAGE`), marks the rail read-only, and the rail header shows a persistent one-line notice in place of "Comment on file". The composer renders nothing while read-only. The selection popover closes right after the toast.
4. Honest "Not sent": a network error or 5xx shows the toast "Not sent. Kept in Comments.". The outbox block sits between the rail header and the thread list on both tabs, inside an always-mounted `aria-live="polite"` region. Deviation: Biome (`useSemanticElements`) rejects `role="status"` on a section, so the live region is a plain `div` with `aria-live`. The narrow floating button counts open + not sent, shows a CloudOff icon when something is unsent, and its label reads "Comments (N open, M not sent)".
   - Found in QA: react-query pauses mutations while `navigator.onLine` is false (default `networkMode: "online"`), so an offline send waited forever and never reached the outbox. `useAddComment` now sets `networkMode: "always"`. The outbox's fresh fetch sets `networkMode: "always"` and `retry: false`.
5. Line ranges: `anchorFromRange` trims the bounds like `captureQuote`. `lineStart` is the first block's start line, `lineEnd` is the LAST block's `data-line-end` (new `DomTextSpace.offsetToLineEnd`). The card showed live/'s resolved range (live/'s `withLines` takes the start line of the last block), so `withBlockLineEnd` (in `dom-text-space.ts`) fixes the end line of quote-placed resolutions in `useCommentAnchors`. Both places note the divergence. live/ has the same bug in capture and in `withLines`: upstream follow-up.
6. Verbatim text-file quotes: text viewer rows carry `data-comb-row` (`TEXT_ROW_ATTR`, one attribute added to step-5's `TextLines`). Each row adds exactly one "\n", blank rows included, so the text viewer's text space is the file text. Limit: CRLF files quote "\n" where the file has "\r\n" (`TextLines` drops "\r").
7. `versionAt(versions, createdAt, complete)`: when the log is full (`COMB_LOG_LIMIT` = 200) and no version is old enough, the oldest listed version stands in. The hook's input building is the pure `anchorInputs(comments, currentVersion, log)` in `lib/comb/comments.ts`.
8. One query per file: `agentFsCommentsQuery(access, file)` pages `comment-list {path, resolved: true, limit: 200, offset}` per stored path form until a short page, capped at 2,000 threads (`listFileThreads`; notice "Showing the newest 2,000 threads."). The rail splits open and resolved on `thread.resolved`, so tab counts cover the full list.
9. A `?comment=` deep link opens the bottom sheet on narrow layouts.
10. The card footer always renders: `threadActions` stays visible with an open (or restored) reply box. Reply hides while the reply box is open.
11. Each outbox card has Retry and Discard (both disabled, label "Sending", while that entry is in flight). "Retry all" shows only for 2+ entries.
12. Minor: expired drafts are swept on rail mount (`sweepExpiredDrafts`). Painted ranges store `end - start`. `anchorFromRange(space, range)` takes the rail's space. `useCommentOutbox` returns a memoized value (in-flight state is an immutable snapshot store, no biome-ignore). The pending range paints in the fallback path. `FileView` is keyed by `${orgId}/${driveId}:${path}`. Focus returns to "Comment on file", to "Reply", or to the element focused before the anchored composer opened. "C" opens the anchored composer while the selection button shows (Kbd on the button, `aria-keyshortcuts="C"`, dashboard shortcut rules; the button's own popover is excluded from the open-overlay check via `data-comb-selection`). Each card has a byline button ("File" on file-level cards, "L3-5" on anchored ones) that selects it, so file-level cards are keyboard operable. `browserStorage()` lives in `drafts.ts`, `QuoteExcerpt` in `components/comb/quote-excerpt.tsx`, reduced motion comes from motion's `useReducedMotion`, and `useQueries({ combine })` replaces `diffsKey`.
    - Sent marker: the browser has no reliable signal for the swarm service account (`/status` does not name it, and `AGENT_FS_REGISTER_EMAIL` is free-form, for example `swarm-admin@agent-fs.local` in QA, while per-agent emails also end in `@swarm.local`). So `sentReplyTaskId(thread, reply)` accepts a reply that STARTS with the marker and whose author is not the thread's author. `isSentToSwarm(thread)` uses the same rule.
13. Tests: `drafts.test.ts` (user scope, sweep, send routing, claim and return, retry guard without and with a lock manager, mid-retry merge, dedupe, fetch failure, per-entry retry, pagehide), `comments.test.ts` (versionAt fallback, paging and the 2,000 cap, `anchorInputs` log fallback), `dom-text-space.test.ts` (blank-line verbatim quote, L1-2, L5-7, end at the next block, cross-block, element boundary, `toRange` round-trip, `withBlockLineEnd`), `comment-composer.test.tsx` (happy-dom render with `GlobalRegistrator`: 403 read-only, 5xx and network to the outbox, 400 inline, read-only renders nothing).

QA (API 3270, UI 3271, agent-fs 7407, session `comb-s7`):
- `fix-01`..`fix-03`: a whole paragraph over source lines 3-5, with the selection ending at the start of the next paragraph, opened with "C". CLI `comment list comb-qa/multi.md`: `lineStart: 3, lineEnd: 5`. The card reads L3-5.
- `fix-04`, `fix-05`: `comb-qa/blank.ts`, rows 1-3 across a blank row: `lineStart: 1, lineEnd: 3`, `quote.exact = "const a = 1;\n\n  const b = 2;"`, a verbatim substring of the file.
- `fix-06`, `fix-07`: offline (`agent-browser set offline on`) file-level send: the toast and the "Not sent" card, on the Open and the Resolved tab.
- `fix-08`, `fix-09`: two tabs on the same file, both offline, then both online: the CLI lists the comment once, and neither tab shows the card.
- `fix-10`: an unsent entry left by the QA human is invisible after connecting as the QA viewer.
- `fix-11`: the viewer sends an anchored comment: the toast, the rail notice, the popover closes.
- `fix-12`, `fix-13`: 390 px deep link opens the sheet with the card selected. With one unsent entry the floating button shows the CloudOff icon and 2 (1 open + 1 not sent).
- The browser relaunched once mid-QA (after `agent-browser dblclick` with a CSS selector) and lost localStorage. The QA reconnected and went on.

Known follow-ups (not fixed here):
- A multi-row highlight also tints the gutter numbers inside the range (the DOM range spans the skipped gutter spans). This was already so before these fixes. Fix idea: paint one range per text segment.
- live/ upstream: the line-range end fix (capture and `withLines`).

Notes for later steps (these replace the matching lines above):
- Query key for one file's threads: `agentFsCommentsKey(access, drive, path)` = `["agent-fs", endpoint, userId, orgId, driveId, "comments", path]` (the trailing "open" | "resolved" is gone). Data: `{threads, truncated}` (`FileThreads`). `agentFsCommentsQuery(access, file)` gives the query options (for `fetchQuery`/prefetch). `useAgentFsComments(file)` takes no options now. Invalidate one file with `agentFsCommentsKey(access, drive, path)`, the drive with `agentFsCommentsKey(access, drive)`.
- `useCommentOutbox(scope, {send, fetchThreads})` returns `{entries, sending, add, discard, retry, retryAll}`. `CommentScope` requires `userId`.
- Markers: use `sentReplyTaskId(thread, reply)` and `isSentToSwarm(thread)`. Both need `author` on the thread and its replies. `sentTaskIdOf(reply)` only parses. Step-9's "Send N" count must use `isSentToSwarm`. The server copy can keep its KV claim as the real guard.
- `dom-text-space.ts`: `TEXT_ROW_ATTR` (`data-comb-row`; a new viewer with one-line rows should set it), `offsetToLineEnd`, `anchorFromRange(space, range)`, `AnchorSpace`, `withBlockLineEnd`.
- `comments.ts`: `listFileThreads`, `COMMENT_PAGE_SIZE`, `COMMENT_LIST_MAX`, `COMB_LOG_LIMIT`, `anchorInputs`, `versionAt(..., complete)`.
- `READ_ONLY_MESSAGE` is exported from `comment-composer.tsx`. `QuoteExcerpt` is in `components/comb/quote-excerpt.tsx`.
- A mutation that must fail fast offline (and not pause) needs `networkMode: "always"`.
- Shared files touched: `use-agent-fs.ts` (comments section only: the query, `networkMode`, `COMB_LOG_LIMIT`), `pages/comb/page.tsx` (the `FileView` key), `viewers/text-viewer.tsx` (one attribute). `file-view.tsx` is unchanged.
