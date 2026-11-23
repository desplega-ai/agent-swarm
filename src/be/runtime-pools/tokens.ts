import { registerVolatileSecret, unregisterVolatileSecret } from "../../utils/secret-scrubber";
import { closeSessionTokenConnections } from "../../utils/session-token-connections";
import { getStorage } from "../storage";
import { validateControllerTokenTtlDays } from "../swarm-config-guard";
import { insertSessionToken } from "../users";
import { RuntimePoolError } from "./errors";

export async function mintControllerToken(
  controllerId: string,
): Promise<{ tokenId: string; plaintext: string; expiresAt: string }> {
  const storage = getStorage();
  const repo = storage.repos.runtimePools;
  return await storage.transaction(async () => {
    const controller = await repo.findController(controllerId);
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
    const expiresAt = await repo.getSessionTokenExpiry(credential.tokenId);
    storage.afterCommit(() =>
      registerVolatileSecret(credential.plaintext, `controller-token:${credential.tokenId}`),
    );
    return { ...credential, expiresAt: expiresAt! };
  });
}

export async function revokeControllerTokens(controllerId: string): Promise<void> {
  const storage = getStorage();
  const repo = storage.repos.runtimePools;
  await storage.transaction(async () => {
    const ids = await repo.listActiveControllerTokenIds(controllerId);
    await repo.revokeControllerTokens(controllerId, new Date().toISOString());
    storage.afterCommit(() => {
      closeSessionTokenConnections(ids);
      for (const id of ids) unregisterVolatileSecret(`controller-token:${id}`);
    });
  });
}
