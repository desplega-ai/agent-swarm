---
id: step-8
name: Mention picker + bell
depends_on: [step-7, step-2]
status: ready
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
- [ ] UI unit tests pass: `bun run test:root -- apps/ui/src/lib/comb/mentions.test.ts apps/ui/src/lib/notifications/unread.test.ts apps/ui/src/api/hooks/use-agent-fs.test.ts`
- [ ] Typecheck: `bun run tsc:check`
- [ ] Dashboard: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [ ] UI E2E smoke still green (the bell renders on every page): `bun run e2e:ui -- --grep @smoke`

#### Automated QA:
- [ ] Local Comb loop with agent-fs from `$AFS` including steps 1-2 (`/health` lists `drive-members` and `comment-mentions`). Two QA humans A and B, both connected, in two `agent-browser` sessions (`agent-browser --session a` / `--session b`, or two profiles).
- [ ] A types `@` in a composer on `comb-qa/notes.md`: the picker lists "swarm" and B, not A, not any `@swarm.local` agent. A picks B, sends "@B can you check?". `agent-fs comment get <id> --json` shows `mentions` with B's user id.
- [ ] B's bell badge shows 1 within 30 s. B opens the bell, clicks the mention, lands on the file with that thread active. The badge drops to 0 and `agent-fs comment notifications --kind mention` (as B) shows it read.
- [ ] Agent-style mention back: with an agent-fs key for a third account, `agent-fs comment reply <id> --body "@A decision needed" --mention <A email>`. A's bell shows it.
- [ ] Feature-detect: point Comb at agent-fs v0.14.0 (the compose image) and confirm the composer has no picker and the bell has no Mentions section, with no console errors.
- [ ] Screenshots + recording of the mention round trip, uploaded per LOCAL_TESTING.md.

#### Manual Verification:
- [ ] Taras checks the picker position and keyboard feel in a long comment.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.
