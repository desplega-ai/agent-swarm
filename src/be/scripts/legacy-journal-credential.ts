import { createHash, randomBytes } from "node:crypto";
import type { HttpRequestAuth } from "../../utils/request-auth-context";

export const LEGACY_JOURNAL_TOKEN_PREFIX = "aseph_journal";
type Grant = { runId: string; agentId: string; expiresAt: string };
const grants = new Map<string, Grant>();

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Older durable rows name the owning agent and journal, but omit the launching credential. */
export function acquireLegacyJournalCredential(runId: string, agentId: string, ttlMs: number) {
  const apiKey = LEGACY_JOURNAL_TOKEN_PREFIX + randomBytes(24).toString("hex");
  const id = digest(apiKey);
  grants.set(id, { runId, agentId, expiresAt: new Date(Date.now() + ttlMs).toISOString() });
  return {
    apiKey,
    release: async () => {
      grants.delete(id);
    },
  };
}

export function resolveLegacyJournalCredential(
  token: string,
  method: string | undefined,
  segments: string[],
): HttpRequestAuth | null {
  const id = digest(token);
  const grant = grants.get(id);
  if (!grant) return null;
  if (Date.parse(grant.expiresAt) <= Date.now()) {
    grants.delete(id);
    return null;
  }
  const [api, internal, resource, runId, operation] = segments;
  if (
    api !== "api" ||
    internal !== "internal" ||
    resource !== "script-runs" ||
    runId !== grant.runId
  )
    return null;
  const allowed =
    method === "POST"
      ? segments.length === 5 && ["steps", "heartbeat", "status"].includes(operation ?? "")
      : method === "GET" && segments.length === 6 && operation === "steps";
  if (!allowed) return null;
  return {
    kind: "agent",
    agentId: grant.agentId,
    tokenKind: "agent",
    tokenId: id,
    taskId: null,
    runtimeId: null,
    expiresAt: grant.expiresAt,
    sourceScriptRunId: grant.runId,
  };
}
