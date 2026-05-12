---
id: step-9
name: Integration + capability flip + qa-use
depends_on: [step-4, step-5, step-7, step-8]
status: ready
---

# step-9: Integration + capability flip + qa-use

## Overview

The DAG's drain step. All vertical slices have landed; now (a) flip `pages` into `DEFAULT_CAPABILITIES` so the MCP tool ships on by default, (b) run the full qa-use session across the auth-mode × content-type matrix with screenshots, (c) confirm the OpenAPI spec is fresh and committed, (d) verify the BUSINESS_USE.md instrumentation budget hasn't been silently violated, (e) tighten any remaining loose ends surfaced during integration.

## Changes Required:

#### 1. Flip the capability default
**File**: `src/server.ts`
**Changes**: Update `DEFAULT_CAPABILITIES` (`src/server.ts:123`):
```ts
const DEFAULT_CAPABILITIES = "core,task-pool,profiles,services,scheduling,memory,workflows,pages";
```

#### 2. Body-size cap (if not landed earlier)
**File**: `src/http/pages.ts` (extend)
**Changes**: Reject `POST` / `PUT` bodies larger than 1 MB at parse time (Content-Length header check before `parseBody`). Return `413 Payload Too Large`. Add an env override `PAGES_MAX_BODY_BYTES` (default `1048576`).

#### 3. Secret-scrubbing audit at egress
**File**: search across `src/http/pages*.ts`, `src/tools/create-page.ts`
**Changes**: Confirm any log call (`console.log`, BU events that include page body in payload, session_logs writes) routes its serialized payload through `scrubSecrets()` (`src/utils/secret-scrubber.ts:197`). Add scrubs where missing. Body itself when served to the user MUST NOT be scrubbed (it's intentional agent content); scrubbing applies only to log/telemetry egress.

#### 4. BUSINESS_USE instrumentation
**File**: `src/tools/create-page.ts`, `src/http/pages.ts`
**Changes**: Add `ensure()` events for page-create, page-update, page-delete using the `api` flow (per `BUSINESS_USE.md`). Place AFTER successful state mutation, OUTSIDE any transaction. No closure-captured variables inside validators. SDK is no-op if `BUSINESS_USE_API_KEY` is missing, so this is safe locally.

#### 5. Full OpenAPI regen + spec freshness
**Files**: `openapi.json`, `docs-site/content/docs/api-reference/**`
**Changes**: `bun run docs:openapi` and commit any final diffs. CI gates on this being clean.

#### 6. qa-use full session
**Files**: `qa-use/tests/pages-full-matrix.yaml` (new)
**Changes**: Single YAML covering the 6-cell matrix (3 auth modes × 2 content types):
1. Public HTML — open `${apiUrl}/p/<id>` directly in Chrome; screenshot.
2. Public JSON — open `${apiUrl}/p/<id>`; assert 302; follow → SPA renders JSON; click an action button; assert success.
3. Authed HTML — navigate to `/artifacts/<id>` in SPA; iframe loads; screenshot.
4. Authed JSON — navigate to `/artifacts/<id>`; JSON renders; click action button; assert success.
5. Password HTML — navigate to `/artifacts/<id>`; password modal; submit; iframe loads.
6. Password JSON — navigate to `/artifacts/<id>`; password modal; submit; JSON renders.

Commit screenshots to `qa-use/sessions/2026-XX-XX-pages-v1/` (date the day of the qa-use run).

#### 7. End-to-end script
**File**: `scripts/e2e-pages.sh` (new — optional but high value)
**Changes**: Shell script that:
1. Boots a fresh DB and `bun run start:http` in the background.
2. Calls `create_page` six times (matrix above) via curl using bearer.
3. Verifies each `api_url` returns the expected shape (curl + assertion).
4. Tears down.

Output is `PASS` or `FAIL`. Documents the manual reproduction in one place. Reference from `plugin/skills/pages/skill.md` § "How to verify your page".

#### 8. Tests
**Files**: re-run the entire suite + the new qa-use session.
**Changes**: No new test files; this step's job is to drain.

### Success Criteria:

#### Automated Verification:
- [ ] Full repo test suite passes: `bun test`
- [ ] Lint + typecheck (root): `bun run lint && bun run tsc:check`
- [ ] Lint + typecheck (ui): `cd ui && pnpm lint && pnpm exec tsc -b`
- [ ] DB-boundary: `bash scripts/check-db-boundary.sh`
- [ ] OpenAPI fresh and committed: `bun run docs:openapi && test -z "$(git status --porcelain openapi.json docs-site/)"`
- [ ] `bun run build:pi-skills` clean: `test -z "$(git status --porcelain plugin/pi-skills/)"`
- [ ] Capability flip lands: `grep -q '"pages"' <(bun -e 'import("./src/server.ts").then(m => console.log(m.getEnabledCapabilities()))')` returns 0.
- [ ] (If e2e script written) `bash scripts/e2e-pages.sh` exits 0.

#### Automated QA:
- [ ] `qa-use/tests/pages-full-matrix.yaml` passes for all 6 cells.
- [ ] Screenshots committed under `qa-use/sessions/2026-XX-XX-pages-v1/` (6 cells × at least 1 screenshot each).
- [ ] Independent agent (e.g. spawn a sub-agent with the swarm running and `CAPABILITIES=pages,...`) calls `create_page` via MCP and confirms the returned `app_url` opens correctly.

#### Manual Verification:
- [ ] Open the SPA, navigate to `/pages`, confirm all 6 created pages are listed and click-throughable.
- [ ] Confirm Slack-share preview is acceptable (or note as follow-up): paste `app_url` into `#swarm-dev-2` Slack channel; unfurl will show the URL but no OG tags in v1 (deferred). Confirm this is acceptable to Taras before merging.
- [ ] Skim the diff of `openapi.json` one final time — sanity-check that no unintended route or schema change snuck in.
- [ ] **Lead-only swarm prompting trial**: spin up a lead-only swarm locally (`bun run pm2-start` with no workers, or use the lead container in `docker-compose.local.yml`) and drive a real interaction where the lead is asked to produce a status report. Confirm the lead actually reaches for `create_page` (instead of artifacts or raw markdown) — i.e. that the SKILL.md prompting is discoverable and ergonomic. Note any prompt-design friction as follow-up. Manual; subjective.
- [ ] **Manual end-to-end browser run**: Taras opens each of the 6 matrix cells in a real Chrome window (not just qa-use headless) and clicks through. Confirm visual fidelity and that nothing was masked by the headless rendering.

**Implementation Note**: Final step. Do NOT merge until all six qa-use cells pass and screenshots are committed (merge gate for `ui/` PRs is strict). Commit as `[step-9] pages v1 integration + capability flip + qa-use full matrix`.
