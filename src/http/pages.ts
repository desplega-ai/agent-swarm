import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { createPage, getPage } from "../be/db";
import { snapshotPage } from "../pages/version";
import { PageAuthModeSchema, PageContentTypeSchema } from "../types";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

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
    authMode: PageAuthModeSchema,
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

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handlePages(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (createPageRoute.match(req.method, pathSegments)) {
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
      // IS v1). step-3 will add snapshot-on-update via the PUT route.
      json(res, { id: page.id, version: 1 }, 201);
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

  if (getPageRoute.match(req.method, pathSegments)) {
    const parsed = await getPageRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const page = getPage(parsed.params.id);
    if (!page) {
      res.writeHead(404);
      res.end();
      return true;
    }
    json(res, page);
    return true;
  }

  return false;
}

// `snapshotPage` is re-exported so step-3's PUT route handler can call it
// before invoking `updatePage`. Mirrors how src/http/workflows.ts re-uses
// `snapshotWorkflow` from `src/workflows/version.ts`.
export { snapshotPage };
