---
date: 2026-05-28
author: Codex
topic: "GitHub App Auth Setup"
tags: [plan, github, github-app, vcs, auth]
status: draft
autonomy: critical
last_updated: 2026-05-28
last_updated_by: Codex
---

# GitHub App Auth Setup Implementation Plan

## Overview

Make GitHub App setup a working alternative to `GITHUB_TOKEN` for swarm GitHub operations, while preserving PAT mode and enabling auto-reactions whenever a usable GitHub token is available.

- **Motivation**: Taras wants users who configure GitHub through the App path to get working clone/pull/push/`gh` behavior without also needing a PAT. Taras also wants the existing token path to auto-react when token auth is available.
- **Related**: `src/github/app.ts`, `src/github/reactions.ts`, `src/github/task-reactions.ts`, `src/be/db.ts`, `src/commands/runner.ts`, `docker-entrypoint.sh`, `src/http/repos.ts`, `ui/src/lib/integrations-catalog.ts`, `docs-site/content/docs/(documentation)/guides/github-integration.mdx`
- **Assumption**: Commit per phase is enabled after manual verification passes. The AskUserQuestion tool was unavailable in this Default-mode session, so this follows the planning skill's recommended default.

## Current State Analysis

GitHub webhook/App support exists, but worker git auth still depends on PAT mode.

- GitHub initializes from `GITHUB_WEBHOOK_SECRET`, then optionally loads `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` for App-backed reactions in `src/github/app.ts:42` and `src/github/app.ts:49`.
- The existing App token minting path is `getInstallationToken(installationId)`, with in-memory caching and GitHub's `POST /app/installations/{installationId}/access_tokens` call in `src/github/app.ts:189`.
- Webhook-created tasks persist `vcsInstallationId` from the payload, for example PR task creation stores `installation?.id` in `src/github/handlers.ts:242` and `src/github/handlers.ts:253`.
- Reactions currently require App auth: `src/github/reactions.ts:1` imports `getInstallationToken` and `isReactionsEnabled`, and each reaction path skips if App credentials are absent.
- Task-start auto-reaction exists in two server-side transitions: `startTask()` calls `addEyesReactionOnTaskStart` at `src/be/db.ts:1268`, and `claimTask()` calls it at `src/be/db.ts:2720`.
- `addEyesReactionOnTaskStart()` currently skips all GitHub tasks without `vcsInstallationId` in `src/github/task-reactions.ts:19`, so PAT-only GitHub webhook setups cannot auto-react even if `GITHUB_TOKEN` is present.
- Worker git auth is still PAT-only: `docker-entrypoint.sh:578` checks `GITHUB_TOKEN`, runs `gh auth setup-git` at `docker-entrypoint.sh:583`, and warns that push will fail without it at `docker-entrypoint.sh:594`.
- Repo auto-clone also assumes the worker already has `GITHUB_TOKEN`; it clones through `gh repo clone` in `docker-entrypoint.sh:659`.
- Runtime repo setup in the runner uses `gh repo clone` for GitHub repos at `src/commands/runner.ts:146` and pulls with plain `git pull` at `src/commands/runner.ts:166`.
- Registered repos do not store GitHub installation metadata today. `SwarmRepoSchema` only includes `id`, `url`, `name`, `clonePath`, `defaultBranch`, `autoClone`, `guidelines`, and timestamps in `src/types.ts:884`.
- Repo API create/update bodies mirror that schema and do not accept installation data in `src/http/repos.ts:38` and `src/http/repos.ts:62`.
- Setup surfaces still present PAT as required: the UI catalog marks `GITHUB_TOKEN` required at `ui/src/lib/integrations-catalog.ts:304`, onboarding asks only for a token at `src/commands/onboard/steps/integration-github.tsx:34`, and generated env/compose output emits only PAT variables in `src/commands/onboard/env-generator.ts:33` and `src/commands/onboard/compose-generator.ts:130`.
- Docs already explain App credentials for reactions and separately say workers need `GITHUB_TOKEN` for git operations in `docs-site/content/docs/(documentation)/guides/github-integration.mdx`.
- GitHub documents that installation access tokens can be used for API calls and Git clients, including HTTPS clone using `x-access-token:TOKEN`, but these tokens are short-lived and scoped to the App installation permissions.

