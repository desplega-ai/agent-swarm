import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  countAllPages,
  countPagesByAgent,
  createPage,
  deletePage,
  getPage,
  getPageVersion,
  getPageVersions,
  listAllPages,
  listPagesByAgent,
  updatePage,
} from "../be/db";
import { snapshotPage } from "../pages/version";
import { type Page, PageAuthModeSchema, PageContentTypeSchema, type PageSummary } from "../types";
import { getAppUrl, getPublicMcpBaseUrl } from "../utils/constants";
import { issuePageSessionCookie } from "../utils/page-session";
import { route } from "./route-def";
import { BODY_TOO_LARGE, enforceContentLengthCap, json, jsonError } from "./utils";

/**
 * Per-page body-size cap. Page bodies are stored as a TEXT column with no
 * per-instance quota, so we bound individual writes here. 5 MiB comfortably
 * holds a JSON-render spec or static HTML report; anything larger is almost
 * certainly an agent runaway. Bumping requires careful thought about the
 * SQLite write-amplification (full body is snapshotted into page_versions on
 * every update).
 */
const MAX_PAGE_BODY_BYTES = 5 * 1024 * 1024;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Lightweight kebab-case slug generator. Lowercases, replaces any run of
 * non-alphanumeric chars with a single hyphen, trims hyphens, falls back to
 * "page" if the result is empty (e.g. a title of "!!!").
 */
function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "page";
}

// ─── Route Definitions ──────────────────────────────────────────────────────

const createPageRoute = route({
  method: "post",
  path: "/api/pages",
  pattern: ["api", "pages"],
  summary: "Create a new page",
  tags: ["Pages"],
  body: z.object({
    slug: z.string().min(1).optional(),
    title: z.string().min(1),
    description: z.string().optional(),
    contentType: PageContentTypeSchema,
    authMode: PageAuthModeSchema.default("authed"),
    password: z.string().min(1).optional(),
    body: z.string(),
    needsCredentials: z.array(z.string()).optional(),
  }),
  responses: {
    201: { description: "Page created" },
    400: { description: "Invalid body" },
    409: { description: "Slug already exists for this agent" },
  },
});

const getPageRoute = route({
  method: "get",
  path: "/api/pages/{id}",
  pattern: ["api", "pages", null],
  summary: "Get a page by ID",
  tags: ["Pages"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Page row" },
    404: { description: "Page not found" },
  },
});

/**
 * Issue a page-session cookie for a given page id. Bearer-authed.
 *
 * Per auth_mode:
 *   - `public`: cookie issued (uniform path — even public pages can be loaded
 *     with cookie context if desired).
 *   - `authed`: cookie issued (normal flow).
 *   - `password`: rejected with 400 — password pages must be unlocked via
 *     `?key=` query / HTTP Basic on `/p/:id` directly (step-5). Bearer-side
 *     issuance would bypass the password check entirely.
 *
 * Response: 204 No Content + `Set-Cookie: page_session=<signed>; HttpOnly; ...`.
 */
const launchPageRoute = route({
  method: "post",
  path: "/api/pages/{id}/launch",
  pattern: ["api", "pages", null, "launch"],
  summary: "Launch a page session (issues HttpOnly cookie)",
  tags: ["Pages"],
  params: z.object({ id: z.string() }),
  responses: {
    204: { description: "Cookie issued" },
    400: { description: "Launch not supported for this page (e.g. password mode)" },
    404: { description: "Page not found" },
  },
});

/**
 * PUT /api/pages/:id — update an existing page. Body is the same shape as
 * POST minus `slug` (slug is immutable post-create to keep the URL stable);
 * any subset of the other fields may be sent. Snapshot of the pre-update
 * state is captured BEFORE applying the patch (mirrors snapshotWorkflow at
 * src/http/workflows.ts:483).
 */
