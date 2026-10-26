---
id: step-2
name: agent-fs through the swarm API
depends_on: []
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-2: agent-fs through the swarm API

## Overview

When `AGENT_FS_PROXY=true`, the swarm API streams `/agentfs/*` to the agent-fs at `AGENT_FS_API_URL`, and serves agent-fs public share pages at `/share/*` and `/site/*`. Comb then gets `api_url = <public API URL>/agentfs` from `/status`, so a bundled agent-fs needs no public port and no second tunnel. Unset flag: every one of these paths behaves as today.

Start from the spike, from the repo root: `PLAN=thoughts/taras/plans/2026-10-26-agent-fs-onboarding` and `git apply $PLAN/spikes/proxy/proxy.patch` (applies on main `4b88368b5`). It adds `src/http/agentfs-proxy.ts` (144 lines: 5 `route()` defs, streaming both ways, header allowlist, upstream CORS stripped, traversal 400, upstream-down 502), wires it in `src/http/all-routes.ts` and `src/http/index.ts`, adds `src/tests/agentfs-proxy.test.ts`, and adds the env to `src/tests/preload.ts`. Read `$PLAN/spikes/proxy/README.md` for the measured numbers and the open items below.

## Changes Required:

#### 1. Proxy (from the patch)
**File**: `src/http/agentfs-proxy.ts` (new, from the patch), `src/http/all-routes.ts`, `src/http/index.ts`
**Changes**: Keep the spike design: pattern `["agentfs", null]`, `exact: false`, `auth: { apiKey: false }`, `rbac: { ungated: "agent-fs enforces its own af_ auth; swarm credentials are never forwarded" }` on non-GETs, `unstructured` 2xx, tag `Comb`. Request headers forwarded: `Authorization` only when it is `Bearer af_...` (drop a swarm API key or an `aswt_` token, so the ungated reason stays true; the patch forwards any `Authorization` today), `Content-Type`, `Accept`, `If-Match`, `If-None-Match`, `Range`, `X-Agent-FS-Message`, `X-Agent-FS-Message-Encoding`. Never forward `Cookie` or `X-Agent-ID`. Response headers kept: content-type, content-length, content-disposition, etag, last-modified, cache-control, location, `x-agent-fs-*`. On `/agentfs/*`, drop upstream `access-control-*` (the swarm's own CORS applies). Always drop hop-by-hop headers. `redirect: "manual"`. Abort the upstream fetch on `res` `close`. Keep `%2F` in the path (Comb sends a file path as one encoded segment). Do not reuse `isSafeProxySuffix` from `page-proxy.ts`.

#### 2. Public share and site pages
**File**: `src/http/agentfs-proxy.ts`
**Changes**: Two more GET defs, `["share", null]` and `["site", null]`, `auth: { apiKey: false }`, active only when the flag is on. Forward to agent-fs `/share/*` and `/site/*` unchanged, and KEEP the upstream CORS headers on these two prefixes: sandboxed site pages run in an opaque origin (`Origin: null`) and need agent-fs's `Access-Control-Allow-Origin: *` (agent-fs repo `packages/server/src/routes/site.ts:12-30`). The swarm's `setCorsHeaders` echoes only allowlisted origins (`src/http/utils.ts:116-123`), so it must not replace them there. Reason for the two prefixes: agent-fs share pages embed root-absolute URLs (`/share/<token>/raw`, redirects to `/site/<token>/`; agent-fs repo `packages/server/src/routes/share.ts:115,389,404` and `site.ts:160,187,199`). Behind `/agentfs` alone they 404. No swarm route uses these prefixes today (checked on main).

#### 3. Comb endpoint
**File**: `src/comb/config.ts:28-37` (`getCombConfig`)
**Changes**: When the flag is on and `AGENT_FS_PUBLIC_URL` is blank, `apiUrl = ${getPublicMcpBaseUrl()}/agentfs` (`src/utils/constants.ts:71-74`). `AGENT_FS_PUBLIC_URL` still wins when set. Flag off: unchanged. Move `isAgentFsProxyEnabled()` from the patch's `agentfs-proxy.ts` (which tests `=== "true"`) to `constants.ts` next to `isCombEnabled()` (164-167), implemented as `isEnvFlagEnabled("AGENT_FS_PROXY", false)`, so every literal the boolean validator accepts turns it on. Read it per request.

#### 4. Do not log share tokens, and slow down open registration
**Files**: `src/http/utils.ts:258` (`safeRequestUrlForLog`, tests in `src/tests/http-log-scrubbing.test.ts`), `src/http/agentfs-proxy.ts`
**Changes**:
- Redact the path segment after `/share/` and `/site/`, with or without the `/agentfs` prefix, the same way query values are redacted today. Add test cases.
- agent-fs `POST /auth/register` is public with no limit. Through a tunnel, the proxy puts it on the internet. Add a per-IP limiter on `POST /agentfs/auth/register` (reuse `createIpRateLimiter` and `clientIp`, as the connector exchange does in `src/http/users.ts:675-683`; 5 per minute), and export a test reset. Document the open registration in the co-deployment guide.

#### 5. Tests that run in CI
**File**: `src/tests/agentfs-proxy.test.ts`
**Changes**: The spike file spawns a real agent-fs from `../agent-fs` or `AGENT_FS_SRC` and skips 11 tests when it is absent (CI has none). Keep that leg as is. Add CI-safe tests against a `Bun.serve({ port: 0 })` fake upstream (pattern: `src/tests/comb-status.test.ts:117-150`, in-process server: `src/tests/fs-routes.test.ts:1-52`):
- a 20 MB generated body streams (assert the first chunk arrives before the upstream finishes). Keep the 200 MB and RSS checks in the real agent-fs leg;
- an SSE response with `: ping` frames every 200 ms (make the fake's interval a parameter) stays open 2 s and closes upstream on client abort;
- a CORS preflight from `http://localhost:5274` returns 204 with one `Access-Control-Allow-Origin`;
- the upstream sees only allowlisted headers, and a `Bearer aswt_...` or swarm API key never reaches it;
- `/site/<token>/` with `Origin: null` returns agent-fs's `Access-Control-Allow-Origin: *`;
- the sixth `POST /agentfs/auth/register` from one IP within a minute gets 429;
- `/share/<token>/raw` forwards; the access log line does not contain the token;
- flag off: authenticated `/agentfs/x`, `/share/x` and `/site/x` keep today's status (run the request on main first and pin it). Accepted change: the defs register as public routes, so an unauthenticated request with the flag off now gets 404 instead of 401. No client depends on it, because no such route existed. Say this in the PR.

#### 6. Config, docs and counters
**Files**:
- `src/be/swarm-config-guard.ts`: add `AGENT_FS_PROXY` to the boolean list (near `COMB_ENABLED`, line 522).
- `apps/ui/src/lib/configuration-catalog.ts`: boolean entry next to `AGENT_FS_PUBLIC_URL` (line 1372), group `integrations`. Description: "Serve agent-fs through the swarm API at /agentfs, so the browser reaches a bundled agent-fs with no public port. Comb then uses <public API URL>/agentfs."
- Docs: `ui/comb.mdx`, `ui/configuration.mdx`, `reference/environment-variables.mdx` (agent-fs table), and a short "Bundled agent-fs behind the swarm API" section in `guides/agent-fs-co-deployment.mdx`. Say clearly that agent-fs has its own `AGENT_FS_PUBLIC_URL` with a different meaning (base for absolute share links, set to `<public API URL>/agentfs` on the agent-fs container).
- `src/tests/preload.ts` and `src/tests/preload-env.test.ts`: `AGENT_FS_PROXY`.
- `bun run docs:openapi`, commit `openapi.json` and `docs-site/content/docs/api-reference/**`, and set the count in `src/tests/docs-index-footprint.test.js` (lines 81, 106, 107) to the regenerated total. The patch sets 461 (5 defs). With the share and site defs it becomes 463 on today's main.

### Success Criteria:

#### Automated Verification:
- [x] Proxy tests: `bun run test:root -- src/tests/agentfs-proxy.test.ts`
- [x] Real agent-fs leg, locally: `git clone --depth 1 --branch v0.18.5 https://github.com/desplega-ai/agent-fs /tmp/afo-step-2/agent-fs && (cd /tmp/afo-step-2/agent-fs && bun install --frozen-lockfile) && AGENT_FS_SRC=/tmp/afo-step-2/agent-fs bun run test:root -- src/tests/agentfs-proxy.test.ts` (13 spike tests plus the new ones pass, none skipped)
- [x] Comb config: `bun run test:root -- src/tests/comb-status.test.ts src/tests/comb-config-guard.test.ts` (new cases: flag on and blank public URL gives `<PUBLIC_MCP_BASE_URL>/agentfs`; public URL set wins; flag off unchanged)
- [x] Auth wiring: `bun run test:root -- src/tests/core-auth.test.ts src/tests/route-def-find-route.test.ts src/tests/cors-allowlist.test.ts`
- [x] Routes and docs: `bun run check:rbac-coverage && bun run check:openapi-response-coverage && bun run docs:openapi && bun run test:root -- src/tests/docs-index-footprint.test.js`
- [ ] Gates: `bun run check:local && bun run lint && bun run lint:slop && bun run tsc:check:tsc`

#### Automated QA:
- [x] Live check with a real agent-fs and a booted API (both on free ports, temp dirs under `/tmp/afo-step-2/`, no `.env`, PIDs saved and killed at the end): start agent-fs from the `/tmp/afo-step-2/agent-fs` checkout above with `AGENT_FS_STORAGE_PROVIDER=local`, boot the API with `AGENT_FS_API_URL=<agent-fs>` `AGENT_FS_PROXY=true` `COMB_ENABLED=true`. Then:
  - `curl -s <api>/agentfs/health` answers from agent-fs;
  - `curl -s -o /dev/null -w '%{http_code}' <api>/agentfs/auth/me` prints `401` (agent-fs's own);
  - `curl -s -H "Authorization: Bearer <operator key>" <api>/status | jq .agent_fs.comb.api_url` prints `"<api>/agentfs"`;
  - a share link made with the `share-create` op opens through `<api>/share/<token>` and its embedded raw file loads.
- [x] Same API with `AGENT_FS_PROXY` unset: `/agentfs/health` returns the status pinned on main.

#### Manual Verification:
- [ ] None. Behavior behind Traefik, Cloudflare and HTTP/2 is checked in root Manual E2E part B (tunnel).

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing it, pause for manual confirmation. Commit as `[step-2] serve agent-fs through the swarm API` after verification passes.
