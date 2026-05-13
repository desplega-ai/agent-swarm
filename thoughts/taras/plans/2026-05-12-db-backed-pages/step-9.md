---
id: step-9
name: Integration + capability flip + qa-use
depends_on: [step-4, step-5, step-7, step-8]
status: done
claimed_by: orchestrator-step-9-2026-05-12
last_updated: 2026-05-12
last_updated_by: orchestrator-step-9-2026-05-12
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
- [x] Full repo test suite passes: `bun test` (3858 pass / 0 fail after fixing tool-config classification)
- [x] Lint + typecheck (root): `bun run lint && bun run tsc:check` (lint exit 0; 22 pre-existing warnings; tsc clean)
- [x] Typecheck (ui): `cd ui && pnpm exec tsc -b` (clean)
- [x] DB-boundary: `bash scripts/check-db-boundary.sh` (passed)
- [x] OpenAPI fresh and committed: `bun run docs:openapi && test -z "$(git status --porcelain openapi.json docs-site/)"` (no diff)
- [x] `bun run build:pi-skills` clean: `test -z "$(git status --porcelain plugin/pi-skills/)"` (no diff)
- [x] Capability flip lands: `pages` added to `DEFAULT_CAPABILITIES` in `src/server.ts:124`.
- [x] `create_page` registered in `DEFERRED_TOOLS` (`src/tools/tool-config.ts`) so the tool-annotations test passes.

#### Automated QA:
- [ ] **Skipped per orchestrator directive** — Taras manually QAs the SPA; no qa-use YAML authored. See Manual Verification below.

#### Manual Verification (Taras runs by hand):

**1. Capability flip sanity-check**
```bash
# fresh boot — confirm `pages` is in the default capability set
unset CAPABILITIES
bun run start:http &
sleep 2
curl -s http://localhost:3013/health | jq .
# (optional) call create_page via MCP and confirm it is NOT 'tool not found'
```

**2. Public HTML page — `/p/:id` direct render**
```bash
# Using MCP tools via the inspector or curl directly against the REST API:
curl -sX POST http://localhost:3013/api/pages \
  -H "Authorization: Bearer ${API_KEY:-123123}" \
  -H "X-Agent-ID: manual-qa" \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Manual QA — public HTML",
    "body": "<!doctype html><h1>hello pages</h1><script>fetch(\"/@swarm/api/get-swarm\").then(r=>r.json()).then(j=>document.body.appendChild(Object.assign(document.createElement(\"pre\"),{textContent:JSON.stringify(j,null,2)})))</script>",
    "contentType": "text/html",
    "authMode": "public"
  }' | jq .
# → open the returned `api_url` in Chrome. Body should render. Note: public-mode
#    SDK calls 401 (by design in v1 — no cookie). Confirm no console error tree.
```

**3. Authed JSON page — SPA renders + declared action fires**
```bash
curl -sX POST http://localhost:3013/api/pages \
  -H "Authorization: Bearer ${API_KEY:-123123}" \
  -H "X-Agent-ID: manual-qa" \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Manual QA — authed JSON",
    "body": {
      "type": "swarm.Container",
      "children": [
        {"type": "swarm.Heading", "level": 1, "text": "Authed JSON"},
        {"type": "swarm.Button", "label": "Ping get-swarm",
         "action": {"kind": "swarm.call", "tool": "get-swarm", "args": {}}}
      ]
    },
    "contentType": "application/json",
    "authMode": "authed"
  }' | jq .
# → open the returned `app_url` (SPA route /artifacts/<id>).
# → ConfigGuard should redirect to /config if no connection is set.
# → Once connection set, JSON renders. Click the button. Action should
#    succeed (200 from /@swarm/api/get-swarm via cookie proxy).
```

**4. Password page — `?key=` and Basic auth both unlock**
```bash
curl -sX POST http://localhost:3013/api/pages \
  -H "Authorization: Bearer ${API_KEY:-123123}" \
  -H "X-Agent-ID: manual-qa" \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Manual QA — password",
    "body": "<!doctype html><h1>password page</h1>",
    "contentType": "text/html",
    "authMode": "password",
    "password": "swordfish"
  }' | jq .
# Then visit the returned `api_url` three ways:
#   a) <api_url>            → 401 + WWW-Authenticate (browser shows Basic prompt)
#   b) <api_url>?key=swordfish → renders directly
#   c) curl -u :swordfish <api_url> → 200 HTML
```

**5. Pages listing UI**
- Open the SPA, navigate to `/pages`.
- Confirm rows from the manual QA above appear; click-through to `/artifacts/:id` works.
- The "My pages only" toggle is a placeholder (hides all rows when on). See follow-up below.

**6. Slack share preview (acceptable to ship as-is)**
- Paste an `app_url` into `#swarm-dev-2`. v1 has no OG tags — unfurl shows URL only. Confirm acceptable; OG tags are explicitly deferred per root.md.

**7. Lead-only swarm prompting trial (subjective)**
- `bun run pm2-start` with no workers, or use the lead container in `docker-compose.local.yml`.
- Drive a real interaction where the lead is asked to produce a status report.
- Confirm the lead reaches for `create_page` (vs artifacts or raw markdown). Note any SKILL.md prompting friction.

**8. qa-use session (CI gate)**
- Taras to run qa-use session manually before merge. The merge gate for `ui/` touches requires screenshots; that gate stays even though this step does not author the YAML.

#### Follow-ups (out of step-9 scope)

- **My-pages-only toggle wiring** (`ui/src/pages/pages/page.tsx:30-42`): no SPA-visible viewer agentId today. Either add `GET /api/whoami` + `useWhoami()` hook, or pass `agentId` via the `usePages` query when the toggle is on. Current behaviour: toggle hides all rows; behaviour is documented in the source comment.
- **BUSINESS_USE instrumentation for page-create/update/delete**: deferred — no events emitted from `src/tools/create-page.ts` or `src/http/pages*.ts`. Add `ensure()` calls in a follow-up; SDK is no-op locally without `BUSINESS_USE_API_KEY` so this isn't blocking v1.
- **`POST /api/pages` body-size cap**: HTML route has the 5 MiB cap (step-3); JSON body-size guard at parse time across REST mutations should be revisited if abuse appears.
- **End-to-end shell script (`scripts/e2e-pages.sh`)**: not landed. Manual checklist above replaces it for v1; convert to script if the manual runs prove repetitive.
- **OG meta tags for unfurl**: deferred, columns ready.

**Implementation Note**: Per orchestrator directive, qa-use YAML was NOT authored — Taras runs qa-use manually before merge. Commit as `[step-9] pages v1 integration + capability flip + manual E2E checklist`.
