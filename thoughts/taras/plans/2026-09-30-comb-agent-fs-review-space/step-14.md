---
id: step-14
name: Docs, E2E, full-loop QA
depends_on: [step-6, step-8, step-9, step-10, step-11, step-12, step-13]
status: ready
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
- [ ] Dashboard: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [ ] Route checks: `bun run check:rbac-coverage && bun run check:openapi-response-coverage`
- [ ] OpenAPI fresh: `bun run docs:openapi && git diff --exit-code openapi.json`
- [ ] Promise checks: `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`
- [ ] UI E2E typecheck + suite: `bun run e2e:ui:tsc && bun run e2e:ui -- --grep @smoke && bun run e2e:ui -- specs/comb.spec.ts`
- [ ] Black-box E2E: `bun run e2e`
- [ ] Docs build (if the docs site has a build check in CI, run the same command; see `runbooks/ci.md`)

#### Automated QA:
Full loop with real agents (the QA scenarios live here, no separate QA doc):
- [ ] Build agent-fs from `$AFS` `main` (steps 1-3 merged): `docker build -t ghcr.io/desplega-ai/agent-fs:comb-dev "$AFS"`. Start the stack with a throwaway override file `/tmp/docker-compose.comb.yml` that sets the `agent-fs` image to `comb-dev` and `COMB_ENABLED=true`, `AGENT_FS_PUBLIC_URL=http://localhost:7433`, `APP_URL=http://localhost:5274` on the API: `docker compose -f docker-compose.local.yml -f /tmp/docker-compose.comb.yml up --build`. Start the UI (`bun run pm2-start` or `cd apps/ui && bun run dev`).
- [ ] Human A connects in the dashboard. A seeds `comb-qa/spec.md` (three sections) through the CLI.
- [ ] A adds three `@swarm` comments on three passages (one asks "rename section 2 to Rollout", one asks for a shorter intro, one asks a question that needs a human answer) and one `@B` mention for human B.
- [ ] B's bell shows the mention. B opens it and lands on the thread.
- [ ] A clicks "Send 3 to swarm". The lead receives ONE task (`source: comb`), delegates or works it. Within the agent run, the file gets new versions and each comment gets a reply. The question comment gets a reply that mentions A (if the worker CLI supports `--mention`, else a plain reply).
- [ ] A's open tab updates live (header "Live"). Each thread shows "Review changes (v1 → vN)". A reviews the diffs, resolves two threads, reverts nothing. A reverts once on a copy file to prove the revert path.
- [ ] A pins `comb-qa/`, clicks a task attachment link to `spec.md` from the task page, and lands in Comb.
- [ ] Flag off: set `COMB_ENABLED=false`. Within 30 s the nav item hides, `/file` shows "Comb is off", `POST /api/comb/review-batches` answers 404, and attachment links point at `live/` again.
- [ ] Record the whole loop at 1.5x (LOCAL_TESTING.md recipe), upload screenshots + recording to `qa/agent-swarm/<date>-comb/`, and link them in the PR body.

#### Manual Verification:
- [ ] Taras watches the recording and runs the loop once himself on local before enabling on prod.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.
