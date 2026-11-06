---
date: 2026-11-06
author: Researcher (swarm)
topic: "GitHub Enterprise Server support via a configurable GitHub base URL"
tags: [plan, github, ghes, enterprise, vcs, config]
status: in-progress
autonomy: autopilot
base_commit: cac056330f58a837fa77ab5488dab3fcf0b0c553
last_updated: 2026-11-06
last_updated_by: Researcher
---

# GitHub Enterprise Server (GHES) Base URL Implementation Plan

## Overview

Make the GitHub host configurable so one swarm deployment can target either github.com (default) or a single GitHub Enterprise Server instance. One resolver owns the web, REST and GraphQL bases. Every GitHub call site, parser, worker auth step and UI link reads from it.

- **Motivation**: A prospect on Discord (BrianPhillips) asked for GHES support. The App-auth plan ruled it out (`thoughts/taras/plans/2026-05-28-github-app-auth-setup.md:57`, `:321`). Taras approved it on 2026-11-06 ("pls implement"). We have no GHES instance; the prospect beta tests.
- **Related**: `src/github/app.ts`, `src/github/reactions.ts`, `src/github/handlers.ts`, `src/vcs/index.ts`, `src/commands/runner.ts`, `docker-entrypoint.sh`, `apps/ui/src/lib/swarm-links.ts`, `src/gitlab/auth.ts` (the self-hosted pattern we mirror).
- **Assumptions**: Autopilot mode (swarm task, no interactive questions). Commit per phase. All line numbers are against `main` at `cac0563`.

## Current State Analysis

There is no shared GitHub base URL. Every call site hardcodes `https://api.github.com` or `github.com` and calls raw `fetch`. No Octokit.

- **API server REST/GraphQL**: `src/github/app.ts:205` (installation token), `src/github/reactions.ts:57,160,228` (REST reactions, GraphQL reaction, comment), `src/github/handlers.ts:1059,1083` (review comments), `src/github/handlers.ts:1211` (GraphQL review counts). Each repeats `X-GitHub-Api-Version: 2022-11-28`.
- **App auth**: JWT minting in `generateAppJWT()` (`src/github/app.ts:145-183`) is host-agnostic. The installation id comes only from the webhook payload; there is no repo installation lookup. There is no App manifest or GitHub OAuth login flow in the product. The only GitHub OAuth URLs are the connection preset at `src/oauth/presets.ts:125-127`.
- **Webhooks**: `POST /api/github/webhook` (`src/http/webhooks.ts:184-199`), HMAC check in `verifyWebhookSignature` (`src/github/app.ts:85-139`). Repo identity is `repository.full_name`; web links come from payload `html_url`. Both work unchanged on GHES.
- **Provider detection and parsing**: `detectVcsProvider` (`src/vcs/index.ts:19`) only recognizes `github.com` or `owner/repo` shorthand, so a GHES URL returns `null`. `runner.ts:3184` matches `github` substrings. `extractGitHubPullRequestUrls` (`src/utils/github-pull-request.ts:16-31`) accepts only `github.com`. `githubCitationUrl` (`src/be/task-citations.ts:26-47`) builds and matches only `github.com`. The PR-attachment SQL (`src/be/db-queries/task-artifacts.ts:61-70`) and the savings query (`src/be/db.ts:5624,5636`) GLOB/LIKE on `github.com`.
- **Worker container**: `docker-entrypoint.sh:636-660` runs `gh auth setup-git` with no `--hostname` and relies on `GITHUB_TOKEN`, which `gh` treats as a github.com token. No `GH_HOST` or `GH_ENTERPRISE_TOKEN` anywhere. Auto-clone (`docker-entrypoint.sh:843-846`) sends unknown hosts to `gh repo clone`. The runner (`src/commands/runner.ts:531-538`) sends a GHES URL to plain `git clone` because `detectVcsProvider` returns `null`, and no git credential helper exists for that host.
- **Self-hosted precedent**: GitLab reads `GITLAB_URL` once (`src/gitlab/auth.ts:28`), derives `${url}/api/v4` (`src/gitlab/reactions.ts:18`), and the entrypoint writes a per-host env-reading credential helper (`docker-entrypoint.sh:672-684`), covered by `src/tests/entrypoint-gitlab-credential-helper.test.ts`. We copy this shape.
- **Config surface**: `RESERVED_KEYS` (`src/be/swarm-config-guard.ts:63-75`) already keeps URL knobs that redirect credentials (`CODEX_OAUTH_DEVICE_BASE_URL`, `CLOUDFLARE_API_BASE_URL`) env-only. A GitHub API base receives the PAT, the App JWT and installation tokens, so it belongs there.
- **Scripts runtime**: the default credential binding pins `GITHUB_TOKEN` to `allowedHosts: ["api.github.com"]` (`src/scripts-runtime/credential-broker/default-bindings.ts:12-14`).
- **UI**: `swarm-links.ts:99,147,182,193`, `outcome-preview.ts:24`, `task-attachments-section.tsx:231`, `task-details-rail.tsx:375`, `repos/[id]/page.tsx:233` all hardcode `github.com`. The UI cannot see server env today.
- **Secret scrubbing**: token rules match by prefix (`github_pat_`, `gh[pousr]_`), which GHES shares. No change needed.

