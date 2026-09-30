---
id: step-2
name: agent-fs comment mentions
depends_on: [step-1]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-2: agent-fs comment mentions

**Repo:** agent-fs (`$AFS` = `/Users/taras/Documents/code/agent-fs`). Builds on step-1 (`SERVER_FEATURES` in `packages/server/src/features.ts`, `listDriveMembersPublic`).

## Overview

Comments can mention drive members. `comment-add` and `comment-update` accept `mentions: string[]` (agent-fs user ids or member emails). Each newly mentioned member gets a targeted `comment_mention` notification. `comment-notification-list` can return mentions, marked with a `kind` field. The CLI gets a repeatable `--mention` flag, so agents can "@human" back. `/health` adds `comment-mentions`.

Backward compatibility: without the new params, every op returns exactly what it returns today. `comment-notification-list` keeps listing only broadcast comment notifications unless the caller asks for `kinds`.

## Changes Required:

#### 1. Storage
**File**: `packages/core/src/db/raw.ts` (`CREATE_TABLES_SQL`)
**Changes**: new table, created with `IF NOT EXISTS` so existing DBs get it on open:
```sql
CREATE TABLE IF NOT EXISTS comment_mentions (
  comment_id TEXT NOT NULL REFERENCES comments(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_comment_mentions_user ON comment_mentions(user_id);
```
Match the timestamp type used by `comments.created_at` in the same file.

**File**: `packages/core/src/db/schema.ts`
**Changes**: drizzle definition `commentMentions` matching the DDL.

**File**: `packages/core/src/db/__tests__/comment-mentions-migration.test.ts` (new)
**Changes**: follow `comment-quote-migration.test.ts`: build an "old" DB without the table, run `CREATE_TABLES_SQL` + `runMigrations` twice, assert the table and index exist and old rows are untouched.

#### 2. Op params and results
**File**: `packages/core/src/ops/types.ts`
**Changes**:
- `CommentAddParams.mentions?: string[]`, `CommentUpdateParams.mentions?: string[]`.
- `CommentEntry.mentions?: Array<{ userId: string; displayName: string | null; email: string }>` (present when the comment has mentions).
- `CommentNotificationListParams.kinds?: Array<"comment" | "mention">`.
- `CommentNotificationEntry.kind: "comment" | "mention"`.

**File**: `packages/core/src/ops/index.ts`
**Changes**: zod: `mentions: z.array(z.string().min(1)).max(20).optional()` on `comment-add` and `comment-update`. `kinds: z.array(z.enum(["comment","mention"])).min(1).optional()` on `comment-notification-list`. Update descriptions.

#### 3. Mention resolution and notifications
**File**: `packages/core/src/ops/comment-mentions.ts` (new)
**Changes**:
- `resolveMentions(ctx, raw: string[]): string[]`: map each entry to a user id. Accept a user id or an email (case-insensitive). Every target must be a member of `ctx.driveId` (use `listDriveMembersPublic` from step-1). Unknown or non-member targets throw `ValidationError` naming the entry. Drop the author and duplicates.
- `saveMentions(ctx, commentId, userIds)`: insert rows (ignore existing), return the ids that are new.
- `emitMentionNotifications(ctx, {commentId, path, parentId, userIds})`: one `events` row per user: `type "comment_mention"`, `resourceType "comment"`, `resourceId commentId`, `target userId`, `metadata {path, parentId}`, same shape as `emitCommentNotifications` (`comment.ts:52-89`).
- `loadMentions(ctx, commentIds)`: batch read for `CommentEntry.mentions`.

**File**: `packages/core/src/ops/comment.ts`
**Changes**:
- `commentAdd` (~185-286): after the insert, resolve + save mentions, emit mention notifications for them. Resolve BEFORE the insert so a bad mention fails the whole call. Keep the broadcast notification as is.
- `commentUpdate` (~411-443): when `mentions` is present, replace the set (delete removed rows, insert new ones) and notify only the newly added users.
- `commentList` and `commentGet`: attach `mentions` for roots and replies with one batched query.

**File**: `packages/core/src/ops/comment-notification.ts`
**Changes**:
- Map kinds to event types: `comment` → `comment_notification`, `mention` → `comment_mention`. `notificationScope` (:17-27) uses `inArray(events.type, types)`. Default `kinds` is `["comment"]`.
- Select `events.type` and map it to `kind` in the entry (:90-99). `unreadCount` counts over the same kinds.
- `commentNotificationRead` (:107-174): accept ids of both types (the update WHERE at :164 uses both types).

