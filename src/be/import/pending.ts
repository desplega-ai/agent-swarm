/**
 * Apply import assignments stored for an agent that was not registered at
 * import time. Called from `createAgent`, inside the registering transaction.
 */

import type { Agent } from "../../types";
import { getAgentById, getDbClient } from "../db";
import { recordSeedState } from "../seed/state-db";
import {
  getOwnedId,
  identityIsAdoptable,
  installImportedSkills,
  seedKind,
  writeInstructions,
} from "./seeders";

type PendingRow = {
  sourceId: string;
  agentKey: string;
  instructions: string | null;
  instructionsHash: string | null;
  skillKeys: string;
};

/** Returns true when it changed the agent's profile or installs. */
export async function resolvePendingImportAssignments(
  agent: Pick<Agent, "id" | "name">,
): Promise<boolean> {
  const rows = await getDbClient().query<PendingRow>(
    `SELECT sourceId, agentKey, instructions, instructionsHash, skillKeys
       FROM import_pending_assignments WHERE agentId = ? OR agentName = ?`,
    [agent.id, agent.name],
  );
  if (rows.length === 0) return false;

  // A savepoint: a failure here rolls back only these writes, never the registration.
  return getDbClient().transaction(async (tx) => {
    let changed = false;
    for (const row of rows) {
      const live = await getAgentById(agent.id);
      const ownedBy = await getOwnedId(row.sourceId, "agent", row.agentKey);
      if (row.instructions !== null && row.instructionsHash !== null && live) {
        // A brand-new agent has no identity yet; never replace one it already has.
        const fresh = identityIsAdoptable(live) || ownedBy === agent.id;
        if (fresh) {
          await writeInstructions(row.sourceId, row.agentKey, agent.id, row.instructions);
          await recordSeedState(
            seedKind(row.sourceId, "agent"),
            row.agentKey,
            row.instructionsHash,
          );
          changed = true;
        }
      }
      const { installed } = await installImportedSkills(
        row.sourceId,
        agent.id,
        JSON.parse(row.skillKeys) as string[],
      );
      if (installed > 0) changed = true;
      await tx.run("DELETE FROM import_pending_assignments WHERE sourceId = ? AND agentKey = ?", [
        row.sourceId,
        row.agentKey,
      ]);
      console.log(
        `[import:${row.sourceId}] resolved pending assignments for agent ${row.agentKey}`,
      );
    }
    return changed;
  });
}
