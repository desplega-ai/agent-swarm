---
date: 2026-04-03T14:00:00-07:00
topic: "Per-Repo Guidelines (PR Checks, Merge Policy, Review Guidance)"
author: Claude
status: implemented
tags: [plan, ci, code-quality, pre-commit, pr-quality, prompting]
autonomy: verbose
last_updated: 2026-04-03
last_updated_by: Claude
implemented_at: 2026-04-03
---

# Per-Repo Code Quality Checks Implementation Plan

## Overview

Agents create PRs with failing CI and don't autonomously fix failures. The root cause is that the swarm has no project-agnostic mechanism to know or enforce what quality checks a project requires. This plan adds per-repo guidelines (PR checks, merge policy, review guidance) stored in the repo config API, injected into agent prompts, enforced in plugin commands, and gated at the lead level.

## Current State Analysis

- **Repo config** (`swarm_repos` table): Has `url`, `name`, `clonePath`, `defaultBranch`, `autoClone` — no quality checks field
- **`/create-pr` command**: 6-step workflow with NO pre-check steps before pushing
- **`/implement-issue` command**: "Run linters and tests" is a tip on line 59, not a mandatory step
- **Session templates**: Zero CI/quality instructions for any agent
- **Lead template**: No merge-safety or quality-gating instructions
- **Coder template**: Advisory "run tests before push" in SOUL.md/CLAUDE.md — not enforced

### Key Discoveries:
- Docker workers don't have project-specific hook managers (prek, husky, etc.) installed (`Dockerfile.worker:38-54`)
- Claude Code runs with `--dangerously-skip-permissions` (`src/providers/claude-adapter.ts:232-235`)
- CI webhook handlers exist but are deliberately suppressed (`src/github/handlers.ts:919-974`)
- Repo context is injected into prompts via `getBasePrompt()` under `## Repository Context` — never truncated (`src/prompts/base-prompt.ts:87-102`)
- `fetchRepoConfig()` already fetches repo config per task (`src/commands/runner.ts:41-59`)

## Desired End State

1. Every repo in the swarm has explicit guidelines defined by the user (PR checks, merge policy, review guidance)
2. The lead blocks task routing to repos without guidelines defined
3. Agents see the repo's guidelines in their system prompt under Repository Guidelines
4. `/create-pr` and `/implement-issue` enforce running PR checks before pushing
5. `/review-pr` references the repo's review guidance and merge policy
6. The lead verifies CI is green + respects `allowMerge` before merging any PR
7. This works for ANY project (not specific to biome, prek, jest, etc.) and for both Claude Code and pi-mono providers

### Verification:
- Guidelines are stored and retrievable via `GET /api/repos`
- Agent prompts include the repo's guidelines under Repository Guidelines
- `/create-pr` refuses to push without running PR checks
- Lead blocks routing to repos without defined guidelines
- Lead respects `allowMerge` flag and verifies CI + human review before merging

## Quick Verification Reference

Common commands to verify the implementation:
- `bun run tsc:check` — TypeScript type check
- `bun run lint:fix` — Biome lint and format
- `bun test` — Unit tests
- `bash scripts/check-db-boundary.sh` — DB boundary check
- `bun run build:pi-skills` — Regenerate pi-skills from commands
- `bun run docs:openapi` — Regenerate OpenAPI spec

Key files to check:
- `src/be/migrations/` — New migration for `guidelines` column
- `src/types.ts` — Updated `SwarmRepoSchema` + new `RepoGuidelinesSchema`
- `src/be/db.ts` — Updated CRUD functions
- `src/http/repos.ts` — Updated API validation
- `src/prompts/base-prompt.ts` — Guidelines injection into prompts
- `src/commands/runner.ts` — Pass guidelines to prompt
- `plugin/commands/create-pr.md` — Mandatory PR checks step
- `plugin/commands/implement-issue.md` — Mandatory PR checks step
- `plugin/commands/review-pr.md` — Review guidance + merge policy references
- `templates/official/lead/CLAUDE.md` — Guidelines gating + delegation context + merge safety
- `templates/official/coder/CLAUDE.md` — Strengthened guidelines references

## What We're NOT Doing

