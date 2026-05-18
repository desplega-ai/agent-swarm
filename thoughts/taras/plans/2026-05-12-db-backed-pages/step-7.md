---
id: step-7
name: JSON renderer (@json-render/react)
depends_on: [step-6]
status: done
assignee: orchestrator-step-7-2026-05-12
claimed_at: 2026-05-12T00:00:00Z
completed_at: 2026-05-12T00:00:00Z
---

# step-7: JSON renderer (`@json-render/react`)

## Overview

Install `@json-render/core` + `@json-render/react` (vercel-labs/json-render, Apache-2.0, peer deps `react^19` + `zod^4`) in `ui/`. Build TWO custom action node types so agents can choose between:

1. **`swarm.sdk`** — `{sdk: "<method>", args: {...}}` — dispatches the named method on the in-SPA `SwarmSDK` (same surface as `BROWSER_SDK_JS` exposed in HTML pages). Recommended default because the SDK surface is already the documented agent contract.
2. **`swarm.call`** — `{method, endpoint, body?}` — raw HTTP. Escape hatch for endpoints the SDK doesn't yet cover.

Both dispatch via the user's bearer (no `/@swarm/api/*` proxy — JSON renderer runs in-SPA). The renderer registers both action types in a single catalog so a spec can use either or both. Also ship a discovery endpoint (`GET /api/pages/actions`) returning the full action allowlist + Zod-derived JSON Schema, so tools that generate pages programmatically can introspect; the agent-facing `plugin/skills/pages/SKILL.md` (note the **uppercase `SKILL.md`** filename — standard skill convention, NOT the legacy `skill.md` used by the older artifacts skill) documents this endpoint and the full allowlist in prose. Replace step-6's `<JsonPlaceholder />` stub with the real renderer. End-to-end: an agent creates a JSON page declaring an `swarm.sdk` button → user clicks → SDK method invoked → server confirms.

## Changes Required:

#### 1. Verify peer-dep compatibility
**File**: `ui/package.json`
**Changes**:
- Add `"@json-render/core": "^<latest>"` and `"@json-render/react": "^<latest>"`.
- Check current `zod` version. `@json-render/react` requires `zod ^4`. If `ui/`'s zod is `< 4`, bump it and run `pnpm install --frozen-lockfile=false` (regenerate lock).
- React is already `^19.x` (verified by step-6 research) — no bump.

#### 2. Install + verify
**File**: `ui/pnpm-lock.yaml` (regenerated)
**Changes**: `cd ui && pnpm install` writes new lockfile. Commit it.

#### 3. Swarm catalog + registry — two action types
**File**: `ui/src/pages/json-page-renderer.tsx` (new)
**Changes**:
```tsx
import { defineCatalog, defineRegistry } from "@json-render/core";
import { Renderer, ActionProvider, StateProvider, ... } from "@json-render/react";
import { z } from "zod";

// Reuse the SDK surface that the Browser SDK already exposes.
// The methods are: createTask, getTasks, getTaskDetails, storeProgress,
// postMessage, readMessages, getSwarm, listServices, slackReply.
const SDK_METHODS = ["createTask","getTasks","getTaskDetails","storeProgress",
  "postMessage","readMessages","getSwarm","listServices","slackReply"] as const;

const swarmSdkSchema = z.object({
  sdk: z.enum(SDK_METHODS),
  args: z.record(z.unknown()).optional(),
});

const swarmCallSchema = z.object({
  method: z.enum(["GET","POST","PUT","DELETE","PATCH"]),
  endpoint: z.string(),
  body: z.record(z.unknown()).optional(),
});

export const swarmCatalog = defineCatalog({
  actions: {
    "swarm.sdk":  swarmSdkSchema,
    "swarm.call": swarmCallSchema,
  },
});

export const swarmRegistry = defineRegistry(swarmCatalog, {
  actions: {
    "swarm.sdk": async ({ params }, setState) => {
      const sdk = makeSwarmSDK(/* apiUrl + apiKey from useConfig */);
      const result = await (sdk[params.sdk] as any)(params.args ?? {});
      setState({ lastActionResponse: result });
    },
    "swarm.call": async ({ params }, setState) => {
      const client = /* ApiClient from context */;
      const res = await fetch(`${client.apiUrl}${params.endpoint}`, {
        method: params.method,
        headers: { ...client.getHeaders(), "Content-Type": "application/json" },
        body: params.body ? JSON.stringify(params.body) : undefined,
      });
      setState({ lastActionResponse: { status: res.status, body: await res.text() } });
    },
  },
});

export function JsonPageRenderer({ body }: { body: string }) {
  let spec: unknown;
  try { spec = JSON.parse(body); } catch { return <ErrorState message="Page body is not valid JSON" />; }
  return (
    <StateProvider>
      <ActionProvider registry={swarmRegistry}>
        <Renderer spec={spec} registry={swarmRegistry} />
      </ActionProvider>
    </StateProvider>
  );
}
```
The `makeSwarmSDK(apiUrl, apiKey)` factory lives at `ui/src/lib/swarm-sdk.ts` (new) — a thin in-SPA mirror of the methods on `BROWSER_SDK_JS`'s `SwarmSDK` class. Each method just wraps `apiClient.<call>` so the SPA's existing client carries the bearer.

