/**
 * Single-use connect codes for the agent-swarm.dev ChatGPT connector.
 *
 * The dashboard asks for a code (`POST /api/users/:id/connector-codes`) and
 * opens the connector's connect page with it. The connector trades the code
 * once (`POST /api/connector/exchange`) for a user-bound `aswt_` token. The
 * token is minted only at exchange time, through the regular `mintToken`
 * path, so an unused code never leaves a token behind.
 */

import { createHash, randomBytes } from "node:crypto";
import { getDbClient } from "./db";
import { type IdentityActor, mintToken } from "./users";

export const CONNECTOR_CODE_TTL_MS = 10 * 60 * 1000;
/** Expired rows stay this long before the heartbeat sweep deletes them. */
const CONNECTOR_CODE_RETENTION_MS = 60 * 60 * 1000;
export const DEFAULT_CONNECTOR_CODE_LABEL = "ChatGPT connector";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Create a code for `userId`. Returns the plaintext once; only its hash is stored. */
export async function createConnectorCode(
  userId: string,
  label: string,
  actor: IdentityActor,
  now = new Date(),
): Promise<{ code: string; expiresAt: string }> {
  const code = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + CONNECTOR_CODE_TTL_MS).toISOString();
  await getDbClient().run(
    `INSERT INTO connector_codes
       (code_hash, user_id, label, actor_kind, actor_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [sha256Hex(code), userId, label, actor.kind, actor.id, now.toISOString(), expiresAt],
  );
  return { code, expiresAt };
}

/**
 * Consume a code and mint its token in one transaction. Returns null when the
 * code is unknown, expired, or already used (callers must not tell these apart).
 */
export async function exchangeConnectorCode(
  code: string,
  now = new Date(),
): Promise<{ token: string; userId: string } | null> {
  const nowIso = now.toISOString();
  return getDbClient().transaction(async (tx) => {
    const row = await tx.get<{
      user_id: string;
      label: string;
      actor_kind: IdentityActor["kind"];
      actor_id: string;
    }>(
      `UPDATE connector_codes SET used_at = ?
        WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
        RETURNING user_id, label, actor_kind, actor_id`,
      [nowIso, sha256Hex(code), nowIso],
    );
    if (!row) return null;
    const { plaintext } = await mintToken(row.user_id, row.label, {
      kind: row.actor_kind,
      id: row.actor_id,
    });
    return { token: plaintext, userId: row.user_id };
  });
}

/** Delete codes that expired more than 1h ago. Returns the number of deleted rows. */
export async function deleteExpiredConnectorCodes(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - CONNECTOR_CODE_RETENTION_MS).toISOString();
  const result = await getDbClient().run("DELETE FROM connector_codes WHERE expires_at < ?", [
    cutoff,
  ]);
  return result.changes;
}
