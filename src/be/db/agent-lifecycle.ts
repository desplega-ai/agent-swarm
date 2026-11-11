import { createHash } from "node:crypto";
import type {
  Agent,
  AgentDeletePreview,
  AgentLifecycleEvent,
  AgentLifecycleWarning,
} from "../../types";
import { TERMINAL_TASK_STATUSES } from "../../types";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { revokeAllAgentSessionTokens } from "../users";
import { getAgentById, isExtensionAgent, NOT_EXTENSION_AGENT_SQL } from "./agents";
import { getDbClient } from "./runtime";

/** A refused delete or restore; `code` is the machine-readable reason. */
export class AgentLifecycleError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
    readonly code: string,
    readonly preview?: AgentDeletePreview,
  ) {
    super(message);
    this.name = "AgentLifecycleError";
  }
}

/** Who performed a lifecycle action. `userId` is the canonical user, null for the shared key. */
export type AgentLifecycleActor = { kind: "user" | "operator"; ref: string; userId: string | null };

const MAX_WARNING_ITEMS = 20;
const PR_LOOP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const NON_TERMINAL_SQL = `status NOT IN (${TERMINAL_TASK_STATUSES.map((s) => `'${s}'`).join(", ")})`;

async function listWarning(
  kind: string,
  sql: string,
  params: Array<string | number>,
): Promise<AgentLifecycleWarning | null> {
  const rows = await getDbClient().query<{ id: string; name: string | null }>(sql, params);
  if (rows.length === 0) return null;
  return {
    kind,
    count: rows.length,
    items: rows.slice(0, MAX_WARNING_ITEMS).map((r) => ({ id: String(r.id), name: r.name })),
  };
}

async function buildPreview(agent: Agent): Promise<AgentDeletePreview> {
  const id = agent.id;
  const blockers: AgentDeletePreview["blockers"] = [];
  if (agent.deletedAt) {
    blockers.push({ code: "already_deleted", message: `Agent was deleted on ${agent.deletedAt}.` });
  }
  if (agent.isLead) {
    blockers.push({ code: "lead", message: "The lead agent cannot be deleted." });
  }
  if (isExtensionAgent(agent)) {
    blockers.push({
      code: "extension",
      message: "Extension identities follow their extension; uninstall the extension instead.",
    });
  }
  const openTasks = await getDbClient().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM agent_tasks WHERE (agentId = ? OR offeredTo = ?) AND ${NON_TERMINAL_SQL}`,
    [id, id],
  );
  if (openTasks?.n) {
    blockers.push({
      code: "open_tasks",
      message: `${openTasks.n} non-terminal task(s) are assigned or offered to this agent. Finish, cancel or reassign them first.`,
    });
  }
  if (agent.runtimePoolId) {
    blockers.push({
      code: "pool_bound",
      message: `Agent is bound to runtime pool ${agent.runtimePoolId}. Unbind it first.`,
    });
  }
  if (agent.status !== "offline") {
    blockers.push({
      code: "not_offline",
      message: `Agent is ${agent.status}. Stop its worker so it goes offline first.`,
    });
  }

  const since = new Date(Date.now() - PR_LOOP_WINDOW_MS).toISOString();
  const warnings = (
    await Promise.all([
      listWarning(
        "schedules",
        "SELECT id, name FROM scheduled_tasks WHERE targetAgentId = ? AND enabled = 1 ORDER BY name, id",
        [id],
      ),
      listWarning(
        "workflow_nodes",
        `SELECT w.id AS id, w.name || ' / ' || json_extract(n.value, '$.id') AS name
           FROM workflows w, json_each(w.definition, '$.nodes') n
          WHERE json_valid(w.definition)
            AND json_extract(n.value, '$.type') = 'agent-task'
            AND json_extract(n.value, '$.config.agentId') = ?
          ORDER BY w.name, w.id, name`,
        [id],
      ),
      listWarning(
        "scripts",
        "SELECT id, name FROM scripts WHERE scope = 'agent' AND scopeId = ? ORDER BY name, id",
        [id],
      ),
      listWarning(
        "memories",
        "SELECT scope AS id, COUNT(*) || ' memories' AS name FROM agent_memory WHERE agentId = ? GROUP BY scope ORDER BY scope",
        [id],
      ),
      listWarning(
        "credential_bindings",
        "SELECT id, config_key AS name FROM script_credential_bindings WHERE scope = 'agent' AND scope_id = ? AND active = 1 ORDER BY config_key, id",
        [id],
      ),
      listWarning(
        "connections",
        "SELECT id, slug AS name FROM script_connections WHERE scope = 'agent' AND scope_id = ? AND enabled = 1 ORDER BY slug, id",
        [id],
      ),
      // Key names only; secret values never leave the table.
      listWarning(
        "config",
        "SELECT id, key || CASE WHEN isSecret = 1 THEN ' (secret)' ELSE '' END AS name FROM swarm_config WHERE scope = 'agent' AND scopeId = ? ORDER BY key, id",
        [id],
      ),
      listWarning(
        "pr_loops",
        `SELECT vcsRepo || '#' || vcsNumber AS id, NULL AS name FROM agent_tasks
          WHERE agentId = ? AND vcsRepo IS NOT NULL AND vcsNumber IS NOT NULL AND finishedAt >= ?
          GROUP BY vcsRepo, vcsNumber ORDER BY vcsRepo, vcsNumber`,
        [id, since],
      ),
      listWarning(
        "inboxes",
        "SELECT id, inboxEmail AS name FROM agentmail_inbox_mappings WHERE agentId = ? ORDER BY inboxEmail, id",
        [id],
      ),
      listWarning(
        "owned_skills",
        "SELECT id, name FROM skills WHERE ownerAgentId = ? ORDER BY name, id",
        [id],
      ),
      listWarning(
        "owned_mcp_servers",
        "SELECT id, name FROM mcp_servers WHERE ownerAgentId = ? ORDER BY name, id",
        [id],
      ),
    ])
  ).filter((w): w is AgentLifecycleWarning => w !== null);

  if (!agent.isLead) {
    const others = await getDbClient().get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agents
        WHERE id != ? AND isLead = 0 AND deleted_at IS NULL AND ${NOT_EXTENSION_AGENT_SQL}`,
      [id],
    );
    if (!others?.n) warnings.push({ kind: "last_worker", count: 1, items: [] });
  }

  const warningsHash = createHash("sha256").update(JSON.stringify(warnings)).digest("hex");
  return { agentId: id, blockers, warnings, warningsHash };
}

