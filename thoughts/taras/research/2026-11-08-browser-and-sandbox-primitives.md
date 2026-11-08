---
date: 2026-11-08T00:00:00+01:00
researcher: Claude
git_commit: 3d215051d5ce71488012fc0e2fe0123434e8ad1a
branch: t3/sandbox-browser-primitives
repository: agent-swarm
topic: "Browser and sandbox primitives v1: open questions (E2B sandbox, Browser Use browser, shared base)"
tags: [research, primitives, sandboxes, browsers, e2b, browser-use, scripts-runtime, budget]
status: complete
autonomy: critical
last_updated: 2026-11-08
last_updated_by: Claude
---

# Research: Browser and sandbox primitives v1 (open questions)

**Date**: 2026-11-08
**Researcher**: Claude
**Git Commit**: 3d215051d
**Branch**: t3/sandbox-browser-primitives

## Research Question

Answer the Open Questions of `thoughts/taras/brainstorms/2026-11-07-browser-and-sandbox-primitives.md`: Browser Use and E2B provider facts, the E2B signed-link hop, follow-up context, the `ctx.*` surface, non-token cost, E2B client reuse, scoped git tokens, and dashboard iframe CSP.

## Summary

**Providers.** E2B and Browser Use both fit the brainstorm's interface. E2B private sandboxes accept only the `e2b-traffic-access-token` header, with no cookie or query alternative, so a browser viewer needs a swarm hop that injects the header. E2B auto-pause (`lifecycle: { onTimeout: 'pause', autoResume: true }`) works, and an HTTP request to the port host wakes the sandbox in about 0.25 s. Processes survive pause and resume when they outlive their command (shell-detached, or `timeoutMs: 0`). The SDK's default 60 s command timeout kills a plain background command. An open `timeoutMs: 0` command appeared to block auto-pause (see "Live spike results"). The Pro tier caps continuous life at 24 h. Activity does not extend a running sandbox's timeout. The default timeout is 5 min. The default template's node v20.9.0 is too old for current Vite. Browser Use v4 returns `cdpUrl` and `liveUrl` on `POST /browsers`. `agent-browser --cdp <cdpUrl>` drives it as-is. Both URLs die when the session stops. The live view is interactive and sends no frame-blocking headers, but read-only is UI-only. Standalone browsers have no pause or resume, a 4 h maximum and no ended webhook. Profiles save state on both timeout and explicit stop.

**Swarm seams.** Follow-ups inherit only the fields in the `createTaskExtended` parent-inheritance block (`src/be/db.ts:2563-2778`). No generic context field exists, and attachments and tags are not inherited. A new `ctx.*` namespace touches the host `buildCtx`, both executors (native harness plus the QuickJS shape, prelude and `dispatchCall`), the `SCRIPT_SDK_TYPES` template or a type contributor, and `build:script-types`. The connections namespaces show the "dedicated RBAC route behind a namespace" pattern. The MCP `script-run` tool has no timeout parameter, so it runs with the 30 s default. Budget admission sums `session_costs.totalCostUsd` per day for global, agent and user scopes. It has no task-tree scope, and swarm-owned compute has no cost line. The only time-based fee is `claude-managed` `runtime_hour`.

**Reuse and security plumbing.** `src/e2b/dispatch.ts` already holds a DB-free E2B client (raw HTTP plus a lazy SDK). The runtime-provider shape (traits, lazy switch factory, controller wrapper, encrypted `secret_config`) and the runtime supervisor (interval loop, idle drain, orphan sweep) are the closest patterns. No shared contract test suite exists. Git credentials are static `GITHUB_TOKEN` / `GITLAB_TOKEN` values. The GitHub App mints installation tokens with no repo or permission narrowing, and only for server-side use. The dashboard CSP has no `frame-src`, so third-party live views can be framed today. The API already has HMAC page-session cookies, one-shot realtime tickets, a streaming HTTP proxy (agent-fs) and `ws` upgrade handling. It has no WebSocket forwarding to an upstream.

## Detailed Findings

### 1. E2B provider facts (web)

Sources: E2B docs (`https://docs.e2b.dev/...`, fetched as `.md`) and the JS SDK source (`https://raw.githubusercontent.com/e2b-dev/E2B/main/packages/js-sdk/src/`, abbreviated "SDK/"). Items marked "(summary)" come from search summaries only and are not verbatim.

**Private traffic and the token** (`/network/restrict-public-access.md`)
- Option: `Sandbox.create({ network: { allowPublicTraffic: false } })`. SDK property: `readonly trafficAccessToken?: string`.
- Quote: "Requests without the `e2b-traffic-access-token` header get `403`."
- New projects default to private since 2026-10-30. "Explicit per-sandbox options override it." The page recommends `e2b` 2.60.0 or later.
- No cookie or query-parameter alternative is documented. A browser cannot send the header on a plain navigation or WebSocket, so a hop must inject it.
- Not confirmed: whether `trafficAccessToken` is populated after `Sandbox.connect()`.

**Port host and websockets**
- `getHost(port)` returns a host without a scheme. Docs: "The first leftmost part of the host is the port number we passed to the method." Pattern `<port>-<sandboxId>.e2b.app` (seen as `wss://8081-%h.e2b.app` in `/sandbox/ssh-access.md`).
- SDK doc comment: "You can then use this address to connect to the sandbox port from outside the sandbox via HTTP or WebSocket."
- Vite HMR is not mentioned anywhere. The `maskRequestHost` option rewrites the Host header sent to the in-sandbox service.
- `/faq/sandbox-lifetime.md`: "no single connection is guaranteed for more than one hour."

**Lifecycle, pause, resume** (`/sandbox/auto-resume.md`, `/sandbox/persistence.md`)
- Shape: `Sandbox.create({ timeoutMs, lifecycle: { onTimeout: 'pause', autoResume: true } })`. `onTimeout` default is `'kill'`. The object form `{ action: "pause", mode: "filesystem" }` cannot combine with auto-resume.
- Resume trigger: "Auto-resume is triggered by sandbox activity", covering "both HTTP traffic and SDK operations". Also: "When an HTTP request arrives at a paused sandbox, the sandbox wakes up automatically to handle it."
- After auto-resume: "it restarts with a 5-minute minimum timeout." "the lifecycle configuration is persistent across pause/resume cycles."
- Persistence (full snapshot): "all the files in the sandbox's filesystem and all the running processes, loaded variables, data, etc." With `mode: 'filesystem'`, resume "cold-boots (reboots) it from disk, losing running processes and open connections."
- Activity does not extend a running sandbox: "Running commands, reading or writing files, and requests to the sandbox's URL do not reset the timeout of a running sandbox."
- `setTimeout(ms)`: "the sandbox timeout will be reset to the new value that you specified."
- `Sandbox.connect(id, { timeoutMs })`: "the new expiry is the later of the current expiry and now plus the timeout you pass (default 5 minutes)." SDK: "If the sandbox is paused, it will be automatically resumed."
- `/sandbox.md`: "pausing resets the runtime window".
- Pause takes about 4 s per GiB of RAM (summary). Paused sandboxes are kept indefinitely (summary).

**Lifetime limits**
- "Maximum time a sandbox can be kept alive is 24 hours (86_400_000 milliseconds) for Pro users and 1 hour (3_600_000 milliseconds) for Hobby users."
- Not confirmed: the default `timeoutMs` on create.

**Git** (SDK/sandbox/git/index.ts, `/migration/git-deprecation.md`)
- `sandbox.git.clone(url, { username, password, branch, depth, path, dangerouslyStoreCredentials })` exists but is deprecated: "Run git with sandbox.commands.run() instead. The git module will be removed in the next major version."
- "Git is installed in the sandbox, so every `sandbox.git` call has a direct equivalent as a shell command." (The `base` template is the default for `Sandbox.create()`, so `base` has git by inference.)
- Documented replacement: `commands.run('git clone https://x-access-token:$GITHUB_TOKEN@github.com/... /home/user/repo', { envs: { GITHUB_TOKEN } })`.

**Commands** (SDK/sandbox/commands/index.ts, `/commands/background.md`)
- `run(cmd, { background: true, onStdout, onStderr, timeoutMs })` returns a `CommandHandle` (`pid`, `wait()`, `kill()`, `disconnect()`).
- `list()`: "List all running commands and PTY sessions." `kill(pid)` (SIGKILL).
- Reattach: "A background command keeps running inside the sandbox even after the SDK disconnects, as long as its command timeout has not expired." Example: `Sandbox.connect(id)` then `sandbox.commands.connect(pid, { timeoutMs: 0 })`.

**Files**
- `writeFiles(files: WriteEntry[])`, each entry `path` and `data`, creates directories. `/filesystem/upload.md`: "pass a stream ... Chunks are uploaded as they arrive, so the size of the data doesn't matter." `sandbox.uploadUrl(...)` exists. No archive upload API found.

