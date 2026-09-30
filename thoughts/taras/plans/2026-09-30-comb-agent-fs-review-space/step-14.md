---
id: step-14
name: Docs, E2E, full-loop QA
depends_on: [step-6, step-8, step-9, step-10, step-11, step-12, step-13]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-14: Docs, E2E, full-loop QA

**Repo:** agent-swarm (plus a locally built agent-fs image from `$AFS` for the full loop). Stitches steps 4-13 and proves the whole review loop with real agents.

## Overview

Comb is documented, covered by a UI E2E spec, and proven end to end: a human comments with `@swarm`, sends a batch, the lead delegates, a worker edits the file and replies, the human sees it live, reviews the diff, and resolves. This step also fixes whatever the full loop exposes across slices (for example query keys that one step invalidates and another does not use).

When done: the Global Verification in `root.md` passes locally, and the docs let an operator turn Comb on.

## Changes Required:

#### 1. Docs
**File**: `docs-site/content/docs/(documentation)/ui/comb.mdx` (new) + `docs-site/content/docs/(documentation)/ui/meta.json`
**Changes**: what Comb is; requirements (agent-fs with features `comment-path-prefix`, `drive-members`, `comment-mentions`, `change-stream`, which parts hide without each); enabling (`COMB_ENABLED`, `AGENT_FS_PUBLIC_URL`, `APP_URL` for Slack/prompt links); connecting (register vs paste key, invite); commenting, `@name`, `@swarm`, "Send N to swarm"; what the agent does; reviewing changes and revert; pins; security note (the `af_` key lives in this browser's localStorage, never reaches the swarm API, Disconnect removes it; HTML renders as source); troubleshooting (CORS on a self-hosted agent-fs, "Polling" instead of "Live", invite errors).

**File**: `docs-site/content/docs/(documentation)/ui/configuration.mdx`
**Changes**: confirm the step-4 entries link to the new page.

#### 2. UI E2E
**File**: `packages/ui-e2e/specs/comb.spec.ts` (new)
**Changes**:
- Always: `/file` with the default E2E API (no agent-fs) shows "Comb is off" and no console errors (`clean.assertClean()`), and the sidebar has no Comb item.
- When `E2E_AGENT_FS_URL` is set (local runs with an agent-fs server): enable `COMB_ENABLED` through the API fixture, connect with a registered key (paste flow), open a seeded markdown file, add a file-level comment, reply, resolve. Skip with a clear reason otherwise. Selectors follow `apps/ui/CLAUDE.md` (roles and names, no `data-testid`).
- Tag the always-on test `@smoke` only if it stays under the suite's per-test budget.

#### 3. Cross-slice fixes
**Files**: whatever the full loop touches.
**Changes**: record each fix in the step notes with its root cause. Typical candidates: invalidation keys (step-11) vs keys used by steps 6, 9, 10; the file page mount points (steps 8-11); feature-detection gaps on v0.14.0.

### Success Criteria:

#### Automated Verification:
- [ ] Unit tests: `bun run test:root -- --parallel=4`
- [ ] Typecheck: `bun run tsc:check`
- [x] Dashboard: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [x] Route checks: `bun run check:rbac-coverage && bun run check:openapi-response-coverage`
- [x] OpenAPI fresh: `bun run docs:openapi && git diff --exit-code openapi.json`
- [x] Promise checks: `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`
- [x] UI E2E typecheck + suite: `bun run e2e:ui:tsc && bun run e2e:ui -- --grep @smoke && bun run e2e:ui -- specs/comb.spec.ts`
- [x] Black-box E2E: `bun run e2e`
- [x] Docs build (if the docs site has a build check in CI, run the same command; see `runbooks/ci.md`)

#### Automated QA:
Full loop with real agents (the QA scenarios live here, no separate QA doc):
- [x] Build agent-fs from `$AFS` `main` (steps 1-3 merged): `docker build -t ghcr.io/desplega-ai/agent-fs:comb-dev "$AFS"`. Start the stack with a throwaway override file `/tmp/docker-compose.comb.yml` that sets the `agent-fs` image to `comb-dev` and `COMB_ENABLED=true`, `AGENT_FS_PUBLIC_URL=http://localhost:7433`, `APP_URL=http://localhost:5274` on the API: `docker compose -f docker-compose.local.yml -f /tmp/docker-compose.comb.yml up --build`. Start the UI (`bun run pm2-start` or `cd apps/ui && bun run dev`).
- [x] Human A connects in the dashboard. A seeds `comb-qa/spec.md` (three sections) through the CLI.
- [x] A adds three `@swarm` comments on three passages (one asks "rename section 2 to Rollout", one asks for a shorter intro, one asks a question that needs a human answer) and one `@B` mention for human B.
- [x] B's bell shows the mention. B opens it and lands on the thread.
- [x] A clicks "Send 3 to swarm". The lead receives ONE task (`source: comb`), delegates or works it. Within the agent run, the file gets new versions and each comment gets a reply. The question comment gets a reply that mentions A (if the worker CLI supports `--mention`, else a plain reply).
- [x] A's open tab updates live (header "Live"). Each thread shows "Review changes (v1 → vN)". A reviews the diffs, resolves two threads, reverts nothing. A reverts once on a copy file to prove the revert path.
- [x] A pins `comb-qa/`, clicks a task attachment link to `spec.md` from the task page, and lands in Comb.
- [x] Flag off: set `COMB_ENABLED=false`. Within 30 s the nav item hides, `/file` shows "Comb is off", `POST /api/comb/review-batches` answers 404, and attachment links point at `live/` again.
- [x] Record the whole loop at 1.5x (LOCAL_TESTING.md recipe), upload screenshots + recording to `qa/agent-swarm/<date>-comb/`, and link them in the PR body.

#### Manual Verification:
- [ ] Taras watches the recording and runs the loop once himself on local before enabling on prod.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.

## Implementation Notes

Commit `e4bdb7609` on `feat/comb-5-docs-e2e` (worktree `/Users/taras/worktrees/agent-swarm/2026-09-30-comb-s14`, base `5897266aa`). Evidence in `/tmp/comb-run/step-14/`: screenshots `01-*.png` to `30-*.png` and `full-loop-1.5x.mp4` (4 min). The upload box stays open until the orchestrator uploads the evidence.

What changed:
- Docs: new `ui/comb.mdx` (requirements with the four features and what hides without each, bucket versioning, turn on, connect, browse, comment, mentions, `@swarm`, send with the 50 cap, what the agent does, review and revert rules, live updates and the shared http stream, links and `APP_URL`, turn off and rollback, security, troubleshooting). `ui/meta.json` lists it. `ui/configuration.mdx` links to it. The co-deployment guide explains bucket versioning. Catalog: `COMB_ENABLED` links to `ui/comb`, `AGENT_FS_PUBLIC_URL` links to `ui/comb#turn-on-comb`.
- UI E2E: `packages/ui-e2e/specs/comb.spec.ts`. The `@smoke` test checks `/status` `comb.enabled=false`, a 404 from `POST /api/comb/review-batches`, "Comb is off" on `/file`, no sidebar Comb link, and a clean console. It skips in remote mode. The agent-fs test runs only with `E2E_AGENT_FS_URL`: it sets `AGENT_FS_API_URL`, a unique `AGENT_FS_REGISTER_EMAIL`, and `COMB_ENABLED` through `PUT /api/config`, reloads, invites a registered human (this provisions the swarm drive), writes a file, then pastes the key, comments on the file, replies, and resolves. Its `finally` deletes the three config rows and reloads. The `api` fixture gained `delete()`.

Cross-slice fixes, each with its root cause:
1. Compose bucket versioning (found in loop 1). `minio-init` created the bucket without versioning. agent-fs checks versioning at startup. Without it, `diff` falls back to the stored `diffSummary` of the `to` version, and `revert` throws. So "Review changes (v1 → v3)" showed only the v2→v3 edit with line 1 numbers. Fix: `mc version enable local/agentfs` in `docker-compose.local.yml`, `docker-compose.example.yml`, and `docker-compose.scripts-only.yml`. Loop 2 showed a real content diff with correct line numbers, and the revert worked.
2. Drive members cache (found in loop 1). `useDriveMembers` had `staleTime` 5 min and no poll. B's list loaded before A registered, so B's bell read "someone mentioned you". Fix: `staleTime` 30 s. The next mount or focus refetches, and loop 2 showed "ada.park@example.com mentioned you" with no reload.
3. Service account byline (orchestrator item). The `[comb:sent]` reply showed the service account email. Decision: label it "Swarm" in `useAuthorLabel` when the author equals `/status` `service_user_id`. Not a display name at provisioning: the bootstrap key can be an operator-supplied account (`API_AGENT_FS_API_KEY` / `AGENT_FS_API_KEY`), and a PATCH would overwrite that person's name. The UI label also needs no re-provisioning on existing deployments.
4. "0m ago" (orchestrator item). Comb already uses one formatter (`formatRelative`). Root cause: it said "just now" under 30 s and `${floor(min)}m ago` after, so 30 to 59 s printed "0m ago". A reopen re-renders the card after that window. Fix: "just now" for the whole first minute, with `relative-time.test.ts`.

Full loop (real Claude lead and worker in compose, agent-fs 0.15.0 image, API key 123123 in my override so no real key reached the browser):
- Loop 1 found fixes 1 and 2. Loop 2 (the retry) passed every Automated QA box and is the recording.
- One task per send: `source=comb`, `taskType=comb-review`, assigned to the lead. The lead worked it itself (no delegation), 59 s, about $0.16. It wrote v2 (intro) and v3 (rename), replied on all three comments, and resolved the rename thread (the prompt allows it for trivial changes).
- The question reply names A only as text (`@<user id>`). The worker image on this base ships agent-fs CLI 0.14, which has no `--mention`, and the agent said so. The pin bump to 0.15.0 is on `main`, so after the merge the reply can carry a real mention.
- A resolved two threads (the intro from the review panel, the question from its card after a reply). A reverted `spec-copy.md` v2 to v1 (v3 `revert`). A pinned `comb-qa/`. The task attachment `spec.md` (inserted with bun:sqlite inside the API container, as in step-13) opened in Comb in the same tab.
- Flag off: `PUT COMB_ENABLED=false` at 12:50:23, route 404 and `/status` false within 5 s, nav item gone and "Comb is off" plus "Open in agent-fs" on the open file at 12:50:34, attachment link back to `https://live.agent-fs.dev/...` with `target=_blank`.
- API logs: no errors. Browser console: no errors (one existing AG Grid deprecation warning).

Deviations:
- No `docker build` of agent-fs: the override uses the published `ghcr.io/desplega-ai/agent-fs:0.15.0` (orchestrator instruction). The override also replaces the pi worker with a Claude worker and sets `APP_URL`/`CORS_ALLOWED_ORIGINS` to the vite port 3351.
- Unit tests: I did not run the full root suite (the brief forbids it). Targeted run: 474 of 475 pass across 47 files (all Comb UI dirs, `src/tests/comb-*`, provisioning, links, favorites, catalog). The one failure is `docs-index-footprint` (expects 389 operations, the tree has 390). The base branch fixes it in its new commit, so no change here.
- agent-fs Global Verification (typecheck, test, e2e in `$AFS`) not run here: `bun run test` needs a build that writes into the read-only agent-fs worktree. Steps 1-3 and 15 ran it before the 0.15.0 release.

Observations (not fixed):
- The mention picker labels members without a display name by the email local part (`@bea.brown`). Expected step-8 behavior.
- A human who connects with "Create with my email" never sees the new key on success. It lives only in that browser. The docs say so. A "show my key" affordance could be a follow-up.
- In loop 1 (no versioning) the moved intro anchor highlighted a partial phrase ("...pilot C"). With versioning it anchors to the whole new paragraph.

Notes for the orchestrator:
- `docs-site` build: `pnpm install --frozen-lockfile && pnpm build` passed. I deleted `docs-site/node_modules`, `.next`, and `.source` after.
- Compose stack is down with volumes. Removed images: `swarm-worker:local`, `2026-09-30-comb-s14-api`, `agent-fs:0.15.0`, `pgsty/minio`. Build cache pruned.

### Review fixes

- `specs/comb.spec.ts`: both tests are tagged `@local` (config `grepInvert` drops them in remote mode), so the hand-rolled `readTarget` skip is gone. The knob is now `E2E_COMB_AGENT_FS_URL` (the `E2E_AGENT_FS_*` family is the CI artifact store's secrets).
- The `finally` cleanup also deletes the provisioning rows (`API_AGENT_FS_API_KEY`, `AGENT_FS_DEFAULT_ORG_ID`, `AGENT_FS_SHARED_ORG_ID`, `AGENT_FS_DEFAULT_DRIVE_ID`, `AGENT_FS_PROVISION_HASH`). Provisioning also writes `process.env`, so the worker API keeps those values until restart. Comb stays off because `COMB_ENABLED` and `AGENT_FS_API_URL` are removed.
- Docs: README `api` fixture row lists `delete`; LOCAL_TESTING.md env table has the knob; versioning steps in the co-deployment guide and both compose files are runnable commands.
- Mentions bell uses `useAuthorLabel(drive)` ("Swarm" for the service account). comb.mdx: resolve rule and `AGENT_FS_LIVE_URL` note.
