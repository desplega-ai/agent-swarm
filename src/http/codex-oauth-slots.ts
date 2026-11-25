/**
 * Worker write path for a Codex OAuth pool slot's refreshed credentials.
 *
 * `getValidCodexOAuth` (src/providers/codex-oauth/storage.ts) refreshes a slot
 * inside its `/api/oauth/refresh-locks` lock and must persist the rotated
 * tokens before it releases the lock, or the next caller replays a consumed
 * refresh token. Workers call it with their own agent key, and
 * `PUT /api/config` gates agent principals to the lead, so the persist failed
 * with a 403 and every Codex task exited 1 (issue #3590).
 *
 * These routes let a registered agent write or quarantine exactly one key,
 * `codex_oauth_<slot>`, and only while it holds that slot's refresh lock. They
 * do not widen config writes for agents in general.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { deleteSwarmConfigByKey, upsertSwarmConfig } from "../be/db";
import { isOAuthRefreshLockHeld } from "../be/db-queries/oauth";
import { getStorage } from "../be/storage";
import { codexOAuthKeyForSlot, MAX_CODEX_OAUTH_SLOT } from "../providers/codex-oauth/storage";
import { getRequestAuth } from "../utils/request-auth-context";
import { registerVolatileSecret } from "../utils/secret-scrubber";
import { runConfigWriteSideEffects } from "./config";
import { requestPrincipal } from "./request-principal";
import { route } from "./route-def";
import { jsonError } from "./utils";

const SLOT_WRITE_POSTURE =
  "registered agents and the operator key may write only codex_oauth_<slot>, and only while holding that slot's refresh lock; the handler enforces both";

const slotParams = z.object({
  slot: z.coerce.number().int().min(0).max(MAX_CODEX_OAUTH_SLOT),
});

const lockOwner = z
  .string()
  .min(1)
  .describe("Owner token returned by POST /api/oauth/refresh-locks/codex_oauth_<slot>");

const slotResultSchema = z.object({ slot: z.number(), key: z.string() });

const storeSlotRoute = route({
  method: "put",
  path: "/api/codex-oauth/slots/{slot}/credentials",
  pattern: ["api", "codex-oauth", "slots", null, "credentials"],
  summary: "Persist refreshed Codex OAuth credentials for a pool slot",
  description:
    "Writes the global secret codex_oauth_<slot>. The caller must hold the slot's refresh lock (lockOwner). Open to registered agents so a worker can persist the tokens it just rotated; no other config key is writable here.",
  tags: ["Codex OAuth"],
  params: slotParams,
  body: z.object({
    lockOwner,
    credentials: z.object({
      access: z.string().min(1),
      refresh: z.string().min(1),
      expires: z.number().finite(),
      accountId: z.string(),
    }),
  }),
  responses: {
    200: { description: "Credentials stored", schema: slotResultSchema },
    403: { description: "Caller is not the operator or a registered agent" },
    409: { description: "Caller does not hold the slot's refresh lock" },
  },
  rbac: { ungated: SLOT_WRITE_POSTURE },
});

const quarantineSlotRoute = route({
  method: "delete",
  path: "/api/codex-oauth/slots/{slot}/credentials",
  pattern: ["api", "codex-oauth", "slots", null, "credentials"],
  summary: "Quarantine a Codex OAuth pool slot after a failed persist",
  description:
    "Deletes the global secret codex_oauth_<slot> so no caller replays a consumed refresh token. The caller must hold the slot's refresh lock (lockOwner).",
  tags: ["Codex OAuth"],
  params: slotParams,
  body: z.object({ lockOwner }),
  responses: {
    200: {
      description: "Slot quarantined (deleted is false when no row existed)",
      schema: slotResultSchema.extend({ deleted: z.boolean() }),
    },
    403: { description: "Caller is not the operator or a registered agent" },
    409: { description: "Caller does not hold the slot's refresh lock" },
  },
  rbac: { ungated: SLOT_WRITE_POSTURE },
});

/**
 * The operator key, or a registered agent on its own runtime or agent token.
 * Task tokens (ACP harness credentials) cannot read the slot, so they never
 * refresh it, and a page session runs agent-authored page code: both are
 * refused, as are users, who keep `PUT /api/config`.
 */
async function ensureSlotWriter(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const auth = getRequestAuth(req);
  const refuse = () => {
    jsonError(res, "Storing Codex OAuth credentials requires a registered agent", 403);
    return false;
  };
  if (auth?.page) return refuse();
  if (auth?.kind === "agent" && auth.tokenKind === "task") return refuse();
  const rawAgentId = req.headers["x-agent-id"];
  const principal = await requestPrincipal(
    req,
    Array.isArray(rawAgentId) ? rawAgentId[0] : rawAgentId,
    { requireRegisteredAgent: true },
  );
  if (principal?.kind === "operator") return true;
  if (principal?.kind === "agent" && principal.agentId) return true;
  return refuse();
}

const LOCK_NOT_HELD =
  "The refresh lock for this slot is not held by lockOwner (expired or taken by another caller)";

export async function handleCodexOAuthSlots(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (storeSlotRoute.match(req.method, pathSegments)) {
    const parsed = await storeSlotRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await ensureSlotWriter(req, res))) return true;
    const { slot } = parsed.params;
    const key = codexOAuthKeyForSlot(slot);
    const { credentials } = parsed.body;
    registerVolatileSecret(credentials.access, `config:${key}`);
    registerVolatileSecret(credentials.refresh, `config:${key}`);
    const value = JSON.stringify(credentials);
    // Check the lock and write in one transaction, so the lock cannot change
    // hands between the check and the write.
    const stored = await getStorage().transaction(async () => {
      if (!(await isOAuthRefreshLockHeld(key, parsed.body.lockOwner))) return false;
      await upsertSwarmConfig({
        scope: "global",
        key,
        value,
        isSecret: true,
        description: `Codex ChatGPT OAuth credentials slot ${slot} (refreshed by a worker)`,
      });
      return true;
    });
    if (!stored) {
      jsonError(res, LOCK_NOT_HELD, 409);
      return true;
    }
    await runConfigWriteSideEffects("global", key, value);
    storeSlotRoute.respond(res, 200, { slot, key });
    return true;
  }

  if (quarantineSlotRoute.match(req.method, pathSegments)) {
    const parsed = await quarantineSlotRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await ensureSlotWriter(req, res))) return true;
    const { slot } = parsed.params;
    const key = codexOAuthKeyForSlot(slot);
    const deleted = await getStorage().transaction(async () => {
      if (!(await isOAuthRefreshLockHeld(key, parsed.body.lockOwner))) return null;
      return deleteSwarmConfigByKey("global", null, key);
    });
    if (deleted === null) {
      jsonError(res, LOCK_NOT_HELD, 409);
      return true;
    }
    if (deleted) await runConfigWriteSideEffects("global", key, "");
    quarantineSlotRoute.respond(res, 200, { slot, key, deleted });
    return true;
  }

  return false;
}
