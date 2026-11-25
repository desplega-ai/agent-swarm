import { createHash } from "node:crypto";

export function scriptRunnerOwnerId(credentialId: string, instanceId: string): string {
  return createHash("sha256").update(`${credentialId}:${instanceId}`).digest("hex");
}
