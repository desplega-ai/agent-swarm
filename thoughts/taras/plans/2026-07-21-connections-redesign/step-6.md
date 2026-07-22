---
id: step-6
name: OAuth presets + curated app hydration
depends_on: [step-1, step-2]
status: ready
---

# step-6: OAuth presets + curated app hydration

## Overview
Ship `src/oauth/presets.ts` — a static, typed preset table generalizing the hardcoded Jira/Linear builders (per provider: authorizeUrl/tokenUrl/scopes/scopeSeparator/tokenAuthStyle/tokenBodyFormat/extraParams/userinfoUrl/quirk notes; Google carries `access_type=offline`+`prompt=consent` so refresh tokens exist at all) — and wire it through app creation: `POST /api/oauth-apps` accepts `presetId`, hydrating everything except `clientId`/`clientSecret`, which customers always supply (never ship a shared Desplega secret). Presets surface through the catalog (blessed manifest entries reference `presetId`) and `.well-known` discovery stays the fallback for uncatalogued providers.

## Changes Required:

#### 1. Preset table
**File**: `src/oauth/presets.ts` (new)
**Changes**: `OAuthPreset` type mirroring the `oauth_apps` quirk columns (step-1 contract) + `setupHints: string[]` (human-readable quirk notes: Google offline params, Jira rotation + 90-day inactivity expiry, Notion basic-auth token style). Initial set: `google`, `slack`, `github`, `jira`, `linear`, `notion`. Exported `getOAuthPreset(id)` / `listOAuthPresets()`. Pure data module — importable from tools and HTTP alike, no DB access.

#### 2. Hydration at app creation
**Files**: `src/http/script-connections.ts` (`POST /api/oauth-apps` body gains `presetId`; handler merges preset → explicit fields win; `source='curated-prefill'` when preset used; response echoes `setupHints` + the static redirect URI), `src/tools/credential-bindings/tool.ts` (`oauth-app-upsert` gains `presetId`, output prints setupHints), `GET /api/oauth-presets` (new small GET route listing presets for pickers)
**Changes**: Validation: presetId unknown → 400 listing valid ids. SSRF checks still run on the merged URLs (defense in depth).

#### 3. Catalog linkage
**Files**: `vendored-openapi/manifest.json` (fill `presetId` on blessed entries where the provider has one), `src/http/script-connections.ts` (catalog entries pass `presetId` through — plumbing landed in step-2)
**Changes**: Data-only.

#### 4. Tests
**File**: `src/tests/oauth-presets.test.ts` (new)
**Changes**: Preset hydration (explicit-field precedence, source marking, hint passthrough); every preset's URLs parse + pass `assertOAuthAppUrlsSafe`; google preset includes the offline params in built authorize URLs (via `buildAuthorizationUrl` with the hydrated app); `GET /api/oauth-presets` shape; unknown presetId 400.

### Success Criteria:

#### Automated Verification:
- [ ] `bun test src/tests/oauth-presets.test.ts src/tests/oauth-callback-flow.test.ts`
- [ ] `bun run tsc:check` && `bun run lint` && `bun run check:rbac-coverage`
- [ ] `bun run docs:openapi` — commit regenerated artifacts (new GET route + body field)

#### Automated QA:
- [ ] Boot server: `curl /api/oauth-presets` lists 6 presets; create an app with `presetId:'google'` + dummy client creds via curl → row has google endpoints, `source='curated-prefill'`, authorize-url contains `access_type=offline&prompt=consent`
- [ ] `curl /api/integrations-catalog` → blessed gmail entry carries `presetId:'google'`
- [ ] Discovery fallback intact: `POST /api/oauth-apps/discover` against a mock RFC-8414 server still fills endpoints

#### Manual Verification:
- [ ] Sanity-read the setupHints copy (user-facing text)

**Implementation Note**: This step is a vertical slice — QA-able on its own. Pause for manual confirmation; commit `[step-6] OAuth presets + curated app hydration` after verification passes.
