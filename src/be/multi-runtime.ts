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
  getActiveTaskCount,
  getAgentById,
  getDbClient,
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

export async function getAgentMaxTasksConfig(agentId: string): Promise<SwarmConfig | null> {
  return (
    (
      await getSwarmConfigs({ scope: "agent", scopeId: agentId, key: AGENT_MAX_TASKS_CONFIG_KEY })
    )[0] ?? null
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
export async function reconcileAgentMaxTasksPolicy(agentId: string): Promise<void> {
  const agent = await getAgentById(agentId);
  if (!agent) return;
  const existing = await getAgentMaxTasksConfig(agentId);
  if (existing) {
    const authoritative = parseAgentMaxTasksValue(existing.value);
    if (authoritative !== null && authoritative !== (agent.maxTasks ?? 1)) {
      await updateAgentMaxTasks(agentId, authoritative);
    }
    return;
  }
  await upsertSwarmConfig({
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
export async function resetAgentMaxTasksMirror(agentId: string): Promise<void> {
  const agent = await getAgentById(agentId);
  if (!agent) return;
  await updateAgentMaxTasks(agentId, defaultMaxTasksForAgent(agent));
}

/**
 * Config upsert that keeps the agents.maxTasks enforcement mirror in step
 * with an agent-scoped AGENT_MAX_TASKS write, in one transaction, so policy
 * and enforcement cannot diverge — including with no runtime connected.
 * Every other key passes straight through.
 */
export async function upsertSwarmConfigWithPolicyMirror(
  data: Parameters<typeof upsertSwarmConfig>[0],
): Promise<SwarmConfig> {
  const scopeId = data.scope === "agent" ? data.scopeId : null;
  if (!scopeId || data.key !== AGENT_MAX_TASKS_CONFIG_KEY) {
    return upsertSwarmConfig(data);
  }
  return await getDbClient().transaction(async () => {
    const row = await upsertSwarmConfig(data);
    // Guard, not validation — both write paths already ran validateConfigValue.
    const value = parseAgentMaxTasksValue(data.value);
    if (value !== null) await updateAgentMaxTasks(scopeId, value);
    return row;
  });
}

// ─── Runtime instances ───────────────────────────────────────────────────────

interface RuntimeInstanceRow {
  id: string;
  agent_id: string;
  status: string;
  reported_slots: number;
  credential_ready: number | null;
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
    credentialReady: row.credential_ready === null ? null : row.credential_ready === 1,
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
export async function upsertRuntimeInstance(instance: {
  id: string;
  agentId: string;
  reportedSlots: number;
  metadata?: Record<string, unknown> | null;
}): Promise<RuntimeInstance | null> {
  const metadataJson = instance.metadata ? JSON.stringify(instance.metadata) : null;
  const row = await getDbClient().get<RuntimeInstanceRow>(
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
    [instance.id, instance.agentId, instance.reportedSlots, metadataJson],
  );
  return row ? rowToRuntimeInstance(row) : null;
}

export async function getRuntimeInstanceById(id: string): Promise<RuntimeInstance | null> {
  const row = await getDbClient().get<RuntimeInstanceRow>(
    "SELECT * FROM runtime_instances WHERE id = ?",
    [id],
  );
  return row ? rowToRuntimeInstance(row) : null;
}

/**
 * Refresh a live runtime instance's liveness from the worker's ping cadence.
 *
 * Matches only a row that is already live and owned by the caller, so worker
 * traffic can refresh liveness but never resurrect a closed or expired
 * runtime — registration stays the only path back to `active`. Returns false
 * when nothing matched, which callers use as "this identity is not live".
 */
export async function touchRuntimeInstance(id: string, agentId: string): Promise<boolean> {
  const result = await getDbClient().run(
    `UPDATE runtime_instances
     SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND agent_id = ? AND status = 'active' AND last_seen_at >= ?`,
    [id, agentId, runtimeLivenessCutoff()],
  );
  return result.changes > 0;
}

/** Mark one runtime instance offline (scoped to its agent, like touch). */
export async function markRuntimeInstanceOffline(
  id: string,
  agentId: string,
): Promise<RuntimeInstance | null> {
  const row = await getDbClient().get<RuntimeInstanceRow>(
    `UPDATE runtime_instances
     SET status = 'offline', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND agent_id = ? RETURNING *`,
    [id, agentId],
  );
  return row ? rowToRuntimeInstance(row) : null;
}

/**
 * Runtimes currently serving an agent. A crashed process never reaches
 * `/close`, so `active` alone would keep a dead runtime counted forever;
 * liveness is therefore the conjunction of status and a fresh `last_seen_at`.
 */
export async function countActiveRuntimeInstancesForAgent(agentId: string): Promise<number> {
  const result = await getDbClient().get<{ count: number }>(
    `SELECT COUNT(*) as count FROM runtime_instances
     WHERE agent_id = ? AND status = 'active' AND last_seen_at >= ?`,
    [agentId, runtimeLivenessCutoff()],
  );
  return result?.count ?? 0;
}

/**
 * Read-only listing for operator observability. `isLive` applies the same
 * status+freshness conjunction as `isRuntimeInstanceLive`, so a stale row
 * that the sweep has not pruned yet is never reported as live.
 */
export async function listRuntimeInstancesForAgent(
  agentId: string,
): Promise<Array<RuntimeInstance & { isLive: boolean }>> {
  const rows = await getDbClient().query<RuntimeInstanceRow & { is_live: number }>(
    `SELECT *, (status = 'active' AND last_seen_at >= ?) AS is_live
     FROM runtime_instances
     WHERE agent_id = ?
     ORDER BY created_at ASC, id ASC`,
    [runtimeLivenessCutoff(), agentId],
  );
  return rows.map((row) => ({ ...rowToRuntimeInstance(row), isLive: row.is_live === 1 }));
}

/**
 * Whether this identity names a runtime of `agentId` that is still reporting.
 * Dispatch uses it so a retired process cannot be handed work alongside its
 * replacement; an absent identity is never live.
 */
export async function isRuntimeInstanceLive(
  id: string | undefined,
  agentId: string,
): Promise<boolean> {
  if (!id) return false;
  const row = await getDbClient().get<{ c: number }>(
    `SELECT COUNT(*) c FROM runtime_instances
     WHERE id = ? AND agent_id = ? AND status = 'active' AND last_seen_at >= ?`,
    [id, agentId, runtimeLivenessCutoff()],
  );
  return (row?.c ?? 0) > 0;
}

/**
 * Record this runtime's credential readiness. Process-local by design: a
 * sibling's state is never touched. Only a live runtime may report.
 */
export async function setRuntimeCredentialReady(
  id: string,
  agentId: string,
  ready: boolean,
): Promise<boolean> {
  const result = await getDbClient().run(
    `UPDATE runtime_instances
     SET credential_ready = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND agent_id = ? AND status = 'active' AND last_seen_at >= ?`,
    [ready ? 1 : 0, id, agentId, runtimeLivenessCutoff()],
  );
  return result.changes > 0;
}

/**
 * Whether any live runtime can currently execute work. A runtime that never
 * reported (NULL) counts as ready, so workers opting out of credential checks
 * stay dispatchable.
 */
export async function hasReadyLiveRuntime(agentId: string): Promise<boolean> {
  const row = await getDbClient().get<{ c: number }>(
    `SELECT COUNT(*) c FROM runtime_instances
     WHERE agent_id = ? AND status = 'active' AND last_seen_at >= ?
       AND (credential_ready IS NULL OR credential_ready = 1)`,
    [agentId, runtimeLivenessCutoff()],
  );
  return (row?.c ?? 0) > 0;
}

/**
 * Recompute the logical agent's state from its live runtimes.
 *
 * Precedence: no live runtime wins (offline), then active work (busy), then
 * credential availability, then idle. Aggregating here is what stops one
 * process's report from overwriting a sibling's — a waiting runtime cannot
 * park an agent a ready sibling is serving, and a ready one cannot pull a
 * busy agent back to idle.
 */
export async function reconcileAgentStatusFromRuntimes(agentId: string): Promise<void> {
  // Reads and the status write commit together: register and retire are
  // overlapping HTTP events, and a stale computation writing last would park
  // an agent offline while a live runtime is serving it.
  await getDbClient().transaction(async () => {
    const agent = await getAgentById(agentId);
    if (!agent) return;
    if ((await countActiveRuntimeInstancesForAgent(agentId)) === 0) {
      if (agent.status !== "offline") await updateAgentStatus(agentId, "offline");
      return;
    }
    if (!(await hasReadyLiveRuntime(agentId))) {
      if (agent.status !== "waiting_for_credentials") {
        await updateAgentStatus(agentId, "waiting_for_credentials");
      }
      return;
    }
    const next = (await getActiveTaskCount(agentId)) > 0 ? "busy" : "idle";
    if (agent.status !== next) await updateAgentStatus(agentId, next);
  });
}

/**
 * Agents with at least one runtime still reporting. While multi-runtime mode
 * is on this is the eligibility set for dispatch: an agent with no live
 * runtime — whether its runtimes died or it has not re-registered since the
 * flag was enabled — cannot poll for work, so assigning to it would strand
 * the task.
 */
export async function agentsWithLiveRuntime(): Promise<Set<string>> {
  const rows = await getDbClient().query<{ agent_id: string }>(
    `SELECT DISTINCT agent_id FROM runtime_instances
     WHERE status = 'active' AND last_seen_at >= ?`,
    [runtimeLivenessCutoff()],
  );
  return new Set(rows.map((r) => r.agent_id));
}

/**
 * Retire runtimes that stopped pinging and take their agents offline when
 * nothing live remains.
 *
 * Inert unless multi-runtime mode is on: after a rollback, workers stop
 * refreshing their rows, and expiring them would offline agents that are
 * running perfectly well under legacy semantics.
 *
 * Deleting the retired rows rather than keeping them is deliberate. Runtime
 * identity is per boot, so retaining them would grow the table once per boot
 * per agent forever; nothing reads a runtime after it stops being live.
 *
 * Expiry deliberately does NOT touch active_sessions. Runtime liveness and
 * in-flight work liveness answer different questions: a stale runtime row is
 * enough to stop NEW dispatch, but sessions are heartbeated by tool activity
 * only — a healthy worker inside a long model call or shell command can be
 * quiet past this cutoff — so it is not evidence the CURRENT work is dead.
 * Crash classification stays owned by the heartbeat's stalled-task
 * remediation, which requires both a stale session heartbeat and a stale
 * task before reclaiming (and cleans the session when it does); the sweep's
 * 30-minute stale-session cleanup backstops any leftover row.
 */
export async function expireStaleRuntimeInstances(): Promise<{
  expired: number;
  agentsOffline: number;
  pruned: number;
}> {
  if (!isMultiRuntimeEnabled()) {
    return { expired: 0, agentsOffline: 0, pruned: 0 };
  }

  return await getDbClient().transaction(async (tx) => {
    const cutoff = runtimeLivenessCutoff();
    // Still-active rows past the window never reached /close; retiring them
    // removes the process from new-work eligibility. Whether its in-flight
    // work is dead is decided separately (see doc comment above).
    const stale = await tx.query<{ id: string; agent_id: string }>(
      `SELECT id, agent_id FROM runtime_instances
       WHERE status = 'active' AND last_seen_at < ?`,
      [cutoff],
    );

    // Prune every row past the window, closed ones included. Runtime identity
    // is per boot, so keeping them would add a row per boot per agent forever
    // and nothing reads a runtime once it stops being live.
    const pruned = (await tx.run("DELETE FROM runtime_instances WHERE last_seen_at < ?", [cutoff]))
      .changes;

    // Recompute every affected agent from what survived: losing the only
    // ready runtime has to park the agent even though a waiting sibling is
    // still live, or the same sweep would assign work it cannot execute.
    let agentsOffline = 0;
    for (const agentId of new Set(stale.map((r) => r.agent_id))) {
      await reconcileAgentStatusFromRuntimes(agentId);
      if ((await getAgentById(agentId))?.status === "offline") agentsOffline++;
    }
    return { expired: stale.length, agentsOffline, pruned };
  });
}