## Desired End State

- Two env vars, both optional, deployment-env only:
  - `GITHUB_URL`: web base of the GitHub instance. Default `https://github.com`.
  - `GITHUB_API_URL`: REST base override. Default derived from `GITHUB_URL`.
- With both unset, every request URL, parser result, git config line and UI link is byte-identical to today. A regression test pins this for each touchpoint.
- With `GITHUB_URL=https://ghe.corp.example`, the API server, workers, `gh`, git and the UI all target `ghe.corp.example`, proven by unit tests against a mocked host (a `Bun.serve` on port 0 that emulates `/api/v3/*` and `/api/graphql`).
- One deployment talks to one GitHub host. `vcsRepo` stays `owner/repo`; the host comes from config.

### Derivation rules

Implemented once in `src/utils/github-host.ts`:

| Input | Web base | REST base | GraphQL URL | git/gh host |
|---|---|---|---|---|
| nothing set | `https://github.com` | `https://api.github.com` | `https://api.github.com/graphql` | `github.com` |
| `GITHUB_URL=https://ghe.corp` | `https://ghe.corp` | `https://ghe.corp/api/v3` | `https://ghe.corp/api/graphql` | `ghe.corp` |
| `GITHUB_URL=https://acme.ghe.com` (GHE.com data residency) | `https://acme.ghe.com` | `https://api.acme.ghe.com` | `https://api.acme.ghe.com/graphql` | `acme.ghe.com` |
| `GITHUB_API_URL=X` (any of the above) | unchanged | `X` | `X` with a trailing `/api/v3` replaced by `/api/graphql`, else `X/graphql` | unchanged |
| `GITHUB_URL=https://github.com` (explicit) | treated as unset | | | |

Normalization: trim, strip trailing `/`, lowercase the host, reject a path, query, fragment or credentials in `GITHUB_URL`. Accept `https:`; accept `http:` only with a startup warning (lab installs). An invalid value fails API boot with a clear error and makes the worker entrypoint exit non-zero, rather than silently falling back to github.com and leaking a GHES token to the public host.

## What We're NOT Doing

- Mixed hosts in one deployment (github.com and GHES side by side, or two GHES instances). Context keys (`src/tasks/context-key.ts:20`) and `vcsRepo` stay host-less.
- Storing `GITHUB_URL` / `GITHUB_API_URL` in `swarm_config`. They are reserved keys, set in the deployment env of the API and every worker, like `GITHUB_TOKEN` in compose today.
- A GitHub App manifest or install wizard. We document the manual App creation URL on GHES instead.
- Claude-managed harness on GHES. `normalizeRepoUrl` (`src/providers/claude-managed-adapter.ts:166-171`) feeds Anthropic's managed GitHub resource, which only knows github.com. We refuse with a clear error when GHES is configured.
- Remote skill install from `raw.githubusercontent.com` (`src/http/skills.ts:633,695`, `src/tools/skills/skill-install-remote.ts:61`, `skill-sync-remote.ts:56`). Skill catalogs are public github.com repos; this stays on github.com.
- Links to our own repo, release checks and third-party OSS (`swarm-update-check.ts`, `phone-header-menu.tsx`, `Chart.yaml`, license headers and the rest of category J below).
- Rewriting historic migrations `135_*` and `141_*`.

## Implementation Approach

- Add one pure resolver module (no DB, no imports from `src/be`), read from `process.env` on each call so tests can flip it. Both API and worker code may import it.
- Swap literals for resolver calls site by site. Each site gets a default-unchanged test and a GHES test.
- Worker auth mirrors the GitLab credential-helper pattern and adds `GH_HOST` plus `GH_ENTERPRISE_TOKEN` only when the host is not github.com. The github.com branch of the entrypoint stays byte-identical.
- The UI reads the resolved web base from one existing API payload and passes it into the parsers as a parameter. The UI never hardcodes the GHES host.
- Order: resolver, then server, then parsers, then worker, then UI, then docs. The resolver lands first because everything depends on it. Docs land last so they describe shipped behaviour.

## Quick Verification Reference

