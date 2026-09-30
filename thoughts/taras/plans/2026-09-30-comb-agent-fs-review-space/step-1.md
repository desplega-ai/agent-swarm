---
id: step-1
name: agent-fs comment prefix + drive-members op
depends_on: []
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-1: agent-fs comment prefix + drive-members op

**Repo:** agent-fs (`$AFS` = `/Users/taras/Documents/code/agent-fs`). Work on a branch or worktree of `$AFS`, never on the swarm repo.

## Overview

Two small read additions in agent-fs that Comb needs, plus the `/health` feature strings that let a client detect them:

1. `comment-list` accepts `pathPrefix`, so a folder view can list every unresolved comment below it in one call.
2. A new op `drive-members` lets ANY drive member (viewer and up) list the drive's members as `{userId, email, displayName}`. Today only admins can list members.

When done, `/health` returns `features: ["share-links", "comment-path-prefix", "drive-members"]`, and both ops work over HTTP, MCP, and the CLI.

Decision carried from the plan: exposing member emails to every drive member is intended (Taras chose name + email). Roles stay private. The code comment in `comment.ts:157-165` ("emails remain private") must be updated to say what is now true.

## Changes Required:

#### 1. `comment-list` path prefix
**File**: `packages/core/src/ops/types.ts` (`CommentListParams`, ~284-291)
**Changes**: add `pathPrefix?: string`.

**File**: `packages/core/src/ops/index.ts` (`comment-list` entry, ~299-310)
**Changes**: add `pathPrefix: z.string().optional()` to the schema. Reject `path` and `pathPrefix` together with a zod `refine` (clear message). Update the op `description` to mention the prefix filter.

