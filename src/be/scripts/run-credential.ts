import { type RunScriptInput, type RunScriptOutput, runScript } from "../../scripts-runtime/loader";
import { getAgentById } from "../db";
import {
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

export type ScriptApiCredential = {
  /**
   * The bearer the script's `ctx.swarm` SDK calls present to the api, or
   * `undefined` to let `runScript` fall back to the swarm API key.
   */
  apiKey: string | undefined;
  /** Revoke the per-run token, if one was minted. Safe to call more than once. */
  release: () => Promise<void>;
};

/**
 * Where a script run came from, bound to its token so the rows it creates can
 * be traced back (`sourceStepId`, `parentScriptRunId`). `sourceStepId` is the
 * swarm-script workflow step that started the run, inherited by nested runs;
 * `sourceScriptRunId` is the run's own `script_runs` id.
 */
export type ScriptRunProvenance = { sourceStepId?: string; sourceScriptRunId?: string };

/**
 * Resolve the api credential a script run acts as. When the run has a real
 * executing agent, mint a short-lived token bound to it so `ctx.swarm` calls
 * are scoped to that agent at the api, instead of carrying the swarm API key
 * (the operator). System runs with no real agent (scheduler and workflow runs
 * pass sentinel ids like "schedule"/"workflow") keep the operator key, their
 * existing behavior. The caller must `release()` when the run ends.
 */
export async function acquireScriptApiCredential(
  agentId: string,
  provenance: ScriptRunProvenance = {},
): Promise<ScriptApiCredential> {
  if (!(await getAgentById(agentId))) {
    return { apiKey: undefined, release: async () => {} };
  }
  const token = await mintScriptRunToken(agentId, SCRIPT_RUN_TOKEN_TTL_MS, provenance);
  let released = false;
  return {
    apiKey: token.plaintext,
    release: async () => {
      if (released) return;
      released = true;
      await revokeSessionToken(token.tokenId);
    },
  };
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
  input: Omit<RunScriptInput, "apiKey">,
  provenance: ScriptRunProvenance = {},
): Promise<RunScriptOutput> {
  const credential = await acquireScriptApiCredential(input.agentId, provenance);
  try {
    return await runScript({ ...input, apiKey: credential.apiKey });
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
    | "agentId"
    | "egressSecrets"
    | "failedBindings"
    | "userConfig"
    | "apiConnections"
    | "mcpConnections"
    | "agentFs"
  >,
  userId: string,
): Promise<RunScriptOutput> {
  const token = await mintUserScriptRunToken(userId, userScriptRunTokenTtlMs());
  try {
    return await runScript({
      ...input,
      apiKey: token.plaintext,
      // Empty: the SDK then sends no X-Agent-ID, which the api refuses on a user token.
      agentId: "",
      // Explicit empties: omitted, the loader falls back to deployment-wide bindings.
      egressSecrets: [],
      failedBindings: [],
      userConfig: {},
      apiConnections: [],
      mcpConnections: [],
    });
  } finally {
    await revokeUserScriptRunToken(token.tokenId);
  }
}