- `bun run check:local`
- `bun run test:root -- src/tests/github-host.test.ts`
- `bun run test:root -- src/tests/github-reactions.test.ts src/tests/github-handlers.test.ts src/tests/github-handlers-reactions.test.ts`
- `bun run tsc:check:tsc`
- `bun run lint`
- `bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh`

---

## Phase 1: GitHub host resolver and config surface

### Overview

Deliverable: `src/utils/github-host.ts` with the derivation table above, the two keys reserved as env-only, and a full unit test file.

### Changes Required:

#### 1. Resolver
**File**: `src/utils/github-host.ts` (new)
**Changes**: Export `getGitHubWebUrl()`, `getGitHubApiUrl()`, `getGitHubGraphqlUrl()`, `getGitHubHost()` (bare host for git/gh), `isGitHubEnterprise()`, `isGitHubUrl(url)` (true for the configured host, and `www.github.com` only in default mode), `githubWebLink(path)`, `githubApiUrl(path)`, and `validateGitHubUrlConfig()` that returns `{ ok, error? }`. Read env on every call, no module cache, so tests and config reloads both work.

#### 2. Reserved keys
**File**: `src/be/swarm-config-guard.ts`
**Changes**: Add `GITHUB_URL` and `GITHUB_API_URL` to `RESERVED_KEYS` (`:63-75`), with a comment that they redirect credential traffic.

#### 3. Boot validation
**File**: `src/github/app.ts`
**Changes**: In `initGitHub()` (`:28-68`), call `validateGitHubUrlConfig()`. On error, log and disable the integration, the same way a missing secret does. Log the resolved web and API base once.

### Success Criteria:

#### Automated Verification:
- [ ] Resolver tests pass: `bun run test:root -- src/tests/github-host.test.ts`
- [ ] Reserved-key tests pass: `bun run test:root -- src/tests/swarm-config-reserved-keys.test.ts`
- [ ] Typecheck passes: `bun run tsc:check:tsc`
- [ ] Boundary checks pass: `bash scripts/check-db-boundary.sh && bash scripts/check-api-key-boundary.sh`

#### Automated QA:
- [ ] `src/tests/github-host.test.ts` covers every row of the derivation table, the normalization rules (trailing slash, uppercase host, path rejected, credentials rejected, `http:` warning), and an explicit `https://github.com` equal to unset.
- [ ] A test asserts that `PUT /api/config` rejects a `GITHUB_URL` row, extending `src/tests/swarm-config-reserved-keys.test.ts`.

#### Manual Verification:
- [ ] None. This phase has no human-only checks.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 1] github host resolver`.

---

## Phase 2: API server calls, App auth, webhooks and script bindings

### Overview

Deliverable: every server-side GitHub request goes through the resolver, proven by a mocked GHES server test.

### Changes Required:

#### 1. REST and GraphQL call sites
**Files**: `src/github/app.ts:205`, `src/github/reactions.ts:57,160,228`, `src/github/handlers.ts:1059,1083,1211`
**Changes**: Replace literals with `githubApiUrl("/app/installations/...")`, `githubApiUrl("/repos/...")` and `getGitHubGraphqlUrl()`. Pull the repeated headers into one `githubApiHeaders(token)` helper in the same module. Pagination already follows the `Link` header (`handlers.ts:1001-1044`), which is host-agnostic.

#### 2. Webhook enterprise header
**File**: `src/http/webhooks.ts`
**Changes**: When GHES is configured, read `X-GitHub-Enterprise-Host`. If it is present and differs from `getGitHubHost()`, log a warning that includes both hosts. Do not reject the request: the HMAC check stays the trust boundary.

#### 3. OAuth connection preset
**File**: `src/oauth/presets.ts:125-135`
**Changes**: Derive `authorizeUrl` (`${web}/login/oauth/authorize`), `tokenUrl` (`${web}/login/oauth/access_token`) and `userinfoUrl` (`${api}/user`) from the resolver when the preset is built. Point the help text at `${web}/settings/developers`.

#### 4. Script credential binding and telemetry host map
**Files**: `src/scripts-runtime/credential-broker/default-bindings.ts:12-14`, `src/telemetry.ts:242-243`
**Changes**: Build the default `GITHUB_TOKEN` binding's `allowedHosts` from the resolved API host instead of the literal `api.github.com`. In GHES mode, allow only the GHES API host, so the PAT never goes to the public host. Add the configured web and API hosts to the telemetry provider map.

### Success Criteria:

#### Automated Verification:
- [ ] Existing GitHub tests still pass unchanged: `bun run test:root -- src/tests/github-reactions.test.ts src/tests/github-handlers.test.ts src/tests/github-handlers-reactions.test.ts src/tests/github-handlers-inline-comments.test.ts src/tests/github-webhook-early-ack.test.ts`
- [ ] Preset and broker tests pass: `bun run test:root -- src/tests/oauth-presets.test.ts src/tests/credential-broker.test.ts src/tests/scripts-runtime-secret-egress.test.ts`
- [ ] New mocked-host test passes: `bun run test:root -- src/tests/github-ghes-mock.test.ts`
- [ ] Typecheck passes: `bun run tsc:check:tsc`
- [ ] Floating-promise checks pass: `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`

#### Automated QA:
- [ ] `src/tests/github-ghes-mock.test.ts` starts a `Bun.serve` on port 0 (per `src/tests/test-net.ts`) that records requests. With `GITHUB_URL=http://127.0.0.1:<port>`, it runs `getInstallationToken`, `addIssueReaction`, `addGraphQLReaction`, `postComment` and the review-comment fetch. It asserts every request hit `/api/v3/...` or `/api/graphql` on the mock, and that none went to `api.github.com`. It stubs global `fetch` to fail on any non-loopback host.
- [ ] The same file, with env unset, asserts the request URLs equal today's literals exactly.
- [ ] A broker test asserts that in GHES mode a script request to `api.github.com` gets no `GITHUB_TOKEN` header.