## Desired End State

The swarm supports two explicit GitHub auth modes:

- **PAT mode**: `GITHUB_TOKEN` continues to work for worker git/`gh` operations. GitHub reactions use that token when App installation auth is unavailable.
- **App mode**: API holds `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`, workers ask the API for short-lived installation tokens for the current repo/task, and those tokens are used for clone, pull, push, and `gh` API calls without exposing the private key to workers.
- GitHub reactions resolve auth through one common helper: App installation token first when possible, PAT fallback when present.
- Repo records can carry GitHub installation metadata, either learned from webhook tasks or resolved by the API from the repo name.
- Setup UI/onboarding/docs make PAT and App mode mutually understandable instead of claiming `GITHUB_TOKEN` is always required.

## What We're NOT Doing

- We are not building a full GitHub App creation wizard or browser OAuth/install flow in this plan.
- We are not changing GitLab auth behavior.
- We are not storing GitHub App private keys in worker containers.
- We are not replacing every ad hoc `gh` command an agent might type inside a task. The plan covers swarm-managed clone/pull/push setup and a documented token-refresh helper; arbitrary long-running human/agent `gh` usage may still need retry guidance if the token expires mid-session.
- We are not adding GitHub Enterprise host support unless it falls out naturally from existing URL parsing; default target remains `github.com`.

## Implementation Approach

- Centralize GitHub token resolution server-side, with App installation tokens preferred and `GITHUB_TOKEN` as a fallback.
- Make reaction helpers accept optional installation IDs, so PAT-only mode can react when `GITHUB_TOKEN` exists.
- Add repo installation metadata through a forward-only migration and repo API/schema updates.
- Add an authenticated API endpoint that workers can call for a short-lived repo/task token; register returned tokens with `registerVolatileSecret()` before returning them.
- Update worker/runner git setup to use command-scoped tokens and avoid writing installation tokens into persistent repo config.
- Update setup surfaces and docs so App mode is a first-class option, while keeping PAT mode as the simpler setup.

## Quick Verification Reference

Common commands to verify the implementation locally:
- `bun run tsc:check`
- `bun test src/tests/task-reactions.test.ts src/tests/github-handlers.test.ts`
- `bun test src/tests/onboard-env.test.ts src/tests/onboard-compose.test.ts src/tests/swarm-repos.test.ts`
- `bun test src/tests/status.test.ts src/tests/http-api-integration.test.ts`
- `bash scripts/check-api-key-boundary.sh`
- `bash scripts/check-db-boundary.sh`
- `bun run docs:openapi` if a new HTTP route is added

---

## Phase 1: Token-Aware GitHub Reactions

### Overview

Create a shared GitHub auth-token resolver and make reactions work in PAT mode when `GITHUB_TOKEN` is available, while preserving App installation-token behavior.

### Changes Required:

#### 1. GitHub Auth Resolver
**File**: `src/github/app.ts` or new `src/github/auth.ts`
**Changes**: Add helpers such as `getGitHubApiToken(opts?: { installationId?: number })`, `hasGitHubReactionAuth()`, and token-source metadata. The resolver should:
- Prefer `getInstallationToken(installationId)` when App credentials and installation id are present.
- Fall back to `process.env.GITHUB_TOKEN` when present.
- Register runtime-fetched installation tokens with `registerVolatileSecret(token, "GITHUB_INSTALLATION_TOKEN")` before returning them.
- Avoid logging raw token values.

#### 2. Reaction Helpers
**File**: `src/github/reactions.ts`
**Changes**: Replace `isReactionsEnabled()` + mandatory `installationId` with the shared resolver. Update `addReaction`, `addIssueReaction`, `addPullReviewCommentReaction`, `addGraphQLReaction`, and `postComment` to accept `installationId?: number`.

#### 3. Task Start Reaction Gate
**File**: `src/github/task-reactions.ts`
**Changes**: Remove the unconditional `vcsInstallationId` early return. Keep requiring `source === "github"`, `vcsProvider === "github"`, and `vcsRepo`, then pass `task.vcsInstallationId` through to the reaction helper.