#### 3b. Actions discovery endpoint
**File**: `src/http/pages.ts` (extend step-3)
**Changes**: Add `GET /api/pages/actions` (bearer-authed). Returns:
```json
{
  "actions": [
    {"name": "swarm.sdk", "description": "Invoke a method on the swarm SDK", "params": <JSON Schema of swarmSdkSchema>, "sdkMethods": [...]},
    {"name": "swarm.call", "description": "Raw HTTP call to a swarm API endpoint", "params": <JSON Schema of swarmCallSchema>}
  ]
}
```
The schemas are derived from the Zod definitions via `zod-to-json-schema` (already a transitive dep or trivially addable). Add a unit test that the endpoint returns the expected names.

#### 4. Wire renderer into ArtifactPage
**File**: `ui/src/pages/artifact-page.tsx` (extend step-6)
**Changes**: Replace `<JsonPlaceholder />` with `<JsonPageRenderer body={data.body} />`. JSON pages are SPA-only — the API's `/p/:id` already 302-redirects JSON `content_type` to the SPA route (step-3, behavior unchanged).

#### 5. Agent-side smoke-test page generator (test fixture)
**File**: `src/tests/fixtures/sample-json-page.json` (new)
**Changes**: A JSON spec with one heading and TWO buttons — one bound to `swarm.sdk` (e.g. `{sdk: "createTask", args: {description: "from-page"}}`) and one bound to `swarm.call` (e.g. `{method: "POST", endpoint: "/api/channels", body: {name: "from-page"}}`). Used by automated QA below to exercise both action paths.

#### 6. Tests
**File**: `ui/src/pages/json-page-renderer.test.tsx` (new — vitest)
**Changes**: Render `<JsonPageRenderer body={sampleJson} />` with a mock fetch; click the `swarm.call` button → assert fetch was called with `Bearer <apiKey>`, `POST`, expected endpoint, expected body. Click the `swarm.sdk` button → assert the SDK method's underlying API call fired with the same bearer.

**File**: `qa-use/tests/pages-json-action.yaml` (new)
**Changes**: Scenario:
1. Pre-create a JSON page with the sample-json fixture via curl.
2. Navigate to `/artifacts/<id>`.
3. Wait for "Create channel" button.
4. Click button.
5. Assert toast / state shows success.
6. Optionally verify side effect: list channels via `/api/channels` and confirm the new one exists.

### Success Criteria:

#### Automated Verification:
- [x] `cd ui && pnpm install --frozen-lockfile` (lockfile is committed and valid)
- [x] `cd ui && pnpm exec tsc -b`
- [x] `cd ui && pnpm lint`
- [ ] ~~`cd ui && pnpm test src/pages/json-page-renderer.test.tsx`~~ — **DEFERRED per Taras**: no UI vitest infra (no vitest, no jsdom). Taras manually QAs the SPA. The unit-test file (`json-page-renderer.vtest.tsx`) plus `vitest.config.ts` / `vitest.setup.ts` + test devDeps were intentionally removed. Backend coverage for the action allowlist is in `src/tests/pages-actions-endpoint.test.ts`.
- [x] Root tests still pass: `bun test` (3858 pass / 0 fail)
- [x] Root lint + typecheck: `bun run lint && bun run tsc:check`

#### Automated QA:
- [ ] ~~qa-use scenario `pages-json-action.yaml`~~ — **DEFERRED per Taras**: no qa-use YAML; Taras manually QAs.
- [ ] ~~`GET /api/channels` reflects the click side-effect~~ — covered by manual QA.

#### Manual Verification:
- [ ] Visual judgment on json-render.dev's default theme (Tailwind 4 + shadcn-styled components ship in the package). If it clashes with the SPA's look, file a follow-up — do NOT block this step on theme polish.
- [ ] Open DevTools Network for the action click: confirm `Authorization: Bearer ${apiKey}` is attached (proves viewer bearer is used, not the page-session cookie — JSON actions in v1 don't route through the `/@swarm/api/*` proxy).

**Implementation Note**: This step introduces a non-trivial third-party UI dep (`@json-render/react`). If install fails for ANY reason (peer-dep mismatch, registry issue, esbuild plugin conflict), STOP and surface to Taras before forking or vendoring. Commit as `[step-7] @json-render/react + swarm.call action node`.