#### 4. CLI
**File**: `packages/cli/src/commands/comment.ts`
**Changes**:
- `add`, `reply`, `update`: repeatable `--mention <user-id-or-email>` using the `sql.ts:43-48` pattern (`(value, prev) => [...prev, value], []`). Pass `mentions` only when non-empty.
- `notifications`: `--kind <comment|mention>` (repeatable) mapped to `kinds`. Print the kind column.

#### 5. `/health` + skill + docs
**File**: `packages/server/src/features.ts`
**Changes**: append `"comment-mentions"`.

**File**: `skills/agent-fs/SKILL.md` (~199-211, ~341-366)
**Changes**: document `--mention` on add/reply/update and `notifications --kind mention`, with one example of an agent asking a human for a decision.

Regenerate `docs/openapi.json` (`bun run scripts/sync-openapi.ts`).

#### 6. Tests
**File**: `packages/core/src/ops/__tests__/comment-mentions.test.ts` (new)
**Changes**:
- Mention by user id and by email (case-insensitive) both store one row.
- A non-member or unknown email fails with `ValidationError` and creates no comment.
- The author mentioning themself is dropped.
- The mentioned user sees one `mention` entry with `kinds: ["mention"]`, and zero mention entries with the default kinds.
- `comment-update` with a new mention notifies only the new user. Removing a mention deletes the row and sends nothing.
- `comment-notification-read` marks a mention read. `unreadCount` drops.
- `comment-list` and `comment-get` return `mentions` with displayName and email.

**File**: `packages/core/src/ops/__tests__/comment-notification.test.ts`
**Changes**: existing assertions still pass unchanged (default kinds). Add `kind: "comment"` on entries.

### Success Criteria:

#### Automated Verification:
- [x] Targeted tests pass: `cd "$AFS" && bun test packages/core/src/ops/__tests__/comment-mentions.test.ts packages/core/src/ops/__tests__/comment-notification.test.ts packages/core/src/ops/__tests__/comment.test.ts packages/core/src/db/__tests__/`
- [x] Full suite passes: `cd "$AFS" && bun run test`
- [x] Typecheck passes: `cd "$AFS" && bun run typecheck`
- [x] OpenAPI is fresh: `cd "$AFS" && bun run scripts/sync-openapi.ts && git diff --exit-code docs/openapi.json`
- [x] Local e2e passes: `cd "$AFS" && bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only`

#### Automated QA:
- [x] Start a local server on an EXISTING `AGENT_FS_HOME` created by v0.14.0 data (copy `/tmp/afs-step1` from step-1 QA, or create one with `main` first). The server opens it without errors and `comment_mentions` exists (`sqlite3 <home>/agent-fs.db '.schema comment_mentions'`, adjust the DB file name to what `AGENT_FS_HOME` holds).
- [x] CLI walkthrough with two users A and B on one drive: A runs `agent-fs comment add docs/a.md --body "@B please check" --mention <B email>`. B runs `agent-fs comment notifications --kind mention` and sees one unread entry with `kind=mention`, then `agent-fs comment read <id>`, then the unread count is 0. B runs `agent-fs comment notifications` (default) and sees only the broadcast entry, as on v0.14.0.
- [x] `GET /health` lists `comment-mentions`.

#### Manual Verification:
- [ ] None beyond review. The change is additive and feature-detected.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes. Merging to agent-fs `main` deploys to prod Fly automatically.

## Implementation Notes

- Ambiguous case-insensitive email matches fail with `ValidationError` asking for an exact user id (Codex decision).
- Verification (real sockets): targeted tests 57 pass; full suite 1075 pass, 0 fail; typecheck clean; openapi fresh; local e2e 168/168 (18 FUSE skipped).
- QA on a v0.14.0 home (detached checkout of e713bc6, one file and one comment written): the step-2 server opened it cleanly, `comment_mentions` and `idx_comment_mentions_user` exist, the old comment is kept. `/health` features: share-links, comment-path-prefix, drive-members, comment-mentions.
- CLI walkthrough (A mentions `B@X.io`, case-insensitive): B `--kind mention` saw 1 unread `kind=mention`; `comment read` marked 1; unread count then 0; default `notifications` lists only `kind=comment` entries; an unknown mention fails with "Mention target is not a member of this drive: nobody@x.io" and creates no comment.
- No code changes during verification.