**Pricing, list, webhooks** (summary)
- $0.000014 per vCPU-second (about $0.05 per vCPU-hour), $0.0000045 per GiB-second (about $0.016 per GiB-hour). Paused and killed sandboxes are not billed. (`/faq/calculate-sandbox-price`)
- `Sandbox.list()` filters by state and metadata pairs, 100 per page, `nextToken`. (`/sandbox/list`)
- Lifecycle webhooks: created, updated, killed, paused, resumed, checkpointed, signed with `e2b-signature`, killed events carry `kill_reason`. (`https://e2b.dev/docs/sandbox/lifecycle-events-webhooks`)

**Bun building blocks for the swarm hop** (`https://bun.com/docs/runtime/networking/fetch.md`, `https://bun.com/docs/runtime/http/websockets.md`)
- Response streaming: "You can use async iterators to stream the response body." Request streaming: "Bun streams the data directly to the network without buffering the entire body in memory".
- Server side: `server.upgrade(req, { headers, data })` inside `fetch`, plus `websocket` handlers.
- Client side: "the second argument can also be an options object. This is a Bun-specific extension of the `WebSocket` standard." It accepts `headers`, so the API can open the upstream socket with `e2b-traffic-access-token`.
- No documented Bun recipe for a websocket reverse proxy. It is composed from the two pieces above. The docs warn to check `Origin` before upgrade.

### 2. Browser Use provider facts (web)

Sources: Browser Use docs, fetched as `.md` (index `https://docs.browser-use.com/llms.txt`; `https://docs.browser-use.com/cloud/llms.txt` returns 404). Quotes are verbatim. Fallback-provider notes come from search summaries only.

**Browser sessions API v4** (`/cloud/api-v4/browsers/create-browser-session.md`, `get-browser-session.md`, `update-browser-session.md`, `list-browser-sessions.md`)
- Server `https://api.browser-use.com/api/v4`. "Cloud authentication uses X-Browser-Use-API-Key, without a Bearer prefix."
- Create: `POST /browsers` (201). Body fields: `profileId` (top level), `networkPolicyId`, `proxyCountryCode` (default `us`, null disables), `metadata` (up to 10 string pairs), `timeout` (minutes, 1 to 240, default 60: "All users can use up to 240 minutes (4 hours)."), `browserScreenWidth` / `Height`, `allowResizing`, `pdfRendererEnabled`, `solveCaptchas` (default true), `customProxy`, `enableRecording`, `extensionIds` (up to 3). No `keepAlive` on standalone browsers.
- Errors: 402 (credits or spend limit), 403 ("Session timeout limit exceeded (maximum 4 hours)"), 404 (profile or extension), 422, 429 ("Too many concurrent active sessions").
- Response: `id`, `status` (`active` | `stopped`), `liveUrl`, `cdpUrl`, `timeoutAt`, `startedAt`, `finishedAt`, `proxyUsedMb`, `proxyCost`, `browserCost`, `agentSessionId`, `recordingUrl`, `metadata`, `extensions`. `GET /browsers/{id}` adds `recordingAvailable`.
- Stop: `PATCH /browsers/{id}` with `{"action":"stop"}` ("Stop the browser session (cannot be undone)"). No DELETE for browser sessions. List: `GET /browsers` with a `metadata` filter, `pageSize` max 100.
- No suspend or resume for standalone browsers. Continuity is a new session with the same profile.

**Live view** (`/cloud/browser/live-preview.md`; the iframe-embed page has identical content)
- Interactive by default: "Treat the URL as a credential: anyone with it can interact with the active browser." "To allow human takeover, remove `inert`, `tabindex="-1"`, and `pointer-events: none`..."
- Framing: "The URL is hosted on `live.browser-use.com`. Add that origin to your Content Security Policy's `frame-src` directive when needed."
- Read-only options are UI-only: the viewer supports `readOnly=true`, "a viewer URL option, not a field in the browser or run creation request". "View-only embeds are a UI restriction, not a server-enforced permission. Anyone who opens the live URL directly or uses the underlying CDP URL can still control the browser. Keep both URLs private."
- Not stated: whether `liveUrl` carries a token or expires.

**Profiles** (`/cloud/api-v4/profiles/*.md`, `/cloud/guides/authentication.md`)
- `POST /profiles` (`name`, `userId`), `GET /profiles`, `GET /profiles/{id}`, `PATCH /profiles/{id}`, `DELETE /profiles/{id}`. View fields `id, userId, name, lastUsedAt, createdAt, updatedAt, cookieDomains`.
- "A profile persists cookies, local storage, and login state across browsers." Save point (image alt text): "Browser 1 logs in, and its state is saved to the profile when it stops."
- Limit: 402 "Profile limit reached; delete unused profiles to create new ones" (count not stated). Guidance: "Use one profile per end user."
- Not found: whether a timeout-triggered stop saves the profile.

**CDP URL** (`/cloud/browser/quickstart.md`, `/cloud/browser/playwright-puppeteer-selenium.md`)
- "Its **CDP URL** is a WebSocket endpoint for remotely controlling Chrome." Documented clients connect with no extra headers: `chromium.connectOverCDP(session.cdpUrl)`, `puppeteer.connect({ browserWSEndpoint: session.cdpUrl })`.
- "Disconnecting CDP, Playwright's `browser.close()`, or `client.close()` does not stop the managed browser."
- "Use its existing browser context so profile cookies and managed settings apply."
- Not stated: URL format, embedded token, validity beyond the active session. `agent-browser --cdp` against it is not documented (not tested).

**Billing, idle, webhooks**
- `https://browser-use.com/pricing.md` (verified 2026-11-05): "Cloud browser session | $0.02/browser-hour". Concurrency "10 / 50 / 250 / 500 / 1000 at $0 / $100 / $1000 / $5000 / $25000" total paid. "No subscription. No concurrency fees."
- "The full rate is charged upfront when the session starts." "When you stop the session, any unused time is automatically refunded proportionally." "Billing is rounded up to the minute (minimum 1 minute)."
- `/cloud/guides/concurrency.md`: "A standalone browser holds a slot until it stops. ... explicitly stop that browser rather than relying on idle cleanup." No idle timeout is named for standalone browsers.
- `/cloud/guides/webhooks.md`: events are `agent.task.status_update` (V2), `session.status.update` (V3), `test`. No v4 browser-session event. Run events `browser.ready` / `browser.released` exist for agent runs only. Standalone sessions need polling of `GET /browsers/{id}`.

**Fallback providers (summary)**
- Browserbase: interactive live view through `debuggerFullscreenUrl` in an iframe. The iframe posts `browserbase-disconnected` to the parent when the session ends. (`https://docs.browserbase.com/platform/browser/observability/session-live-view`)
- Hyperbrowser: interactive by default, server-side `viewOnlyLiveView: true`, live URL token "will expire after 12 hours", GET on the session returns a refreshed URL. (`https://hyperbrowser.ai/docs/sessions/live-view`)

### 3. Follow-up tasks and context

**Short answer:** there is no generic context or metadata field on a task. A follow-up carries exactly the fields that `createTaskExtended` copies from `parentTaskId` (`src/be/db.ts:2563-2778`). `task_attachments` rows, `tags`, `providerMeta` and `harnessVariantMeta` are not inherited.

**Inheritance block** (`createTaskExtended`, `src/be/db.ts:2504`; it runs `CreateTaskOptionsSchema.parse(options)` first, `db.ts:2515`; schema at `src/types.ts:993`)
- Copied from the parent: Slack channel, thread, user and participants (`:2582-2597`), agentmail ids (`:2599-2608`), mention ids (`:2610-2616`), the VCS identity as one unit (`:2629-2660`), `dir` (`:2683`), `outputSchema` unless opted out (`:2693`), `requestedByUserId` (`:2702`), `key` (`:2710`), `contextKey` (`:2714`), `followUpConfig` only with `inheritParentFollowUpConfig` (`:2721`), `routingAffinity` (`:2733`).
- Not copied: `model` (`:2664-2682`), `slackTriggerMessageTs` (`types.ts:1010`).
- Slack backfill from `sourceTaskId` and from a Slack `contextKey`, then a mismatch guard (`:2783-2855`).
- No stored root column. A session root is a task with `parentTaskId IS NULL` (`migrations/230_session_shares.sql:1`). `session_members(taskId, rootId)` (`migrations/259_session_summaries_open_tasks.sql:63-65`). `getRootTaskChain` (`db.ts:13152`). `parentTaskId` has no FK (`src/be/db/tasks/write.ts:1244`).

**Follow-up creators** (`src/tasks/worker-follow-up.ts`)
- `createWorkerTaskFollowUp` (`:377`): Lead follow-up when a worker task ends. Skipped for workflow tasks (`:392`), disabled `followUpConfig` (`:393`), Lead assignee (`:396`), live chained child (`:415`), a `pre.task.followUp` block (`:524`). Sets `source: "system"`, `taskType: "follow-up"`, `parentTaskId: task.id`, Slack fields, `contextKey: await deferredWorkChatContextKey(task)` (`:555-575`). The description includes an attachments block from `getTaskAttachments` (`:459`, `formatAttachmentsBlock` `:315`). Called from `src/tasks/task-terminal-effects.ts:160`.
- `createResumeFollowUp` (`:712`): `taskType: "resume"`, tags `auto-resume`, `reason:<reason>`, `resume-generation:N` (`:810-825`), relies on the inheritance block for the rest (`:827-834`).
- `createRerouteDecisionTask` (`:961`), `createPoolStarvationDecisionTask` (`:1054`): Lead decision tasks.

