---
date: 2026-09-04T12:00:00+02:00
author: taras
topic: "UI E2E against a seeded API on PR/main, plus swarm-driven exploratory PR testing"
tags: [brainstorm, e2e, ui, playwright, agent-browser, swarm, agent-fs, pages, scripts, ci]
status: complete
exploration_type: idea
last_updated: 2026-09-04
last_updated_by: taras
---

# UI E2E against a seeded API, plus swarm-driven exploratory PR testing. Brainstorm

## Context

Taras wants two related things:

1. **Deterministic UI E2E in CI.** Tests of `apps/ui/` that run against a real, *seeded* API on every PR and on `main`. Today the black-box suite (`bun run e2e`, PR #1311) boots the API on a free port with no Docker and no LLM, and the Slack visual E2E (PR #1338 / #1341) renders legacy-vs-v2 Slack screenshots from `slack-mock` and posts them as a sticky PR comment. There is no browser-driven UI suite yet. Frontend PRs are gated on a manual `qa-use` session with screenshots.

2. **Swarm-driven exploratory testing.** Use the swarm itself to (a) make sure the E2E suite actually runs and stays green, and (b) do exploratory browser testing on PRs, both ours and external ones. Candidate browser drivers: `agent-browser` (already used locally for local URLs) and Playwright.

Supporting ideas:

- Store test artifacts (screenshots, traces, videos, reports) on our own agent-fs instance instead of only GitHub Actions artifacts.
- Use custom swarm scripts, exposed as HTTP APIs, to record run metadata.
- Render dynamic (possibly public) pages to track runs and results over time.

Existing primitives to reuse (facts being confirmed by background research): `scripts/e2e/` SUT boot, `slack-visuals.yml` publishing flow, `artifacts` skill + `agent-swarm artifact` CLI, `create_page`, swarm scripts, swarm apps, schedules, GitHub integration.

Initial thoughts from Taras: agent-browser and Playwright are both attractive. The artifact and metadata layer should live on our stack (agent-fs + scripts + pages), which also dogfoods the product.

## Exploration

### Facts gathered (background research, 2026-09-04)

**What exists for E2E today**

- `bun run e2e` (`scripts/e2e/sut.ts:56-141`) spawns `bun run src/http.ts` with a fresh temp SQLite DB, fresh `AGENT_FS_LOCAL_DIR`, `NODE_ENV=test`, integrations disabled. It never starts `apps/ui`. It runs 9 contract scenarios over HTTP + MCP and gates on route/tool coverage.
- Visuals (`scripts/e2e/visuals.ts`) come from `@desplega.ai/slack-mock` `frames()` + `screenshot()`, stitched into GIFs by ffmpeg. Not Playwright. Published to the orphan `ci-visuals` branch (`visuals-publish.sh`, 30-day prune) and a sticky PR comment (`slack-visuals.yml`, informational only).
- `merge-gate.yml` job `e2e-contract` is the only per-PR run of the contract suite. `ci.yml` (push to main) has no e2e job. `nightly-e2e.yml` runs `--harness <provider>` inside `worker:slim`.
- **The "qa-use screenshots" frontend gate is documentation only.** No workflow checks for it. `merge-gate.yml` `ui-lint` only runs tokens check + Biome + `tsc -b`. `LOCAL_TESTING.md:227`, `runbooks/testing.md:20`, `apps/ui/CLAUDE.md:291`, `CLAUDE.md` all claim CI enforcement. This is drift.
- No Playwright, `@playwright/test`, puppeteer, or agent-browser dependency anywhere in the repo. No `playwright.config.*`, no `*.spec.ts` under `apps/ui`. Playwright + Chromium + qa-use exist only in the `worker-full-base` Docker stage (`Dockerfile.worker:471-555`, `PLAYWRIGHT_BROWSERS_PATH=/opt/playwright`). Slim has none.
- `apps/ui` is a Vite SPA on port 5274 that proxies `/api`, `/health`, `/status` to `VITE_PROXY_TARGET || http://localhost:3013`. Prod reads `VITE_API_URL` / `VITE_API_KEY` at build time. The API does **not** serve the UI dist. Eight `.test.tsx` files exist in `apps/ui` but no test runner is wired.
- Seeders: only `agentFsProvisionSeeder`, `scriptsSeeder`, `skillsSeeder` (`src/be/seed/registry.ts:16`). No demo-data seeder for agents, tasks, sessions, pages, or apps. Scenarios create data ad hoc through the public API. No snapshot DB fixture.

**Swarm primitives available**

- GitHub: webhooks in `src/http/webhooks.ts:255-273` handle `pull_request`, `issue_comment`, review events, `check_run`, `check_suite`, and re-emit onto `workflowEventBus` as `github.pull_request.<action>`. Tasks get `source: "github"`, `taskType: "github-pr"`, `vcsRepo`, `vcsNumber`, `vcsInstallationId`. **No fork / external-PR distinction anywhere.** No MCP tool posts PR comments or check runs. `review-pr` / `respond-github` shell out to `gh`.
- agent-fs: `AgentFsProvider` (`src/fs/agent-fs-provider.ts:46`) needs `apiUrl`, `apiKey`, `orgId`, `driveId`. Raw URL `${apiUrl}/orgs/{org}/drives/{drive}/files/{path}/raw`. Human viewer link `${AGENT_FS_LIVE_URL}/file/~/<org>/<drive>/<path>` is public. `agent-fs write` is text-only, binaries need a binary-safe upload. agent-fs skill is in both slim and full images.
- Pages: `authMode` is `public | authed | password` (`src/types.ts:2146`). Versioned. Injected `window.swarmSdk` gives KV, tasks, agents, events, and a generic `swarm.call`. `<swarm-diff>` renders annotated diffs. JSON pages are json-render specs.
- Scripts as APIs: `POST /api/scripts/{id}/apis` creates an endpoint with `authMode: none | bearer`. Invocation is `POST /api/x/script/{endpointId}` (`src/http/x.ts:71`). Workflows accept `POST /api/webhooks/{workflowId}` with optional HMAC. App actions are `POST /api/apps/{id}/actions/{name}`.
- Swarm apps: typed models, named queries, script/task/sync actions, json-render UI at `/apps/<id>`. **All app routes are RBAC-gated. No public mode.** Pages are the only public surface.
- Schedules: `targetType` is `agent-task | workflow | script`, cron or interval. Workflow nodes: `agent-task`, `foreach`, `script`, `swarm-script`, `wait`. Triggers: `webhook` or `schedule`.
- Host tooling: `agent-browser` v0.31.1 (standalone CLI with its own bundled skill via `agent-browser skills get core`), `qa-use`, and `playwright` are installed on Taras's Mac. agent-browser is **not** in the worker image.

**Implications**

- Both halves of the idea start from zero on the UI side. The contract suite gives a proven SUT boot to reuse.
- The seeded-API requirement is a real gap: there is no fixture mechanism. Deterministic UI tests need one.
- The swarm exploratory layer can build on GitHub webhooks, schedules, and worker-full browser tooling, but external PRs need a security posture that does not exist today.
- Metadata tracking has two candidates: a swarm app (typed, private) or a script API + public page (open). Apps cannot be public today.

### Q: Which half is the first deliverable that the other builds on?
Same core for both. Start with the deterministic CI suite, but the exploratory layer must **yield deterministic tests** (exploration output becomes committed specs). Taras also wants a custom Playwright extension, `pw.ai.{assert|act|extract}`, backed by an OpenRouter key that is configured locally and in CI.

**Insights:**
- The shared core is a Playwright harness: fixtures that boot API + UI + seed, plus the `pw.ai` extension. CI runs it headless. The swarm runs the same harness in exploratory mode.
- "Exploratory yields deterministic" implies a hardening step: an AI-driven session records what it did (resolved locators, extracted values, assertions) and emits a replayable spec. This is the Stagehand / self-healing pattern. It also implies the swarm needs to open PRs with new specs, so the loop closes in git.
- `pw.ai.*` with a live LLM in CI makes the CI suite non-deterministic by construction unless AI resolutions are cached and replayed. This is the next decision.
- OpenRouter as the provider keeps the model choice portable and matches the existing E2E model choice convention (`openrouter/...`).

### Q: How should the CI suite stay deterministic when pw.ai calls an LLM?
Live LLM calls are allowed in CI. Taras chose this over cache-and-replay and over "pw.ai is exploratory-only".

**Insights:**
- Claude's concern, recorded: live LLM calls make every pw.ai step subject to model latency, cost, outages, and non-determinism. A model outage on OpenRouter could block merges if these tests gate. Mitigations that do not change the decision: retries on pw.ai steps, a small fast model by default (the repo already standardizes on `openrouter/deepseek/deepseek-v4-flash` for E2E), and a per-run cost cap.
- This makes "which tests gate merge" the next decision: pure-locator specs and pw.ai-backed specs have different reliability profiles.
- Cache-and-replay stays available as a later optimization inside `pw.ai` without changing test code. It is deferred, not rejected.
- Design consequence for `pw.ai`: the extension should log every LLM resolution (prompt, chosen locator, model, tokens, cost) into the Playwright trace or a sidecar JSON. That is what the swarm reads to harden exploratory findings into plain locators later, and what the tracker page shows.

### Q: What blocks a PR merge?
Nothing gates yet. Both tiers are informational (PR comment + tracker page). Gate later once the flake rate is known.

Taras added direction on `pw.ai`: the AI methods must feel like native Playwright methods, simple. Look at `../cope` (desplega.ai code) where a similar thing was done. Implementation should use the Vercel AI SDK in agent mode, with an iteration limit and a small set of exposed browser actions. **`pw.ai` is parked as an action item**; it has its own complexities and comes later.

**Insights:**
- The first deliverable is therefore a plain Playwright suite. `pw.ai` becomes a follow-up with its own brainstorm or plan. The harness must leave room for it: a `test.extend` fixture slot named `ai`, and a per-step event log the tracker can consume.
- "Informational only" changes the CI shape: the UI E2E job must never fail the merge gate, so it lives in its own workflow (like `slack-visuals.yml`), posts a sticky comment, and pushes artifacts. The existing `visuals-publish.sh` + sticky comment machinery is directly reusable.
- The docs drift about the qa-use gate should be fixed in the same effort: either the new UI E2E job replaces the qa-use claim, or the docs stop claiming CI enforcement.

### Facts from web research (2026-09-04)

- **Playwright under Bun is not reliable.** `@playwright/test` has open browser-launch and module-resolution issues under Bun (`microsoft/playwright#38095`, `oven-sh/bun#23826`). Run the suite under Node even in this Bun-first repo. Node is already in the worker image; CI runners have it.
- **Playwright 1.62** ships `init-agents` (planner, generator, healer agent definitions for claude/codex/opencode/vscode). Planner explores a running app and writes a Markdown plan, generator turns it into `*.spec.ts` with live-verified locators, healer repairs failing specs. This is the exact "exploratory yields deterministic" loop, first-party.
- Stagehand (MIT) has `act`/`extract`/`observe`/`agent`, works on a local Playwright page, supports OpenAI-compatible base URLs (OpenRouter works for act/observe/extract, `agent()` has reported issues), and has `cacheDir` replay with zero LLM calls. Reference design for `pw.ai` if we want caching later. auto-playwright is a single `auto()` function. ZeroStep needs its own cloud token.
- **agent-browser** (Vercel Labs) is a Rust CLI + Node daemon over Playwright/CDP, CLI-only (no Node SDK), `snapshot` gives `@e1` refs, `--cdp <port>` attaches to an existing browser. It fits agent-driven exploration, not a committed spec suite. It could share a browser with a Playwright run via CDP.
- Microsoft `playwright-mcp` exposes browser tools over MCP (Apache-2.0). Alternative to agent-browser for the swarm's harnesses that already speak MCP.
- **Fork PRs on GitHub Actions**: `pull_request` runs with a read-only token and **no secrets**. `pull_request_target` has secrets but must never check out and execute fork code. Safe pattern for "run untrusted PR code, then publish with secrets" is a two-workflow split (`pull_request` build → `workflow_run` publisher that never executes PR code).
- Report publishing patterns: upload-artifact, orphan branch + Pages, or `upload-pages-artifact` + `deploy-pages`. Our `ci-visuals` orphan branch is the second pattern already.
- **Correction on the docs drift**: during this session the `CLAUDE.md` in the main checkout changed. It now says the frontend screenshot requirement is a reviewer convention with no CI job, captured with `agent-browser` and uploaded to agent-fs via `agent-fs write --file` (binary-safe, CLI >= 0.7.1) plus `agent-fs signed-url` (24h default, 7 days max). `qa-use` is no longer the tool. The worktree for this brainstorm branched before that change.

### Q: What should "seeded API" mean for the suite?
API-driven seed script, once per suite. It must also be able to run direct DB queries and mutations when needed.

**Insights:**
- `scripts/e2e/db.ts` already opens the SUT's SQLite file read-only for assertions. Extending it to read-write gives the seed script its escape hatch with no new server code. `scripts/` is exempt from the DB-boundary check. WAL mode plus the server's `BEGIN IMMEDIATE` retry makes cross-process writes safe.
- Runtime split: the seed script and `startSut` are Bun (`bun:sqlite`), Playwright must run under Node. The natural shape is that the existing Bun orchestrator (`scripts/e2e/run.ts` or a sibling `ui.ts`) boots SUT + UI, seeds, then spawns `playwright test` as a Node child with the ports in env. Playwright's `globalSetup` does not need to know about Bun.
- The seed must be idempotent and produce stable handles (agent names, task titles, page slugs) that specs select by. IDs are server-generated UUIDs, so specs select by name, not by ID, or the seed writes a manifest JSON the specs read.
- Direct DB mutations cover what the API cannot express: backdated heartbeats for stalled-task views, cost rows with `costSource` variants, memory rows, past session logs.

### Facts from `../cope` (desplega.ai) for the parked `pw.ai` item

- The AI act/assert/extract system in cope is the **qa-use product backend**, Python, not a Playwright wrapper. `OpenRouterClient` wraps the openai SDK (`be/core/ai/llm_or.py:90-135`, `OPENROUTER_API_KEY`). Tools are Pydantic classes passed to `ainvoke_tools` (`be/core/ai/ainvoke.py:957`).
- Public surface: `ai_action`, `ai_assertion` (single LLM call by default, agent loop only if `max_steps > 1`), `extract_structured_data` into a named variable (`be/core/block_runner.py:2529-3187`). Failures raise, reasoning is appended to block logs.
- Agent loop caps: `MAX_ITERATIONS = 100`, `ASSERTION_MAX_STEPS = 10`, stuck detection after 3 failed steps (`be/experiments/test_agent_2.py:209-210, 6242-6420`).
- Action vocabulary is one enum (`ActionIntentType`, `test_agent_2_models.py:505-553`): goto, click, fill, type, press, hover, scroll, select, check, wait, `to_be_visible`-style element assertions, `to_have_url`, extract from page. Each intent carries accessibility-tree `refs` for grounding, the same idea as agent-browser's `@eN` refs.
- Model presets: `@preset/gemini-flash` default, sonnet for "max", opus for "ultra" (`be/core/model_defaults.py:25-28`).
- Self-heal: `BlockFixManager.attempt_fix` regenerates a block from the live selector map plus Playwright locator docs. Generate-test-from-session: `get_blocks_from_history` and `qa-use browser generate-test`.
- cope's own Playwright suite (`example-e2e/`) is plain: chromium only, `retries: CI ? 2 : 1`, `trace/video: on-first-retry`, `screenshot: on`, their own `@desplega.ai/playwright-reporter` streaming to an HTTP endpoint, no `test.extend` fixtures, runs on push to main only, no LLM key in the job.
- Takeaway for `pw.ai` later: the cope shape (small action enum, refs grounding, single-shot assertion with agent fallback, low iteration cap) ports cleanly to a Vercel AI SDK `tool()` set with `stopWhen: stepCountIs(n)`. The suite itself stays plain.

### Q: What should the first deterministic suite cover?
Route smoke plus three core flows. Smoke: every sidebar route renders against the seeded world with zero console errors and zero failed API calls. Flows: task list to task detail to session logs; settings configuration round-trip; create a page and view its share URL.

**Insights:**
- The route-smoke test is data-driven from a route list. It should assert on console errors, failed `/api` responses, and a stable screenshot per route. Screenshots feed the tracker page and the PR comment even without visual diffing.
- The three flows fix the seed's minimum contents: agents, tasks in several statuses with session data, a config key, and page creation permissions.
- The route list itself can be generated by the swarm exploratory layer later, closing the loop from exploration to a committed list.

### Q: Where does the PR's code run for swarm exploration, and what triggers it?
In-worker boot with an opt-in trigger. A worker-full agent checks out the PR, runs the same Bun orchestrator (SUT + UI + seed), then explores inside the container. Triggered by a PR label or an `@swarm explore` comment, plus a nightly schedule on main.

**Insights:**
- The GitHub webhook path already turns `pull_request` and `issue_comment` events into `github-pr` tasks with `vcsRepo` / `vcsNumber`. The trigger is a routing rule on label or comment text, not new plumbing.
- The nightly run is a schedule with `targetType: agent-task` or a workflow with a `schedule` trigger. The workflow form fits better because it can chain: explore (agent-task) then harden (agent-task) then open PR.
- `agent-browser` is not in the worker image today. Adding it to `worker-full-base` is a Dockerfile change with the usual leaf-block and HOME-pollution traps. Playwright + Chromium are already there.
- The orchestrator must expose the booted ports to the agent (env or a JSON handle file) so the agent can point agent-browser at the UI.

### Q: What is the posture for external (fork) PRs?
Maintainer label plus an ephemeral sandbox with no prod secrets. External PRs run only after a maintainer applies the label. The run happens in a fresh sandbox (E2B or a throwaway container) that receives only an OpenRouter key and a scoped agent-fs upload token. The swarm posts the PR comment from outside the sandbox.

**Insights:**
- The webhook handler has no fork detection today. `pull_request.head.repo.fork` (or head repo full name differing from base) is the signal. This is a small, isolated addition to `src/github/handlers.ts` that tags the task, for example `vcsIsFork: true`.
- Two execution paths share one contract: "given a repo + ref, boot, explore, write artifacts, return a findings JSON". Internal PRs use a worker-full container. Fork PRs use the sandbox. The evals subproject already drives E2B sandboxes with the worker image, so the sandbox path has prior art (`apps/evals/src/swarm/sandbox.ts`).
- "Scoped agent-fs upload token" is a fact to verify: whether agent-fs can mint a drive-scoped, write-only, short-lived token. If not, the sandbox writes artifacts to a tmp dir and the trusted side uploads them.
- Same split applies to GitHub Actions: the CI suite runs under `pull_request` (no secrets) for forks, so CI artifact upload to agent-fs must be optional and skipped when the secret is absent.

### Q: How should runs record metadata and expose a tracker?
One script API ingest point, storage in a swarm app, a public page as the read-only projection. A seeded swarm script exposed at `POST /api/x/script/{endpointId}` (bearer) receives run reports from CI (curl) and from swarm agents. It writes typed rows into a swarm app (runs, results, artifacts) and regenerates a public page with the latest runs embedded after each ingest.

**Insights:**
- The ingest payload is the contract between all three producers (CI suite, swarm exploratory, nightly). One JSON schema: run identity (repo, ref, sha, PR number, trigger, runner kind), per-spec results, artifact links, cost and model when AI was involved, and a findings list for exploratory runs.
- The script must be seeded (`src/be/seed-scripts`) so a fresh deploy has it, and the app definition must be seeded or created by the script on first ingest. Which of those two is simpler is a fact for research.
- The endpoint bearer lives in GitHub Actions secrets and in the swarm worker env. Fork PR CI runs have no secret, so they skip ingest, and the tracker only learns about them through the label-triggered swarm run.
- Regenerating a page per ingest means the page body is a render of app rows. Keep it small: latest N runs per target plus a link into the private app for history. Page versions accumulate on each rewrite, which the 5 MiB per-version cap tolerates but retention should prune.
- The `<swarm-diff>` primitive and `window.swarmSdk` are not needed for v1 of the page. Plain HTML with embedded JSON is enough.

### Q (Taras, mid-session): What does "fresh sandbox" mean? And we should consider sharding, and each suite should run against a fresh API.
Clarification given: "fresh sandbox" for fork PRs means an execution environment created per run and destroyed after it (E2B sandbox or throwaway container) with no swarm credentials, as opposed to a worker-full container that carries the swarm key.

On isolation, Claude first proposed "fresh API per suite, shard by suite". Taras pushed back: one CI job per suite is too granular at 20 suites and costs GitHub Actions minutes.

**Insights:**
- Claude conflated two knobs. **Isolation unit** (how many APIs boot) and **CI shard count** (how many jobs) are independent. Fresh API per suite is an in-job process concern and costs seconds. Shard count should stay small and fixed, like the unit-test job's 2 shards.
- The Playwright-native isolation unit is the **worker process**. A worker-scoped fixture can spawn `bun run src/http.ts` on a free port, run the seed, and hand `baseURL` to every test in that worker. Node can spawn Bun, so no wrapper orchestrator is needed. With one worker per spec file this equals "fresh API per suite".
- Twenty suites on 2 shards means each job boots about 10 APIs sequentially or a few in parallel, bounded by `workers`. At 2 to 3 seconds per boot plus seed, that is under a minute of overhead per job.

### Q: Isolation per Playwright worker with 2 fixed CI shards?
Confirmed. A worker-scoped fixture spawns the SUT on a free port and seeds it. CI runs `--shard=1/2` and `--shard=2/2` as two jobs. Shard count is one config value.

**Insights:**
- The UI is the wrinkle. The Vite dev server proxies `/api` to a single `VITE_PROXY_TARGET`, and `deployment-config.ts` bakes `VITE_API_URL` at build time. With N APIs per job, each worker needs its own UI origin pointed at its own API. Cleanest default: build the dist once per job with `VITE_API_URL=http://localhost:3013` (which triggers the relative-path branch in the API client), then have the worker fixture start a tiny Node static server on a free port that serves the dist and proxies `/api`, `/health`, `/status` to that worker's SUT. This tests the production bundle and needs no per-worker Vite process. Whether the client code has a runtime API-URL override is a fact for research.
- The fixture handle is one object: `{ apiUrl, apiKey, uiUrl, dbPath }`. Specs never see ports.
- Trace, video, and screenshot policy follows cope's proven config: `trace: on-first-retry`, `screenshot: on`, `retries: CI ? 2 : 1`, chromium only.

### Q: Where do artifacts live and how long are they visible?
agent-fs is primary, GitHub Actions artifacts are the fallback. Every run uploads its Playwright output dir to agent-fs under `e2e/<repo>/<pr-N|main>/<sha>/<shard>/` with `agent-fs write --file`. The ingest payload carries agent-fs paths and the tracker renders viewer links. Fork PR CI runs have no token and fall back to `actions/upload-artifact`. Prune paths older than 30 days.

**Insights:**
- Link lifetime is a real gap. `agent-fs signed-url` expires in 24 hours by default and 7 days at most. The tracker page outlives that. Either the page links to the `live.agent-fs.dev` viewer route (public per the artifacts skill, needs confirming for binaries and for a drive that is not personal) or the ingest script re-signs URLs when it regenerates the page. Fact for research.
- The Playwright HTML report is a directory of HTML plus assets. Uploading it file by file to agent-fs and serving it from the viewer may not work if the viewer does not serve sibling assets. A zipped report plus per-spec PNG screenshots is the safe minimum. Fact for research.
- CI needs an agent-fs token and drive id as secrets. This is the same class of secret the nightly harness legs already use, so the pattern exists.
- Pruning is a scheduled swarm script, which is more dogfooding and replaces a shell step in CI.

### Q: How much of the "swarm keeps the suites green" loop is in scope?
Full loop. Taras asked Claude to send a task to the production swarm lead describing the script contract the loop needs: persistence, dedup, workflow trigger, and the cases it must handle. The swarm designs and implements that contract in parallel with the suite work.

**Insights:**
- The loop has three legs, all driven by the ingest script: failure on main or nightly creates one triage task per failure fingerprint; exploratory findings create a "promote to spec" task; a green run closes open incidents.
- Task sent to the production swarm on 2026-09-04 (see the task text under "Swarm task" below). Its deliverables are the ingest script API, the tracker app models, the workflow that runs triage and promotion, the public page regeneration, the pruning schedule, and a JSON schema for the payload.
- Without `pw.ai`, the "promote" leg hardens by hand: the agent uses the exploratory session's step log plus Playwright's `init-agents` generator pattern (live-verified locators) to write plain specs. That keeps CI free of LLM calls, which is consistent with `pw.ai` being parked.
- Reviewer budget: promoted-spec PRs and fix PRs land on humans. The workflow should batch per night and cap PRs per day. This is a workflow config value, not a design change.

### Swarm task (sent 2026-09-04)

Production swarm task `065bfdb9-fdf7-4a24-8acd-90f0cccb0f4d` (unassigned, `feature`, tier `smart`, priority 60, tags `e2e ui-e2e scripts tracker workflows`). Sent over a fresh MCP HTTP session because the session's `agent-swarm-user` MCP client returned "Invalid session" twice.

Summary of what it asks for: a contract proposal posted as progress first, then implementation. The proposal must cover the ingest payload JSON schema, app models with upsert keys, shard aggregation and incomplete-run handling, failure fingerprint + incident lifecycle, the workflow it triggers for triage and for promote-to-spec with a PR-per-day cap, public page regeneration with non-expiring artifact links, a pruning schedule, and the auth model for CI, workers, and fork sandboxes. Deliverables: seeded script(s), app definition, workflow definition, page template, JSON schema file, tests, and a PR. Full text: `/tmp/2026-09-04-e2e-tracker-task.md` (copy into `thoughts/` if it should outlive the session).

### Q: Does the phasing "suite, tracker, swarm runner, pw.ai" hold?
Confirmed.

- **P1 Suite**: Playwright harness under `apps/ui/e2e` (worker fixture boots SUT + seed, built dist + per-worker proxy), route smoke + 3 flows, informational CI workflow with a sticky comment, GitHub artifacts.
- **P2 Tracker**: agent-fs upload, ingest to the swarm's script endpoint, public page. Starts when the swarm delivers the contract from task `065bfdb9`.
- **P3 Swarm runner + green loop**: label or comment trigger, nightly on main, agent-browser in worker-full, fork sandbox, triage and promote workflows.
- **P4 pw.ai**: native-feeling `act` / `assert` / `extract` on a fixture, AI SDK agent loop with a step cap.

**Insights:**
- P1 has no dependency on the swarm. P2 is mostly wiring once the contract exists. P3 is the first phase that touches `Dockerfile.worker` and the GitHub handler.
- Each phase is a separate plan. P1 is ready for `/create-plan` after research closes the fact-shaped questions below.

### Review round 1 (file-review + chat, 2026-09-04)

### Q (Taras, chat): The tracker should not be a seed. Template instead, installed by our lead via a task?
Agreed. Seeds run at boot on every install and would put desplega-specific scripts, schedules, a page slug, an app, and workflows into every tenant's catalog. A template is inert until installed, and installing it dogfoods the real install path.

The swarm had already opened PR #1349 (`jackknife/ui-e2e-tracker`, four seeded catalog scripts, 41 tests, a JSON schema, a runbook, verified live). Claude left a **changes requested** review asking to move the scripts into `templates/swarm-tooling/ui-e2e-tracker/`, add an idempotent lead-run install recipe, keep the tests by loading sources from the template, keep the schema at repo root, and never surface the endpoint bearer in a task result or comment.

**Insights:**
- The PR found real runtime constraints worth keeping: non-lead workers cannot read the endpoint bearer (`get-config includeSecrets` is masked), so workers call `script-run name="ui-e2e-ingest"` directly and only CI uses the bearer. Apps have no composite-unique constraint, so every model carries an indexed `*Key` and upserts are list-then-patch. `fnv1a64` fingerprint because the runtime import allowlist rejects `crypto`.
- The PR's "live viewer links never expire" claim is true only for logged-in team members. See the artifact decision below.

### Q (comment): Where will the code live?
New package `packages/ui-e2e/`.

**Insights:**
- Root `package.json` workspaces already include `packages/*`, and `bunfig.toml` uses the hoisted linker, so `@playwright/test` resolves from the root `bun.lock`. The package declares a Node engine and runs `npx playwright test`.
- The Bun-side boot (spawn SUT, seed, print a JSON handle) lives inside the package too, run with `bun`. `scripts/e2e/sut.ts` and `db.ts` are Bun-only (`Bun.spawn`, `Bun.$`, `bun:sqlite`), so the Node worker fixture spawns that boot script as a child rather than importing it.
- Needs wiring into `merge-gate.yml` lint and tsc jobs like `apps/ui`.

### Q (comment): We should be able to run the E2E against a remote API from the start.
Remote mode is an env target: `E2E_API_URL` + `E2E_API_KEY`, optional `E2E_UI_URL`. Seeding against a remote is off unless `E2E_REMOTE_SEED=1`. Specs that need the DB escape hatch carry a `@local` tag and skip remotely. A denylist refuses the prod API host.

**Insights:**
- Fact that makes this cheap: `apps/ui` already accepts `?apiUrl=&apiKey=` query params (`apps/ui/src/hooks/use-config.ts:71-140`) and keeps connections in `localStorage["agent-swarm-connections"]`, as long as the build has no `VITE_API_URL`. So the suite builds the UI once with no deployment config and injects any API per browser context. This replaces the per-worker proxy idea from earlier.
- The API must answer CORS for a UI origin on another port. The UI's connections page implies it does. Verify in the plan.

### Q (comment): Iron out the open questions now.
Done in-session. Three fact agents answered them. Results moved into "Resolved facts" under Synthesis. Five small fact questions remain for the P1 plan.

### Q (comment): What envs do we need for this to work?
Answered as an environment matrix under Constraints: local, CI internal PR, CI fork PR, CI main and nightly, remote target, swarm worker, fork sandbox, the SUT child, and the UI build.

### Q (comment): R10 should become a Linear ticket in Taras Brain.
Created `DES-782` "Build pw.ai (act/assert/extract) Playwright fixture for the UI E2E suite" with the full shape and references.

### Q: agent-fs is not public. What should the tracker page do?
Facts from the agent-fs source: every route needs a bearer, there are no public drives, the live viewer is an authed SPA that renders HTML as source, signed URLs run 60 seconds to 7 days and force download, keys are per user with no drive, write-only, or TTL scope, `write --file` hits `PUT .../raw` with a 50 MB cap, there is no directory upload, and there is no bulk delete or lifecycle.

Decision: **authed page, agent-fs only.** The tracker page uses `authMode: authed` and links live-viewer URLs for the team. No public surface, no second store.

**Insights:**
- The artifacts skill line "public, no auth required" (`templates/skills/artifacts/content.md:114`) is wrong and should be fixed.
- Fork sandboxes get no agent-fs key at all, since no scoped token exists. The trusted worker pulls files out of the sandbox and uploads them.
- Prune loops `rm` per path. PR #1349 already reports prefixes it could not delete.

## Synthesis

### Key Decisions

1. **One core for CI and for the swarm.** A Playwright harness (`test.extend` fixtures) is the shared foundation. The swarm's exploration must yield deterministic, committed specs.
2. **Deterministic suite ships first.** `pw.ai.{act|assert|extract}` is parked to P4 and tracked as Linear `DES-782`. When it lands: native-feeling methods on a fixture, Vercel AI SDK in agent mode with an iteration cap and a small browser-action tool set, OpenRouter key locally and in CI, live LLM calls allowed in CI. Reference shapes: cope's action enum and caps, Stagehand's cache-and-replay.
3. **Nothing gates merge yet.** Results are informational: sticky PR comment plus tracker page. Gate later once the flake rate is known.
4. **Seeding is API-driven, once per API instance,** with a direct DB read/write escape hatch (`bun:sqlite`) for states the API cannot express: stalled tasks, agent liveness, `costSource`, backdated `createdAt`, embeddings.
5. **v1 scope**: route smoke (zero console errors, zero failed API calls, one screenshot per route) plus three flows: task list to detail to session logs, settings configuration round-trip, create a page and open its share URL.
6. **Isolation is per Playwright worker**: a worker-scoped fixture spawns the SUT on a free port and seeds it. CI runs 2 fixed shards. Shard count is one config value.
7. **Code lives in a new package `packages/ui-e2e/`**: `playwright.config.ts`, fixtures, specs, the reporter, the Bun-side boot scripts, and later the `ai` fixture. Tracker and exploratory task templates live in `templates/swarm-tooling/ui-e2e-tracker/`. CI in `.github/workflows/ui-e2e.yml`. The payload schema stays at `schemas/ui-e2e-ingest.v1.schema.json`.
8. **Remote mode from day one**: `E2E_API_URL` + `E2E_API_KEY` (+ optional `E2E_UI_URL`) switch the fixture from "spawn SUT" to "use target". Remote seeding needs `E2E_REMOTE_SEED=1`. `@local` specs skip remotely. The prod API host is denied.
9. **UI connection injection, not proxying**: build the UI once with no `VITE_API_URL` / `VITE_API_KEY`, serve the dist once per job, and inject the API per browser context through `?apiUrl=&apiKey=` (or `addInitScript` writing `agent-swarm-connections`). Requires API CORS for the UI origin.
10. **Swarm exploratory runs boot the PR in-worker**, triggered by a PR label (default `swarm-explore`) or a bot mention, plus a nightly schedule on main.
11. **Fork PRs**: maintainer label required, execution in an ephemeral sandbox (E2B or throwaway container) that holds only an OpenRouter or harness key. No swarm key, no agent-fs key, no GitHub token. The trusted worker pulls artifacts out and posts the comment.
12. **Tracking is an installable template, never a seed.** One script exposed as a bearer-auth script API (`POST /api/x/script/{endpointId}`) is the CI ingest point. Swarm workers call the same script through `script-run` with no bearer. Storage is a swarm app (typed models, `*Key` upsert columns). The lead installs the template into our instance through an idempotent task. Re-running the install is the upgrade path.
13. **Tracker page is `authMode: authed`, artifacts live on agent-fs only.** Live-viewer links for the team. GitHub Actions artifacts remain the fallback for fork CI runs. Prune after 30 days by looping `rm`.
14. **Full green loop**: failures on main or nightly open one triage task per fingerprint (fix PR for spec or infra, Linear issue for app bugs). Exploratory findings open a promote-to-spec task. PR-per-day cap. Contract owned by prod swarm task `065bfdb9-fdf7-4a24-8acd-90f0cccb0f4d`, first implementation in PR #1349 (changes requested: template, not seed).
15. **Phasing**: P1 suite, P2 tracker, P3 swarm runner + loop, P4 pw.ai. One plan per phase.

Deferred, with defaults:

- Deferred: Playwright config. Defaulting to Node 22+, `npx playwright test` from `packages/ui-e2e`, chromium only, `retries: CI ? 2 : 1`, `trace: on-first-retry`, `screenshot: on`, `workers` bounded so at most a few SUTs boot in parallel per job.
- Deferred: boot handshake. Defaulting to `bun packages/ui-e2e/boot/sut.ts` printing one JSON line `{ apiUrl, apiKey, uiUrl, dbPath }` and exiting when stdin closes. The Node worker fixture spawns it, parses the line, and tears it down.
- Deferred: CI trigger paths. Defaulting to `ui-e2e.yml` (not in `merge-gate.yml`) on PR paths `apps/ui/**`, `packages/ui-e2e/**`, `scripts/e2e/**`, `src/http/**`, `src/be/**`, and on every push to main. The job sets up both Bun and Node.
- Deferred: sticky comment. Defaulting to a new generator in `packages/ui-e2e` with marker `<!-- ui-e2e -->`, and the `gh api` find-then-PATCH-or-POST steps copied from `slack-visuals.yml`.
- Deferred: exploration browser tool. Defaulting to `agent-browser` added to `worker-full-base` (needs Node 24+, image has Node 22 today), with Playwright's `init-agents` generator and healer definitions as the reference for the promote leg.
- Deferred: exploratory trigger wiring. Defaulting to adding `swarm-explore` to `GITHUB_EVENT_LABELS` and a label-specific prompt template. Today `github.pull_request.labeled` is one template for all labels, so a small code change is expected.
- Deferred: fork detection. Defaulting to tagging the task from `pull_request.head.repo.fork` in `src/github/handlers.ts`.
- Deferred: docs. Defaulting to updating `LOCAL_TESTING.md`, `runbooks/testing.md`, and `CLAUDE.md` in the P1 PR, and fixing the artifacts skill's "public, no auth required" line. The agent-browser screenshot convention for frontend PRs stays.

### Resolved facts (in-session research, 2026-09-04)

**UI**
- API URL and key: build-time `VITE_API_URL` + `VITE_API_KEY` must be both set or both empty (`apps/ui/src/lib/deployment-config.ts:1-47`, throws otherwise). At runtime `getConfig()` resolves deployment config, then a per-tab embed connection, then `localStorage["agent-swarm-connections"]`, then `http://localhost:3013` with no key (`apps/ui/src/lib/config.ts:24-27, 234-265`). `?apiUrl=&apiKey=` query params are read and stripped by `extractUrlParams()` (`apps/ui/src/hooks/use-config.ts:71-140`), disabled when deployment config is set. There is no login page. The `getBaseUrl()` relative-path branch is `import.meta.env.DEV` only (`apps/ui/src/api/client.ts:234`, `fs.ts:41`).
- Routes: about 50 in `apps/ui/src/app/router.tsx`; sidebar groups in `components/layout/app-sidebar.tsx:104-192`. Id-free routes cover home, agents, tasks, sessions, chat, services, schedules, workflows, connections, scripts, approval-requests, usage (+budgets, metrics), all settings pages, templates, mcp-servers, skills, people, memory, pages, apps. Id routes need a seeded agent, task, session root task, schedule, workflow, workflow run, connection, script, script run, approval request, integration, template, mcp server, skill, repo, person, page, or app.
- `vite preview` has no proxy config (`apps/ui/vite.config.ts:65-84` is `server.proxy` only). Irrelevant with connection injection.

**Runtime and CI**
- Root workspaces include `packages/*`; `bunfig.toml` linker is hoisted; one root `bun.lock`. No Playwright dependency exists today. CI uses only `oven-sh/setup-bun`; the single `setup-node` (Node 22) is for npm publish. `merge-gate.yml` `ui-lint` installs at the root and runs `check:tokens`, `lint`, `tsc -b` with `working-directory: apps/ui`.
- Worker image Node is 22 via nodesource (`Dockerfile.worker:62`). Playwright browsers at `/opt/playwright` in `worker-full` only.
- `startSut(keep, slackEnv, extraEnv)` (`scripts/e2e/sut.ts:56-142`) sets `PORT`, `API_KEY` + `AGENT_SWARM_API_KEY` (random hex), `DATABASE_PATH`, `NODE_ENV=test`, `AGENT_FS_LOCAL_DIR`, `SECRETS_ENCRYPTION_KEY_FILE`, `OAUTH_KEEPALIVE_DISABLE`, `GITHUB_DISABLE`, `GITHUB_WEBHOOK_SECRET=""`, `LINEAR_DISABLE`, `JIRA_DISABLE`, `AGENTMAIL_DISABLE`, `AGENTMAIL_API_KEY=""`, `ANONYMIZED_TELEMETRY=false`, then `extraEnv`. Free port from a `node:net` bind. Health poll every 250 ms up to 60 s. `stopSut` SIGTERM then SIGKILL after 5 s and deletes DB, WAL, SHM, log, temp dirs. Uses `Bun.spawn`, `Bun.$`, `Bun.file`; `db.ts` uses `bun:sqlite` read-only. Neither imports under Node.
- `scripts/e2e/visuals-comment.ts` is hardwired to the Slack visuals shape and marker (`visuals-comment.ts:96`). The upsert is inline `gh api` in `slack-visuals.yml:107-114`.

**Seeding through the API**
- All routes need the bearer; `X-Agent-ID` only where `auth: { agentId: true }` (`src/http/route-def.ts:74-75`).
- `POST /api/agents` (name required). `POST /api/tasks` (task required; omitted `agentId` defaults to the lead, so the task lands `pending`; `draft: true` then `POST /api/tasks/{id}/promote-draft`). `unassigned` or `offered` to `in_progress` only through `GET /api/poll` with `X-Agent-ID`. `POST /api/tasks/{id}/finish` with `X-Agent-ID` sets `completed` or `failed`. `/cancel`, `/pause`, `/resume`, `/supersede` exist. `POST /api/tasks/{id}/progress`. `POST /api/session-logs` (`sessionId`, `iteration`, `lines[]`, `taskId?`). `POST /api/session-costs` accepts `createdAt` epoch ms but not `costSource`. `POST /api/tasks/{id}/context` needs `X-Agent-ID`. `POST /api/pages` (`title`, `contentType`, `body`, `slug?`, `authMode?`). `POST /api/apps` creates only, no upsert by name. `POST /api/schedules`, `POST /api/workflows`, `PUT /api/config` (`scope`, `key`, `value`). `POST /api/memory/index` returns 202 and embeds asynchronously.
- DB-only states: stalled tasks (`agent_tasks.lastUpdatedAt`, stamped on every write, threshold 30 min in `src/be/db.ts:9206-9217`), crash-recovery pin tags, agent liveness (`agents.lastActivityAt`), exact `costSource` values, backdated `agent_tasks.createdAt`, memory embeddings.

**Swarm side**
- Mentions: `handleComment()` (`src/github/handlers.ts:875`) matches `GITHUB_BOT_NAME` (default `agent-swarm-bot`) and `GITHUB_BOT_ALIASES` from env, renders `github.comment.mentioned`, creates a `github-comment` task. Labels: `pull_request.labeled` (`handlers.ts:446-514`) gated by `GITHUB_EVENT_LABELS` (default `swarm-review`), renders `github.pull_request.labeled`. Templates are overridable per event type and scope through `PUT /api/prompt-templates` with `skip_event` support, but there is no label-specific template and no GitHub event to workflow trigger. No `src/routing/` exists.
- `postComment()` in `src/github/reactions.ts:228` posts an issue comment with the installation token but is unused. Agents post through `gh`.
- E2B (`apps/evals/src/swarm/sandbox.ts`): one sandbox per service. API sandbox from template `agent-swarm-api`, port 3013, integrations disabled, SQL fixture applied through the exec API before boot (`sandbox.ts:434-472`). Worker sandboxes from `agent-swarm-worker` with Playwright browsers at `/opt/playwright`. `src/commands/e2b.ts` is the `agent-swarm e2b` CLI it mirrors.

**agent-fs**
- No unauthenticated route (`packages/server/src/middleware/auth.ts:6-44`). No public drives (`packages/core/src/identity/drives.ts:53-64`). Live viewer is an authed SPA; `.html` is shown as text, no iframe. Raw route sets `Content-Disposition: attachment`. Signed URLs: default 24 h, range 60 s to 7 days, re-issuable without re-upload, attachment disposition, local-FS backend falls back to an authed app URL. One API key per user, no scoping. agent-swarm provisions one agent-fs user per agent as drive `editor` (`src/be/seed/agent-fs-provision.ts:236-306`). `write --file` calls `PUT .../files/<path>/raw`, 50 MB body cap, no directory upload, no bulk delete, no lifecycle.

### Open Questions

Fact-shaped, small, for the P1 plan:

- Does `src/http` send CORS headers for a browser origin on another port, and for `Authorization` preflights? Connection injection depends on it.
- Can `packages/ui-e2e/boot` import `scripts/e2e/sut.ts` under `scripts/check-e2e-boundary.sh` and the `scripts/e2e/tsconfig.json` scope, or should a copy of the minimal boot live in the package?
- How does `POST /api/tasks` create an `unassigned` pool task when an omitted `agentId` defaults to the lead? Explicit `null`, or `offeredTo`?
- Does a label-specific prompt template need a code change in `src/github/handlers.ts`, or can the `github.pull_request.labeled` template branch on the label name through interpolation?
- Which Playwright version to pin, and the CI cache key for `~/.cache/ms-playwright` (cope keys on `playwright --version`).

### Constraints Identified

- Playwright must run under Node. Bun has open browser-launch and module-resolution issues with `@playwright/test`. `scripts/e2e/sut.ts` and `db.ts` are Bun-only, so boot runs as a Bun child of the Node fixture.
- The API never serves the UI dist. The UI bakes its API URL at build time unless the build has no deployment config, in which case runtime connection injection works.
- Swarm apps have no public mode. Pages do, but the tracker page is `authed` by decision.
- agent-fs has no public access, no scoped tokens, no directory upload, no bulk delete. Signed URLs cap at 7 days and force download. Binary uploads need `agent-fs write --file` (CLI >= 0.7.1), 50 MB per file.
- Fork PR runs on GitHub Actions (`pull_request`) have no secrets and a read-only token.
- `worker-slim` has no browser. `worker-full` has Playwright, Chromium, qa-use, and Node 22, but not agent-browser (needs Node 24+).
- `POST /api/apps` is create-only. Upserts are list-then-patch on `*Key` columns. The scripts runtime import allowlist rejects `crypto`.
- Non-lead workers cannot read secrets from config. CI uses the endpoint bearer; workers use `script-run` directly.
- The merge gate must never depend on LLM availability.
- Repo rules: no hard-coded ports in tests, `getApiKey()` for the swarm key, DB boundary (only `scripts/` and API-server code may touch SQLite; `packages/ui-e2e/boot` must be allowlisted or spawn `scripts/e2e`), Dockerfile leaf-block and HOME-pollution traps, `check-e2e-boundary.sh` for `scripts/e2e`.
- GitHub Actions minutes: 2 shards, not one job per suite.
- Existing memory note "skip UI unit-test infra in this repo" still holds for unit tests. This brainstorm adds UI E2E, not unit tests.

### Environments and env vars

| Environment | Who runs it | Env it needs |
|---|---|---|
| Local dev (macOS) | Taras, agents in a worktree | Bun + Node 22+. `bun run e2e:ui` (working name) boots everything. Optional `OPENROUTER_API_KEY` (P4). Optional agent-fs vars for upload. No ingest. |
| CI, internal PR | `ui-e2e.yml` on `pull_request` | Secrets: `UI_E2E_INGEST_URL`, `UI_E2E_INGEST_BEARER`, `AGENT_FS_API_URL`, `AGENT_FS_API_KEY` (a dedicated CI user, editor on the e2e drive), `AGENT_FS_ORG_ID`, `AGENT_FS_DRIVE_ID`. `OPENROUTER_API_KEY` from P4. Both `setup-bun` and `setup-node`. `GITHUB_TOKEN` for the sticky comment. |
| CI, fork PR | same workflow, `pull_request` from a fork | No secrets. Upload with `actions/upload-artifact`. Skip ingest and agent-fs. Comment step skipped (read-only token) or moved to a `workflow_run` publisher later. |
| CI, main and nightly | `push` to main, `schedule` | Same as internal PR. Nightly adds the exploratory swarm run trigger (P3). |
| Remote target | anyone with a staging swarm | `E2E_API_URL`, `E2E_API_KEY`, optional `E2E_UI_URL`, `E2E_REMOTE_SEED=1` to allow seeding. Prod host denied. |
| Swarm worker (internal PR, nightly) | `worker-full` container | Normal worker env (`MCP_BASE_URL`, `AGENT_SWARM_API_KEY`, `AGENT_ID`), per-agent agent-fs key from `swarm_config`, GitHub installation token for checkout and `gh`, harness or `OPENROUTER_API_KEY` for exploration, agent-browser installed. Runs the same `bun run e2e:ui` in-container. |
| Fork sandbox (P3) | E2B sandbox from the worker template | Only a harness or `OPENROUTER_API_KEY`. No swarm key, no agent-fs key, no GitHub token. Artifacts pulled out by the trusted worker. |
| SUT child | spawned per Playwright worker | What `startSut` sets today: `PORT`, `API_KEY` + `AGENT_SWARM_API_KEY`, `DATABASE_PATH`, `NODE_ENV=test`, `AGENT_FS_LOCAL_DIR`, `SECRETS_ENCRYPTION_KEY_FILE`, all `*_DISABLE` flags, `ANONYMIZED_TELEMETRY=false`. |
| UI build | once per job | `VITE_API_URL` and `VITE_API_KEY` both empty so runtime injection works. `VITE_DEMO_MODE` unset. |

### Core Requirements

- **R1 Runner.** One command (working name `bun run e2e:ui`) builds the UI once, then runs the Playwright suite. Each worker gets a fresh seeded API and its own UI origin. Exits non-zero on failure. Works on macOS locally and on ubuntu in CI.
- **R2 Seed.** Idempotent, API-driven, with a DB escape hatch. Emits a manifest of stable handles (names, slugs) that specs select by. No IDs in specs.
- **R3 Specs.** Route smoke plus three flows. Specs use roles, labels, and seeded names. No hard-coded ports. Chromium only. A fixture slot named `ai` is reserved but unimplemented.
- **R4 CI.** `ui-e2e.yml`, informational, 2 shards, PR paths + main. Sticky PR comment with pass/fail per spec and screenshot links. Playwright report and traces uploaded.
- **R5 Ingest.** Each shard posts the run payload to the script endpoint when the bearer secret is present, and skips silently when it is absent.
- **R6 Artifacts.** agent-fs upload under the path convention with the binary-safe CLI route. GitHub artifact fallback. 30-day prune by a scheduled swarm script.
- **R7 Tracker.** An installable template (script, app definition, workflows, page, schema, install recipe) that the lead installs into our instance through an idempotent task. Private swarm app plus an `authed` page with live-viewer links. Never seeded. The bearer is revealed once to the lead and copied by a human into the CI secret.
- **R8 Exploratory runner.** Label or mention trigger and a nightly schedule. Internal PRs run in worker-full. Fork PRs run in a sandbox with no swarm, agent-fs, or GitHub credentials. Findings are posted as a PR comment by the trusted worker and ingested.
- **R9 Green loop.** Triage task per failure fingerprint, fix PR or Linear issue, promote-to-spec PR from exploratory findings, PR cap per day, incident closes on green.
- **R10 pw.ai (P4, Linear `DES-782`).** `act`, `assert`, `extract` on the `ai` fixture. AI SDK agent loop with a step cap and a small browser tool set. Every step logged (prompt, resolved locator, model, tokens, cost) for later hardening.

## Next Steps

- **Handoff: `/desplega:create-plan` for P1**, with this document as input. Scope: `packages/ui-e2e` (Node, `@playwright/test`), Bun boot + API-driven seed with the DB escape hatch, connection injection, route smoke + 3 flows, `ui-e2e.yml` informational with 2 shards and a sticky comment, remote mode, docs updates. The five Open Questions are settled inside the plan's research step.
- **P2** waits on PR #1349 being reworked into `templates/swarm-tooling/ui-e2e-tracker/` and installed by the lead. Then wire the reporter's ingest and agent-fs upload.
- **P3** (exploratory runner, fork sandbox, green loop) and **P4** (`DES-782`, pw.ai) get their own plans later.
- The worktree branch `worktree-brainstorm-ui-e2e-swarm` holds this doc uncommitted. Copy `/tmp/2026-09-04-e2e-tracker-task.md` and `/tmp/2026-09-04-pr-1349-review.md` next to it if they should outlive the session.
