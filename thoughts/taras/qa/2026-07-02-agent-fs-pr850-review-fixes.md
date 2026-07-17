---
date: 2026-07-02T00:00:00Z
topic: "PR #850 agent-fs first-class — review, E2E, and blocker fixes"
status: "PR CLEAN/MERGEABLE, all CI green; item 5 fixed + verified live"
branch: feat/agent-fs-first-class-813
pr: 850
---

# PR #850 agent-fs first-class — review, E2E, and blocker fixes (handoff/QA)

**Branch:** `feat/agent-fs-first-class-813` (PR #850). Rebased onto latest main (past the ui/→apps/ui/ monorepo move #892). CLEAN / MERGEABLE, all CI green.

## What was done this session

1. **Reviewed PR #850** (8-angle finder + 10 verifier passes) and ran local E2E against real agent-fs 0.9.0.
2. **Fixed 4 merge blockers** (commit "resolve merge blockers from PR review + E2E"):
   - Migration `104`→`106` (main took 104 reasoning-effort, 105 user-favorites).
   - Compose healthcheck curl→`node -e fetch` (agent-fs:0.9.0 image has no curl → deadlocked `docker compose up`). Verified live: container healthy.
   - Bootstrap `API_AGENT_FS_API_KEY` now stripped **unconditionally** from `/api/config/resolved` + `/api/config` (was only stripped when `agentId` present; entrypoint/runner fetch without it). Regression test `src/tests/config-api-only-keys.test.ts`.
   - 10s `AbortSignal.timeout` on seeder `agentFsRequest` (ran pre-listen → blackholed URL hung boot). + scrubSecrets at 3 log egresses.
3. **Fixed item 5 — scope resolution** (commit `37195135`, the real blocker given prod has agent-fs ENABLED):
   - `FileScope` gains `key`/`orgId`/`driveId`; `providerPath` honors stored key (strips leading slash, rejects `..`).
   - `AgentFsProvider` resolves per-request org/drive (row's, falling back to configured).
   - `scopeFromAttachment` passes row `provider_key`/`path` + org/drive.
   - download/signed-url/delete gate on `backingProviderId` (agent-fs kind or local-fs providerId = provider-backed; shared-fs volume/url/page → 404 download, pointer-only delete = no orphan).
   - Verified LIVE vs real agent-fs 0.9.0: arbitrary-path/leading-slash/org-drive-override resolve+delete OK; old reconstruct 404s.

## Prod reality (checked read-only via `ssh swarm` = 116.202.39.248)

- agent-fs IS enabled: `AGENT_FS_API_URL=https://agent-fs-taras.fly.dev`. No co-deployed agent-fs container.
- Migration head = 105 → 106 applies clean on deploy. Merging main auto-deploys.
- **712 attachments**: agent-fs 236 (232 arbitrary paths), shared-fs 195 (all arbitrary), url 181, page 100. This is why item 5 was a blocker not a fast-follow.
- DB: `/var/lib/docker/volumes/swarm-new-22yjmi_swarm_db/_data/agent-swarm-db.sqlite` (host sqlite3; `docker exec` blocked, host reads OK).

## Remaining (fast-follow, NOT blockers) — not yet greenlit

- **Item 8 — dead human links**: `taskAttachmentDisplayUrl` (`src/utils/task-attachment-links.ts`) renders shared-fs/agent-fs rows as bearer-only `/api/fs/.../raw` on the SPA/dashboard origin (no `/api` proxy in prod) or a wrong live host. Runs regardless of agent-fs. Cosmetic, same 427 rows. Offered to bundle; awaiting go.
- **Item 6 — unrecoverable lost agent key**: `ensureAgentFsCredentialsForAgent` registers `allowConflict:false`; agent-fs 0.9.0 has no login/rotate → lost key = permanent 409/500. Needs upstream change or re-key workaround.
- **mimeType bug**: agent-fs upload records `mimeType` from the ops JSON response (`application/json`) instead of the uploaded content-type (`src/http/fs.ts` sendUpload). Breaks dashboard mime-keyed previews.
- Provider-registry memo split-brain (`src/fs/registry.ts`) — only bites on transient boot failure.

## Machine gotcha

Worker-image builds fill disk; OrbStack VM crashed once mid-session. `df` was ~99% full repeatedly. `docker builder prune -af` + OrbStack restart reclaims space. Check `df` before `docker:build:worker`.

## Env note

`.env.docker` / `.env.docker-lead` were created + deleted during E2E (token-bearing; gitignored). To re-run the full worker E2E, recreate them pointing `MCP_BASE_URL`/`AGENT_FS_API_URL` at the local API/agent-fs.
