import { SDK_ALLOWLIST } from "../scripts-runtime/sdk-allowlist";

/**
 * Workflow guests get the same explicitly reviewed swarm surface as scripts.
 * Host context properties outside this list never cross the capability broker.
 */
export const WORKFLOW_SWARM_CAPABILITY_ALLOWLIST: readonly string[] = [...SDK_ALLOWLIST];

const WORKFLOW_SWARM_CAPABILITIES = new Set<string>(WORKFLOW_SWARM_CAPABILITY_ALLOWLIST);

export function isWorkflowSwarmCapabilityAllowed(method: string): boolean {
  return WORKFLOW_SWARM_CAPABILITIES.has(method);
}