#### 4. Handler Acknowledgement Reactions
**File**: `src/github/handlers.ts`
**Changes**: Replace `if (installation?.id) addIssueReaction(...)` style guards with calls that pass `installation?.id`; the helper decides whether App or PAT auth is available.

### Success Criteria:

#### Automated Verification:
- [ ] Reaction unit tests pass: `bun test src/tests/task-reactions.test.ts`
- [ ] GitHub handler tests pass: `bun test src/tests/github-handlers.test.ts`
- [ ] Secret scrubber tests still pass: `bun test src/tests/secret-scrubber.test.ts`
- [ ] Typecheck passes: `bun run tsc:check`

#### Automated QA:
- [ ] Add a focused mock test proving a GitHub task with no `vcsInstallationId` still calls the expected reaction helper when PAT auth is present.
- [ ] Add a focused mock test proving App installation auth remains preferred when both installation id and PAT exist.

#### Manual Verification:
- [ ] With `GITHUB_TOKEN` and `GITHUB_WEBHOOK_SECRET` set but no App private key, trigger or simulate a GitHub mention task and confirm the source issue/comment receives an eyes reaction.

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit after verification passes.

---

## Phase 2: App Installation Metadata and Token Broker

### Overview

Add server-owned repo/task token resolution so workers can request short-lived GitHub App installation tokens without knowing the App private key.

### Changes Required:

#### 1. Repo Installation Metadata
**File**: `src/be/migrations/NNN_github_repo_installation.sql`
**Changes**: Add nullable columns to `swarm_repos`, likely:
- `vcsProvider TEXT`
- `vcsInstallationId INTEGER`
- `vcsFullName TEXT`

Keep this forward-only and do not modify existing migrations.

#### 2. Repo Types and Queries
**Files**: `src/types.ts`, `src/be/db.ts`, `src/http/repos.ts`, `src/tools/repos/*`, `ui/src/api/hooks/use-repos.ts` if needed
**Changes**: Add the new metadata fields to schema, row mapping, create/update APIs, and repo tools. Keep metadata optional so existing repos and GitLab repos continue working.

#### 3. Installation Lookup Helper
**File**: `src/github/app.ts` or new `src/github/installations.ts`
**Changes**: Add `getRepoInstallationId(repoFullName: string)` that:
- Uses an App JWT to call GitHub's repository installation lookup.
- Caches repo to installation id results in process memory.
- Returns `null` cleanly when App credentials are missing or the App is not installed on the repo.

#### 4. VCS Token Broker Route
**File**: new `src/http/vcs.ts`
**Changes**: Add a route-factory endpoint such as `POST /api/vcs/token` with API-key auth. Request body should accept `provider?: "github"`, `repo?: string`, `taskId?: string`, and `purpose?: "api" | "git"`. GitHub is the only provider implemented in this plan, but the route namespace should stay VCS-scoped because the caller is the repo/runner auth layer, not the GitHub webhook handler. Resolution order:
- Task `vcsInstallationId` and `vcsRepo`, when `taskId` is provided.
- Registered repo `vcsInstallationId`, when present.
- GitHub repository installation lookup by repo full name.
- `GITHUB_TOKEN` fallback when App token is unavailable and PAT mode is configured.

Response should include the token, source (`app-installation` or `pat`), repo, optional `installationId`, and expiry if known. Do not log the token.

#### 5. OpenAPI Registration
**Files**: `scripts/generate-openapi.ts`, `src/http/index.ts`
**Changes**: Import and route the new handler, then run `bun run docs:openapi` and commit regenerated `openapi.json` plus API-reference docs.

### Success Criteria:

#### Automated Verification:
- [ ] Repo API tests pass: `bun test src/tests/swarm-repos.test.ts`
- [ ] HTTP/API integration tests for the token route pass: `bun test src/tests/http-api-integration.test.ts`
- [ ] OpenAPI regenerates cleanly: `bun run docs:openapi`
- [ ] Typecheck passes: `bun run tsc:check`
- [ ] Boundary checks pass: `bash scripts/check-api-key-boundary.sh && bash scripts/check-db-boundary.sh`

