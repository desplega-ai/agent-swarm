---
id: step-2
name: Vendored specs + blessed manifest + catalog merge
depends_on: []
status: ready
---

# step-2: Vendored specs + blessed manifest + catalog merge

## Overview
Ship the curated-catalog substrate: a top-level `vendored-openapi/` directory of trimmed, git-pinned OpenAPI specs with a manifest, an operator-run refresh script (modelsdev pattern) plus a CI drift check (openapi.json-freshness pattern — modelsdev has none, this is new machinery), a new `vendored` value for `openapi_spec_source_kind` (migration 119) with a loader branch, and an in-repo blessed manifest merged into the existing `GET /api/integrations-catalog` response (tag `feeds:["blessed"]`, ranked top) with integrations.sh kept as long-tail discovery.

## Changes Required:

#### 1. Vendored specs + manifest
**Files**: `vendored-openapi/manifest.json` (new), `vendored-openapi/<slug>.json` (new, initial blessed set: github, slack, linear, jira, gmail — trimmed to the blessed operation subset), `vendored-openapi/README.md`
**Changes**: Manifest entries: `{slug, name, domain, specFile, specSourceUrl, specVersionPin, baseUrl, categories, presetId?, docsUrl, blessedOperations: string[]}`. Specs are trimmed copies (only `blessedOperations` paths + referenced components), reviewed like code.

#### 2. Refresh script + CI drift check
**Files**: `scripts/refresh-vendored-openapi.ts` (new; template: `scripts/refresh-modelsdev-pricing.ts` — fetch pinned source, re-trim, print human diff, write), `scripts/check-vendored-openapi.ts` (new; verifies each spec file is exactly the deterministic trim of itself given the manifest — catches hand-edits/drift without network), `.github/workflows/merge-gate.yml`, `package.json` (scripts `refresh:vendored-openapi`, `check:vendored-openapi`)
**Changes**: CI runs the offline check only; refresh stays operator-run.

#### 3. `vendored` spec source kind
**Files**: `src/be/migrations/119_vendored_spec_source.sql` (new — table-copy rebuild of `script_connections` widening the `openapi_spec_source_kind` CHECK to `('url','inline','agent_fs','vendored')`; pattern `112_script_connections_graphql.sql`), `src/be/script-connections.ts` (type union at `:40,835`; `upsertScriptConnection` + `refreshScriptConnection` branch: `openapi_spec_source` holds the vendored slug, spec body read from `vendored-openapi/<slug>.json` on disk — path resolution must handle source checkout and Docker image layout like `src/be/modelsdev-cache.ts:33-51`; refresh = re-read from disk, no network, no SSRF concerns), `src/http/script-connections.ts` + `src/tools/script-connections/tool.ts` (accept `specSource: {kind:'vendored', slug}`)
**Changes**: As above. `Dockerfile` must COPY `vendored-openapi/` (check `.dockerignore`).

#### 4. Blessed manifest merged into catalog route
**File**: `src/http/script-connections.ts` (catalog handler around `:1060-1101` + `normalizeCatalogEntry`/`catalogEntriesFromPayload` `:1014-1058`)
**Changes**: Load blessed entries from `vendored-openapi/manifest.json` at module init; merge into the catalog response ahead of proxied entries, `feeds:["blessed"]`, de-dupe by domain (blessed wins). integrations.sh failure must no longer 502 when blessed entries exist — degrade to blessed-only with a `partial:true` flag. Entry shape gains optional `vendoredSlug` + `presetId` passthrough fields (additive).

### Success Criteria:

#### Automated Verification:
- [ ] New tests pass: `bun test src/tests/vendored-openapi.test.ts` (new: manifest schema, trim determinism, `vendored` upsert+refresh via `upsertScriptConnection`, catalog merge incl. integrations.sh-down degradation, migration 119 preserves rows)
- [ ] Drift check passes: `bun run check:vendored-openapi`
- [ ] Existing suites green: `bun test src/tests/script-connections.test.ts src/tests/script-connections-http.test.ts`
- [ ] `bun run tsc:check` && `bun run lint` && `bun run docs:openapi` (commit regenerated `openapi.json` — request schema change on upsert route)
- [ ] Worker image builds with the new COPY: `docker build -f Dockerfile .`

#### Automated QA:
- [ ] Boot server, `curl /api/integrations-catalog` → blessed entries present, first, tagged `feeds:["blessed"]`
- [ ] Create a connection from a vendored slug via curl (`specSource: {kind:'vendored', slug:'github'}`), then `refresh` it → generated types present, no network fetch (verify with server logs)
- [ ] Corrupt one vendored spec locally → `bun run check:vendored-openapi` fails; restore → passes

#### Manual Verification:
- [ ] Review the initial blessed set + trim level (which operations made the cut) — product judgment

**Implementation Note**: This step is a vertical slice — QA-able on its own. Pause for manual confirmation; commit `[step-2] vendored specs + blessed manifest + catalog merge` after verification passes.
