---
date: 2026-10-25T01:55:00+02:00
author: Claude (with Taras)
topic: "agent-fs in the agent-swarm onboarding"
tags: [brainstorm, onboarding, agent-fs, comb, invites, memory]
status: complete
exploration_type: problem
last_updated: 2026-10-25
last_updated_by: Claude
---

# agent-fs in the agent-swarm onboarding: Brainstorm

## Context

From the 24-25 Oct onboarding feedback rounds (`/tmp/2026-10-25-0051-onboarding-round2.md`, D7 and D10).

Taras's comment on D10 (invite members), verbatim in substance: agent-fs should start automatically too, with a local embedding model at first. The user must know how to set it up. Today it is messy: Comb (still beta) on one side, the live agent-fs on the other, and users must create an account and then ask the swarm to invite them. Should it be part of onboarding, with a one-click install and a link to agent-fs with the UI already set up? Maybe a "Connect with agent swarm" flow from agent-fs.

What we know so far:
- `install.sh` / `agent-swarm onboard` starts no agent-fs container. Only the Compose example (agent-fs plus MinIO) and the onboarding-qa `stack` mode run one.
- agent-fs runs local embeddings in-process (node-llama-cpp, nomic-embed-text-v1.5, 768 dims). It has no embed endpoint for other services.
- Swarm memory works with no key (keyword search only). Semantic recall needs an OpenAI-compatible embeddings key. The polish PR adds an honest "keyword search only" choice (D7 options 1 and 2).
- No team invite flow exists in agent-swarm. People has "New user", per-user `aswt_` tokens are minted by hand, and RBAC roles exist in the API with no UI.
### Facts (code read, 25 Oct)

- **The swarm already provisions agent-fs by itself.** Set only `AGENT_FS_API_URL`, and a boot seeder registers an admin, creates the org `swarm` and the drive `shared`, mints one key per agent, and invites every swarm user with an email (`src/be/seed/agent-fs-provision.ts`). A config reload can switch from `local-fs` to agent-fs without a restart.
- **Install paths:** `agent-swarm onboard` (so `install.sh`) generates no agent-fs. The Compose example, `docker-compose.local.yml` and stack mode run agent-fs plus MinIO. Helm has `agentFs.enabled: false` by default.
- **MinIO is not required.** agent-fs supports `AGENT_FS_STORAGE_PROVIDER=local` (local disk, file versions kept, single replica). Helm already exposes it.
- **Local embeddings:** the default `EMBEDDING_PROVIDER=local`. EmbeddingGemma 2 (339 MB download, plus 195 MB for images), or nomic-embed-text-v1.5 as the lighter model. agent-fs docs say plan 2 GB RAM for the default model. No measured idle numbers.
- **Comb** (review space in the dashboard) is off by default (`COMB_ENABLED=false`). A human gets in with "Create with my email" (registers an agent-fs account, key kept in the browser) or "Paste a key". If the account cannot read the swarm drive, the swarm API invites it as editor.
- **agent-fs auth is API keys only.** `POST /auth/register {email}` is public, with no email check. An invite fails until the invitee has registered. No OAuth, device code, magic link or SSO.
- **Swarm side:** users have emails, `aswt_` user tokens and RBAC roles. The swarm route `POST /api/fs/members/invite` invites an email with the bootstrap key. No MCP tool calls it.
- **Live UI** (`live.agent-fs.dev`) is a separate SPA that takes an API URL and a key.

## Exploration

### Q: What kind of exploration is this?
Problem to solve.

**Insights:** Most of the plumbing exists (seeder, per-agent keys, email-based invites, local storage, local embeddings). The mess is in the human path: two surfaces (Comb in the dashboard, the live UI), a manual account step, and no install path that starts agent-fs.

### Q: In a new user's first session, what is agent-fs for?
See agent work in the dashboard (Comb). Taras: "the problem is sometimes the agent sends live agent-fs links instead of internal, so we should have a way to control this. Check latest main, I think we did some changes in that direction."

**Insights (checked on main, 25 Oct):**
- Main moved the other way. #2400 (merged 24 Oct, 22:17 UTC) tells agents to hand people "the live app link `${AGENT_FS_LIVE_URL}/file/~/<org>/<drive>/<path>`" and to make `share-create` links only on request. The base prompt reads it at `src/prompts/session-templates.ts:204-205`.
- `AGENT_FS_LIVE_URL` defaults to `https://live.agent-fs.dev` (`src/utils/constants.ts:77-89`). The comment there says self-hosted operators should set it. A new install never does.
- The dashboard already serves the same path shape: `/file/~/:orgId/:driveId/*` opens Comb (`apps/ui/src/app/router.tsx:226-227`). So an "internal" link is `${APP_URL}/file/~/<org>/<drive>/<path>`, with the same suffix as the live link.
- So the control is one value: the base URL that file links use. Today it is always the live app.