#### Manual Verification:
- [ ] None. GHES itself is verified in the beta checklist.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 2] server github calls via resolver`.

---

## Phase 3: Host-aware URL parsing and provider detection

### Overview

Deliverable: GHES URLs are detected as GitHub and parsed into PRs, citations and attachments everywhere github.com URLs are today.

### Changes Required:

#### 1. Provider detection
**Files**: `src/vcs/index.ts:19`, `src/commands/runner.ts:3184`
**Changes**: `detectVcsProvider` returns `"github"` when `isGitHubUrl(url)` or for `owner/repo` shorthand. Keep GitLab, Azure and Bitbucket checks first. In GHES mode, a host containing `gitlab.` that equals the configured GitHub host wins as GitHub. `runner.ts:3184` uses the same helper instead of the loose `includes("github")`.

#### 2. PR and citation parsers
**Files**: `src/utils/github-pull-request.ts:16-52`, `src/be/task-citations.ts:26-47`
**Changes**: Match `getGitHubHost()` instead of `github.com`, and emit canonical URLs with `getGitHubWebUrl()`. Shorthand `owner/repo#N` resolves to the configured host.

#### 3. SQL host matching
**Files**: `src/be/db-queries/task-artifacts.ts:59-70`, `src/be/db.ts:5624,5636`
**Changes**: Bind the web base as a query parameter (`? || '/*'` for GLOB, `'%' || ? || '/%/pull/%'` for LIKE) instead of the literal. Default mode binds `github.com`, so results stay identical.

#### 4. Claude-managed guard
**File**: `src/providers/claude-managed-adapter.ts:166-171`
**Changes**: When `isGitHubEnterprise()`, throw a clear "claude-managed does not support GitHub Enterprise Server" error before building the resource. Default mode is unchanged.

### Success Criteria:

#### Automated Verification:
- [ ] Provider and VCS tests pass: `bun run test:root -- src/tests/vcs-provider.test.ts src/tests/vcs-provider-isolation.test.ts src/tests/vcs-tracking.test.ts src/tests/runner-bitbucket-vcs.test.ts`
- [ ] Parser and SQL tests pass: `bun run test:root -- src/tests/task-citations.test.ts src/tests/task-artifacts.test.ts src/tests/task-pull-request-backfill-migration.test.ts`
- [ ] Managed adapter tests pass: `bun run test:root -- src/tests/claude-managed-adapter.test.ts`
- [ ] Typecheck passes: `bun run tsc:check:tsc`

#### Automated QA:
- [ ] Each file above gains a GHES case (`GITHUB_URL=https://ghe.test`): `detectVcsProvider("https://ghe.test/o/r") === "github"`, `extractGitHubPullRequestUrls("see https://ghe.test/o/r/pull/7")` yields one PR, `githubCitationUrl("o/r#7")` returns `https://ghe.test/o/r/issues/7`, and the attachment SQL extracts a GHES PR URL from task output.
- [ ] Negative controls in GHES mode: a github.com PR URL is no longer extracted as a PR of this deployment, and in default mode a `ghe.test` URL is not extracted.

