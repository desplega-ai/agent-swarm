---
date: 2026-11-07T00:00:00+01:00
author: Taras
topic: "Browser and sandbox (preview server) primitives"
tags: [brainstorm, primitives, browsers, sandboxes, previews, providers]
status: complete
exploration_type: idea
last_updated: 2026-11-08
last_updated_by: Claude
---

# Browser and sandbox (preview server) primitives: Brainstorm

## Context

Taras wants a few small new swarm primitives, mainly **browsers** and **sandboxes** (previews, servers).

Target loop: a task starts a server with a change inside a sandbox. The sandbox stays open so that humans can check it and give feedback. The agent then iterates on the same sandbox.

Design intent: both primitives are easy to implement and use an interface (provider adapter) approach. Operators can add their own providers:
- Sandboxes: E2B, Daytona, and similar.
- Browsers: Browser Use Cloud, and similar.

### What exists today (facts, 2026-11-07)

- **Computer primitive brainstorm** (`thoughts/taras/brainstorms/2026-10-10-computer-primitive.md`, PR #2042, merged as docs only). It designs a `computers` entity with provider adapters, a per-kind op contract (`ctx.computers.<slug>.<op>()`), takeover and hand-back, owner and "lent to swarm" access, and a v1 `browser` kind (exty plus one cloud provider). Nothing from it is implemented: no `computers` code exists in `src/`.
- **Runtime providers** (`src/runtime-providers/`: docker, e2b, boxd, static) start and stop **worker runtimes** for runtime pools. The interface is DB-free, with traits (`canProvision`, `supportsPause`, `maxTtlSec`, ...). This is where workers run, not a user-facing preview.
- **Worker task sandboxes research** (2026-11-05, uncommitted, branch `t3/worker-agent-sandboxes`) covers isolation of the worker itself (gVisor, srt, microVMs). Different concern: it isolates the agent, not a preview for humans.
- **Pages** (`src/http/pages.ts`, migration 059) host static pages. No preview URL, port exposure, or tunnel concept exists for running servers.

## Exploration

### Q: How does this relate to the Oct 10 computer primitive brainstorm?
Slimmer replacement. Re-cut it into two small primitives (browser, sandbox) with thin provider interfaces. Reuse its decisions where they still fit. Drop the rest (consent levels, takeover state machine) unless a need shows up.

**Insights:** The Oct 10 doc becomes a source of reusable decisions, not the spec. Candidates to keep: server-side adapters (API owns state), scripts-first access, budget-gated provisioning, idle suspend plus reaper. Candidates to drop or defer: exty as a v1 adapter, the per-kind 23-op contract, the `human-controlled` state, consent levels, presence push.

### Q: Where does the preview server run, relative to the worker that writes the code?
A separate sandbox, driven from outside. The agent creates a sandbox (E2B, Daytona), syncs code in, runs the start command, and gets a public URL per port. The sandbox outlives the task.

**Insights:** This matches the Oct 10 "drive from outside" relation: workers stay unchanged. The interface follows the common shape of the E2B and Daytona SDKs: create, exec, files, preview URL per port, pause, destroy. It is a different seam from `src/runtime-providers/` (worker runtimes). Some adapters (e2b) can share client code, but the interfaces stay separate. Because the sandbox outlives the task, ownership and cleanup become first-class questions.

### Q: After a human checks the preview and leaves feedback, how does the agent iterate?
A follow-up task bound to the sandbox. Feedback (dashboard comment, Slack reply) creates a follow-up task in the same task tree, with the sandbox id attached. The agent reattaches, edits, restarts, and posts the new URL. This works after the original task has finished.

**Insights:** No worker slot is held while the human is away. The sandbox, not the agent session, carries continuity across iterations. So the sandbox row must point to its task tree, and the follow-up task must know "reattach sandbox X". This reuses the existing follow-up plumbing (`src/tasks/worker-follow-up.ts`). Context loss between iterations is mitigated by the sandbox state (files, running server) plus the task tree history.

**Provider facts (web research, 2026-11-07, from search summaries, verify before building):**
- All five sandbox providers checked (E2B, Daytona, Modal, Vercel, Cloudflare) support create, exec, background processes, and a URL per port. The interface shape is common.
- Preview URL auth differs: E2B header token (`allowPublicTraffic:false`), Daytona header token or signed expiring URL (iframe-safe), Modal connect tokens, Cloudflare token in the hostname (needs own wildcard domain), Vercel unclear.
- Persistence differs: E2B pause keeps FS and memory (paused up to about 30 days), Daytona stop and archive (auto-archive 7 days), Modal and Vercel FS snapshots only. Max continuous life is about 24 h on paid plans for E2B, Modal, Vercel.
- Cost is low: about $0.05 to $0.14 per vCPU-hour. Paused is free on E2B.
- All five browser providers checked (Browser Use, Browserbase, Steel, Hyperbrowser, Anchor) expose a CDP URL plus a live view URL and persistent profiles (cookies, storage, never open tabs). Interactive live view is confirmed for Browserbase and Hyperbrowser, unconfirmed for Browser Use and Steel. Max session about 4 to 24 h. About $0.02 to $0.12 per hour.

### Q: Who owns a sandbox and when does it die?
Polymorphic links ("metamorphic" in Taras's words): a sandbox has a source task, a PR when applicable, and other links. Idle pause and TTL are key.

**Insights:** Interpretation: a sandbox row carries a small set of typed links (source task, task tree root, PR, possibly workflow run or Slack thread) instead of one fixed owner field. Each link can drive behavior: the source task gives the requesting user and the follow-up target, a PR close or merge can trigger destroy, a Slack thread is where the URL is posted. Pause after idle and destroy after TTL apply to every sandbox, whatever links it has. The same link model likely fits browsers too.

### Q: How does the agent's code change get into the sandbox?
Git first: the agent pushes its branch, and the sandbox clones or pulls `{repo, ref}`. Upload must also be possible for some cases.

**Insights:** The API injects a short-lived scoped git token only for the clone or pull, so long-lived repo credentials never sit in the sandbox. Upload covers non-git content (generated sites, scratch apps). Upload needs a worker-side path, because MCP tools run on the API and cannot read the worker filesystem. Options: a worker CLI that tars a directory and POSTs it, or an upload through agent-fs (the worker writes, the API copies into the sandbox). The interface needs a `writeFiles` (or `uploadArchive`) op for this either way.

### Q: What surface do agents get for sandboxes?
Scripts-only, like the Oct 10 decision: `ctx.sandboxes.*` in scripts, plus one list tool on MCP.

**Insights:** Every iteration step (refresh, exec for logs) costs a script run, so the seeded skill must show the common loops as short script examples. The surface needs a type contributor (`src/be/scripts/type-contributors.ts`), the QuickJS prelude mirror, and `SDK_TOOL_NAME_MAP` or `EXCLUDED_TOOLS` entries. Long operations (clone plus install plus start) can pass the 30 s default script wall clock, so create and refresh are likely async: return at once, then poll state or wait with a bounded timeout up to the 5 min cap.

### Q: How does a sandbox know how to set up and start the app?
Both. Swarm-side templates in the DB are the general mechanism. A repo file covers custom setup.

**Insights:** Interpretation of the layering: a DB template (operator-defined, picked by name or matched by repo) gives provider, image or template, resources, TTL, and env references. A checked-in repo file (for example `.agent-swarm/sandbox.json`) adds or overrides the app-specific parts: setup, start, ports. The create call overrides last. Precedence: template, then repo file, then call. Templates also give the operator one place to cap cost (provider, size, TTL) whatever the repo file says.

### Q: Who can open a sandbox preview URL?
A signed expiring link, minted by the swarm. The provider URL is private. The swarm mints a short-lived signed link per viewer (dashboard button, Slack post). Links are shareable with reviewers outside the swarm and revocable. Nothing is public by default.

**Insights:** Provider support is uneven, so the adapter decides how to make the link. Daytona has native signed, expiring, iframe-safe URLs. Modal accepts a `_modal_connect_token` query parameter or cookie. Cloudflare puts the token in the hostname. E2B only accepts a header token (`e2b-traffic-access-token`), which a human browser cannot send. For E2B, the swarm needs a thin redirect or proxy hop that sets a cookie or header. So the interface is `previewLink(port, ttl)`, with a trait that says "native" or "needs swarm hop". Revocation for native links depends on the provider (Daytona standard tokens cannot be revoked, signed URLs can).

### Q: How do env and secrets reach the previewed app?
Templates (and repo files) reference swarm secrets by name. The agent can also send env at create. Operators may configure them in the dashboard.

**Insights:** Three sources, one rule: values resolve on the API server and go only into the sandbox env. Repo files hold references, never values. The dashboard template editor gets an env section (plain values plus secret references). Agent-sent env is allowed, and agent-sent secret references resolve server-side the same way. Exec output and logs go through `scrubSecrets`. Open point for research: which secret scope an agent may reference (its own, the requesting user's, global).

### Q: What is the main job of the browser primitive in v1?
A persistent, logged-in cloud browser with a live view. The profile keeps logins across sessions. The agent drives it. A human can watch and take over through the provider's live view (for example to log in or solve a captcha).

**Insights:** Throwaway headless use stays on the worker's local `agent-browser`. The primitive adds three things a worker cannot give: persistence (profile), a human-visible live view, and takeover. Fact (checked 2026-11-08): `agent-browser` already supports `--cdp <url>` and `connect <url>`, and has built-in providers (`-p browserbase`, `browseruse`, `browserless`, ...). So the worker can drive a remote browser with the CLI it already knows, if it gets a CDP URL. Exty (the human's own browser) stays deferred.

### Q: How does the agent drive the cloud browser?
A script returns a short-lived CDP URL, and `agent-browser` drives it. `ctx.browsers.open(id)` resumes the session and returns the CDP URL. The agent then runs `agent-browser --cdp <url> ...`, as it does locally.

**Insights:** The swarm does not maintain a browser op contract, which removes the biggest part of the Oct 10 design. Provider keys stay on the API server; only the per-session URL reaches the worker. The CDP URL is a credential while it lives: short TTL, scrubbed at every egress (a new secret shape for `scrubSecrets`). Browser Use docs warn against exposing the CDP URL, so the TTL and scrub rules matter. Audit is coarse (open and close events, not each click).

### Q: How do human takeover and hand-back work for the browser?
Agent-initiated ask, no state machine. When the agent hits a login or captcha, it calls `request-human-input` with a signed live-view link. It continues when the human answers. Humans can also open the live view at any time from the dashboard. No `human-controlled` state and no lock. Conflicts are rare and the human wins.

**Insights:** This drops the Oct 10 takeover state machine and reuses the existing human-input path. The signed live-view link uses the same minting as sandbox preview links. Interactive live view must be confirmed per provider (confirmed for Browserbase and Hyperbrowser, unconfirmed for Browser Use and Steel). A provider without an interactive live view can still serve the agent-only case.

### Q: Who may use a browser profile?
Named profiles, owned by a user or by the swarm. A profile (persistent logins) is separate from a session (a running browser: ephemeral, linked to a task, with pause and TTL like sandboxes). A user-owned profile serves only that user's tasks. A swarm-owned profile (for example `qa-bot`) serves any agent.

**Insights:** This keeps the Oct 10 owner rule and drops consent levels and the "lent" toggle. A swarm-owned profile is the "lent" case. The access check runs when `ctx.browsers.open` resolves the profile, using the session's source-task link to find the requesting user. Profiles are provider-specific (a Browserbase context cannot move to Steel), so a profile row records its provider. Profiles keep cookies and storage, never open tabs.

### Q: How much code and data do sandboxes and browser sessions share?
A shared base with kind-specific adapters. One base lifecycle interface (create, status, pause, resume, destroy, traits) and one table with a `kind` column. Links, reaper, link minting, and cost are shared. Each kind adds its own interface: sandbox (exec, files, previewLink), browser (cdpUrl, liveViewLink, profiles).

**Insights:** A third kind later (for example a desktop VM or a database branch) is a new kind interface, not new plumbing. This is close to the Oct 10 "computers" entity, without the op contract. Profiles get their own table, because they outlive sessions. The base stays separate from `src/runtime-providers/` (worker runtimes). An E2B adapter can share client setup with the runtime provider, not the interface.

### Q: Which providers ship in v1?
E2B for sandboxes, Browser Use for browsers.

**Insights:** E2B: the swarm already has E2B credentials and templates, pause keeps FS and memory and costs nothing while paused. E2B accepts only a header token on private URLs, so the swarm needs the redirect or proxy hop for signed links in v1. Browser Use: Taras's earlier pick and the cheapest option. Research must confirm that its live view is interactive (the takeover decision depends on it) and how its profiles persist. `agent-browser -p browseruse` exists, but the drive decision uses a plain CDP URL, so the adapter only needs the session API.

### Q: Where does the human see the preview and leave feedback?
In the origin channel, plus a dashboard page. The agent posts the signed link where the task came from (Slack thread, PR comment, dashboard task). A reply there becomes the follow-up task through existing routing. The dashboard gets a page for sandboxes and browser sessions (state, links, live view, logs, pause, destroy) with a feedback box. No in-preview comment overlay in v1.

**Insights:** The origin channel comes from the sandbox's source-task link, so the polymorphic links decision pays off here. The dashboard feedback box creates the same follow-up task as a channel reply, with the sandbox id attached. Reviewers outside the swarm can view through the signed link, but they comment only where they already have access (Slack, GitHub). An overlay stays a later option, because the E2B swarm hop could inject it.

### Q: What does "implement your own providers" mean for v1?
In-repo adapters with a clean interface, like `src/runtime-providers/` and `src/providers/`. Adding a provider (for example Daytona) is one file, a registry entry, and the shared contract tests. Out-of-tree adapters (extensions or a remote controller) wait for a real request.

**Insights:** A shared contract test suite per kind is what makes "add one file" true: every adapter runs the same create, exec, preview link, pause, resume, destroy checks against a fake or a live account. Provider credentials go through encrypted swarm config, and each provider host joins the egress allowlist.

### Q: Who may create sandboxes and browser sessions, and what stops runaway cost?
Agents create freely under caps. Any agent can create through scripts. Limits: a maximum of live (unpaused) resources per task tree and per swarm, template-level size and TTL, and cost recorded per resource and rolled into the existing budget admission and the Usage page. Over a cap, the call fails with a clear error. No human approval step.

**Insights:** Paused resources do not count against the live cap, which suits E2B (paused is free). Cost per resource is provider time times a rate from the adapter, not token cost, so it needs a non-token line in budget admission and the Usage page.

## Synthesis

### Key Decisions
- **Replaces the Oct 10 computer primitive** as a slimmer design. Kept: API-side adapters, scripts first, owner rule, budget-gated provisioning, idle pause and reaper. Dropped: the per-kind op contract, the `human-controlled` state, consent levels, the "lent" toggle, exty in v1.
- **Two kinds on one shared base.** One base lifecycle interface (create, status, pause, resume, destroy, traits) and one resource table with a `kind` column. Shared: links, reaper, signed-link minting, cost. Kind interfaces: `sandbox` (exec, files, previewLink) and `browser` (cdpUrl, liveViewLink, profiles). Separate from `src/runtime-providers/` (worker runtimes).
- **Polymorphic links.** A resource has typed links: source task, task tree root, PR when applicable, and others (workflow run, Slack thread). Links drive behavior: requesting user, follow-up target, origin channel, destroy on PR close.
- **Lifecycle.** Idle pause and TTL destroy apply to every resource. Lazy resume on next link open or reattach.
- **Sandbox runs separately and is driven from outside.** Workers stay unchanged. The sandbox outlives the task.
- **Code sync.** Git first: the agent pushes a branch, and the sandbox clones or pulls `{repo, ref}` with a short-lived scoped token injected by the API. Upload is also supported for non-git content.
- **App config in layers.** DB templates (operator-defined, general: provider, image, size, TTL, env) then a repo file (custom: setup, start, ports) then the create call. Later layers override earlier ones.
- **Env and secrets.** Templates, repo files and agents reference swarm secrets by name. Values resolve on the API and go only into the sandbox env. Repo files never hold values. The dashboard edits template env. Exec output is scrubbed.
- **Preview access.** The provider URL is private. The swarm mints short-lived, revocable, signed links per viewer. Native where the provider supports it, a swarm hop otherwise (E2B).
- **Feedback loop.** The agent posts the signed link to the origin channel (Slack thread, PR comment, dashboard task). A reply there, or the dashboard feedback box, creates a follow-up task in the same tree with the resource id attached. The agent reattaches, edits, refreshes, and posts again.
- **Agent surface is scripts only.** `ctx.sandboxes.*` and `ctx.browsers.*`, plus one MCP list tool. A seeded skill shows the common loops as short scripts.
- **Browser job.** A persistent, logged-in cloud browser with a live view. Throwaway headless use stays on the worker's local `agent-browser`.
- **Browser driving.** `ctx.browsers.open(id)` returns a short-lived CDP URL. The agent runs `agent-browser --cdp <url>`. No swarm op contract.
- **Takeover.** Agent-initiated: `request-human-input` with a signed live-view link. Humans can open the live view at any time. No lock, no state machine. The human wins conflicts.
- **Profiles.** Named profiles, owned by a user (that user's tasks only) or by the swarm (any agent). A profile is separate from a session and records its provider.
- **v1 providers.** E2B (sandbox) and Browser Use (browser).
- **Extensibility.** In-repo adapters: one file, a registry entry, and a shared contract test suite per kind. Out-of-tree adapters wait for a real request.
- **Budget.** Agents create freely under caps: live resources per task tree and per swarm, template size and TTL. Cost per resource joins budget admission and the Usage page. Over a cap, a clear error.
- Deferred: **idle and TTL defaults.** Defaulting to pause after 30 minutes idle and destroy after 7 days untouched, both operator-tunable. For E2B, "idle" uses traffic seen by the swarm hop plus the last exec.
- Deferred: **PR-close behavior.** Defaulting to destroy on PR merge or close when a PR link exists.
- Deferred: **upload path.** Defaulting to an upload through agent-fs (the worker writes, the API copies into the sandbox), so no new worker CLI is needed.
- Deferred: **secret scope for agent references.** Defaulting to the same scopes the agent can already resolve today (global plus its own), with requesting-user secrets only when the source task has a requesting user.
- Deferred: **caps defaults.** Defaulting to 3 live resources per task tree and 20 per swarm.
- Deferred: **in-preview comment overlay.** Not in v1. The E2B swarm hop could inject it later.
- Deferred: **exty (human-shared browser).** Not in v1. It can become a third adapter of the `browser` kind later.

### Open Questions
- Browser Use: is the live view interactive (click and type), can it be embedded in an iframe, how do profiles persist, how is a session suspended or resumed, and how long does a CDP URL stay valid? (input for `/research`)
- E2B: confirm `allowPublicTraffic:false` behavior and the token flow, pause and resume limits (max paused time, timeout reset), the 24 h continuous limit on the current plan, and git clone support in the SDK. (input for `/research`)
- What is the cleanest swarm hop for E2B signed links: a redirect that sets a cookie on a swarm domain, or a streaming proxy (websockets and HMR must work)? Which host serves it? (input for `/research`)
- How does the existing follow-up path (`src/tasks/worker-follow-up.ts`, Slack thread replies, PR comments) attach context to a follow-up task, so a resource id can ride along? (input for `/research`)
- How are a new `ctx.*` surface and its types added: the type contributor in `src/be/scripts/type-contributors.ts`, the runtime ctx, the QuickJS prelude mirror? (input for `/research`)
- How do budget admission (`src/be/budget-admission.ts`) and the Usage page attribute non-token cost today? (input for `/research`)
- Which E2B client code in `src/runtime-providers/e2b.ts` can the sandbox adapter reuse? (input for `/research`)
- How does the swarm mint a scoped, short-lived git token today (GitHub app installation tokens, GitLab), and can it be limited to one repo with read access? (input for `/research`)
- Can the dashboard embed a provider live view in an iframe (CSP `frame-src`), or must it open a new tab? (input for `/research`)

### Constraints Identified
- The API server is the sole DB owner. Adapters, the reaper, link minting and the swarm hop run API-side. Workers reach resources only through scripts over HTTP.
- Scripts run under a 30 s default wall clock (5 min cap). Create and refresh must be async with explicit bounded waits.
- New `ctx.*` surfaces need a type contributor, a QuickJS mirror, and `SDK_TOOL_NAME_MAP` or `EXCLUDED_TOOLS` entries (CI-enforced).
- Provider keys, git tokens, CDP URLs and signed links are secrets: encrypted config, scrubbed at every egress (new secret shapes in `scrubSecrets`), egress allowlist per provider host.
- New routes use the `route()` factory with an RBAC posture and typed 2xx schemas. New routes and tools need black-box E2E scenarios. A migration must sort above `main`'s tail.
- Provider differences are real (link auth, persistence, max lifetime). The interface exposes them as traits, not as optional methods.
- Paid plans limit continuous sandbox life to about 24 h, so long feedback cycles depend on pause and resume.

### Core Requirements
- A base resource interface and registry, plus kind interfaces for `sandbox` and `browser`, with traits (link auth mode, supports pause, max lifetime).
- One resource table (`kind`, provider, state, template, typed links, external id, last activity, cost to date) and a profiles table (name, owner, provider, external id).
- DB-backed sandbox templates editable in the dashboard, merged with the repo file and the create call.
- Sandbox ops: create from `{repo, ref}` or upload, refresh (pull plus restart), exec (logs, debug), preview link per port, pause, resume, destroy.
- Browser ops: create session with a profile, open (CDP URL), live-view link, close; profile create, list, delete.
- Signed-link minting with expiry and revocation, native or through a swarm hop.
- Reaper: idle pause, TTL destroy, PR-close destroy, caps enforcement.
- Scripts surface `ctx.sandboxes.*` and `ctx.browsers.*`, one MCP list tool, and a seeded skill with loop examples.
- Follow-up tasks carry the resource id. The agent posts links to the origin channel.
- Dashboard page: list, detail (state, links, live view, logs), pause, destroy, feedback box, template and profile management.
- Cost per resource in budget admission and the Usage page.
- Adapters: E2B sandbox and Browser Use browser, each passing a shared contract test suite for its kind.

## Next Steps

- Brainstorm complete on 2026-11-08. The file-review window timed out with no comments.
- Next: `/desplega:research` on the Open Questions above, then `/desplega:create-plan` for v1 (E2B sandbox and Browser Use browser on a shared base).