### Q: Which link should agents give people for a file?
The dashboard when Comb is on. Taras: add a new env, on by default for new installs only, so existing installs keep today's behavior. Add a UI toggle too. Also discuss feature parity of Comb with the agent-fs live UI: search, a sidebar as good as the live one, semantic search, batch sending of comments ("I think it's broken now"), MIME types, share links, presence.

**Insights:**
- Shape: a new env (for example `AGENT_FS_LINK_TARGET=dashboard|live`). Unset means `live`, so existing installs do not change. `agent-swarm onboard` and the Compose example write `dashboard` for new installs. It goes in the Settings > Configuration catalog as the UI toggle (the repo rule for operator env vars). The base prompt and the attachment links read one resolved value.
- If Comb is worse than the live UI, dashboard links make the experience worse. So parity is a precondition for the default. A parity pass (Comb vs live UI, from code) is running.

### Q: Should every `install.sh` / onboard install start agent-fs?
Yes, light by default: one agent-fs container on local disk (no MinIO), a light local embedding model, Comb on. Taras: also check whether an embedding model can run as its own Docker container, so agent-swarm and agent-fs share one embeddings service.

**Insights:**
- A shared server fits the swarm side well: swarm memory already speaks the OpenAI embeddings API with a configurable base URL. agent-fs support for an OpenAI-compatible base URL is not checked yet.
- Open risks: vector dims (swarm 512, agent-fs 768), nomic task prefixes, and existing installs that already hold vectors. A research pass on TEI, Ollama, llama.cpp server, Infinity and LocalAI is running.

### Facts: Comb vs the agent-fs live UI (code read, main `0afb7d8d7`, agent-fs v0.18.4)

| Area | Comb | Live UI |
|---|---|---|
| Tree | Yes, lazy | Yes, plus Recent and Favorites |
| Drive / org switch | No (swarm drive only) | Yes |
| Search: name, full text, semantic | **No** | Yes (hybrid, FTS, semantic, fuzzy name) |
| Viewers | Markdown, text, image, video, PDF, table. No audio. JSON and HTML as source | Adds audio, rendered HTML, parquet, xlsx, sqlite/duckdb, a SQL page |
| Editing, upload, rename, delete, move | **No** (read-only plus comments and revert) | Yes |
| Inline comments, threads, resolve | Yes | Yes |
| @mentions, "Send to swarm", revert UI, offline outbox | Yes | No |
| Share links | **No** | Yes |
| Presence | Yes, through the swarm API | Yes, through agent-fs |
| Realtime changes, versions, diff | Yes | Yes |
| Members / invite UI | Read-only list | Read-only list |

- **Batch comment sending:** in Comb, "batch" means "Send N to swarm", for root comments that contain `@swarm`. The code path shows no defect (UI, route, server and markers match). It can look broken: one unreadable comment fails the whole batch (502), a non-swarm drive gives 400, missing org or drive ids give 503, everything already sent gives 409, and a task made with no lead online may sit unassigned (not checked). A held set of draft comments sent together (like a GitHub review) exists in neither UI. Not tested live.
- **Browser path (detail below):** Comb's browser calls agent-fs directly at `AGENT_FS_PUBLIC_URL` (falling back to the internal `AGENT_FS_API_URL`) with the person's own `af_` key. Only `/status`, the presence socket and "Send to swarm" go through the swarm API. The Compose example sets no public URL, so a remote browser gets "Cannot reach agent-fs". Behind a tunnel, agent-fs needs its own public HTTPS URL, and media signed URLs need a reachable storage endpoint.

### Q: How should the browser reach a bundled agent-fs?
Taras: "check the envs we set, we should ensure to set all the correct envs of the agent-swarm on start so that it knows where to use it. unsure tbh".

**Insights:**
- Deferred, defaulting to a proxy through the swarm API. With a proxy, every value the swarm needs at start can be derived from what `install.sh` already knows:
  - `AGENT_FS_API_URL=http://agent-fs:7433` (internal, written by onboard).
  - `AGENT_FS_PUBLIC_URL` = the public API URL plus `/agentfs`. `install.sh --tunnel` already writes `PUBLIC_MCP_BASE_URL`, so the API can derive it, and no second tunnel or extra env is needed. On a laptop it is `http://localhost:3013/agentfs`, the same origin as the API, so the browser rules are the same as for the API (D9).
  - `COMB_ENABLED=true` and the new link-target env (`dashboard`), written by onboard for new installs only.
  - agent-fs: `AGENT_FS_STORAGE_PROVIDER=local` and the embedding settings below.
