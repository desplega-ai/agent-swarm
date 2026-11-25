import { type RunScriptInput, type RunScriptOutput, runScript } from "../../scripts-runtime/loader";
import type { ScriptRunProvenance } from "../../utils/request-auth-context";
import { getAgentById } from "../db";
import { getStorage } from "../storage";
import {
  findUserById,
  mintBrokerSessionToken,
  mintOperatorScriptRunToken,
  mintScriptRunToken,
  mintUserScriptRunToken,
  revokeSessionToken,
  revokeUserScriptRunToken,
} from "../users";

/**
 * Backstop lifetime of a script run's api credential. The run revokes its
 * token the moment it ends (see `runScriptWithRunCredential`); this bounds a
 * token whose run died without releasing. Comfortably above the 5m maximum
 * script wall clock.
 */
const SCRIPT_RUN_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * Lifetime of a user MCP run's token. `SCRIPT_RUN_USER_TOKEN_TTL_MS` is a test
 * seam (the e2e suite sets it so a run can watch its own token expire); it can
 * only shorten the backstop, never extend it.
 */
function userScriptRunTokenTtlMs(): number {
  const override = Number(process.env.SCRIPT_RUN_USER_TOKEN_TTL_MS);
  return override > 0 && override < SCRIPT_RUN_TOKEN_TTL_MS ? override : SCRIPT_RUN_TOKEN_TTL_MS;
}

export type ScriptExecutionPrincipal =
  | { kind: "operator" }
  | { kind: "agent"; agentId: string; parentTokenId?: string }
  | { kind: "user"; userId: string };

export type ScriptApiCredential = {
  /** Bearer for authenticated SDK calls. */
  apiKey: string;
  /** Revoke the per-run token, if one was minted. Safe to call more than once. */
  release: () => Promise<void>;
};

/** Mint a credential for a registered agent or an explicit server-owned principal. */
export async function acquireScriptApiCredential(
  agentId: string,
  provenance: ScriptRunProvenance = {},
  authority?: ScriptExecutionPrincipal,
  ttlMs = SCRIPT_RUN_TOKEN_TTL_MS,
): Promise<ScriptApiCredential> {
  if (authority?.kind === "user") {
    const user = await findUserById(authority.userId);
    if (!user || user.status !== "active" || user.mergedIntoUserId)
      throw new Error("Script executing user is inactive");
    const token = await mintUserScriptRunToken(authority.userId, ttlMs, provenance);
    return { apiKey: token.plaintext, release: () => revokeUserScriptRunToken(token.tokenId) };
  }
  if (authority?.kind === "agent" && authority.agentId !== agentId) {
    throw new Error("Script agent does not match its execution principal");
  }
  if (authority?.kind !== "operator" && !(await getAgentById(agentId))) {
    throw new Error("Script executing agent does not exist");
  }
  const token =
    authority?.kind === "operator"
      ? await mintOperatorScriptRunToken(agentId, ttlMs, provenance)
      : authority?.kind === "agent" && authority.parentTokenId
        ? await mintBrokerSessionToken(agentId, authority.parentTokenId, ttlMs, provenance)
        : await mintScriptRunToken(agentId, ttlMs, provenance);
  let released = false;
  return {
    apiKey: token.plaintext,
    release: async () => {
      if (released) return;
      await revokeSessionToken(token.tokenId);
      released = true;
    },
  };
}

/** `ctx.db.dialect` of a run: the active storage engine's `db_query` dialect. */
function scriptDbDialect(): RunScriptInput["dbDialect"] {
  return getStorage().capabilities.dbQueryDialect;
}

/**
 * Run a script with a per-run credential bound to its executing agent, and
 * revoke that credential when the run ends: on success, a thrown error, a
 * timeout or an abort. Every api-side script-run caller goes through here.
 * The mint and revoke stay on the api side because `src/scripts-runtime/` is
 * a no-DB zone (`scripts/check-db-boundary.sh`); `runScript` only receives the
 * bearer.
 */
export async function runScriptWithRunCredential(
  input: Omit<RunScriptInput, "apiKey" | "dbDialect">,
  provenance: ScriptRunProvenance = {},
  authority?: ScriptExecutionPrincipal,
): Promise<RunScriptOutput> {
  if (authority?.kind === "user")
    return runScriptAsUserWithRunCredential(input, authority.userId, provenance);
  const credential = await acquireScriptApiCredential(input.agentId, provenance, authority);
  try {
    return await runScript({ ...input, apiKey: credential.apiKey, dbDialect: scriptDbDialect() });
  } finally {
    await credential.release();
  }
}

/**
 * Run a script for a user, with no executing agent: its `ctx.swarm` calls
 * present a short-lived token bound to `userId`, so the api applies that
 * user's permissions, and the run gets no agent's credentials, connections or
 * deployment egress secrets. The token is revoked when the run ends.
 */
export async function runScriptAsUserWithRunCredential(
  input: Omit<
    RunScriptInput,
    | "apiKey"
    | "dbDialect"
    | "agentId"
    | "egressSecrets"
    | "failedBindings"
    | "userConfig"
    | "apiConnections"
    | "mcpConnections"
    | "agentFs"
  >,
  userId: string,
  provenance?: ScriptRunProvenance,
): Promise<RunScriptOutput> {
  const credential = await acquireScriptApiCredential(
    "",
    provenance,
    { kind: "user", userId },
    userScriptRunTokenTtlMs(),
  );
  try {
    return await runScript({
      ...input,
      apiKey: credential.apiKey,
      dbDialect: scriptDbDialect(),
      // Empty: the SDK then sends no X-Agent-ID, which the api refuses on a user token.
      agentId: "",
      // Explicit empties: omitted, the loader falls back to deployment-wide bindings.
      egressSecrets: [],
      failedBindings: [],
      userConfig: {},
      apiConnections: [],
      mcpConnections: [],
      agentFs: undefined,
    });
  } finally {
    await credential.release();
  }
}
