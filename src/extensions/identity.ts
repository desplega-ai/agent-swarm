import { getStorage } from "@/be/storage";
import {
  createAgent,
  EXTENSION_AGENT_ROLE,
  getAllAgents,
  isExtensionAgent,
  updateAgentMaxTasks,
  updateAgentProfile,
  updateAgentStatus,
} from "../be/db";

function extensionAgentName(name: string): string {
  return `ext:${name}`;
}

/**
 * Thrown when the `ext:<name>` agent name is held by an agent that is not an
 * extension identity. Agent names are self-service, so the name alone never
 * makes a row the extension's identity.
 */
export class ExtensionIdentityConflictError extends Error {
  constructor(agentName: string) {
    super(
      `Agent name "${agentName}" is held by an agent that is not an extension identity. Rename or delete that agent, then retry.`,
    );
    this.name = "ExtensionIdentityConflictError";
  }
}

async function findExtensionAgent(agentName: string) {
  return (await getAllAgents({ includeExtensions: true })).find(
    (candidate) => candidate.name === agentName,
  );
}

export async function ensureExtensionAgent(name: string): Promise<string> {
  const agentName = extensionAgentName(name);
  return await getStorage().transaction(async () => {
    let agent = await findExtensionAgent(agentName);
    // Only adopt a row this lifecycle created: every one carries the extension role.
    if (agent && !isExtensionAgent(agent)) throw new ExtensionIdentityConflictError(agentName);
    if (!agent) {
      agent = await createAgent({
        name: agentName,
        isLead: false,
        status: "offline",
        maxTasks: 0,
        capabilities: [],
      });
    }

    if (agent.status !== "offline") await updateAgentStatus(agent.id, "offline");
    if (agent.maxTasks !== 0) await updateAgentMaxTasks(agent.id, 0);
    await updateAgentProfile(
      agent.id,
      {
        description: `System agent for extension ${name}`,
        role: EXTENSION_AGENT_ROLE,
        capabilities: [],
      },
      undefined,
      { allowExtensionRole: true },
    );
    return agent.id;
  });
}

export async function deactivateExtensionAgent(name: string): Promise<void> {
  const agent = await findExtensionAgent(extensionAgentName(name));
  if (agent && isExtensionAgent(agent) && agent.status !== "offline")
    await updateAgentStatus(agent.id, "offline");
}
