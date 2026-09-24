import type {
  Agent,
  AgentAvatar,
  AgentCredStatus,
  AgentLog,
  AgentLogEventType,
  AgentSkill,
  AgentStatus,
  AgentTask,
  ProviderName,
  RoutingAffinity,
} from "../../types";
import { AgentAvatarSchema } from "../../types";
import { isEnvFlagEnabled } from "../../utils/env-flag";
import { getDbClient } from "./runtime";

type AgentDependencies = {
  createLogEntry: (entry: {
    eventType: AgentLogEventType;
    agentId?: string;
    oldValue?: string;
    newValue?: string;
  }) => Promise<AgentLog>;
  installSystemDefaultSkillsForAgent: (agentId: string) => Promise<AgentSkill[]>;
};

let dependencies: AgentDependencies;

// The facade registers deferred calls while it still owns logging and skills.
export function configureAgentDependencies(value: AgentDependencies): void {
  dependencies = value;
}

// ============================================================================
// Agent Queries
// ============================================================================

export type AgentRow = {
  id: string;
  name: string;
  isLead: number;
  status: AgentStatus;
  description: string | null;
  role: string | null;
  capabilities: string | null;
  maxTasks: number | null;
  emptyPollCount: number | null;
  claudeMd: string | null;
  soulMd: string | null;
  identityMd: string | null;
  setupScript: string | null;
  toolsMd: string | null;
  heartbeatMd: string | null;
  lastActivityAt: string | null;
  provider: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  /** JSON array of env-var names; populated only when status is `waiting_for_credentials`. */
  credentialMissing: string | null;
  /** Phase 1.5: per-agent harness provider pushed on worker registration. */
  harness_provider: string | null;
  /** Migration 055: worker-self-reported credential snapshot (JSON of AgentCredStatus). NULL = unreported. */
  cred_status: string | null;
  /** Migration 119: custom avatar (JSON of AgentAvatar). NULL = deterministic hash-derived fallback. */
  avatar: string | null;
};

/** Safe-parse the `avatar` JSON column. Malformed/invalid content (e.g. a
 * hand-edited row, or a future downgrade) falls back to `null` so rendering
 * always has a deterministic path — never throws. */