- **Not re-enabling suppressed CI webhook handlers** — The cascade merge risk remains. Better prompting is the approach.
- **Not adding Claude Code `PreToolUse` hook enforcement** — Doesn't work for pi-mono. Prompting is provider-agnostic.
- **Not hardcoding specific tools** (biome, jest, prek, etc.) — Quality checks are user-defined per repo.
- **Not adding auto-fix logic for CI failures** — Out of scope. Agents should get it right before pushing.
- **Not changing the merge-gate CI pipeline** — It works correctly; the problem is upstream.
- **Not updating the `commit-push-pr` desplega plugin skill** — This is an external plugin skill (`commit-commands:commit-push-pr`), not an agent-swarm plugin command. If agents use it to create PRs, it bypasses the updated `/create-pr` workflow. This is a known limitation — the desplega plugin should be updated separately to reference Repository Guidelines.

## Implementation Approach

Prompting-first, provider-agnostic. Store quality checks in the repo config API, inject them into agent prompts at assembly time, enforce them in plugin commands, and gate them at the lead level. All changes work for both Claude Code and pi-mono since they operate on prompt content and command files, not provider-specific hooks.

---

## Phase 1: DB + API + MCP Tools — Add `guidelines` to Repo Config

### Overview
Add a `guidelines` TEXT column to `swarm_repos` storing a JSON object with structured repo guidelines. This covers PR quality checks, merge policy, and review instructions — all user-defined per repo. Also create MCP tools (`get-repos`, `update-repo`) so the lead can check and set guidelines without resorting to raw HTTP calls.

```typescript
type RepoGuidelines = {
  prChecks: string[];       // Commands or mini-tasks to run before creating a PR (e.g., “bun run lint:fix”, “ensure tests exist for new functions”)
  mergeChecks: string[];    // What to verify before merging (e.g., “all CI checks pass”, “at least one human approval”)
  allowMerge?: boolean;     // Whether auto-merge is allowed. Default: false
  review: string[];         // Review guidance for reviewers (e.g., “check xxx.md”, “enforce camelCase in yyy/”)
};
```

NULL means “not yet defined” (lead should ask). An empty object `{}` with empty arrays means “explicitly no checks.”

### Changes Required:

#### 1. New SQL Migration
**File**: `src/be/migrations/NNN_repo_guidelines.sql` (next number after highest existing)
**Changes**: 
```sql
ALTER TABLE swarm_repos ADD COLUMN guidelines TEXT DEFAULT NULL;
```
The column stores a JSON string of the `RepoGuidelines` type.

#### 2. TypeScript Types
**File**: `src/types.ts`
**Changes**: Add `RepoGuidelinesSchema` and include it in `SwarmRepoSchema`:
```typescript
export const RepoGuidelinesSchema = z.object({
  prChecks: z.array(z.string()),
  mergeChecks: z.array(z.string()),
  allowMerge: z.boolean().optional().default(false),
  review: z.array(z.string()),
});

export type RepoGuidelines = z.infer<typeof RepoGuidelinesSchema>;

// In SwarmRepoSchema:
guidelines: RepoGuidelinesSchema.nullable().optional(),
```

#### 3. DB Functions
**File**: `src/be/db.ts`
**Changes**:
- Update `SwarmRepoRow` type to include `guidelines: string | null`
- Update `rowToSwarmRepo()` to parse JSON: `guidelines: row.guidelines ? JSON.parse(row.guidelines) : null`
- Update `createSwarmRepo()` to serialize: `JSON.stringify(data.guidelines)` if provided
- Update `updateSwarmRepo()` to handle the new field

#### 4. API Validation
**File**: `src/http/repos.ts`
**Changes**:
- Add `guidelines` to POST body schema (optional, nullable `RepoGuidelinesSchema`)
- Add `guidelines` to PUT body schema (optional, nullable `RepoGuidelinesSchema`)
- Ensure GET responses include the field

#### 5. MCP Tools for Repo Management
**Files**: `src/tools/repos/get-repos.ts`, `src/tools/repos/update-repo.ts`
**Changes**: Create two new MCP tools:

**`get-repos`** — Lists registered repos with their guidelines. Wraps `GET /api/repos`. Returns repo name, url, clonePath, defaultBranch, and guidelines. Supports optional `name` filter parameter. The lead uses this to check if a repo has guidelines before routing tasks.

**`update-repo`** — Updates a repo's configuration including guidelines. Wraps `PUT /api/repos/{id}`. Accepts repo ID and partial update fields (including `guidelines`). The lead uses this to set guidelines after asking the user.

