import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { listTaskTemplates } from "../be/db";
import { TaskTemplateKindSchema } from "../types";
import { route } from "./route-def";
import { json } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const listTemplates = route({
  method: "get",
  path: "/api/task-templates",
  pattern: ["api", "task-templates"],
  summary: "List task templates ('To start' bucket)",
  tags: ["Task Templates"],
  query: z.object({
    category: z.string().optional(),
    /** v2 hook — v1 callers always pass `kind=task` (or omit). */
    kind: TaskTemplateKindSchema.optional(),
    /** Case-insensitive LIKE match against `title` OR `description`. */
    query: z.string().optional(),
  }),
  responses: {
    200: { description: "Task template list" },
    401: { description: "Unauthorized" },
  },
  auth: { apiKey: true },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleTaskTemplates(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (listTemplates.match(req.method, pathSegments)) {
    const parsed = await listTemplates.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const templates = listTaskTemplates({
      category: parsed.query.category,
      kind: parsed.query.kind,
      query: parsed.query.query,
    });
    json(res, { templates });
    return true;
  }

  return false;
}
