---
id: step-7
name: MCP tools + docs
depends_on: [step-1]
status: done
---

# step-7: MCP tools + docs

## Overview

Rewrite the two user-related MCP tools (`resolve-user`, `manage-user`) to the new shape (Q18 — break-and-migrate, no compat shim) and bring the docs into lockstep. Also inventory and rewrite every caller of `resolve-user` across `src/` and `plugin/commands/` (Core Req #16) — workers calling the old field names should error out at runtime, not silently degrade. Regenerate `plugin/pi-skills/user-management/SKILL.md` via `bun run build:pi-skills`. Hand-edit `MCP.md` and `docs-site/.../mcp-tools.mdx` (research §1h confirmed no `bun run docs:mcp` generator).

## Changes Required:

#### 1. `resolve-user` MCP tool — new shape (Q18)

**File**: `src/tools/resolve-user.ts`

**Changes**:

- Input Zod schema (lines 14–21):
  ```ts
  const InputSchema = z.object({
    kind: z.string().optional(),        // 'slack' | 'linear' | 'github' | 'gitlab' | 'jira' | custom
    externalId: z.string().optional(),
    email: z.string().email().optional(),
  }).refine(
    (v) => (v.kind !== undefined && v.externalId !== undefined) || v.email !== undefined,
    { message: 'Provide either (kind + externalId) or email' }
  );
  ```
- Handler:
  - If `kind && externalId`: `findUserByExternalId(kind, externalId)`.
  - Else if `email`: `findUserByEmail(email)`.
  - Return tool response with the matched user OR "No user found".
- **Remove** the four field names (`slackUserId`, `linearUserId`, `githubUsername`, `gitlabUsername`) AND `name` from the schema. Workers passing the old shape error at runtime — intentional per Q18 ("break-and-migrate semantics").

#### 2. `manage-user` MCP tool — identities array

**File**: `src/tools/manage-user.ts`

**Changes**:

- Input Zod schema (lines 27–30): drop the four identity fields. Add `identities: z.array(z.object({ kind: z.string(), externalId: z.string() })).optional()`.
- Create branch (lines 78–104): call `createUser({ name, email, role, dailyBudgetUsd, status, metadata })` (no identity fields) → for each entry in `identities ?? []`, `linkIdentity(user.id, kind, externalId, operatorActor)`.
- Update branch (lines 107–146): call `updateUser` without identity fields. If `identities` provided: compute diff against current `getUserIdentities(userId)` — emit `linkIdentity` for additions and `unlinkIdentity` for removals.
- Email-alias edits (per Q19) emit dedicated `email_added` / `email_removed` events. Manage-user is one of two callers (the People-page edit form in step-9 is the other).

#### 3. Worker-caller inventory + rewrite

**Inventory step**: `grep -RIn '"resolve-user"\|resolve-user' src/ plugin/commands/ plugin/pi-skills/` — produce a list. Likely call-sites:

- `plugin/commands/user-management.md` (entire file — example payloads).
- Possibly `src/server.ts` or MCP-tool middleware glue.
- Possibly `plugin/opencode-plugins/*` (if any reference resolve-user).

**Rewrite step**: replace every old-shape invocation. Examples:

- `{slackUserId: "U_X"}` → `{kind: "slack", externalId: "U_X"}`
- `{githubUsername: "alice"}` → `{kind: "github", externalId: "alice"}`
- `{email: "x@y.com"}` → unchanged (email survives Q18).
- `{name: "Alex"}` → dropped; no replacement. Caller must provide kind+externalId or email.

#### 4. Docs — hand-edited

**File**: `MCP.md`

**Changes** (lines 223–247 and the resolve-user/manage-user sections):

- Update the `resolve-user` doc to the new `{kind?, externalId?, email?}` shape with the refine constraint described.
- Update the `manage-user` doc:
  - Drop the four identity fields from input.
  - Add `identities` array shape.
  - Add `dailyBudgetUsd`, `status`, `metadata` (new fields landed in migration 064).
- **Do NOT touch** line 170 (`send-task.slackUserId` — task-context column, KEPT). **Do NOT touch** the `agent_tasks.slackUserId` references at line 483 / 808 in `CHANGELOG.md`.

**File**: `docs-site/content/docs/(documentation)/reference/mcp-tools.mdx`

**Changes** (lines 766–789, resolve-user + manage-user sections):

- Same content updates as `MCP.md`.
- **Do NOT touch** line 75 (`send-task.slackUserId` — task-context). **Do NOT touch** `docs-site/.../guides/slack-integration.mdx:70, 78` (also `agent_tasks.slackUserId`).

**File**: `plugin/commands/user-management.md`

**Changes**: rewrite the entire file. Update every example payload to use:

- `resolve-user`: `{kind: "slack", externalId: "U_X"}` / `{email: "x@y.com"}`.
- `manage-user`: `{name, email, identities: [{kind, externalId}, ...]}`.
- Include a brief migration note at the top: "Old field names (`slackUserId`, `linearUserId`, etc.) were dropped in 2026-05. Use `{kind, externalId}` shape instead."

#### 5. Regenerate pi-skills

**Command**: `bun run build:pi-skills`

**File**: `plugin/pi-skills/user-management/SKILL.md` (regenerated)

**Changes**: auto-generated from `plugin/commands/user-management.md` above. Commit the regenerated output.

#### 6. Tests

**File**: `src/tests/mcp-tools-user.test.ts` (existing if present; otherwise new)

**Changes**:

- Test: `resolve-user` with `{kind: "slack", externalId: "U_X"}` → matches via `findUserByExternalId`.
- Test: `resolve-user` with `{email: "x@y.com"}` → matches via `findUserByEmail`.
- Test: `resolve-user` with `{slackUserId: "U_X"}` (old shape) → input validation fails with "Unrecognized keys" or Zod's no-extra-keys error.
- Test: `resolve-user` with `{}` → refine fails with "Provide either (kind + externalId) or email".
- Test: `manage-user` create with `identities: [{kind: "slack", externalId: "U_X"}, {kind: "linear", externalId: "L_Y"}]` → user created + 2× `linkIdentity` calls + 2× `identity_added` events.
- Test: `manage-user` update with `identities` diff — adding one + removing one → correct `linkIdentity` + `unlinkIdentity` events.
- Test: `manage-user` update emits `email_added` / `email_removed` when `emailAliases` is changed.

### Success Criteria:

#### Automated Verification:

- [x] `bun test src/tests/mcp-tools-user.test.ts` — all cases pass.
- [x] `bun run lint` passes on `src/tools/**`.
- [x] `bun run build:pi-skills` runs clean — `plugin/pi-skills/user-management/SKILL.md` regenerated and committed.
- [x] `grep -RIn '\(slackUserId\|linearUserId\|githubUsername\|gitlabUsername\)\s*:' plugin/ docs-site/ MCP.md` returns 0 hits outside the kept `send-task` references explicitly listed in research §1h (audit each remaining hit manually).
- [x] Old shape `{name: ...}` removed from `resolve-user` Zod — `grep -n '\.name' src/tools/resolve-user.ts` returns 0 hits.

#### Automated QA:

- [ ] MCP-server walkthrough: with the dev API running (`bun run dev:http`), invoke `resolve-user` over MCP with `{kind: "slack", externalId: <existing-user-slack-id>}` → returns the user. (Covered in `src/tests/mcp-tools-user.test.ts` via direct-handler invocation; live MCP transport pending sibling step completion.)
- [ ] Same walkthrough: invoke with the OLD shape `{slackUserId: <id>}` → returns a clear validation error (NOT silent null match). (Covered at the schema level in `src/tests/mcp-tools-user.test.ts`; live MCP-transport assertion pending.)
- [ ] Same walkthrough: invoke `manage-user` create with the new `identities` array → resulting user has the identities linked (verify via direct DB query + via `getUserIdentities`). (Covered in `src/tests/mcp-tools-user.test.ts` via `getUserIdentities` + `user_identity_events` SQL probe.)
- [x] Run `pi-skills` agent (or any harness that reads from `plugin/pi-skills/user-management/SKILL.md`) — confirm the skill instructions reflect the new shape, not the old. (Regenerated `SKILL.md` mirrors the new MD source; verified by `head` + grep of `kind`/`externalId` tokens — 34 occurrences vs 0 in the old SKILL.md.)

#### Manual Verification:

- [ ] Skim `MCP.md` + `docs-site/.../mcp-tools.mdx` after the edit — wording is consistent, examples compile mentally, no stale `slackUserId`/`linearUserId`/etc. references in user-tool sections.
- [ ] Confirm the regenerated `plugin/pi-skills/user-management/SKILL.md` matches the new source MD (no drift).

**Implementation Note**: After verification passes, commit with `[step-7] mcp: resolve-user new shape + manage-user identities array + docs + pi-skills regen`. The pi-skills file MUST be in the same commit (CI freshness check).
