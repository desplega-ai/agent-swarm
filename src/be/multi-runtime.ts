/**
 * Persistence for multi-runtime agents: the runtime-instance lifecycle and the
 * logical task-concurrency policy that sits above it.
 *
 * Server-side by design — these helpers own SQLite statements, so they live
 * under `src/be` rather than beside the DB-free flag reader in
 * `src/utils/multi-runtime.ts`, keeping the worker/API database boundary
 * intact (`scripts/check-db-boundary.sh`).
 */

import type { Agent, RuntimeInstance, RuntimeInstanceStatus, SwarmConfig } from "../types";
import { isMultiRuntimeEnabled } from "../utils/multi-runtime";
import {
  getAgentById,
  getDb,
  getSwarmConfigs,
  updateAgentMaxTasks,
  updateAgentStatus,
  upsertSwarmConfig,
} from "./db";

// ─── Logical task policy ─────────────────────────────────────────────────────

/**
 * Agent-scoped swarm_config key holding the logical maxTasks policy in
 * multi-runtime mode. Operators edit this row; `agents.maxTasks` stays the
 * enforcement mirror that hasCapacity()/getRemainingCapacity() read. Same
 * column-vs-config split as HARNESS_PROVIDER.
 */
export const AGENT_MAX_TASKS_CONFIG_KEY = "AGENT_MAX_TASKS";

/** Bounds match AgentSchema.maxTasks, so a mirrored write stays schema-valid. */
function parseAgentMaxTasksValue(raw: string): number | null {
  const str = raw.trim();
  if (!/^\d+$/.test(str)) return null;
  const value = Number(str);
  return value >= 1 && value <= 100 ? value : null;
}

/**
 * Concurrency an agent falls back to with no explicit policy. Mirrors the
 * role defaults the runner resolves for itself (`resolveMaxConcurrent`), so a
 * lead keeps room for the follow-up work it waits on.
 */
export function defaultMaxTasksForAgent(agent: Pick<Agent, "isLead">): number {
  return agent.isLead ? 2 : 1;
}

export function getAgentMaxTasksConfig(agentId: string): SwarmConfig | null {
  return (
    getSwarmConfigs({ scope: "agent", scopeId: agentId, key: AGENT_MAX_TASKS_CONFIG_KEY })[0] ??
    null
  );
}

/**
 * Reconcile the AGENT_MAX_TASKS policy row with its agents.maxTasks mirror,
 * never consuming the runtime-reported concurrency.
 *
 * With no row yet, seed from the persisted agents.maxTasks — the value the
 * swarm is already enforcing — so enabling multi-runtime mode cannot change
 * behaviour. An existing row is authoritative and repairs the mirror instead.
 *
 * Runs inside the registration transaction so concurrent runtimes serialize:
 * the first seeds, the rest observe.
 */
export function reconcileAgentMaxTasksPolicy(agentId: string): void {
  const agent = getAgentById(agentId);
  if (!agent) return;
  const existing = getAgentMaxTasksConfig(agentId);
  if (existing) {
    const authoritative = parseAgentMaxTasksValue(existing.value);
    if (authoritative !== null && authoritative !== (agent.maxTasks ?? 1)) {
      updateAgentMaxTasks(agentId, authoritative);
    }
    return;
  }
  upsertSwarmConfig({
    scope: "agent",
    scopeId: agentId,
    key: AGENT_MAX_TASKS_CONFIG_KEY,
    value: String(agent.maxTasks ?? defaultMaxTasksForAgent(agent)),
    description: "Logical agent max-tasks policy (seeded from agents.maxTasks)",
  });
}

/**
 * Deleting the policy returns the agent to its role default rather than to a
 * fixed single slot — otherwise resetting a lead would leave it unable to
 * start the follow-up its own task waits on.
 */
export function resetAgentMaxTasksMirror(agentId: string): void {
  const agent = getAgentById(agentId);
  if (!agent) return;
  updateAgentMaxTasks(agentId, defaultMaxTasksForAgent(agent));
}

/**
 * Config upsert that keeps the agents.maxTasks enforcement mirror in step
 * with an agent-scoped AGENT_MAX_TASKS write, in one transaction, so policy
 * and enforcement cannot diverge — including with no runtime connected.
 * Every other key passes straight through.
 */
export function upsertSwarmConfigWithPolicyMirror(
  data: Parameters<typeof upsertSwarmConfig>[0],
): SwarmConfig {
  const scopeId = data.scope === "agent" ? data.scopeId : null;
  if (!scopeId || data.key !== AGENT_MAX_TASKS_CONFIG_KEY) {
    return upsertSwarmConfig(data);
  }
  return getDb().transaction(() => {
    const row = upsertSwarmConfig(data);
    // Guard, not validation — both write paths already ran validateConfigValue.
    const value = parseAgentMaxTasksValue(data.value);
    if (value !== null) updateAgentMaxTasks(scopeId, value);
    return row;
  })();
}

