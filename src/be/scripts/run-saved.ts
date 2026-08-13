import { runScript } from "../../scripts-runtime/loader";
import type { ScriptRecord } from "../../types";
import {
  getScriptApiConnectionDescriptors,
  getScriptMcpConnectionDescriptors,
} from "../script-connections";
import { buildScriptCredentialBindingsWithFailures } from "../script-credential-broker";
import { touchScratchScriptLastUsed } from "./db";

export function getSavedScriptOwnerAgentId(script: ScriptRecord): string | null {
  return script.scopeId ?? script.createdByAgentId;
}

/** Run a saved script with the selected agent's credential and connection bindings. */
export async function runSavedScriptAsAgent(args: {
  script: ScriptRecord;
  input: unknown;
  agentId: string;
}) {
  // Touch before executing (not just after) so a scratch script that's already
  // stale when a run starts can't be reaped by the retention sweep while the
  // run — which may take up to the runtime's wall-clock ceiling — is in flight.
  if (args.script.isScratch) touchScratchScriptLastUsed(args.script.id);

  const credentials = await buildScriptCredentialBindingsWithFailures({
    agentId: args.agentId,
  });
  const output = await runScript({
    source: args.script.source,
    args: args.input,
    fsMode: args.script.fsMode,
    agentId: args.agentId,
    egressSecrets: credentials.egressSecrets,
    failedBindings: credentials.failedBindings,
    apiConnections: getScriptApiConnectionDescriptors({ agentId: args.agentId }),
    mcpConnections: getScriptMcpConnectionDescriptors({ agentId: args.agentId }),
  });
  if (output.exitCode === 0 && !output.error && !output.runtimeError) {
    touchScratchScriptLastUsed(args.script.id);
  }
  return output;
}