#### Manual Verification:
- [ ] None. This phase has no human-only checks.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 3] host-aware github parsing`.

---

## Phase 4: Worker container auth, clone and gh CLI

### Overview

Deliverable: a worker started with `GITHUB_URL` and `GITHUB_TOKEN` can clone, pull, push and run `gh` against the GHES host, proven by entrypoint tests with a stub `gh`.

### Changes Required:

#### 1. Entrypoint GitHub auth block
**File**: `docker-entrypoint.sh:633-661`
**Changes**: Validate `GITHUB_URL` first, using the same rules in shell, and exit non-zero on an invalid value. If the host is not `github.com`:
- export `GH_HOST=<host>` and `GH_ENTERPRISE_TOKEN="$GITHUB_TOKEN"`, because `gh` reads `GH_TOKEN`/`GITHUB_TOKEN` only for github.com and `*.ghe.com`;
- write an env-reading credential helper, `git config --global --replace-all "credential.https://<host>.helper" '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=${GITHUB_TOKEN}"; }; f'`, the same pattern as GitLab at `:683-684`;
- skip `gh auth setup-git`, because the helper replaces it.

The github.com branch stays byte-identical.

#### 2. Runner clone and PR lookup
**File**: `src/commands/runner.ts:531-538,3184-3188`
**Changes**: Use `gh repo clone` once Phase 3 detects the GHES URL as GitHub. `gh pr list` infers the host from the remote. No other change is expected; add a test that pins the command that is chosen.

#### 3. Baked agent commands
**Files**: `plugin/commands/create-pr.md:11` (then `bun run build:pi-skills`)
**Changes**: Change "If `github.com` → use `gh` CLI" to "If the remote is GitHub (github.com or the `$GITHUB_URL` host) → use `gh` CLI".

#### 4. Deployment env plumbing
**Files**: `docker-compose.example.yml` (api, lead and worker env blocks), `charts/agent-swarm/values.yaml:93-98`, `charts/agent-swarm/templates/configmap.yaml:25-33`
**Changes**: Add commented `GITHUB_URL` / `GITHUB_API_URL` to the API and every agent service. Add `config.githubUrl` and `config.githubApiUrl` to the chart values, rendered into the shared configmap so the API and workers always agree.

### Success Criteria:

#### Automated Verification:
- [ ] New entrypoint test passes: `bun run test:root -- src/tests/entrypoint-github-enterprise.test.ts`
- [ ] Existing entrypoint tests pass: `bun run test:root -- src/tests/entrypoint-gitlab-credential-helper.test.ts src/tests/entrypoint-config-env-export.test.ts src/tests/entrypoint-export-to-env.test.ts`
- [ ] Pi skills regenerate with no drift: `bun run build:pi-skills && git diff --exit-code plugin/pi-skills/`
- [ ] Helm renders: `helm template charts/agent-swarm --set config.githubUrl=https://ghe.test | grep -c GITHUB_URL`

#### Automated QA:
- [ ] `src/tests/entrypoint-github-enterprise.test.ts`, modelled on the GitLab helper test, runs the auth block with a temp `HOME` and a stub `gh` on `PATH` that records its argv. In GHES mode it asserts that `GH_HOST` and `GH_ENTERPRISE_TOKEN` are exported, that `git credential fill` for `https://ghe.test` returns `x-access-token` plus the token, that the token is not written to `~/.gitconfig` in plain text, and that `gh auth setup-git` is not called.
- [ ] Default mode in the same test: the stub records `gh auth setup-git` exactly as today and no `credential.https://github.com.helper` is written.
- [ ] An invalid `GITHUB_URL=ftp://x` makes the block exit non-zero.

#### Manual Verification:
- [ ] CI's Docker job builds `worker-slim` (no local Docker in swarm containers).

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 4] worker ghes auth`.

---

## Phase 5: UI links and integration settings

### Overview

Deliverable: dashboard links, chips and repo provider badges point at the GHES host, and the GitHub integration card shows the configured host.

### Changes Required:

#### 1. Expose the resolved web base
**File**: `src/http/status.ts` (or the payload the UI already loads at app start; the implementer confirms which one)
**Changes**: Add `github: { webUrl, apiUrl, enterprise }` to that payload's zod schema, then run `bun run docs:openapi` and commit `openapi.json`. No new route, so the E2E coverage manifest does not change.

#### 2. Link parsers and builders
**Files**: `apps/ui/src/lib/swarm-links.ts:99,147,182,193`, `apps/ui/src/components/sessions-v2/pane/outcome-preview.ts:24`, `apps/ui/src/components/shared/task-attachments-section.tsx:231`, `apps/ui/src/pages/tasks/[id]/task-details-rail.tsx:375`, `apps/ui/src/pages/repos/[id]/page.tsx:233`
**Changes**: Pass the web base in as a parameter (default `https://github.com`) instead of the `GITHUB_HOSTS` set and literals. Feed it from one hook that reads the payload above.