function parseAgentAvatar(raw: string | null): AgentAvatar | null {
  if (!raw) return null;
  try {
    const parsed = AgentAvatarSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Map an agent row to the `Agent` shape. When `slim` is true the six identity
 * markdown blobs (`claudeMd`/`soulMd`/`identityMd`/`toolsMd`/`heartbeatMd`/
 * `setupScript`) are omitted — they bloat list responses by ~16 KB/agent and
 * are never needed at the swarm-overview level. Fetch them via
 * `GET /api/agents/{id}` when required.
 */
export function rowToAgent(row: AgentRow, slim = false): Agent {
  const base: Agent = {
    id: row.id,
    name: row.name,
    isLead: row.isLead === 1,
    status: row.status,
    description: row.description ?? undefined,
    role: row.role ?? undefined,
    capabilities: row.capabilities ? JSON.parse(row.capabilities) : [],
    maxTasks: row.maxTasks ?? 1,
    emptyPollCount: row.emptyPollCount ?? 0,
    lastActivityAt: row.lastActivityAt ?? undefined,
    provider: (row.provider as ProviderName | null) ?? undefined,
    harnessProvider: (row.harness_provider as ProviderName | null) ?? null,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    credentialMissing: row.credentialMissing
      ? (JSON.parse(row.credentialMissing) as string[])
      : null,
    credStatus: row.cred_status ? (JSON.parse(row.cred_status) as AgentCredStatus) : null,
    avatar: parseAgentAvatar(row.avatar),
  };
  if (slim) return base;
  return {
    ...base,
    claudeMd: row.claudeMd ?? undefined,
    soulMd: row.soulMd ?? undefined,
    identityMd: row.identityMd ?? undefined,
    setupScript: row.setupScript ?? undefined,
    toolsMd: row.toolsMd ?? undefined,
    heartbeatMd: row.heartbeatMd ?? undefined,
  };
}

/**
 * Phase 3 of the worker credential safe-loop plan.
 *
 * `ready=true` clears the waiting state — the agent transitions to `idle`
 * and the dispatcher will start handing it tasks again.
 *
 * `ready=false` parks the agent on `waiting_for_credentials` with the env-var
 * names it's blocked on. The capacity dispatch query already filters
 * `status === 'idle'` so the new value is implicitly excluded with no other
 * code change.
 */
export async function updateAgentCredentialState(
  agentId: string,
  ready: boolean,
  missing: string[] | null,
): Promise<Agent | null> {
  const prev = await getAgentById(agentId);
  const status: AgentStatus = ready ? "idle" : "waiting_for_credentials";
  const missingJson = ready ? null : missing && missing.length > 0 ? JSON.stringify(missing) : null;
  const row = await getDbClient().get<AgentRow>(
    "UPDATE agents SET status = ?, credentialMissing = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *",
    [status, missingJson, agentId],
  );
  // Only clear the accumulated empty-poll count on a genuine recovery
  // (waiting_for_credentials -> ready), so routine post-task `ready:true`
  // reports don't clobber a legitimately accumulated count and defeat the
  // MAX_EMPTY_POLLS polling gate.
  if (ready && prev?.status === "waiting_for_credentials") await resetEmptyPollCount(agentId);
  return row ? rowToAgent(row) : null;
}

/**
 * Record which env vars a worker is missing without touching status — the
 * logical status is derived from runtime readiness in multi-runtime mode.
 */
export async function updateAgentCredentialMissing(
  agentId: string,
  missing: string[] | null,
): Promise<void> {
  const json = missing && missing.length > 0 ? JSON.stringify(missing) : null;
  await getDbClient().run(
    "UPDATE agents SET credentialMissing = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    [json, agentId],
  );
}

export async function createAgent(
  agent: Omit<Agent, "id" | "createdAt" | "lastUpdatedAt"> & { id?: string },
): Promise<Agent> {
  const id = agent.id ?? crypto.randomUUID();
  const maxTasks = agent.maxTasks ?? 1;
  const row = await getDbClient().get<AgentRow>(
    "INSERT INTO agents (id, name, isLead, status, maxTasks, provider, harness_provider, createdAt, lastUpdatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING *",
    [
      id,
      agent.name,
      agent.isLead ? 1 : 0,
      agent.status,
      maxTasks,
      agent.provider ?? null,
      agent.harnessProvider ?? null,
    ],
  );
  if (!row) throw new Error("Failed to create agent");
  try {
    await dependencies.installSystemDefaultSkillsForAgent(id);
  } catch (err) {
    console.warn(
      "[db] Failed to install system-default skills for new agent:",
      (err as Error).message,
    );
  }
  try {
    await dependencies.createLogEntry({
      eventType: "agent_joined",
      agentId: id,
      newValue: agent.status,
    });
  } catch {}
  return rowToAgent(row);
}

export async function getAgentById(id: string): Promise<Agent | null> {
  const row = await getDbClient().get<AgentRow>("SELECT * FROM agents WHERE id = ?", [id]);
  return row ? rowToAgent(row) : null;
}

/**
 * Role stamped on the `ext:<name>` agent row an extension authenticates as
 * (`src/extensions/identity.ts`). These rows are API identities, not workers:
 * they are hidden from agent listings and can never be assigned, offered, or
 * claim tasks. The rows themselves are kept so the extension can keep calling
 * the API and re-enabling it finds the same identity.
 */
export const EXTENSION_AGENT_ROLE = "extension";

/** SQL predicate that drops extension-identity rows from an `agents` scan. */
export const NOT_EXTENSION_AGENT_SQL = `COALESCE(role, '') != '${EXTENSION_AGENT_ROLE}'`;

export function isExtensionAgent(agent: Pick<Agent, "role"> | null | undefined): boolean {
  return agent?.role === EXTENSION_AGENT_ROLE;
}

export function extensionAgentAssignmentError(agent: Pick<Agent, "id" | "name">): string {
  return `Agent "${agent.name}" (${agent.id}) is an extension identity and cannot be assigned, offered, or scheduled tasks. Target a worker or lead agent instead.`;
}

/**
 * Thrown when an ordinary registration or profile update tries to grant the
 * reserved extension role, or to strip it from an extension identity. Only
 * `ensureExtensionAgent` may set it.
 */
export class ReservedAgentRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReservedAgentRoleError";
  }
}