**Slack thread replies** (`src/slack/handlers.ts`)
- Thread lookup on `agent_tasks.slackChannelId` + `slackThreadTs`: `getMostRecentTaskInThread` (`src/be/db/tasks/read.ts:2087`), `getAgentWorkingOnThread` (`read.ts:1869`). `contextKey` = `task:slack:<channel>:<threadTs>` (`src/tasks/context-key.ts:125`).
- Lead target (`handlers.ts:841-896`): a text-only reply to a thread with a running task steers it via `requestSlackThreadSteering` (no new task, `:846-864`). Otherwise `createSlackTaskWithFiles` with `parentTaskId: latestTask?.id` and `inheritParentOutputSchema: false`, `inheritParentRequester: false`.
- Worker target (`:899-916`): same Slack fields, no `parentTaskId`.

**GitHub PR comments and reviews** (`src/github/handlers.ts`)
- `handleComment` (`:869`) needs an `@agent-swarm` mention. It looks up `findTaskByVcs(repo, number, "github")` (`:916`, `read.ts:820`) and only names it in the description ("Related task: ..."). The new task is a root task (`taskType: "github-comment"`, vcs fields, `contextKey: buildGithubContextKey(...)`, `:948-971`).
- Review submitted (`:1370-1452`): `taskType: "github-review"`, no `parentTaskId`.
- PR link columns on `agent_tasks`: `vcsProvider, vcsRepo, vcsEventType, vcsNumber, vcsCommentId, vcsAuthor, vcsUrl, vcsInstallationId, vcsNodeId` (migrations 006, 033). PR URLs found in text are stored as `task_attachments` `kind='url'` with `providerId: "github"`, `intent: "task-deliverable"` (`recordTaskPullRequestAttachments`, `db.ts:1292`).

**Dashboard**
- `POST /api/tasks` (`src/http/tasks.ts:329`): body accepts `parentTaskId`, `contextKey`, `key`, `source`, `outputSchema`, `agentId`, `routingReason`, `requestedByUserId`, `draft` (`:337-386`). No free-form context field. Parent attach is checked by `denyParentAttach` (`:1111-1120`).
- UI composer (`apps/ui/src/components/shared/task-composer.tsx:310-320, 401-408`) sends `parentTaskId: targetTask?.id ?? rootTaskId`, `routingReason: "continuity"`, `source: "ui"`. Files make a draft, upload, then `promoteDraft`.

**Task attachments** (`src/be/migrations/072_task_attachments.sql:16-36`)
- Columns `id, task_id (FK cascade), agent_id, name, kind, url, path, page_id, mime_type, size_bytes, sha256, intent, description, is_primary, created_at`, later also `providerId`, `capabilities`. CHECK `kind IN ('agent-fs','url','shared-fs','page')`. One task per row, not inherited.

**`request-human-input`** (`src/tools/request-human-input.ts`)
- Input `title`, `questions` (`approval | text | single-select | multi-select | boolean | config`, markdown `description`), `timeoutSeconds`, `detached` (`:12-46`).
- Creates an approval request with `sourceTaskId` (current task unless detached, `:98-124`) and returns `url = ${getAppUrl()}/approval-requests/${request.id}` (`:126-130`). Tool description: "No Slack message is sent; share the URL yourself" (`:54-60`).
- The answer arrives as a new task: `createApprovalFollowUpTask` (`src/workflows/approval-notifications.ts:468`, called from `src/http/approval-requests.ts:761`) creates `taskType: "hitl-follow-up"`, `parentTaskId: request.sourceTaskId`, `routingReason: "continuity"`, same agent, Slack fields from the source task (`:502-516`). The text lists `- <label>: <answer>` lines. `detached: true` creates no follow-up.

**Origin channel on post-back**
- No single helper. Slack: `sendTaskResponse` (`src/slack/responses.ts:120`) posts to `task.slackChannelId` + `task.slackThreadTs`, so inherited Slack fields route a follow-up's result into the original thread. Agent-side `src/tools/slack-reply.ts`. GitHub: only an eyes reaction (`src/github/task-reactions.ts`); `postComment` exists at `src/github/reactions.ts:210` (callers not traced).
- `contextKey` is the cross-ingress identifier (`types.ts:920`, families in `src/tasks/context-key.ts`).

**PR comment post-back (follow-up trace)**
- `postComment(repo, issueNumber, body, installationId)` (`src/github/reactions.ts:210-237`) POSTs to `/repos/${repo}/issues/${issueNumber}/comments` as the App bot. It has no non-test callers in `src/` (re-export `src/github/index.ts:29`, tests `src/tests/github-ghes-mock.test.ts`).
- The same holds for `postGitLabComment` (`src/gitlab/reactions.ts:84-104`), `postBitbucketPullRequestComment` (`src/bitbucket/api.ts:57-79`) and `postAzureDevOpsPullRequestComment` (`src/azure-devops/api.ts:180-202`).
- No MCP tool in `src/tools/` posts to a PR. No code path posts a task result as a PR or MR comment. Agents post with `gh` / `glab` on the worker.
- Lifecycle post-back exists for trackers only: Jira posts task output as an issue comment (`src/jira/outbound.ts:96-129`), Linear calls `client.createComment` (`src/linear/outbound.ts:161, 211, 257`), Azure DevOps moves work item state (`src/azure-devops/outbound.ts:63-69`). GitHub only adds an eyes reaction (`src/github/task-reactions.ts:31-110`).

**contextKey families** (`src/tasks/context-key.ts`)
- `ContextKeyFamily` (`:51-57`): slack, agentmail, chat-sdk, trackers, schedule, workflow. `ParsedContextKey` union (`:67-107`).
- Formats: `task:slack:{channel}:{threadTs}` (`:125`), `task:agentmail:{threadId}` (`:167`), `task:chat-sdk:{adapter}:{encoded}` (`:138`), `task:trackers:github:{owner}:{repo}:{issue|pr}:{n}` (`:172`), gitlab, azure-devops (pr and workitem), bitbucket, linear, jira (`:195-287`), `task:schedule:{id}` (`:289`), `task:workflow:{id}` (`:294`).
- KV-only prefixes with a builder and no parser case: `task:agent:{agentId}` (`:305`), `task:page:{pageId}` (`:315`), `task:app:{appId}:{sessionKey}:user:{userId}` (`:329`). `parseContextKey` throws on these (`default`, `:512-513`).
- Adding a family: no registry. Add to `ContextKeyFamily` and `ParsedContextKey`, add a builder, add a `case` in `parseContextKey` (`:355`). `assertSafePart` (`:109-123`) rejects empty or `:`-containing parts.
- Consumers: lookups in `src/be/db/tasks/read.ts` (`getLatestTaskByContextKey` `:1827`, `getInProgressTasksByContextKey` `:1724`, `getAgentWorkingOnContextKey` `:1954`, `getLatestActiveTaskByContextKey` `:2021`, `getLatestLeadTaskByContextKey` `:2047`), Slack backfill (`src/tasks/slack-routing.ts:47-58`), chat-sdk routing, KV namespaces (`src/http/kv.ts:306-330`, `src/realtime/auth.ts:49-81`). Column `agent_tasks.contextKey`, indexes `(contextKey)` and `(contextKey, status)` (`migrations/042_task_context_key.sql`).

### 4. Adding a `ctx.*` script surface

**Today's `ctx`** (`src/scripts-runtime/ctx.ts:20-59`): `swarm` (Proxy over MCP tools plus `config`, `room`), `api` (connections), `mcp` (connections), `fs`, `sh`, `stdlib`, `logger`. `buildCtx({ swarmConfig, apiConnections, mcpConnections, agentFs, signal })` builds the host-side object for both executors.

**Native executor**
- `src/scripts-runtime/eval-harness.ts:100-117` reads `SwarmConfigPayload` from stdin, calls `patchFetchWithEgressSubstitution(...)`, then `buildCtx(...)`. The script runs as `mod.default(validatedArgs, ctx)` (`:168`). Payload write: `executors/native.ts:301`. Sandboxed launch: `native.ts:191-203`.