Follow the existing MCP tool pattern (see `src/tools/` for examples). Register both tools in the tool chain.

#### 6. OpenAPI Spec
**Command**: `bun run docs:openapi`
**Why**: The repo API schema changed, regenerate the spec.

#### 7. Migration Strategy for Existing Repos
**Note**: When the migration runs, all existing repos get `guidelines: NULL`. To avoid breaking existing deployments:
- The lead should treat `NULL` as "guidelines not yet configured" and proactively ask users to define guidelines for existing repos during its next session.
- Until guidelines are set, the lead should WARN but still route tasks (soft gate) for existing repos that were already working. For NEW repos added after this change, the lead should hard-block.
- The distinction: repos with `createdAt` before this migration was applied get a soft gate; repos created after get a hard gate. In practice, this can be simplified to: if guidelines is NULL and the repo already has task history, warn. If guidelines is NULL and no task history, block.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Unit tests pass: `bun test`
- [ ] DB boundary check: `bash scripts/check-db-boundary.sh`
- [ ] Fresh DB works: `rm -f agent-swarm-db.sqlite* && bun run start:http` (then Ctrl+C)
- [ ] Existing DB migrates: `bun run start:http` (with existing DB, then Ctrl+C)
- [ ] OpenAPI regenerated: `bun run docs:openapi && test -z "$(git diff --name-only openapi.json)"`
- [ ] MCP tools registered: verify `get-repos` and `update-repo` appear in the tool list

#### Manual Verification:
- [ ] Test `get-repos` MCP tool returns repos with guidelines field
- [ ] Test `update-repo` MCP tool can set guidelines on a repo
- [ ] Create a repo with guidelines: `curl -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" -d '{"url":"github.com/test/repo","name":"test-repo","guidelines":{"prChecks":["npm test","npm run lint"],"mergeChecks":["all CI checks pass"],"allowMerge":false,"review":["check README.md"]}}' http://localhost:3013/api/repos`
- [ ] Verify guidelines are returned: `curl -H "Authorization: Bearer 123123" http://localhost:3013/api/repos | jq '.repos[].guidelines'`
- [ ] Update guidelines: `curl -X PUT -H "Authorization: Bearer 123123" -H "Content-Type: application/json" -d '{"guidelines":{"prChecks":["npm test"],"mergeChecks":[],"review":[]}}' http://localhost:3013/api/repos/<id>`
- [ ] Verify NULL vs empty distinction: repo without guidelines shows `null`, repo with empty arrays shows `{"prChecks":[],...}`

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 2: Inject Repo Guidelines into Agent Prompts

### Overview
When assembling an agent's system prompt, inject the repo's guidelines alongside the repo's CLAUDE.md under `## Repository Context`. This ensures every agent working on a repo sees PR checks, merge policy, and review guidance in their prompt — no discovery needed.

### Changes Required:

#### 1. Extend Repo Context Type
**File**: `src/prompts/base-prompt.ts`
**Changes**: Add `guidelines` to the `repoContext` type in `BasePromptArgs`:
```typescript
repoContext?: {
  claudeMd?: string | null;
  clonePath: string;
  warning?: string | null;
  guidelines?: RepoGuidelines | null;
};
```

#### 2. Inject Guidelines into Prompt
**File**: `src/prompts/base-prompt.ts`
**Changes**: In the repo context injection block (around line 87-102), after injecting the CLAUDE.md content, add a section for repo guidelines. When `guidelines` is non-null and has any non-empty array, render:

```
## Repository Guidelines (MANDATORY)

### PR Checks — Run ALL before pushing code or creating a PR:
1. `command-or-task-1`
2. `command-or-task-2`
If ANY check fails, fix the issue before pushing. Do NOT push code with failing checks.
Do NOT use `--no-verify` or any flag that bypasses git hooks.

### Merge Policy:
- Auto-merge: [Allowed / Not allowed (default)]
- Before merging, verify: [mergeChecks items]

### Review Guidance:
- [review items]
```

When `guidelines` is `null`, render: "No repository guidelines defined. If you need to push code, ask the lead or user to define guidelines first."

When `guidelines` has all empty arrays, render nothing (user explicitly chose no checks).

