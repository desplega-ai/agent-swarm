import type { AgentMemory } from "@/types";

export function canReadMemory(memory: AgentMemory, agentId: string | undefined): boolean {
  return memory.scope === "swarm" || memory.agentId === agentId;
}