#### 3. Setup surfaces
**Files**: `apps/ui/src/lib/integrations-catalog.ts:481-575`, `apps/ui/src/pages/setup/steps/integrations/git-panes.tsx:16-17`, `apps/ui/src/pages/repos/page.tsx:100`, `apps/ui/src/pages/repos/[id]/page.tsx:100`, `src/commands/onboard/steps/integration-github.tsx:22`
**Changes**: Add read-only `GITHUB_URL` / `GITHUB_API_URL` rows to the GitHub card (marked as deployment env, not editable, because they are reserved). Build the tokens link and repo URL placeholder from the web base.

### Success Criteria:

#### Automated Verification:
- [ ] UI link tests pass: `bun test apps/ui/src/lib/swarm-links.test.ts`
- [ ] UI lint and build pass: `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b`
- [ ] OpenAPI is fresh: `bun run docs:openapi && git diff --exit-code openapi.json`
- [ ] Response coverage passes: `bun run check:openapi-response-coverage`

#### Automated QA:
- [ ] `swarm-links.test.ts` gains GHES cases: a `https://ghe.test/o/r/pull/7` link parses as a PR chip, `o/r#7` gets an href on `ghe.test`, and in default mode `ghe.test` URLs are plain links.
- [ ] Boot the API with `GITHUB_URL=https://ghe.test` (`DESPLEGA_TELEMETRY_ENV=test bun run start:http`) plus the UI, seed a task with a GHES PR URL, and capture screenshots of the task rail and attachment chip with `agent-browser`, per the frontend PR rule.

#### Manual Verification:
- [ ] A reviewer checks the screenshots in the PR's `## Before / after` section.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 5] ui ghes links`.

---

## Phase 6: Docs, env reference and beta checklist

### Overview

Deliverable: operator docs describe GHES setup end to end, and the beta checklist below is published in the GitHub integration guide.

### Changes Required:

#### 1. Docs pages
**Files**: `docs-site/content/docs/(documentation)/integrations/github.mdx`, `docs-site/content/docs/(documentation)/reference/environment-variables.mdx`, `docs-site/content/docs/(documentation)/guides/deployment.mdx`, `DEPLOYMENT.md:756`, `skills/agent-swarm/references/compose.md`, `skills/agent-swarm/references/helm.md`
**Changes**: Add a "GitHub Enterprise Server" section with the derivation table, the two env vars, the App creation URL `https://<host>/settings/apps/new`, the webhook reachability requirement, and the unsupported list (mixed hosts, claude-managed, remote skill install). Run `bun run build:docs-index` if frontmatter changes, and `bun run check:operator-skill` after the skill edits.

#### 2. Supersede the old exclusion
**File**: `thoughts/taras/plans/2026-05-28-github-app-auth-setup.md:57,321`
**Changes**: Add a one-line note pointing at this plan.

### Success Criteria:

#### Automated Verification:
- [ ] Operator skill check passes: `bun run check:operator-skill`
- [ ] Docs index has no drift: `bun run build:docs-index && git diff --exit-code templates/skills/swarm-docs/content.md`
- [ ] Lint passes: `bun run lint`

#### Automated QA:
- [ ] Run the docs-site build and open the GitHub integration page with `agent-browser`. Confirm that the GHES section renders and that its links resolve.

#### Manual Verification:
- [ ] The prospect runs the beta checklist below on their GHES instance and reports each item.

**Implementation Note**: After this phase, pause for manual confirmation. Commit as `[phase 6] ghes docs`.

---

## Beta-tester checklist (prospect)

What they set:
1. On the GHES instance, create a GitHub App at `https://<host>/settings/apps/new` with contents, issues and pull requests read/write, and the webhook URL `https://<swarm-api>/api/github/webhook` plus a secret. Install it on a test repo.
2. Create a PAT (or a bot-user token) on the GHES host with `repo` scope.
3. On the API **and every worker**, set `GITHUB_URL=https://<host>`, plus `GITHUB_TOKEN`, `GITHUB_EMAIL` and `GITHUB_NAME`. On the API only, set `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`. Set `GITHUB_API_URL` only if their API is not at `/api/v3`.

What they verify (report pass/fail with the log line):
- [ ] API boot logs the resolved web and API base for their host.
- [ ] Worker boot logs "GitHub Enterprise auth configured (host: <host>)", and `gh auth status` inside the worker shows the host.
- [ ] A registered repo auto-clones into `/workspace/repos/<name>`.
- [ ] Mentioning the bot in an issue creates a swarm task and adds an eyes reaction.
- [ ] An agent pushes a branch and opens a PR with `gh pr create`; the task links the PR, and the dashboard chip opens the GHES URL.
- [ ] A PR review comment triggers a follow-up task that contains the review comments.
- [ ] `grep -r api.github.com` over the API and worker logs returns nothing.
- [ ] Their GHES version, and whether any request was rejected for the `X-GitHub-Api-Version: 2022-11-28` header.

