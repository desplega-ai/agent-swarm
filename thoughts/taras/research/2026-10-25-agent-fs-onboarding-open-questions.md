---
date: 2026-10-25T02:15:00+02:00
researcher: Claude
git_commit: 7feb68fd6
branch: main
repository: agent-swarm (plus ~/Documents/code/agent-fs)
topic: "agent-fs in onboarding: the 4 open questions from the brainstorm"
tags: [research, agent-fs, comb, onboarding, embeddings, rbac, invites]
status: complete
autonomy: autopilot
last_updated: 2026-10-25
last_updated_by: Claude
---

# Research: agent-fs in onboarding, open questions

**Date**: 2026-10-25, 02:15 BCN
**Researcher**: Claude
**Git Commit**: agent-swarm `origin/main` 7feb68fd6; agent-fs working tree (v0.18.x)
**Input**: `thoughts/taras/brainstorms/2026-10-25-agent-fs-onboarding.md`, Synthesis > Open Questions

## Research Question

1. Does agent-fs `inviteToOrg` need the invitee registered first, and does the swarm agent-fs seeder re-run when a new swarm user is created?
2. TEI CPU image size, idle RAM and throughput for nomic-embed-text-v1.5, and whether TEI's `dimensions` parameter truncates correctly (Matryoshka).
3. Can the swarm API proxy agent-fs under a path such as `/agentfs/*`, including SSE and file bodies, without buffering? What changes for Comb's CORS and auth?
4. Which pages and routes reject a non-admin `aswt_` user (Requester, Viewer) today?

## Summary

**Invites need an account first, and nothing retries.** `inviteToOrg` fails with a plain `Error` (HTTP 500) when the email has no agent-fs account. There is no pending-invite record, and a later registration does not join the org. The swarm seeder runs only at API boot. Its hash includes every user email, so a new swarm user triggers an invite on the next restart. That invite fails if the person has no agent-fs account, the failure is only logged, and the new hash is stored, so the swarm does not retry it. Comb's "Create with my email" path works because it registers first (browser to agent-fs), then asks the swarm to invite.

