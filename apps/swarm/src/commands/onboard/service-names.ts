import type { ServiceEntry } from "./types.ts";

export interface ExpandedService {
  name: string; // e.g., "lead", "worker-coder-1"
  sanitizedName: string; // e.g., "lead", "worker_coder_1"
  containerName: string; // e.g., "swarm-lead", "swarm-worker-coder-1"
  entry: ServiceEntry;
  index: number; // 0-based within the entry's count
  agentId: string; // from state.agentIds[name]
}

/**
 * Expand ServiceEntry[] (which have a `count` field) into individual named services.
 * Naming rules:
 *  - lead (count=1) -> "lead"
 *  - lead (count>1) -> "lead-1", "lead-2"
 *  - worker role "coder" (count=1) -> "worker-coder"
 *  - worker role "coder" (count=2) -> "worker-coder-1", "worker-coder-2"
 */
export function expandServices(
  services: ServiceEntry[],
  agentIds: Record<string, string>,
): ExpandedService[] {
  const result: ExpandedService[] = [];

  for (const entry of services) {
    for (let i = 0; i < entry.count; i++) {
      const suffix = entry.count > 1 ? `-${i + 1}` : "";
      const baseName = entry.isLead ? "lead" : `worker-${entry.role}`;
      const name = `${baseName}${suffix}`;
      const sanitizedName = name.replace(/-/g, "_");
      const containerName = `swarm-${name}`;
      const agentId = agentIds[name] ?? "";

      result.push({
        name,
        sanitizedName,
        containerName,
        entry,
        index: i,
        agentId,
      });
    }
  }

  return result;
}
