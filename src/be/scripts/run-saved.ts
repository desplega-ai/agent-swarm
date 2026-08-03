import { runScript } from "../../scripts-runtime/loader";
import type { ScriptRecord } from "../../types";
import {
  getScriptApiConnectionDescriptors,
  getScriptMcpConnectionDescriptors,
} from "../script-connections";
import { buildScriptCredentialBindingsWithFailures } from "../script-credential-broker";

export function getSavedScriptOwnerAgentId(script: ScriptRecord): string | null {
  return script.scopeId ?? script.createdByAgentId;
}

/** Run a saved script with the selected agent's credential and connection bindings. */
export async function runSavedScriptAsAgent(args: {
  script: ScriptRecord;
  input: unknown;
  agentId: string;
}) {
  const credentials = await buildScriptCredentialBindingsWithFailures({
    agentId: args.agentId,
  });
  return runScript({
    source: args.script.source,
    args: args.input,
    fsMode: args.script.fsMode,
    agentId: args.agentId,
    egressSecrets: credentials.egressSecrets,
    failedBindings: credentials.failedBindings,
    apiConnections: getScriptApiConnectionDescriptors({ agentId: args.agentId }),
    mcpConnections: getScriptMcpConnectionDescriptors({ agentId: args.agentId }),
  });
}