/**
 * Returns the reason a role change is refused, or null when it is allowed.
 * `allowExtensionRole` is passed only by the extension identity lifecycle.
 */
export function reservedRoleViolation(
  currentRole: string | null | undefined,
  nextRole: string | undefined,
  opts?: { allowExtensionRole?: boolean },
): string | null {
  if (nextRole === undefined || nextRole === currentRole) return null;
  if (currentRole === EXTENSION_AGENT_ROLE) {
    return `Extension identities keep the "${EXTENSION_AGENT_ROLE}" role; it cannot be changed.`;
  }
  if (nextRole === EXTENSION_AGENT_ROLE && !opts?.allowExtensionRole) {
    return `Role "${EXTENSION_AGENT_ROLE}" is reserved for extension identities.`;
  }
  return null;
}

/** Thrown by task creation when the assignee or offer target is an extension identity. */
export class ExtensionAgentAssignmentError extends Error {
  constructor(agent: Pick<Agent, "id" | "name">) {
    super(extensionAgentAssignmentError(agent));
    this.name = "ExtensionAgentAssignmentError";
  }
}

/**
 * Lists agents ordered by name. Extension identities are excluded unless
 * `includeExtensions` is set; only the extension identity lifecycle and
 * name-collision checks need them.
 */
export async function getAllAgents(opts?: {
  slim?: boolean;
  includeExtensions?: boolean;
}): Promise<Agent[]> {
  const rows = await getDbClient().query<AgentRow>(
    opts?.includeExtensions
      ? "SELECT * FROM agents ORDER BY name"
      : `SELECT * FROM agents WHERE ${NOT_EXTENSION_AGENT_SQL} ORDER BY name`,
  );
  return rows.map((row) => rowToAgent(row, opts?.slim ?? false));
}

export async function getLeadAgent(): Promise<Agent | null> {
  const leads = (await getAllAgents()).filter((a) => a.isLead);
  // Prefer a usable (non-offline) lead so callers route to one that can actually
  // poll — e.g. an old offline lead must not shadow a live replacement. Falls
  // back to any lead (incl. offline) so existing "is there a lead at all?"
  // semantics are preserved; callers that require a live lead must check
  // `status` themselves (see escalateUnreclaimedResumes).
  return leads.find((a) => a.status !== "offline") ?? leads[0] ?? null;
}

export async function updateAgentStatus(id: string, status: AgentStatus): Promise<Agent | null> {
  const oldAgent = await getAgentById(id);
  const row = await getDbClient().get<AgentRow>(
    "UPDATE agents SET status = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *",
    [status, id],
  );
  if (row && oldAgent) {
    try {
      await dependencies.createLogEntry({
        eventType: "agent_status_change",
        agentId: id,
        oldValue: oldAgent.status,
        newValue: status,
      });
    } catch {}
  }
  return row ? rowToAgent(row) : null;
}

export async function updateAgentMaxTasks(id: string, maxTasks: number): Promise<Agent | null> {
  const row = await getDbClient().get<AgentRow>(
    `UPDATE agents SET maxTasks = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`,
    [maxTasks, id],
  );
  return row ? rowToAgent(row) : null;
}