const updatePageRoute = route({
  method: "put",
  path: "/api/pages/{id}",
  pattern: ["api", "pages", null],
  summary: "Update an existing page",
  tags: ["Pages"],
  params: z.object({ id: z.string() }),
  body: z.object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    contentType: PageContentTypeSchema.optional(),
    authMode: PageAuthModeSchema.optional(),
    password: z.string().min(1).nullable().optional(),
    body: z.string().optional(),
    needsCredentials: z.array(z.string()).nullable().optional(),
  }),
  responses: {
    200: { description: "Page updated" },
    404: { description: "Page not found" },
    413: { description: "Payload too large" },
  },
});

const deletePageRoute = route({
  method: "delete",
  path: "/api/pages/{id}",
  pattern: ["api", "pages", null],
  summary: "Delete a page (and all version history)",
  tags: ["Pages"],
  params: z.object({ id: z.string() }),
  responses: {
    204: { description: "Page deleted" },
    404: { description: "Page not found" },
  },
});

const listPagesRoute = route({
  method: "get",
  path: "/api/pages",
  pattern: ["api", "pages"],
  summary: "List pages",
  description:
    "Returns pages WITHOUT the heavy `body` (the full HTML/JSON document) and `passwordHash` by default — list views never render the body. Pass `fields=full` to restore `body`. Fetch a full page via `GET /api/pages/{id}`.",
  tags: ["Pages"],
  query: z.object({
    agentId: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    /** `full` restores the legacy shape (includes `body`); default is slim. */
    fields: z.enum(["full", "slim"]).optional(),
  }),
  responses: {
    200: { description: "Page list with totals + share-URL pointers" },
  },
});

/**
 * GET /api/pages/actions — discovery endpoint for the JSON-page action
 * allowlist (step-7 of the db-backed-pages plan). Returns the full set of
 * action types that a JSON page can declare, plus a JSON-Schema rendering of
 * each action's params (derived from the same Zod schemas the SPA uses, so
 * the contract is single-source-of-truth).
 *
 * Used by tools that generate pages programmatically (agents, fixtures,
 * future MCP tooling) to introspect what's supported without scraping the
 * skill markdown.
 */
const listPageActionsRoute = route({
  method: "get",
  path: "/api/pages/actions",
  pattern: ["api", "pages", "actions"],
  summary: "List JSON-page action allowlist (with param JSON Schemas)",
  tags: ["Pages"],
  responses: {
    200: { description: "Action allowlist" },
  },
});

/**
 * Action-param schemas duplicated from `ui/src/pages/pages/[id]/json-page-renderer.tsx`.
 * Kept here (not imported from `ui/`) because the API server must not depend on
 * the SPA build. If you change one side, update the other — there's an
 * end-to-end test in step-7's qa-use scenario that exercises both action paths,
 * so drift surfaces fast in practice.
 */
const SDK_METHODS = [
  "createTask",
  "getTasks",
  "getTaskDetails",
  "storeProgress",
  "postMessage",
  "readMessages",
  "getSwarm",
  "listServices",
  "slackReply",
] as const;

const swarmSdkActionParamsSchema = z.object({
  sdk: z.enum(SDK_METHODS),
  args: z.record(z.string(), z.unknown()).optional(),
});

const swarmCallActionParamsSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
  endpoint: z.string(),
  body: z.record(z.string(), z.unknown()).optional(),
});

const listPageVersionsRoute = route({
  method: "get",
  path: "/api/pages/{id}/versions",
  pattern: ["api", "pages", null, "versions"],
  summary: "List version snapshots for a page",
  tags: ["Pages"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Version list (newest first)" },
    404: { description: "Page not found" },
  },
});

const getPageVersionRoute = route({
  method: "get",
  path: "/api/pages/{id}/versions/{version}",
  pattern: ["api", "pages", null, "versions", null],
  summary: "Get a single page-version snapshot",
  tags: ["Pages"],
  params: z.object({ id: z.string(), version: z.coerce.number().int().min(1) }),
  responses: {
    200: { description: "Version snapshot" },
    404: { description: "Page or version not found" },
  },
});