**QuickJS executor (host side and prelude mirror)**
- Host: `executors/quickjs-runner.ts:532-548` builds the same `hostCtx` and a `shape` descriptor (`api`, `mcp`, `fs` method names). The sandbox gets one global, `__host_call(path, argsJson)` (`:610-621`), capped at `MAX_CONCURRENT_HOST_CALLS = 16` (`:56`).
- `dispatchCall` (`:225-289`) routes dotted paths, own members only. Branches exist for `swarm.room`, `swarm.<tool>`, `api|mcp.<slug>.<method>`, `fs.<method>`, `sh`. Unknown paths throw `unknown quickjs host call: ${path}`.
- Prelude: `executors/quickjs-prelude.ts:420-448` rebuilds `ctx` from `method(path)` wrappers. Header (`:16-17`): `__swarm_shape` exists so "`ctx` matches the native executor exactly".
- Swarm-API-backed host calls run inside `swarmHostCalls.run(true, ...)` (`:262, 270, 280`). `egressFetch` trusts the swarm origin only in that scope (`quickjs-worker.ts:45-55`). `HOST_ONLY_REDACTED` blocks unwrapping `system:apiKey` and `system:runtimeInstanceId` (`quickjs-runner.ts:50, 307-309`).

**HTTP from a namespace**
- Payload (`executors/types.ts:16-38`): `system.apiKey` (secret), `system.agentId`, `system.mcpBaseUrl`, `user`, `egressSecrets`, `failedBindings`, `apiConnections`, `mcpConnections`, `agentFs`. Built in `loader.ts:97-120` (`apiKey = input.apiKey ?? getApiKey()`). `SwarmConfig` wraps values in `Redacted` (`swarm-config.ts:4-46`).
- Helpers: `swarm-sdk.ts:15-30` `headers(config)`; `mcp-client.ts:52-73` `postSwarmJson(config, path, body, label)` (throws unless `{ ok: true }`).
- Dedicated-route pattern: `ctx.api.<slug>.query` and `ctx.mcp.<slug>.<tool>` call `POST /api/script-connections/{id}/sql-query` and `/mcp-call` (`src/http/script-connection-proxy.ts:35-85`), with `auth: { apiKey: true, agentId: true }`, `rbac: { permission: "script-connection.invoke" }`, and a `can(...)` check (`:130-135`). The descriptor carries only `connectionId`; "The DSN never reaches the sandbox" (`api-types.ts:52-57`).
- `ctx.swarm.<method>`: `createSwarmSdk` Proxy (`swarm-sdk.ts:741-768`) calls `callTool` (`:698-732`), rejected unless `isSdkToolAllowed`. `bridgeRequestFor` (`:62-476`) maps some methods to REST routes, the rest fall through to `POST /api/mcp-bridge` (`:636-646`). Results go through `scrubObject`. Reads and `Idempotency-Key` writes retry on 5xx (`:478-624`).

**Types**
- Contributor contract (`src/be/scripts/type-contributors.ts:6-24`): `(context: { agentId?, repoId? }) => string | Promise<string>`. "never a compiler-host or files-Map change". Existing: `getScriptApiTypes` (`src/be/script-connections.ts:2186`), `getScriptMcpTypes` (`:2200`), `getScriptAppTypes` (`src/apps/script-types.ts:296`).
- Static types: `SCRIPT_SDK_TYPES` template in `src/be/scripts/typecheck.ts:32-676`, incl. `SwarmSdk` (`:191`, hand-written signatures), `ScriptFs` (`:606-643`), `ScriptContext` (`:645-661`). Assembly: `scriptSdkTypesWithGeneratedApis` (`:678-686`), `scriptStdlibTypesWithGeneratedApis` (`:754-762`), `typecheckScript` (`:1329-1350`), HTTP callers `src/http/scripts.ts:1006-1072`.
- Generation: `bun run build:script-types` (`scripts/bundle-script-types.ts:17-48`) writes `src/scripts-runtime/types/swarm-sdk.d.ts` and `stdlib.d.ts`. CI freshness check `scripts/check-script-types-freshness.sh`.

**Tool registration rule**: `SDK_TOOL_NAME_MAP` (`src/scripts-runtime/sdk-allowlist.ts:1-205`), `REST_ONLY_SDK_METHODS` (`:219`). `scripts/check-sdk-tool-registration.ts` fails on any tool missing from the map and from `EXCLUDED_TOOLS`, and on stale exclusions. Runs in `.github/workflows/ci.yml:211` and `merge-gate.yml:439`.

**Wall clock** (`executors/types.ts`): `DEFAULT_SCRIPT_RESOURCES.wallClockMs = 30_000`, `MAX_SCRIPT_WALL_CLOCK_MS = 300_000`, `SCRIPT_LONG_TIMEOUT_HINT_MS = 120_000`, `cpuTimeSec: 60`. Merge in `loader.ts:169-173` (no clamp there). Who can ask for more:
- MCP `script-run` / `ctx.swarm.script_run`: no timeout parameter (`src/tools/script-run.ts:55-83`), so 30 s.
- Workflow `swarm-script` node: `timeoutMs` 1 s to 5 min, default 30 s (`src/workflows/executors/swarm-script.ts:25-41`).
- `/x` route: header `x-swarm-timeout-ms`, default 60 s, clamped 1 s to 5 min (`src/http/x.ts:47-48, 122-129`).
- `runSavedScriptAsAgent` accepts `timeoutMs` (`src/be/scripts/run-saved.ts:25, 61`). Scheduler passes 60 s (`src/scheduler/scheduler.ts:122`).

**Secrets in namespaces**: worked example `ctx.fs`. The API builds an `EgressSecretEntry` from the agent's own `AGENT_FS_API_KEY` row (`src/be/script-credential-broker.ts:63-101`). The descriptor carries only `{ apiUrl, orgId, driveId }`. `script-fs.ts:114-125` passes `placeholderForConfigKey(...)` as the key, and the patched fetch swaps in the value for allowed hosts.

**Steps to add a namespace, as the existing ones were added**
1. Host factory under `src/scripts-runtime/`, field on `RuntimeCtx` and `buildCtx`. No `src/be/db` imports. Use `postSwarmJson` for API calls.
2. Optional dedicated route via `route()` with an RBAC verb (`src/rbac/permissions.ts`, `legacy-policy.ts`), typed 2xx schema, import in `src/http/all-routes.ts`, `bun run docs:openapi`.
3. Non-secret descriptors through `SwarmConfigPayload`, `RunScriptInput` (`loader.ts:40-76`), `buildConfigPayload`, and the `runScriptWithRunCredential` callers (`http/scripts.ts:815`, `run-saved.ts:49`, `workflows/executors/swarm-script.ts:132`, `scheduler/scheduler.ts:110`, `http/x.ts:248`).
4. Native: add to `buildCtx` in `eval-harness.ts:112-117`. QuickJS: shape entry, prelude line, `dispatchCall` branch wrapped in `swarmHostCalls.run(true, ...)`.
5. Types in `SCRIPT_SDK_TYPES` and `ScriptContext`, or a contributor. `bun run build:script-types`.
6. MCP tools: `SDK_TOOL_NAME_MAP` or `EXCLUDED_TOOLS`, optional `bridgeRequestFor` case, `READ_TOOLS`.
7. Tests per executor (pattern `src/tests/scripts-fs.test.ts:189`), `scripts-typecheck.test.ts`, `sdk-allowlist.test.ts`, black-box E2E scenario for new routes or tools.

### 5. Budget admission and non-token cost

**Short answer:** swarm-owned compute (E2B minutes, worker runtime time) is not tracked as cost today. The only non-token charges are provider-billed fees inside `session_costs.totalCostUsd`: the Claude Managed Agents `runtime_hour` fee, Devin `acu`, and per-request `web_search`.

**Budget admission** (`src/be/budget-admission.ts`)
- One entry point: `canClaim(agentId, nowUtc, requestedByUserId?)` (`budget-admission.ts:72`). It does not write to the DB.
- Three scopes, checked in order: `global` (line 91), `agent` (line 106), `user` (line 122, only when `requestedByUserId` is set). There is no task-tree scope. Every budget is a daily USD figure (`dailyBudgetUsd`), compared as `spend >= dailyBudgetUsd` on the UTC calendar day (line 44). `resetAt` is the next UTC midnight (line 47).
- Spend sums `session_costs.totalCostUsd`: `getDailySpendForAgent` (`src/be/db.ts:13532`), `getDailySpendGlobal` (`db.ts:13552`), `getDailySpendForUser` (`db.ts:13566`, joins `agent_tasks` on `taskId` and filters `requestedByUserId`).
- Refusal shape (`budget-admission.ts:14-31`): `{ allowed: false, cause: "agent" | "global" | "user", agentSpend?, agentBudget?, globalSpend?, globalBudget?, userSpend?, userBudget?, resetAt }`.
- Kill switch: `BUDGET_ADMISSION_DISABLED` (line 77; `src/be/swarm-config-guard.ts:569`; catalog `apps/ui/src/lib/configuration-catalog.ts:1574`).
- Call sites: `/api/poll` for a pre-assigned task (`src/http/poll.ts:434`) and for a pool candidate (`poll.ts:622`), MCP `task-action accept` (`src/tools/task-action.ts:522`, message "Refused: <cause> daily budget exceeded. Resets at <resetAt>."), runtime-pool provisioning (`src/be/runtime-pools/supervisor.ts:852`, breaks the provisioning loop), and runtime-pool routing (`src/be/runtime-pools/routing.ts:272`). Task creation is not gated.
- Side effects: dedup row `recordBudgetRefusalNotification` (`db.ts:13597`), bus event `task.budget_refused` (`src/be/budget-refusal-notify.ts:154`), extension event `post.task.budgetRefused` (`src/extensions/post-bridge.ts:194`), worker backoff (`src/utils/budget-backoff.ts`).
- Budget CRUD: `src/http/budgets.ts` (`GET /api/budgets`, `GET /api/budgets/refusals`, GET/PUT/DELETE `/api/budgets/{scope}/{scopeId}`). Daily limits are rows in the `budgets` table (migrations 046, 074), not `swarm_config` keys.