export async function updateAgentProvider(
  id: string,
  provider: ProviderName,
): Promise<Agent | null> {
  const row = await getDbClient().get<AgentRow>(
    `UPDATE agents SET provider = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`,
    [provider, id],
  );
  return row ? rowToAgent(row) : null;
}

/**
 * Phase 1.5 (cloud-personalization): set the per-agent `harness_provider`
 * column. Pass `null` to clear. Validation against the canonical provider
 * list happens at the API layer via `ProviderNameSchema`.
 *
 * Returns the updated row, or null if the agent does not exist.
 */
export async function setAgentHarnessProvider(
  id: string,
  provider: ProviderName | null,
): Promise<Agent | null> {
  const row = await getDbClient().get<AgentRow>(
    `UPDATE agents SET harness_provider = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`,
    [provider, id],
  );
  return row ? rowToAgent(row) : null;
}

/**
 * Migration 055 — write the worker-self-reported credential snapshot.
 * Pass `null` to clear (e.g. on agent re-registration). Validation against
 * the JSON shape happens at the API layer via `AgentCredStatusSchema`.
 *
 * Worker reports this alongside the existing `updateAgentCredentialState`
 * call; we keep the writes in two functions so the dispatch pattern stays
 * one-row-one-fact, and the PATCH handler can choose which to call based
 * on which fields the request body carried.
 */
export async function updateAgentCredStatus(
  id: string,
  credStatus: AgentCredStatus | null,
): Promise<Agent | null> {
  const json = credStatus ? JSON.stringify(credStatus) : null;
  const row = await getDbClient().get<AgentRow>(
    `UPDATE agents SET cred_status = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`,
    [json, id],
  );
  return row ? rowToAgent(row) : null;
}

/**
 * Migration 055 — read all agents whose `harness_provider` matches a given
 * provider, with their reported `cred_status`. Used by the credential-status
 * API endpoint to roll up "is this provider working across the fleet?".
 *
 * Agents with NULL `cred_status` (never reported, or CRED_CHECK_DISABLE=1)
 * are still returned — the caller surfaces them as "unreported".
 */
export async function listAgentsWithCredStatusByProvider(provider: string): Promise<Agent[]> {
  const rows = await getDbClient().query<AgentRow>(
    `SELECT * FROM agents WHERE harness_provider = ? ORDER BY name`,
    [provider],
  );
  return rows.map((row) => rowToAgent(row));
}

/**
 * Phase 1.5 (cloud-personalization): aggregate count of registered agents
 * by `harness_provider`. NULL rows (agents that registered before the
 * migration or never pushed a value) are excluded — they show up in the
 * total agent count but not here.
 *
 * Used by future fleet displays. Not consumed in this phase.
 */
export async function getAgentHarnessProviders(): Promise<
  Array<{ provider: string; count: number }>
> {
  const rows = await getDbClient().query<{ provider: string; count: number }>(
    `SELECT harness_provider AS provider, COUNT(*) AS count
       FROM agents
       WHERE harness_provider IS NOT NULL
       GROUP BY harness_provider
       ORDER BY harness_provider`,
  );
  return rows.map((r) => ({ provider: r.provider, count: r.count }));
}

export async function updateAgentActivity(id: string): Promise<void> {
  await getDbClient().run(
    `UPDATE agents SET lastActivityAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    [id],
  );
}

// ============================================================================
// Agent Poll Tracking Functions
// ============================================================================

/** Maximum consecutive empty polls before agent should stop polling */
export const MAX_EMPTY_POLLS = 2;

/**
 * Increment the empty poll count for an agent.
 * Returns the new count after incrementing.
 */
export async function incrementEmptyPollCount(agentId: string): Promise<number> {
  const row = await getDbClient().get<{ emptyPollCount: number }>(
    `UPDATE agents
       SET emptyPollCount = emptyPollCount + 1,
           lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?
       RETURNING emptyPollCount`,
    [agentId],
  );
  return row?.emptyPollCount ?? 0;
}

/**
 * Reset the empty poll count for an agent to zero.
 * Called when a task is assigned or agent re-registers.
 */
export async function resetEmptyPollCount(agentId: string): Promise<void> {
  await getDbClient().run(
    `UPDATE agents
     SET emptyPollCount = 0,
         lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
    [agentId],
  );
}