- A second tunnel would double the certificate waits and the random hostnames. "Swarm-only access" loses per-person agent-fs identity.

### Facts: one embeddings container for both services
- **Swarm memory** can use a local OpenAI-compatible server today with no code change: `EMBEDDING_API_BASE_URL`, `EMBEDDING_MODEL`, any non-empty key, and `EMBEDDING_DIMENSIONS` (default 512, read at boot). It sends `dimensions` on every request. It adds no nomic task prefixes. A model change at the same dims does not re-embed, and a dims change on an install that already has vectors needs a manual vec-table rebuild (not tested). New installs have no vectors, so they can start at 768.
- **agent-fs** has `local` (nomic in-process through node-llama-cpp, or EmbeddingGemma 2 in a worker, both 768 dims), `openai` (hardcoded model, no base URL) and `gemini`. It cannot call an OpenAI-compatible URL today. A small `openai-compat` provider (base URL, model, prefixes, its own name) would do it. Changing the provider re-embeds every file once, and search keeps working meanwhile.
- **Servers:** Hugging Face TEI (CPU images for x86_64 and arm64, OpenAI `/v1/embeddings`, nomic v1.5 supported, Apache-2.0) is the best fit. Ollama is the low-friction fallback (`dimensions` documented, no prefixes). llama.cpp server works with client-side prefixes. Image sizes, RAM and throughput were not measured.

### Q: How should a bundled install get embeddings with no key?
One Hugging Face TEI CPU container with nomic-embed-text-v1.5, for both services.

**Insights:** Swarm memory needs only env (base URL, model, a dummy key, 768 dims on new installs). agent-fs needs an `openai-compat` provider. Both should add nomic task prefixes (`search_query:` / `search_document:`), or quality drops. Existing installs keep their current embeddings. Moving them is a separate, manual migration.

### Q: What must Comb gain before dashboard links become the default for new installs?
Search (name and semantic), share links, the audio and rendered-HTML viewers, and uploads ("should be easy"). Taras: "drive org control is not relevant as the core part is using the swarm defaults".

**Insights:** Editing, rename, delete and move stay in the live UI through "Open in agent-fs". Comb stays scoped to the swarm drive. agent-fs already has the ops for all of these (`search`, `fts`, `find`, share create, writes), so this is UI work in Comb, not new agent-fs API.

### Q: On a bundled agent-fs, how does a person get their agent-fs account?
Taras: "it should be as part of the setup, probably an additional step, explaining what is it you know?"

**Insights:** A new `/setup` step for files. Step 1 already collects the person's email, and the swarm already owns the bundled agent-fs (bootstrap admin key), so the step can create the account and the drive invite with no key to paste. Installs without a bundled agent-fs need a different path in the same step (connect an existing agent-fs, or skip).

### Q: What does the new Files step in `/setup` do?
It explains agent-fs. The account is created automatically, with no click. Taras: "if we do not [have it], we should ensure we have asked for user email before this so it's done".

**Insights:** The email from step 1 ("Who are you?") becomes a hard input for the Files step. Step 1 must require it on installs with a bundled agent-fs. agent-fs register has no email check, so the swarm should only register the email the person gave in step 1, never a typed one in the Files step.

### Q: Where should "Invite your team" live?
At the end of setup (a closing card when team size is not "Just me") and on the People page. Taras: "but sharing might be hard, right? like we need to explain how others should be able to access the swarm, probably with personal tokens instead of operator??"

**Insights:** An invite must give the teammate their own access, not the operator key. A link that carries a token is a secret in chat. A safer shape is a one-time invite code that the dashboard exchanges for a personal token on first open. A fact pass on `aswt_` user tokens, RBAC and invite mechanisms is running.