#### 3. Pass Guidelines from Runner
**File**: `src/commands/runner.ts`
**Changes**: 
- `fetchRepoConfig()` already returns the full repo object which now includes `guidelines` (from Phase 1)
- When building `repoContext` for `getBasePrompt()`, include `guidelines` from the repo config
- Update both the normal task path (~line 2916) and the resumed task path (~line 2696) to pass `guidelines`
- For the convention-based fallback (when no repo config exists), set `guidelines: null`

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Unit tests pass: `bun test`
- [ ] DB boundary check: `bash scripts/check-db-boundary.sh`

#### Manual Verification:
- [ ] Start the server, create a repo with guidelines, create a task targeting that repo. Verify the agent's system prompt contains the "Repository Guidelines (MANDATORY)" section with PR checks, merge policy, and review guidance.
- [ ] Create a repo WITHOUT guidelines (null). Verify the warning message appears.
- [ ] Create a repo with all-empty guidelines. Verify no section or warning appears.

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 3: Plugin Commands — Mandatory Pre-Check Steps

### Overview
Update `/create-pr`, `/implement-issue`, and `/review-pr` commands to reference the repo guidelines system.

### Changes Required:

#### 1. Update `/create-pr` Command
**File**: `plugin/commands/create-pr.md`
**Changes**: Rewrite the workflow to include mandatory PR checks and post-PR CI monitoring:

```markdown
## Workflow

1. **Verify state** — confirm you're in a git repo, not on main/master, and have commits to push.
2. **Run PR checks (MANDATORY)** — Run ALL checks listed in the "PR Checks" section of your Repository Guidelines. Run each command/task sequentially. If ANY check fails, fix the issue and re-run until all pass. If no guidelines are defined, check the project's CLAUDE.md for a pre-PR checklist and run those. Do NOT proceed until all checks pass.
3. **Push the branch** — `git push -u origin HEAD`
4. **Gather context** — review commit messages and changed files since diverging from base.
5. **Generate title and description:**
   - **Title**: Concise summary (conventional commit style if the repo uses it)
   - **Description**: Summary of changes, notable items, testing done, related issues
6. **Create the PR/MR** using `gh pr create` or `glab mr create`.
7. **Check CI status** — After creating the PR, wait ~30 seconds, then check CI with `gh pr checks <pr-number>` (GitHub) or `glab mr view --json pipelines` (GitLab). If any check is failing, investigate the failure, fix it, push the fix, and re-check. Repeat until CI is green.
8. **Report** the PR/MR URL and CI status.
```

#### 2. Update `/implement-issue` Command
**File**: `plugin/commands/implement-issue.md`
**Changes**: 
- Rename section "### 4. Commit and Push" to "### 4. Quality Checks, Commit, and Push"
- Add mandatory PR checks before the commit step (referencing Repository Guidelines)
- Add CI monitoring after PR creation in section 5
- Remove the tip "Run linters and tests before creating the PR" (line 59) since it's now mandatory

Updated section 4:
```markdown
### 4. Quality Checks, Commit, and Push

1. **Run PR checks (MANDATORY)** — Run ALL checks from the "PR Checks" section of your Repository Guidelines. Fix any failures before proceeding. If no guidelines are defined, check the project's CLAUDE.md for a pre-PR checklist.
2. **Commit** with a message referencing the issue (e.g., `Fix #123: <description>`). Use conventional commit style if the repo uses it.
3. **Push** with `git push -u origin HEAD`.
```

Updated section 5:
```markdown
### 5. Create the PR

Create the PR with a descriptive title and body including: summary of changes, key changes list, testing done, and `Fixes #<issue-number>` to auto-close the issue on merge.

