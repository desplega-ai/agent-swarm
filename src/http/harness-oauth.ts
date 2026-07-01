import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { ensureHarnessOAuth } from "../oauth/harness-refresh";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

const refreshHarnessOAuthRoute = route({
  method: "post",
  path: "/api/harness/oauth/refresh",
  pattern: ["api", "harness", "oauth", "refresh"],
  summary: "Return a current harness OAuth credential after API-side refresh locking",
  tags: ["Harness"],
  body: z.object({
    provider: z.literal("codex"),
    slot: z.number().int().min(0).optional(),
    bufferMs: z.number().int().min(0).optional(),
  }),
  responses: {
    200: { description: "Current harness OAuth credential" },
    400: { description: "Validation error" },
    500: { description: "Refresh failed" },
  },
});

export async function handleHarnessOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (!refreshHarnessOAuthRoute.match(req.method, pathSegments)) return false;

  const parsed = await refreshHarnessOAuthRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;

  try {
    const credentials = await ensureHarnessOAuth(parsed.body.provider, {
      slot: parsed.body.slot,
      bufferMs: parsed.body.bufferMs,
    });
    json(res, { credentials });
  } catch (err) {
    jsonError(res, err instanceof Error ? err.message : String(err), 500);
  }
  return true;
}
