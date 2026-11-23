/**
 * Operator-only agent delete and restore (migration 334). A delete appends the
 * full `agents` row to the append-only `agent_history` table, then hard-deletes
 * the row; a restore reinserts the latest `deleted` snapshot under the same id,
 * so data keyed by agent id without a foreign key (tasks, memories, scripts,
 * config) reattaches. Rows behind a cascading foreign key do not come back.
 */

import type { AgentDeleteBlockerCounts, AgentHistoryRow } from "@desplega/storage";
import type { Agent, AgentHistoryEvent } from "../types";
import { TERMINAL_TASK_STATUSES } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import {
  deleteAgent,
  getAgentById,
  installSystemDefaultSkillsForAgent,
  isExtensionAgent,
} from "./db";
import { getStorage } from "./storage";
import { revokeAllAgentSessionTokens } from "./users";

/** A refused delete or restore; `code` is the machine-readable reason. */
export class AgentHistoryError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
    readonly code: string,
    readonly blockers: Array<{ code: string; message: string }> = [],
  ) {
    super(message);
    this.name = "AgentHistoryError";
  }
}

// Each count refuses the delete. The last three are NO ACTION foreign keys
// that would otherwise fail the DELETE itself.
const COUNT_BLOCKERS: Array<[code: keyof AgentDeleteBlockerCounts, what: string]> = [
  [
    "open_tasks",
    "non-terminal task(s) are assigned or offered to it; finish, cancel or reassign them",
  ],
  ["schedules", "enabled schedule(s) target it; disable or retarget them"],
  ["owned_skills", "skill(s) are owned by it"],
  ["owned_mcp_servers", "MCP server(s) are owned by it"],
  ["inboxes", "AgentMail inbox(es) map to it"],
];

async function deleteBlockers(agent: Agent): Promise<Array<{ code: string; message: string }>> {
  const blockers: Array<{ code: string; message: string }> = [];
  if (agent.isLead) blockers.push({ code: "lead", message: "The lead agent cannot be deleted." });
  if (isExtensionAgent(agent)) {
    blockers.push({ code: "extension", message: "Uninstall the extension instead." });
  }
  // Offline means no worker is running, so nothing re-registers the id mid-delete.
  if (agent.status !== "offline") {
    blockers.push({ code: "not_offline", message: `Agent is ${agent.status}. Stop its worker.` });
  }
  if (agent.runtimePoolId) {
    blockers.push({ code: "pool_bound", message: `Unbind it from pool ${agent.runtimePoolId}.` });
  }
  const counts = await getStorage().repos.agents.countDeleteBlockers(
    agent.id,
    TERMINAL_TASK_STATUSES,
  );
  for (const [code, what] of COUNT_BLOCKERS) {
    const n = counts[code];
    if (n > 0) blockers.push({ code, message: `${n} ${what}.` });
  }
  return blockers;
}

type HistoryRow = AgentHistoryRow;

function rowToEvent(row: HistoryRow): AgentHistoryEvent {
  return {
    id: row.id,
    agentId: row.agent_id,
    event: row.event,
    actorRef: row.actor_ref,
    reason: row.reason,
    snapshot: JSON.parse(row.snapshot_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

async function appendEvent(
  agentId: string,
  event: HistoryRow["event"],
  actorRef: string,
  reason: string,
): Promise<AgentHistoryEvent> {
  const agents = getStorage().repos.agents;
  const snapshot = await agents.findAgentSnapshot(agentId);
  const row = await agents.insertHistory({
    id: crypto.randomUUID(),
    agent_id: agentId,
    event,
    actor_ref: actorRef,
    reason: scrubSecrets(reason.trim()),
    // Unscrubbed: restore must reinsert the row byte-exact.
    snapshot_json: JSON.stringify(snapshot),
    created_at: new Date().toISOString(),
  });
  if (!row) throw new Error("Failed to append agent history");
  return rowToEvent(row);
}

async function latestEvent(agentId: string): Promise<HistoryRow | null> {
  return await getStorage().repos.agents.latestHistory(agentId);
}

export async function deleteAgentToHistory(
  agentId: string,
  reason: string,
  actorRef: string,
): Promise<AgentHistoryEvent> {
  const storage = getStorage();
  return await storage.transaction(async () => {
    const agent = await getAgentById(agentId);
    if (!agent) throw new AgentHistoryError("Agent not found", 404, "not_found");
    const blockers = await deleteBlockers(agent);
    if (blockers.length > 0) {
      throw new AgentHistoryError(blockers[0]!.message, 409, blockers[0]!.code, blockers);
    }
    const event = await appendEvent(agentId, "deleted", actorRef, reason);
    // Every token that resolves to the agent dies with it.
    await revokeAllAgentSessionTokens(agentId);
    // Install rows hold NO ACTION foreign keys; restore reinstalls the system defaults.
    await storage.repos.agents.deleteAgentSkills(agentId);
    await storage.repos.agents.deleteAgentMcpServers(agentId);
    await deleteAgent(agentId);
    return event;
  });
}

export async function restoreAgentFromHistory(
  agentId: string,
  input: { reason: string; newName?: string },
  actorRef: string,
): Promise<{ agent: Agent; event: AgentHistoryEvent }> {
  const storage = getStorage();
  const agents = storage.repos.agents;
  return await storage.transaction(async () => {
    if (await getAgentById(agentId)) {
      throw new AgentHistoryError("Agent exists; nothing to restore", 409, "not_deleted");
    }
    const last = await latestEvent(agentId);
    if (last?.event !== "deleted") {
      throw new AgentHistoryError("No deleted agent with this id", 404, "not_found");
    }
    const row: Record<string, string | number | null> = JSON.parse(last.snapshot_json);
    const name = input.newName?.trim() || String(row.name);
    row.name = name;
    row.lastUpdatedAt = new Date().toISOString();
    const taken = await agents.findAgentIdByName(name);
    if (taken) {
      throw new AgentHistoryError(
        `Another agent is named "${name}". Pass newName.`,
        409,
        "name_taken",
      );
    }
    // Only columns that still exist, so a snapshot taken before a later migration still restores.
    const columns = (await agents.listAgentColumns()).filter((c) => c in row);
    await agents.insertAgentSnapshot(
      columns,
      columns.map((c) => row[c] ?? null),
    );
    await installSystemDefaultSkillsForAgent(agentId);
    const event = await appendEvent(agentId, "restored", actorRef, input.reason);
    return { agent: (await getAgentById(agentId))!, event };
  });
}

/** Newest first; one agent's events, or every agent's. */
export async function listAgentHistory(agentId?: string): Promise<AgentHistoryEvent[]> {
  // shortcut: capped at 500 rows with no paging, add a cursor if the table outgrows it.
  const rows = await getStorage().repos.agents.listHistory(agentId || undefined, 500);
  return rows.map(rowToEvent);
}