After creating the PR, check CI status with `gh pr checks` (GitHub) or `glab mr view --json pipelines` (GitLab). If CI fails, fix the issues, push, and re-check until green.
```

#### 3. Update `/review-pr` Command
**File**: `plugin/commands/review-pr.md`
**Changes**: 
- Step 2 (CI check) already exists and is mandatory — keep as-is
- Add a new step referencing the repo's `review` guidelines: after checking CI, before starting the code review, read the "Review Guidance" section from Repository Guidelines for repo-specific review instructions (e.g., "check xxx.md", "enforce camelCase in yyy/")
- Update the merge/approval section to reference the repo's `mergeChecks` and `allowMerge` policy

#### 4. Regenerate Pi-Skills
**Command**: `bun run build:pi-skills`
**Why**: Updated commands must be converted to pi-mono format.

### Success Criteria:

#### Automated Verification:
- [ ] Pi-skills freshness: `bun run build:pi-skills && test -z "$(git diff --name-only plugin/pi-skills/)"`
- [ ] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Read the updated `/create-pr` command and verify the PR checks step is mandatory and references Repository Guidelines
- [ ] Read the updated `/implement-issue` command and verify checks are a mandatory workflow step (not a tip)
- [ ] Read the updated `/review-pr` command and verify it references review guidance and merge policy
- [ ] Read the generated pi-skills and verify the same instructions are present
- [ ] Verify the commands are project-agnostic (reference "Repository Guidelines", not specific tools)

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 4: Lead Template — Quality Gating + Merge Safety

### Overview
Update the lead template to (a) block task routing to repos without defined quality checks, and (b) add merge-safety guardrails so the lead never auto-merges without CI green and human review.

### Changes Required:

#### 1. Lead CLAUDE.md — Guidelines Gating + Delegation Context + Merge Safety
**File**: `templates/official/lead/CLAUDE.md`
**Changes**: Add three new operational rules:

```markdown
9. **Repo guidelines required before routing code tasks** — Before routing ANY implementation, coding, or bug-fix task to a repo, verify the repo has `guidelines` defined (check via `get-repos`). If the repo has no guidelines (null), ask the user to define them before proceeding. Do NOT route code tasks to repos without guidelines. Use `update-repo` to set them. Guidelines include: `prChecks` (commands/tasks before PR), `mergeChecks` (conditions before merge), `allowMerge` (whether auto-merge is allowed, default false), `review` (guidance for reviewers).
10. **Include guidelines context when delegating** — When creating a task for a coder or reviewer, include the repo's guidelines in the task description. For coding tasks, mention the `prChecks`. For review tasks, mention the `review` guidance. This ensures agents know what's expected even before their prompt is assembled.
11. **Never auto-merge without CI green + human review** — Before merging any PR (via `gh pr merge` or `glab mr merge`):
    - Check the repo's `allowMerge` flag — if false (default), do NOT merge. Ask the user.
    - If `allowMerge` is true, verify ALL items in the repo's `mergeChecks` are satisfied
    - Verify ALL CI checks pass: `gh pr checks <number>` — every check must show ✓
    - Verify at least one human (non-agent) has approved the PR
    - If CI is failing, route a fix task to the coder who created the PR
    - If no human review exists, notify the user and wait
```

#### 2. Lead SOUL.md — Guidelines Values
**File**: `templates/official/lead/SOUL.md`
**Changes**: Add to the `## Hard Rules` section:

```markdown
- **No code tasks without guidelines.** Every repo must have guidelines defined before agents push code. Ask the user if missing.
- **CI must be green before merge.** Never merge a PR with failing CI. Route a fix task instead.
- **Human review before merge.** Agent approvals alone are not sufficient. A human must approve.
- **Respect `allowMerge`.** If the repo's guidelines say `allowMerge: false` (the default), do not merge. Period.
```

### Success Criteria:

#### Automated Verification:
- [ ] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Read the updated lead CLAUDE.md and verify guidelines gating, delegation context, and merge safety rules are clear
- [ ] Read the updated lead SOUL.md and verify the guidelines values are present
- [ ] Verify the lead has a clear path: check repo config → missing guidelines? → ask user → store via update-repo → then route task
- [ ] Verify delegation includes guidelines context in task descriptions
- [ ] Verify the merge-safety rules cover: CI check, human review, explicit instruction

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 5: Base CI Instructions for All Agents

### Overview
Add a new `system.agent.code_quality` session template block that gives ALL agents (not just coders) baseline awareness of the repo guidelines system. This ensures that even agents without official templates know about PR checks, merge policy, and review guidance.

**Relationship to Phase 2:** Phase 2 injects the *specific* guidelines for the current repo (the actual commands and rules). This phase adds *generic awareness* of how the guidelines system works, so agents know what to look for even before a specific repo context is loaded. They are complementary: Phase 2 = "here are YOUR repo's checks," Phase 5 = "here's HOW the guidelines system works in general."

### Changes Required:

#### 1. New Session Template Block
**File**: `src/prompts/session-templates.ts`
**Changes**: Register a new template `system.agent.code_quality` with universal instructions:

