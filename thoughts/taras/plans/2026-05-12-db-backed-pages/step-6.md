---
id: step-6
name: SPA /artifacts/:id + HTML iframe
depends_on: [step-3]
status: done
---

# step-6: SPA `/artifacts/:id` + HTML iframe rendering

## Overview

Add a new `/artifacts/:id` route to the SPA at `ui/src/app/router.tsx:43-86`. The route fetches `${apiUrl}/p/:id.json` (with absolute URL and `credentials: 'include'` so cookies travel cross-origin), inspects `content_type` and `auth_mode`, and renders HTML pages inside a sandboxed iframe whose `src` is `${apiUrl}/p/:id` (also absolute, cookie-friendly). Authed pages call `POST ${apiUrl}/api/pages/:id/launch` first to mint the cookie. Password pages collect the password in a modal and pass it as `?key=` in the iframe `src` (the page's own auth path issues the cookie). JSON-rendering deferred to step-7; this step short-stubs JSON pages to "rendering coming soon — view via `api_url`" so the route doesn't crash.

## Changes Required:

#### 1. New SPA route
**File**: `ui/src/app/router.tsx`
**Changes**: Add `<Route path="/artifacts/:id" element={<ArtifactPage />} />` as a child of `RootLayout`. ConfigGuard wraps it implicitly (no exemption needed — viewers without a configured connection get redirected to `/config`, which is acceptable v1 behavior).

#### 2. ArtifactPage component
**File**: `ui/src/pages/artifact-page.tsx` (new — follow shadcn conventions used elsewhere in `ui/src/pages/`)
**Changes**:
```tsx
export function ArtifactPage() {
  const { id } = useParams<{ id: string }>();
  const { connection } = useConfig();          // ui/src/hooks/use-config.ts
  const apiUrl = connection?.apiUrl;
  const apiKey = connection?.apiKey;
  const { data, error, isLoading } = useQuery({
    queryKey: ["page-metadata", id],
    queryFn: () => fetchPageMetadata(apiUrl, apiKey, id!),  // implemented in api/client.ts
  });
  if (isLoading) return <Skeleton ... />;
  if (error || !data) return <ErrorState ... />;
  if (data.contentType === "application/json") return <JsonPlaceholder />;  // step-7 swaps this
  switch (data.authMode) {
    case "public":    return <PublicHtmlFrame apiUrl={apiUrl} id={id} title={data.title} />;
    case "authed":    return <AuthedHtmlFrame apiUrl={apiUrl} apiKey={apiKey} id={id} title={data.title} />;
    case "password":  return <PasswordHtmlFrame apiUrl={apiUrl} id={id} title={data.title} />;
  }
}
```

`PublicHtmlFrame`: render `<iframe src={`${apiUrl}/p/${id}`} sandbox="allow-scripts allow-forms allow-same-origin" className="w-full h-screen border-0" />`.

`AuthedHtmlFrame`: on mount, `fetch(`${apiUrl}/api/pages/${id}/launch`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, credentials: "include" })` first; only after 204 → render the iframe (same shape as public). Show a brief loader during launch. Handle non-204 with an error state.

`PasswordHtmlFrame`: render a password input (shadcn `Input` + `Button`) inside a `Card`. On submit → `setIframeSrc(`${apiUrl}/p/${id}?key=${encodeURIComponent(password)}`)`. Once src is set, render the iframe; the iframe load itself does the auth + cookie mint. If the iframe response is 401, the browser will show the Basic dialog inside the frame — let it happen.

#### 3. API client helper
**File**: `ui/src/api/client.ts`
**Changes**: Add to `ApiClient` (or as a free function):
```ts
async fetchPageMetadata(id: string): Promise<PageMetadata> {
  const res = await fetch(`${this.apiUrl}/p/${id}.json`, {
    headers: this.getHeaders(),
    credentials: "include",
  });
  if (!res.ok) throw new Error(`page ${id}: ${res.status}`);
  return res.json();
}
```
(For `authed` mode this will 401 until cookie minted — caller handles by minting first via `launchPage`.) Also add `launchPage(id)` that POSTs to `/api/pages/:id/launch`. Types in `ui/src/api/types.ts` if a separate file is the convention; otherwise inline.

#### 4. PageMetadata type
**File**: `ui/src/api/client.ts` (or `ui/src/api/types.ts`)
**Changes**: Mirror server's response shape from step-3:
```ts
type PageMetadata = {
  id: string;
  version: number;
  title: string;
  description: string | null;
  contentType: "text/html" | "application/json";
  authMode: "public" | "authed" | "password";
  body: string;
};
```

#### 5. CORS on launch endpoint (cross-checking step-2)
**File**: `src/http/pages.ts`
**Changes**: Confirm step-2's CORS preflight handling covers `OPTIONS /api/pages/:id/launch` from `http://localhost:5274` (dev SPA origin). Adjust if step-2's heuristic missed this case.

#### 6. qa-use seed (not a full test yet — step-9 owns the full session)
**File**: `qa-use/tests/pages-html-render.yaml` (new — follow existing `qa-use/tests/*.yaml` shape if present)
**Changes**: Three scenarios as YAML scaffolding (full scenarios filled in step-9):
1. Navigate to `/artifacts/<public-html-id>` → screenshot.
2. Navigate to `/artifacts/<authed-html-id>` → wait for iframe load → screenshot.
3. Navigate to `/artifacts/<password-html-id>` → enter password → screenshot.

### Success Criteria:

#### Automated Verification:
- [x] `cd ui && pnpm exec tsc -b` (CI's exact form — NOT `--noEmit`)
- [x] `cd ui && pnpm lint`
- [x] No regressions in existing server tests: `bun test`
- [x] Lint root: `bun run lint`
- [x] Typecheck root: `bun run tsc:check`

#### Automated QA:
- [ ] Boot the swarm locally: API on :3013 (`bun run start:http`), SPA on :5274 (`cd ui && pnpm dev`). Pre-create three pages via curl (public HTML, authed HTML, password HTML). Open each `/artifacts/:id` URL in Chrome (headless via qa-use), confirm:
  - Public: iframe loads, body visible.
  - Authed: brief loader → iframe loads, body visible. DevTools shows `Set-Cookie page_session` on the launch response.
  - Password: input form → submit → iframe loads body.
- [ ] qa-use session screenshots committed to `qa-use/sessions/2026-XX-XX-pages-step-6/` for the three scenarios (merge-gate requirement for `ui/` touches).

#### Manual Verification:
- [ ] In an incognito Chrome window with a configured connection, click `/artifacts/<id>` directly — confirm `ConfigGuard` does NOT redirect (connection is present in localStorage). In a fresh profile WITHOUT a connection, confirm it DOES redirect to `/config` (acceptable v1 behavior).
- [ ] Verify cross-origin cookie behavior: in dev (`localhost:5274` ↔ `localhost:3013`), Network panel shows cookie in the iframe's request to `/p/:id` after launch.

**Implementation Note**: This is the first step that touches `ui/` — the qa-use session with screenshots is non-negotiable per the merge gate (`CLAUDE.md` § testing). Commit as `[step-6] SPA /artifacts/:id route with HTML iframe rendering`.