// ─── Runtime instances ───────────────────────────────────────────────────────

interface RuntimeInstanceRow {
  id: string;
  agent_id: string;
  status: string;
  reported_slots: number;
  metadata: string | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

function rowToRuntimeInstance(row: RuntimeInstanceRow): RuntimeInstance {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadata = null;
    }
  }
  return {
    id: row.id,
    agentId: row.agent_id,
    status: row.status as RuntimeInstanceStatus,
    reportedSlots: row.reported_slots,
    metadata,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Minutes without a ping before a runtime stops counting as live. The runner
 * pings every poll iteration (~2s), so this is a wide margin that will not
 * expire a healthy idle worker; it matches the "worker clearly dead" window
 * the stalled-task classifier already uses.
 */
export function runtimeStaleThresholdMinutes(): number {
  return Number(process.env.RUNTIME_STALE_THRESHOLD_MIN) || 5;
}

function runtimeLivenessCutoff(): string {
  return new Date(Date.now() - runtimeStaleThresholdMinutes() * 60 * 1000).toISOString();
}

/**
 * Register (or refresh) a runtime instance serving a logical agent. A
 * re-registration from the same process refreshes its row in place rather
 * than accumulating rows.
 *
 * The `DO UPDATE ... WHERE` guard makes runtime ownership permanent: an id
 * already held by one agent can never be reassigned to another, so a
 * duplicate id cannot move a live runtime between agents. Returns null in
 * that case (no row written).
 */
export function upsertRuntimeInstance(instance: {
  id: string;
  agentId: string;
  reportedSlots: number;
  metadata?: Record<string, unknown> | null;
}): RuntimeInstance | null {
  const metadataJson = instance.metadata ? JSON.stringify(instance.metadata) : null;
  const row = getDb()
    .prepare<RuntimeInstanceRow, [string, string, number, string | null]>(
      `INSERT INTO runtime_instances (id, agent_id, status, reported_slots, metadata)
       VALUES (?, ?, 'active', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = 'active',
         reported_slots = excluded.reported_slots,
         metadata = COALESCE(excluded.metadata, runtime_instances.metadata),
         last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE runtime_instances.agent_id = excluded.agent_id
       RETURNING *`,
    )
    .get(instance.id, instance.agentId, instance.reportedSlots, metadataJson);
  return row ? rowToRuntimeInstance(row) : null;
}

export function getRuntimeInstanceById(id: string): RuntimeInstance | null {
  const row = getDb()
    .prepare<RuntimeInstanceRow, [string]>("SELECT * FROM runtime_instances WHERE id = ?")
    .get(id);
  return row ? rowToRuntimeInstance(row) : null;
}

/**
 * Refresh a live runtime instance's liveness from the worker's ping cadence.
 *
 * Matches only an `active` row owned by the pinging agent, so a ping can
 * neither resurrect a closed runtime nor reach another agent's row.
 * Registration stays the only writer of `active`. Returns false when nothing
 * matched, which callers use as the signal that the identity is not live.
 */
export function touchRuntimeInstance(id: string, agentId: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE runtime_instances
       SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND agent_id = ? AND status = 'active'`,
    )
    .run(id, agentId);
  return result.changes > 0;
}

/** Mark one runtime instance offline (scoped to its agent, like touch). */
export function markRuntimeInstanceOffline(id: string, agentId: string): RuntimeInstance | null {
  const row = getDb()
    .prepare<RuntimeInstanceRow, [string, string]>(
      `UPDATE runtime_instances
       SET status = 'offline', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND agent_id = ? RETURNING *`,
    )
    .get(id, agentId);
  return row ? rowToRuntimeInstance(row) : null;
}

/**
 * Runtimes currently serving an agent. A crashed process never reaches
 * `/close`, so `active` alone would keep a dead runtime counted forever;
 * liveness is therefore the conjunction of status and a fresh `last_seen_at`.
 */
export function countActiveRuntimeInstancesForAgent(agentId: string): number {
  const result = getDb()
    .prepare<{ count: number }, [string, string]>(
      `SELECT COUNT(*) as count FROM runtime_instances
       WHERE agent_id = ? AND status = 'active' AND last_seen_at >= ?`,
    )
    .get(agentId, runtimeLivenessCutoff());
  return result?.count ?? 0;
}

/**
 * Whether this identity names a runtime of `agentId` that is still reporting.
 * Dispatch uses it so a retired process cannot be handed work alongside its
 * replacement; an absent identity is never live.
 */
export function isRuntimeInstanceLive(id: string | undefined, agentId: string): boolean {
  if (!id) return false;
  const row = getDb()
    .prepare<{ c: number }, [string, string, string]>(
      `SELECT COUNT(*) c FROM runtime_instances
       WHERE id = ? AND agent_id = ? AND status = 'active' AND last_seen_at >= ?`,
    )
    .get(id, agentId, runtimeLivenessCutoff());
  return (row?.c ?? 0) > 0;
}

/**
 * Agents with at least one runtime still reporting. While multi-runtime mode
 * is on this is the eligibility set for dispatch: an agent with no live
 * runtime — whether its runtimes died or it has not re-registered since the
 * flag was enabled — cannot poll for work, so assigning to it would strand
 * the task.
 */
export function agentsWithLiveRuntime(): Set<string> {
  const rows = getDb()
    .prepare<{ agent_id: string }, [string]>(
      `SELECT DISTINCT agent_id FROM runtime_instances
       WHERE status = 'active' AND last_seen_at >= ?`,
    )
    .all(runtimeLivenessCutoff());
  return new Set(rows.map((r) => r.agent_id));
}

/**
 * Startup cleanup for one runtime: drop this agent's sessions that no live
 * runtime owns, which is what a restarting process leaves behind (its
 * previous boot used a different instance id).
 *
 * A live sibling's session must survive — deleting it would strand its task
 * with no session row, and the orphan sweep would then requeue work that
 * process is still executing. A still-heartbeating session is therefore kept
 * even when no runtime row backs it, which is the state during the window
 * where the flag was just enabled and running workers have not yet
 * re-registered.
 */
export function cleanupRuntimeSessions(agentId: string): number {
  const cutoff = runtimeLivenessCutoff();
  const result = getDb()
    .prepare(
      `DELETE FROM active_sessions
       WHERE agentId = ?
         AND lastHeartbeatAt < ?
         AND (
           runtimeInstanceId IS NULL
           OR runtimeInstanceId NOT IN (
             SELECT id FROM runtime_instances
             WHERE agent_id = ? AND status = 'active' AND last_seen_at >= ?
           )
         )`,
    )
    .run(agentId, cutoff, agentId, cutoff);
  return result.changes;
}

/**
 * Retire runtimes that stopped pinging, release what they held, and take
 * their agents offline when nothing live remains.
 *
 * Inert unless multi-runtime mode is on: after a rollback, workers stop
 * refreshing their rows, and expiring them would offline agents that are
 * running perfectly well under legacy semantics.
 *
 * Deleting the retired rows rather than keeping them is deliberate. Runtime
 * identity is per boot, so retaining them would grow the table once per boot
 * per agent forever; nothing reads a runtime after it stops being live. Their
 * sessions are removed in the same transaction, so a crashed process cannot
 * leave a session behind as false evidence that it is still running — the
 * task it held then reaches the normal orphan/stall recovery paths.
 */
export function expireStaleRuntimeInstances(): {
  expired: number;
  agentsOffline: number;
  sessionsCleaned: number;
  pruned: number;
} {
  if (!isMultiRuntimeEnabled()) {
    return { expired: 0, agentsOffline: 0, sessionsCleaned: 0, pruned: 0 };
  }

  return getDb().transaction(() => {
    const cutoff = runtimeLivenessCutoff();
    // Still-active rows past the window are the crashed processes: they never
    // reached /close, so retiring them is what releases their work.
    const stale = getDb()
      .prepare<{ id: string; agent_id: string }, [string]>(
        `SELECT id, agent_id FROM runtime_instances
         WHERE status = 'active' AND last_seen_at < ?`,
      )
      .all(cutoff);

    let sessionsCleaned = 0;
    if (stale.length > 0) {
      const deleteSessions = getDb().prepare(
        "DELETE FROM active_sessions WHERE runtimeInstanceId = ?",
      );
      for (const { id } of stale) sessionsCleaned += deleteSessions.run(id).changes;
    }

    // Prune every row past the window, closed ones included. Runtime identity
    // is per boot, so keeping them would add a row per boot per agent forever
    // and nothing reads a runtime once it stops being live.
    const pruned = getDb()
      .prepare("DELETE FROM runtime_instances WHERE last_seen_at < ?")
      .run(cutoff).changes;

    let agentsOffline = 0;
    for (const agentId of new Set(stale.map((r) => r.agent_id))) {
      if (countActiveRuntimeInstancesForAgent(agentId) > 0) continue;
      const agent = getAgentById(agentId);
      if (!agent || agent.status === "offline") continue;
      updateAgentStatus(agentId, "offline");
      agentsOffline++;
    }
    return { expired: stale.length, agentsOffline, sessionsCleaned, pruned };
  })();
}
