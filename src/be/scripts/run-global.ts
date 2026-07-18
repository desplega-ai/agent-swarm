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
}): Promise<{ result: unknown; stdout: string }> {
  const script = getScript({ name: input.scriptName, scope: "global" });
  if (!script) {
    throw new Error(`Script '${input.scriptName}' not found`);
  }
  const output = await runScript({
    source: script.source,
    args: input.args,
    fsMode: "none",
    agentId: input.agentId,
    egressSecrets: await buildScriptCredentialBindings({ agentId: input.agentId }),
    apiConnections: getScriptApiConnectionDescriptors({ agentId: input.agentId }),
    mcpConnections: getScriptMcpConnectionDescriptors({ agentId: input.agentId }),
    timeoutMs: input.timeoutMs ?? 60_000,
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