---

## Appendix

### Grep inventory (main @ cac0563)

Method: two regex passes over the repo tarball, because the session's Bash tool was blocked. Pass 1: `github\.com|githubusercontent\.com|GH_HOST|GH_ENTERPRISE_TOKEN|GITHUB_API_URL|GITHUB_URL|GITHUB_HOST|GITHUB_SERVER_URL|octokit` over 5,589 text files, excluding `thoughts/`, `mockups/`, `talks/`, `assets/`, `vendored-openapi/` and `specs/`. It found 1,397 lines in 358 files. Pass 2: `gh (repo|pr|api|auth|issue)`, `setup-git`, `credential.helper`, `insteadOf`, `x-access-token`, `GH_TOKEN`, `GITHUB_TOKEN|APP_|WEBHOOK`, `GITLAB_URL`, `api/v3|v4` over product code. It found 143 lines. Raw hit lists: agent-fs `thoughts/16990304-76e4-4017-b991-f3e37b34cf73/research/ghes-grep-cac0563.txt` and `ghes-grep2-cac0563.txt`.

Hits by area (pass 1): docs-site 518, `src/tests` 397, `apps/ui` 82, `skills/` 82, `src/be` 44, root files 40, `templates/community` 40, `templates/skills` 20, `.github` 14, `charts` 12, `scripts` 23, `runbooks` 10, `src/github` 10, other `src/*` about 40.

**A. REST API base** (change):
- `src/github/app.ts:205`
- `src/github/reactions.ts:57`, `:228`
- `src/github/handlers.ts:1059`, `:1083`
- `src/oauth/presets.ts:127`

**B. GraphQL** (change):
- `src/github/reactions.ts:160`
- `src/github/handlers.ts:1211`

**C. App auth / OAuth** (change):
- `src/oauth/presets.ts:125-126`, `:135`
- `src/github/app.ts:42-59` (env reads, plus boot validation)
- `DEPLOYMENT.md:756` (docs)

**D. Webhooks** (header check only): `src/http/webhooks.ts:184-199`. There are no host literals.

**E. git clone / credential** (change):
- `docker-entrypoint.sh:636-660`, `:843-846`
- `src/commands/runner.ts:531-538`

**F. gh CLI** (env plus doc):
- `docker-entrypoint.sh:641`
- `src/commands/runner.ts:533`, `:3187`
- `plugin/commands/create-pr.md:11`
- `plugin/pi-skills/create-pr/SKILL.md:11` (generated)
- `src/providers/acp-target-catalog.ts:87-88` and `apps/ui/src/lib/acp-target-catalog.ts:69-70` already pass `GH_HOST` through for Copilot (keep).
- `src/hooks/pr-body-guard.ts:352` is already host-aware (keep and add a test).

**G. URL parsing / repo resolution** (change):
- `src/vcs/index.ts:19`
- `src/commands/runner.ts:3184`
- `src/utils/github-pull-request.ts:16-18`, `:31`, `:52`
- `src/be/task-citations.ts:26-46`
- `src/be/db-queries/task-artifacts.ts:61-70`
- `src/be/db.ts:5624`, `:5636`
- `src/providers/claude-managed-adapter.ts:170` (guard)
- `src/telemetry.ts:242-243`
- `src/scripts-runtime/credential-broker/default-bindings.ts:13`

**H. UI links** (change):
- `apps/ui/src/lib/swarm-links.ts:99`, `:147`, `:182`, `:193`
- `apps/ui/src/components/sessions-v2/pane/outcome-preview.ts:24`
- `apps/ui/src/components/shared/task-attachments-section.tsx:231`
- `apps/ui/src/pages/tasks/[id]/task-details-rail.tsx:375`
- `apps/ui/src/pages/repos/[id]/page.tsx:100`, `:233`
- `apps/ui/src/pages/repos/page.tsx:100`
- `apps/ui/src/pages/setup/steps/integrations/git-panes.tsx:16-17`
- `src/commands/onboard/steps/integration-github.tsx:22`

**I. Seed scripts on api.github.com** (follow-up, see below):
- `src/be/seed-scripts/catalog/gh-pr-snapshot.ts:400`, `:454`
- `src/be/seed-scripts/catalog/github-issues-pull.ts:42`
- `src/be/seed-scripts/catalog/boot-triage.ts:79`
- `src/be/seed-scripts/catalog/boot-triage.inline.ts:79`
- `src/be/seed-scripts/catalog/star-history-refresh.ts:45`
- `templates/skills/tackle-gh-comments/files/scripts/gh-pr-comments.ts:66`
- `templates/skills/qa-loom/content.md:139` (`uploads.github.com`)
- `templates/schedules/gtm-weekly-review/content.md:34-35`