/**
 * Cookie issuance moved to `src/utils/page-session.ts::issuePageSessionCookie`
 * so the password-flow on `/p/:id` (step-5) can mint cookies via the same
 * helper. `dev=true` softens the cookie for `http://localhost` (no Secure
 * required; SameSite=Lax). Detected by `isDevRequest()` below.
 */

/**
 * Apply CORS headers needed for the cross-origin launch call. The SPA on
 * `localhost:5274` calls `localhost:3013` with `credentials: 'include'`,
 * which requires:
 *   - `Access-Control-Allow-Origin: <exact origin>` (NOT `*`)
 *   - `Access-Control-Allow-Credentials: true`
 *
 * Production paths typically use a shared parent domain (cookie scoped via
 * `Domain=`), but for local dev we have to be explicit.
 */
function applyLaunchCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = (req.headers.origin as string | undefined) ?? "";
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

/**
 * Resolve the public API base URL used to build a page's `api_url` share
 * pointer (handed to a browser). Delegates to the shared
 * {@link getPublicMcpBaseUrl} helper (trailing slashes already stripped) so
 * callers can concatenate `/p/:id` directly.
 */
function getApiBaseUrl(): string {
  return getPublicMcpBaseUrl();
}

/**
 * Resolve the SPA / dashboard base URL used to build a page's `app_url` share
 * pointer (→ `/pages/:id`). Delegates to the shared {@link getAppUrl} helper.
 */
function getAppBaseUrl(): string {
  return getAppUrl();
}

/** Decorate a page row with share-URL pointers. */
function withShareUrls<T extends { id: string }>(
  page: T,
): T & { app_url: string; api_url: string } {
  return {
    ...page,
    api_url: `${getApiBaseUrl()}/p/${page.id}`,
    app_url: `${getAppBaseUrl()}/pages/${page.id}`,
  };
}

/**
 * Compute the page's "edit counter" — `MAX(page_versions.version) + 1`. Means
 * "this is the N-th edit since the page was created". After the first PUT the
 * value is 2 (one snapshot row → version 1 → counter becomes 2). This is the
 * value POST and PUT return as `version` on the wire.
 */
function pageEditCounter(pageId: string): number {
  const versions = getPageVersions(pageId);
  return versions.length > 0 ? versions[0]!.version + 1 : 1;
}

