import { runScript } from "../../scripts-runtime/loader";
import {
  getScriptApiConnectionDescriptors,
  getScriptMcpConnectionDescriptors,
} from "../script-connections";
import { buildScriptCredentialBindings } from "../script-credential-broker";
import { getScript } from "./db";

/**
 * Run a global catalog script server-side with the standard credential/
 * connection wiring. Shared by the subscription dispatcher and script-backed
 * tools (the scheduler has its own older copy of this pattern).
 * Throws on non-zero exit / runtime error.
 */
export async function runGlobalScriptByName(input: {
  scriptName: string;
  args: unknown;
  agentId: string;
  timeoutMs?: number;
  /**
   * Restrict `ctx.swarm` to read-only methods. Used by routing dry runs, where
   * suppressing bus events alone does NOT make the run side-effect-free — the
   * handler still executes with real credentials.
   */
  readOnly?: boolean;
}): Promise<{ result: unknown; stdout: string }> {
  const script = getScript({ name: input.scriptName, scope: "global" });
  if (!script) {
    throw new Error(`Script '${input.scriptName}' not found`);
  }
  // Gating `ctx.swarm` alone is not enough: `ctx.api` / `ctx.mcp` hand the
  // script authenticated descriptors for EXTERNAL services, and the egress
  // broker substitutes real credentials into its fetches. A handler that
  // normally writes through one of those could mutate a third-party system
  // during a dry run, so a read-only run gets none of them.
  const readOnly = input.readOnly === true;
  const output = await runScript({
    source: script.source,
    args: input.args,
    fsMode: "none",
    agentId: input.agentId,
    egressSecrets: readOnly ? [] : await buildScriptCredentialBindings({ agentId: input.agentId }),
    apiConnections: readOnly ? [] : getScriptApiConnectionDescriptors({ agentId: input.agentId }),
    mcpConnections: readOnly ? [] : getScriptMcpConnectionDescriptors({ agentId: input.agentId }),
    timeoutMs: input.timeoutMs ?? 60_000,
    readOnly: input.readOnly,
  });
  if (output.exitCode !== 0 || output.error) {
    throw new Error(
      output.stderr ||
        `Script '${input.scriptName}' exited with code ${output.exitCode}${
          output.error ? ` (${output.error})` : ""
        }`,
    );
  }
  return { result: output.result, stdout: output.stdout };
}