**J. Not in scope (own-repo links, third-party OSS, examples, historic migrations)**:
- Own-repo links and update checks: `src/be/seed-scripts/catalog/swarm-update-check.ts:10,111`, `src/commands/onboard/compose-generator.ts:222,225`, `src/commands/onboard/env-generator.ts:22`, `src/commands/onboard/steps/integration-slack.tsx:10`, `apps/ui/src/components/layout/app-header.tsx:212`, `phone-header-menu.tsx:34`, `dashboard-nudges.tsx:83`, `upgrade-required.tsx:25`, `github-star-nudge-toast.tsx:9`, `chat-sdk-setup.tsx:136,208`, `chat-sdk-fields.ts:41`, `configuration-catalog.ts:1582`, `integrations-catalog.ts:1570`, `apps/templates-ui/src/components/{header,footer}.tsx`, `charts/agent-swarm/Chart.yaml` and README, `.env*.example`, `docker-compose*.yml` comments.
- Remote skill fetch: `src/http/skills.ts:633,695`, `src/tools/skills/skill-install-remote.ts:61`, `skill-sync-remote.ts:56`.
- Connection UI placeholders and catalog: `apps/ui/src/pages/connections/page.tsx:1265-1266,1628,1638,1999,2948,2960`, `catalog-browser.tsx:46`, `public-ranking-row.tsx:219`.
- Historic migrations: `src/be/migrations/135_backfill_task_pull_request_attachments.sql`, `141_scheduled_task_automation_preflight.sql:70,87`.
- Third-party and license links, CI-only and dev scripts: `Dockerfile.worker:89,92,662`, `scripts/gitleaks.sh`, `scripts/seed.ts:917`, `scripts/ci-unit-test-report.ts:193`, `scripts/bump-agent-fs.ts`, `deploy/**`, `tools/oxlint/**`, `src/x402/README.md`, `src/slack/files.ts:146`, `src/pages/browser-sdk.ts:673`, `src/utils/credentials.ts:78`, `src/utils/internal-ai/register-bedrock.ts:22`, and all `templates/community/**` and `templates/skills/**` OSS links.
- Docs: 518 lines, mostly release notes. Only the pages listed in Phase 6 change.

**Tests with host literals** (397 lines; these keep passing in default mode): `task-artifacts.test.ts` 58, `task-pull-request-backfill-migration.test.ts` 43, `prompt-template-github.test.ts` 38, `github-event-filter.test.ts` 16, `github-handlers-reactions.test.ts` 14, `session-costs.test.ts` 12, `swarm-repos.test.ts` 12, `extensions-pre-task.test.ts` 11, `github-reactions.test.ts` 10, `vcs-tracking.test.ts` 10, `fetch-resolved-env.test.ts` 10, `apps-sync-engine.test.ts` 10, plus `apps/ui/src/lib/swarm-links.test.ts` 28.

### Follow-up plans
- Seed scripts and skill helpers on GHES (category I). They run in the scripts runtime, which cannot see reserved env keys. Option: add `github: { webUrl, apiUrl }` to the `SwarmConfigPayload` sent over stdin, then switch the scripts to `ctx.swarm.github.apiUrl`. Not needed for the beta, because these are swarm-ops scripts.
- Mixed github.com plus GHES deployments would need a host on `vcsRepo`, context keys and repo records.

### Derail notes
- `GITLAB_URL` is neither reserved nor validated (`src/be/swarm-config-guard.ts`), so a config writer can point `GITLAB_TOKEN` at any host. Same risk class as the one this plan closes for GitHub.
- `src/github/app.ts:218` and `reactions.ts:243` log GitHub error bodies without `scrubSecrets`.

### Open questions for Taras
- Env-only (reserved) versus a settable `swarm_config` row. This plan picks env-only, because the URL receives the PAT, the JWT and installation tokens. The cost: the prospect edits compose or Helm values, not the dashboard.
- Is GHE.com (data residency) in scope for the beta? The resolver supports it cheaply, but nobody has asked for it.

### References
- Prior plan: `thoughts/taras/plans/2026-05-28-github-app-auth-setup.md`
- GHES REST base `https://<host>/api/v3`, GraphQL `https://<host>/api/graphql`: GitHub Enterprise Server REST and GraphQL docs.
- `gh` env: `GH_HOST` and `GH_ENTERPRISE_TOKEN` (`gh help environment`).