function isDevRequest(req: IncomingMessage): boolean {
  if (process.env.NODE_ENV === "production") return false;
  // We want `SameSite=Lax` only when the request itself comes from the same
  // local-`http://localhost` origin as the API — same-site loads tolerate
  // Lax without Secure. Anything else (including portless `*.localhost`
  // setups talking from HTTPS to the HTTP API) must use `SameSite=None;
  // Secure` so the cookie travels on cross-site fetches; Chrome treats
  // localhost as a secure origin so the Secure flag is fine on HTTP.
  const origin = (req.headers.origin as string | undefined) ?? "";
  return (
    origin === "" || origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1")
  );
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handlePages(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (createPageRoute.match(req.method, pathSegments)) {
    // Body-size cap. Page bodies land in SQLite TEXT — cap large writes.
    if (enforceContentLengthCap(req, res, MAX_PAGE_BODY_BYTES) === BODY_TOO_LARGE) return true;
    const parsed = await createPageRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    if (!myAgentId) {
      jsonError(res, "X-Agent-ID header required", 400);
      return true;
    }

    const slug = parsed.body.slug ?? slugify(parsed.body.title);

    // Hash password if provided. Bun.password.hash is async (Argon2 by default;
    // we explicitly select bcrypt to keep hashes short + portable).
    let passwordHash: string | undefined;
    if (parsed.body.password) {
      passwordHash = await Bun.password.hash(parsed.body.password, "bcrypt");
    }

    try {
      const page = createPage({
        agentId: myAgentId,
        slug,
        title: parsed.body.title,
        description: parsed.body.description,
        contentType: parsed.body.contentType,
        authMode: parsed.body.authMode,
        passwordHash,
        body: parsed.body.body,
        needsCredentials: parsed.body.needsCredentials,
      });
      // First write has no prior snapshot — version 1 is implicit (the parent
      // IS v1). Subsequent edits land via PUT and bump the counter.
      json(
        res,
        {
          id: page.id,
          version: 1,
          api_url: `${getApiBaseUrl()}/p/${page.id}`,
          app_url: `${getAppBaseUrl()}/pages/${page.id}`,
        },
        201,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE")) {
        jsonError(res, `Page with slug "${slug}" already exists for this agent`, 409);
        return true;
      }
      throw err;
    }
    return true;
  }

  // GET /api/pages/actions — JSON-page action allowlist. MUST come BEFORE
  // getPageRoute (which matches `["api", "pages", null]`) because otherwise
  // the `null`-wildcard slot would capture "actions" as a page id.
  if (listPageActionsRoute.match(req.method, pathSegments)) {
    const sdkSchema = z.toJSONSchema(swarmSdkActionParamsSchema, { target: "draft-7" });
    const callSchema = z.toJSONSchema(swarmCallActionParamsSchema, { target: "draft-7" });
    json(res, {
      actions: [
        {
          name: "swarm.sdk",
          description: "Invoke a method on the in-SPA Swarm SDK with the viewer's bearer.",
          params: sdkSchema,
          sdkMethods: SDK_METHODS,
        },
        {
          name: "swarm.call",
          description: "Raw HTTP call to a swarm /api/* endpoint with the viewer's bearer.",
          params: callSchema,
        },
      ],
    });
    return true;
  }

  // GET /api/pages — listing. MUST come BEFORE getPageRoute because both
  // patterns start with `["api", "pages"]` and the list pattern is shorter.
  // Optional `agentId` query filter narrows to a single owner — used by the
  // SPA's "My pages only" toggle. Omitting it returns all pages visible to
  // the caller (no per-row ACL in v1).
  if (listPagesRoute.match(req.method, pathSegments)) {
    const parsed = await listPagesRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const limit = parsed.query.limit ?? 50;
    const offset = parsed.query.offset ?? 0;
    // List responses default to slim (no `body`); `?fields=full` restores it.
    const full = parsed.query.fields === "full";
    let pages: Array<Page | PageSummary>;
    let total: number;
    if (parsed.query.agentId) {
      pages = full
        ? listPagesByAgent(parsed.query.agentId, limit, offset)
        : listPagesByAgent(parsed.query.agentId, limit, offset, { slim: true });
      total = countPagesByAgent(parsed.query.agentId);
    } else {
      pages = full ? listAllPages(limit, offset) : listAllPages(limit, offset, { slim: true });
      total = countAllPages();
    }
    json(res, {
      pages: pages.map(withShareUrls),
      // Filter-aware total (real row count, not the current page's length) so
      // the UI pager reflects all pages, not just what this request returned.
      total,
      limit,
      offset,
    });
    return true;
  }

  // GET /api/pages/:id/versions/:version — single-version snapshot. Match
  // BEFORE the listVersions / getPage routes because it has the deepest path.
  if (getPageVersionRoute.match(req.method, pathSegments)) {
    const parsed = await getPageVersionRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const page = getPage(parsed.params.id);
    if (!page) {
      res.writeHead(404);
      res.end();
      return true;
    }
    const version = getPageVersion(parsed.params.id, parsed.params.version);
    if (!version) {
      res.writeHead(404);
      res.end();
      return true;
    }
    json(res, version);
    return true;
  }

  // GET /api/pages/:id/versions — full version history (newest first).
  if (listPageVersionsRoute.match(req.method, pathSegments)) {
    const parsed = await listPageVersionsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const page = getPage(parsed.params.id);
    if (!page) {
      res.writeHead(404);
      res.end();
      return true;
    }
    const versions = getPageVersions(parsed.params.id);
    json(res, { versions });
    return true;
  }

  if (getPageRoute.match(req.method, pathSegments)) {
    const parsed = await getPageRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const page = getPage(parsed.params.id);
    if (!page) {
      res.writeHead(404);
      res.end();
      return true;
    }
    json(res, withShareUrls(page));
    return true;
  }

  // PUT /api/pages/:id — update an existing page. Snapshot BEFORE update.
  if (updatePageRoute.match(req.method, pathSegments)) {
    if (enforceContentLengthCap(req, res, MAX_PAGE_BODY_BYTES) === BODY_TOO_LARGE) return true;
    const parsed = await updatePageRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const existing = getPage(parsed.params.id);
    if (!existing) {
      res.writeHead(404);
      res.end();
      return true;
    }

    // Hash password if a new one was provided. `null` → clear the hash.
    let passwordHashUpdate: string | null | undefined;
    if (parsed.body.password === null) {
      passwordHashUpdate = null;
    } else if (parsed.body.password !== undefined) {
      passwordHashUpdate = await Bun.password.hash(parsed.body.password, "bcrypt");
    }

    // Snapshot first — failure must NOT block the update (mirrors workflows.ts).
    try {
      snapshotPage(parsed.params.id, myAgentId);
    } catch {
      // intentional empty
    }

    const updated = updatePage(parsed.params.id, {
      title: parsed.body.title,
      description: parsed.body.description ?? undefined,
      contentType: parsed.body.contentType,
      authMode: parsed.body.authMode,
      passwordHash: passwordHashUpdate,
      body: parsed.body.body,
      needsCredentials: parsed.body.needsCredentials ?? undefined,
    });
    if (!updated) {
      res.writeHead(404);
      res.end();
      return true;
    }
    json(res, { id: updated.id, version: pageEditCounter(updated.id) });
    return true;
  }

  // DELETE /api/pages/:id — page_versions cascade via FK ON DELETE CASCADE.
  if (deletePageRoute.match(req.method, pathSegments)) {
    const parsed = await deletePageRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const ok = deletePage(parsed.params.id);
    if (!ok) {
      res.writeHead(404);
      res.end();
      return true;
    }
    res.writeHead(204);
    res.end();
    return true;
  }

  // CORS preflight for the launch endpoint. The SPA on localhost:5274 sends
  // an OPTIONS preflight before the credentialed POST. Match the same path
  // pattern (`api/pages/<id>/launch`) so we only respond for this one route.
  if (
    req.method === "OPTIONS" &&
    pathSegments.length === 4 &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "pages" &&
    pathSegments[3] === "launch"
  ) {
    applyLaunchCors(req, res);
    res.writeHead(204);
    res.end();
    return true;
  }

  if (launchPageRoute.match(req.method, pathSegments)) {
    const parsed = await launchPageRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const page = getPage(parsed.params.id);
    if (!page) {
      applyLaunchCors(req, res);
      res.writeHead(404);
      res.end();
      return true;
    }

    // Password mode bypasses the bearer-launch path entirely. Otherwise a
    // caller with API_KEY could mint a cookie for a password-protected page
    // without ever knowing the password. step-5 issues the password-mode
    // cookie from the public `/p/:id?key=...` route, where the password is
    // actually verified.
    if (page.authMode === "password") {
      applyLaunchCors(req, res);
      jsonError(res, "use ?key= or Basic auth on /p/:id directly", 400);
      return true;
    }

    // public + authed both mint a cookie here. No per-page ACL in v1: the
    // bearer is the API_KEY, same trust as the rest of the API.
    const cookie = await issuePageSessionCookie(page.id, { dev: isDevRequest(req) });

    applyLaunchCors(req, res);
    res.setHeader("Set-Cookie", cookie);
    res.writeHead(204);
    res.end();
    return true;
  }

  return false;
}

// `snapshotPage` is re-exported so step-3's PUT route handler can call it
// before invoking `updatePage`. Mirrors how src/http/workflows.ts re-uses
// `snapshotWorkflow` from `src/workflows/version.ts`.
export { snapshotPage };