#### Automated QA:
- [ ] Mock GitHub fetches verify repository installation lookup, token caching, PAT fallback, and missing-auth error responses.
- [ ] Token route test verifies returned token is registered as a volatile secret by checking `scrubSecrets(token)` redacts it.

#### Manual Verification:
- [ ] With App credentials and an installed repo, call the broker endpoint for `owner/repo` and confirm the response source is `app-installation`.
- [ ] With only `GITHUB_TOKEN`, call the same endpoint and confirm the response source is `pat`.

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit after verification passes.

---

## Phase 3: Worker Git and Runner Auth

### Overview

Use the token broker for swarm-managed GitHub clone, pull, push, and `gh` commands so App-mode setup works in workers.

### Changes Required:

#### 1. Worker Token Fetch Helper
**File**: `docker-entrypoint.sh`
**Changes**: Add a shell helper that calls the API token broker with `Authorization: Bearer ${API_KEY}` and `X-Agent-ID: ${AGENT_ID}`. Use it only for GitHub repos and keep the token command-scoped.

#### 2. Entrypoint Auto-Clone
**File**: `docker-entrypoint.sh`
**Changes**: Replace the hard PAT-only branch with:
- PAT path: preserve existing `GITHUB_TOKEN` and `gh auth setup-git` behavior.
- App path: for each repo from `/api/repos?autoClone=true`, fetch a token and clone via `git clone https://x-access-token:${TOKEN}@github.com/owner/repo.git` or command-scoped `GH_TOKEN` where `gh` supports it.
- Avoid echoing commands that include tokens; keep logs token-free.

#### 3. Runner Repo Setup
**File**: `src/commands/runner.ts`
**Changes**: Before `gh repo clone` or `git pull` for GitHub repos, request a token for the task/repo. Use command-scoped env (`GH_TOKEN`/`GITHUB_TOKEN`) for `gh` calls, and for `git pull` use either a temporary credential helper or a one-shot authenticated URL that is not persisted in `.git/config`.

#### 4. Prompt/Operational Guidance
**Files**: `src/prompts/session-templates.ts`, `docs-site/content/docs/(documentation)/guides/github-integration.mdx`
**Changes**: Document that swarm-managed repo setup refreshes App tokens automatically, but arbitrary `gh` commands inside a long-running session may need the helper/refresh path if a token expires.

### Success Criteria:

#### Automated Verification:
- [ ] Runner-focused tests pass: `bun test src/tests/task-working-dir.test.ts src/tests/vcs-tracking.test.ts`
- [ ] Entrypoint tests pass or are added if none cover this behavior: `bun test src/tests/entrypoint-config-env-export.test.ts`
- [ ] Typecheck passes: `bun run tsc:check`
- [ ] Secret scrubbing tests pass: `bun test src/tests/secret-scrubber.test.ts`

#### Automated QA:
- [ ] Add a script-level or mocked runner test showing GitHub repo setup requests a broker token when `GITHUB_TOKEN` is absent.
- [ ] Add an entrypoint-level smoke/mocked test showing auto-clone uses a repo-specific broker token and does not print the token.

#### Manual Verification:
- [ ] Start a worker with App credentials on the API, no `GITHUB_TOKEN` in the worker, and a registered GitHub repo. Confirm auto-clone succeeds.
- [ ] Assign a GitHub-sourced task and confirm the runner starts in the repo clone path and `git pull` works.
- [ ] From inside the worker, create a branch and push using the documented App-token refresh path.

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit after verification passes.

---

## Phase 4: Setup UX, Status, and Docs

### Overview

Make App mode visible and correctly represented across setup UI, onboarding, status, templates, and docs.

### Changes Required:

