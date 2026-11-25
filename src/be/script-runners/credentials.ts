import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  registerVolatileSecret,
  scrubSecrets,
  unregisterVolatileSecret,
} from "../../utils/secret-scrubber";
import { getStorage } from "../storage";

export async function mintScriptRunnerCredential(
  name: string,
  expiresAt: string,
  actor: string | null,
) {
  const storage = getStorage();
  if (!storage.capabilities.scriptRunners) throw new Error("script_runners_need_postgres");
  const token = `assr_${randomBytes(32).toString("hex")}`;
  const now = new Date().toISOString();
  const credential = {
    id: randomUUID(),
    name: scrubSecrets(name),
    expiresAt: new Date(expiresAt).toISOString(),
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
    createdBy: actor,
    updatedBy: actor,
  };
  return storage.transaction(async () => {
    await storage.repos.scriptRunners.insert(
      credential,
      createHash("sha256").update(token).digest("hex"),
    );
    storage.afterCommit(() => registerVolatileSecret(token, `script-runner:${credential.id}`));
    return { credential, token };
  });
}

/** Only the future runner link may use this credential lookup. */
export async function authenticateScriptRunnerCredential(token: string) {
  const storage = getStorage();
  if (!storage.capabilities.scriptRunners || !/^assr_[a-f0-9]{64}$/.test(token)) return null;
  return storage.repos.scriptRunners.findActiveByHash(
    createHash("sha256").update(token).digest("hex"),
    new Date().toISOString(),
  );
}

export async function revokeScriptRunnerCredential(id: string, actor: string | null) {
  const storage = getStorage();
  return storage.transaction(async () => {
    const found = await storage.repos.scriptRunners.revoke(id, new Date().toISOString(), actor);
    if (found) storage.afterCommit(() => unregisterVolatileSecret(`script-runner:${id}`));
    return found;
  });
}