**TEI fits, with two caveats.** Image `cpu-1.9.4` is about 239 MB compressed (x86_64) and `cpu-arm64-1.9.4` about 117 MB. The nomic weights are 547 MB. Versions before 1.9.4 crash at startup on this model (issue #927). No published CPU RAM or throughput numbers exist for this model: those need a measurement. TEI's `dimensions` truncates and then L2-normalizes, but nomic's card applies a layer norm before truncation, so 512-dim vectors from TEI do not follow the card's recipe (the quality effect is not measured). Nomic task prefixes must be added by the client: `/v1/embeddings` has no prompt name, and nomic's repo defines no `prompts`.

**A proxy is possible, but nothing like it exists yet.** The swarm API runs on `node:http`, not `Bun.serve`. A throwaway experiment showed that `node:http` with `Readable.fromWeb(r.body).pipe(res)` streams a 200 MB body (first chunk after 1 ms, about 15 MB RSS growth), streams a 50 MB upload, and keeps an SSE stream alive through 15 s of silence. Today's swarm `/api/fs/*` routes buffer bodies, and agent-fs itself buffers raw file reads. A `/agentfs/*` route needs its own auth posture, because the swarm's core auth returns 401 for any request without a swarm credential, and Comb sends an `af_` bearer.

**Non-admin users hit 403s almost everywhere.** Requester and Viewer get GETs on most routes. Writes are denied on every route with no RBAC verb, including `POST /api/tasks`, task cancel, steer, workflows, schedules, memory search (POST), config, integrations and approvals. The UI has no permission-aware helper and no global 403 handler. `/setup` redirects every user when onboarding is open, so a non-admin teammate lands in steps whose writes return 403.

## Detailed Findings

### 1. agent-fs invites and the swarm seeder

- `inviteToOrg` looks up the user by exact email and throws `new Error("User with email ... not found")` (agent-fs `packages/core/src/identity/orgs.ts:217-230`). The route `POST /orgs/:orgId/members/invite` (`packages/server/src/routes/orgs.ts:104-110`) has no try/catch. The error middleware maps an Error with no `code` to 500 `INTERNAL_ERROR` (`packages/server/src/middleware/error.ts:13-28`).
- No pending-invite store exists (no `pending_invite` anywhere in `packages/*/src`). `createUser` (`packages/core/src/identity/users.ts:30-51`) creates the user and a personal org only. Email matching has no case folding.
- `POST /auth/register` for an existing email returns 409 `CONFLICT` and no key (`packages/server/src/routes/auth.ts:17-45`; email unique at `schema.ts:13`). An org admin can reset the key of an org member (`POST /orgs/:orgId/members/:userId/reset-key`, `routes/orgs.ts:137`), not of a non-member.
- Swarm seeder: the only caller is `runAllSeeders` at API boot (`src/http/index.ts:698-700`, registry `src/be/seed/registry.ts:17-18`). No config-reload, schedule or user-create trigger was found.
- `provisionHash` (`src/be/seed/agent-fs-provision.ts:522-537`) hashes `{version, apiUrl, registerEmail, invites}`, and `resolveInviteTargets` (`:498-508`) lists every user email with a role (`viewer` for viewer, read-only or guest; else `editor`).
- `inviteToSharedOrg` (`:394-416`) catches every error with a `console.warn`, and the hash is stored afterwards (`:122-128`). So a failed invite is not retried until the user list changes again.
- User creation (`findOrCreateUserByEmail`, `src/be/users.ts:340-380`) calls no agent-fs code.
- Comb "Create with my email" (`apps/ui/src/components/comb/connect-card.tsx:53-95`, `connect-flow.ts:95-112`): the browser calls agent-fs `POST /auth/register` (409 means "email taken, paste your key"), then `GET /auth/me`, then lists the swarm drive. On 403 or 404 it calls swarm `POST /api/fs/members/invite` (`src/http/fs.ts:109-131`, `inviteEmailToSharedOrg` at `agent-fs-provision.ts:213-234`), then lists again. The key lives only in browser `localStorage` (`lib/agent-fs/credential-store.ts:1-4`).

### 2. TEI on CPU with nomic-embed-text-v1.5

| Item | Value | Source |
|---|---|---|
| Latest release | v1.9.4 (15 Sep 2026) | GitHub releases API |
| x86_64 image | `ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.4`, about 239 MB compressed | GHCR manifest |
| arm64 image | `...:cpu-arm64-1.9.4`, about 117 MB compressed (separate tag) | GHCR manifest |
| Model weights | `model.safetensors` 547 MB (quantized ONNX variants 111 to 274 MB) | Hugging Face API |
| Support | NomicBERT 137M is in the supported list. Images up to 1.9.3 crash with `duplicate field max_position_embeddings` (issue #927). The fix (PR #876) is in the 1.9.4 notes. Not run | TEI docs, issue #927 |
| Idle RAM, throughput on 4 vCPU | No published numbers. The weights alone set a floor of about 0.55 GB (inference, not measured) | none |
| `dimensions` | Accepted on `/v1/embeddings`. Rejects 0 or above the model size. Otherwise truncates, then L2-normalizes (`core/src/infer.rs`, `embed_pooled`) | TEI source |
| Matryoshka | The nomic card applies `layer_norm`, then truncates, then normalizes. TEI applies no layer norm in `modules.json` order (not confirmed in backend code) | model card |
| Prefixes | `--default-prompt` is one static string for the whole server. `--default-prompt-name` and `prompt_name` need `prompts` in the model config, and nomic has none. `/v1/embeddings` passes no prompt name. So the client adds `search_query:` / `search_document:` | TEI CLI docs, `router/src/lib.rs`, `server.rs` |

Measurement not done: the local Docker run was skipped to save disk.

### 3. Proxying agent-fs through the swarm API

- No generic proxy or streaming pass-through exists. The server is `node:http` `createServer` (`src/http/index.ts:263`, listen at `:730`), with no `idleTimeout`, `keepAliveTimeout` or `requestTimeout` set.
- `/api/fs/*` buffers: `sendDownload` uses `res.end(Buffer.from(await response.arrayBuffer()))` (`src/http/fs.ts:491-492`), and uploads collect chunks into `Buffer.concat` (`fs.ts:592-601`). Body caps come from `maxBodyBytes` (`src/http/route-def.ts:74`) or `enforceContentLengthCap` (`src/http/utils.ts:425`).
- Experiment (Bun 1.4.3):

| Proxy | 200 MB download | 50 MB upload | SSE with 15 s silence |
|---|---|---|---|
| `Bun.serve` + `new Response(r.body)` | streamed, first chunk 1 ms, about 11 MB RSS | intact (`duplex: "half"`) | reset at about 10 s (default `idleTimeout`) |
| `node:http` + `Readable.fromWeb(...).pipe(res)` | streamed, first chunk 1 ms, about 15 MB RSS | intact (`Readable.toWeb(req)`) | survived |

- agent-fs sends `: ping` every 5 s on its event stream (agent-fs `events.ts:8, 96`), and allows 8 streams per user (`events.ts:7`).
- Comb's calls (`apps/ui/src/lib/agent-fs/client.ts`): ops `POST /orgs/{org}/ops` (`:133`), raw file `GET /orgs/{org}/drives/{drive}/files/{path}/raw` (`:152`), the `signed-url` op (`:181`), events `GET /orgs/{org}/drives/{drive}/events` (`:196`). All send `Authorization: Bearer af_...` (`:65`).
- Swarm auth: `handleCore` returns 401 for a non-public path without a swarm credential (`src/http/core.ts:458-524`). Unknown paths are fail-closed (`route-def.ts:197-214`). A `/agentfs/*` route needs `auth: {apiKey: false}` or a core bypass like `/mcp-user` (`core.ts:510-513`).
- CORS: preflight returns 204 before auth (`core.ts:466-469`). CORS headers are set early (`index.ts:340`). The allowlist (`utils.ts:14-21`) covers `*.agent-swarm.dev`, `*.agent-swarm.cloud`, local 5274 and `ui.swarm.localhost:1355`. `Expose-Headers` lists only Content-Type, Content-Length, ETag and Location (`:142`), so agent-fs `X-Agent-FS-*` headers (`files.ts:68-72`) would not reach the browser through the swarm.
- agent-fs CORS defaults to `["*"]` (`app.ts:34-36`).
- Local storage: the adapter reports `presignedUrls: false` (`core/src/storage/local-adapter.ts:116-118`). The `signed-url` op then returns an authenticated app link (`kind: "app"`, no expiry), and throws `UnsupportedOperation` with no `appUrl` (`core/src/ops/signed-url.ts:61-75`). Raw GETs are served by agent-fs and buffered in memory (`server/src/routes/files.ts:25-81`).

### 4. Non-admin `aswt_` users

- Admission checks only the verbs in the user's role grant (`src/rbac/admission.ts:34-59`, from `src/http/core.ts:596-617`). A verb-less route passes for GET and HEAD and returns 403 `admission: route has no permission verb (operator-only)` otherwise (`admission.ts:58`).
- Requester verbs: `task.create.own`, `task.read.own`, `task.cancel.own`, `task.action.own`, `task.fs.mutate`, `favorite.write.own`, `session.share`, `session.presence`. Viewer: `favorite.write.own`, `session.presence` (`src/be/rbac-roles.ts:19-52`).

| Area | Requester | Viewer |
|---|---|---|
| `POST /api/tasks`, task cancel, pause, resume (no verb on the route) | denied | denied |
| Task steer (`task.steer.own`, not in the role) | denied | denied |
| Task promote-draft (`task.action.own`) | allowed | denied |
| Task and session GETs (owned or shared only) | allowed | allowed |
| Session share | allowed | denied |
| Comb "Send to swarm" (`task.create.own`) | allowed | denied |
| `/api/fs/tasks/*` upload and delete | allowed | denied |
| `/api/fs` invite and agent credentials | denied | denied |
| Agents, workflows, schedules: writes | denied | denied |
| Memory: `POST /search`, `/list`, `/rate` | denied | denied |
| `PUT /api/onboarding`, `POST /api/onboarding/memory`, `PUT /api/config` | denied | denied |
| Integrations, Provider keys, People, budgets: writes | denied | denied |
| Approvals respond (`approval.respond`) | denied | denied |
| Apps and script-connection invoke | denied | denied |
| Most GETs (status, onboarding, config with masked secrets, agents, workflows, usage) | allowed | allowed |

- Rules that reject any user, admin included: `operatorOnly` on `POST`, `PATCH`, `DELETE /api/model-profiles` (`model-profiles.ts:160-173`); `leadOrOperator` on models-catalog refresh and overlay (`models-catalog.ts:268-300`); `agentOrOperator` on harness-support; operator-only Slack inbound diagnostics (`slack-inbound.ts:99`); operator or agent token for session tokens (`sessions.ts:858, 911`).
- UI: no permission-aware helper. The only gate is `isAdminLike(user)` (`apps/ui/src/lib/user-role.ts`), which reads the free-text profile role, not RBAC. No global 403 handler; hooks toast `err.message`. `GET /api/whoami` returns the user row with no role grant (`users.ts:159-165, 693-701`). `GET /api/users/{id}/roles` and `GET /api/rbac/roles` exist and pass admission, but the UI calls neither.
- `/setup`: `OnboardingRedirect` (`components/onboarding/onboarding-redirect.tsx:32-53`, mounted at `root-layout.tsx:143`) sends every user to `/setup` while onboarding is open. The step writes then return 403 for a non-admin.
- Note: every new user gets the `admin` role by default through a DB trigger (`rbac-roles.ts:71-78`).

## Code References

- agent-fs: `packages/core/src/identity/orgs.ts:217-230`, `packages/server/src/routes/orgs.ts:104-110,137`, `packages/server/src/routes/auth.ts:17-45`, `packages/core/src/ops/signed-url.ts:61-75`, `packages/server/src/routes/files.ts:25-81`
- agent-swarm: `src/be/seed/agent-fs-provision.ts:122-128,213-234,394-416,498-537`, `src/http/index.ts:263,340,698-700`, `src/http/core.ts:458-524,596-617`, `src/http/fs.ts:109-131,491-492,592-601`, `src/http/utils.ts:14-21,142`, `src/rbac/admission.ts:34-59`, `src/be/rbac-roles.ts:19-78`, `apps/ui/src/lib/agent-fs/client.ts:65-196`, `apps/ui/src/components/onboarding/onboarding-redirect.tsx:32-53`

## Open Questions

- Real RAM and throughput of TEI `cpu-1.9.4` with nomic v1.5 on 4 vCPU, and whether it starts (needs a run on a box).
- Whether TEI applies a layer norm after pooling for NomicBERT (backend code not searched).
- Proxy behavior behind Dokploy, Traefik or Cloudflare, and over HTTP/2.