### Facts: personal access for teammates (main, 25 Oct)
- `aswt_` user tokens exist: about 143 bits, hash stored, no expiry, revocable, no per-token scope (the token carries its user's role).
- A bearer `aswt_` resolves to that user if the user is `active`. RBAC is on by default. **Every new user gets the `admin` role by default** (DB trigger), so a teammate is an admin unless the role is narrowed. Roles: `admin` (all), `requester` (own tasks, file changes, sessions), `viewer` (almost read-only).
- The dashboard already accepts an `aswt_` key in a URL (the DES-771 embed flow). It is stored per browser tab only, with identity from `/api/whoami`.
- No invite flow exists. The `invited` status cannot log in. A reusable piece exists: **connector codes** (`src/be/connector-codes.ts`), single use, 10 minute TTL, hash stored, exchanged at a public, rate-limited route for a freshly minted `aswt_` token. It is shaped for the agent-swarm.dev connector.
- The agent-fs seeder invites every swarm user with an email to the shared org. A failed invite only logs a warning. Whether agent-fs needs the person registered first is in agent-fs, not checked here.

### Q: What happens to existing installs?
Full backward compatibility. Taras: "for current installs it should be no change at all".

**Insights:** Every new behavior (bundled agent-fs, TEI, the link-target env, Comb on, the Files step, invites) is written by onboard or the Compose example for new installs only. Server defaults stay as today when the new envs are unset. "Connect with agent swarm" from the hosted live agent-fs is parked.

## Synthesis

### Key Decisions
- **First-session job:** agent-fs is where agents put their work, and people read and review it in Comb inside the dashboard.
- **File links:** a new env picks the base of file links (default name `AGENT_FS_LINK_TARGET=dashboard|live`). Unset means `live` (today). Onboard and the Compose example write `dashboard` for new installs. A Settings > Configuration toggle controls it. The base prompt and attachment links read one resolved value.
- **Bundle:** every new `install.sh` / onboard install starts agent-fs on local disk (no MinIO), with Comb on.
- **Embeddings:** one Hugging Face TEI CPU container with nomic-embed-text-v1.5 serves both swarm memory (env only, 768 dims on new installs) and agent-fs (a new `openai-compat` provider). Both add nomic task prefixes.
- **Comb parity bar before the link default flips:** name, full-text and semantic search, share links, audio and rendered-HTML viewers, and uploads. No drive or org switching. Editing and file management stay in the live UI. Tonight's parity session covers this.
- **Accounts:** a new `/setup` step explains agent-fs, and creates the person's agent-fs account and drive access automatically from the step 1 email. Step 1 must collect the email on installs with a bundled agent-fs.
- **Invites:** an "Invite your team" card at the end of setup (team size not "Just me") and an Invite button on People. An invite gives each teammate personal access (their own user and token), not the operator key.
- **Existing installs:** full backward compatibility. No change at all unless the operator turns the new behavior on.
- Deferred: browser path to a bundled agent-fs, defaulting to a proxy path on the swarm API (`/agentfs/*`), with `AGENT_FS_PUBLIC_URL` derived from the public API URL. Taras was unsure. Revisit in the plan.
- Deferred: invite link shape, defaulting to a one-time code (reuse the connector-code table and exchange) that the dashboard swaps for a personal `aswt_` token.
- Deferred: the invitee's role, defaulting to a role picked in the invite form with Requester preselected. The DB default today is admin for every new user.
- Deferred: the Comb "beta" badge, defaulting to removal once the parity PR merges.
- Parked: "Connect with agent swarm" from the hosted live agent-fs.

### Open Questions
- (research) Does agent-fs `inviteToOrg` need the invitee registered first, and does the swarm seeder re-run when a new user is created?
- (research) TEI CPU image size, idle RAM and throughput for nomic v1.5 on 4 vCPU, and whether TEI's `dimensions` truncates correctly (Matryoshka).
- (research) Can the swarm API proxy agent-fs SSE streams and file bodies without buffering (Bun streaming), and what CORS or auth headers change?
- (research) Which settings pages and routes reject a non-admin `aswt_` user today, so a Requester invitee does not hit dead ends.

### Constraints Identified
- No change for existing installs. Every new behavior is opt-in or written only by new-install tooling.
- agent-fs `POST /auth/register` is public with no email check. The swarm must only register the email the person gave in step 1.
- Comb's browser talks to agent-fs directly, so a bundled agent-fs needs a browser-reachable URL behind the same tunnel.
- Memory needs a 768-dim start on new installs. A dims change on an existing install needs a manual vec-table rebuild.
- The `full` preset already runs 11 agents. TEI and agent-fs add RAM on small boxes (not measured).
- The telemetry catalog lives in the private proxy repo, and new use-case values are filtered until it is updated (from the polish PR).

### Core Requirements
- A new install reaches a working agent-fs, Comb and keyless semantic memory with no extra command and no key.
- `/setup` has a Files step that explains agent-fs and finishes with the person's account ready.
- Agents' file links open in the dashboard on new installs, and stay unchanged on old ones.
- Comb covers search, share, uploads and the missing viewers before dashboard links become the default.
- A teammate can be invited by email and gets personal, role-scoped access through a one-time link.

## Next Steps

- Tonight: the Comb parity session (prompt in `/tmp/2026-10-25-comb-parity-prompt.md`).
- Then `/desplega:research` on the Open Questions, then `/desplega:create-plan` for: bundled agent-fs plus TEI in onboard, the link-target env, the Files step, and invites.
