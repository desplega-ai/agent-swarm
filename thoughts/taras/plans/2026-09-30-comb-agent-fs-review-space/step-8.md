---
id: step-8
name: Mention picker + bell
depends_on: [step-7, step-2]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-8: Mention picker + bell

**Repo:** agent-swarm. Needs agent-fs with step-1 (`drive-members` op) and step-2 (`mentions[]`, `comment-notification-list {kinds}`, `kind` per entry). Local QA runs agent-fs from `$AFS` with steps 1-2 applied.

## Overview

Typing `@` in the Comb comment composer opens a picker with the drive's human members and a special "swarm" entry. Picking a person inserts `@Name` and sends that person's agent-fs user id in `mentions[]`. Picking "swarm" inserts the `@swarm` marker (no mention id; step-9 turns marked comments into a task). A mentioned person sees the mention in the dashboard notification bell, reads it, and jumps straight to the comment. Everything is feature-detected: when agent-fs lacks `comment-mentions` or `drive-members`, the composer stays a plain textarea and the bell shows no Comb section.

When done: "@teammate" works end to end between two humans in the dashboard, and agents can "@human" back through the CLI (`--mention`, step-2).

## Changes Required:

#### 1. Members
**File**: `apps/ui/src/api/hooks/use-agent-fs.ts`
**Changes**: `useDriveMembers()` → `drive-members` op, `staleTime` 5 min, enabled only when `features.has("drive-members")`. Selector `pickableMembers(members, me)` removes the caller and any email ending in `@swarm.local` (agent accounts).

#### 2. Picker in the composer
**File**: `apps/ui/src/lib/comb/caret-position.ts` (new)
**Changes**: textarea caret coordinates via the mirror-div technique (copy computed styles, measure a span at the caret). Pure DOM helper, no dependency.

**File**: `apps/ui/src/lib/comb/mentions.ts` (new)
**Changes**:
- `activeMentionQuery(text, caret)` → `{start, query} | null` when the caret follows `@<word chars>` at a word boundary.
- `insertMention(text, range, label)` → new text + caret.
- `collectMentionIds(body, picked: Map<label, userId>)` → ids whose `@label` still appears in the body (a deleted token drops its mention).
- Labels: `displayName` when set, else the email local part. Disambiguate duplicate labels by appending the email local part.

**File**: `apps/ui/src/components/comb/mention-picker.tsx` (new)
**Changes**: `Popover` (`@/components/ui/popover`) + `Command` list (`@/components/ui/command`) positioned at the caret. First item "swarm · send to the swarm" (inserts `@swarm`), then members filtered by the query (name or email). Up/Down/Enter/Tab/Escape keyboard handling that does not steal Enter from the textarea when the picker is closed.

**File**: `apps/ui/src/components/comb/comment-composer.tsx`
**Changes**: plug the picker into the `renderComposerExtras` mount point from step-7. On send, pass `mentions: collectMentionIds(...)` only when non-empty and `features.has("comment-mentions")`.

**File**: `apps/ui/src/components/comb/comment-thread.tsx`
**Changes**: render `@Name` tokens that match `comment.mentions` as chips (name + email tooltip). The `@swarm` chip already exists (step-7 markers).

#### 3. Bell section
**File**: `apps/ui/src/api/hooks/use-agent-fs.ts`
**Changes**: `useAgentFsMentions()` → `comment-notification-list {kinds: ["mention"], limit: 20}`, `refetchInterval` 30 s, enabled when Comb is `ready` and `features.has("comment-mentions")`. `useMarkMentionsRead()` → `comment-notification-read {ids}`.

**File**: `apps/ui/src/lib/notifications/unread.ts` (new)
**Changes**: pure `totalUnread({staticUnread, mentionsUnread})` so the badge math is testable.

**File**: `apps/ui/src/components/notifications/notification-bell.tsx` (~25-80)
**Changes**: the badge count adds the mentions `unreadCount`. The bell renders when there is a current swarm user OR an active Comb mentions source (today it returns null without `currentUser.userId`, :30). Opening the popover still marks the static definitions read, and does NOT mark mentions read (a mention is read when clicked or with "Mark all read").

