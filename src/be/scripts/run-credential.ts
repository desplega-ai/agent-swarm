import { type RunScriptInput, type RunScriptOutput, runScript } from "../../scripts-runtime/loader";
import { getAgentById } from "../db";
import { mintScriptRunToken, revokeSessionToken } from "../users";

/**
 * Backstop lifetime of a script run's api credential. The run revokes its
 * token the moment it ends (see `runScriptWithRunCredential`); this bounds a
 * token whose run died without releasing. Comfortably above the 5m maximum
 * script wall clock.
 */
const SCRIPT_RUN_TOKEN_TTL_MS = 15 * 60 * 1000;

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
 * Resolve the api credential a script run acts as. When the run has a real
 * executing agent, mint a short-lived token bound to it so `ctx.swarm` calls
 * are scoped to that agent at the api, instead of carrying the swarm API key
 * (the operator). System runs with no real agent (scheduler and workflow runs
 * pass sentinel ids like "schedule"/"workflow") keep the operator key, their
 * existing behavior. The caller must `release()` when the run ends.
 */
export async function acquireScriptApiCredential(agentId: string): Promise<ScriptApiCredential> {
  if (!(await getAgentById(agentId))) {
    return { apiKey: undefined, release: async () => {} };
  }
  const token = await mintScriptRunToken(agentId, SCRIPT_RUN_TOKEN_TTL_MS);
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
): Promise<RunScriptOutput> {
  const credential = await acquireScriptApiCredential(input.agentId);
  try {
    return await runScript({ ...input, apiKey: credential.apiKey });
  } finally {
    await credential.release();
  }
}
