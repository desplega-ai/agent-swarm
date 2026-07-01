import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { acquireOAuthRefreshLock, releaseOAuthRefreshLock } from "../be/db-queries/oauth";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

/**
 * HTTP surface for the cross-process OAuth refresh-token lock
 * (`oauth_refresh_locks`, migration 077). The tracker-OAuth path
 * (`src/oauth/ensure-token.ts`) reaches this table directly since it already
 * runs on the API/DB-owner side. Worker-side code (e.g. the Codex pool
 * refresh in `src/providers/codex-oauth/storage.ts`) can't import `be/db`,
 * so it serializes its refreshes through these endpoints instead.
 *
 * Lock keys are caller-defined strings scoped by the caller — e.g. the Codex
 * pool uses `codex_oauth_<slot>`, distinct from tracker provider names like
 * `linear`/`jira`/`github` that already live in this table.
 */

const MAX_LOCK_TTL_MS = 5 * 60 * 1000;
const LOCK_KEY_PATTERN = /^[a-zA-Z0-9._:-]{1,200}$/;

const LockKeySchema = z.object({ key: z.string().regex(LOCK_KEY_PATTERN) });

const acquireBodySchema = z.object({
  ttlMs: z.number().int().positive().max(MAX_LOCK_TTL_MS),
});

const releaseBodySchema = z.object({
  owner: z.string().min(1),
});

const acquireLockRoute = route({
  method: "post",
  path: "/api/oauth/refresh-locks/{key}",
  pattern: ["api", "oauth", "refresh-locks", null],
  summary: "Acquire a cross-process OAuth refresh lock",
  tags: ["OAuth"],
  params: LockKeySchema,
  body: acquireBodySchema,
  responses: {
    200: { description: "Lock acquired; returns the owner token" },
    409: { description: "Lock is currently held by another caller" },
    400: { description: "Validation error" },
  },
});

const releaseLockRoute = route({
  method: "delete",
  path: "/api/oauth/refresh-locks/{key}",
  pattern: ["api", "oauth", "refresh-locks", null],
  summary: "Release a cross-process OAuth refresh lock if still held by the given owner",
  tags: ["OAuth"],
  params: LockKeySchema,
  body: releaseBodySchema,
  responses: {
    204: { description: "Released (a mismatched/expired owner is a no-op, also 204)" },
    400: { description: "Validation error" },
  },
});

export async function handleOAuthLocks(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (acquireLockRoute.match(req.method, pathSegments)) {
    const parsed = await acquireLockRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const owner = acquireOAuthRefreshLock(parsed.params.key, parsed.body.ttlMs);
    if (!owner) {
      jsonError(res, "lock is held by another caller", 409);
      return true;
    }
    json(res, { owner });
    return true;
  }

  if (releaseLockRoute.match(req.method, pathSegments)) {
    const parsed = await releaseLockRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    releaseOAuthRefreshLock(parsed.params.key, parsed.body.owner);
    res.writeHead(204);
    res.end();
    return true;
  }

  return false;
}