**Cost storage**
- `session_costs` (`src/be/migrations/001_initial.sql:179`, then 047 `costSource`, 063 relax, 128 accuracy columns plus `modelBreakdown` JSON, 271 subscription usage). `costSource` enum: `"harness" | "pricing-table" | "unpriced" | "estimated"` (`src/types.ts:1950`).
- `agent_tasks` has no cost column. Cost attaches through `session_costs.taskId`.
- Pricing book `pricing(provider, model, token_class, effective_from, price_per_million_usd)` (`046_budgets_and_pricing.sql:41`), append-only, latest `effective_from <= now` wins. `PricingTokenClassSchema` (`types.ts:4134`): `input, cached_input, output, cache_write, cache_write_1h, web_search, runtime_hour, acu`. `PricingProviderSchema` at `types.ts:4114`.
- Recompute: `recomputeSessionCost` (`src/http/session-cost-recompute.ts:173`), called from `POST /api/session-costs` (`src/http/session-data.ts:176`). The time-based fee path (lines 271-277):
  ```ts
  if (input.provider === "claude-managed" && durationMs > 0) {
    const runtimeRate = await lookupRate(input.provider, "*", "runtime_hour", input.atEpochMs);
    if (runtimeRate == null) return unpricedResult(input, modelBreakdown);
    sessionFeesUsd += (durationMs / 3_600_000) * (runtimeRate / PER_MILLION);
  ```
  Seeded at $0.08 per hour (`src/providers/pricing-sources.md:167`).

**Usage page**
- Routes: `GET /api/session-costs/summary` (`session-data.ts:242`, `groupBy: day | agent | both | user`), `GET /api/session-costs/dashboard` (280), `GET /api/session-costs` (291), `GET /api/keys/costs` (`src/http/api-keys.ts:413`). Summary query `getSessionCostSummary` (`db.ts:5259-5480`) reads `session_costs sc LEFT JOIN agent_tasks t`. It returns totals, `daily`, `byAgent`, `byUser`, `byCredential`.
- UI: `apps/ui/src/app/routes.tsx:327` (`usage`), main component `apps/ui/src/pages/usage/usage-content.tsx` (`useUsageSummary(... groupBy: "both")`, line 94). Sub-routes `/usage/budgets`, `/usage/metrics`, `/usage/savings`. Dimensions: day, agent, user, credential. No breakdown by cost type and no per-runtime dimension.

**Closest analogue to "max live resources": runtime pool caps**
- `runtime_pools.max_runtimes` (nullable = uncapped), `min_runtimes`, `slots_per_runtime` (`206_runtime_pools.sql:27`; Zod `types.ts:2447-2455`). No cost columns on `runtime_pools` or `runtime_instances`.
- `countPoolRuntimes` (`src/be/runtime-pools/demand.ts:46`) counts `provisioning` plus fresh `active` instances. `computeDesired` (`demand.ts:58`): "Existing runtimes consume the pool cap before any agent receives new capacity" (line 63).
- Provisioning concurrency `RUNTIME_PROVISION_CONCURRENCY` (default 8), circuit breaker `RUNTIME_CIRCUIT_THRESHOLD` / `RUNTIME_CIRCUIT_OPEN_MIN` (catalog lines 558, 596).

### 6. E2B runtime provider reuse

**Short answer:** the generic E2B client code lives in `src/e2b/dispatch.ts` and `src/e2b/env.ts`, not in the runtime adapter. The adapter (`src/runtime-providers/e2b.ts`) is a thin layer over it. The repo pins `"e2b": "2.26.0"` (`package.json:248`, same in `apps/evals/package.json:20`). E2B's private-traffic page recommends 2.60.0 or later (section 1).

**Generic client pieces** (`src/e2b/dispatch.ts`)
- Raw HTTP: `e2bFetchJson` (`:218-245`, `X-API-Key` header `:134-139`, throws `E2BApiError(statusCode, ...)`). `createSandbox` (`POST /sandboxes` with `{templateID, timeout, secure: true, allow_internet_access, metadata, envVars}`, `:247-266`), `killSandbox` (`DELETE /sandboxes/:id`, `:324-335`), `listSandboxes` (`GET /sandboxes`, `:337-342`), `setTemplateVisibility` (`:631-664`).
- SDK via `await import("e2b")`: `setSandboxTimeout` (`Sandbox.connect` + `setTimeout` + `getInfo`, `:299-322`), `buildImageTemplate` (`Template().fromImage`, `:606-614`).
- `e2bSdkConnectionOptions(apiKey, env, apiBase)` (`:161-172`) from `E2B_API_URL`, `E2B_DOMAIN`, `E2B_SANDBOX_URL`.
- Port URL helpers `sandboxPortHost` / `sandboxPortUrl` (`:192-202`): `https://<port>-<sandboxID>.<domain>`, default domain `e2b.app`.
- `redactWithEnv` and `DEFAULT_E2B_API_BASE` (`src/e2b/env.ts`).
- CLI template build `runE2BCommand` / `buildTemplate` (`:531-569`).

**Worker-specific pieces** (not generic): `startDetachedProcess` (`bash -lc`, `user: "root"`, `tee` to `/tmp/agent-swarm-e2b-worker.log`, `:349-395`), the `/docker-entrypoint.sh` start in `provision`, `streamSandboxLog`, `waitForAgentRegistration`, `resolveWorkerApiUrl` and the HTTPS worker URL check.

**Runtime adapter** (`src/runtime-providers/e2b.ts`)
- Key only from `target.E2B_API_KEY` (`:90-93`), never `process.env`. `withRedactedErrors` (`:43-53`).
- Traits (`:59-71`): `canProvision: true`, `ephemeralDisk: true`, `supportsPause: true`, `maxTtlSec: 24*3600`, `maxContinuousSec` from `E2B_MAX_CONTINUOUS_SEC` (default 3600). Default lease 900 s (`:33`), `E2B_TTL_SEC` override.
- `status` via `Sandbox.getInfo` (`:150-162`; runbook: `Sandbox.connect` would resume a paused sandbox). `pause` via `Sandbox.betaPause` (`:199-205`). `resume` via `Sandbox.connect(id, { timeoutMs })` (`:207-216`). `renew` via `setSandboxTimeout` (`:182-197`). `list` filters metadata `swarm.runtime-id` and `swarm.owner === ownerId` (`:164-180`).
- Metadata `{...req.labels, owner, runtimeId, poolId, agentId}`, reserved keys last (`:106-112`).

**Interface pattern** (`src/runtime-providers/types.ts`)
- "Mirrors the harness-provider shape in `src/providers/types.ts` (adapter + traits + lazy factory). DB-free by design" (`:1-9`).
- `RuntimeProviderTraits` (`:15-28`), `RuntimeTargetConfig` flat bag (`:31`), `ConfigStatus` (`:33-37`), `RuntimeHandle { kind, externalId, createdAt?, controllerId?, meta? }` (`:67-76`), `RuntimeStatus` (`:78`), `RuntimeProvider` with required `checkConfig/provision/terminate/status/list` and optional `renew/pause/resume/releaseCache` (`:80-100`), `RUNTIME_LABELS` (`:103-108`).
- Registry is a lazy `switch` factory, not a registry object: `createRuntimeProvider(kind, target)` (`src/runtime-providers/index.ts:13-41`), kind enum `RuntimeProviderKindSchema` (`src/types.ts:2364`). Harness providers use the same shape (`src/providers/index.ts:24-79`).
- `BuiltinController` (`src/runtime-providers/controller.ts:35-91`) binds provider and target, rethrows errors through `scrubSecrets`, stamps `controllerId`.

**Credentials**
- E2B key lives in `runtime_controllers.secret_config`, one AES-256-GCM JSON blob (`src/be/runtime-pools/db.ts:211-212, 283-284`). API responses carry only `secretConfigKeys` (`rowToController`, `:54-69`). Target assembly with env overlay and `registerVolatileSecret` in `getRuntimeControllerTarget` (`:114-143`). Boot registration `loadRuntimeControllerSecrets` (`:568-585`).
- Seeding: `builtin-e2b` copies `env.E2B_API_KEY` into `secretConfig` when none is stored (`src/be/runtime-pools/seed.ts:73-81`).
- UI: `apps/ui/src/pages/settings/runtime-controllers-page.tsx` (write-only secret rows, `secretPatch` `:87`).

