import { registerVolatileSecret, unregisterVolatileSecret } from "../../utils/secret-scrubber";
import { closeSessionTokenConnections } from "../../utils/session-token-connections";
import { getDbClient } from "../db";
import { validateControllerTokenTtlDays } from "../swarm-config-guard";
import { insertSessionToken } from "../users";
import { RuntimePoolError } from "./errors";

export async function mintControllerToken(
  controllerId: string,
): Promise<{ tokenId: string; plaintext: string; expiresAt: string }> {
  return await getDbClient().transaction(async (client) => {
    const controller = await client.get<{ placement: string }>(
      "SELECT placement FROM runtime_controllers WHERE id = ?",
      [controllerId],
    );
    if (!controller) throw new RuntimePoolError("Controller not found", 404);
    if (controller.placement !== "remote")
      throw new RuntimePoolError("Only remote controllers can receive a controller token");
    await revokeControllerTokens(controllerId);
    const configured = process.env.RUNTIME_CONTROLLER_TOKEN_TTL_DAYS;
    const ttlDays = validateControllerTokenTtlDays(configured) === null ? Number(configured) : 90;
    const credential = await insertSessionToken(
      controllerId,
      null,
      null,
      ttlDays * 86_400_000,
      null,
      undefined,
      controllerId,
    );
    const row = await client.get<{ expiresAt: string }>(
      "SELECT expiresAt FROM session_tokens WHERE id = ?",
      [credential.tokenId],
    );
    getDbClient().afterCommit(() =>
      registerVolatileSecret(credential.plaintext, `controller-token:${credential.tokenId}`),
    );
    return { ...credential, expiresAt: row!.expiresAt };
  });
}

export async function revokeControllerTokens(controllerId: string): Promise<void> {
  await getDbClient().transaction(async (client) => {
    const rows = await client.query<{ id: string }>(
      "SELECT id FROM session_tokens WHERE controllerId = ? AND revokedAt IS NULL",
      [controllerId],
    );
    await client.run(
      "UPDATE session_tokens SET revokedAt = ? WHERE controllerId = ? AND revokedAt IS NULL",
      [new Date().toISOString(), controllerId],
    );
    getDbClient().afterCommit(() => {
      closeSessionTokenConnections(rows.map((row) => row.id));
      for (const row of rows) unregisterVolatileSecret(`controller-token:${row.id}`);
    });
  });
}