#### 1. Integration Catalog
**File**: `ui/src/lib/integrations-catalog.ts`
**Changes**: Make GitHub auth mode explicit. `GITHUB_TOKEN` should not be globally required when App credentials are present. Keep `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, and `GITHUB_APP_PRIVATE_KEY` clear for App mode.

#### 2. Status Endpoint
**File**: `src/http/status.ts`
**Changes**: Replace the current App-only milestone check with a status that distinguishes:
- webhook configured
- PAT auth available
- App credentials available
- App token minting verified, if a repo/install probe exists

#### 3. CLI Onboarding and Templates
**Files**: `src/commands/onboard/types.ts`, `src/commands/onboard/steps/integration-github.tsx`, `src/commands/onboard/env-generator.ts`, `src/commands/onboard/compose-generator.ts`, `templates-ui/src/lib/compose-generator.ts`
**Changes**: Add PAT/App mode selection and generate the right env vars. In App mode, pass App credentials to API service only; pass no private key to worker services.

#### 4. Docs and Runbooks
**Files**: `docs-site/content/docs/(documentation)/guides/github-integration.mdx`, possibly `runbooks/local-development.md`
**Changes**: Document both setup modes, required App permissions (`contents`, `issues`, `pull requests`, and workflow-related permissions if workflow operations are expected), token expiry behavior, and a minimal troubleshooting section.

### Success Criteria:

#### Automated Verification:
- [ ] Onboarding env tests pass: `bun test src/tests/onboard-env.test.ts`
- [ ] Onboarding compose tests pass: `bun test src/tests/onboard-compose.test.ts`
- [ ] Status tests pass: `bun test src/tests/status.test.ts`
- [ ] UI typecheck passes if UI files changed: `cd ui && pnpm exec tsc -b`
- [ ] Typecheck passes: `bun run tsc:check`

#### Automated QA:
- [ ] Add tests that generated compose keeps `GITHUB_APP_PRIVATE_KEY` on API service only and never on worker services.
- [ ] Add tests that PAT mode still emits `GITHUB_TOKEN`, `GITHUB_EMAIL`, and `GITHUB_NAME` for workers.

#### Manual Verification:
- [ ] Run `bun run src/cli.tsx help` and `bun run src/cli.tsx onboard` far enough to verify the GitHub step displays both PAT and App mode coherently.
- [ ] Open the integrations UI and verify GitHub no longer presents PAT as the only valid configuration.

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit after verification passes.

---

## Manual E2E

Run these after all phases land, using disposable or low-risk test repositories.

1. PAT-only reaction path:
   - Start API with `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`, `GITHUB_EMAIL`, and `GITHUB_NAME`, but without `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`.
   - Trigger a GitHub mention or assignment event against `/api/github/webhook`.
   - Confirm the task is created and an eyes reaction is posted via PAT auth.

2. App-only repo path:
   - Start API with `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, and `GITHUB_APP_PRIVATE_KEY`; do not set worker `GITHUB_TOKEN`.
   - Install the App on `<owner>/<repo>` with at least contents write, issues write, and pull requests write.
   - Register the repo with auto-clone enabled through `POST /api/repos`.
   - Start a worker and confirm `/workspace/repos/<repo>` is cloned.
   - Trigger a GitHub task, confirm the worker starts in the repo clone, creates a branch, pushes it, and can open or update a PR.

3. Token expiry behavior:
   - Force or simulate an expired cached App token.
   - Repeat `git pull` or a broker request and confirm a fresh installation token is minted without restarting the worker.

4. Secret safety:
   - Inspect API and worker logs after the above runs.
   - Confirm no PAT, installation token, or App private key appears in stdout/stderr, `/workspace/logs/*.jsonl`, or `session_logs`.

---

## Appendix

- **Follow-up plans**:
  - A future GitHub App browser install flow could store installation ids automatically when users install the App through the dashboard.
  - A future helper tool could expose "refresh GitHub token for current repo" to agents for arbitrary `gh` commands inside long sessions.
- **Derail notes**:
  - The current `src/be/db.ts` import of GitHub reaction code means task state transitions can fire external GitHub API calls from DB helpers. This is existing behavior; this plan does not move those side effects, but a future cleanup could relocate it to a service/event boundary.
  - GitHub Enterprise support would need host-aware App credentials and API base URL handling; keep that out unless specifically requested.
- **References**:
  - Existing App token code: `src/github/app.ts:189`
  - Existing reaction code: `src/github/reactions.ts:1`
  - Existing worker PAT setup: `docker-entrypoint.sh:575`
  - Existing runner clone path: `src/commands/runner.ts:133`
  - GitHub docs: https://docs.github.com/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