- Before pushing code: run all PR checks from the Repository Guidelines section
- Before creating a PR/MR: verify all PR checks pass
- After creating a PR/MR: check CI status and fix failures
- Before merging: check the repo's merge policy (`allowMerge`, `mergeChecks`)
- When reviewing: follow the repo's review guidance
- Never use `--no-verify` or bypass git hooks
- Never force-push to main/master

#### 2. Add to Both Composite Templates
**File**: `src/prompts/session-templates.ts`
**Changes**: Add `system.agent.code_quality` to both `system.session.lead` and `system.session.worker` composites, after `system.agent.system`.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Unit tests pass: `bun test`

#### Manual Verification:
- [ ] Verify the template renders correctly by checking a worker agent's assembled prompt includes the code quality block
- [ ] Verify the template is provider-agnostic (no Claude Code-specific references)
- [ ] Verify lead agents also receive the block

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 6: Strengthen Coder Template

### Overview
The coder template already has advisory CI instructions. Strengthen them to explicitly reference the repo guidelines system and make them non-negotiable.

### Changes Required:

#### 1. Coder CLAUDE.md
**File**: `templates/official/coder/CLAUDE.md`
**Changes**: Update the Coding Guidelines to reference the guidelines system:

- "Run ALL PR checks from your Repository Guidelines before pushing — no exceptions"
- "If CI fails after pushing, fix it immediately without being asked"
- "Never use `--no-verify` when committing or pushing"
- Remove the separate "Run linters and type checks before committing" and "Always run the full test suite before pushing" lines (consolidated into the guidelines reference)

### Success Criteria:

#### Automated Verification:
- [ ] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Read the updated coder CLAUDE.md and verify instructions reference Repository Guidelines
- [ ] Verify instructions are project-agnostic (no specific tool names)

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Testing Strategy

### Unit Tests
- Test `rowToSwarmRepo()` correctly parses `guidelines` from JSON string
- Test `createSwarmRepo()` and `updateSwarmRepo()` correctly serialize guidelines
- Test `getBasePrompt()` injects guidelines section when present, warning when null, nothing when all-empty
- Test migration applies cleanly on fresh DB and existing DB

### Integration Tests
- Create a repo via API with guidelines, verify returned in GET
- Update guidelines via PUT, verify persisted
- Verify NULL vs empty-arrays distinction in API responses

### Manual E2E
```bash
# Start the server
bun run start:http

# Create a repo with guidelines
curl -X POST -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{"url":"github.com/test/repo","name":"test-repo","guidelines":{"prChecks":["npm test","npm run lint"],"mergeChecks":["all CI checks pass","at least one human approval"],"allowMerge":false,"review":["check README.md","enforce camelCase"]}}' \
  http://localhost:3013/api/repos

# Verify via API
curl -H "Authorization: Bearer 123123" http://localhost:3013/api/repos | jq '.repos[] | {name, guidelines}'

# Update guidelines
curl -X PUT -H "Authorization: Bearer 123123" -H "Content-Type: application/json" \
  -d '{"guidelines":{"prChecks":["npm test"],"mergeChecks":[],"allowMerge":true,"review":[]}}' \
  http://localhost:3013/api/repos/<id>

# Docker E2E: start worker, assign task to test repo, verify prompt includes Repository Guidelines
```

## References
- Research: `thoughts/taras/research/2026-04-03-ci-hooks-pr-quality.md`
- Related brainstorm: `thoughts/taras/brainstorms/2026-03-28-pr-auto-merge-safety.md`
- Related plan: `thoughts/taras/plans/2026-03-30-github-event-safety-defaults.md`

## Review Errata

_Reviewed: 2026-04-03 by Claude_

### Resolved

- [x] Phase 1 title still said `codeQualityChecks` — fixed to `guidelines`
- [x] Overview paragraph said "code quality checks" — updated to "guidelines"
- [x] Frontmatter `topic` updated to reflect the broader guidelines framing
- [x] Phase 3 overview mentioned delegation changes that belong in Phase 4 — removed
- [x] **No MCP tools for repo management** — Added `get-repos` and `update-repo` MCP tools to Phase 1 (section 5)
- [x] **Migration strategy** — Added migration strategy section to Phase 1 (section 7): soft gate for existing repos, hard gate for new repos
- [x] **`commit-push-pr` bypass** — Documented as known limitation in "What We're NOT Doing" section
- [x] **Phase 2 vs Phase 5 relationship** — Added clarifying paragraph to Phase 5 overview