/**
 * Check if an agent has exceeded the maximum empty poll count.
 */
export async function shouldBlockPolling(agentId: string): Promise<boolean> {
  const agent = await getAgentById(agentId);
  return (agent?.emptyPollCount ?? 0) >= MAX_EMPTY_POLLS;
}

export async function deleteAgent(id: string): Promise<boolean> {
  const agent = await getAgentById(id);
  if (agent) {
    try {
      await dependencies.createLogEntry({
        eventType: "agent_left",
        agentId: id,
        oldValue: agent.status,
      });
    } catch {}
  }
  const result = await getDbClient().run("DELETE FROM agents WHERE id = ?", [id]);
  return result.changes > 0;
}

// ============================================================================
// Agent Capacity Functions
// ============================================================================

/**
 * Get the count of active (in_progress) tasks for an agent.
 * Used to determine current capacity usage.
 */
/**
 * Tasks occupying one of the agent's concurrency slots.
 *
 * A claimed offer counts too — omitting it let a second concurrent poll take
 * another task past the limit. It is counted only through `offeredTo`, the
 * agent actually reviewing it: `agentId` on an offer may still be the lead
 * that created it, which would otherwise consume the lead's own capacity.
 */
export async function getActiveTaskCount(agentId: string): Promise<number> {
  const result = await getDbClient().get<{ count: number }>(
    `SELECT COUNT(*) as count FROM agent_tasks
     WHERE (agentId = ? AND status = 'in_progress')
        OR (offeredTo = ? AND status = 'reviewing')`,
    [agentId, agentId],
  );
  return result?.count ?? 0;
}

/**
 * Check if an agent has capacity to accept more tasks.
 */
export async function hasCapacity(agentId: string): Promise<boolean> {
  const agent = await getAgentById(agentId);
  if (!agent) return false;
  const activeCount = await getActiveTaskCount(agentId);
  return activeCount < (agent.maxTasks ?? 1);
}

/**
 * Get remaining capacity (available task slots) for an agent.
 */
export async function getRemainingCapacity(agentId: string): Promise<number> {
  const agent = await getAgentById(agentId);
  if (!agent) return 0;
  const activeCount = await getActiveTaskCount(agentId);
  return Math.max(0, (agent.maxTasks ?? 1) - activeCount);
}

/**
 * Update agent status based on current capacity.
 * Agent is 'busy' when any tasks are in progress, 'idle' when none.
 * Does not modify 'offline' status.
 */
export async function updateAgentStatusFromCapacity(agentId: string): Promise<void> {
  const agent = await getAgentById(agentId);
  if (!agent || agent.status === "offline") return;
  // `waiting_for_credentials` is owned by the worker's credential-wait
  // tick — task-completion shouldn't accidentally promote a blocked agent
  // back to idle.
  if (agent.status === "waiting_for_credentials") return;

  const activeCount = await getActiveTaskCount(agentId);
  const newStatus = activeCount > 0 ? "busy" : "idle";

  if (agent.status !== newStatus) {
    await updateAgentStatus(agentId, newStatus);
  }
}

// ============================================================================
// Routing Affinity (interrupted/pooled task role & capability gating)
// ============================================================================

/**
 * Kill-switch for the pool eligibility gate (`isAgentEligibleForTask` and its
 * callers: `claimTask`, `assignUnassignedTaskPending`,
 * `getUnassignedTaskIdsForAgent`). ON by default. Set to `0` to restore
 * pre-affinity behavior verbatim — mirrors the `HEARTBEAT_PIN_*_RESUME`
 * rollback convention. A function (read dynamically), not a module-load-time
 * const, so it can be toggled mid-test (see `isGracefulResumePinEnabled` in
 * src/tasks/worker-follow-up.ts for the same pattern).
 */