async function requireAgent(agentId: string): Promise<Agent> {
  const agent = await getAgentById(agentId, { includeDeleted: true });
  if (!agent) throw new AgentLifecycleError("Agent not found", 404, "not_found");
  return agent;
}

export async function previewAgentDeletion(agentId: string): Promise<AgentDeletePreview> {
  return await buildPreview(await requireAgent(agentId));
}

type EventRow = {
  id: string;
  agent_id: string;
  action: "deleted" | "restored";
  actor_kind: "user" | "operator";
  actor_ref: string;
  created_by: string | null;
  reason: string;
  snapshot_json: string;
  created_at: string;
};

function rowToEvent(row: EventRow): AgentLifecycleEvent {
  return {
    id: row.id,
    agentId: row.agent_id,
    action: row.action,
    actorKind: row.actor_kind,
    actorRef: row.actor_ref,
    createdBy: row.created_by,
    reason: row.reason,
    snapshot: JSON.parse(row.snapshot_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

async function writeEvent(
  agentId: string,
  action: EventRow["action"],
  actor: AgentLifecycleActor,
  reason: string,
  snapshot: Record<string, unknown>,
  at: string,
): Promise<AgentLifecycleEvent> {
  const row = await getDbClient().get<EventRow>(
    `INSERT INTO agent_lifecycle_events
       (id, agent_id, action, actor_kind, actor_ref, created_by, reason, snapshot_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [
      crypto.randomUUID(),
      agentId,
      action,
      actor.kind,
      actor.ref,
      actor.userId,
      scrubSecrets(reason.trim()),
      scrubSecrets(JSON.stringify(snapshot)),
      at,
    ],
  );
  if (!row) throw new Error("Failed to write agent lifecycle event");
  return rowToEvent(row);
}

/**
 * Soft-delete an agent. The preview is recomputed inside the write lock, so no
 * task can land between the check and the write, and a changed warning set
 * refuses with `warnings_changed` until the operator previews again.
 */
export async function softDeleteAgent(
  agentId: string,
  input: { reason: string; warningsHash: string },
  actor: AgentLifecycleActor,
): Promise<{ agent: Agent; disabledScheduleIds: string[]; event: AgentLifecycleEvent }> {
  return await getDbClient().transaction(async () => {
    const agent = await requireAgent(agentId);
    const preview = await buildPreview(agent);
    const blocker = preview.blockers[0];
    if (blocker) throw new AgentLifecycleError(blocker.message, 409, blocker.code, preview);
    if (preview.warningsHash !== input.warningsHash) {
      throw new AgentLifecycleError(
        "Warnings changed since the preview. Review them and confirm again.",
        409,
        "warnings_changed",
        preview,
      );
    }
    const now = new Date().toISOString();
    // A schedule pinned to a deleted agent would error and back off on every tick.
    const disabledScheduleIds = (
      await getDbClient().query<{ id: string }>(
        `UPDATE scheduled_tasks SET enabled = 0, lastUpdatedAt = ?, updated_by = COALESCE(?, updated_by)
          WHERE targetAgentId = ? AND enabled = 1 RETURNING id`,
        [now, actor.userId, agentId],
      )
    )
      .map((r) => r.id)
      .sort();
    await getDbClient().run(
      "UPDATE agents SET deleted_at = ?, deleted_by = ?, lastUpdatedAt = ? WHERE id = ?",
      [now, actor.userId, now, agentId],
    );
    // Every credential that resolves to the agent dies with it. Restore leaves
    // these revoked; the worker re-registers and gets new ones.
    const revokedTokenCount = await revokeAllAgentSessionTokens(agentId);
    const event = await writeEvent(
      agentId,
      "deleted",
      actor,
      input.reason,
      {
        name: agent.name,
        status: agent.status,
        warnings: preview.warnings,
        disabledScheduleIds,
        revokedTokenCount,
      },
      now,
    );
    const deleted = await getAgentById(agentId, { includeDeleted: true });
    return { agent: deleted!, disabledScheduleIds, event };
  });
}

/**
 * Undo a soft delete. The agent comes back offline and unbound; the schedules
 * the delete disabled stay off and are returned for a manual re-enable.
 */
export async function restoreAgent(
  agentId: string,
  input: { reason: string; newName?: string },
  actor: AgentLifecycleActor,
): Promise<{ agent: Agent; disabledScheduleIds: string[]; event: AgentLifecycleEvent }> {
  return await getDbClient().transaction(async () => {
    const agent = await requireAgent(agentId);
    if (!agent.deletedAt) throw new AgentLifecycleError("Agent is not deleted", 409, "not_deleted");
    const name = input.newName?.trim() || agent.name;
    const taken = await getDbClient().get<{ id: string }>(
      "SELECT id FROM agents WHERE name = ? AND id != ? AND deleted_at IS NULL",
      [name, agentId],
    );
    if (taken) {
      throw new AgentLifecycleError(
        `Another agent is named "${name}". Pass newName to restore under a different name.`,
        409,
        "name_taken",
      );
    }
    const lastDelete = await getDbClient().get<{ snapshot_json: string }>(
      `SELECT snapshot_json FROM agent_lifecycle_events
        WHERE agent_id = ? AND action = 'deleted' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [agentId],
    );
    const disabledScheduleIds = lastDelete
      ? ((JSON.parse(lastDelete.snapshot_json) as { disabledScheduleIds?: string[] })
          .disabledScheduleIds ?? [])
      : [];
    const now = new Date().toISOString();
    await getDbClient().run(
      `UPDATE agents SET deleted_at = NULL, deleted_by = NULL, status = 'offline',
              runtime_pool_id = NULL, name = ?, lastUpdatedAt = ? WHERE id = ?`,
      [name, now, agentId],
    );
    const event = await writeEvent(
      agentId,
      "restored",
      actor,
      input.reason,
      { previousName: agent.name, name, deletedAt: agent.deletedAt, disabledScheduleIds },
      now,
    );
    const restored = await getAgentById(agentId);
    return { agent: restored!, disabledScheduleIds, event };
  });
}

export async function listAgentLifecycleEvents(agentId: string): Promise<AgentLifecycleEvent[]> {
  const rows = await getDbClient().query<EventRow>(
    "SELECT * FROM agent_lifecycle_events WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC",
    [agentId],
  );
  return rows.map(rowToEvent);
}
