/**
 * Operator-only agent delete and restore (migration 334). A delete appends the
 * full `agents` row to the append-only `agent_history` table, then hard-deletes
 * the row; a restore reinserts the latest `deleted` snapshot under the same id,
 * so data keyed by agent id without a foreign key (tasks, memories, scripts,
 * config) reattaches. Rows behind a cascading foreign key do not come back.
 */
import type { Agent, AgentHistoryEvent } from "../types";
import { TERMINAL_TASK_STATUSES } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import {
  deleteAgent,
  getAgentById,
  getDbClient,
  installSystemDefaultSkillsForAgent,
  isExtensionAgent,
} from "./db";
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

const NON_TERMINAL_SQL = `status NOT IN (${TERMINAL_TASK_STATUSES.map((s) => `'${s}'`).join(", ")})`;

// Each count refuses the delete. The last three are NO ACTION foreign keys
// that would otherwise fail the DELETE itself.
const COUNT_BLOCKERS: Array<[code: string, sql: string, what: string]> = [
  [
    "open_tasks",
    `SELECT COUNT(*) AS n FROM agent_tasks WHERE (agentId = ?1 OR offeredTo = ?1) AND ${NON_TERMINAL_SQL}`,
    "non-terminal task(s) are assigned or offered to it; finish, cancel or reassign them",
  ],
  [
    "schedules",
    "SELECT COUNT(*) AS n FROM scheduled_tasks WHERE targetAgentId = ?1 AND enabled = 1",
    "enabled schedule(s) target it; disable or retarget them",
  ],
  [
    "owned_skills",
    "SELECT COUNT(*) AS n FROM skills WHERE ownerAgentId = ?1",
    "skill(s) are owned by it",
  ],
  [
    "owned_mcp_servers",
    "SELECT COUNT(*) AS n FROM mcp_servers WHERE ownerAgentId = ?1",
    "MCP server(s) are owned by it",
  ],
  [
    "inboxes",
    "SELECT COUNT(*) AS n FROM agentmail_inbox_mappings WHERE agentId = ?1",
    "AgentMail inbox(es) map to it",
  ],
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
  for (const [code, sql, what] of COUNT_BLOCKERS) {
    const n = (await getDbClient().get<{ n: number }>(sql, [agent.id]))?.n ?? 0;
    if (n > 0) blockers.push({ code, message: `${n} ${what}.` });
  }
  return blockers;
}

type HistoryRow = {
  id: string;
  agent_id: string;
  event: "deleted" | "restored";
  actor_ref: string;
  reason: string;
  snapshot_json: string;
  created_at: string;
};

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
  const snapshot = await getDbClient().get<Record<string, unknown>>(
    "SELECT * FROM agents WHERE id = ?",
    [agentId],
  );
  const row = await getDbClient().get<HistoryRow>(
    `INSERT INTO agent_history (id, agent_id, event, actor_ref, reason, snapshot_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [
      crypto.randomUUID(),
      agentId,
      event,
      actorRef,
      scrubSecrets(reason.trim()),
      // Unscrubbed: restore must reinsert the row byte-exact.
      JSON.stringify(snapshot),
      new Date().toISOString(),
    ],
  );
  if (!row) throw new Error("Failed to append agent history");
  return rowToEvent(row);
}

async function latestEvent(agentId: string): Promise<HistoryRow | null> {
  return await getDbClient().get<HistoryRow>(
    "SELECT * FROM agent_history WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    [agentId],
  );
}

export async function deleteAgentToHistory(
  agentId: string,
  reason: string,
  actorRef: string,
): Promise<AgentHistoryEvent> {
  return await getDbClient().transaction(async () => {
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
    await getDbClient().run("DELETE FROM agent_skills WHERE agentId = ?", [agentId]);
    await getDbClient().run("DELETE FROM agent_mcp_servers WHERE agentId = ?", [agentId]);
    await deleteAgent(agentId);
    return event;
  });
}

export async function restoreAgentFromHistory(
  agentId: string,
  input: { reason: string; newName?: string },
  actorRef: string,
): Promise<{ agent: Agent; event: AgentHistoryEvent }> {
  return await getDbClient().transaction(async () => {
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
    const taken = await getDbClient().get("SELECT id FROM agents WHERE name = ?", [name]);
    if (taken) {
      throw new AgentHistoryError(
        `Another agent is named "${name}". Pass newName.`,
        409,
        "name_taken",
      );
    }
    // Only columns that still exist, so a snapshot taken before a later migration still restores.
    const columns = (
      await getDbClient().query<{ name: string }>("SELECT name FROM pragma_table_info('agents')")
    )
      .map((c) => c.name)
      .filter((c) => c in row);
    await getDbClient().run(
      `INSERT INTO agents (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
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
  const rows = await getDbClient().query<HistoryRow>(
    `SELECT * FROM agent_history ${agentId ? "WHERE agent_id = ?" : ""}
      ORDER BY created_at DESC, rowid DESC LIMIT 500`,
    agentId ? [agentId] : [],
  );
  return rows.map(rowToEvent);
}
