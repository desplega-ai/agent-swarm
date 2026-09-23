import {
  createAgent,
  EXTENSION_AGENT_ROLE,
  getAllAgents,
  getDbClient,
  updateAgentMaxTasks,
  updateAgentProfile,
  updateAgentStatus,
} from "../be/db";

function extensionAgentName(name: string): string {
  return `ext:${name}`;
}

export async function ensureExtensionAgent(name: string): Promise<string> {
  const agentName = extensionAgentName(name);
  return await getDbClient().transaction(async () => {
    let agent = (await getAllAgents({ includeExtensions: true })).find(
      (candidate) => candidate.name === agentName,
    );
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
    await updateAgentProfile(agent.id, {
      description: `System agent for extension ${name}`,
      role: EXTENSION_AGENT_ROLE,
      capabilities: [],
    });
    return agent.id;
  });
}

export async function deactivateExtensionAgent(name: string): Promise<void> {
  const agent = (await getAllAgents({ includeExtensions: true })).find(
    (candidate) => candidate.name === extensionAgentName(name),
  );
  if (agent && agent.status !== "offline") await updateAgentStatus(agent.id, "offline");
}
