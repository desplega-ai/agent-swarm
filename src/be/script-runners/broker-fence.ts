import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { getStorage } from "../storage";

const fences = new Map<string, { runId: string; ownerId: string }>();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function registerDurableBrokerFence(bearer: string, runId: string, ownerId: string) {
  const key = hash(bearer);
  fences.set(key, { runId, ownerId });
  return () => fences.delete(key);
}
/** Call inside the mutation transaction. The no-op update locks the owner row until commit. */
export async function assertDurableBrokerFence(req: IncomingMessage) {
  const bearer = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
  const fence = bearer ? fences.get(hash(bearer)) : undefined;
  if (!fence) {
    if (req.headers["x-script-owner"]) throw new Error("Durable broker fence is no longer active");
    return;
  }
  if (
    !(await getStorage().repos.scripts.guardScriptRunOwner(
      fence.runId,
      fence.ownerId,
      new Date().toISOString(),
    ))
  )
    throw new Error("Durable execution ownership expired");
}