**Supervisor as reaper analogue** (`src/be/runtime-pools/supervisor.ts`)
- `startRuntimeSupervisor(intervalMs = RUNTIME_SUPERVISOR_INTERVAL_MS || 5000)` (`:957-977`), `setInterval` + `unref`, `inFlight` overlap guard in `reconcileOnce` (`:912-933`), debounced kick on `task.created` (`:935-955`), `stopRuntimeSupervisor` (`:979-1011`). Boot `src/http/index.ts:885`, shutdown `:518`.
- Reap (`reapPoolRuntimes`, `:359-610`): batched `status`, per-id serialization (`recovery.ts:31-46`), stale/missing/provision-timeout death paths, idle detection with `idle_since` and a two-tick drain (`:582-604`).
- The supervisor never calls `pause`. Paused runtimes go to `recoverPausedRuntime` (`recovery.ts:88-109`).
- Lease renew (`renewPoolLeases`, `:612-649`), rotation (`lifecycle.ts:4-24`), orphan sweep with `ORPHAN_GRACE_MS = 120_000` (`:651-700`), circuit breaker (`recordProvisionFailure`, `:93-182`).
- Tables: `runtime_controllers`, `runtime_pools`, `runtime_instances` columns (`migrations/206_runtime_pools.sql`, `132_multi_runtime_instances.sql`). Status values live in Zod, not SQL CHECK (`RuntimeInstanceStatusSchema`, `src/types.ts:2358`).

**Tests**: no shared behavioral contract suite across adapters. `src/tests/runtime-provider-registration.test.ts` checks touch points (factory list, adapter file, runbook heading, UI kind list). Per-adapter tests mock infrastructure (`runtime-providers-e2b.test.ts` mocks `../e2b/dispatch` and `e2b`). Fakes: `FailureTestController` (`src/tests/runtime-pools-test-utils.ts:13-42`), `FakeRuntimeProvider` (`runtime-supervisor.test.ts:55`). Smoke: `scripts/runtime-provider-smoke.ts`.

**Background loops**: no generic interval registry. Each subsystem owns `start*`/`stop*` with a module-level `setInterval`, wired in `src/http/index.ts:865-919` and `shutdown()` (`:500+`). Heartbeat and scheduler wrap bodies in `withLoopPath(...)`; the supervisor does not.

**Runbook** (`runbooks/runtime-providers.md`): adapters stay DB-free (`:3-4`), adapter contract (`:165-179`), owner isolation via labels that override user labels (`:181-188`), adding-a-provider checklist (`:369-379`), E2B section (`:272-329`).

**Other E2B users**: `src/commands/e2b.ts` (CLI, builds templates from `Dockerfile` / `Dockerfile.worker`), `apps/evals/src/swarm/sandbox.ts` (imports `killSandbox`, `e2bSdkConnectionOptions` from `src/e2b/dispatch`, writes files through the SDK `Sandbox`). No `e2b.toml` or template directory exists.

### 7. Scoped git tokens

**Short answer:** the swarm never mints a repo-scoped, read-only, short-lived git token today. The GitHub App path mints installation tokens, but with no scope narrowing, and only for server-side reactions and review reads. Workers clone and push with a long-lived `GITHUB_TOKEN` / `GITLAB_TOKEN` from `swarm_config`.

**GitHub App** (`src/github/app.ts`)
- Config: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (raw PEM or base64, `:59-69`). Log line "App credentials loaded for bot reactions" (`:70`).
- App JWT is hand-rolled RS256 with `node:crypto` (`:154-192`). No `@octokit/auth-app`.
- `getInstallationToken(installationId)` (`:198-248`) POSTs `/app/installations/${installationId}/access_tokens` with no body (`:213-223`). No `repositories`, `repository_ids` or `permissions` field anywhere in `src/github/`. The token has the installation's full scope.
- In-memory cache keyed by installation id, reused while `expiresAt > Date.now() + 60_000`. Lifetime is GitHub's default (comment: "typically 1 hour", `:196`).
- Callers: `src/github/reactions.ts:29-41, 221`, `src/github/handlers.ts:1111-1117`. Both fall back to `GITHUB_TOKEN`. No caller hands the token to a worker.
- GHES support: `githubApiUrl`, `resolveGitHubHost` (`app.ts:1-2, 43-49`).
- `GITHUB_APP_PRIVATE_KEY` is in `ENV_EXPORT_RESTRICTED_KEYS` (`src/utils/config-env-export.ts:19`).

**Worker git credentials**
- `docker-entrypoint.sh:361-396` fetches `GET /api/config/resolved?agentId=...&includeSecrets=true` and exports rows to env.
- GitHub: `gh auth setup-git` (`:519`). GHES: credential helper that echoes `username=x-access-token` and `password=${GH_ENTERPRISE_TOKEN}` (`:513-514`). GitLab: `glab auth login` plus helper `username=oauth2` (`:545-580`). Azure DevOps (`:596`), Bitbucket (`:644`).
- Clone: `ensureRepoForTask` (`src/commands/runner.ts:531-540`) uses `gh repo clone`, `glab repo clone` or `git clone` with ambient credentials.
- `/api/config/resolved` (`src/http/config.ts:243-268`, handler `:419-454`) unmasks secrets per `requestSecretReadScope` (`:66-98`) and registers revealed values with the scrubber (`registerVolatileSecret`, `:442-447`).

**GitLab** (`src/gitlab/auth.ts:26-49`): static `GITLAB_TOKEN` ("PAT/Group Access Token for API calls"), `GITLAB_URL`. No minting.

**Repos registry**: `swarm_repos(id, url, name, clonePath, defaultBranch, autoClone, guidelines, hooks, ...)` (`001_initial.sql:260-269`, migrations 032, 098, 082; `SwarmRepoSchema` `src/types.ts:2257-2272`). No credential column. Per-repo credentials can only be `swarm_config` rows with `scope='repo'` (`types.ts:2190`), merged global, then agent, then repo (`getResolvedConfig`, `db.ts:7021-7052`).

**Existing short-lived credential patterns**
- Per-run script token (`src/be/scripts/run-credential.ts`): `mintScriptRunToken(agentId, SCRIPT_RUN_TOKEN_TTL_MS, provenance)`, TTL `15 * 60 * 1000` ("Backstop lifetime", `:11`), revoked in `finally` (`:48-76`). Token rows in `session_tokens` (`migrations/149_session_tokens.sql`), plaintext `SESSION_TOKEN_PREFIX + base62(randomBytes(24))`, stored as sha256 (`src/be/users.ts:687-764`). Swarm API bearer only.
- Credential broker (`src/scripts-runtime/credential-broker/README.md`, `default-bindings.ts:16-27`): scripts send `[REDACTED:<configKey>]` placeholders. The fetch patch substitutes the value in headers or query only for hosts in `allowedHosts`. Default binding: `GITHUB_TOKEN` for the GitHub API host. Bindings live in `SCRIPT_CREDENTIAL_BINDINGS`. It brokers a static secret, it does not mint.
- agent-fs per-agent key: `POST /api/fs/agent-credentials` (`src/http/fs.ts:112-127`) stores `AGENT_FS_API_KEY` as an agent-scoped secret (`src/be/seed/agent-fs-provision.ts:310-312, 365-367`).

**Secrets storage and scopes** (relevant to "secret scope for agent references")
- No separate secrets table. Secrets are `swarm_config` rows with `isSecret=1`, scopes `global | agent | repo` (`001_initial.sql:246-258`). There is no `user` scope.
- AES-256-GCM on write (`db.ts:6865`, `src/be/crypto/secrets-cipher.ts:1-49`). Key from `SECRETS_ENCRYPTION_KEY`, `_FILE`, `<dbdir>/.encryption-key`, or auto-generated (`src/be/crypto/key-bootstrap.ts:9-14`).
- Agent read paths: env injection at boot, MCP `get-config` (`src/tools/swarm-config/get-config.ts:59-128`; unmasked needs `config.read.secrets`, otherwise "reading unmasked secrets requires the lead agent"), `/api/config/resolved`, and `ctx.swarm.config` in scripts (own agent scope over global, no repo secrets, `config.ts:114-128`).
- `secret-scrubber.ts:61-62` lists `GITHUB_TOKEN` and `GITLAB_TOKEN`.

### 8. Dashboard CSP, signed links, hop host