**File**: `apps/ui/src/components/notifications/agent-fs-mentions-section.tsx` (new), rendered by `notification-panel.tsx` above the static list
**Changes**: header "Mentions" + "Mark all read". Items: actor name (map `actor` user id through `useDriveMembers`, fall back to "someone"), file name + folder, body excerpt (one line), relative time, unread dot. Click → navigate to `/file/~/<org>/<drive>/<path>?comment=<commentId>` (the reply's root when `parentId` is set) and mark that id read. Empty state "No mentions".

#### 4. Tests
**File**: `apps/ui/src/lib/comb/mentions.test.ts` (new)
**Changes**: query detection at start, after a space, not inside an email (`a@b.com`), insertion and caret, removed tokens drop ids, duplicate labels.

**File**: `apps/ui/src/lib/notifications/unread.test.ts` (new)
**Changes**: badge math with and without a mentions source.

**File**: `apps/ui/src/api/hooks/use-agent-fs.test.ts` (new or extended)
**Changes**: `pickableMembers` drops self and `@swarm.local`.

### Success Criteria:

#### Automated Verification:
- [x] UI unit tests pass: `bun run test:root -- apps/ui/src/lib/comb/mentions.test.ts apps/ui/src/lib/notifications/unread.test.ts apps/ui/src/api/hooks/use-agent-fs.test.ts`
- [x] Typecheck: `bun run tsc:check`
- [x] Dashboard: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [x] UI E2E smoke still green (the bell renders on every page): `bun run e2e:ui -- --grep @smoke`

#### Automated QA:
- [x] Local Comb loop with agent-fs from `$AFS` including steps 1-2 (`/health` lists `drive-members` and `comment-mentions`). Two QA humans A and B, both connected, in two `agent-browser` sessions (`agent-browser --session a` / `--session b`, or two profiles).
- [x] A types `@` in a composer on `comb-qa/notes.md`: the picker lists "swarm" and B, not A, not any `@swarm.local` agent. A picks B, sends "@B can you check?". `agent-fs comment get <id> --json` shows `mentions` with B's user id.
- [x] B's bell badge shows 1 within 30 s. B opens the bell, clicks the mention, lands on the file with that thread active. The badge drops to 0 and `agent-fs comment notifications --kind mention` (as B) shows it read.
- [x] Agent-style mention back: with an agent-fs key for a third account, `agent-fs comment reply <id> --body "@A decision needed" --mention <A email>`. A's bell shows it.
- [x] Feature-detect: point Comb at agent-fs v0.14.0 (the compose image) and confirm the composer has no picker and the bell has no Mentions section, with no console errors.
- [ ] Screenshots + recording of the mention round trip, uploaded per LOCAL_TESTING.md.

#### Manual Verification:
- [ ] Taras checks the picker position and keyboard feel in a long comment.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.

## Implementation Notes

Commit `371778a77` on `comb/s8` (worktree `/Users/taras/worktrees/agent-swarm/2026-09-30-comb-s8`, on the wave-3 tip `d88c49629`). Evidence in `/tmp/comb-run/step-8/` (screenshots `01-*.png` to `23-*.png`, recording `mention-round-trip.webm`). The upload box stays open: the orchestrator uploads the evidence.

Verification notes:
- Tests: 29 new tests pass (`mentions.test.ts`, `unread.test.ts`, `use-agent-fs.test.ts`). The composer and markers tests still pass. `tsc:check`, `apps/ui` lint (plain `bun run lint`, no Biome crash), `tsc -b`, and `check:tokens` pass. UI E2E smoke: 34 passed, 17 skipped (worktree `.env` moved aside for the run, then restored).
- QA ran on agent-fs 0.15.0 source (API 3280, UI 3281, agent-fs 7408). Two browser sessions: A (`comb-s8`, no swarm user) and B (`comb-s8-b`, swarm user "Bea Brown"). A third account C played the agent.
- Picker: "@" lists swarm, Agent C, Bea Brown, and swarm-admin. It hides A (self) and `worker-9@swarm.local`. `swarm-admin@agent-fs.local` (the swarm service account) still shows: see "Notes for later steps". Up/Down, Enter, Tab, and a click pick. Escape closes only the list (the file composer, the anchored composer in the selection popover, and the phone bottom sheet all stay open). A click keeps the focus in the textarea, also inside the modal sheet.
- `comment get` shows `mentions: [B]`. A reply "@x @swarm and @Bea Brown please" sends `mentions: [B]` only.
- B connected with 1 static + 1 mention unread (badge 2). Opening the panel marked the static item read (badge 1). A click on the mention opened `notes.md?comment=<root>` with the thread active, the badge dropped to 0, and `comment notifications --kind mention` (as B) shows it read. "Mark all read" marked 3 mentions read (CLI `unreadCount: 0`).
- Agent-style: C ran `comment reply <id> --body "@qa-a decision needed" --mention qa-a@example.com`. A's bell (no swarm user) showed 1 unread 25 s later. The reply mention opens the root thread. "@qa-a" renders as a chip.
- Feature-detect: agent-fs 0.14.0 from npm (`@desplega.ai/agent-fs@0.14.0`, not the compose image) on the same port with a fresh home and swarm DB. `/health` features: `share-links`. "@b" opens no list, the textarea has no `aria-autocomplete`, a plain comment posts, the bell is absent without a swarm user, and with a user it shows only the static list. No console errors.

Decisions and deviations:
- `pickableMembers` lives in `lib/comb/mentions.ts` (relative imports, so the root test runner can load it). `use-agent-fs.ts` re-exports it, and `use-agent-fs.test.ts` imports the source module. It takes an optional third argument `serviceUserId` for step-9's field.
- `collectMentionIds` gets the label map of every pickable member, not only the picked ones. A typed "@Bea Brown", a restored draft, and an outbox retry all keep their mentions. A deleted token still drops its mention. Matching is case-insensitive and prefers the longest label.
- The picker renders only with both `comment-mentions` and `drive-members` (the plan's feature-detect rule). `sendParamsRef` sends `mentions` only when non-empty.
- Labels: display name, else the email local part. A repeated label (or "swarm") gets `(local part)`, then `(email)`. Chips match the display name, the local part, the email, and both disambiguated forms of each mentioned member (agents may write any of them).
- `activeMentionQuery` returns `{start, end, query}` (`end` added: a pick replaces the whole word under the caret). A mention starts at the text start, after whitespace, or after an opening bracket or quote.
- Escape closes the list until the next "@". Keys go to the list only while it is open. The listener sits on the textarea and prevents the event, so the composer's own handler skips it. Radix handles Escape first (the list is the top layer), so a parent popover or sheet stays open.
- The textarea gets `aria-autocomplete="list"`, plus `aria-controls` and `aria-activedescendant` while the list is open (read from cmdk's DOM after it renders, because cmdk sets its own ids).
- Bell: no swarm user and an active mentions source shows the bell with the Mentions section only (static definitions need a user for their read state). Opening the panel still marks static items read and never marks mentions read. The badge caps at "9+" (`unreadBadgeLabel`), because mentions can push the count past one digit in a 16 px circle.
- The Mentions section maps `actor` through `useDriveMembers` (display name, else email, else "someone"). Unread dot is `bg-primary`.
- `CommentNotificationEntry.kind` is optional in the dashboard type (absent on 0.14.0 servers).

Notes for later steps:
- Exports: `lib/comb/mentions.ts`: `pickableMembers(members, selfUserId, serviceUserId?)`, `labelMembers`, `LabeledMember`, `SWARM_LABEL`, `activeMentionQuery`, `MentionQuery`, `insertMention`, `collectMentionIds`, `splitMentions`, `MentionSegment`, `mentionRoute(drive, entry)` (Comb route with `?comment=<root id>`, either stored path form). `lib/comb/caret-position.ts`: `caretOffset`, `caretClientRect`. `lib/notifications/unread.ts`: `totalUnread`, `unreadBadgeLabel`. Types: `CommentMention`, `CommentEntry.mentions?`, `CommentNotificationEntry.kind?`, `CommentNotificationReadResult`.
- Hooks (`api/hooks/use-agent-fs.ts`): `useAgentFsMentions()` returns `{drive, query}` (`drive` null when inactive). Key: `["agent-fs", endpoint, userId, orgId, driveId, "notifications", "mention"]` (swarm drive), 30 s poll. `useMarkMentionsRead()` mutates `{ids}` or `{all: true}`.
- Mount: `file-view.tsx` passes `renderComposerExtras={renderMentionPicker}` on its own line under the comment `// step-8: "@" mention picker in every composer.` (the `<CommentRail>` JSX is now multi-line). `renderMentionPicker` is a stable module function.
- Step-9 merge: in `components/comb/mention-picker.tsx`, the line `// Step-9 merge: pass status.agent_fs.comb.service_user_id as the third argument.` marks the `pickableMembers(members ?? [], userId)` call. Until then the swarm service account (`AGENT_FS_REGISTER_EMAIL`, for example `swarm-admin@agent-fs.local`) shows in the picker.
- `NotificationPanel` props are now `{stateByKey, showStatic, mentionsDrive, onNavigate}`.
- Gotcha: `agent-browser` clicks right after Escape can hit the list's 100 ms exit animation ("covered by div#radix-..."). Wait about 300 ms.

### Review fixes

Commit `e302d4c73` on `comb/s8` (on top of `371778a77`). Evidence: `/tmp/comb-run/step-8/fix-01-*.png` to `fix-11-*.png`, `fix-ime-results.txt`.

What changed:
- Picked-only mentions. The composer owns `picked` (`Map<label, userId>`), exposed on `ComposerExtrasContext.picked`. The picker adds to it on a member pick, before `setBody`. `writeDraft(storage, key, text, now, mentions?)` saves it with the draft as `[label, userId]` pairs. `readDraftMentions(storage, key, now)` restores it. `finish()` clears it. `collectMentionIds(body, picked)` resolves only picked labels that are still in the body. A typed name (for example "@admin" or "@Agent C") notifies nobody. The outbox entry needs no extra seeding: its `params.mentions` already holds the ids resolved at send time, and a retry sends them unchanged.
- IME. The picker key guard is `event.isComposing || event.keyCode === 229` (same rule as `lib/enter-submit.ts`). `PopoverContent` has `onEscapeKeyDown` that prevents the dismiss during a composition (same guard, so Safari's keyCode 229 Escape is covered too). The dead `case "Escape"` is gone: Radix handles Escape on the document in the capture phase before the textarea listener.
- Bell layout. The Mentions list is `max-h-64 overflow-y-auto` (about 3.5 rows). The static cards render under it in their own block, so they stay in view. The section takes `query` from the bell (`AgentFsMentions["query"]`), and `useMarkMentionsRead(drive)` takes the bell's drive. Mark-read failures show `toast.error(err.message || "Could not mark mentions read")` in the hook's `onError`.
- Quadratic regex. `activeMentionQuery` runs `QUERY_CHARS` on the last 64 characters before the caret only (`MAX_QUERY_LENGTH`). A longer word is not a mention. The old code took 210 ms on `"a".repeat(20000) + " "`. The new test runs four 20k cases under 50 ms.
- Marker collision. New UI regex, for the orchestrator to align with the step-9 server copy (`src/comb/markers.ts`) byte for byte: `/(^|\s)@swarm(?![\p{L}\p{N}_-]|[.@][\p{L}\p{N}_-])/iu`. `splitSwarmMarkers` now builds its global copy with `SWARM_MARKER_RE.flags + "g"` (the `u` flag is required for `\p{...}`). `labelMembers` reserves a label when `@<label>` would match the marker: it uses the next form (display name, then email local part, then email, then user id). Examples: "Swarm Fan" <fan@x.io> becomes "fan". A display name "swarm" with email swarm@y.io becomes "swarm@y.io". "swarm-admin" and "Swarmy" stay, because the new regex does not match them.
- Picker anchor: `anchorStart = matchStart ?? anchorAt.current`, `PopoverContent key={anchorStart}`, className `animate-none!` (computed `animation-name: none`). Caret mirror: `overflowX: hidden`, `overflowY: scroll` when `scrollHeight > clientHeight`.
- aria: one effect (deps `[enabled, textareaRef]`) sets `aria-autocomplete` and removes all three list attributes in its cleanup.
- Moves: `pickableMembers` is imported from `lib/comb/mentions` directly (no re-export from the hooks file), and `use-agent-fs.test.ts` is deleted (its tests moved to `mentions.test.ts`). `pickerItems`, `PickerItem` (`{value, label, detail, userId: string | null}`), and `markMentionsRead(list, ids | null)` now live in `lib/comb/mentions.ts`. `totalUnread` is inlined in the bell. `unread.ts` keeps `unreadBadgeLabel` only.

Decisions and deviations:
- Marker regex: the fix asked for "not followed by `-`, `.`, or a name character". I kept "." (and "@") as an end when no name character follows, so "please fix this @swarm." still marks the comment. "@swarm.bot" and "@swarm@x.io" do not match. This is the same boundary rule as a mention token (`endsToken`). The strict form would silently drop the marker at the end of a sentence.
- A reserved label hides the display name in the inserted token, so `pickerItems` now also matches the display name ("@Swa" finds "fan") and shows it in the detail ("Swarm Fan · fan@example.com") when the label does not contain it.
- The picked map is not pruned when a token is deleted. If the human deletes "@Ann" and types "@Ann" again in the same composer, it is still a mention (they picked Ann in this composer). Undo keeps working.

Verification: `bun run test:root -- apps/ui/src/lib/comb/ apps/ui/src/lib/notifications/ apps/ui/src/api/ apps/ui/src/components/comb/` (239 pass), `bun run tsc:check`, `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens` (plain lint, no Biome crash), `check-floating-promises` 0, `check-promise-sinks` 0.

Browser QA (agent-fs 0.15.0 source on 7408, API 3280, UI 3281, sessions `comb-s8` = A and `comb-s8-b` = B "Bea Brown"; all stopped and closed after):
- "@" lists swarm, Agent C, Bea Brown, fan ("Swarm Fan"), swarm-admin, and `べん太`. "@Swa" finds swarm, fan, and swarm-admin (fix-01).
- A picked Bea with Enter, then typed "please check, and @Agent C too" without picking. `comment list` shows `mentions: [B]`. C's mention inbox stayed at 0, B's grew by 1 (fix-02).
- A typed "@Bea Brown typed by hand" (Escape on the list, no pick): the comment has no `mentions`, B's inbox did not change (fix-03). Escape closed only the list.
- A picked Bea, typed more, reloaded: the composer reopened with the draft, and the send carried `mentions: [B]`.
- IME: agent-browser cannot drive an IME and its `eval` is blocked in this harness, so `fix-ime.ts` sent CDP input to the page. After "@" plus `Input.imeSetComposition "べ"` (the list shows `べん太`): Enter (`isComposing: true`) did not pick, Escape (`isComposing: true`) was prevented and the list stayed open (fix-04). A Safari-style Enter (`keyCode 229`, `isComposing: false`) did not pick. A plain Escape closed only the list. A plain Enter picked.
- Bell: B with 21 unread mentions (20 posted by C) and the static Slack card. The panel is 538 px tall, the Mentions list is 256 px and scrolls, and the static card stays in view before and after scrolling the list (fix-05, fix-06). With agent-fs stopped, "Mark all read" showed the toast "Cannot reach agent-fs at http://localhost:7408" (fix-07).
- aria: with the list open, the textarea has `aria-controls` and `aria-activedescendant` pointing at cmdk's ids. After Escape both are gone and `aria-autocomplete` stays (fix-08). Gotcha: in headless agent-browser, `requestAnimationFrame` callbacks run only when a frame renders (a screenshot forces one). Take a screenshot before you read rAF-driven DOM state.
- Anchor: the list moved from under line 4 (y 371) to under line 1 (y 311) when a click moved the caret to another "@" (fix-09, fix-10). In a scrolled textarea (240 px, 14 lines), the list opens under the last wrapped line (fix-11).
- Not re-run: the agent-fs 0.14.0 feature-detect leg (the aria cleanup on "disabled" is the same effect cleanup as unmount).

Notes for later steps (supersede the list above where they differ):
- `NotificationPanel` props are now `{stateByKey, showStatic, mentions: AgentFsMentions, onNavigate}`. `AgentFsMentionsSection` props: `{drive, query, onNavigate}`. `useMarkMentionsRead(drive)` takes the drive. `lib/notifications/unread.ts` exports `unreadBadgeLabel` only.
- `ComposerExtrasContext` has a new `picked: Map<string, string>` field. Any other composer extra that inserts a mention must add to it before `setBody`.
- Step-9: copy the regex above into `src/comb/markers.ts` exactly, with the `iu` flags. Any server code that builds a global copy must keep the `u` flag.
- Step-7 follow-up (not changed here): the composer's own `onKeyDown` checks only `event.nativeEvent.isComposing`. In Safari, an Escape or Cmd+Enter that ends a composition (keyCode 229) can still close the composer or send while the picker list is closed.
