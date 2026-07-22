---
id: step-11
name: Integration — E2E gauntlet + docs
depends_on: [step-3, step-8, step-9, step-10]
status: ready
---

# step-11: Integration — E2E gauntlet + docs

## Overview
Terminal stitch step: prove the whole redesign end to end (fresh + populated DB boots, the Gmail-style 1-app/2-authorizations/2-connections scenario through real script execution, tracker + MCP flows on the unified core), sweep for dead code from the old stacks, and land the documentation the same-PR rules require (docs-site guides, runbooks, MCP.md, final openapi/artifact regen).

## Changes Required:

#### 1. E2E script + verification harness
**File**: `scripts/e2e-connections-redesign.ts` (new, PASS/FAIL + /tmp log per the script-builder convention)
**Changes**: Against a locally booted server + in-script mock OAuth provider and mock API: (1) fresh-DB boot → migrations 117-120 apply; (2) populated-DB boot from a pre-117 fixture → all rows carried, backfill encrypts, second boot no-ops; (3) app → authorizations `support`+`sales` → two connections with `auth:{type:'oauth'}` → `script_run` calls `ctx.api.gmailSupport` + `ctx.api.gmailSales` → mock receives two different Bearer tokens; (4) refresh-failure path: kill mock token endpoint → sweep flips status → script gets typed error → restore → recovers; (5) tracker wrapper flow (mock linear); (6) MCP-DCR flow (mock AS) → `resolveSecrets=true` returns the header.

#### 2. Dead-code + consistency sweep
**Files**: repo-wide
**Changes**: Verify nothing references dropped tables/columns (`rg "oauth_tokens|mcp_oauth_tokens|mcp_oauth_pending|oauthProvider|SCRIPT_CREDENTIAL_BINDINGS|RESERVED_OAUTH_PROVIDERS"` — remaining hits only in migrations/changelogs/thoughts); delete orphaned helpers (in-memory pending map remnants, `DEDICATED_CALLBACK_PROVIDERS`, legacy blob store types); confirm scrubber covers new secret shapes per `runbooks/secret-scrubbing.md`.

#### 3. Documentation (same-PR rules)
**Files**: `docs-site/content/docs/(documentation)/guides/` (connections/OAuth guide — new or heavily rewritten: apps vs authorizations, static callback registration, presets, embedded auth, vendored specs), `runbooks/local-development.md` (OAuth env/callback section), `runbooks/secret-scrubbing.md` (new secret shapes: `connection.<slug>.secret`, encrypted columns), `MCP.md` (tool arg changes: `auth` object, `oauth-authorizations-list`, presetId, vendored source), `CLAUDE.md` (script-connections `<important>` block: update the connection/binding/OAuth description to the new model), `openapi.json` + api-reference (final `bun run docs:openapi`)
**Changes**: As listed. Check `BUSINESS_USE.md` instrumentation still matches if any `ensure()` call sites moved.

### Success Criteria:

#### Automated Verification:
- [ ] E2E harness passes: `bun run scripts/e2e-connections-redesign.ts` → PASS
- [ ] Full merge-gate mirror: `bun install --frozen-lockfile && bun run lint && bun run tsc:check && bun test && bash scripts/check-db-boundary.sh && bun run check:dep-graph && bun run check:rbac-coverage && bun run check:vendored-openapi`
- [ ] `bun run docs:openapi` produces no diff (artifacts already committed)
- [ ] `docker build -f Dockerfile .` and `docker build -f Dockerfile.worker .` succeed (COPY changes from step-2)
- [ ] Dead-reference grep from #2 returns only migrations/docs/thoughts hits

#### Automated QA:
- [ ] `docker compose -f docker-compose.local.yml up --build` → send a task through the local swarm that runs a script against an OAuth-backed connection (swarm-local-e2e recipe) → task completes with substituted credentials, logs scrubbed

#### Manual Verification:
- [ ] Taras end-to-end pass with a real provider (Google two-inbox scenario) on the dev deployment
- [ ] Review the docs-site guide copy

**Implementation Note**: This step is the DAG's integration gate. After it passes, run the plan's Global Verification checklist in `root.md`. Commit `[step-11] integration e2e + docs` after verification passes.
