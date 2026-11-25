import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  registerVolatileSecret,
  scrubSecrets,
  unregisterVolatileSecret,
} from "../../utils/secret-scrubber";
import { closeSessionTokenConnections } from "../../utils/session-token-connections";
import { userHoldsExplicitVerb } from "../rbac-roles";
import { getStorage } from "../storage";
import { findUserById } from "../users";

export const MAX_RUNNER_CREDENTIAL_TTL_MS = 90 * 86_400_000;

async function issuerIsActive(userId: string) {
  const user = await findUserById(userId);
  return (
    !!user &&
    user.status === "active" &&
    !user.mergedIntoUserId &&
    (await userHoldsExplicitVerb(userId, "script_runner.write"))
  );
}

export async function mintScriptRunnerCredential(
  name: string,
  expiresAt: string | undefined,
  actor: string | null,
) {
  const storage = getStorage();
  if (!storage.capabilities.scriptRunners) throw new Error("script_runners_need_postgres");
  const token = `assr_${randomBytes(32).toString("hex")}`;
  const issuedAt = Date.now();
  const deadline =
    expiresAt === undefined ? issuedAt + MAX_RUNNER_CREDENTIAL_TTL_MS : Date.parse(expiresAt);
  if (!(deadline > issuedAt && deadline <= issuedAt + MAX_RUNNER_CREDENTIAL_TTL_MS))
    throw new Error("Invalid runner credential expiry");
  const now = new Date(issuedAt).toISOString();
  const credential = {
    id: randomUUID(),
    name: scrubSecrets(name),
    expiresAt: new Date(deadline).toISOString(),
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
    createdBy: actor,
    updatedBy: actor,
  };
  return storage.transaction(async () => {
    if (actor && !(await issuerIsActive(actor)))
      throw new Error("Runner credential issuer is inactive");
    await storage.repos.scriptRunners.insert(
      credential,
      createHash("sha256").update(token).digest("hex"),
    );
    storage.afterCommit(() => registerVolatileSecret(token, `script-runner:${credential.id}`));
    return { credential, token };
  });
}

/** Only the runner link may use this credential lookup. */
export function scriptRunnerCredentialHash(token: string) {
  return /^assr_[a-f0-9]{64}$/.test(token)
    ? createHash("sha256").update(token).digest("hex")
    : null;
}

/** Recheck the issuing user's grant when the API validates a connected runner. */
export async function activeScriptRunnerCredential(hash: string) {
  const credential = await getStorage().repos.scriptRunners.findActiveByHash(
    hash,
    new Date().toISOString(),
  );
  if (credential?.createdBy && !(await issuerIsActive(credential.createdBy))) return null;
  return credential;
}

export async function revokeScriptRunnerCredential(id: string, actor: string | null) {
  const storage = getStorage();
  return storage.transaction(async () => {
    const found = await storage.repos.scriptRunners.revoke(id, new Date().toISOString(), actor);
    if (found)
      storage.afterCommit(() => {
        unregisterVolatileSecret(`script-runner:${id}`);
        closeSessionTokenConnections([`script-runner:${id}`]);
      });
    return found;
  });
}