**Dashboard CSP: no `frame-src` restriction today**
- The only CSP is in the nginx image: `apps/ui/nginx.conf:33` `add_header Content-Security-Policy "frame-ancestors 'self'; object-src 'none'; base-uri 'self'" always;` (asserted by `scripts/smoke-ui-image.sh:61`). No `default-src`, `frame-src`, `child-src` or `connect-src`, so the dashboard can frame any origin. `frame-ancestors 'self'` only stops other sites from framing the dashboard.
- No CSP meta in `apps/ui/index.html`, none in `vite.config.ts`, none in `vercel.json`. No env var extends it.
- Existing iframes: pages (`apps/ui/src/pages/pages/[id]/page.tsx:245`, `sandbox="allow-scripts allow-forms allow-same-origin allow-popups"`, line 258), Comb HTML (`apps/ui/src/components/comb/viewers/html-viewer.tsx:124`, `HTML_SANDBOX = "allow-scripts allow-forms allow-popups allow-modals"`, no `allow-same-origin`, `referrerPolicy: "no-referrer"`, `apps/ui/src/lib/comb/html-view.ts:25-37`), PDF viewer (`pdf-viewer.tsx:10`), attachment preview (`task-attachments-section.tsx:909`).
- `PAGES_FRAME_ANCESTORS` controls who may frame public `/p/:id` (`src/http/pages-public.ts:308-332`, catalog `configuration-catalog.ts:1606`).

**Signed-link patterns that exist**

| Mechanism | Where | Mint | Verify | TTL | Revoke |
|---|---|---|---|---|---|
| Page-session cookie | `src/utils/page-session.ts` | `POST /api/pages/{id}/launch` (`src/http/pages.ts:225-234`) or `/p/:id?key=` | HMAC-SHA256 + `timingSafeEqual`, payload `{pageId, exp, uid?, name?, op?}` (`:44-54, 134-229`) | 3600 s (`:339`) | none found; rotate secret |
| Realtime ticket | `src/realtime/tickets.ts`, `src/http/realtime.ts:14` | `POST /api/realtime/ticket` | redeemed on WS upgrade `?ticket=` (`src/realtime/transport.ts:155`) | 60 s | one-shot, deleted on redeem (`tickets.ts:53`) |
| agent-fs signed URL | `src/fs/agent-fs-provider.ts:230`, `src/http/fs.ts:228` | GET signed-url route | agent-fs | max 3600 s (`fs.ts:574`) | none |
| agent-fs site share | `apps/ui/src/lib/comb/html-view.ts` | dashboard asks for 900 s | agent-fs | 15 min, re-mint under 3 min left | none |

- Page-session secret: `PAGE_SESSION_SECRET`, `_FILE`, `<dbdir>/.page-session-secret`, or auto-generated. It never falls back to the API key (`page-session.ts:10-15, 82-128`). Cookie `page_session_<pageId>`, `SameSite=None; Secure` outside local dev (`:381-382`).
- Page CSP (`pages-public.ts:342-373`): `default-src 'self'`, `connect-src 'self'`, `frame-ancestors 'self' <APP_URL origins> [+ PAGES_FRAME_ANCESTORS for public pages]`.

**Proxies in the API today**
- Server is `node:http`, not `Bun.serve` (`src/http/index.ts:2, 277, 773`). Handlers run in order, then a 404 (`:447-456`).
- WebSockets use `ws` with `noServer: true`: realtime (`src/realtime/transport.ts:188`, paths `/@swarm/realtime` and `/api/realtime`, other paths `socket.destroy()`, auth before `handleUpgrade`, cap 1000 clients) and controllers (`src/http/controllers-connect.ts:56-73`). Both attach to `httpServer` at `index.ts:474-476`. No WebSocket forwarding to an upstream exists.
- HTTP forwarding: `src/http/page-proxy.ts:324` (`/@swarm/api/*`, cookie auth, buffered body for "small JSON payloads", path-traversal guard `:172`). `src/http/agentfs-proxy.ts:302` (`/agentfs/*`, `/share/*`, `/site/*`, streaming body, forwards only `Authorization: Bearer af_...` plus an allowlist, never Cookie or `X-Agent-ID`, 502 on upstream failure, canonical-path check `:194-200`).
- Note: the Bun websocket client headers found in section 1 apply to Bun's global `WebSocket`. The API upgrade path today is `ws` on `node:http`.

**Public URL config** (`src/utils/constants.ts`): `getAppUrl()` (`APP_URL`, then `DASHBOARD_URL`, default `https://app.agent-swarm.dev`, `:18-45`), `getMcpBaseUrl()` (`MCP_BASE_URL`, internal, `:76`), `getPublicMcpBaseUrl()` (`PUBLIC_MCP_BASE_URL`, `:90`), `deriveApiBaseUrl(req)` (`src/http/utils.ts:549`: public, internal, forwarded headers, localhost). No wildcard-subdomain routing exists.

**Egress allowlist** (`src/utils/egress-guard.ts`)
- `assertUrlSafe` (`:179`, string check only) and `createGuardedFetch` (`:487`, DNS resolution, private-answer deny, address pinning, max 5 redirects, credential headers dropped on cross-origin hops).
- `EgressPolicy = { allowPrivate, allowlist }` (`:218`). Config `SCRIPT_EGRESS_ALLOW_PRIVATE`, `SCRIPT_EGRESS_ALLOWLIST` (`src/scripts-runtime/loader.ts:90-95`), enforced only by the QuickJS executor (per code comment). Validator `swarm-config-guard.ts:466-468`.
- No per-provider host table exists. API-side provider calls (`mcp-oauth.ts`, `provider-key-probes.ts`, `script-connections.ts`) use `assertUrlSafe` with their own options. `page-proxy` and `agentfs-proxy` use plain `fetch`.

**Scrubber** (`src/utils/secret-scrubber.ts`, `runbooks/secret-scrubbing.md`)
- Output `[REDACTED:<name>]`. Passes: known values (env, volatile, stored), `TOKEN_REGEXES` (`:507`, entries `{ name, lits, re }`), key-context (assignments, headers, URL userinfo), vendored gitleaks rules.
- Runtime registration: `registerVolatileSecret(value, name)`; stored secrets `registerStoredSecret` in `src/be/secret-registry.ts`.
- New shape: extend `SENSITIVE_KEY_EXACT` or `TOKEN_REGEXES`, add a test in `src/tests/secret-scrubber.test.ts` or `fixtures/secret-corpus.ts`, bump `SCRUBBER_RULES_VERSION` (now 12, `:55`), and add a `mayRedactWith` clause for new rule shapes (`secret-scrub-gate.test.ts`).
- No structural rule today for query-string signed URLs or `wss://...token=` shapes (not run against such strings).

## Code References

| File | Line | Description |
|------|------|-------------|
| `src/be/db.ts` | 2504, 2563-2778 | `createTaskExtended` and the parent-inheritance block |
| `src/types.ts` | 993 | `CreateTaskOptionsSchema` (task write contract) |
| `src/tasks/worker-follow-up.ts` | 377, 712 | Lead follow-up and resume creators |
| `src/workflows/approval-notifications.ts` | 468 | `createApprovalFollowUpTask` (human answer becomes a task) |
| `src/tools/request-human-input.ts` | 85-131 | Approval request and dashboard URL |
| `src/slack/handlers.ts` | 841-916 | Slack thread reply to steer or task |
| `src/github/handlers.ts` | 869, 1370 | PR comment and review tasks |
| `src/scripts-runtime/ctx.ts` | 20-59 | `RuntimeCtx` and `buildCtx` |
| `src/scripts-runtime/executors/quickjs-runner.ts` | 225-289, 532-548 | QuickJS `dispatchCall` and shape |
| `src/scripts-runtime/executors/quickjs-prelude.ts` | 420-448 | QuickJS `ctx` mirror |
| `src/be/scripts/typecheck.ts` | 32-676, 645-661 | `SCRIPT_SDK_TYPES`, `ScriptContext` |
| `src/be/scripts/type-contributors.ts` | 6-24 | Type contributor contract |
| `src/http/script-connection-proxy.ts` | 35-85 | Dedicated routes behind `ctx.api` / `ctx.mcp` |
| `src/scripts-runtime/executors/types.ts` | - | Wall-clock defaults and `SwarmConfigPayload` |
| `src/be/budget-admission.ts` | 72 | `canClaim` |
| `src/http/session-cost-recompute.ts` | 173, 271-277 | Cost recompute and `runtime_hour` fee |
| `src/e2b/dispatch.ts` | 161-395 | DB-free E2B client helpers |
| `src/runtime-providers/types.ts` | 15-108 | Runtime provider interface and traits |
| `src/runtime-providers/e2b.ts` | 59-216 | E2B runtime adapter |
| `src/be/runtime-pools/supervisor.ts` | 359-610, 957-977 | Reap loop and supervisor start |
| `src/be/runtime-pools/db.ts` | 114-143, 211-212 | Controller target assembly, encrypted secrets |
| `src/github/app.ts` | 198-248 | Installation token mint (no scope narrowing) |
| `docker-entrypoint.sh` | 361-396, 493-580 | Worker config fetch and git credential helpers |
| `src/be/scripts/run-credential.ts` | 11, 39-76 | Per-run 15 min token, revoked in `finally` |
| `src/be/script-credential-broker.ts` | 63-101 | Placeholder secret pattern (`ctx.fs` agent-fs key) |
| `apps/ui/nginx.conf` | 33 | Dashboard CSP (`frame-ancestors` only) |
| `src/utils/page-session.ts` | 44-229 | HMAC signed cookie mint and verify |
| `src/realtime/tickets.ts` | 3, 53 | One-shot 60 s ticket |
| `src/http/agentfs-proxy.ts` | 194-302 | Streaming HTTP reverse proxy |
| `src/realtime/transport.ts` | 151-205 | `ws` upgrade auth on `node:http` |
| `src/utils/egress-guard.ts` | 179, 218, 487 | URL guard, egress policy, guarded fetch |
| `src/utils/secret-scrubber.ts` | 55, 507 | Rules version and `TOKEN_REGEXES` |