export function isPoolAffinityEnforcementEnabled(): boolean {
  return isEnvFlagEnabled("POOL_AFFINITY_ENFORCEMENT", true);
}

/**
 * Snapshot an agent's role/harness/capabilities into a `RoutingAffinity`
 * blob, for stamping onto a continuation task (resume, retry) at the moment
 * of interruption. Returns `null` when the agent row is already gone —
 * callers fall back to the parent's own (inherited) `routingAffinity` via
 * `createTaskExtended`'s parentTaskId inheritance block.
 */
export async function buildRoutingAffinityFromAgent(
  agentId: string,
): Promise<RoutingAffinity | null> {
  const agent = await getAgentById(agentId);
  if (!agent) return null;
  return {
    sourceAgentId: agent.id,
    role: agent.role,
    harnessProvider: agent.harnessProvider ?? agent.provider ?? undefined,
    capabilities: agent.capabilities ?? [],
  };
}

/**
 * The single eligibility gate every pool consumer (poll auto-claim,
 * `task-action claim`, `autoAssignPoolTasks`) MUST use before handing a task
 * to an agent. Exact-match on the snapshotted role string (no keyword
 * taxonomy in v1); `harnessProvider` is informational only and never
 * enforced (native session resume is deprecated). Missing role data on
 * either side is treated as INELIGIBLE — never fail-open to "anyone" — so a
 * capability-only requirement (no `role` set) can only ever be claimed by
 * its `sourceAgentId`, and otherwise queues until the starvation escalation
 * hands it to the Lead. Lead-only work is different: any Lead may claim it
 * (subject to explicitly required capabilities), because its source/role is
 * only recovery provenance and must not turn a worker's old role into a
 * constraint on the Lead pool.
 */
export function isAgentEligibleForTask(
  agent: Pick<Agent, "id" | "isLead" | "role" | "capabilities">,
  task: Pick<AgentTask, "routingAffinity" | "routingAffinityInvalid">,
): boolean {
  // Extension identities are API principals, never task executors.
  if (isExtensionAgent(agent)) return false;
  const affinity = task.routingAffinity;
  // A malformed persisted blob is a security boundary failure, not an
  // untagged task. Quarantine it from every assignment/claim path.
  if (task.routingAffinityInvalid) return false;
  if (!affinity) return true; // Untagged task — unchanged behavior.

  const requiredCapabilities = affinity.capabilities ?? [];
  const hasRequiredCapabilities = () => {
    const agentCapabilities = new Set(agent.capabilities ?? []);
    return requiredCapabilities.every((cap) => agentCapabilities.has(cap));
  };
  // Lead-only is an authorization boundary, never a best-effort pool hint or
  // a source-agent exception. Its explicit capability requirements remain
  // enforced even if the role/capability affinity kill-switch is enabled.
  // Do not require an unrelated worker role/source to match a Lead-only task.
  if (affinity.leadOnly) return agent.isLead && hasRequiredCapabilities();
  if (!isPoolAffinityEnforcementEnabled()) return true;

  if (affinity.sourceAgentId && affinity.sourceAgentId === agent.id) return true; // Own work.

  // A caller-declared capability requirement (`send-task`/`task-action`
  // `requiredCapabilities`) carries neither `role` nor `sourceAgentId` — those
  // are only stamped by `buildRoutingAffinityFromAgent` snapshots. Match it on
  // capabilities alone; requiring a role here made every such task unclaimable
  // and every direct assignment inheriting it rejected (issue #1601).
  if (!affinity.role && !affinity.sourceAgentId) return hasRequiredCapabilities();

  if (!agent.role || !affinity.role) return false; // Missing role data — no fail-open.
  if (agent.role !== affinity.role) return false;

  return hasRequiredCapabilities();
}