**File**: `packages/core/src/ops/comment.ts` (`commentList`, ~288-356)
**Changes**:
- When `pathPrefix` is set, add `like(schema.comments.path, <escaped prefix> + "%")` with an `ESCAPE '\\'` clause (use a drizzle `sql` fragment, because `like()` has no escape argument). Escape `\`, `%`, and `_` in the prefix. Normalize the prefix with `normalizePrefix()` from `packages/core/src/ops/paths.ts:21-26` so `docs` and `/docs/` behave the same. An empty or `/` prefix means the whole drive.
- Keep today's defaults (unresolved roots unless `resolved: true`) and ordering.

#### 2. `drive-members` op
**File**: `packages/core/src/identity/drives.ts` (`listDriveMembers`, ~105-119)
**Changes**: add a sibling `listDriveMembersPublic(db, driveId)` that selects `users.id`, `users.email`, `users.displayName` (no role). Do not change the admin listing.

**File**: `packages/core/src/ops/drive-members.ts` (new)
**Changes**: handler `driveMembers(ctx, params: {})` → `{ members: Array<{ userId: string; email: string; displayName: string | null }> }`, sorted by `displayName ?? email`. Scope: `ctx.driveId` only.

**File**: `packages/core/src/ops/types.ts`
**Changes**: `DriveMembersParams`, `DriveMember`, `DriveMembersResult`.

**File**: `packages/core/src/ops/index.ts`
**Changes**: import the handler, add the `opRegistry` entry (`description`, `handler`, `schema: z.object({})`), add it to the re-export list (~406).

**File**: `packages/core/src/identity/rbac.ts` (`OP_ROLES`, ~15-50)
**Changes**: `"drive-members": "viewer"`. Without this row the op defaults to admin.

**File**: `packages/core/src/ops/comment.ts` (~157-165)
**Changes**: update the comment above `addAuthorNames` so it no longer claims that emails are private. Roles remain private.

#### 3. CLI
**File**: `packages/cli/src/commands/comment.ts` (`list`)
**Changes**: add `--prefix <path>` mapped to `pathPrefix`.

**File**: `packages/cli/src/commands/` (new `members.ts`, or the closest existing drive/org command file)
**Changes**: `agent-fs members` (or `agent-fs drive members`, pick the style that matches the existing command tree) that calls `drive-members` and prints a table, `--json` supported like sibling commands. Register it where the other commands register.

#### 4. `/health` features
**File**: `packages/server/src/features.ts` (new)
**Changes**: `export const SERVER_FEATURES = ["share-links", "comment-path-prefix", "drive-members"] as const`. Later steps append to this list.

**File**: `packages/server/src/app.ts` (~70-72)
**Changes**: `/health` returns `features: [...SERVER_FEATURES]`. Keep the comment about older servers omitting `features`.

**File**: `packages/core/src/openapi.ts` (~75) if the health schema enumerates features, then regenerate `docs/openapi.json` with `bun run scripts/sync-openapi.ts`.

#### 5. Skill + docs
**File**: `skills/agent-fs/SKILL.md` (comments table ~199-211, examples ~341-366)
**Changes**: document `comment list --prefix` and the members command. `RELEASING.md:26` requires skill updates when commands change.

#### 6. Tests
**File**: `packages/core/src/ops/__tests__/comment.test.ts`
**Changes**: prefix cases: nested paths match, a sibling folder with the same leading characters does not (`docs/` vs `docs-old/`), `_` and `%` in folder names match literally, `path` + `pathPrefix` together is a validation error, resolved filter still works.

**File**: `packages/core/src/ops/__tests__/drive-members.test.ts` (new)
**Changes**: a viewer can call it through `dispatchOp` (no permission error), the result has no `role`, a user of another drive is not listed, `displayName` is null when unset.

**File**: `packages/server/src/__tests__/share.test.ts:138` (or a new `health.test.ts`)
**Changes**: assert `features` contains `comment-path-prefix` and `drive-members`.

### Success Criteria:

#### Automated Verification:
- [x] Targeted tests pass: `cd "$AFS" && bun test packages/core/src/ops/__tests__/comment.test.ts packages/core/src/ops/__tests__/drive-members.test.ts packages/server/src/__tests__/`
- [x] Full suite passes: `cd "$AFS" && bun run test`
- [x] Typecheck passes: `cd "$AFS" && bun run typecheck`
- [x] OpenAPI is fresh: `cd "$AFS" && bun run scripts/sync-openapi.ts && git diff --exit-code docs/openapi.json`
- [x] Versions check: `cd "$AFS" && bun run scripts/sync-versions.ts --check`
- [x] Local e2e passes: `cd "$AFS" && bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --local-only`

#### Automated QA:
- [x] Start a local server (`AGENT_FS_HOME=/tmp/afs-step1 AGENT_FS_STORAGE_PROVIDER=local SERVER_PORT=7433 bun run packages/cli/src/index.ts server`). `GET /health` lists both new features.
- [x] Register two users (A, B). Share one drive: A invites B as `viewer` (`POST /orgs/:org/members/invite`). With B's key, `POST /orgs/:org/ops {"op":"drive-members","driveId":...}` returns both users with email and displayName and no role. Before this change the same call path for members was admin-only.
- [x] With A's key, write `docs/a.md`, `docs/sub/b.md`, `docs-old/c.md`, add one comment on each, then `comment-list {"pathPrefix":"docs/"}` returns exactly the two `docs/` comments. CLI `agent-fs comment list --prefix docs/` shows the same two.

#### Manual Verification:
- [ ] Taras confirms the email exposure to all drive members is acceptable for prod (it deploys on merge to `main`).

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes. Merging to agent-fs `main` deploys to prod Fly automatically.

## Implementation Notes

- Codex implemented, Claude verified outside the sandbox: full suite 1066 pass / 0 fail, typecheck, openapi fresh, versions, local e2e 167/167. QA ran on port 7401.
- CLI style: top-level `agent-fs members` (matches the current command tree), `--json` supported. `comment list --prefix <path>` added.
- MCP unwraps the refined zod schema (otherwise the `path`/`pathPrefix` refine hides the `comment-list` fields from MCP).
- Prefix matching supports absolute and relative stored paths and stays case-sensitive (SQLite LIKE is case-insensitive by default).
- `path` + `pathPrefix` together returns HTTP 500 with the zod message, same as every other zod validation error in the server today (unchanged).
- No version bump: the release script commits and pushes. Orchestrator does it (likely `./scripts/release.sh 0.14.1`).
- `scripts/e2e.ts` extended with prefix and drive-members cases.
- No code changes were needed during verification.