## Decisions from review (2026-11-08)

- **Preview access is configurable.** A setting selects the access mode. v1 ships `public` (the E2B public URL) as the default. `private` (the swarm hop) is not built in v1. Selecting it fails with a clear error. This changes the brainstorm decision "nothing public by default" for v1. Taras marked the private-fails part with "(?)", so confirm it during planning.
- **E2B SDK: bump for all.** One bump of `e2b` in the root `package.json` to 2.60.0 or later, with a runtime-pool regression check (`betaPause`, `connect`, `getInfo`) in the same PR.
- **Cost: new `resource_costs` table.** Per-resource rows (provider time times rate). Budget admission and the Usage summary add them as a non-token line with its own dimension.
- **Live checks: spike now.** The six facts that need live calls are checked before the plan (section "Live spike results").

## Live spike results (2026-11-08)

### Browser Use v4 (5 sessions, 1 profile, all stopped or deleted)

- **Create**: `POST /browsers` with `{ timeout: 1, metadata }` returned 201 in about 0.6 s. `timeoutAt - startedAt` was exactly 60 s, so `timeout` is in minutes. A 1-minute session reported `browserCost` 0.000333.
- **`cdpUrl` shape**: `https://<session-uuid>.cdp.browser-use.com/`. It has no query and no token. The session id in the hostname is the only secret.
- **`liveUrl` shape**: `https://live.browser-use.com/?wss=<64 chars>`. One query parameter, `wss`, with a token-like value.
- **Live view framing**: `liveUrl` returned 200 with no `X-Frame-Options`, no CSP and no `Set-Cookie` (Next.js on Vercel). The headers allow framing. An actual iframe embed was not tested.
- **agent-browser**: `agent-browser --cdp "<https cdpUrl>" open https://example.com` worked first try with the https URL as given. `snapshot` and `get title` (`Example Domain`) worked.
- **URL lifetime**: after `PATCH {"action":"stop"}` (200, 0.4 s), `GET /browsers/{id}` shows `status: stopped` and `cdpUrl: null`, `liveUrl: null`. A reconnect with the saved CDP URL failed with `502 Bad Gateway`. `<cdp>/json/version` returned 502 `vm not found`. Both URLs die with the session.
- **Timeout stop**: the session stopped about 8 s after `timeoutAt`.
- **Profile save**: both a timeout stop and an explicit stop saved the profile. After timeout, `cookieDomains: ["httpbin.org"]` and `updatedAt` moved. The next session with the profile had the cookie. After explicit stop, the next session (started 5 s later) had both cookies. `lastUsedAt` stayed `null` throughout.
- **Limits**: responses carry `x-ratelimit-limit: 125`, `x-ratelimit-remaining`, `x-ratelimit-reset: 5`. No profile-count or session-count fields or headers were seen.

### E2B (SDK 2.63.0, 9 sandboxes, all killed)

- **Token after connect**: `trafficAccessToken` (64 chars) is set on create and also on a fresh `Sandbox.connect(id)` object. The connected token worked as the header (200). `Sandbox.getInfo` has no token field. Its keys: `sandboxId, templateId, name, metadata, allowInternetAccess, envdVersion, startedAt, endAt, state, cpuCount, memoryMB, network, lifecycle, sandboxDomain, volumeMounts, envdUnresponsiveAtPause`. The create object also exposes `envdAccessToken` and `mcpToken`.
- **Default timeout**: `endAt - startedAt` = 300000 ms (5 min).
- **Default template**: git, node v20.9.0, npm 10.1.0, npx, python3 3.11.6 on Debian 12. No `bun`, no `pnpm`. Latest `create-vite` 9.3.4 and `vite` 8.3.6 need node `^20.19.0 || >=22.12.0` and fail on this node (`'node:util' does not provide an export named 'styleText'`). `vite@6` (6.4.5) works.
- **Private traffic**: port 8000 without the header returned 403, with `e2b-traffic-access-token` 200.
- **Vite through the port host** (`5173-<id>.e2b.app`): the first fetch returned 403 "Blocked request. This host (...) is not allowed" (Vite `allowedHosts`). With `server: { allowedHosts: true }` it returned 200. The HMR websocket (`vite-hmr` subprotocol) opened and received `{"type":"connected"}` on a public sandbox, and on a private sandbox when Bun's `WebSocket` sent the header. Without the header the private upgrade got 403. A stopped dev server gives 502.
- **Auto-pause and resume**: `lifecycle: { onTimeout: "pause", autoResume: true }` with `timeoutMs: 60_000`. State was `paused` by t+65 s. The first fetch after pause returned 200 in 226 to 264 ms (two runs), and the timeout restarted at about 300 s. **The `http.server` process was gone after resume in both runs** (`ps` empty, `commands.list()` `[]`), and the next fetch returned 502. The re-check below explains this.
- **Process survival re-check** (4 sandboxes, all killed, one run per variant). The `commands.run` default `timeoutMs` is 60_000 (`CommandStartOpts.timeoutMs`, `@default 60_000`, `node_modules/e2b/dist/index.d.ts` about line 6282). The manual pause call is `sbx.pause()` / `Sandbox.pause(id)`. `betaPause` remains as an alias.

  | Variant | Auto-paused? | Alive after resume | First fetch after pause | Follow-ups | PID |
  |---|---|---|---|---|---|
  | A: `{ background: true, timeoutMs: 0 }` | **no**, stayed `running` for the full 3 min poll | n/a (still running at t+204 s) | n/a | n/a | same |
  | B: `nohup ... &` (shell-detached, command returns at once) | yes, about t+62 s | yes | 200, 285 ms | 200, 200, 200 | same |
  | C: `{ background: true }`, default timeout (control) | yes | **no** (alive at t+59 s, gone after) | 200, 230 ms | 502, 502, 502 | gone |
  | D: A plus manual `sbx.pause()` at t+31 s, resume via `Sandbox.connect` | manual | yes | 200, 161 ms | 200, 200, 200 | same |

  - The default 60 s command timeout killed the process in the first spike. Processes do survive pause and resume when they outlive their command (B, D).
  - **An open background command with `timeoutMs: 0` appears to block auto-pause** (A never paused). Not isolated further. For idle pause, either start the server shell-detached (B) or pause explicitly from the swarm (D).
  - After a shell-detached start (B), `commands.list()` returns `[]` even though the process runs. Liveness checks must use `ps` or the port, not `commands.list()`.
  - In C, the first fetch after resume returned 200 although the process was gone. Its source is not established.
- **SDK 2.26.0 types** already include `allowPublicTraffic`, `trafficAccessToken`, `lifecycle`, `onTimeout` and `autoResume` (grep of `dist/*.d.ts`). The bump decision stands, but these options do not force it.

## Open Questions

- E2B: why does an open `timeoutMs: 0` background command block auto-pause (variant A)? Single observation, not isolated. It decides between shell-detached starts with E2B auto-pause and swarm-driven `pause()` from the reaper.
- E2B: preview templates need a newer node (or bun) than the `base` template's node v20.9.0 for current Vite. A DB template must name a custom E2B template or install a runtime at setup.
- E2B: dev servers with host checks (Vite `allowedHosts`) block the `*.e2b.app` host by default. The repo file or setup step must allow it.
- Browser Use: an actual iframe embed of `liveUrl` was not tested (headers allow it). The `?wss=` token lifetime beyond the session is unknown (the URL is nulled at stop).
- Swarm (private mode, deferred): the hop would run on `node:http` plus `ws` (the API server), or on a separate host. Cookie domain and host are open. No wildcard-subdomain routing exists.

## Appendix

- **Architecture notes**: API-side adapters stay DB-free (runtime-providers runbook). Provider factories are lazy `switch` statements with dynamic imports (`src/runtime-providers/index.ts`, `src/providers/index.ts`). Provider secrets are stored encrypted per controller row, registered with the scrubber at boot and on read. Background loops are module-level `setInterval` pairs started from `src/http/index.ts`. Scripts reach the API through `postSwarmJson`, the MCP bridge, or dedicated `route()` handlers with RBAC verbs.
- **Source quality**: provider facts in sections 1 and 2 are verbatim from fetched docs unless marked "(summary)". A context-mode hook blocked `WebFetch`, so the second pass used `ctx_fetch_and_index`.
- **Historical context (from thoughts/)**: `thoughts/taras/brainstorms/2026-10-10-computer-primitive.md` (Oct 10 computer primitive, docs-only PR #2042), `thoughts/taras/brainstorms/2026-11-07-browser-and-sandbox-primitives.md` (source brainstorm).
