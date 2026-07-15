# Changelog

All notable changes to Agent Swarm are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.119.1] - 2026-07-15

### Changed
- **Daily release metadata now reflects the v1.119.0 documentation release** (#973) — package, chart, OpenAPI, and generated API-reference versions advance together for the patch release.

## [1.119.0] - 2026-07-14

### Added
- **Experimental scripts-only MCP mode now supports coordination through a compact code-mode surface** (#969) — `SCRIPTS_ONLY_MCP` trims the external MCP catalog to eight script tools while preserving the full SDK behind `script-run`, adds per-agent/repository/global configuration, ships six coordination seed scripts, and includes a ready-made experiment stack plus measured harness guidance.

## [1.118.0] - 2026-07-12

### Added
- **Canonical asset namespace keys now group related swarm resources across their lifecycle** (#963) — tasks, workflows, schedules, pages, and provider-backed files support shared or personal namespace keys, inheritance, exact/prefix filtering, audited metadata-only moves, and cross-entity discovery without replacing their existing IDs or routing context.

### Fixed
- **Favorites now work with hosted dashboard operator authentication** (#967) — page, workflow, and schedule favorites resolve to a stable operator principal scope, persist across API-key rotation, and remain isolated from user-scoped favorites.

## [1.117.0] - 2026-07-11

### Added
- **Dashboard catalogs now have URL-backed search and composable filters** (#961) — Pages, Approval Requests, and workflow definitions gained consistent filter bars, list-specific facets, clear actions, pagination reset, and distinct no-match states while preserving existing sorting behavior.
- **Task dispatch now guards Slack routing coherence before work starts** (#960) — `send-task` validates channel/thread pairs against the parent task and Slack context key, rejects accidental cross-thread delivery, and exposes an audited `overrideSlackContext` escape hatch for intentional handoffs.

### Changed
- **The worker image now ships Codex CLI and SDK 0.144.1** (#959) — the pinned runtime supports GPT-5.6 models, aligns the baseline config with `gpt-5.6-terra`, and uses the current `codex plugin add` command so bundled context-mode installation remains active.

### Fixed
- **Dashboard filtering now queries the complete candidate set** (#964) — Approval Request status filtering happens before the row limit, and Pages are fetched in bounded batches so older or later matching records are not hidden from search and facets.
- **Inherited Slack routes are normalized atomically at persistence boundaries** (#960) — channel/thread backfill follows the Slack context key as a unit and residual divergence is corrected and surfaced through telemetry instead of risking a misdirected completion.

## [1.115.0] - 2026-07-10

### Added
- **Routing affinity now gates every pool consumer against the original assignee's role/capabilities** (#954) — resumes, reboot-sweep retry children, and fresh tasks declaring `requiredCapabilities` (`send-task`/`task-action create`) carry a `routingAffinity` snapshot; worker poll auto-claim, `task-action claim`, and the heartbeat's pool auto-assign all use the same eligibility gate, and affinity-tagged pool tasks with zero eligible registered agents escalate to the Lead instead of landing on an arbitrary idle worker.
- **Script API connections can now return raw HTTP responses on demand** (#952) — `ctx.api.*` callers can opt into raw status/header/body access for binary payloads and non-2xx inspection instead of always getting parsed JSON or thrown HTTP errors.
- **Codex now supports the GPT-5.6 Sol, Terra, and Luna model family** (#958) — the new models are available in the catalog, pricing snapshot, UI picker, eval matrix, and portable tier defaults (`smart`/`ultra`, `regular`, and `smol` respectively); GPT-5.6 also exposes the Codex-only `max` reasoning effort when the selected model advertises it.

### Changed
- **User-token RBAC admission now covers more MCP-user and route-backlog surfaces** (#951) — favorites, skills, MCP servers, scripts, and related tool admission paths are now wired through the role engine with tighter secret access posture.
- **The dashboard home now centers on an activity timeline instead of the legacy graph stack** (#945) — overlapping task lanes, parent/child hover links, burst clustering, zoom controls, and a unified home surface replace the older canvas/table/dashboard split.
- **The worker image trims extra Claude-side surfaces by default** (#943) — bundled skills, remote control, Claude AI connectors, and several unneeded built-in tools are disabled in the default Claude config to reduce context/tooling bloat inside worker sessions.
- **Slack-originated delegated tasks now deliver substantive prose results inline in the originating thread** (#957) — completions still avoid duplicates after `slack-reply`, keep primary-attachment deliverables compact, and truncate oversized output with a link to the full task.

### Fixed
- **UI-created tasks can attribute `requestedByUserId` correctly in trusted shared-key deployments** (#953) — operators can opt into a body-field fallback with `TRUST_BODY_REQUESTED_BY_USER_ID=true` without reopening the default anti-spoofing path.
- **Per-agent setupScript failures are non-fatal by default after the v1.106.0 privilege hardening** — `STARTUP_SCRIPT_STRICT` now defaults to `false`, so worker pods continue booting when a per-agent `/workspace/start-up.*` script still contains root-only commands. Set `STARTUP_SCRIPT_STRICT=true` to keep fail-fast behavior.
- **Playwright and browser-automation tasks now have the Chromium runtime libraries they need in the worker image** (#946) — the bundled browser can launch without per-agent `apt` bootstrap workarounds.

### Migration notes
- **v1.106.0 setupScript privilege boundary:** per-agent `setupScript` and `/workspace/start-up.*` hooks now run as the unprivileged `worker` user after the container drops privileges, and the worker image no longer includes blanket passwordless sudo (#865, #866). Move root-requiring steps such as system package installs, `/usr/lib` global npm writes, service ownership changes, or local database bootstrap into the admin-controlled global `SETUP_SCRIPT` config, into the worker image, or into the built-in optional service toggles. Keep per-agent setup user-level, for example `bun i -g` or `npm config set prefix "$HOME/.npm-global"`.

## [1.114.0] - 2026-07-09

### Added
- **Script connections now cover OpenAPI, GraphQL, and proxied MCP clients with OAuth-aware credential bindings** (#934) — lead-managed connections can generate typed `ctx.api.*` and `ctx.mcp.*` surfaces, scheduled/workflow/external script runs receive the same connection context, and the dashboard now has first-class connections and OAuth-app management.
- **Page deletion is now available as a first-class MCP tool** (#940) — agents can remove stale published pages by id or slug instead of only creating/updating them.
- **Workflow webhooks now support explicit verification formats** (#941) — triggers can declare plain HMAC, timestamped HMAC, or token-equality verification with stricter fail-closed validation.
- **RBAC role-engine admission can now be switched on for user-token REST traffic** (#935, #936) — built-in roles, bootstrap/backfill, and zero-role self-healing make per-user admission enforcement practical in hosted and self-hosted swarms.

### Changed
- **Workflow and schedule triage tooling is deeper and more scriptable** (#933) — schedules gained shallow patch updates, workflow/schedule listings expose more operational filters, and the scripts SDK can call the allowlisted triage operations directly.
- **Worker-image harness pins refreshed again** (#932) — `Dockerfile.worker` now ships Claude Code `2.1.208`, Codex `0.143.3`, and OpenCode / `@opencode-ai/sdk` `1.17.17`.

### Fixed
- **User identity resolution now fails closed on unresolved humans instead of inventing display names** (#939) — Slack, GitHub, GitLab, Jira, Kapso, and AgentMail flows all resolve through the same provider-agnostic user invariant, preventing guessed identities from leaking into tasks, approvals, or audit trails.

## [1.113.0] - 2026-07-08

### Added
- **RBAC decisions now write to a dedicated `permission_audit` log** (#922) — allow/deny checks are buffered, retained, and queryable without putting audit writes in the request path.
- **Workflow and schedule triage tooling is available across HTTP, MCP, and scripts** (#933) — schedules can be patched with shallow nullable-field updates, schedule/workflow lists expose operational filters, and the scripts SDK now routes the allowlisted schedule/workflow operations.

### Changed
- **RBAC enforcement now flows through a broader central `can()` chokepoint** (#921, #925) — more MCP tool and config mutations are checked consistently, while `swarm-config` writes/deletes and unmasked secret reads are now lead-gated by default.
- **Schedule authoring guidance now pushes the correct `targetType`** (#927) — operators are steered toward direct `workflow` and `script` targets instead of wrapping them in unnecessary agent-task schedules.
- **Script guidance now covers typed `ctx.api` connections and a single script-decision rubric** (#928, #930) — agent prompts and the `swarm-scripts` skill point workers toward typed API clients, lead-owned connection registration handoffs, and the canonical script-vs-tool policy.
- **Worker-image harness pins refreshed** (#932) — `Dockerfile.worker` now ships Claude Code `2.1.204`, Codex `0.143.0`, and opencode / `@opencode-ai/sdk` `1.17.15`.

### Fixed
- **Favorites routes can no longer fall out of RBAC coverage and OpenAPI generation** (#926) — route-import completeness is enforced so `/api/favorites` stays audited and documented.
- **Memory deletes and HTTP integration tests are more robust against cross-run state leakage** (#924) — SQLite-backed memory deletion now re-checks FTS availability on the current DB, and the integration suite no longer leaves local agent-fs test files in the worktree.

## [1.112.0] - 2026-07-07

### Added
- **Lead-gated Slack message management is now available through MCP** (#918) — registered workers can request Slack message deletion and updates through audited tools while Slack-side mutation authority remains lead-controlled.
- **First-task kickoff now resets task branches to the repository default branch** (#919) — fresh worker sessions start from the latest default branch instead of inheriting stale local branch state.

### Changed
- **Worker images now include PostgreSQL 16 pgvector support** (#920) — worker containers ship `postgresql-16-pgvector` for local and task-scoped database workflows that need vector search.

### Fixed
- **GitHub review submission no longer silently drops inline comments** (#917) — invalid or unplaceable inline PR review comments are surfaced instead of disappearing during review creation.

## [1.111.0] - 2026-07-07

### Added
- **Memory retrieval v2 is now operator-visible end to end** (#894, #915) — search can expand through linked memories, `memory-get` exposes links/backlinks, tagged memories and retrieval-source usefulness data flow through the APIs, and the dashboard memory panel now explains those metrics with clearer charts/tooltips.
- **Graceful-shutdown resumes now use the same same-agent pinning model as crash recovery** (#911) — paused work is reclaimed by the original stable-ID worker after restart, with a reaper escalation path to a Lead reroute decision when the agent never comes back.
- **Codex OAuth pool health is now actively hardened** (#914) — locked keep-warm refreshes can sweep all `codex_oauth_*` slots, refresh rejections surface actionable upstream auth errors, and boot-seeded worker auth files no longer carry live pool refresh tokens.

### Changed
- **The legacy GitHub Pages README mirror was removed** (#913) — the deleted `docs/` site and sync workflow no longer shadow `docs.agent-swarm.dev`, which is now the only maintained public docs surface.

### Fixed
- **Slack DM file uploads now reply into the visible DM tree** (#912) — task-scoped `slack-upload-file` uses the user-facing DM root when present instead of a hidden progress-message thread, while channel uploads stay attached to the original Slack thread.

## [1.110.0] - 2026-07-06

### Changed
- **Worker-image harness pins refreshed** (#909) — `Dockerfile.worker` now ships Claude Code `2.1.201`, Codex `0.142.5`, pi-coding-agent `0.80.3`, and opencode / `@opencode-ai/sdk` `1.17.13`.
- **Crash-recovery resumes pin to their own agent instead of the role-blind pool** (#911) — when the heartbeat detects a crashed worker, the `resume` task is now assigned back to the original stable-ID agent and reclaimed when it restarts instead of being released to the unassigned pool. A pin that is never reclaimed within `HEARTBEAT_RESUME_PIN_GRACE_MIN` (default 10 min) is escalated to a Lead-owned `task.reroute.decision` follow-up for explicit re-delegation.

## [1.109.0] - 2026-07-04

### Added
- **Dashboard task attachments now preview inline and render above session prompts** (#898, #900) — uploaded files are visible directly in the session timeline instead of being buried behind the lower attachment cards only.

### Fixed
- **Assigned workers now get a one-call attachment fetch recipe and local attachment previews keep the right MIME type** (#899) — task prompts include a direct `/api/fs/tasks/{taskId}/files/{attachmentId}/raw` download command, and `local-fs` persists the uploaded content type so inline previews render correctly.
- **Attachment cards in the dashboard no longer show empty shells or cancel active previews as easily** (#903, #905) — empty states are hidden and the preview loader is more resilient while files stream in.
- **Agent-fs provisioning no longer downgrades existing shared-drive members** (#904) — founder and executive swarm roles now provision as `editor`, and the native agent-fs seeder skips current members whose role is already equal or higher instead of overwriting them with a lower invite role.
- **Hosted-install telemetry now counts Swarm Cloud deployments correctly in the `is_cloud` cohort** (#901).

## [1.108.0] - 2026-07-03

### Added
- **Dashboard sessions can now create tasks with attached files and render those attachments in the drill-down sheet** (#895, #896) — the shared composer stages uploads, persists them after task creation, and shows the same task files inside both the sessions sheet and the full task detail page.
- **Agent-fs now has first-class provider-backed task attachment plumbing across API, worker, and dashboard flows** (#850) — shared-file provisioning, attachment resolution, and provider-backed download/delete paths now work cleanly for agent-authored files instead of only the old task-path upload layout.
- **Cloud app favorites and page slug routes landed in the dashboard** (#887) — operators can pin preferred cloud apps and use stable page slugs for shared routes.

### Changed
- **The dashboard, templates registry, and eval harness now live under `apps/*` in the monorepo** (#892) — build, Docker, CI, and repo docs all follow the new `apps/ui`, `apps/templates-ui`, and `apps/evals` layout.

### Fixed
- **Worker startup scripts now warn instead of crashing the worker by default after privilege drop** (#891) — per-agent setup failures log migration guidance and the pod keeps booting unless `STARTUP_SCRIPT_STRICT=true`.
- **GitHub workflow enqueues now use the GraphQL mutation path when classic auto-merge is disabled** (#890) — CI-triggered queueing stays aligned with the repo's merge-queue setup.
- **Pages can now serve video previews under the right CSP and Linear tracker tasks avoid duplicate context-key collisions** (#888, #886) — page media embeds load correctly and Linear-triggered follow-up tasks stay scoped to the right thread context.

## [1.107.0] - 2026-07-02

### Added
- **Tasks can now carry an explicit reasoning-effort level end-to-end** (#879, #883) — operators can set per-agent defaults while `send-task` and `task-action` can also persist `effort: off | low | medium | high | xhigh` directly on created tasks.
- **Schedules now support native execution targets** (#878) — a schedule can create an agent task, trigger a workflow directly, or launch a saved global script via `targetType`.

### Changed
- **Structural lint can now warn without blocking the rest of the quality gate** (#882) — the repo keeps the structural check visible while avoiding hard failures for warning-only findings.
- **Worker-image harness pins refreshed again** (#868) — the weekly Docker worker bump updates the bundled Claude Code, Codex, OpenCode, and pi-family versions.

### Fixed
- **Codex credential recovery is more stable under OAuth churn and empty-poll recovery** (#880, #881) — the runner now resets the credential poll deadlock path correctly and serializes per-slot refreshes to avoid refresh-token family revocation.
- **Memory, MCP session, and PM2 service boundaries were tightened** (#869, #870, #875) — `memory-get` now enforces ownership, owner MCP sessions reject mismatched `X-Agent-ID` headers, and `register-service` validates persisted PM2 launch metadata before saving it.
- **Worker privilege boundaries are stricter** (#865, #866) — setup-script updates are syntax-validated and audited, they run after privilege drop, and the worker image no longer grants blanket passwordless sudo.

## [1.106.0] - 2026-07-01

### Added
- **Saved scripts can now be exposed as external HTTP APIs** (#862) — swarm scripts can be published at `POST /api/x/script/<id>` with optional bearer auth, request-shape validation, usage tracking, and MCP management via `script-apis`.
- **Evals now cover orchestration substrate scenarios plus a gated UI flow** (#863, #853) — the eval harness gained broader orchestration coverage while the evals UI added a login gate for controlled access.

### Changed
- **Claude Managed Agents now default to `claude-sonnet-5`** (#861) — managed-agent setup, model registries, pricing metadata, and runtime selectors were updated for the new default.
- **The evals stack is easier to ship as a standalone service with refreshed June model configs** (#852, #860) — deployment and scenario config updates keep the eval environment aligned with the current model set.
- **Worker-image harness pins refreshed** (#868) — the weekly Docker worker bump updates Claude Code, Codex, OpenCode, and pi-family versions bundled into the worker image.
- **Environment-variable reference coverage expanded** — the docs now include missing heartbeat, workflow, script-runtime, provider, Jira, Composio, Pages, and UI dev-server settings plus corrected memory-rater variable names.

### Fixed
- **Codex loop detection now handles nested MCP args and low-cardinality ping-pong patterns correctly** (#856) — legitimate edit/test and `script-upsert`/`script-run` cycles no longer trip false-positive loop kills as early.
- **Evals infra reliability issues were tightened up across TLS, health checks, and registry cache refreshes** (#854, #855, #864) — Turso TLS bootstrap, Docker healthcheck quoting, and registry cache revalidation all fail less often.
- **Worker and setup-script privilege boundaries were hardened** (#865, #866) — per-agent setup scripts now run after privilege drop, accepted setupScript updates are syntax-validated and audited, and the worker image no longer grants blanket passwordless sudo.
- **MCP, register-service, and harness-provider security guardrails were tightened** (#869, #870, #872) — owner MCP sessions are bound to the initializing `X-Agent-ID`, PM2 service configs are validated before persistence, and harness fallback now considers available credentials instead of defaulting unconditionally to Claude.
- **Evals runs, artifacts, checks, and transcripts are more reliable and easier to inspect** (#871, #873, #876) — startup reconciles orphaned eval runs, log artifacts load through the authenticated UI helper, check descriptions are clearer, and transcripts surface final attempt outcomes plus provider-specific tool inputs.

## [1.105.0] - 2026-06-30

### Added
- **Agent Swarm now emits OTLP session cost and token metrics for every harness** (#817) — finalized session-cost records export cumulative `agentswarm.cost.usd` and `agentswarm.tokens` counters alongside the existing traces.
- **A DORA metrics community template now ships with the repo** (#848) — teams can seed a weekly DORA report playbook and schedule without building the reporting workflow from scratch.

### Changed
- **Schedule mutation gates are now relaxed for registered agents** (#847) — `update-schedule` and `delete-schedule` no longer require creator-or-lead ownership when a registered agent needs to manage an existing schedule.

### Fixed
- **Heartbeat reboot sweeps no longer cancel pre-boot stale sessions** (#846) — the concurrency-safe guard stops false crash-recovery cleanups during startup races.
- **Page exports now render full server-side PDFs** (#840) — page PDF generation keeps the complete document instead of truncating exported output.
- **Authed iframe launches now wait for the page session to be ready** (#839) — the UI avoids racing iframe startup before the backing page is available.
- **Script connection audit writes now avoid agent IDs in user audit foreign keys** (#841) — credential-binding and script-connection mutations persist canonical user attribution cleanly.

## [1.104.0] - 2026-06-29

### Added
- **Scripts credential bindings now broker outbound auth without exposing raw secrets** (#830) — scripts can use allowlisted header or query placeholder substitution instead of embedding credentials in source or arguments.
- **Scripts can now register typed OpenAPI connections** (#838) — lead-managed script connections generate `ctx.api.<slug>` clients and can attach approved credential bindings for authenticated API calls.
- **Memory recall now supports hybrid retrieval plus in-place editing** (#829) — agents can enable reciprocal-rank-fusion memory search and correct an existing memory without losing its ID or history.

### Changed
- **Scripts credential bindings now live-reload on MCP config mutations** (#837) — global config edits made through MCP tools trigger the same integration reload path as the HTTP config route, so runtime flags and broker changes apply immediately.
- **Worker-image harness pins refreshed** (#836) — the weekly Docker worker bump updates the bundled Claude Code, Codex, and OpenCode harness versions.

## [1.103.0] - 2026-06-27

### Added
- **Workers can now opt into per-repo git-hook bootstrap** (#828) — repo records accept `hooks: { enabled: true }`, the worker image bundles `install-repo-hooks.sh`, and runners invoke it after clone/refresh so repository-local hooks can be installed automatically.
- **Telemetry now covers deeper runtime lifecycle signals** (#826) — workers and schedulers emit session-cost, compaction, workflow, schedule, and provider-session completion/failure events in addition to the existing task lifecycle baseline.
- **A Code Health Reports community template now ships with the repo** (#823) — operators get a seeded community-report template out of the box instead of having to author the first version from scratch.

### Fixed
- **Runner startup no longer risks a `runningTask` TDZ during `session_init`** (#827) — provider sessions can initialize without tripping an internal runner crash during early event handling.
- **Provider stderr now persists in streamed session logs** (#824) — raw stderr events are buffered and flushed alongside normal provider log lines so debugging data is retained in task/session logs.
- **Codex edit bursts no longer trip false-positive loop detection as easily** (#821) — low-cardinality `Edit`/`Write`/`Delete` file-change batches now require a higher repeat threshold before the hook blocks the session.
- **Auto-cloned repos now hard-sync clean default branches before task execution** (#825) — worker checkouts recover more reliably from stale local branch state when reusing clean auto-cloned repositories.

## [1.102.0] - 2026-06-26

### Added
- **Scripts, workflows, and schedules now record canonical user audit attribution** (#810) — create and update flows now populate `created_by` / `updated_by` when a trusted human requester exists, covering MCP and HTTP paths while leaving pure automation writes nullable.
- **A new `taste-minimalist-skill` now ships in the default page-design seed set** (#816) — page-generation templates now include a reusable minimalist taste baseline plus the bundled license artifact for seeded skills.

### Changed
- **GitHub Pages docs now ship a first-class landing page and landing-site styling** (#814, #815) — the synced README site now has branded layout/CSS, icons, and a Pages publishing flow that matches the main landing experience more closely.

### Fixed
- **Audit-user resolution for script/workflow/schedule writes is now server-trusted instead of header-spoofable** (#810) — `X-Source-Task-Id` only contributes a requester when the named task belongs to the calling agent, and authenticated HTTP users take precedence for audit stamping.

## [1.101.1] - 2026-06-25

### Changed
- **Worker-image harness pins refreshed** (#809) — `Dockerfile.worker` now ships Claude Code `2.1.187`, Codex `0.142.0`, OpenCode `1.17.9`, and pi `0.80.2`, plus the corresponding `pi-ai` `0.80` API migration updates.

### Fixed
- **Published CLI package now works cleanly through `npx`** (#804) — the npm package now ships a built `dist/cli.js` entrypoint with a Node shebang, so `npx @desplega.ai/agent-swarm ...` runs the same commands without requiring Bun to execute the published bin.
- **Slack message extraction now keeps all text layers instead of truncating at the first summary** (#807) — `extractSlackMessageText()` now combines top-level text, legacy attachment bodies/fields/actions, and Block Kit content with exact-match dedup, so alert-style Slack threads preserve the real diagnostic payload for agents.

## [1.101.0] - 2026-06-22

### Added
- **`codex-login` accepts credential slots above 9** (#802) — the slot ceiling (`MAX_SLOT`) was raised from 9 to 31, so operators can register more than 10 Codex OAuth credentials in the sandbox pool. The rest of the stack (storage-key regex, runner enumeration, api-keys endpoint) was already unbounded; this removes the only enforced limit.

### Fixed
- **`swarm-script` workflow nodes can trigger workflows (and other fall-through MCP tools) again** (#801) — `trigger-workflow` was returning a 403 because `mcp-bridge.ts` checked the MCP tool name against the SDK method-name set. A new `isMcpToolAllowedForScripts()` check matches against MCP names, also unblocking `slack_post`, `page_create`, `schedule_*`, and other previously-403ing tools. A latent arg-name drift (`workflow_trigger` typed as `{ id; input? }` while the tool reads `triggerData`) was fixed and the generated SDK type defs regenerated.

## [1.100.4] - 2026-06-20

### Fixed
- **`swarm-script` workflow args now preserve exact-token JSON types without leaking cross-scope values** (#798, #799) — `config.args` entries written as a single token such as `{{input.payload}}` now keep native object/array/number/boolean shapes instead of stringifying them, while mixed strings still interpolate as strings and raw token resolution stays scoped to the node's local interpolation context during retries and fan-out.

## [1.100.3] - 2026-06-19

### Added
- **Memory retrieval rows now carry grouping metadata** (#780) — `memory_retrieval` records now capture a stable `retrievalId` plus per-result rank so downstream raters and analytics can group one search/get fan-out into a coherent retrieval event.

### Fixed
- **Slack auto-join now preserves the info-failure fallback while still blocking external Slack Connect channels** (#790, #792) — public internal channels still auto-join on demand, but external/shared channels now return an explicit invite-required error and a `conversations.info` failure no longer disables the original join-and-retry fallback.
- **Assistant-side Slack co-mentions no longer spawn accidental tasks** (#784) — assistant-thread messages that only mention another user are ignored unless they also mention the swarm bot, preventing side conversations from triggering lead work.
- **GitHub review tasks now include inline review comments instead of dropping body-less reviews** (#788) — submitted PR reviews fetch and append inline comments with file/line context, and large review bundles are paginated so all comments reach the worker task.
- **Claude Bridge only activates with OAuth and now preserves transcript-backed metrics again** (#789) — `SWARM_USE_CLAUDE_BRIDGE=true` now requires `CLAUDE_CODE_OAUTH_TOKEN` (otherwise the adapter falls back to stock `claude`), and the worker image pins `@desplega.ai/claude-bridge` `0.2.2` so Claude's transcript stays enabled for cost/token/event reconstruction.

## [1.100.0] - 2026-06-17

### Added
- **Configurable wall-clock timeout for `swarm-script` workflow nodes** (#776) — workflow authors can now set `config.timeoutMs` between 1s and 60s, with schema validation plus runtime enforcement aligned to the scripts-runtime wall-clock budget and CPU-time ceiling.

### Changed
- **Worker-image harness pins refreshed** (#772) — `Dockerfile.worker` now ships Claude Code `2.1.178`, pi-mono `0.79.4`, Codex CLI / SDK `0.140.0`, and opencode / `@opencode-ai/sdk` `1.17.7`.

### Fixed
- **OAuth keepalive refresh is awaited during shutdown** (#774) — shutdown now waits for the keepalive refresh path to finish so Jira webhook lifecycle cleanup and related finalization work do not race process exit, and the Slack alert path now requires an explicitly configured channel.
- **Task lifecycle telemetry emits the missing transition events again** (#773) — lifecycle updates now record the missing telemetry edge so downstream observability and reporting stay aligned with real task state changes.

## [1.99.0] - 2026-06-15

### Added
- **Memory recall-edge capture layer (Phase 1)** (#767) — `memory-search` and `memory-get` now require an explicit `intent`, retrieval events are recorded for both search and get flows, and the memory subsystem can resolve typed links to external artifacts such as GitHub PRs and agent-fs paths.
- **E2B-backed eval harness sub-project** (#737) — the new `evals/` package runs scenario × harness-config matrices against real swarm stacks, stores results in a Turso-backed libsql replica, captures transcripts and artifacts, and grades attempts with deterministic checks plus optional LLM or agentic judges.

## [1.98.1] - 2026-06-14

### Changed
- **Worker image now pins opencode CLI and SDK `1.17.4`** (#761) — the default worker build picks up the upstream opencode fixes for tool-result passthrough, better session recovery after context overflow, MCP abort handling, and clearer surfacing of content-filtered responses.

### Fixed
- **Session-end profile sync no longer overwrites lead-side profile edits** (#763) — local-harness sessions now record baseline hashes for `SOUL.md`, `IDENTITY.md`, `TOOLS.md`, `HEARTBEAT.md`, and `CLAUDE.md` at start-up, then skip unchanged files during the final FS → DB sync so `update-profile` changes made by the lead survive until the agent actually edits those files.

## [1.96.0] - 2026-06-12

### Added
- **pi-mono Bedrock mode now does real AWS probing with account-accurate model enumeration** (#738, #744) — workers can activate Bedrock SDK mode explicitly or from an `amazon-bedrock/*` model, classify AWS credential failures before task execution, and surface the exact Bedrock models the account can invoke in-region, including inference-profile-only Claude models.
- **Generic MCP OAuth authorize-request extras** (#739) — MCP server definitions can now attach provider-specific `extraAuthorizeParams` such as `access_type=offline` and `prompt=consent` without bespoke server code, while reserved OAuth parameters remain protected from override.

### Changed
- **Skill bundles now sync across local harness filesystems** (#740) — the worker mirrors the installed skill set into Claude, pi-mono, Codex, opencode, and shared `.agents` directories, and refreshes the bundled `agent-fs` CLI to `0.7.5`.
- **Docker release notifications now carry the resolved package version end-to-end** (#742, #746) — the image publish workflow notifies Swarm Cloud with the release version instead of only commit-derived context, keeping downstream release records aligned with package tags.
- **Persisted logs and task text get broader secret scrubbing coverage** (#743) — runtime-fetched config secrets are now registered for redaction, and more token patterns are scrubbed before session logs, task progress, outputs, and failures hit the database.

### Fixed
- **Slack watcher restart state is durable** (#727) — tracked Slack thread messages survive restarts, preventing duplicate task creation or duplicate completion chatter after a reboot.
- **pi-mono Bedrock runtime errors surface as structured failure categories** (#731) — AWS SDK failures now preserve actionable auth/access/throttle/model diagnostics instead of collapsing into vague runtime errors.
- **Workflow property-match aliases resolve correctly again** (#734) — compatible alias forms for property-match inputs no longer fail validation during workflow execution.
- **Boot-time historical log scrubbing avoids false candidate matches** (#745) — the one-time scrubber now chooses rows and token boundaries more precisely, reducing accidental misses and over-matches.

## [1.95.0] - 2026-06-11

### Added
- **First-class Bedrock auth mode for pi-mono** (#738) — pi-mono can now use Bedrock credentials directly and probe credential availability so AWS runtime/auth failures are surfaced before a task gets deep into execution.
- **Generic extra MCP OAuth authorize parameters** (#739) — MCP OAuth connections can now pass provider-specific `extraAuthorizeParams` through the authorize flow without one-off server code for each provider.
- **Skill sync across harnesses with agent-fs 0.7.5** (#740) — runtime skill bundles now sync across harness environments, and the bundled agent-fs version is refreshed for the latest shared-filesystem behavior.

## [1.94.0] - 2026-06-11

### Added
- **Portable model tiers across tasks, schedules, workflows, and UI** (#719) — task authors can now express provider-agnostic intent with `modelTier` (`smol`, `regular`, `smart`, `ultra`), while each worker resolves that tier to a concrete model at claim time based on its harness/provider and local overrides.
- **Memory rating nudges in retrieval responses** (#724) — `memory-search` and `memory-get` now return task-context-aware `rateHint` guidance so agents can immediately call `memory_rate(...)` on useful or misleading memories.
- **Non-blocking embeddings on worker boot** (#716) — startup no longer stalls on embeddings-related work, reducing time-to-ready for worker sessions.

### Changed
- **Claude Bridge pin and worker-image defaults refreshed** (#730, #721, #718, #712) — `Dockerfile.worker` now pins `@desplega.ai/claude-bridge` `0.1.12` and ships Claude Code `2.1.170`, pi-mono `0.79.1`, Codex CLI `0.139.0`, and opencode / `@opencode-ai/sdk` `1.16.2`.
- **Bundled pricing and model-selector metadata refreshed** (#713, #720, #717, #733) — the built-in pricing registries were resynced, pinned models.dev entries are preserved during refreshes, and the UI now exposes Claude Fable 5 alongside the updated model catalog.

### Fixed
- **Slack tools now auto-join public channels on `not_in_channel`** (#710) — `slack-read`, `slack-post`, `slack-reply`, and `slack-start-thread` join public channels and retry once instead of failing outright; private channels now return a clear `/invite` instruction.
- **Slack watcher restart dedupe is durable** (#727) — Slack watcher message tracking now persists across process restarts so already-seen messages are not recreated as fresh tasks after a worker/API restart.
- **Workflow property-match input aliases resolve correctly** (#734) — workflow validation now accepts the intended property-match input aliases instead of rejecting compatible route-porting shapes.
- **Worker runtime failures are easier to diagnose and less noisy** (#723, #715, #731) — skill-sync permission issues are corrected at boot, credential selection is model-aware, session logs include better harness metadata, task failures now surface the Claude Bridge pane tail, and pi-mono/Bedrock AWS SDK failures emit structured categories instead of being laundered as empty success.

## [1.93.0] - 2026-06-10

### Added
- **Per-task harness variant capture and task-detail badge** (#699) — workers now record which harness variant actually executed a task (for example `claude` stock vs bridge, plus provider version metadata), and the dashboard surfaces that directly on the task detail view for faster debugging.
- **`fable` model shortname across task and schedule entry points** (#709) — `send-task`, `task-action`, and schedule creation/update flows now accept `fable`, with provider-specific mappings, pricing, and context-window sizing wired in.
- **Script-runtime GitHub egress substitution** (#708) — sandboxed scripts can now call allowlisted GitHub endpoints using the default `GITHUB_TOKEN` flow without exposing the raw secret value to the script itself.
- **Worker image ships optional PostgreSQL 16 tooling** (#702) — `Dockerfile.worker` now includes PostgreSQL 16 binaries and an entrypoint-backed `scripts/init-local-postgres.sh` helper for opt-in local database bootstrapping inside worker containers.

### Changed
- **Worker-image harness pins refreshed** (#712) — `Dockerfile.worker` now ships Claude Code `2.1.170`, pi-mono `0.79.1`, and Codex CLI / SDK `0.139.0` (opencode / `@opencode-ai/sdk` stay at `1.16.2`).
- **Bundled model pricing metadata refreshed** (#701, #713) — the daily models.dev syncs updated the built-in pricing data that powers model-cost lookups and related guidance.

### Fixed
- **Slack tools now auto-join public channels** (#710) — `slack-read`, `slack-post`, `slack-reply`, and `slack-start-thread` recover from `not_in_channel` by joining the public channel and retrying, instead of failing; private channels surface a clear "invite the bot with `/invite` first" error. The bundled `slack-manifest.json` now includes the `channels:join` bot scope.
- **Codex credential pools now fail over across key types** (#706) — when one Codex credential source is exhausted, the runner can fall back between `OPENAI_API_KEY` and `codex_oauth_*` pools instead of reusing a known-rate-limited slot, and successful tasks clear stale rate-limit marks.
- **Worker skill refresh now writes to the worker filesystem safely** (#707) — runtime skill refreshes now write managed `SKILL.md` bundles to the local worker disk and avoid wiping the skill cache on transient list-fetch failures.

## [1.92.2] - 2026-06-09

### Added
- **`compound-insights` now reports script usage and spend snapshots** (#695) — the global script now distinguishes authoritative `script_runs` totals from MCP-call log signals, adds per-script run metrics, and surfaces cost/token honesty rails in the same operational report.

### Changed
- **Worker-image harness pins refreshed** (#698) — `Dockerfile.worker` now ships Claude Code `2.1.168`, pi-mono `0.78.1`, Codex CLI / SDK `0.137.0`, and opencode / `@opencode-ai/sdk` `1.16.2`.
- **Bundled model pricing metadata refreshed** (#692) — the daily models.dev sync updated the built-in pricing data that powers model-cost lookups and related guidance.

### Fixed
- **Dependent tasks now cascade-fail on upstream non-success terminal states** (#697) — tasks that depend on a failed, cancelled, or superseded parent no longer stay blocked forever; the system now recursively marks them failed with a descriptive reason and reports the impact in the lead follow-up.
- **Memory search reranking now filters noise and respects source quality** (#696) — memory retrieval now applies source-aware recency, a minimum similarity floor, response-side embedding-dimension validation, and protected manual-memory handling so relevant memories outrank recent noise.

## [1.92.1] - 2026-06-07

### Added
- **Complex skill file foundation** (#680) — skills can now store bundled reference files in the database, sync those files into local provider skill directories, expose file CRUD over `/api/skills/{id}/files*`, and let agents fetch bundled references on demand via the new `skill-get-file` MCP tool.

### Changed
- **Bundled model pricing metadata refreshed** (#682) — the daily models.dev sync updated the built-in pricing data that powers model-cost lookups and related guidance.

### Fixed
- **Memory KNN queries now cap `k` and purge expired rows first** (#684) — oversized nearest-neighbor requests no longer overrun the memory index path, and expired rows are cleaned before search to keep recall stable.

## [1.92.0] - 2026-06-05

### Added
- **Durable script workflow runs** (#653, #656, #657, #659, #663) — script workflows can now run in the background with persisted runs, journaled step state, dashboard visibility, and three new MCP tools: `launch-script-run`, `get-script-run`, and `list-script-runs`.
- **Salesforce Hosted MCP Server setup guide** (#660) — the docs now include an end-to-end Salesforce OAuth guide covering External Client App setup, required `mcp_api` scopes, manual client registration, and common redirect / scope pitfalls.

### Changed
- **Claude Bridge toggle for the Claude harness** (#664) — `SWARM_USE_CLAUDE_BRIDGE=true|1` now routes spawned Claude sessions through the installed `claude-bridge` binary from pinned package `@desplega.ai/claude-bridge@0.1.8`, a Desplega-owned `claude -p` drop-in that drives interactive Claude Code through `tmux` for subscription-pool runs. The env is reloadable via `swarm_config`; `false|0|unset` keeps the normal `CLAUDE_BINARY` path.
- **Legacy Claude bridge binaries are now a deprecated compatibility path** (#664) — existing direct `CLAUDE_BINARY` bridge deployments keep working, including tmux fail-fast and trust pre-seed behavior, but now emit a deprecation warning pointing operators to `SWARM_USE_CLAUDE_BRIDGE=true`. Docs and runbooks now recommend claude-bridge.
- **Codex credits-exhausted cooldown is operator-tunable** (#668) — the dedicated cooldown for workspace-credits-exhausted Codex OAuth slots now resolves from `swarm_config`, validates strictly, and updates live without restarting workers.

### Fixed
- **Slack thread reads now include attachment-only and Block Kit-only roots** (#658) — `slack-read` and worker thread-context extraction now recover text from alert-style Slack payloads, so Datadog / PagerDuty / GitHub threads no longer appear empty to the swarm.

## [1.90.0] - 2026-06-03

### Added
- **`x` command + `swarm_x` Composio bridge** — Agent Swarm now exposes a thin external-route surface for approved third-party operations. Humans can run `agent-swarm x composio ...`, agents can call `swarm_x`, and the docs now cover the shared workflow.
- **Config-driven metrics dashboards** (#626) — operators can define read-only SQL dashboards, version them, and render them in the UI without shipping bespoke frontend code. Includes the `create_metric` MCP tool and the metrics definitions HTTP surface.
- **Attio integration card + bundled interaction skill template** (#632) — the integrations catalog now exposes Attio alongside a reusable skill template for CRM record/query workflows.

### Changed
- **Requester profile guidance now propagates into task prompts** (#628) — when a canonical user has a `role` or `notes`, the runner injects a `Requester Profile` section so agents can match tone and depth without weakening task or safety constraints.
- **GitHub task cancellation is runtime-configurable** (#634) — PR/issue unassign and review-request-removal events still cancel linked tasks by default, but each behavior can now be disabled independently through `swarm_config`.
- **User-token attribution now survives REST task/workflow entry points** (#621) — REST-authenticated calls carry canonical-user attribution through task creation and downstream workflow execution for better auditability and requester-aware behavior.

### Fixed
- **Heartbeat can dispatch auto-assigned pool tasks correctly** (#622) — crash recovery no longer misses work that was auto-assigned from the pool before the heartbeat sweep.
- **Heartbeat crash-recovery resume loops now stop cleanly** (#637) — the heartbeat supersede/resume path now respects the generation budget and avoids the race that could create duplicate resume attempts.

### Added
- **System-default `swarm-scripts` skill + bundled templates in Docker images** (#614) — the repo now ships a built-in scripts skill/decision rubric as a system-managed default, and both `Dockerfile` and `Dockerfile.worker` copy `templates/` into the image so those defaults are present in compiled deployments.
- **Context-mode tools on all local coding harnesses** (#599) — Claude Code, Codex, and opencode workers now advertise the `ctx_*` context-mode MCP tools by default, giving every local harness the same compressed-search / fetch-and-index workflow. `CONTEXT_MODE_DISABLED=true` remains the per-worker escape hatch.
- **E2B dispatch CLI** (#574) — new `agent-swarm e2b` subcommands build/publish templates and start API or worker sandboxes on demand for CI and Dockerless smoke-test workflows.
- **E2B swarm lifecycle CLI v1** (#601) — `agent-swarm e2b` now covers grouped swarm operations end-to-end: interactive/headless `start-stack` launches an API, a lead, and N workers; `e2b swarms list|info|kill|add|logs` manages those groups by slug; `e2b extend` resyncs live TTLs; and role-scoped `--api|lead|worker-{env-file,secret}` flags layer per-role runtime config on top of shared env.
- **Codex subprocess session runner** (#581) — Codex tasks now execute inside a throwaway `codex-session-runner` child process that receives config over stdin and streams structured events/results back over stdout, isolating `@openai/codex-sdk` state to one task at a time and keeping the long-lived worker runner's heap flat.
- **Universal follow-up context preamble across all harnesses** (#567) — child tasks now receive a bounded parent-context summary before execution, so follow-up continuity works on non-resumable providers (`pi`, `opencode`, `devin`) as well as resumable ones. The immediate parent contributes task/output/artifact detail, older ancestors are pointer-only, and `CONTEXT_PREAMBLE_MAX_TOKENS` caps prompt growth.
- **Native Kapso / WhatsApp integration** (#560) — Agent Swarm now supports native inbound WhatsApp routing via Kapso. Lead-only `register-kapso-number` / `unregister-kapso-number` MCP tools provision number routing through the swarm's native webhook, inbound messages are verified and deduped before creating `kapso-inbound` tasks or dispatching workflows, and new `send-whatsapp-message` / `reply-whatsapp-message` MCP tools cover the common outbound text path while the `kapso-whatsapp` skill handles templates, media, and reactions.
- **User-facing MCP token flow for canonical users** (#536) — operators can now mint one-time plaintext MCP tokens for a user, revoke them later, and manage the flow through the People/user registry surface. This adds the user-token API routes and makes the canonical-user model usable for end-user MCP auth flows.
- **Per-task skill hot-reload across local harnesses** (#555) — between tasks the worker polls a cheap `GET /api/agents/:id/skills/signature` endpoint and only re-syncs `~/.claude/skills/`, `~/.pi/agent/skills/`, and `~/.codex/skills/` when the installed-skill set has actually changed. Newly installed / uninstalled skills now appear on the next task without restarting the worker. Foreign skills (`SKILL.md` files not owned by the swarm) are preserved across re-syncs; sync failures retry on the next tick instead of blocking the runner. New `src/utils/skills-refresh.ts` extracts the refresh helper from the runner. The `claude-managed` provider is unaffected — sessions run in Anthropic's sandbox and skills are uploaded out-of-band.
- **Integrations UI: `AGENTMAIL_API_KEY` required on AgentMail card** (#547) — the AgentMail integration card in the dashboard now declares `AGENTMAIL_API_KEY` as a required config field so operators can wire AgentMail through the standard integrations flow instead of editing env files.
- **Pointer-based task attachments + Slack/UI relay (Phase 1 + 2a)** (#537, #540, #542, #545) — agents can attach pointer-based artifacts (agent-fs paths, URLs, shared-fs paths, swarm Pages) to a task via `store-progress`. Migration 072 adds the `task_attachments` table (agent_tasks untouched — joined at read time in `get-task-details`); 073 adds nullable `agent_fs_org_id` / `agent_fs_drive_id` so agent-fs attachments resolve to `${AGENT_FS_LIVE_URL}/file/~/<org>/<drive>/<path>` live URLs. `store-progress` now also auto-resolves missing `orgId` / `driveId` on `agent-fs` attachments from the new `AGENT_FS_DEFAULT_ORG_ID` / `AGENT_FS_DEFAULT_DRIVE_ID` swarm-config keys (scope precedence: agent > global) — per-row IDs always win, and the `constants.ts` env-var fallback stays as a secondary path for self-hosters without a config DB. `store-progress` accepts up to 20 attachments per call (any call — progress or completion); appends are append-only with sha256 dedup (falls back to `(kind, pointer, name)` tuple). Slack rendering covers both the DM/untracked `buildCompletedBlocks` path AND the dominant tree-message `updateTreeMessage` → `buildTreeBlocks` path (capped at 10 attachments per tree message with a `… and M more …` context footer to stay inside Slack's 50-block / 40 KB limits). UI mirrors the resolver through `import.meta.env.VITE_AGENT_FS_*`.
- **`send-task` + `resolve-user`: requestedByUserId inheritance, externalIds in response, userId lookup** (#538) — `send-task` accepts `requestedByUserId` and auto-inherits it from the caller's current task so the original human's identity flows through multi-hop lead → worker → child delegations (lets a child running `gh pr create --assignee` resolve the GitHub handle). `resolve-user` now accepts `userId` as a third alternative to `{kind, externalId}` and `email`, and the response includes `externalIds: Array<{kind, externalId}>` so callers can reverse-look up platform handles from a canonical user ID.
- **Codex OAuth multi-credential pool** (#517) — `src/commands/codex-login.ts` + `runner.ts` support a pool of Codex OAuth credentials so multiple Codex-provider workers can share a rotating credential pool instead of all colliding on a single auth slot. Useful when running fleet-scale Codex workers under one ChatGPT account.
- **Seed catalog with 10 built-in global scripts** (#519) — `package.json` ships a curated set of 10 swarm-shared TypeScript scripts seeded into the catalog on first boot so the `script-search` / `script-run` MCP surface is non-empty out of the box. Authors of new global scripts can extend the seed list rather than starting from scratch.
- **Filter-aware pagination + generic `get-metrics` endpoint** (#530) — list endpoints now compute `total` against the same filter set as the result page (instead of the unfiltered table), so dashboard pagination is accurate when filters are active. New generic `get-metrics` MCP tool + `/api/metrics` route exposes ad-hoc swarm metrics without needing per-shape endpoints; see `src/tools/get-metrics.ts` for the supported metric keys.
- **OTel: `http.route` attribute, nested API child spans, split `service.name`, HTTP semconv attrs, named MCP tool spans** (#528, #531, #535) — API request spans are now named by route template (`GET /api/tasks/:id`) instead of a hardcoded `http.server`, with nested child spans per API handler. `resolveServiceName()` splits the per-role `service.name` so API / worker / MCP processes don't collapse onto a single `agent-swarm` service in SigNoz (#535 pins the resource detectors to `host`/`os`/`process` — dropping `envDetector` — so `OTEL_SERVICE_NAME` from a shared env doesn't silently overwrite the explicit per-role value). Adds the standard OTel HTTP server semconv attrs (`server.address`, `url.scheme`, `network.protocol.version`, `user_agent.original`) and names server-side MCP tool spans `mcp.tool <tool-name>` for readability in the trace tree. Cardinality stays bounded (tool names are a fixed enum).
- **Link Claude Code spans into worker trace via `TRACEPARENT`** (#516) — the worker now propagates a W3C `traceparent` header into the Claude Code subprocess so Claude Code's own spans nest under the worker task span in SigNoz/Jaeger. End-to-end trace coverage now spans MCP tool call → worker task → Claude Code internals in a single trace tree.

- **Humans as first-class users + People page redesign** (#500) — major refactor landing the canonical user-identity surface. Migration 064 adds `user_external_ids` (PK `kind+externalId`), `user_tokens` (with `tokenPreview`), and `user_identity_events` (10-type CHECK enum), plus new `users` columns `metadata`, `dailyBudgetUsd`, `status`. Drops the four inline-UNIQUE identity columns (`slackUserId` / `linearUserId` / `githubUsername` / `gitlabUsername`) — payloads using the old field names now fail Zod validation at runtime (no compatibility shim). New `src/be/users.ts` exposes the API-side identity helpers (`find{ById,ByExternalId,ByEmail}`, `findOrCreateUserByEmail`, `linkIdentity` / `unlinkIdentity`, `mintToken` / `revokeToken` / `resolveUserByToken`, `recordIdentityEvent`, `fingerprintApiKey`) — every mutating helper wraps the row update + event emission in a `db.transaction`. Slack, GitHub, GitLab, Linear, and AgentMail webhook handlers are rewired to the new surface; unmapped senders are recorded under `integration:unmapped:<provider>` in the kv store (`:meta` + `:count`, 30-day TTL) so operators can triage them on the People → Unmapped tab. `manage-user` / `resolve-user` MCP tools now take `identities: [{kind, externalId}]` declaratively (update path computes the diff and emits `identity_added` / `identity_removed`); email-alias edits emit `email_added` / `email_removed`. New `aswt_<base62>` token shape is secret-scrubbed end-to-end.
- **UI: filter sessions list by active user** (#518) — sessions shell exposes a user filter so the dashboard sessions list can scope to a single canonical user across all their identities. Adds the query parameter to `useSessions` + the underlying `GET /api/sessions` route; covered by `src/tests/sessions.test.ts`.
- **CI: fail PRs with a DB migration numbering conflict** (#520) — new `.github/workflows/migration-conflict-check.yml` runs `scripts/check-migration-conflicts.sh` on every PR so two branches that both author `NNN_*.sql` with the same number can't silently land and overwrite each other on `main`.
- **Reusable scripts runtime — `script-*` MCP tools + `swarm-script` workflow node** (#493) — swarm-shared TypeScript script catalog callable across agents and from workflows. Five new MCP tools: `script-search`, `script-run`, `script-upsert`, `script-delete`, `script-query-types`. Runtime evaluates user-supplied TS in a sandboxed `Bun.spawn` subprocess wrapped in `ulimit -v 524288 -t 60 -u 32 -f 65536 -n 64`, 30s AbortController, 1 MB stdout cap. Agent identity + bearer flow as a JSON `SwarmConfigPayload` over the subprocess **stdin** — not env vars; bearer wrapped in `Redacted<string>`. SDK surface derived from the MCP tool registry at build time via `scripts/bundle-script-types.ts` against a curated allowlist (`src/scripts-runtime/sdk-allowlist.ts`). `script-upsert` runs `tsc --noEmit` against generated `.d.ts` and rejects on diagnostics; inline `script-run` skips typecheck. v1 supports `fsMode: 'none'` (per-run tmpdir) only — `'workspace-rw'` returns 501. API server owns the `scripts` + `script_versions` tables; workers + runtime invoke via HTTP.
- **`argsSchema` convention for the scripts catalog** (#505) — a script may export a Zod schema named `argsSchema`; on `script-upsert` the runtime extracts it, converts it to JSON Schema via `zod`'s `toJSONSchema`, and stores it on the catalog entry as the new `argsJsonSchema` field so callers can discover a script's argument shape before running it. The export is optional — scripts without it get a `null` `argsJsonSchema`. Adds migration `066_scripts_args_json_schema.sql`.
- **`GET /api/memory/{id}` and `GET /api/schedules` REST endpoints** — fetch a single memory by ID, and list schedules with `enabled` / `name` / `scheduleType` / `hideCompleted` query filters.
- **OpenTelemetry tracing** (#488) — API, worker, MCP, and tool execution spans exported via OTLP. Disabled unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Works with SigNoz Cloud, self-hosted SigNoz, Jaeger (via OTLP collector), Honeycomb, Grafana Tempo, and any other OTLP-compatible backend. New env vars: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` (secret-scrubbed), `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_TRACE_POLL`. Full guide at [`/docs/guides/observability-opentelemetry`](/docs/guides/observability-opentelemetry).
- **`OTEL_TRACE_POLL` flag to gate poll-loop spans** (#492) — `worker.poll` and `/api/poll` spans are now off by default; set `OTEL_TRACE_POLL=1` to re-enable. Reduces span volume by ~90% on idle workers. Same PR also fixes the SigNoz Cloud endpoint docs — use the regional base URL (e.g. `https://ingest.eu2.signoz.cloud`); the SDK appends `/v1/traces`.
- **Legacy bridge `CLAUDE_BINARY` support is now first-class** (#482) — the existing-but-undocumented `CLAUDE_BINARY` env var is formalized for alternate Claude CLI argv prefixes that drive `claude` interactively in `tmux` to keep swarm runs on the Max/Pro subscription credit pool after Anthropic's 2026-06-15 programmatic-credit split. Accepts a single binary, an absolute path, or a whitespace-separated command string; whitespace-split into argv tokens before the swarm appends the usual claude flags. New `parseClaudeBinary` and `resolveClaudeBinary` helpers in `src/providers/claude-adapter.ts`. Reloadable via `swarm_config` overlay (precedence: repo > agent > global > env > `claude`) so operators can flip a worker via `set-config CLAUDE_BINARY=...` without a container restart. Fail-fast `Bun.which("tmux")` check for legacy bridge binaries. Pre-seeds `~/.claude.json` (`projects[cwd].hasTrustDialogAccepted = true`) at session-create so the first-run trust dialog doesn't hang the tmux pane. User-facing guide moved to [`/docs/guides/claude-bridge-experimental`](/docs/guides/claude-bridge-experimental); engineering notes in `runbooks/harness-providers.md`.
- **`tmux` apt-installed in `Dockerfile.worker`** (#482) — ships in the worker image by default so tmux-backed Claude bridge commands work out of the box. Single apt list addition, same `RUN` block — no new layer.

### Changed
- **Context-mode nudges fire earlier and match real tool names** (#615) — local coding harness prompts now steer agents toward `ctx_execute` / `ctx_batch_execute` after every 3 qualifying external MCP calls instead of 10, and the Claude MCP server key now matches the hook guidance so the suggested `ctx_*` tools are the same names agents can actually call.
- **Runner refresh is now non-destructive on dirty repos** (#617) — when a task reuses an already-cloned repo with local changes, the runner auto-stashes that work before refreshing from `origin/<defaultBranch>` and surfaces the resulting `swarm-autostash` refs in the composed prompt so agents can restore them explicitly if needed.
- **Worker harness pins refreshed** (#610) — `Dockerfile.worker` now ships Claude Code `2.1.158`, pi-mono `0.78.0`, Codex CLI / SDK `0.135.0`, and opencode / `@opencode-ai/sdk` `1.15.13`.
- **Worker harness pins refreshed** (#583) — `Dockerfile.worker` now ships Claude Code `2.1.154`, pi-mono `0.76.0`, Codex CLI / SDK `0.135.0`, and opencode / `@opencode-ai/sdk` `1.15.12`.
- **Helm chart version sync is scripted and CI-guarded** (#578) — new `bun run sync-chart-version` and `bun run check-chart-version` commands keep `charts/agent-swarm/Chart.yaml` aligned with `package.json` and fail CI when they drift.
- **Worker image: `postgresql-client` pre-installed** (#553) — `Dockerfile.worker` now apt-installs `postgresql-client`, so `psql` is available on every lead/worker boot. Eliminates the per-session `apt-get install` cost for agents doing ad-hoc Postgres queries.
- **Docker harness bumps** (#552) — `Dockerfile.worker` ships newer `claude-code`, `pi`, `opencode`, and `codex` (0.133.0) harness versions; no compose-side changes required.
- **Slim list-endpoint payloads, add `?fields=full` opt-in** (#527) — `get-swarm`, `get-tasks`, `list-schedules`, `list-workflows` now return slim default payloads (dashboard-shape only) with an opt-in `?fields=full` query param for callers that need every column. Cuts dashboard polling bandwidth substantially on swarms with hundreds of in-flight tasks; `costData`, `progress`, large JSON blobs, and other expensive columns gate behind the opt-in.
- **DB perf: `listRecentSessions` single-pass + `getLogsByTaskId` LIMIT + UI poll 5s → 10s** (#526) — `listRecentSessions` collapsed to a single SQL pass; `getLogsByTaskId` now bounded by a LIMIT; UI session-detail polling slowed from 5s to 10s. Cuts API CPU under dashboard load.
- **DB perf: PRAGMAs + 3 indexes on `agent_tasks`** (#522) — adds the Q1 + Q2 indexes flagged by the Linear-fast-UI research run plus the recommended PRAGMA tunings. Speeds up the dashboard's frequently-queried filtered task lists (status × source × tags).
- **Scripts: relax typecheck to match runtime + descriptive diagnostics + runtime globals** (#533) — `script-upsert` typecheck previously rejected `JSON`, `Math`, `Date`, `Number`, `String`, `Error`, `Promise`, `Array<T>`, `isFinite`, `parseInt`, `parseFloat`, `encodeURIComponent`, `fetch`, `URL`, `crypto.randomUUID`, etc. even though all of those work at runtime. New `SCRIPT_RUNTIME_GLOBALS` ambient shim in `src/be/scripts/typecheck.ts` declares only the globals the eval-harness subprocess actually exposes; `lib` pinned to `lib.es2022.d.ts` (no `lib.dom.d.ts`) so DOM-only globals (`window`, `document`, `localStorage`) still reject. Diagnostics are now descriptive.
- **`pi-mono` delegates Amazon Bedrock auth to the AWS SDK** (#541) — `src/commands/provider-credentials.ts` stops hand-rolling AWS sigv4 and delegates to the AWS SDK's credential provider chain, picking up profile / env / IMDS / EKS-IRSA / SSO credentials transparently. Same change applies to Bun-compiled binaries.
- **Docs: update stale API host references to `api.desplega.agent-swarm.dev`** (#523) — `.env.example` and `DEPLOYMENT.md` referenced the legacy `api.agent-swarm.dev` host; both now point at the canonical `api.desplega.agent-swarm.dev` Fly target so copy-pasteable configs work out of the box.
- **Tool spans now implicit-close on assistant-message boundary** (#496, #497) — non-MCP and MCP tool spans previously could leak open when a tool finished without an explicit end event. The runner now closes any still-open tool span when it observes the next assistant message, ensuring spans always have a duration in SigNoz/Jaeger.
- **Context & cost tracking fixes** (#491) — multiple corrections to `peakContextPercent` and `costSource` tagging on `store-progress` and the claude-managed runner path; results in more accurate per-task token + USD attribution in the dashboard.
- **Docker harness bumps** (#489) — `Dockerfile.worker` ships newer codex / claude-code / pi-coding-agent / opencode versions; no compose-side changes required.

### Fixed
- **Skill filesystem sync now targets the swarm API origin** (#616) — remote-skill sync and auto-clone flows now use the API base URL instead of a non-API origin, making worker-side skill refreshes reliable in deployed environments.
- **Onboard dashboard auto-connect links** (#601) — the onboarding flow now builds dashboard deep-links with the SPA's required camelCase query params (`apiUrl`, `apiKey`, optional `name`), so the post-onboard "open dashboard" link connects successfully instead of silently failing on the old snake_case variant.
- **Codex spawn-budget hardening** (#581) — the Claude adapter now stages large system prompts via `--append-system-prompt-file`, and the prompt bootstrapper caps injected repo `CLAUDE.md` content so hot workers stop tripping Linux `E2BIG` / `MAX_ARG_STRLEN` spawn failures on prompt-heavy repos.
- **Codex subprocess diagnostics + pipe hygiene** (#584) — structured subprocess errors now propagate their real failure messages, non-TTY runs stop emitting cursor-restore escape codes into the JSON pipe, and fallback failures include stderr tail for postmortems.
- **Lazy provider loading for `pi` credential checks / adapter init** (#585) — workers that are not using `HARNESS_PROVIDER=pi` no longer import `@earendil-works/pi-coding-agent` at boot, avoiding module-side-effect crashes on unrelated providers.
- **Slack replies to swarm-started threads** (`1c6ea7f2`) — human replies now route correctly when the swarm posted the thread root itself, without requiring a fresh `@mention`.
- **Config env export skips invalid shell identifiers** (#573) — `docker-entrypoint.sh` now drops keys like `CF-Access-Client-Id` from `/tmp/swarm_config.env` instead of aborting the shell `source` and silently losing all later config entries.
- **Runner rate-limit cooldown parsing** (#559) — runner health detection now recognizes more qualified rate-limit messages and preserves structured cooldown timing instead of immediately reusing a credential slot that is still cooling down.
- **Claude resume-session recovery** — stale or invalid Claude resume-session IDs are now handled more reliably in the runner/resume path instead of failing the resumed task outright.
- **Jira OAuth token rotation persistence** — rotated Jira OAuth credentials now persist correctly after refresh, preventing follow-up tracker calls from regressing onto stale tokens.
- **Schedules: `update-schedule` accepts explicit `null` for `intervalMs` / `cronExpression`** (#554) — the MCP `update-schedule` tool + `PATCH /api/schedules/:id` handler rejected payloads that nulled out one timing field while setting the other (a legitimate "switch from interval to cron and back" flow). Both paths now route through a shared `mergeScheduleTiming` / `validateRecurringTiming` helper so `null` is treated as "clear this field" rather than "absent"; one of the two must still resolve to a real value after the merge. Regenerated `openapi.json`.
- **`slack-upload-file`: clearer constraint that paths resolve on the API server** (#553) — the tool description, not-found error, and source-level docstring no longer suggest that worker-side `/tmp/...` or `/workspace/personal/...` paths "work with a workspace fallback." The only volume shared between the API server and worker/lead containers is `/workspace/shared/`; everything else must be passed inline via the base64 `content` param. No behavior change on the file-resolution code path — documentation + error-message clarity only.
- **`store-progress` attachments on already-terminal tasks** (#544) — PR #542 (Phase 2a follow-up) silently dropped every attachment row when `store-progress` was called against a task already in `completed` / `failed` / `cancelled` state, because the attachment-insert was gated by the same `!isTerminal` short-circuit that prevents zombie-revival. Attachments are pointer-based + append-only with sha256 / `(kind, pointer, name)` dedup, so they don't change task state and shouldn't get caught by the zombie-revival guard. The attachment insert now runs BEFORE the terminal-status short-circuit, restoring the schema-documented behavior ("may be sent on any call — progress or completion — and accumulate across calls"). New `store-progress-attachments-handler.test.ts` covers the regression + four adjacent paths.
- **Wire Bun-compile Bedrock provider on entry points** (#539) — pi-ai loads its Bedrock provider via a dynamic `import("./amazon-bedrock.js")` that `bun build --compile` cannot resolve from the binary's virtual filesystem, so the first `bedrock-converse-stream` call from a compiled binary failed with `ResolveMessage: Cannot find module './amazon-bedrock.js' from '/$bunfs/root/agent-swarm'`. Both compiled entry points (`src/cli.tsx` for worker/lead, `src/http.ts` for API) now call `setBedrockProviderModule()` with the statically-importable `@earendil-works/pi-ai/bedrock-provider` module. Override survives `resetApiProviders()` triggered by `AgentSession.reload()` / `ModelRegistry.refresh()`. Mirrors upstream pi-mono fix `mariozechner/pi-mono#2350`.
- **Scripts: resolve `zod` during typecheck in the compiled binary** (#529) — `script-upsert` typecheck failed in compiled binaries because `zod`'s module resolution went looking for a node_modules tree that isn't present in the Bun virtual filesystem. The typecheck path now pre-resolves `zod` at build time so `import { z } from "zod"` (used by every `argsSchema` export) passes typecheck in both dev and compiled-binary modes.
- **Worker container reaps orphaned grandchildren with `tini` as PID 1** (#509) — the worker/lead container's PID 1 was the `agent-swarm` Bun process itself, which does not `waitpid(-1)`, so grandchildren spawned by harness sessions (npm, esbuild, headless chrome, next-server, ffmpeg, git) that outlived their immediate parent reparented to PID 1 and accumulated as zombies — one PID slot each — over the container's uptime. `Dockerfile.worker` now prepends `tini` so PID 1 is a real init that reaps every orphan and forwards signals to the worker. Image-level fix so it covers all deployments regardless of compose `init:` config.
- **GitHub comment & review webhook tasks now carry `requestedByUserId`** (#521) — `handleComment()` and `handlePullRequestReview()` resolved the GitHub sender into an underscore-prefixed, intentionally-unused variable and never passed it to `createTaskWithSiblingAwareness()`, so every comment- and review-sourced task had `requestedByUserId = null` even when the author was mapped in `user_external_ids`. Completes the `requestedByUserId` wiring from #500. Also fixes `handleComment()` passing a hardcoded `"issue_comment"` to `resolveGitHubSender()` for `pull_request_review_comment` events — now uses the `eventType` param so the unmapped-tracker labels the event correctly.
- **AgentMail event handling cleanup** (`ed22cc4d`) — tightens `src/agentmail/types.ts` and the corresponding handlers after the user-identity refactor.
- **Runner captures `rate_limit_event` for resilient 5h cooldown** (#508) — the Claude adapter now surfaces `rate_limit_event` payloads through `src/providers/types.ts` and `src/providers/claude-adapter.ts`; the runner records them via `src/utils/error-tracker.ts` so a single 5-hour rate-limit hit is observable across reschedules and doesn't get retried into a tighter cooldown loop. Adds `src/tests/rate-limit-event.test.ts` and extends `src/tests/error-tracker.test.ts` (CAI-1279).
- **Workflow webhook triggers honor `hmacHeader` + resolve `hmacSecret` refs** (#510) — webhook trigger config previously ignored a custom `hmacHeader` and did not resolve `${{ secrets.* }}` references for `hmacSecret`. `src/http/workflows.ts`, `src/workflows/input.ts`, and `src/workflows/triggers.ts` now read the header from trigger config (defaulting to `X-Hub-Signature-256`) and resolve secret refs before HMAC verification. Covered by `src/tests/workflow-triggers-v2.test.ts`.
- **UI: single-branch condition node edges now render in the workflow graph** (#511) — `ui/src/components/shared/workflow-node-shell.tsx` was dropping outbound edges from condition nodes that only had one branch wired. The shell now emits handles for both branches even when only one is configured, so the edge to the downstream node draws correctly in the workflow visualiser.
- **Scripts runtime resolves the eval-harness path in compiled-binary mode** (#499) — in compiled binaries `import.meta.url` resolves to `/$bunfs/` paths that spawned subprocesses cannot read. The Dockerfile now pre-builds `eval-harness.ts`, `stdlib`, and `swarm-sdk` into self-contained bundles exposed via the new `SCRIPT_RUNTIME_DIR` env var; a `TS_LIB_DIR` fallback lets the TypeScript compiler find `lib.*.d.ts` for script typecheck (fixes `Error` / `Number` / `String` constructor false positives).
- **`swarm-script` workflow node populates executor output on timeout / spawn-error** (#504) — a script step that times out or fails to spawn now records its output instead of leaving it empty.
- **`eval-harness` parses `rawArgs` defensively** (#503) — malformed or non-JSON `rawArgs` passed to a script run no longer crash the harness.
- **Resolved secrets redacted from persisted workflow step inputs** (#501) — secret values resolved into a workflow step's inputs are now scrubbed before the step input is persisted, so they don't leak into stored run history.
- **`Dockerfile.worker` pre-creates `/home/worker/.local/{bin,share,state}` as `worker`** (#483) — entrypoint also `chown -R`s `/home/worker/.local` to `worker:worker` right before `exec gosu worker`. Fixes `EACCES: permission denied, mkdir '/home/worker/.local/share'` when the Bun MCP subprocess spawns inside reviewer/codex/Bun workers, caused by root-owned `.local` directories left behind by root-level steps that obey XDG (notably `archil mount`) while `ENV HOME=/home/worker` is still active under `USER root`.
- **`pi-mono` adapter model handling** (`2650a54c`) — fixes model resolution in `src/providers/pi-mono-adapter.ts`.

## [1.79.1] - 2026-05-13

### Added
- **KV store + Pages SDK + `kv-storage` skill** (#478) — Redis-like, namespaced key/value store auto-scoped to the agent's current context (Slack thread / PR / Linear issue / agent scratchpad / page). New `kv` capability and five MCP tools (`kv-get`, `kv-set`, `kv-delete`, `kv-incr`, `kv-list`) plus public `/api/kv` HTTP routes for the Pages SDK. 2 MiB body cap, opt-in TTL via `expiresInSec`, atomic upserts/increments. Adds migration `061_kv_store.sql`. The `kv-storage` SKILL.md documents context auto-resolution rules and includes the "do NOT use for secrets / embedded knowledge / files" guardrail.
- **Pages: diff helper + PDF export + view counter** (#479) — page versions now support diff retrieval, a built-in PDF export endpoint, and a monotonic view counter (migration `062_pages_view_count.sql`). Counter surfaces in the dashboard pages listing.
- **Telemetry: `is_cloud` emitted on every event** (#476) — the telemetry initializer attaches an `is_cloud` flag derived from the runtime environment to every event so downstream pipelines can filter cloud vs self-hosted traffic without joining to a separate dimension.

### Changed
- **Slack task-tree status icons now cover every task lifecycle state** (#604) — tree messages in Slack no longer drop the icon when a node is `backlog`, `unassigned`, `offered`, `reviewing`, `paused`, or `superseded`. The renderer now accepts the full `AgentTaskStatus` union and falls back safely for unknown future states, so parent/child trees stay readable across the full lifecycle.
- **Pages public renderer CSP: allowlist `jsdelivr.net` + `unpkg.com` for `script-src`** (#480) — published HTML pages can now load CDN-hosted libraries from the two most common JS CDNs without inline-script workarounds. CSP otherwise unchanged.
- **`pi-coding-agent` migrated to `@earendil-works` scope @ 0.74.0** (#459) — `Dockerfile.worker`, provider credential plumbing, and the `harness-providers` docs page were updated to the new package name. Existing installs on the old scope continue to work; new builds pull from `@earendil-works/pi-coding-agent`.

## [1.79.0] - 2026-05-13

### Added
- **DB-backed pages — `create_page` MCP tool + `/pages` SPA route** (#472) — agents can now publish HTML or JSON pages that live in SQLite, no long-lived process needed. Adds the `pages` capability (on by default), the `create_page` tool with upsert-by-(agent, slug) semantics and snapshot-on-update versioning, and three new HTTP routes: `POST/GET/PUT/DELETE /api/pages`, `POST /api/pages/:id/launch` (HMAC-signed `page_session` cookie), and public `/p/:id` / `/p/:id.json` serving with three auth modes (`public`, `authed`, `password`). Bodies capped at 5 MiB. HTML pages get `<base target=_blank>`, Space Grotesk + Space Mono fonts, Tailwind Play CDN, swarm-themed CSS variables, and a `window.swarmSdk` singleton injected via `BROWSER_SDK_JS`. JSON pages render through `@json-render/react` with a swarm-specific component catalog (Container/Card/Heading/Text/Button/Metric/Alert) and two action handlers (`swarm.sdk`, `swarm.call`). New `system.agent.share_urls` prompt template documents `MCP_BASE_URL` / `APP_URL` / `SWARM_URL` / `AGENT_FS_LIVE_URL` for share-link generation.
- **Domain-grouped `window.SwarmSDK`** (#472) — replaces the previous flat 9-method surface with seven explicit domain modules (`tasks`, `agents`, `events`, `memory`, `repos`, `schedules`, `approvalRequests`), each mapping 1:1 to a `/api/*` REST section. Calls route through the cookie-gated `/@swarm/api/*` proxy so no client-side token handling is needed. Mirrored in the SPA at `ui/src/lib/swarm-sdk.ts` for the JSON renderer's `swarm.sdk` action. Removed (not part of curated v1): `postMessage`, `readMessages`, `listServices`, `slackReply`.
- **`pages` skill (`plugin/skills/pages/`)** (#472) — full agent-facing guide covering page lifecycle, the seven SDK domains with HTTP-path mapping, share-URL patterns, and copy-pasteable signature blocks.

### Changed
- **UI: Pages surface feature-gated behind API ≥ 1.79.0** (#473) — sidebar entry, command-menu, and `/pages` / `/pages/:id` routes consult a generalized `useFeatureGate` lookup. Older API servers stop seeing the Pages nav entry and get a clean `<UpgradeRequired />` screen on deep links. Hooks-order preserved by moving the gate's early-return after all `useMemo` / `useCallback` declarations.

## [1.78.1] - 2026-05-12

### Fixed
- **`agent-swarm artifact list` / `artifact stop` handles `{services:[]}` envelope** (#469) — `/api/services` returns `{ services: [...] }`, but both commands cast the JSON as a bare `Array`. `artifact list` crashed loudly with `TypeError: services.filter is not a function`, and `artifact stop` silently no-op'd the registry-unregister (try/catch swallowed it), leaving stale DB rows. Both call sites now extract `body.services ?? []`. New `artifact-commands.test.ts` mocks `globalThis.fetch` and asserts `{services:[…]}`, `{services:[]}`, and `{}` shapes all parse without throwing. Existing `artifact-sdk.test.ts` mocks updated — they were encoding the bug. Follow-up flagged: `artifact stop <name>` runs `pm2 delete artifact-<name>` even for nohup/non-PM2 processes, which fails silently.
- **Skill approval flow passes `scope` through `skill-update`** (#468) — the harness's skill-update approval handler was dropping the `scope` parameter, so approvals always wrote to agent scope regardless of the requester's intent.

### Changed
- **`artifacts` skill — rename `skill.md` → `SKILL.md`, add YAML frontmatter** (#469) — Claude Code's skill scanner watches the uppercase filename; the lowercase variant was invisible to the harness. Frontmatter bakes in the actual user phrasings ("create an artifact for X", "host this for me", "make me a tunneled URL", "give me a live link", ...) so the skill surfaces reliably. Every CLI example now uses the correct `agent-swarm artifact <subcommand>` form. New "Auth & URL Pattern" + "Running it as a daemon" sections (nohup + PM2 recipes) plus an explicit callout that `artifact stop` currently only kills PM2-started processes.
- **Markdown-rendered task views in the dashboard** (cf261b16) — adds `MarkdownView` + `CollapsibleDescription` components; `tasks-table` and `tasks/[id]` pages now render output / failure / description as Markdown. Sharper error tracker — `error-tracker.ts` gets richer context capture (covered by 30 new tests).

## [1.78.0] - 2026-05-12

### Added
- **Multi-arch Docker image publishing — `linux/amd64` + `linux/arm64`** (#437) — `docker-and-deploy.yml` workflow now publishes both architectures for `ghcr.io/desplega-ai/agent-swarm` and `ghcr.io/desplega-ai/agent-swarm-worker`. Bumps `Dockerfile.worker` accordingly. Same tags (`v<version>`, `latest`, `sha-<commit>`) as before; pulls on Apple Silicon and Linux ARM nodes no longer go through QEMU emulation.

### Changed
- **`src/x402/` marked alpha / opt-in** (#467) — the x402 payments module remains in-tree but documentation clarifies it is alpha and disabled by default; production deployments should keep it gated.
- **npm dependency bumps across 3 directories — 13 updates** (#464) — routine `dependabot` group bump for the npm_and_yarn group. No public API impact.

### Fixed
- **Workflow script nodes mark themselves failed on non-zero exit** (#462) — previously a script-node exec that returned non-zero status would still resolve as `completed`, silently passing failure downstream. The node now propagates the exit code as a workflow-node failure so dependent nodes don't run on a broken upstream.
- **`pi` provider: anthropic shortnames re-route through OpenRouter when only `OPENROUTER_API_KEY` is set** (#458) — operators running pi-only with OpenRouter credentials no longer get `Provider not configured` errors when a task requests an anthropic shortname (`opus`, `sonnet`, `haiku`). The pi adapter's model resolver now consults the configured credential pool before short-circuiting to anthropic-direct.
- **CI flake fixes** (4c5b4cb5) — stabilization of intermittently-failing tests; no production behavior change.

## [1.77.3] - 2026-05-12

### Fixed
- **Codex adapter rate-limit handling** (b5023b08) — adapter now backs off cleanly on Codex rate-limit errors instead of bubbling them up as task failures.

## [1.77.2] - 2026-05-12

### Added
- **Worker reports `latest_model` to the API** (175c579d) — `buildLatestModelReport` + `reportLatestModel` (`src/commands/provider-credentials.ts`) post the worker's effective model to `PUT /api/agents/{id}/credential-status` along with provenance (`task` / `agent_config` / `custom` / `adapter_default`). Surfaces in the dashboard so operators can see which model a worker is actually running per task.

## [1.77.1] - 2026-05-12

### Changed
- **Pretty-printed runner progress for `pi` and `codex` harnesses** (55e3b1ea) — runner now emits compact, human-readable progress lines for tool-call events from non-Claude harnesses instead of raw JSON.

## [1.77.0] - 2026-05-12

### Added
- **Live env reload from `swarm_config`** (314168b4) — runner re-reads `MODEL_OVERRIDE` and `AGENT_FS_SHARED_ORG_ID` from `swarm_config` on every poll tick and applies them to `process.env` mid-flight. Other env keys (boot identity, credential-pool members, paired-state values, OS-level vars) are intentionally **not** reloadable — see the `RELOADABLE_ENV_KEYS` list in `src/commands/runner.ts` for the rationale per category.
- **Provider can flip mid-credential-wait** (`src/commands/credential-wait.ts`) — `awaitCredentials` now accepts an optional `getProvider()` callback that is re-read on every tick. An operator flipping `HARNESS_PROVIDER` in `swarm_config` while a worker is parked in `waiting_for_credentials` now actually pivots the predicate, no container restart needed.

### Changed
- **`Dockerfile.worker` size optimization** (314168b4) — eliminated the multi-GB `chown -R worker:worker /home/worker` layer that was duplicating the entire `$HOME` tree. Root-side installs (`npm install`, `qa-use install-deps`, `playwright install`) now run with `HOME=/root` + `NPM_CONFIG_CACHE=/tmp/npm-cache` + `PLAYWRIGHT_BROWSERS_PATH=/opt/playwright` overrides inline, so caches never land in `/home/worker`. Adds extensive npm `overrides` for transitive bloaters (`chromadb`, `chromadb-default-embed`, `@xenova/transformers`, `tree-sitter-wasms`, `web-tree-sitter`, `cohere-ai`, `voyageai`, `ollama`) — all stubbed via `npm:empty-npm-package@1.0.0`. Bumps `@desplega.ai/qa-use` 2.17.0 → 2.18.0 and `@desplega.ai/agent-fs` 0.5.1 → 0.5.3. Full rationale in [`runbooks/docker-images.md`](./runbooks/docker-images.md).
- **opencode plugin: vendored `lib/` helpers + Dockerfile COPY** (#460) — opencode's plugin loader runs inside its own bundled Bun runtime which only exposes `@opencode-ai/{plugin,sdk}`. Session-summary helpers (`opencode-auth.ts`, `summarize.ts`) are now vendored under `plugin/opencode-plugins/lib/` and copied into `/home/worker/.config/opencode/plugins/lib/` by `Dockerfile.worker` so the plugin's relative imports resolve.

### Fixed
- **Session summarization across worker harness providers (claude, pi, opencode, codex)** (#460) — extracts a single shared `internal-ai` abstraction (`src/utils/internal-ai/`) for structured-output LLM calls, with a credential resolver that handles `OPENROUTER_API_KEY` → `ANTHROPIC_API_KEY` → `OPENAI_API_KEY` → Codex OAuth → `CLAUDE_CODE_OAUTH_TOKEN` precedence. All four worker harnesses now use it for end-of-session summarization:
  - **claude** (`src/hooks/hook.ts`) — Stop hook now goes through `summarizeSession` from `internal-ai` instead of the OpenRouter-only `runMemoryRater`. Pro/Max OAuth users with no OpenRouter key keep working via the `claude -p --json-schema` fallback. The wrapper now passes `--json-schema` AND appends the schema inline to the user prompt, with a tolerant `stripJsonFences` parser (defense-in-depth) — fixes the earlier silent failure where `JSON.parse("No significant learnings.")` always threw and dropped every summary. `claude-adapter` mirrors `CLAUDE_CODE_OAUTH_TOKEN` to `AGENT_SWARM_CLAUDE_OAUTH_TOKEN` to survive Claude CLI's hook env-stripping.
  - **pi** (`src/providers/pi-mono-extension.ts`) — migrated off the previous direct-rater path onto the shared wrapper, with explicit DI for testability.
  - **opencode** (`plugin/opencode-plugins/agent-swarm.ts`) — replaced the dead `claude -p` shellout (which always ran with `sessionFile=undefined` in production) with an SDK-sourced transcript fetched at `session.idle` time, flattened to text + completed tool calls only. Plugin uses a new opencode-specific credential resolver that reads `~/.local/share/opencode/auth.json` (ApiAuth / WellKnownAuth / anthropic OAuth with refresh + persist) plus env vars.
  - **codex** (`src/providers/codex-adapter.ts`) — codex now buffers its transcript and runs the same shared session-summary call at session end.

### Removed
- **`--ai-loop` CLI flag** (`src/cli.tsx`) — removed from `worker` and `lead` commands. The legacy AI-based polling mode it gated has been the default for some time; the flag was a no-op carry-over.

## [1.76.0] - 2026-05-10

### Added
- **Sessions UI + new tables/endpoints — Phases 1–3 + Sessions experience** (#455) — full session-as-first-class-citizen rework of the dashboard backed by four new HTTP routes and three new migrations.
  - **Phase 1 — source enum cleanup + `requestedByUserId` + 1.76.0 bump**: migration `056_drop_agent_tasks_source_check.sql` (table-rebuild) drops the `agent_tasks.source` SQL CHECK constraint in favor of Zod `AgentTaskSourceSchema` validation in `src/http/tasks.ts`. Preserves the `requestedByUserId → users(id)` FK and post-043 provider/providerMeta columns. Migration-runner regression test flipped from CHECK-throws to Zod-rejects (HTTP 400). `openapi.json` + `docs-site/content/docs/api-reference/**` regenerated for the bump.
  - **Phase 2 — new tables + endpoints**: migrations `057_inbox_item_state.sql` and `058_task_templates.sql` (with v2-aware `kind`/`payload` polymorphism + 5 seed rows). New Zod schemas in `src/types.ts`: `InboxItemTypeSchema`, `InboxItemStatusSchema`, `InboxItemStateSchema`, `TaskTemplateSchema`. New DB helpers: `listInboxState`, `upsertInboxState`, `listTaskTemplates`, `getRootTaskChain` (recursive CTE), `listRecentSessions`. `getAllTasks` now accepts `string | string[]` status (CSV-friendly) + `createdAfter` ISO filter.
    Four new HTTP route files via the `route()` factory (auto-registered in OpenAPI):
    - `src/http/users.ts` → `GET / POST / PUT /api/users` (3 endpoints)
    - `src/http/sessions.ts` → `GET /api/sessions`, `GET /api/sessions/{rootTaskId}` (2 endpoints)
    - `src/http/inbox-state.ts` → `GET, PATCH /api/inbox-state` (2 endpoints)
    - `src/http/task-templates.ts` → `GET /api/task-templates` (kind + query + category filters)
    Existing `POST /api/tasks` is now tolerant of unknown `requestedByUserId` (coerces to `NULL` + warn instead of FK 500). `GET /api/tasks` accepts CSV `status` and `createdAfter` filters.
  - **Phase 3 — identity boot gate + `parentTaskId` / `requestedByUserId` plumbing**: composer follow-ups now route correctly via the lead by default for any task without an explicit `agentId` (drops the `!parentTaskId` guard). UI composer follow-ups are no longer left unassigned.
  - **Sessions UI**: brand-new `/sessions` route with `SessionsShell`, `SessionTimeline`, collapsible `ParallelGroup`, `TaskCard` (passive — opens `TaskDetailSheet` via Maximize2 button), `<OutcomeBlock>` with copy-to-clipboard, Markdown-rendered failure / output sections (via `<Streamdown>`), session timeline showing the actual requesting user name resolved from `useUsers` cache, "Session start" badge, and an Eye-off toggle to hide system tasks (default hidden, count surfaced in tooltip, persisted under `agent-swarm-sessions-show-system`). Session detail page at `/sessions/[rootTaskId]`.
- **`HARNESS_PROVIDER` overridable via `swarm_config` (live reconcile)** (#455) — workers now resolve their effective harness from `swarm_config` (repo > agent > global) overlaid on `process.env`, defaulting to `"claude"`. Poll loop re-fetches every ~10s and swaps the adapter live (with `basePrompt` rebuild) when the resolved value changes — operators flip a worker's provider from the dashboard without restarting. Symmetric to `MODEL_OVERRIDE` precedence. `PATCH /api/agents/{id}/harness-provider` now mirrors its value into a `swarm_config` row at `scope=agent`. New `validateConfigValue` guard rejects invalid `HARNESS_PROVIDER` values at write time (HTTP 400 + MCP error). `docker-entrypoint.sh` skips `HARNESS_PROVIDER` when baking config to env (so a deleted `swarm_config` row isn't shadowed by a stale env value). 17 new tests in `harness-provider-resolution.test.ts` + PATCH side-effect coverage; E2E in docker covers boot default → PUT swarm_config → PATCH route → DELETE fallback to env.
- **Cloud personalization & adaptive home — phases 1–4** (#452) — agent-swarm now feels like *your* deployment from the moment a user opens it.
  - **Phase 1 + 1.5 + 1.6** — `GET /status` (identity + 7 setup milestones + activity + agent_fs), `POST /status/test-connection` for live harness verification, new `HomePage` at `/` (legacy `DashboardPage` demoted to `/dashboard`), per-agent `harness_provider` column (migration 054), iteration & polish (sidebar branding, OAuth-aware credential validation, harness column on `/agents`, demo seed script, [Personalization & Status guide](docs-site/.../guides/personalization.mdx)).
  - **Phase 2** — additive `health` rollup on `/status`, `StatusContext` that dedupes fetches, `AppHeader` health badge polling every 30s with Page Visibility pause, cloud-aware Docs/Support/Billing menu items in the swarm switcher, subtle self-host marketing footer.
  - **Phase 3** — `template-recommendations.ts` maps detected integrations to starter templates (`slack+github` → `pr-triage`, `linear+github` → `issue-to-pr`, `jira` → `bug-intake`, fallback → `hello-world`). Empty states on `/templates`, `/tasks`, `/workflows` plus a "First steps" card on home. Four template stubs land under `templates/official/`.
  - **Phase 4** — `useDismissibleCard` hook namespaced by `apiUrl` (storage key `swarm:v1:${apiUrl}:${cardKey}`), welcome card on home, per-milestone collapse, and tour-completion full-section collapse once the four MVP milestones have each been verified at least once.
  - New cloud envs: `SWARM_CLOUD`, `SWARM_ORG_NAME`, `SWARM_ORG_LOGO_URL`, `SWARM_BRAND_COLOR`, `SWARM_MARKETING_URL`, `SWARM_HIDE_CLOUD_PROMO`, `SWARM_VERIFY_TTL_MS`. Worker-side `HARNESS_PROVIDER` is now reported on register and drives the harness milestone.

### Changed
- **Follow-up task control + resume path cleanup** (#587, #593, #594) — `send-task` and workflow `agent-task` nodes now accept `followUpConfig` so long-running flows can disable or customize the lead follow-up created on child completion/failure. The old provider-native resume path is deprecated in favor of the DB-backed context preamble, and pause/resume now supersedes the current task with an explicit follow-up instead of trying to stitch the provider session back together.
- **Worker image pins** (#590, #598) — `Dockerfile.worker` now pins Claude Code `2.1.156` and sets `DISABLE_AUTOUPDATER=1` so hot workers stay on the tested CLI version instead of self-updating under load.
- **Docker worker global tools** — `Dockerfile.worker` now ships `@desplega.ai/qa-use` 2.19.0 and `@desplega.ai/agent-fs` 0.7.2 out of the box, keeping the default worker image aligned with the current QA/browser-automation and agent-fs CLI surfaces.
- **Slack manifest scopes trimmed for App Directory submission** (#454) — drops 4 redundant bot scopes (`chat:write.public`, `mpim:read` / `mpim:history` / `mpim:write`) and the matching `message.mpim` event. Group-DM support isn't used by any handler in `src/slack/`, and reviewers prefer explicit bot invites over `chat:write.public`. Also flips `token_rotation_enabled` to `true` (marketplace requirement). Socket mode preserved — HTTP migration is a separate PR.
- **Memory rater — Stop-hook summarizer swapped to OpenRouter SDK** (#450) — the sub-`claude` CLI piggyback path silently produced "Not logged in · Please run /login" rows after the 2026-05-05 `CLAUDE_CODE_VERSION` bump (2.1.112 → 2.1.126) stopped propagating `CLAUDE_CODE_OAUTH_TOKEN` to hook subprocesses (0 LLM rater rows ever, 417 garbage session-summary rows over 2 days). Replaced with a Vercel AI SDK `generateObject` call against OpenRouter — schema-validated `{summary, ratings}` output, no manual envelope/fence parsing. Default model: `google/gemini-3-flash-preview` (Gemini 3 Flash via OpenRouter — materially cheaper than Haiku 4.5: $0.5/M input + $3/M completion vs $1/M + $5/M). Override via `MEMORY_RATER_LLM_MODEL`. **No-op when `OPENROUTER_API_KEY` is unset** — self-hosters / OSS users skip session summary + LLM ratings entirely rather than falling back to the broken claude path. Drops 251 LOC of dead JSON-fence parsing code (`parseSummaryWithRatings`, `extractSummaryFromClaudeStdout`, `tryParseLooseJson`).
- **Worker self-reports `cred_status`** (b89d6a06) — credentials adapter import removed from the API bundle; the worker reports its credential status directly via `PUT /api/agents/{id}/credential-status` instead of having the API duplicate provider-specific resolution logic. Reduces API bundle size and keeps provider knowledge worker-side.
- **Status: harness milestone is fleet-derived** (6561b6cb) — `GET /status` no longer reads `process.env.HARNESS_PROVIDER` on the API process (a worker-side env var). Instead it derives the milestone from the registered worker fleet — surfaces a clear "No workers registered with `HARNESS_PROVIDER=…`" hint when the live-test target has no agents.

### Fixed
- **Scheduled-task completion memory gating** (#597) — automatic / recurring tasks now persist task-completion memories only when they explicitly call `store-progress(..., persistMemory: true)`, preventing daily or heartbeat no-op runs from flooding the memory index by default.
- **OAuth refresh-token persistence and access-token reads** — refresh paths now serialize and compare-and-swap rotating OAuth tokens before persisting replacements, preventing stale refresh-token reuse and keeping `get-oauth-access-token` / tracker status reads aligned with the authoritative DB row.
- **MCP task-tool content for text-only harnesses** — `get-task-details`, `get-tasks`, `task-action`, `cancel-task`, and `send-task` now mirror their structured payloads into text content as JSON, so providers that only inspect `content` still see the machine-readable result shape.
- **`pi-mono` completion output + lead follow-ups** — the adapter now captures the last assistant message as fallback task output, and the worker-completion follow-up path is shared between `store-progress` and direct task-finish flows so the lead consistently receives completion/failure follow-ups.
- **Memory rater dedupes scheduled-task self-similar memories** (#451) — scheduled tasks fire byte-identical `task.task` text every run, and task-completion memories are named `Task: ${task.task.slice(0, 80)}`. The previous LLM rater scored 5+ near-clones at +1.0 each in one cron pass, inflating `alpha` 5x in a single session. New `dedupeRetrievalsForRater` in the Stop hook keeps the freshest occurrence per memory name. Includes regression tests (5 cron clones + 1 distinct → 2 rows).
- **Codex creds: `~/.codex/auth.json` is a valid live-test bypass** (8d06bc53) — the harness milestone live-test now treats the on-disk Codex auth file as a successful credential bypass, matching the documented Codex provider precedence (OAuth file > API key).
- **Memory rater Stop-hook regression chain** (#444, #445, #447) — the LLM piggyback rater introduced in #429 had been silent in production since deploy. Three follow-ups landed the fix:
  - **#444** — gate-trace logging in the Stop hook to expose which precondition was failing
  - **#445** — pass `taskId` via `AGENT_SWARM_TASK_ID` (and `AGENT_SWARM_AGENT_ID`) env vars instead of relying on the on-disk `TASK_FILE`. The file disappeared mid-session in production, so `Bun.file().text()` threw ENOENT; the catch swallowed it and `taskId` stayed undefined, which short-circuited `fetchRetrievalsForTask`
  - **#447** — tolerant JSON parser (`tryParseLooseJson`) for Haiku output that occasionally wrapped the inner `result` in ` ```json ` fences or prefixed it with a short prose preamble. Strict `JSON.parse` rejected those shapes; the new helper strips fences and falls back to first-`{` / last-`}` slicing. The summarizer prompt also got an explicit no-fences / no-preamble directive as defense-in-depth. Includes regression tests for both `parseSummaryWithRatings` and `extractSummaryFromClaudeStdout`

### Changed
- **`Dockerfile.worker`** — bumped `CODEX_VERSION` from 0.125.0 to 0.128.0; matching `@openai/codex-sdk` bump from `^0.125.0` to `^0.128.0` in `package.json` (#442)
- **`Dockerfile.worker`** — `@desplega.ai/qa-use` bumped to 2.17.0 to dodge a `workspace:*` resolution failure in 2.15.3 that broke uncached Docker Build CI; pinned `@huggingface/hub` to 2.11.0 via npm overrides to work around `@huggingface/xetchunk-wasm@0.0.4` shipping unpublished `workspace:*` siblings. Switched the global-tool install pattern from `npm install -g` to staging-dir install + symlink-to-`/usr/local/bin` so the override applies (#447)

## [1.75.0] - 2026-05-06

### Added
- **Memory rater v1.5 — completion (steps 4–7)**:
  - **Step 4 (#429)** — `LlmRater` (`src/be/memory/raters/llm.ts`) that piggybacks on the existing Stop-hook session-summary Haiku call. When `MEMORY_LLM_RATER_ENABLED=true` the summarizer prompt is augmented to also rate retrieved memories `useful: true | false`; ratings are POSTed to `/api/memory/rate` with `source: "llm"`. Zero extra LLM round-trips on the worker hot path
  - **Step 5 (#428)** — `memory_rate` MCP tool. Agents can record explicit usefulness ratings on a retrieved memory in their current task (`useful`, optional short `note`, optional `referencesSource` external pointer). Spam-guarded by the `memory_retrieval` row produced when the memory was surfaced; out-of-task calls are rejected. Wired through the worker `ExplicitSelfRatingRater` and surfaced in the runner-injected memory recall prompt (`src/prompts/memories.ts`)
  - **Step 6 (#436)** — `referencesSource` edges. The optional free-form `<source>:<identifier>` field on `memory_rate` (e.g. `github:owner/repo#N`, `linear:KEY-N`, `customer:<slug>`, `slack:<channel>:<ts>`) creates/updates an edge from the rated memory to the external artifact it cites. Sanitized for NUL bytes and control characters
  - **Step 7 (#440)** — v1.5 capstone: docs + business-use flow instrumentation + cross-cutting end-to-end tests covering the implicit-citation, llm, and explicit-self rater paths. `MCP.md` regenerated to surface the new `memory_rate` tool entry
- **Worker credential safe-loop** (#441) — workers no longer crash-loop when harness credentials are missing. The TypeScript-level `awaitCredentials` (`src/commands/credential-wait.ts`) replaces the bash-level fail-fast in `docker-entrypoint.sh`. The container always boots, calls `join-swarm`, and parks in a `waiting_for_credentials` agent status while polling `swarm_config` for the missing variables. Status is reported via `PUT /api/agents/{id}/credential-status`; the dispatcher's `getIdleWorkersWithCapacity` predicate already excludes non-`idle` workers, so blocked agents are routed around without any extra condition. Self-heals as soon as the credential lands — no container restart required. The single hard exit retained is `API_KEY` (without it the worker can't talk to the API at all)

### Changed
- **`new-ui` directory renamed to `ui`** (a2e86719) — README, configs, and CI workflows updated to reference the canonical `ui/` path. Standalone landing site removed (60bb0ea8) in favor of the rewritten `agent-swarm.dev` (#438)
- **`new-ui` design system migration** (#439) — tokens, primitives, and composition layer for the dashboard. Lays groundwork for shared-component reuse across the dashboard, templates UI, and docs site
- **Landing v2 — Coordination Intelligence rewrite of `agent-swarm.dev`** (#438)

### Fixed
- **Thin meta descriptions across landing & docs pages** (#433) — automated SEO pass expanded short/missing meta descriptions to improve search snippets

## [1.74.4] - 2026-05-06

### Added
- **Workflow `wait` executor** (#420) — pause a run for a fixed duration (`mode: "time"`, `durationMs` in 1ms..1y) or until a `workflowEventBus` event satisfies an optional payload filter (`mode: "event"`, `eventName` + `filter` + `scope: run|global` + optional `timeoutMs` routing to the `timeout` port). Time mode and event-mode timeouts wake via the `wait-poller`; event matches resume via the workflow event bus. Brings the built-in executor count to 10
- **Workflow `triggerSchema` end-to-end authoring** (#423) — workflows can attach an optional JSON Schema to validate `triggerData` across every entry path (manual `/trigger`, webhooks, schedules, `trigger-workflow` MCP). Mismatched payloads are rejected with HTTP 400 (or MCP error) **before** a run is created. New / updated MCP tools: `create-workflow`, `update-workflow`, `patch-workflow` (and `trigger-workflow`'s validator surface). HTTP `POST` / `PUT` / `PATCH /api/workflows/{id}` accept `triggerSchema` (and `null` on `PUT`/`PATCH` to clear). Failure responses echo the active schema so callers can self-correct. Validator subset is deliberate: `type`, `required`, `properties`, `enum`, `const`, `items`; other keywords (`oneOf`, `anyOf`, `$ref`, `pattern`, `format`, …) are silently ignored. Frontend editor + tester in `new-ui/`
- **Linear: workflow-state gate + `swarm-ready` label override** (#395) — Linear webhooks now only trigger swarm tasks for issues whose `WorkflowState.type` is in the configured allowlist (default: `unstarted, started, completed, canceled` — i.e. everything except `triage` and `backlog`). A configurable label (default `swarm-ready`, override via `LINEAR_SWARM_READY_LABEL`) bypasses the gate so users can pre-stage backlog issues. Skipped assignments leave a comment on the AgentSession explaining how to retry
- **Memory rater foundations (steps 1–3 of v1.5)** (#425, #426, #427):
  - Step 1 (#425): `memory_rating` schema, `MemoryRater` spine, and a `NoopRater` reranker as a typed seam for future raters
  - Step 2 (#426): retrieval bridge (`memory_retrieval` rows) + `ImplicitCitationRater` so citations in agent output map back to the memories that were retrieved into the prompt
  - Step 3 (#427): `POST /api/memory/rate` (Zod-validated `RatingEvent[]`, max 50, source ∈ `llm, explicit-self`, R6 spam-guard requires a matching `memory_retrieval` row for `explicit-self`, 409 on partial-unique-index dup) and `GET /api/memory/retrievals` (joins `memory_retrieval × agent_memory`, scoped by `X-Agent-ID`, ORDER BY `retrievedAt` DESC, LIMIT 50, 500-char content snippet). OpenAPI + `docs-site/content/docs/api-reference/memory.mdx` regenerated

### Changed
- **Workflows concept doc + runbook** updated for `wait` (10 executors) and `triggerSchema` (`docs-site/content/docs/(documentation)/concepts/workflows.mdx`)
- **`.mcp.json` precedence fix for multi-root workspaces** (a2963f2b) — multi-root MCP config resolution now picks the right manifest

### Fixed
- **Codex provider: prefer OAuth over API key** (`v1.74.4`, c92df43b) — Codex harness now selects the ChatGPT OAuth credential when both an OAuth token and an API key are present, matching the documented precedence
- **Trackers: ensure tokens are refreshed** (4dcdfd96) — `tracker-status` MCP tool and surrounding integration paths now refresh tracker OAuth tokens before issuing API calls instead of failing on stale tokens

## [1.74.1] - 2026-05-05

### Changed
- Regenerated `openapi.json` and `docs-site/content/docs/api-reference/**` to embed the bumped `package.json` version (no functional API changes)

## [1.74.0] - 2026-05-05

### Added
- **Per-task `outputSchema` support documented across harness providers** (#6faabc9d). `docs-site/content/docs/(documentation)/guides/harness-providers.mdx` and `runbooks/harness-providers.md` now carry a supported-providers table for `outputSchema` enforcement: `claude`, `claude-managed`, `codex`, `opencode`, `pi` enforce the schema via the `store-progress` MCP tool; `devin` only enforces when `HAS_MCP=true`, and the runner now carries an explicit NOTE in `ensureTaskFinished` (`src/commands/runner.ts:551`) that default-mode Devin's `providerOutput` is **not** validated against `task.outputSchema` and is stored as-is. Callers should not assume `JSON.parse(task.output)` will succeed when the task ran on default-mode Devin
- **Marketplace plugin pin** — Claude marketplace plugin install in `Dockerfile.worker` now pins `desplega-ai/ai-toolbox@cc-desplega-2.0.0` (was floating)

### Changed
- **Bumped pinned harness CLIs in `Dockerfile.worker`**:
  - `CLAUDE_CODE_VERSION` 2.1.112 → 2.1.126
  - `PI_CODING_AGENT_VERSION` 0.67.2 → 0.73.0
  - `CODEX_VERSION` 0.118.0 → 0.125.0
- **Bumped global npm tooling in `Dockerfile.worker`**:
  - `@desplega.ai/qa-use` 2.14.0 → 2.15.3
  - `@desplega.ai/agent-fs` 0.4.0 → 0.5.1
- **Bumped pinned dependencies in `package.json`**:
  - `@anthropic-ai/sdk` `latest` → `^0.93.0`
  - `@mariozechner/pi-agent-core` / `pi-ai` / `pi-coding-agent` ^0.67.2 → ^0.73.0
  - `@openai/codex-sdk` ^0.118.0 → ^0.125.0
- **`pi-mono` adapter now passes `cwd` and `agentDir` to `DefaultResourceLoader`** (`src/providers/pi-mono-adapter.ts`) — uses the new `getAgentDir()` export from `@mariozechner/pi-coding-agent` so the resource loader resolves task-local paths correctly. Adapter switched from `@sinclair/typebox` to the bare `typebox` re-export to track the upstream pi-mono package's bundled types

## [1.73.5] - 2026-05-04

### Added
- **opencode harness provider foundations** — `HARNESS_PROVIDER=opencode` is now wired into `createProviderAdapter` (#399, #400, #403, #412). Rolling out across DES-295 → DES-304:
  - **DES-295** (#399): `ProviderNameSchema` adds `"opencode"`; new `CostData.provider` discriminator (`"claude" | "codex" | "pi" | "opencode"`) so the API can route Codex's pricing-table recompute vs. trust the harness-reported `totalCostUsd`. Migration `048_agent_provider.sql` adds an `agents.provider` column for per-agent provider pinning. `openapi.json` regenerated
  - **DES-296** (#400): `fetchInstalledMcpServers` extracted from `claude-adapter.ts` into shared `src/utils/mcp-server-fetcher.ts` so non-claude adapters (opencode, future ones) can reuse the swarm-MCP install discovery
  - **DES-297** (#412): `validateOpencodeCredentials(env)` in `src/utils/credentials.ts` checks `OPENROUTER_API_KEY` → `ANTHROPIC_API_KEY` → `OPENAI_API_KEY` → `~/.local/share/opencode/auth.json` in priority order and fail-fasts at boot when none are present. `PROVIDER_CREDENTIAL_VARS` map now includes `opencode: ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]` so a worker pinned to opencode doesn't stamp unrelated credentials onto its task records
  - **DES-299** (#403): `OpencodeAdapter` + `OpencodeSession` now spin up an in-process `@opencode-ai/sdk` server, subscribe to its SSE event stream, map events to the swarm's `ProviderEvent` union, accumulate per-`AssistantMessage` cost into `CostData`, and persist every event as a `raw_log` row through `scrubSecrets`. Idempotent `abort()` closes the server cleanly
  - **DES-300** (#413): Per-task agent file for opencode plus environment isolation via `OPENCODE_CONFIG` and `OPENCODE_DATA_HOME` so concurrent opencode tasks no longer share config/state (`src/providers/opencode-adapter.ts`, tests in `src/tests/opencode-adapter.test.ts`). Supersedes the auto-closed #405 after the parent `feat/des-294-des-299` branch was deleted on #403's merge — content unchanged, only the base branch was retargeted
  - **DES-301** (#406): Self-contained opencode plugin at `plugin/opencode-plugins/agent-swarm.ts` (~290 LOC) ports every swarm hook behavior — `tool.execute.before` does the cancellation poll + ScheduleWakeup polling-block check, `tool.execute.after` heartbeats `/api/agents/<id>/heartbeat`, `experimental.chat.system.transform` injects the lead concurrent-tasks context, `experimental.session.compacting` re-injects the task goal (PreCompact parity), `event:file.edited` syncs SOUL/IDENTITY/TOOLS/CLAUDE.md and auto-indexes `/memory/` writes, `event:session.idle` does the final identity sync + session summary + `/api/sessions/<id>/close`. `OpencodeAdapter` now resolves the plugin absolute path via `import.meta.dir`, attaches it via the per-task config, and sets `SWARM_API_URL` / `SWARM_API_KEY` / `SWARM_AGENT_ID` / `SWARM_TASK_ID` / `SWARM_IS_LEAD` env vars for the spawned process (restored in `finally` to prevent cross-task contamination). `@opencode-ai/plugin@1.14.30` added as devDependency for the `Plugin` type
  - **DES-302** (#407): `Dockerfile.worker` installs the opencode CLI (`ARG OPENCODE_VERSION` + curl installer) and SDK (`ARG OPENCODE_SDK_VERSION` + `npm install -g @opencode-ai/sdk`), and copies `plugin/opencode-plugins/agent-swarm.ts` into the image at `/home/worker/.config/opencode/plugins/`. `docker-entrypoint.sh` gains an `elif HARNESS_PROVIDER=opencode` branch in the credential validation block (one of `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `~/.local/share/opencode/auth.json` must be present) and in the binary-check section. `docker-compose.example.yml` ships a commented `worker-opencode` service block as a starting point
  - **DES-303** (#409): Added `## Opencode` section, provider-comparison-table column, adapter-dispatch block, and Docker config example to `docs-site/.../guides/harness-configuration.mdx`. `docs-site/.../reference/environment-variables.mdx` adds `opencode` to the `HARNESS_PROVIDER` allowed-values plus a credentials sub-table (OPENROUTER primary, ANTHROPIC, OPENAI, `auth.json` fallback). `runbooks/harness-providers.md` gains a supported-providers summary table that includes opencode
  - **DES-304** (#410): `scripts/e2e-docker-opencode.ts` — focused end-to-end Docker smoke for the opencode harness. `basic` builds the worker image, runs an `HARNESS_PROVIDER=opencode` container, posts a write-file task, asserts `unassigned → in_progress → completed`, the resulting `/workspace/hello.txt` content, and `tasks.provider = 'opencode'`. `isolation` runs two concurrent containers and verifies independent completion plus per-task `OPENCODE_DATA_HOME` isolation. CLI flags: `--test basic|isolation`, `--skip-build`, `MODEL_OVERRIDE=…`
- **[Receipts](/docs/receipts) section in docs-site with a [Ralph Loop](/docs/receipts/workflows/ralph-loop) workflow recipe** (#411). Public JSON workflow definition at `docs-site/public/receipts/workflows/ralph-loop.json` so it can be imported via the templates flow

### Changed
- README "Multi-provider" line + docs-site Harness Configuration / Harness Providers / Environment Variables / Overview pages now list `opencode` alongside the existing five providers
- SEO-tuned descriptions on top architecture pages — overview, agents, memory (#408)
- **`db-query` MCP tool no longer lead-only** (#415) — drops the `callerAgent.isLead` gate so any authenticated agent (workers included) can issue read-only queries against the swarm DB. Unblocks the 4-week-stale worker → Linear interaction path: workers can now fetch their own `oauth_tokens` row and hit Linear's GraphQL API via the `linear-interaction` skill without round-tripping through the lead. Acknowledged trade-off: workers gain full read access to `oauth_tokens`, `configs` (still encrypted at rest), and every other DB row. Long-term path is dedicated `linear-*` MCP tools so the trust boundary can shrink back to lead-only `db-query`. HTTP `/api/db-query` remains API-key gated as before. Tool description and `MCP.md` / `docs-site/.../reference/mcp-tools.mdx` synced

### Fixed
- **Docker `Build + Publish + Deploy` workflow has been red on every push to `main` since #407** (#416, DES-294). Three latent bugs in `Dockerfile.worker` shipped together because CI's only opencode-touching signal was the build itself, which hit the version-pin failure long before the runtime issues could surface:
  1. `OPENCODE_VERSION` bumped `0.5.10 → 1.14.30` to match the `@opencode-ai/sdk` pin. `opencode.ai/install` resolves versions via `anomalyco/opencode`, whose earliest tag is `v1.3.17`. The old pin's release page 301'd (so the installer kept going) but the tarball returned a 9-byte HTTP 404 body that `tar xz` rejected with `gzip: stdin: not in gzip format`
  2. `ENV PATH="/home/worker/.opencode/bin:$PATH"` set immediately after the install — the opencode installer only patches `~/.bashrc`, so non-interactive shells (the entrypoint, gosu drops, the SDK's `cross-spawn`) missed it and `docker-entrypoint.sh:166`'s `command -v opencode` would `FATAL` in production
  3. `chown -R worker:worker /home/worker` after the root-side `npm install -g` + `qa-use install-deps` block, so opencode (running as worker uid 1001) doesn't `EACCES` on its first `mkdir /home/worker/.cache/opencode`
  Plus `MODEL_OVERRIDE` is now forwarded through `scripts/e2e-docker-opencode.ts` so the Docker test can pin a model without editing the script. Four follow-up bugs uncovered during end-to-end verification (plugin path resolves to a non-existent location in the bundled binary; `agent_tasks.provider` / `.model` and `agents.provider` / `.lastActivityAt` not persisted; runner `Failed to save cost data: 400`) are documented in `thoughts/taras/qa/2026-05-03-opencode-integration-des294.md` for separate follow-up

## [1.73.4] - 2026-04-30

### Fixed
- **Worker auto-clone leaves repos owned by `root:root`, breaking subsequent runner sessions with `fatal: detected dubious ownership`.** `docker-entrypoint.sh` runs as root until the final `gosu worker` exec, so the auto-clone block was cloning repos as root and the worker user couldn't run `git` against them on later boots. The auto-clone loop now invokes `gh repo clone` / `git pull` via `gosu worker bash -c …` so `.git` ends up owned by `worker:worker`. The `2>/dev/null` mask on `git pull` (which had been hiding this exact failure on subsequent boots) is also removed (#398)
- **Defense-in-depth: `git config --system --add safe.directory '*'` early in entrypoint** so any other root-vs-worker uid mismatch on `/workspace` (Archil/FUSE mounts, host-mounted volumes, manually-created paths) no longer trips the "dubious ownership" check (#398)
- **Slack `event_id` idempotency on the task-creation path (DES-293).** Slack retries event deliveries on 3s timeout / 5xx, so a slow handler (e.g. one that fetches thread context before calling `createTaskExtended`) was producing N duplicate task rows from a single user message — root cause of the 2026-04-30 multi-session race (1 user message → 3 task rows → 3 Researcher sessions → 3 duplicate Jira pushes). New in-memory cache `src/slack/event-dedup.ts` keyed by `body.event_id` (5-min TTL, `unref`-ed cleanup timer) is checked at the top of `app.event("message")` and the assistant `userMessage` middleware. On a hit the handler logs `dropping Slack retry: event_id=…` and returns early so Bolt acks 200 OK and Slack stops retrying. Single-process design — Socket Mode means all events flow through one WebSocket; if we ever horizontally scale the API, swap in a DB- or Redis-backed cache (#396)
- **Terminal-status idempotency in `completeTask` / `failTask` / `store-progress` (DES-292).** Re-completing or re-failing a terminal task was overwriting `output`/`finishedAt`, re-emitting `task.completed` / `task.failed` on `workflowEventBus`, inserting duplicate `task_status_change` log rows, triggering `business-use ensure` with a now-failing validator, indexing duplicate memory entries, and **creating duplicate follow-up tasks to lead** — the downstream noise from the same 2026-04-30 race. `src/be/db.ts` `completeTask` / `failTask` now early-return `null` when the task is already terminal (mirrors `cancelTask`); `src/tools/store-progress.ts` short-circuits before any side-effects with `wasNoOp: true`, so the post-transaction memory-write and follow-up-task-creation blocks are gated on `!wasNoOp`. First-call-wins (#397)
- **Partial task-ID search on the new-UI tasks list page (DES-286).** `getAllTasks` and `getTasksCount` in `src/be/db.ts` now match `(task LIKE ? OR id LIKE ?)`, and the search-input placeholder reads `Search by description or ID...`. Pasting the first 6–8 characters of a task UUID surfaces it (#394)

## [1.73.3] - 2026-04-30

### Added
- **Memory dashboard at `/memory`** in the new-UI. New router page, sidebar entry, `useMemory` hook, and shared `<CollapsibleDescription>` component. Surfaces memory entries with scope, source, tags, and per-row delete; lists agents and recent indexing activity
- **Memory HTTP API** — new `src/http/memory.ts` exposing `POST /api/memory/index`, `POST /api/memory/search`, `POST /api/memory/re-embed`, `GET /api/memory`, and `DELETE /api/memory/:id`. All routes registered via the `route()` factory and surfaced in `openapi.json` + `docs-site/content/docs/api-reference/memory.mdx`
- **Workflows-detail page improvements** in the new-UI — richer node/run rendering on `/workflows/:id` and surfaced workflow context on `/tasks/:id`

### Changed
- `scripts/seed.ts` + `scripts/seed.default.json` extended with memory + workflow fixtures used by the new dashboard

## [1.73.2] - 2026-04-30

### Changed
- Regenerated `openapi.json` and `docs-site/content/docs/api-reference/**` to track route metadata (no functional changes)

## [1.73.1] - 2026-04-30

### Fixed
- **Slack tree connectors render misaligned in Slack's proportional sans-serif font.** Box-drawing characters (`├ └ │`) shift unpredictably across glyph widths, so progress blocks looked broken under nested children. Switched to a single `↳` indent with 3-space continuation, which renders cleanly regardless of font (#392)

## [1.73.0] - 2026-04-29

### Added
- **API runtime image now ships `bun` + `python3`** so the script-workflow executor can run `ts` and `python` script nodes inside the API container. The compiled API binary doesn't include the `bun` CLI itself; the `bun` static binary is now copied from the `oven/bun:latest` builder stage (already cached in the build image) instead of re-fetched. `python3` installed via `apt-get --no-install-recommends` with apt lists cleaned. Image stays lean — only adds `python3` + the bun static binary. Repro that motivated the fix: workflow `script-backends-test` failed on `ts`/`python` nodes with `Executable not found in $PATH: "bun" / "python3"` (#391)
- **`DEFAULT_APP_URL` shared constant** at `src/utils/constants.ts` (`https://app.agent-swarm.dev`) — used as the dashboard fallback for Slack task links, workflow HITL approval URLs, and any other call sites that previously hard-coded a local default. `getTaskLink()` now always returns Slack mrkdwn link syntax (no more plain-text task IDs) by falling back to `DEFAULT_APP_URL` when `APP_URL` is unset; URL pattern updated to `/tasks/:id` to match the new-UI dashboard route. `buildProgressBlocks` now routes through `getTaskLink()` so progress headers also link out (#390, DES-283)

### Changed
- Default models updated in workflow executors (`raw-llm.ts`, `validate.ts`); regenerated `openapi.json` and `docs-site/content/docs/api-reference/**`
- Jira `initJira()` / Linear `initLinear()` now overwrite stale `oauth_apps.redirectUri` values on boot (`upsertOAuthApp` heals existing rows when `JIRA_REDIRECT_URI` / `LINEAR_REDIRECT_URI` change, including the `MCP_BASE_URL`-preferred fallback)

## [1.72.0] - 2026-04-28

### Added
- **Claude Managed Agents harness provider** (`HARNESS_PROVIDER=claude-managed`). Sessions execute in Anthropic's managed cloud sandbox; the worker becomes a thin SSE relay that maps `client.beta.sessions.events.stream` events to the swarm's `ProviderEvent` union — no LLM process, no local CLI, no skill filesystem on the worker. New one-time `claude-managed-setup` CLI creates an Anthropic-side Environment, uploads `plugin/commands/*.md` skills via `client.beta.skills.create`, creates an Agent referencing those skills, and persists `MANAGED_AGENT_ID` + `MANAGED_ENVIRONMENT_ID` to `swarm_config` (encrypted). New env vars: `MANAGED_AGENT_ID`, `MANAGED_ENVIRONMENT_ID`, `MANAGED_AGENT_MODEL` (default `claude-sonnet-4-6`), `MANAGED_GITHUB_VAULT_ID`, `MANAGED_GITHUB_TOKEN`. `MCP_BASE_URL` must be HTTPS-public (Anthropic's sandbox calls `/mcp` from the cloud) — adapter and entrypoint fail-fast otherwise. Cost computation accounts for token rates **plus** Anthropic's $0.08/session-hour runtime fee. New-UI Integrations dashboard surfaces the same config (Phase 7). Provider design rationale + SDK quirks documented in [`/docs/guides/harness-providers#claude-managed-agents`](/docs/guides/harness-providers) (#384)
- **Devin harness provider** (`HARNESS_PROVIDER=devin`). New env vars: `DEVIN_API_KEY` (cog_*), `DEVIN_ORG_ID` (org_*), `DEVIN_POLL_INTERVAL_MS` (default 15s), `DEVIN_ACU_COST_USD` (default $2.25), `DEVIN_API_BASE_URL`, `DEVIN_MAX_ACU_LIMIT`. Standalone `.env.docker-devin.example` template added (#378)
- **Per-agent + global daily cost budgets** with refusal-at-claim. New tables `agent_budgets`, `swarm_budgets`, and `agent_pricing` (migrations 046 + 047). New routes `GET /api/budgets`, `PUT /api/budgets/{agentId}`, `GET /api/pricing` plus session-cost recompute on Codex sessions. Workers honor budgets in `poll-task` / `task-action` claim gates — refused claims emit a Slack notification via `budget-refusal-notify`. Backoff timing for refused-budget retries lives in `src/utils/budget-backoff.ts` (#385)
- **Budgets + spend dashboard at `/budgets`** in the new-UI (DES-278). New router page, sidebar entry, `useBudgets` hook, and `useIntegrationsMeta` API client wiring. Surfaces global + per-agent budgets, current spend, and refusal events (#386)
- New CLI command `claude-managed-setup` (run from your laptop) — bootstraps the Anthropic-side Agent + Environment and persists IDs to `swarm_config`. `--force` recreates from scratch
- New CLI command `codex-login` — interactive ChatGPT OAuth bootstrap for Codex workers (refactored out of the in-tree Codex setup)

### Changed
- `package.json` version bump to `1.72.0`; regenerated `openapi.json` and `docs-site/content/docs/api-reference/**`
- `runner.ts` claim path now consults the budget-admission gate before promoting `pending` → `in_progress`; refusal records a session-cost row with `cost_source = "refusal"`
- README "Multi-provider" line now lists Claude Code, Codex, pi-mono, **Devin**, and **Claude Managed Agents**

## [1.71.2] - 2026-04-28

### Fixed
- `initJira()` / `initLinear()` now prefer `MCP_BASE_URL` over the localhost default when `JIRA_REDIRECT_URI` / `LINEAR_REDIRECT_URI` are unset. The previous fallback was being persisted into `oauth_apps.redirectUri` and used verbatim by the OAuth authorize flow, so prod was sending users back to `http://localhost:3013/...` after Atlassian/Linear consent — even though the UI displayed the correct request-derived URL. Existing rows are healed automatically by `upsertOAuthApp` on next boot

## [1.71.1] - 2026-04-27

### Added
- `DELETE /api/trackers/jira/disconnect` and `DELETE /api/trackers/linear/disconnect` — Jira disconnect deletes registered webhooks, OAuth tokens, and metadata; Linear revokes upstream and drops tokens. Both endpoints surface in the Integrations UI as a "Disconnect" button next to the OAuth status
- `/status` responses for both Jira and Linear now include the computed `redirectUri` so the OAuth cards can render it with a copy button. The `JIRA_REDIRECT_URI` / `LINEAR_REDIRECT_URI` form fields were removed (env vars still work as overrides)

### Changed
- OAuth flow opens in a new tab via `window.open` so the dashboard context survives the round-trip; status auto-refreshes on focus
- Webhook/redirect base URL is now derived from the inbound request when `MCP_BASE_URL` is unset; boot warns when `MCP_BASE_URL == APP_URL` (the prod misconfig)

### Fixed
- Jira/Linear "not configured" alert chips no longer wrap mid-pill on narrow viewports (`whitespace-nowrap` + extracted `CodeChip` helper)
- shadcn `AlertDescription` rendered each `<code>` chip on its own grid row because of `display: grid; gap-1`. Wrapping inline content in a single `<p>` collapses children into one grid item so chips flow inline as intended

## [1.71.0] - 2026-04-27

### Added
- **Jira Cloud integration** — full OAuth 3LO authorization code flow against `api.atlassian.com`, cloudId resolution via `/oauth/token/accessible-resources`, and a typed `jiraFetch()` that prepends `/ex/jira/{cloudId}`, refreshes on 401, and respects 429 `Retry-After`. New routes: `GET /authorize`, `GET /callback`, `GET /status`, `POST /webhook/:token`, `POST /api/trackers/jira/webhook-register`, `DELETE /api/trackers/jira/webhook/:id`. Inbound: assignee→bot transitions and @-mention comments create swarm tasks; outbound: lifecycle events (`task.created/completed/failed/cancelled`) post unicode-emoji plaintext comments back to the originating issue. Webhook auth uses URL-path token (timing-safe compare) — Atlassian doesn't HMAC-sign OAuth 3LO dynamic webhooks (Errata I8). Webhook keepalive runs every 12h and refreshes any registration with <7d to expiry. New ADF (Atlassian Document Format) recursive walker for inbound comment/issue body parsing. Migration `043_jira_source.sql` adds `jira` to the `agent_tasks` source CHECK constraint. 57 new unit tests across `jira-metadata`, `jira-webhook`, `jira-sync`, `jira-oauth`, `jira-outbound-sync`, `jira-webhook-lifecycle`. Full integration guide at [`/docs/guides/jira-integration`](/docs/guides/jira-integration). New Integrations UI card with cloudId/siteUrl/scope/expiry/webhook count + copyable redirect URL (#382)
- New tracker provider `jira` is now recognized by `tracker-status`, `tracker-link-task`, `tracker-map-agent`, and `tracker-sync-status` MCP tools

### Fixed
- `botAccountId` cache moved to a `globalThis`-keyed slot so all module instances share the same value across cache-busting dynamic imports under `bun:test`'s parallel file runner. Fixes a CI-only test-isolation gap in `jira-sync.test.ts`
- Two test files using `mock.module` on real modules (`jira-oauth.test.ts` mocking `oauth/wrapper`, `jira-webhook.test.ts` mocking `jira/sync`) switched to `spyOn` against namespace imports — `mock.module` overrides leak across the test process and broke victim files when bun:test's parallel-file order put the mocking file first

## [1.70.0] - 2026-04-24

### Added
- Uniform `contextKey` column on `agent_tasks` populated at every task-ingress site (Slack, AgentMail, GitHub, GitLab, Linear, scheduler, workflow, `send-task`). Schema: `task:slack:{channelId}:{threadTs}`, `task:agentmail:{threadId}`, `task:trackers:github:{owner}:{repo}:{issue|pr}:{number}`, `task:trackers:gitlab:{projectId}:{mr|issue}:{iid}`, `task:trackers:linear:{issueIdentifier}`, `task:schedule:{scheduleId}`, `task:workflow:{workflowRunId}`. Migration 041 adds nullable `contextKey` plus `(contextKey, status)` composite index. Child tasks auto-inherit from parent via `parentTaskId` (#358)
- Cross-ingress sibling-task awareness (phase 2): reader-side prompt injection surfaces sibling/parent tasks sharing the same `contextKey` so workers see related work across ingress paths. Includes additive `ADDITIVE_SLACK` buffer generalization and Linear hard-refuse UX fix (#359)
- New harness-providers guide at [`/docs/guides/harness-providers`](/docs/guides/harness-providers) covering the `ProviderAdapter` contract, task↔session lifecycle, raw session-log pipeline, swarm-MCP exposure, system-prompt composition/delivery, skills handling, and a 15-step walkthrough grounded in the claude / pi / codex reference adapters (`docs-site/content/docs/(documentation)/guides/harness-providers.mdx`)
- `slack-post` gains an optional `threadTs` parameter so the lead can post threaded replies under an existing message, and a sibling `slack-start-thread` tool posts a top-level message and returns `{ channelId, ts }` so subsequent `slack-post` calls can thread under it. Unblocks daily-digest flows where the parent is a summary and the body is an in-thread reply (#373)
- `GET /api/mcp-oauth/{id}/authorize-url` returns `{ providerUrl }` (Bearer-authed) so the dashboard Connect flow can XHR-then-navigate and keep Bearer auth on the authed endpoint while letting the browser follow the provider redirect directly (#372)

### Fixed
- `core.ts` HTTP middleware now honors per-route `auth: { apiKey: false }` via a `routeRegistry` lookup instead of a hardcoded exception list, so `/api/mcp-oauth/callback` and other opt-out routes no longer 401 on API_KEY swarms. Unknown paths still fail closed. Adds middleware unit tests (#367, #372)
- Docker entrypoint no longer inlines MCP credentials (OAuth Bearers, static headers, env-backed secrets) into `/workspace/.mcp.json` at boot; it now only uses installed-server names to seed `settings.json` permission patterns. The per-session merge in `claude-adapter.ts` is extracted into a pure `mergeMcpConfig` and flipped so installed servers from the API **override** on-disk entries, restoring the "resolve at dispatch time" guarantee from 1.69.0 so OAuth re-auth, secret rotation, and install/uninstall propagate without worker restart. 8 new unit tests cover precedence, uninstall propagation, and staleness (#369, #371)
- MCP OAuth `Authorization` header now normalizes `token_type: "bearer"` to capital `Bearer`, so providers like Amplitude's MCP (which reject the RFC 6749 lowercase form despite RFC 6750 being case-insensitive) accept the token. Non-bearer schemes pass through verbatim (#370)
- `update-profile` tool now gates `Bun.write("/workspace/SOUL.md" | "/workspace/IDENTITY.md")` on `requestInfo.agentId === process.env.AGENT_ID`, so test-suite fake `WORKER_ID`s no longer overwrite a real container's identity files. Also raises `IDENTITY_FILE_MIN_LENGTH` in `src/hooks/hook.ts` from 100 → 500 as defense-in-depth against the Stop hook syncing short sentinel writes back into the DB (#374)

## [1.69.1] - 2026-04-23

### Added
- `ENABLE_PROMPT_CACHING_1H=1` is now set by default for every Claude Code session spawned via `ClaudeAdapter`. Opt out via `swarm_config` or environment (`ENABLE_PROMPT_CACHING_1H=0`). Regenerated `openapi.json` + API reference pages for the version bump

## [1.69.0] - 2026-04-22

### Added
- **OAuth 2.0 MCP support for headless swarms** — end-to-end support for OAuth 2.0-protected MCP servers running inside worker containers. Workers resolve a valid access token at dispatch time (refreshing on expiry), inject it into the provider config, and propagate token-refresh failures back to the task without leaking tokens into logs or prompts (#357)
- `POST /api/mcp-oauth/{mcpServerId}/authorize` / `GET /api/mcp-oauth/callback` — browser-driven OAuth authorization code flow for user-scoped MCP servers (#357)
- `POST /api/mcp-oauth/{mcpServerId}/manual-client` — operator-supplied client credentials for MCP servers that don't implement dynamic client registration (#357)
- `GET /api/mcp-oauth/{mcpServerId}/metadata` / `GET /api/mcp-oauth/{mcpServerId}/status` — metadata discovery (RFC 8414) and per-server OAuth status for the Integrations UI (#357)
- `POST /api/mcp-oauth/{mcpServerId}/refresh` / `DELETE /api/mcp-oauth/{mcpServerId}` — manual refresh and revocation endpoints (#357)
- New MCP OAuth panel in the dashboard (`new-ui/src/pages/mcp-servers/[id]/mcp-oauth-panel.tsx`) for authorize / refresh / revoke / manual-client management, with live status from `use-mcp-oauth.ts` (#357)
- Encrypted-at-rest OAuth token storage via migration `041_mcp_oauth_tokens.sql`, reusing the `swarm_config` AES-256-GCM encryption key; access tokens are never returned over HTTP (#357)
- Dummy OAuth MCP server reference implementation at `scripts/dummy-oauth-mcp/` for local testing of the full flow (authorization code, PKCE, dynamic client registration, refresh) (#357)
- 1100+ lines of new test coverage across `src/tests/mcp-oauth-*.test.ts` (queries, resolve-secrets, ensure-token, wrapper) (#357)

## [1.68.0] - 2026-04-22

### Added
- New `/integrations` dashboard page that lets operators configure third-party integrations (Slack, GitHub, GitLab, Linear, Sentry, AgentMail, Anthropic, OpenRouter, OpenAI, Codex, business-use) without hand-editing `.env`. Frontend-only catalog in `new-ui/src/lib/integrations-catalog.ts`, one form field per known `swarm_config` key, with labels, help text, docs links, and category/search filters (#364)
- `POST /api/config/reload` — thin wrapper over the existing `/internal/reload-config` so the Integrations UI can apply saved values live (re-inits AgentMail, GitHub, Linear, stops/starts Slack socket mode) without a process restart (#364)
- `GET /api/config/env-presence?keys=K1,K2,...` — returns `{ presence: { KEY: boolean } }` so the UI can surface which values come from the deployment env vs the DB without ever pushing raw env values to the browser (#364)
- Per-field **Replace** / **Clear** affordances on the Integrations detail page. Secrets render masked (`••••••`); non-secret values (emails, channel names, flags) edit in place. Save auto-invokes reload and toasts which integrations were re-initialized (#364)
- Source chips on each field: `db+env` (live), `env (deploy)` (no DB row), `db (pending reload)` — rendered via shadcn Tooltip for fast hover reveal. Collapsible legend on the list page explains every chip (#364)

### Changed
- Sidebar restructured: Chat and Services hidden (routes still accessible); new **AI** group (Skills, MCP Servers); new **Configuration** group (Integrations, Templates, Approvals, Repos). Breadcrumbs now resolve integration ids to display names (`github` → "GitHub") and include proper-case labels for Integrations and API Keys (#364)
- Toaster references the correct Tailwind v4 CSS vars (`--color-popover` instead of `--popover`) and pins `!bg-popover` so toasts are opaque instead of translucent (#364)

## [1.67.5] - 2026-04-22

### Added
- Centralized secret scrubber (`src/utils/secret-scrubber.ts`) that replaces sensitive env values and known-shape tokens (GitHub PATs, Anthropic/OpenAI/OpenRouter `sk-*` keys, Slack `xox*`, JWTs, AWS access keys, Google API keys) with `[REDACTED:<name>]` markers at every text-egress point — adapter log files, `session_logs` writes, pretty-printed stdout, stderr dumps — so credentials never leak into `/workspace/logs/*.jsonl`, the `session_logs` SQLite table, or container stdout shipped to log aggregators (#363)
- `CLAUDE.md` contributor note directing future code that logs/prints/transports sensitive values to wrap emitted strings with `scrubSecrets()` at the egress point (#363)

## [1.67.4] - 2026-04-21

### Fixed
- Slack thread follow-ups that `@`-mention a different user/bot (e.g. `@Devin wdyt?`) no longer create spurious tasks for the swarm agent. Both the router thread-follow-up branch (`src/slack/router.ts`) and the `ADDITIVE_SLACK` buffer branch (`src/slack/handlers.ts`) now use a new `hasOtherUserMention()` helper and bail when the message mentions another `<@U...>` and does not mention our bot (#355)

## [1.67.3] - 2026-04-21

### Added
- `PRAGMA busy_timeout = 5000` on every SQLite connection (`src/be/db.ts`, applied on both fresh-DB and `Database.deserialize` paths) so concurrent writer contention (heartbeat sweep vs. `/ping`, `/close`, agent registration) waits out the lock instead of failing instantly with `SQLITE_BUSY` (#354)
- Process-level `uncaughtException` / `unhandledRejection` log-and-continue handlers in `src/http/index.ts` as defense-in-depth against a single bad request taking the API pod down (#354)
- Composite index on `agent_tasks(slackChannelId, slackThreadTs, status)` (migration 040) to speed up Slack thread lookups used by the follow-up re-delegation guard (#345)
- Hero wireframe video back in `README.md` plus reproducible Remotion source in `assets/video-source/` (two compositions: daily-evolution and slack-to-pr) (#350)

### Changed
- Removed hardcoded seed users from migration 031; added `scripts/backfill-seed-users.sql` for manual re-seeding (#343)
- Lead agent session template now references `manage-user` tool for registering unknown users from Slack (#343)
- Lead session prompt and `task.worker.completed` / `task.worker.failed` templates updated to explicitly forbid re-delegating follow-up results back to a worker (#345)

### Fixed
- API server no longer crashes with an unhandled `SQLiteError: database is locked` when heartbeat and HTTP writers race on the `agents` row — `busy_timeout` plus process-level guards together stop a single lock collision from failing every in-flight request (#354)
- Duplicate Slack responses caused by the lead re-delegating follow-up tasks: `send-task` now blocks re-delegation when the thread already has a completed task within the last 48 hours, and the follow-up template discourages it at the prompt layer (#345)

## [1.67.2] - 2026-04-17

### Added
- `sqlite-vec` native extension bundled in Docker server image for vector similarity search; new `SQLITE_VEC_EXTENSION_PATH` env var points at the extension inside the container

### Changed
- Bumped bundled Claude Code CLI version in `Dockerfile.worker` from 2.1.109 to 2.1.112

## [1.67.1] - 2026-04-15

### Fixed
- `SECRETS_ENCRYPTION_KEY` / `SECRETS_ENCRYPTION_KEY_FILE` / on-disk `.encryption-key` now also accept a 64-character hex-encoded 32-byte key (e.g. `openssl rand -hex 32`) in addition to the existing base64 format. Existing base64 keys keep working unchanged.
- Invalid-key errors now include the exact generation commands (`openssl rand -base64 32` or `openssl rand -hex 32`) and call out the common `openssl rand -base64 39` mistake, instead of just reporting the byte count.

### Docs
- New **Encryption Key** section in the Docker Compose deployment guide covering resolution order, generation, backup, common mistakes, and first-time migration from plaintext
- `SECRETS_ENCRYPTION_KEY` and `SECRETS_ENCRYPTION_KEY_FILE` added to the Environment Variables reference

## [1.67.0] - 2026-04-14

### Added
- Encrypted-at-rest storage for `swarm_config` `isSecret=1` rows using AES-256-GCM
- New `SECRETS_ENCRYPTION_KEY` / `SECRETS_ENCRYPTION_KEY_FILE` env vars for providing the master key (otherwise auto-generated at `<data-dir>/.encryption-key` only when the DB does not yet contain encrypted secret rows — e.g. a fresh DB or first upgrade from plaintext-only secrets)
- Auto-migration of legacy plaintext secrets to ciphertext on first boot after upgrade

### Security
- `swarm_config` API now rejects reserved keys `API_KEY` and `SECRETS_ENCRYPTION_KEY` (case-insensitive) at the HTTP, MCP, and DB layers — these remain environment-only and can no longer be stored in the SQLite config store
- Secrets are no longer stored as plaintext in `agent-swarm-db.sqlite`; on-disk rows carry only base64-encoded AES-256-GCM payloads of `iv || ciphertext || authTag`

### Operator notes
- Upgrade is transparent as long as the same encryption key remains available across restarts; legacy plaintext secrets are auto-migrated on first boot after upgrade
- Existing databases that already contain encrypted secret rows now fail closed if the encryption key is missing, instead of silently auto-generating a different key
- **First-time migration safety:** If upgrading from plaintext without `SECRETS_ENCRYPTION_KEY` set, a one-time plaintext backup is created at `<db-path>.backup.secrets-YYYY-MM-DD.env` before encryption. **Delete this file after verifying your encryption key is backed up.**
- **Back up and preserve the actual encryption key material alongside your SQLite DB** — whether it comes from `SECRETS_ENCRYPTION_KEY`, `SECRETS_ENCRYPTION_KEY_FILE`, or an auto-generated `.encryption-key`. Losing that key means losing all encrypted secrets with no recovery path
- Do not switch between env/file/auto-generated key sources unless the underlying base64 key value is identical
- Key rotation is not yet supported (follow-up release)

## [1.66.0] - 2026-04-13

### Added
- `swarmVersion` column on `agent_tasks` — each task is stamped with the current package.json version at creation time, enabling benchmarking agent performance (cost, duration, tokens) across releases (#332)
- Task detail page shows "Swarm version" metadata row in the dashboard (#332)

### Changed
- Version bump 1.65.0 → 1.66.0 to mark the benchmarking tracking boundary (#332)

## [1.65.0] - 2026-04-12

### Added
- Memory TTL support — memories can now have an `expiresAt` field; expired memories are automatically excluded from search results (#327)
- Memory staleness management with access tracking — `accessCount` field tracks how often a memory is retrieved, enabling recency-aware reranking (#327)
- `memory-delete` MCP tool for explicit memory removal (#327)
- Memory provider abstraction layer (`EmbeddingProvider`, `MemoryStore` interfaces) for pluggable storage and embedding backends (#327)
- Memory reranker combining vector similarity, recency decay, and access frequency into a unified relevance score (#327)

### Changed
- Memory system refactored from monolithic `db.ts` functions into modular `src/be/memory/` provider architecture with SQLite+sqlite-vec store and OpenAI embedding provider (#327)
- `memory-search` now uses the reranker pipeline for improved result quality (#327)
- `inject-learning` and `store-progress` updated to support new memory metadata fields (#327)

## [1.64.1] - 2026-04-11

### Added
- Anonymized telemetry integration — tracks high-level task lifecycle events (created, started, completed, failed, cancelled), server start, and worker session start/end. Opt-out via `ANONYMIZED_TELEMETRY=false` (#325)

### Fixed
- Rate limit detection now matches "hit your limit" error messages in addition to existing patterns (#324)
- Workflow `mustPass` validation failures now cancel only the failed branch's downstream nodes instead of the entire workflow run; parallel/sibling branches continue executing (#322)
- Published package now includes `tsconfig.json`

## [1.64.0] - 2026-04-10

### Changed
- Release cut after merging the latest `main`, carrying forward the Codex ChatGPT OAuth support, provider-auth documentation, and telemetry updates already landed on this branch.

## [1.63.1] - 2026-04-10

### Added
- `agent-swarm codex-login` now supports an interactive ChatGPT OAuth flow for Codex workers: it prompts for the target swarm API URL, uses best-effort masked API key input, stores credentials as the global `codex_oauth` config entry, and documents the laptop-to-Docker-Compose restore flow for deployed swarms.

### Fixed
- Codex Docker workers now convert stored `codex_oauth` credentials into the real `~/.codex/auth.json` format expected by the Codex CLI, so ChatGPT OAuth works after container boot without `OPENAI_API_KEY`.
- Codex tasks authenticated through ChatGPT OAuth now stamp `credentialKeyType=CODEX_OAUTH`, so the API Keys dashboard and cost tracking surfaces show OAuth-backed Codex usage alongside other credential types.

## [1.63.0] - 2026-04-09

### Added
- **Codex provider** — Run agents with OpenAI Codex via `HARNESS_PROVIDER=codex`. Wraps `@openai/codex-sdk` 0.118 to drive the `codex app-server` JSON-RPC protocol. Includes per-session MCP config (Streamable HTTP), slash-command skill inlining, AGENTS.md system-prompt injection, AbortController-based cancellation, tool-loop detection, heartbeat/activity reporting, and a typed model catalogue (gpt-5.4 default). Auth via `OPENAI_API_KEY` or `~/.codex/auth.json` (#100)
- Docker worker image installs the Codex CLI (`@openai/codex@0.118.0`) alongside Claude and pi-mono and ships a baseline `~/.codex/config.toml`; entrypoint validates codex auth, bootstraps `~/.codex/auth.json` from `OPENAI_API_KEY` via `codex login --with-api-key` at boot (idempotent), and mirrors slash-command skills into `~/.codex/skills/<name>/SKILL.md` (#100)
- Per-model pricing table for Codex models in `src/providers/codex-models.ts` (gpt-5.4, gpt-5.4-mini, gpt-5.3-codex, gpt-5.2-codex) sourced from developers.openai.com/api/docs/pricing — codex tasks now record real `totalCostUsd` in `session_costs` and contribute to dashboard cost summaries (#100)
- `name` and `provider` columns on the `api_key_status` table — pooled credentials now carry an auto-derived harness provider (claude/pi/codex) and an optional human-friendly label settable from the dashboard. New `PATCH /api/keys/name` endpoint and the API Keys page in the dashboard gains a Name column (click to rename via Dialog) and a Provider dropdown filter (#100)
- Provider-aware credential pooling — `resolveCredentialPools` accepts a `provider` hint and only pools env vars relevant to the active harness, so a codex worker no longer stamps a stale `CLAUDE_CODE_OAUTH_TOKEN` on its task records (#100)
- Codex `[context-overflow]` failure rewrite — when a codex turn hits the context window, the failure message is rewritten with a clear prefix and points users at Linear DES-143 for the auto-compaction follow-up. Codex `reasoning`, `todo_list`, and `agent_message` deltas now flow as `custom` ProviderEvents (`codex.reasoning`, `codex.todo_list`, `codex.message_delta`) so future UI surfaces can render them without raw_log scraping (#100)
- `scripts/e2e-docker-provider.ts` now supports `--provider codex` and `--provider all` (claude+pi+codex) for end-to-end Docker testing (#100)
- Codex log support in the dashboard's session log viewer — `parseSessionLogs` dispatches on `cli === "codex"` and maps Codex's `item.completed` events (`agent_message`, `mcp_tool_call`, `command_execution`, `reasoning`, `file_change`, `web_search`, `todo_list`) to the same ContentBlock schema used by claude/pi (#100)
- Slack message deduplication with `slackReplySent` flag — when agents post results via `slack-reply`, the task completion message shows a minimal one-liner instead of duplicating the full output (#314)
- Tree-based Slack status messages — parent tasks render child task progress in a visual tree with status icons, indentation, and overflow handling (#314)
- Slack thread buffer (`ADDITIVE_SLACK=true`) — non-mention thread replies are captured, debounced, and batched into a single follow-up task with dependency chaining (#314)
- `!now` command in Slack threads to flush the additive buffer immediately without dependency chaining (#314)
- `SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION` env var — when `true`, thread follow-up routing and additive buffering require an explicit @mention (#313)
- `slackChannelId`, `slackThreadTs`, `slackUserId` parameters on `send-task` MCP tool for explicit Slack context propagation (#314)
- GitHub eyes reaction (👀) automatically added when agents pick up GitHub-sourced tasks — supports issue comments, PR review comments, PR reviews, and issue/PR bodies (#310)
- Discoverability Optimizer agent template added to `docker-compose.example.yml` (#311)

### Fixed
- Codex adapter `peakContextPercent` no longer clamps to 100% on chatty turns — the SDK reports `input_tokens` as per-turn-cumulative across every model invocation (with cached portions counted at every roundtrip), which routinely exceeds the model's context window even when no individual call did. New formula uses `(input - cached + output) / window` as a peak proxy (#100)
- Codex adapter `contextPercent` is now emitted on the same 0-100 scale as claude/pi (was 0-1 fraction), so the dashboard's `Peak %` cell renders correctly via `.toFixed(0)` (#100)
- Dashboard `model` badge falls back to `costs[0]?.model` when `task.model` is null — codex tasks created without an explicit model in the POST body now display the actual model used (recorded by the runner in `session_costs`) (#100)
- DataGrid wrapper auto-detects editable columns and only suppresses cell focus when none are present — read-only tables are unaffected, editable columns can now take focus (#100)
- Codex SDK binary path resolved via `CODEX_PATH_OVERRIDE` env var (`/usr/bin/codex` in the Docker image) — the bundled SDK can no longer `require.resolve("@openai/codex")` from inside a Bun-compiled executable, so the override sidesteps the failure (#100)

### Changed
- Slack completion messages now conditionally show minimal or full output based on whether the agent already posted via `slack-reply` (#314)
- Buffer flush messages show dependency status ("queued pending completion" vs "batched into task") (#314)

## [1.59.3] - 2026-04-08

### Fixed
- Slack assistant thread: `file_share` messages now correctly route to the lead agent instead of being silently dropped (DES-138, #304)
- Slack assistant `setStatus`/`setTitle` calls wrapped with error handling to prevent crashes in non-assistant threads

### Changed
- `registerRegisterAgentMailInboxTool` renamed to `registerRegisterAgentmailInboxTool` for naming consistency
- Docker Compose example updated: content reviewer worker now uses `pi` harness provider with `moonshotai/kimi-k2.5` model via OpenRouter
- MCP.md regenerated to reflect tool registration changes

## [1.59.2] - 2026-04-07

### Changed
- Slack tools (`slack-reply`, `slack-read`) moved from core to deferred — only loaded when task has Slack context (#298)
- Slack prompt instructions now conditionally injected via `system.agent.worker.slack` template only for Slack-originated tasks (#298)
- New `system.agent.code_quality` template added to all session composites for repository guidelines enforcement (#298)
- Repository guidelines (PR checks, merge policy, review guidance) now injected into system prompt from per-repo configuration (#298)
- `get-repos` and `update-repo` tools added to deferred tools set (#294)

### Fixed
- Repos edit modal and added repository detail page in dashboard UI (#301)
- Task table sort state now preserved across data refreshes (#300)
- Schedule UI showing wrong "Runs At" time for future dates (#299)
- Slack template variables now use `VariableDefinition` type for proper validation (#298)

## [1.59.0] - 2026-04-04

### Added
- Unified user identity system — canonical user registry with cross-platform resolution across Slack, GitHub, GitLab, Linear, and email (DES-51, #287)
- `resolve-user` MCP tool for looking up user profiles by any platform identifier
- `manage-user` MCP tool for lead-only CRUD operations on user profiles
- Per-repo guidelines system — configurable PR checks, merge policy, and review guidance per repository (#294)
- `get-repos` and `update-repo` MCP tools for lead repo management with guidelines
- Requesting user identity surfaced in task details and agent prompts (#292)
- User management skill for creating and managing user profiles across platforms

### Changed
- Slack, GitHub, GitLab, and AgentMail handlers now resolve requesting user identity and attach it to tasks
- UX principles template generalized — replaced Desplega-specific references with placeholders

### Fixed
- Heartbeat system: aggressive reboot sweep and boot triage improvements
- `allowMerge` edge case in repo guidelines and removed type duplication
- `requestedBy` added to Trigger interface, removing double cast workaround

## [1.57.5] - 2026-04-02

### Added
- Auto-generated `llms.txt` for AI discoverability on the landing page (#283)

### Changed
- Runner structured output fallback refactored with discriminated union `FallbackResult` type for clearer error handling
- Dockerfile worker: updated plugin install commands and bumped `qa-use` to v2.11.0

### Fixed
- Workflow engine routes to correct port after validation instead of broadcasting to all ports (#280)
- Workflow script nodes now parse JSON stdout correctly for interpolation (#279)
- PostToolUse hook now validates minimum content length (100 chars) for SOUL.md/IDENTITY.md sync to prevent accidental profile corruption (#278)
- Bun test failure and typecheck error in test infrastructure (#281)

## [1.57.0] - 2026-03-31

### Added
- API key rate limit tracking and automatic rotation — tracks per-key rate limits, extracts reset times from Claude error messages, and rotates to available keys (#274)
- API Keys dashboard page with summary cards for monitoring rate limit status
- API key reference documentation and OpenAPI spec updates

### Changed
- `update-profile` tool now enforces minimum 200 character length for `soulMd` and `identityMd` fields to prevent accidental profile corruption (#272)
- Rate-limit availability fetch moved into `resolveCredentialPools` helper for cleaner code organization

### Fixed
- Profile min-length validation added server-side after repeated client-side failures (#272)
- Rate limit reset time extraction from Claude error messages

## [1.56.5] - 2026-03-30

### Changed
- GitHub event handling restricted to explicit human actions — PR closed/synchronize, reviews, CI checks are now suppressed by default to prevent cascade auto-merge behavior

## [1.56.3] - 2026-03-30

### Changed
- GitHub event handling restricted to explicit human actions — PR closed/synchronize, reviews, CI checks are now suppressed by default to prevent cascade auto-merge behavior
- New `GITHUB_EVENT_LABELS` env var (default: `swarm-review`) — label-based triggers for PR and issue events
- Heartbeat system rewritten with checklist-based approach and improved stall detection
- Session templates support added to hook system for dynamic prompt injection
- `maxTasks` schema limit increased to 100 in `get-swarm` output validation (DES-20)

## [1.55.0] - 2026-03-29

### Added
- `patch-workflow` MCP tool — partially update workflow definitions by creating, updating, or deleting individual nodes with automatic version snapshots
- `patch-workflow-node` MCP tool — partially update a single node in a workflow definition with automatic version snapshots
- `cancel-workflow-run` MCP tool — cancel running or waiting workflow runs, including all non-terminal steps and associated tasks (#265)
- Per-node `timeoutMs` support in workflow config — set custom timeouts for individual workflow nodes (#261)

### Removed
- Epics system deprecated — all epic MCP tools removed (`create-epic`, `get-epic-details`, `list-epics`, `update-epic`, `delete-epic`, `assign-task-to-epic`, `unassign-task-from-epic`, `tracker-link-epic`). Use workflows for multi-task orchestration instead
- `epicId` parameter removed from `send-task` and `store-progress` tools

### Fixed
- Workflow engine safeguards — cooldown periods, circuit breaker, and rate-limit detection to prevent runaway execution (#264)
- `validate` executor strict JSON schema disabled for OpenRouter compatibility (#263)
- `raw-llm` executor strict JSON schema disabled for OpenRouter compatibility (#262)

## [1.54.1] - 2026-03-27

### Added
- Stalled task auto-remediation and lead startup self-check — lead agent now triggers a heartbeat sweep on startup to detect and recover stalled tasks (DES-19, #256)
- `jq` added to API server Docker image for script node JSON parsing (#254)

### Fixed
- HITL loop resume — use successor routing instead of `findReadyNodes` for correct workflow loop re-entry (#257)
- Workflow engine loop support — iteration-aware idempotency keys allow workflows with cycles to re-execute nodes correctly (#255)
- HITL port-based routing for workflow resume — use port routing instead of direct node targeting (#253)
- Task details prompt expansion overflow — prevent large task descriptions from exceeding prompt limits (#258)
- Create follow-up tasks for already-tracked Linear issues (#252)
- Preserve context usage value on task completion (#251)
- Tool call progress normalization — handle case-insensitive tool names from different providers (pi-mono vs Claude)
- Store-progress dependency tracking for paused/resumed tasks

### Changed
- Deployment guide rewritten with step-by-step quick start, expanded volume architecture, and adding-workers instructions
- OpenAPI spec updated with HITL port-routing unit tests

## [1.53.0] - 2026-03-26

### Added
- MCP server management for agents — 7 new tools (`mcp-server-create`, `mcp-server-get`, `mcp-server-list`, `mcp-server-update`, `mcp-server-install`, `mcp-server-uninstall`, `mcp-server-delete`) with scope cascade (agent → swarm → global) and auto-injection into worker Docker containers (#248)
- Context usage tracking — monitor context window utilization and compaction events per task with `POST/GET /api/tasks/:id/context` endpoints, context extraction from Claude adapter and pi-mono, and visual indicators in task details (#247)
- Generic events table for tool/skill/session tracking (#246)
- Configurable DB seeding script with faker.js for realistic test data (DES-11, #245)
- Slack notifications dispatched when HITL approval requests are created (#241)
- Auto VCS PR number tracking for tasks
- Session log viewer UI redesign with markdown rendering, JSON tree, and visual polish
- Skill-check step added to `work-on-task` command (#249)

### Fixed
- `tracker-status` tool crash with undefined `req.requestInfo` (#243)
- Linear OAuth token auto-refresh (#244)
- Flaky CI test failures from shared mutable state race conditions
- Mock `slack/app` in workflow executor tests to prevent CI flake
- Use `tsc -b` for new-ui typecheck in CI and pre-push hook

### Changed
- Opus/Sonnet context window updated to 1M tokens

## [1.52.0] - 2026-03-25

### Added
- Skill system — full lifecycle for reusable procedural knowledge: create, install, publish, search, sync remote skills from GitHub repositories (#229)
  - Phases 1-6: data layer, API, filesystem bridge, system prompt injection, UI, and OpenAPI spec
  - 12 new MCP tools: `skill-create`, `skill-get`, `skill-list`, `skill-search`, `skill-install`, `skill-uninstall`, `skill-update`, `skill-publish`, `skill-delete`, `skill-install-remote`, `skill-sync-remote`
  - Scope resolution: agent → swarm → global
- Human-in-the-Loop (HITL) workflow executor — pause workflows for human approval or input via the dashboard (#228)
  - `request-human-input` MCP tool with support for approval, text, single-select, multi-select, and boolean question types
  - Approval requests UI at `/approval-requests/{id}`
  - Follow-up task auto-creation when approval requests are resolved (#234)
- Business-use instrumentation — track core system invariants across API + worker architecture via `@desplega.ai/business-use` (#237)
  - Task lifecycle, agent registration, and API boot flows
  - Optional: enters no-op mode when `BUSINESS_USE_API_KEY` is not set

### Fixed
- Server-side fallback for `sourceTaskId` on HITL approval requests (#238)
- Walk up directory tree to find `.mcp.json` for `X-Source-Task-Id` injection (#236)
- Explicit Slack metadata on HITL follow-up tasks (#235)
- Correct approval request URL path from `/requests/` to `/approval-requests/` (#233)
- Prevent runner crash when repo clone fails (#232)

## [1.51.0] - 2026-03-23

### Added
- Bot name aliases for GitHub @mentions via `GITHUB_BOT_ALIASES` env var — comma-separated list of alternative names that trigger the bot alongside `GITHUB_BOT_NAME` (#211)
- Channel activity poll trigger — lead agent can poll for new Slack channel messages since last cursor, enabling event-driven workflows (#218)
- Lead agents can now update any worker's profile via `update-profile` tool with the new `agentId` parameter (#225)
- Dynamic docs sitemap generation and 20 new documentation pages (#224)

### Fixed
- Session logs stored under wrong task ID after auto-claim pool task changes — removed redundant reassociation logic in `store-progress` (#226)
- Skip workflow-managed tasks from creating follow-up lead tasks — workflow engine handles sequencing via `resume.ts` (#226)

## [1.50.0] - 2026-03-23

### Added
- Workflow fan-out support — `next` field now accepts `string[]` for parallel execution of multiple nodes (#220)
- Configurable `onNodeFailure` on workflow definitions — `"fail"` (default) or `"continue"` to proceed with partial results (#220)
- Convergence gating — downstream nodes automatically wait for all fan-out predecessors to complete before executing (#220)
- Step deduplication — prevents duplicate steps when async tasks resume into convergence nodes (#220)
- Auto-claim for pool tasks — workers atomically claim unassigned tasks during poll instead of receiving notifications (#222)
- Session log reassociation for pool tasks — logs from pool trigger sessions are correctly linked to the real task ID (#222)
- `runnerSessionId` field on active sessions for session log tracking (#222)
- Active sessions API endpoint for updating provider session ID (`PUT /api/active-sessions/provider-session/{taskId}`) (#222)
- Schedule→Workflow triggering — when a schedule fires and an enabled workflow references that schedule in its `triggers` array, the workflow executes instead of creating a standalone task (#219)
  - Backward compatible: schedules without linked workflows still create tasks as before
  - Multiple workflows can reference the same schedule
  - `POST /api/schedules/:id/run` returns `workflowRunIds` when workflows are triggered
- Workflow-level `dir` and `vcsRepo` fields — all `agent-task` nodes that don't explicitly set these inherit the workflow-level defaults (#219)
  - Available for interpolation as `{{workflow.dir}}` and `{{workflow.vcsRepo}}`
- Prompt template registry — per-event customizable templates with scope resolution (global → agent → repo), wildcard matching, and version history (#208)
  - HTTP render endpoint for Docker workers to resolve templates via API
  - Templates UI (`templates-ui/`) with AG Grid list, Monaco editor, live preview, and template history
  - Seed runner/tool/session templates from code registry on API startup

### Fixed
- Workflow resume race condition — `finalizeOrWait` prevents stuck runs when no nodes are ready (#220)
- Retry logic uses convergence-aware node detection instead of blindly passing successors (#220)
- Worker/API DB boundary: moved `seed.ts` to `src/be/`, use DI pattern for resolver's DB access (#208)
- Test DB isolation for bun's single-process test model (#208)
- Migration version collision detection (#208)

## [1.49.0] - 2026-03-21

### Added
- `agent-swarm onboard` CLI wizard — interactive first-time setup that collects credentials, generates `docker-compose.yml` + `.env`, starts the stack, and verifies health (#206)
  - Presets: `dev`, `content`, `research`, `solo`
  - Progress indicator, `ANTHROPIC_API_KEY` support, Ctrl+C handling
  - Inline validation errors for integration steps (GitHub, GitLab, Sentry, Slack)
- `agent-swarm docs` command — show documentation URL with `--open` flag to launch in browser
- `agent-swarm claude` command — run Claude CLI with optional message and headless mode
- Workflow structured output support — agent-task nodes can define `config.outputSchema` for validated JSON responses (#207)
  - `store-progress` validates agent output against schema inline
  - Workspace scoping for agent-task executor via `vcsRepo`
- Workflow I/O schemas with explicit input mappings and data flow validation (#201)
- Fumadocs LLMs and OpenAPI integrations for docs site (#205)

### Changed
- CLI command renames: `setup` → `connect`, `mcp` → `api` (#206)
- `api` command gains `--db` flag for custom database file path
- CLI help rewritten as plain `console.log` with per-command `--help` support
- `connect` command auto-reads `API_KEY` from `.env`, uses random port, supports `APP_URL`

### Fixed
- Workflow validation: clear `nextRetryAt` when retries are exhausted (#207)
- Workflow validation: re-run validation after retry poller re-executes a step (#207)
- Workflow validation: normalize pass/fail across all executor types (#207)

## [1.48.0] - 2026-03-20

### Added
- Workflow I/O schemas with explicit input mappings and data flow validation (#201)
  - Node-level `inputs` mapping for cross-node data flow
  - Static data flow validation for input references
  - `triggerSchema` for validating trigger payloads
- Fumadocs LLMs and OpenAPI integrations for docs site (#205)
  - API Reference pages auto-generated from OpenAPI spec
  - Project selector for Documentation vs API Reference
  - `.md` extension support for LLM-friendly content
- CI merge gate for generated API docs drift detection
- SEO: automated inbound links to new documentation pages

### Changed
- API reference consolidated to single page with tag-based subsections
- Docs site sidebar navigation improved with API Reference visibility

### Fixed
- Docs site project selector visibility on all pages

## [1.47.0] - 2026-03-20

### Added
- Linear integration — bidirectional ticket tracker sync via OAuth + webhooks (#161)
  - OAuth 2.0 authorization flow with PKCE
  - Webhook handler for issue/comment events
  - `AgentSession` lifecycle tracking for Linear issues
  - Generic tracker abstraction layer (`tracker_sync` table) for future integrations
  - `.env.example` updated with Linear setup instructions
- Workflow engine redesign — DAG-based workflow automation with improved reliability (#196)
  - Executor registry architecture for extensible step types
  - Node I/O schemas with explicit input mappings and validation
  - Workflow-level `triggerSchema` validation
  - Static data flow validation for input mappings
  - Convergence deadlock fix with active edge tracking
  - Interpolation rewrite with unresolved variable tracking and deep config support
  - Slack notification executor for workflow steps
- Portless integration for local development — friendly URLs like `api.swarm.localhost:1355` (#200)
  - `dev:http` script uses portless by default
  - New `start:portless` script for production-like local runs
  - `.env.example` updated with portless configuration instructions
- `agent-fs` Claude plugin pre-installed in worker containers

### Changed
- Claude Code version pinned in Dockerfile.worker via `CLAUDE_CODE_VERSION` build arg (default: `2.1.80`) — replaces dynamic installer for reproducible builds (#202)
- Runner prompt generation is now provider-aware for pi skill prefix

### Fixed
- Corepack permissions — `COREPACK_HOME` redirected to user-writable directory to avoid "operation rejected by your operating system" errors (#202)
- `task.cancelled` outbound handler added for proper cancellation event propagation
- Follow-up tasks properly repoint `tracker_sync` for session lifecycle
- Read user message from `agentActivity` with proper stop signal handling
- Avoid duplicate responses — prefer `AgentSession` over issue comments
- [UI] Use node ID as graph label, remove schema sections from workflow inspector

## [1.45.1] - 2026-03-19

### Added
- Debug tab with database explorer — SQL query interface in the dashboard with Monaco editor, table browser sidebar, and AG Grid results display
- `db-query` MCP tool — lead-only read-only SQL queries against the swarm database (capped at 100 rows)
- `POST /api/db-query` REST endpoint for database inspection
- Agent-fs native integration — persistent, searchable filesystem shared across the swarm
  - Auto-registration on first container boot (idempotent)
  - Lead creates shared org, workers receive invitations automatically
  - System prompt conditionally includes agent-fs CLI usage instructions
  - `agent-fs` CLI and Claude plugin pre-installed in worker containers

### Changed
- Per-session MCP config — each Claude session gets its own `/tmp/mcp-{taskId}.json` config file instead of sharing `.mcp.json`, eliminating race conditions with concurrent sessions (#192)
- `--strict-mcp-config` flag ensures only per-session MCP servers are loaded (#192)
- Removed time-based `getAgentCurrentTask()` fallback — uses deterministic `sourceTaskId` only
- Slack metadata is now auto-inherited from the creator's current task via `X-Source-Task-Id` header — explicit `slackChannelId`/`slackThreadTs`/`slackUserId` params on `send-task` remain available as optional overrides (#191)

### Fixed
- Concurrency safety for Slack metadata auto-inheritance — pass `sourceTaskId` through MCP session context via `X-Source-Task-Id` header instead of guessing current task (#191)
- `send-task` now propagates `sourceTaskId` for accurate Slack metadata lookup

## [Unreleased]

### Added
- Multi-API-config UI for dashboard — connect to multiple swarm instances from a single browser (#189)
  - Slug-based connection data layer with localStorage persistence (Phase 1)
  - React context for multi-connection state management (Phase 2)
  - Sidebar swarm switcher and header connection name display (Phase 3)
  - Config page multi-connection management with URL param modal (Phase 4)
  - Health indicator dots in swarm switcher (Phase 5)

## [1.44.5] - 2026-03-17

### Added
- OpenAPI 3.1 spec at `/openapi.json` (~83KB, ~60 REST endpoints) generated from route registry (#184)
- Scalar interactive API docs at `/docs` — pre-authentication API explorer (#184)
- `MODEL_OVERRIDE` and `CAPABILITIES` env vars for content agents in `docker-compose.example.yml` (#165)
  - `content-writer`: `MODEL_OVERRIDE=opus`, capability: `content-writing`
  - `content-reviewer`: `MODEL_OVERRIDE=sonnet`, capability: `content-review` (uses Gemini via OpenRouter)
  - `content-strategist`: `MODEL_OVERRIDE=sonnet`, capability: `content-strategy`

### Changed
- `route()` factory replaces all raw `matchRoute()` calls — typed route definitions with Zod schemas for params, query, and body validation (#184)
- Lead agent now posts task results back to originating Slack threads (#183)
- Worker agents now post start/completion/failure updates to originating Slack threads (#183)

### Fixed
- Slack thread follow-ups route to lead when assigned agent is offline (#183)
- `parentTaskId` continuity preserved for follow-up tasks (#183)
- ARM compatibility for Docker Compose — added `platform: linux/amd64` to all services to fix `no matching manifest for linux/arm64/v8` on Apple Silicon Macs (#180)

### Added
- Rich Block Kit messages for all Slack responses — structured headers, context, sections, and action buttons (#177)
- Single evolving message per task — assignment, progress, and completion all update one message via `chat.update` (#177)
- Slack Assistant sidebar support with thread routing, suggested prompts, and typing status (#177)
- Interactive actions: follow-up modal for sending follow-up tasks, cancel with confirmation dialog (#177)
- Markdown-to-Slack format converter (`markdownToSlack`) for consistent formatting (#177)
- Per-agent write isolation on shared disk (#172)
  - Each agent can only write to its own subdirectory under `/workspace/shared/{category}/{agentId}/`
  - PreToolUse hook warns agents before writing to another agent's directory
  - PostToolUse hook detects "Read-only file system" errors and guides agents to use their own directory
  - Base prompt updated with per-agent directory convention and discovery commands
  - Slack download tool saves to per-agent download directory by default
- Claude credential validation — fail fast if no auth is set
- Pre-push hooks to match CI merge gate checks
- Working directory (`dir`) support for agent tasks (#159)
  - `send-task` and `task-action` accept `dir` parameter (absolute path) to set agent starting directory
  - Runner resolves `dir` for both new and resumed tasks with fallback chain: `task.dir` > `vcsRepo` clone path > default cwd
  - System prompt annotated with working directory context when non-default
- Content agent templates: writer, reviewer, strategist (#160, #162)
  - 3 new official templates: `official/content-writer`, `official/content-reviewer`, `official/content-strategist`
  - Docker-compose examples for all 3 content agents
  - Content reviewer configured with Gemini via OpenRouter (`HARNESS_PROVIDER=pi`)
- Template defaults applied during worker registration (#159)
  - Templates can now set `name`, `role`, `capabilities`, `maxTasks`, and `isLead` as fallback defaults
  - Template fetched before registration so defaults apply to the registration call itself
- Archil FUSE mount support for persistent workspace storage (#166, #168, #169)
  - `archil` CLI installed in both API and worker Docker images
  - FUSE3 and libfuse2 packages added to Docker images
  - Entrypoint-based mount logic for R2-backed persistent disks
  - Removed `VOLUME` directives for `/workspace/shared` and `/workspace/personal` to allow FUSE mounts
- Contribution guidelines (CONTRIBUTING.md) with templates linked in docs and landing page (#158)
- Templates registry for agent workers (#155, #156)
  - 6 official templates: lead, coder, researcher, reviewer, tester, forward-deployed-engineer
  - Templates UI (Next.js) with gallery, detail pages, and interactive docker-compose builder
  - `TEMPLATE_ID` env var for initial profile fetching on first boot (e.g., `official/coder`)
  - `TEMPLATE_REGISTRY_URL` env var for custom registry endpoints
  - Template idempotency: existing profile fields are never overwritten
  - GitHub issue/PR templates for community template submissions
- GitLab integration with Provider Adapter Pattern (#153)
  - `POST /api/gitlab/webhook` route with timing-safe secret verification
  - Handlers for merge_request, issue, note (comments), and pipeline events
  - Bot mention detection via `GITLAB_BOT_NAME` env var
  - GitLab trigger events for workflow engine (`gitlab.merge_request.*`, `gitlab.issue.*`, etc.)
  - `glab` CLI installed in worker Docker image
  - VCS provider detection for automatic `gh`/`glab`/`git` clone selection
  - New env vars: `GITLAB_TOKEN`, `GITLAB_URL`, `GITLAB_WEBHOOK_SECRET`, `GITLAB_BOT_NAME`, `GITLAB_EMAIL`, `GITLAB_NAME`
- ProviderAdapter abstraction with pi-mono support (#151)
  - `ProviderAdapter` interface decouples the runner from Claude CLI
  - `ClaudeAdapter` extracted from monolithic runner (~600 lines)
  - `PiMonoAdapter` with MCP tool discovery, event normalization, and cost tracking
  - All 6 swarm hook events mapped to pi-mono extension handlers
  - Selected via `HARNESS_PROVIDER=claude|pi` env var
  - Docker multi-provider support in Dockerfile.worker and entrypoint

### Changed
- API data disk switched from Archil FUSE to Fly volume for reliability
- Shared disk uses exclusive Archil mounts with `--force` for stale delegation recovery
- Template fetching refactored to run before agent registration (cached and reused for identity files)
- Docker workspace volumes replaced with FUSE mount points for Archil compatibility

### Fixed
- Thread follow-ups now route correctly after task completion — `getAgentWorkingOnThread` checks all statuses (#177)
- Docker entrypoint runs as root for FUSE mounts, then drops to worker user via `gosu` before exec
- Archil FUSE mount fixes: read-write mounts, per-agent subdirectory checkout, POSIX signal names in entrypoint, shared flag for mount calls
- `dir` validation added to MCP tool schemas with inner type cast fix
- Workspace `mkdir` made non-fatal for read-only Archil mounts
- VOLUME directives removed from Dockerfile.worker to unblock FUSE mounts on Fly.io

### Changed
- Memory system enhancements (#148)
  - Epic-linked task completions auto-promote to swarm scope (visible to all workers)
  - `inject-learning` creates swarm-scoped memories
  - Mandatory `memory-search` directive in base prompt
  - Follow-up tasks include epic context (goal, plan, progress, nextSteps)
  - Server-side memory injection enriched with epic name/goal and recent task summaries
  - New `nextSteps` column on epics (migration 005)
- Base prompt updated with VCS CLI comparison table (gh vs glab)
- DB migration 006: renames `github*` columns to `vcs*`, adds `vcsProvider` column

### Fixed
- Prevent duplicate review tasks and fix PR Lifecycle workflow (#150)
  - Dedup guard for review task creation
  - Action filtering fixes in webhook handlers
  - Webhook enrichment improvements

- Workflow automation engine with DAG-based node execution (#142)
  - Trigger nodes: task created/completed, GitHub events, Slack messages, email, webhooks
  - Condition nodes: property-match, code-match (sandboxed JS), LLM-classify
  - Action nodes: create-task, send-message, delegate-to-agent
  - Template interpolation with `{{variable}}` syntax in node configs
  - Async node support with pause/resume for long-running actions
  - Stuck run recovery and retry-from-failure support
  - 9 MCP tools for workflow CRUD, triggering, and run management
  - REST API endpoints for workflows and runs
- Workflows UI with React Flow graph visualization (#144)
  - Interactive DAG visualization with dagre auto-layout
  - Custom node components (TriggerNode, ConditionNode, ActionNode) with status overlays
  - Workflow runs table with execution status tracking
  - Step detail drill-down panel
  - Workflows section in dashboard sidebar under Operations
- E2E workflow test with Docker worker integration
- Database migration system with numbered `.sql` files and incremental runner (#133)
- Lightweight code-level heartbeat module for swarm triage without spinning up Claude sessions (#124)
  - 3-tier approach: preflight gate, code-level triage, Claude escalation
  - Auto-assignment of pool tasks to idle workers
  - Stall detection for in-progress tasks
  - Worker health status correction
  - Configurable via `HEARTBEAT_*` environment variables

### Changed
- Migrated inline `try { ALTER TABLE } catch {}` schema blocks to `src/be/migrations/` folder

### Fixed
- `property-match` workflow node crash when config uses flat format (`property`/`operator`/`value`) instead of `conditions` array (#146)
- API migration Dockerfile fix for workflow schema

## [1.43.0] - 2026-03-12

### Added
- Slack thread follow-up routing — @mentions in threads route directly to the worker already active in that thread, bypassing lead delegation
- Additive Slack buffer (`ADDITIVE_SLACK=true`) — non-mention thread replies are debounced and batched into a single follow-up task with dependency chaining
- `!now` command for instant buffer flush without dependency chaining
- `HEURISTICS.md` documenting all Slack routing rules and buffering behavior
- `reactions:write` Slack scope for visual buffer feedback (:eyes:, :heavy_plus_sign:, :zap:)

### Changed
- Eliminated inbox message system — all Slack and AgentMail messages now route directly as tasks
- Leads poll for tasks like workers (removed poll-task lead block)
- Child tasks auto-inherit Slack/AgentMail metadata from parent tasks
- Removed `inbox-delegate` and `get-inbox-message` MCP tools
- Removed fuzzy name matching from Slack router (replaced by task-based routing)

### Fixed
- AgentMail sender domain filter now correctly handles "Name \<email\>" format

## [1.36.0] - 2026-03-06

### Added
- One-time (delayed) scheduled tasks alongside recurring schedules
  - New `scheduleType` field: `recurring` (default) or `one_time`
  - `create-schedule` accepts `delayMs` (relative delay) or `runAt` (absolute ISO datetime) for one-time schedules
  - One-time schedules auto-disable after execution
  - `list-schedules` hides completed one-time schedules by default (`hideCompleted`)
  - UI shows type badges (amber=one-time, emerald=recurring)
- AgentMail webhook domain filters: `AGENTMAIL_INBOX_DOMAIN_FILTER` and `AGENTMAIL_SENDER_DOMAIN_FILTER` env vars to filter incoming webhooks by inbox and sender domain

### Changed
- Docker worker improvements: streamlined `Dockerfile.worker` and `docker-entrypoint.sh`

## [1.35.2] - 2026-03-05

### Fixed
- Avoid duplicate heartbeat triage task creation for the same stalled task set
- Run stale heartbeat resource cleanup even when preflight triage gate bails

## [1.35.1] - 2026-03-05

### Fixed
- Use unique port variables per service in `docker-compose.example.yml` to avoid conflicts (#137)
- Clarified that port variables are examples and that isolated network namespaces can share ports

### Changed
- Added internal cross-links across docs pages and blog/examples navigation (#135)
- Added canonical URLs and JSON-LD structured data to docs pages

## [1.34.0] - 2026-03-04

### Added
- Task cost tracking and display in task details page (#131)
- Schedule and epic HTTP API endpoints for CRUD operations
- Exhaustive HTTP API integration test suite (#132)
- `claude-context-mode` as default context management plugin for workers (#125)
- Base prompt test coverage

### Changed
- Refactored monolithic `src/http.ts` into modular route handlers under `src/http/` (#132)
- Abstracted route matching into `matchRoute` utility with dedicated tests
- Converted handler dispatch to registry-based for-loop pattern
- Improved system prompt assembly in `base-prompt.ts`

### Fixed
- Context-mode marketplace plugin ID in install command (#130)
- Lint warnings and type errors across HTTP route handlers

## [1.32.0] - 2026-03-03

### Added
- Model control per task, schedule, and global override — `model` parameter (`haiku`/`sonnet`/`opus`) on `send-task`, `task-action`, `create-schedule`, and `update-schedule` (#127)
- Schedule-to-task linking via `scheduleId` — tasks created by schedules have a direct back-reference and `get-tasks` supports filtering by `scheduleId` (#127)
- Multi-credential support — `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` accept comma-separated values for load balancing across subscriptions (#119)
- `ANTHROPIC_API_KEY` as alternative credential to `CLAUDE_CODE_OAUTH_TOKEN`
- x402 payments guide page and environment variables reference in documentation site

## [1.31.0] - 2026-02-28

### Added
- x402 payment capability for agents — automatic USDC micropayments for x402-gated APIs (#108)
- Dual signer support: Openfort (managed wallet in TEE) and viem (raw private key)
- Openfort backend wallet signer with v-value normalization for USDC settlement
- x402 CLI for testing payments (`check`, `fetch`, `status` commands)
- Spending tracker with per-request and daily limits
- Real testnet E2E tests with x402.org facilitator on Base Sepolia
- Landing site: x402 example page, blog section with Openfort hackathon post and swarm metrics post

### Fixed
- Openfort signature v-value normalization (v=0/1 to v=27/28) for on-chain USDC settlement
- Network chain passthrough to Openfort signer (was hardcoded to baseSepolia)

## [1.30.1] - 2026-02-28

### Added
- Agent `lastActivityAt` timestamp for stall detection (#105)
- Slack attachment handling — voice memos, images, and file uploads are now processed as messages (#103)
- `includeHeartbeat` filter for `get-tasks` — heartbeat/system tasks are excluded by default (#102)
- Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) on all 36 MCP tools for improved Tool Search discoverability (#95)

### Changed
- Pinned Dockerfile builder to `bun:1.3.9` for reproducible builds
- Dockerfile improvements: `pipefail`, consolidated `RUN` layers, `--no-install-recommends` for Node.js and GitHub CLI
- Removed `cc-ai-tracker` from worker image agent tools
- README optimized for GitHub star conversion: badges, hero, issue/PR templates (#104)

## [1.28.1] - 2026-02-27

### Added
- Fumadocs documentation site at docs.agent-swarm.dev (18 pages across architecture, concepts, guides, and reference sections)
- Agent-swarm.dev landing page
- Agent artifacts feature via localtunnel — SDK, CLI command, `/artifacts` skill, and Docker support
- Depot build system for Docker images
- Slack offline message queuing — @mentions when no agents are online are now queued as tasks
- `AGENTMAIL_DISABLE` env var to skip AgentMail integration

### Changed
- Server-side aggregation for usage pages (performance improvement)
- Removed old `ui/` directory in favor of `new-ui/`

### Fixed
- Usage pages performance issues (5 review fixes: full table scan, SQL parameterization, useMemo deps, groupBy validation, test coverage)
- CI path filtering to skip workflows for docs-site and landing directory changes

## [1.28.0] - 2026-02-17

### Added
- New dashboard UI ("Mission Control" theme) with AG Grid, command palette, and dark mode
  - Phase 1-6: project scaffolding, app shell, config page, agents/tasks/epics pages, chat/schedules/usage pages, polish
- Comprehensive env vars reference and agent configuration docs
- Active sessions table for lead concurrency tracking
- Concurrent context endpoint for lead session awareness
- Task deduplication guard to prevent concurrent lead duplicates
- Workers wake on in-app chat @mentions
- Delete-channel MCP tool (lead-only)

### Changed
- README and docs cleaned up for public launch
- Polished env examples and DEPLOYMENT.md

### Fixed
- New UI: CSS vars instead of hardcoded oklch in charts
- New UI: swapped theme and sidebar active state
- New UI: stale config dialog, chat URL params; removed dead code
- Zombie task revival — prevent completed tasks from being revived
- Task pool claiming made atomic to prevent race conditions

## [1.25.0] - 2026-02-07

### Added
- Agent self-improvement mechanisms (7 proposals implemented)
- Follow-up task creation for lead on worker task completion
- `/internal/reload-config` endpoint and config loader extraction
- Session error tracking with meaningful error reporting for failed worker sessions

### Fixed
- Graceful fallback when session resume fails with stale session ID
- Lead task completion polling prioritization and increased concurrency
- Slack initialized flag reset on stop
- AgentMail `from_` type fix

## [1.21.0] - 2026-01-28

### Added
- MCP tools for swarm config management and server config injection
- AgentMail webhook support
- Persistent memory system with vector search
- Centralized repo management
- Persistent setup scripts and TOOLS.md for agents
- Soul/identity editors in UI profile modal
- Session attachment with `--resume` logic in runner for session continuity

### Fixed
- Permanent notification loss from mark-before-process race
- 404 handling in task finalization
- Config upsert with NULL scopeId for global config

## [1.16.3] - 2026-01-14

### Added
- Epics feature for project-level task organization
- Lead-only authorization for epic tools
- Slack user filtering by email domain and user ID whitelist
- Scheduled tasks feature (cron-based recurring task automation)

### Fixed
- Task totals to show absolute counts

## [1.15.8] - 2026-01-07

_Initial tracked version. Earlier changes are not included in this changelog._
