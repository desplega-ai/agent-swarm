---
id: step-7
name: Comments with anchors
depends_on: [step-5]
status: ready
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
- [ ] UI unit tests pass: `bun run test:root -- apps/ui/src/lib/comb/`
- [ ] Typecheck: `bun run tsc:check`
- [ ] Dashboard: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`

#### Automated QA:
- [ ] Local Comb loop (root.md), QA human connected, `comb-qa/notes.md` open.
- [ ] `agent-browser` selects the text "Second paragraph" (`agent-browser eval` with a DOM Range + `getSelection().addRange`), clicks "Comment", types "Tighten this", sends. The rail shows the thread. `agent-browser eval "CSS.highlights.has('comb-comment')"` is `true`. Screenshot shows the highlight.
- [ ] `bun run "$AFS/packages/cli/src/index.ts" comment list comb-qa/notes.md --json` (as the QA human) shows the comment with `lineStart`, `lineEnd`, and `quote.exact = "Second paragraph."` or the selected text.
- [ ] Re-anchoring: with the CLI, insert two lines at the top of `notes.md` (new version). Reload Comb: the highlight is on the moved passage and the card shows no "lost" badge. Replace the passage entirely: the card shows "lost".
- [ ] Reply, resolve (moves to Resolved tab), reopen (back to Open). File-level comment on `comb-qa/media/pic.png` (if step-6 is merged) or on `blob.bin`.
- [ ] Draft survives reload: type in the composer, reload, the text is back. Outbox: `agent-browser` sets the page offline (`agent-browser eval` cannot, so stop the local agent-fs server instead), send a comment, see "Not sent", restart agent-fs, click Retry, the comment posts.
- [ ] Cross-client check: open the same file in `live/` (`https://live.agent-fs.dev/?apiUrl=http://localhost:7433&apiKey=<qa key>` or a local `live/` dev server) and confirm the comment highlights the same passage.
- [ ] Screenshots + recording of select → comment → reply → resolve, uploaded per LOCAL_TESTING.md.

#### Manual Verification:
- [ ] Taras tries selection-to-comment on a long real markdown file and judges whether the highlight colors and rail layout are readable in light and dark themes.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.
