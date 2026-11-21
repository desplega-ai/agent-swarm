/**
 * Single-use codes that a browser or connector trades once for an `aswt_` token.
 *
 * Two kinds share the `connector_codes` table:
 *
 * - `connector`: the agent-swarm.dev ChatGPT connector. The dashboard asks for
 *   a code (`POST /api/users/:id/connector-codes`) and opens the connector's
 *   connect page with it. The connector trades the code once
 *   (`POST /api/connector/exchange`).
 * - `invite`: a teammate invite (`POST /api/invites`). The teammate's browser
 *   trades it once (`POST /api/invites/exchange`). The exchange also flips the
 *   user from `invited` to `active`, because `aswt_` auth admits only active
 *   users.
 *
 * The token is minted only at exchange time, through the regular `mintToken`
 * path, so an unused code never leaves a token behind. Each exchange redeems
 * only its own kind.
 */

import { createHash, randomBytes } from "node:crypto";
import { assertMayActOnOperatorGrantedTarget, userHoldsOperatorGrantedRole } from "./rbac-roles";
import { getStorage } from "./storage";
import { type IdentityActor, mintToken, recordIdentityEvent } from "./users";

const usersRepo = () => getStorage().repos.users;

export type ConnectorCodeKind = "connector" | "invite";

export const CONNECTOR_CODE_TTL_MS = 10 * 60 * 1000;
export const INVITE_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Expired rows stay this long before the heartbeat sweep deletes them. */
const CONNECTOR_CODE_RETENTION_MS = 60 * 60 * 1000;
export const DEFAULT_CONNECTOR_CODE_LABEL = "ChatGPT connector";
export const DEFAULT_INVITE_CODE_LABEL = "Dashboard invite";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Create a code for `userId`. Returns the plaintext once; only its hash is stored. */
export async function createConnectorCode(
  userId: string,
  label: string,
  actor: IdentityActor,
  now = new Date(),
  opts: { kind?: ConnectorCodeKind; ttlMs?: number } = {},
): Promise<{ code: string; expiresAt: string }> {
  const kind = opts.kind ?? "connector";
  const ttlMs = opts.ttlMs ?? CONNECTOR_CODE_TTL_MS;
  const code = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  // Check and insert under one write lock, so an operator grant cannot land
  // between them (OperatorGrantedTargetError for another user's auditor).
  await getStorage().transaction(async () => {
    await assertMayActOnOperatorGrantedTarget(actor, userId);
    await usersRepo().insertConnectorCode({
      codeHash: sha256Hex(code),
      userId,
      label,
      actorKind: actor.kind,
      actorId: actor.id,
      createdAt: now.toISOString(),
      expiresAt,
      kind,
    });
  });
  return { code, expiresAt };
}

/**
 * Consume a code and mint its token in one transaction. Returns null when the
 * code is unknown, expired, already used, or of another kind (callers must not
 * tell these apart). For an invite code, also returns null when the user is
 * no longer `invited` (suspended or merged since): the code is spent and no
 * token is minted.
 */
export async function exchangeConnectorCode(
  code: string,
  opts: { kind?: ConnectorCodeKind; now?: Date } = {},
): Promise<{ token: string; userId: string } | null> {
  const kind = opts.kind ?? "connector";
  const nowIso = (opts.now ?? new Date()).toISOString();
  return getStorage().transaction(async () => {
    const row = await usersRepo().redeemConnectorCode(sha256Hex(code), kind, nowIso);
    if (!row) return null;
    const actor: IdentityActor = {
      kind: row.actor_kind as IdentityActor["kind"],
      id: row.actor_id,
    };
    // Another user's code must not become a credential for an operator-granted
    // role the target gained after the code was created. The code is spent.
    if (
      actor.kind !== "operator" &&
      actor.id !== row.user_id &&
      (await userHoldsOperatorGrantedRole(row.user_id))
    ) {
      return null;
    }

    if (kind === "invite") {
      const activated = await usersRepo().activateInvitedUser(row.user_id, nowIso);
      if (activated === 0) return null;
      await recordIdentityEvent(
        row.user_id,
        "status_changed",
        actor,
        { status: "invited" },
        { status: "active", source: "invite_exchange" },
      );
    }

    const { plaintext } = await mintToken(row.user_id, row.label, actor, {
      source: kind === "invite" ? "invite_exchange" : "connector_exchange",
    });
    return { token: plaintext, userId: row.user_id };
  });
}

/** Delete a user's unused invite codes, so a re-invite leaves one live link. */
export async function deleteUnusedInviteCodes(userId: string): Promise<number> {
  return usersRepo().deleteUnusedInviteCodes(userId);
}

/** Delete codes that expired more than 1h ago. Returns the number of deleted rows. */
export async function deleteExpiredConnectorCodes(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - CONNECTOR_CODE_RETENTION_MS).toISOString();
  return usersRepo().deleteConnectorCodesExpiredBefore(cutoff);
}
