import { jsonText, likeAsciiCi, nowIso } from "../dialect";
import type { SqlExecutor } from "../executor";
import { EMPTY, type SqlQuery, sql, sqlList } from "../sql";

/**
 * Domain: runtime pools (`runtime_controllers`, `runtime_pools`,
 * `runtime_cache_releases`, the pool columns of `runtime_instances`), plus the
 * statements the pool supervisor runs against `agents` (pool binding and
 * provision retry columns), `active_sessions`, `agent_tasks`,
 * `channel_messages`, `session_tokens` (controller tokens) and `seed_state`
 * (the default pool marker).
 *
 * Rows come back in the SQLite value shape on every engine (flags 0/1, JSON as
 * text, timestamps as the text the column stores).
 *
 * "Insertion order" below means the order rows were inserted (SQLite: rowid).
 */

export type RuntimeControllerRow = {
  id: string;
  name: string;
  kind: string;
  placement: string;
  config: string;
  secretConfig: string | null;
  status: string;
  lastSeenAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RuntimePoolRow = {
  id: string;
  name: string;
  kind: string;
  placements: string;
  image: string | null;
  lifecycle: string;
  idleMinutes: number | null;
  slotsPerRuntime: number;
  maxRuntimes: number | null;
  minRuntimes: number;
  delivery: string | null;
  env: string;
  resources: string | null;
  cache: string | null;
  workspace: string | null;
  ttlSec: number | null;
  resolvedImage: string | null;
  enabled: number;
  consecutiveFailures: number;
  circuitOpenUntil: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewRuntimeController = {
  id: string;
  name: string;
  kind: string;
  placement: string;
  configJson: string;
  secretConfig: string | null;
  actor: string | null;
};

export type RuntimeControllerUpdate = {
  name: string;
  kind: string;
  placement: string;
  configJson: string;
  secretConfig: string | null;
  /** `null` keeps the stored `updated_by`. */
  actor: string | null;
  now: string;
};

/** Pool columns a create or update writes, JSON already serialized. */
export type RuntimePoolValues = {
  name: string;
  kind: string;
  placementsJson: string;
  image: string | null;
  lifecycle: string;
  idleMinutes: number | null;
  slotsPerRuntime: number;
  maxRuntimes: number | null;
  minRuntimes: number;
  delivery: string | null;
  envJson: string;
  resourcesJson: string | null;
  cacheJson: string | null;
  workspaceJson: string | null;
  ttlSec: number | null;
  enabled: boolean;
};

export type NewRuntimePool = RuntimePoolValues & { id: string; actor: string | null };

export type RuntimePoolUpdate = RuntimePoolValues & {
  resolvedImage: string | null;
  /** `null` keeps the stored `updated_by`. */
  actor: string | null;
  now: string;
};

export type NewRuntimeCacheRelease = {
  id: string;
  poolId: string;
  controllerId: string;
  ownerId: string;
  cacheKey: string;
  runtimeIdsJson: string;
  actor: string | null;
};

export type RuntimeCacheReleaseRow = {
  id: string;
  poolId: string;
  controllerId: string;
  ownerId: string;
  key: string;
};

export type ControllerRuntimeRow = { id: string; status: string; external_handle: string | null };

export type RemoteControllerRow = {
  id: string;
  status: string;
  updated_at: string;
  last_seen_at: string | null;
};

/** A `runtime_instances` row (SQLite value shape: flags 0/1, JSON as text). */
export type RuntimeInstanceRow = {
  id: string;
  agent_id: string;
  pool_id: string | null;
  controller_id: string | null;
  external_handle: string | null;
  provision_attempts: number;
  provision_error: string | null;
  provision_requested_at: string | null;
  draining: number;
  idle_since: string | null;
  lease_expires_at: string | null;
  task_id: string | null;
  workspace_slot?: number | null;
  status: string;
  reported_slots: number;
  credential_ready: number | null;
  metadata: string | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
};

/**
 * An `active` row of the agent seen at or after `since`. A workspace runtime
 * counts only once the supervisor stored its verified handle.
 */
const liveConfirmedRuntime = (id: string, agentId: string, since: string): SqlQuery => sql`
  id = ${id} AND agent_id = ${agentId} AND status = 'active' AND last_seen_at >= ${since}
  AND (workspace_slot IS NULL OR external_handle IS NOT NULL)`;

export interface RuntimePoolsRepository {
  // --- controllers ---
  /** Ordered by name (unique). */
  listControllers(): Promise<RuntimeControllerRow[]>;
  findController(id: string): Promise<RuntimeControllerRow | null>;
  /** Controllers holding encrypted secret config. Ordered by name (unique). */
  listControllersWithSecrets(): Promise<RuntimeControllerRow[]>;
  /** Id of a controller whose name is `name` or whose id is `id`. */
  findControllerIdByNameOrId(name: string, id: string): Promise<string | null>;
  findControllerIdByName(name: string): Promise<string | null>;
  /** True when another controller (not `exceptId`) has `name`. */
  controllerNameTaken(name: string, exceptId: string): Promise<boolean>;
  insertController(controller: NewRuntimeController): Promise<void>;
  updateController(id: string, update: RuntimeControllerUpdate): Promise<void>;
  deleteController(id: string): Promise<void>;
  /**
   * Writes the E2B config status. The error columns change only while they
   * are empty or hold an error that starts with `prefix`; the write is skipped
   * when the status and such an error are already current.
   */
  setControllerConfigStatus(
    id: string,
    update: {
      status: string;
      prefix: string;
      error: string | null;
      errorAt: string | null;
      now: string;
    },
  ): Promise<void>;
  setControllerStatus(id: string, status: string, now: string): Promise<void>;
  /** Online remote controller goes offline (conditional on `status = 'online'`). */
  markRemoteControllerOffline(id: string, now: string): Promise<void>;
  /** Remote-placement controllers, in insertion order. */
  listRemoteControllers(): Promise<RemoteControllerRow[]>;
  recordControllerError(id: string | null, error: string, now: string): Promise<void>;

  // --- pools ---
  /** Ordered by name (unique). */
  listPools(): Promise<RuntimePoolRow[]>;
  findPool(id: string): Promise<RuntimePoolRow | null>;
  findPoolIdByNameOrId(name: string, id: string): Promise<string | null>;
  /** True when another pool (not `exceptId`) has `name`. */
  poolNameTaken(name: string, exceptId: string): Promise<boolean>;
  insertPool(pool: NewRuntimePool): Promise<void>;
  updatePool(id: string, update: RuntimePoolUpdate): Promise<void>;
  deletePool(id: string): Promise<void>;
  /** The stored cache JSON and placements JSON of a pool. */
  findPoolCache(poolId: string): Promise<{ cache: string | null; placements: string } | null>;
  /**
   * Stores the built E2B template name, only while the pool still has `image`
   * and the same cpu/memory (defaults 4 and 8192). Returns the changed count.
   */
  setResolvedImage(
    poolId: string,
    update: { name: string; image: string; cpu: number; memoryMb: number; now: string },
  ): Promise<number>;
  /**
   * Counts one provision failure; opens the circuit until `openUntil` at
   * `threshold` consecutive failures or when it is already open. Returns the
   * resulting `circuit_open_until`, or null when the pool does not exist.
   */
  recordPoolProvisionFailure(
    poolId: string | null,
    update: { error: string; now: string; threshold: number; openUntil: string },
  ): Promise<{ circuit_open_until: string | null } | null>;
  /** Sets the cache warning, only while the error is empty or starts with `prefix`. */
  setPoolCacheError(
    poolId: string,
    update: { error: string | null; errorAt: string | null; prefix: string },
  ): Promise<void>;

  // --- cache releases ---
  hasCacheReleaseForController(controllerId: string): Promise<boolean>;
  /** No-op when (controller, owner, cache key) is already queued. */
  insertCacheRelease(release: NewRuntimeCacheRelease): Promise<void>;
  /** Ordered by created_at, then insertion order. */
  listCacheReleases(): Promise<RuntimeCacheReleaseRow[]>;
  /**
   * Claims a release (state `deleting`, updated_at = claimedAt) when it is
   * pending or its claim is older than `staleBefore`, and none of its runtimes
   * is still non-offline. Returns the changed count.
   */
  claimCacheRelease(id: string, claimedAt: string, staleBefore: string): Promise<number>;
  /** Deletes a release still held by the claim made at `claimedAt`. */
  deleteClaimedCacheRelease(id: string, claimedAt: string): Promise<void>;
  /** Returns a release held by the claim made at `claimedAt` to pending. */
  releaseCacheReleaseClaim(
    id: string,
    claimedAt: string,
    error: string,
    now: string,
  ): Promise<void>;

  // --- runtime instances ---
  hasNonOfflinePoolRuntime(poolId: string): Promise<boolean>;
  /** A non-offline pool runtime of the agent (any pool). */
  hasNonOfflineAgentPoolRuntime(agentId: string): Promise<boolean>;
  /** A provisioning, non-draining runtime of the agent in the pool. */
  hasProvisioningRuntime(agentId: string, poolId: string): Promise<boolean>;
  /**
   * Ids of the pool's non-offline runtimes on `controllerId` (or with no
   * controller), in insertion order.
   */
  listNonOfflinePoolRuntimeIds(poolId: string, controllerId: string): Promise<string[]>;
  /** Ids of the controller's non-offline runtimes, in insertion order. */
  listNonOfflineControllerRuntimeIds(controllerId: string): Promise<string[]>;
  /** The controller's runtimes, in insertion order. */
  listControllerRuntimes(controllerId: string): Promise<ControllerRuntimeRow[]>;
  /**
   * Stores the handle of a provision whose response never arrived. Matches a
   * non-offline runtime with no handle yet; returns its agent and slot.
   */
  adoptRemoteProvision(update: {
    runtimeId: string;
    controllerId: string;
    agentId: string;
    poolId: string;
    handleJson: string;
    now: string;
  }): Promise<{ agent_id: string; workspace_slot: number | null } | null>;
  /** Provisioning runtimes of the controller with no handle, in insertion order. */
  listUnadoptedProvisioningIds(controllerId: string): Promise<string[]>;
  /** Resumed runtime: last_seen_at = now, lease cleared (non-offline only). */
  markRuntimeResumed(runtimeId: string, now: string): Promise<void>;
  /** First provision error of a provisioning runtime. Returns the changed count. */
  setProvisionError(runtimeId: string, error: string): Promise<number>;
  /** Sets provision_error unless one is already stored. */
  setProvisionErrorIfUnset(runtimeId: string, error: string): Promise<void>;
  /** provision_attempts = the agent's attempts + 1, provision_requested_at = now. */
  recordProvisionRequest(runtimeId: string, agentId: string, now: string): Promise<void>;
  /** Stores the handle and lease; `createdAt` null keeps the stored created_at. */
  recordProvisioned(
    runtimeId: string,
    update: {
      handleJson: string;
      leaseExpiresAt: string | null;
      createdAt: string | null;
      now: string;
    },
  ): Promise<void>;
  /** Renewed lease (non-offline only). */
  setRuntimeLease(runtimeId: string, leaseExpiresAt: string, now: string): Promise<void>;
  /** Busy runtime: idle_since cleared; task_id set to `taskId` when that task exists. */
  markRuntimeBusy(runtimeId: string, draining: boolean, taskId: string | null): Promise<void>;
  setRuntimeIdleSince(runtimeId: string, idleSince: string): Promise<void>;
  setRuntimeDraining(runtimeId: string, draining: boolean): Promise<void>;
  /**
   * Runtimes of the pool holding an unrevoked session token that expires by
   * `expiresBy`, or created at or before `rotateAt`. Ordered by id.
   */
  listRotatingRuntimeIds(
    poolId: string,
    expiresBy: string,
    rotateAt: string | null,
  ): Promise<string[]>;

  // --- agents (pool binding and provision retry) ---
  /** Agents bound to the pool, ordered by name, then insertion order. */
  listAgentsForPool<T>(poolId: string): Promise<T[]>;
  /** Sets the agent's pool; returns the agent row, or null when missing. */
  bindAgent<T>(
    agentId: string,
    poolId: string | null,
    actor: string | null,
    now: string,
  ): Promise<T | null>;
  /** Unbinds every agent of the pool. */
  unbindPoolAgents(poolId: string, actor: string | null, now: string): Promise<void>;
  setAgentCreatedBy(agentId: string, actor: string | null): Promise<void>;
  /** Returns the new attempt count, or null when the agent is missing. */
  incrementProvisionAttempts(agentId: string): Promise<number | null>;
  setProvisionRetryAt(agentId: string, retryAt: string): Promise<void>;
  resetProvisionRetry(agentId: string): Promise<void>;
  resetPoolProvisionRetry(poolId: string | null): Promise<void>;
  getProvisionRetry(agentId: string): Promise<{
    runtime_provision_retry_at: string | null;
    runtime_provision_attempts: number;
  } | null>;

  // --- tasks and sessions the supervisor reads ---
  /** The agent's pending task ids, ordered by createdAt, then insertion order. */
  listPendingTaskIds(agentId: string): Promise<string[]>;
  /**
   * The agent's pending tasks and the tasks offered to it, ordered by priority
   * descending, createdAt, then insertion order.
   */
  listPendingWork<T>(agentId: string): Promise<T[]>;
  /** Channels with an unread, unclaimed message that mentions the agent. */
  countUnreadMentionChannels(agentId: string): Promise<number>;
  /** Task ids of the runtime's active sessions, in insertion order. */
  listRuntimeSessionTaskIds(runtimeId: string): Promise<string[]>;
  /**
   * In-progress tasks dispatched to the runtime (directly or as its current
   * task) with no active session, in insertion order.
   */
  listDispatchedTaskIdsWithoutSession(runtimeId: string): Promise<string[]>;
  deleteRuntimeSession(taskId: string, runtimeId: string): Promise<void>;
  hasRuntimeSession(runtimeId: string): Promise<boolean>;
  countRuntimeSessions(runtimeId: string): Promise<number>;
  /**
   * True when the runtime has a stale session: its task is terminal, or it has
   * no task and is not a taskless trigger or heartbeated before `sessionCutoff`.
   */
  hasStaleRuntimeSession(
    runtimeId: string,
    terminalStatuses: readonly string[],
    sessionCutoff: string,
  ): Promise<boolean>;
  deleteStaleRuntimeSessions(
    runtimeId: string,
    terminalStatuses: readonly string[],
    sessionCutoff: string,
  ): Promise<void>;
  /**
   * The task of the first (insertion order) session that keeps the runtime
   * busy: a non-terminal task, or a fresh taskless trigger. Null when none.
   */
  findBusyRuntimeSession(
    runtimeId: string,
    terminalStatuses: readonly string[],
    sessionCutoff: string,
  ): Promise<{ taskId: string } | null>;

  // --- controller tokens ---
  getSessionTokenExpiry(tokenId: string): Promise<string | null>;
  /** Unrevoked controller token ids, ordered by id. */
  listActiveControllerTokenIds(controllerId: string): Promise<string[]>;
  revokeControllerTokens(controllerId: string, now: string): Promise<void>;

  // --- seed marker ---
  hasSeedMarker(kind: string, key: string): Promise<boolean>;
  insertSeedMarker(kind: string, key: string, seededHash: string): Promise<void>;

  // --- runtime instance lifecycle (src/be/multi-runtime.ts) ---
  findRuntimeInstance(id: string): Promise<RuntimeInstanceRow | null>;
  /** True when `id` is a `provisioning` row of `agentId`. */
  isProvisioningRuntimeOf(id: string, agentId: string): Promise<boolean>;
  /**
   * Inserts an `active` row, or refreshes the row with that id (status,
   * slots, metadata unless null, last_seen_at, updated_at) only when it
   * belongs to the same agent. Null when the id belongs to another agent.
   */
  upsertActiveRuntime(row: {
    id: string;
    agentId: string;
    reportedSlots: number;
    metadata: string | null;
  }): Promise<RuntimeInstanceRow | null>;
  /** Clears the pool's failure count and open circuit. */
  resetPoolCircuit(poolId: string): Promise<void>;
  insertProvisioningRuntime(row: {
    id: string;
    agentId: string;
    poolId: string;
    controllerId: string;
    reportedSlots: number;
    workspaceSlot: number | null;
    now: string;
  }): Promise<RuntimeInstanceRow | null>;
  /** Workspace slots held by the agent's non-offline runtimes. Ascending. */
  listWorkspaceSlotsInUse(agentId: string): Promise<number[]>;
  /** Overwrites provision_error, whatever the row's state. */
  overwriteProvisionError(runtimeId: string, error: string): Promise<void>;
  /**
   * Refreshes last_seen_at / updated_at of an `active` row of the agent seen
   * at or after `since` whose workspace (if any) is confirmed. True when one matched.
   */
  touchLiveRuntime(id: string, agentId: string, since: string): Promise<boolean>;
  /** True when the row matches the `touchLiveRuntime` condition (read-only). */
  isLiveConfirmedRuntime(id: string, agentId: string, since: string): Promise<boolean>;
  /** Marks the agent's row offline and returns it, or null when none matched. */
  markRuntimeOffline(id: string, agentId: string): Promise<RuntimeInstanceRow | null>;
  /** `active` rows of the agent seen at or after `since`. */
  countLiveRuntimes(agentId: string, since: string): Promise<number>;
  /**
   * Every row of the agent, with `is_live` (1 when `active` and seen at or
   * after `since`, else 0). Ordered by created_at, then id.
   */
  listRuntimesForAgent(
    agentId: string,
    since: string,
  ): Promise<(RuntimeInstanceRow & { is_live: number })[]>;
  /** Sets credential_ready on an `active` row seen at or after `since`. True when one matched. */
  setRuntimeCredentialReady(
    id: string,
    agentId: string,
    ready: boolean,
    since: string,
  ): Promise<boolean>;
  /** True when a live row of the agent has credential_ready NULL or true. */
  hasReadyLiveRuntime(agentId: string, since: string): Promise<boolean>;
  /** Agents with an `active` row seen at or after `since`. Ordered by agent id. */
  listAgentIdsWithLiveRuntime(since: string): Promise<string[]>;
  /** Non-pool `active` rows last seen before `cutoff`. Insertion order. */
  listStaleUnpooledRuntimes(cutoff: string): Promise<{ id: string; agent_id: string }[]>;
  /**
   * Deletes rows last seen before `cutoff` that are not provisioning and are
   * either non-pool or offline. Returns the count.
   */
  pruneStaleRuntimes(cutoff: string): Promise<number>;
  /** Rows of the pool, ordered by created_at, then insertion order. */
  listRuntimesForPool(poolId: string): Promise<RuntimeInstanceRow[]>;
  /** Rows of every listed pool in one statement, ordered like `listRuntimesForPool`. */
  listRuntimesForPools(poolIds: readonly string[]): Promise<RuntimeInstanceRow[]>;

  // --- remote controller connection (src/http/controllers-connect.ts) ---
  /** Stores the connection error; an `online` controller stays online, any other goes offline. */
  recordControllerConnectionError(id: string, error: string, now: string): Promise<void>;
  /** Sets only the status column (updated_at unchanged). */
  setControllerStatusOnly(id: string, status: string): Promise<void>;
  /** Marks the controller online, seen at `seenAt`, and clears its last error. */
  markControllerOnline(id: string, seenAt: string, updatedAt: string): Promise<void>;
  /** Sets only last_seen_at. */
  touchControllerSeen(id: string, now: string): Promise<void>;
  /** Marks the controller offline, whatever its status, with updated_at and last_seen_at. */
  markControllerDisconnected(id: string, now: string): Promise<void>;
  /** Sets the runtime's current task id (scoped to its agent). */
  setRuntimeTask(runtimeId: string, agentId: string, taskId: string): Promise<void>;

  // --- pool routing and auth modes (src/be/runtime-pools/routing.ts, src/be/multi-runtime.ts) ---
  /**
   * Free slots per agent over its eligible runtimes: `active`, not draining,
   * credential ready (or unknown), seen at or after `seenSince`, in an enabled
   * pool (or none), and not held by a live task of a per-task pool. A runtime's
   * free slots are its reported slots minus the larger of its session count and
   * its own live task (never below 0). Only `agentId` when given. One row per
   * agent, in no particular order.
   */
  listEligibleRuntimeSlots(
    seenSince: string,
    agentId?: string,
  ): Promise<{ agent_id: string; free_slots: number }[]>;
  /** Distinct agents with a `provisioning`, non-draining runtime. In no particular order. */
  listProvisioningAgentIds(): Promise<string[]>;
  /**
   * One row per `active` runtime seen at or after `seenSince`: its agent and
   * `runtime_token` (1 when an unrevoked token of that runtime and agent expires
   * after `now`, else 0). In no particular order.
   */
  listLiveRuntimeAuthModes(
    now: string,
    seenSince: string,
  ): Promise<{ agent_id: string; runtime_token: number }[]>;
}

const CONTROLLER_COLUMNS = sql`id, name, kind, placement, config, secret_config AS "secretConfig",
  status, last_seen_at AS "lastSeenAt", last_error AS "lastError", last_error_at AS "lastErrorAt",
  created_by AS "createdBy", updated_by AS "updatedBy", created_at AS "createdAt", updated_at AS "updatedAt"`;

const POOL_COLUMNS = sql`id, name, kind, placements, image, lifecycle, idle_minutes AS "idleMinutes",
  slots_per_runtime AS "slotsPerRuntime", max_runtimes AS "maxRuntimes", min_runtimes AS "minRuntimes",
  delivery, env, resources, cache, workspace, ttl_sec AS "ttlSec", resolved_image AS "resolvedImage", enabled,
  consecutive_failures AS "consecutiveFailures", circuit_open_until AS "circuitOpenUntil",
  last_error AS "lastError", last_error_at AS "lastErrorAt", created_by AS "createdBy",
  updated_by AS "updatedBy", created_at AS "createdAt", updated_at AS "updatedAt"`;

/** Session triggers that run without a task. */
const TASKLESS_TRIGGERS = sql`'unread_mentions', 'pool_tasks_available', 'channel_activity'`;

export abstract class BaseRuntimePoolsRepository implements RuntimePoolsRepository {
  constructor(protected readonly db: SqlExecutor) {}

  // --- controllers ---

  listControllers(): Promise<RuntimeControllerRow[]> {
    return this.db.query<RuntimeControllerRow>(
      sql`SELECT ${CONTROLLER_COLUMNS} FROM runtime_controllers ORDER BY name`,
    );
  }

  findController(id: string): Promise<RuntimeControllerRow | null> {
    return this.db.get<RuntimeControllerRow>(
      sql`SELECT ${CONTROLLER_COLUMNS} FROM runtime_controllers WHERE id = ${id}`,
    );
  }

  listControllersWithSecrets(): Promise<RuntimeControllerRow[]> {
    return this.db.query<RuntimeControllerRow>(
      sql`SELECT ${CONTROLLER_COLUMNS} FROM runtime_controllers WHERE secret_config IS NOT NULL ORDER BY name`,
    );
  }

  async findControllerIdByNameOrId(name: string, id: string): Promise<string | null> {
    const row = await this.db.get<{ id: string }>(
      sql`SELECT id FROM runtime_controllers WHERE name = ${name} OR id = ${id}`,
    );
    return row?.id ?? null;
  }

  async findControllerIdByName(name: string): Promise<string | null> {
    const row = await this.db.get<{ id: string }>(
      sql`SELECT id FROM runtime_controllers WHERE name = ${name}`,
    );
    return row?.id ?? null;
  }

  async controllerNameTaken(name: string, exceptId: string): Promise<boolean> {
    return (
      (await this.db.get(
        sql`SELECT id FROM runtime_controllers WHERE name = ${name} AND id != ${exceptId}`,
      )) !== null
    );
  }

  async insertController(c: NewRuntimeController): Promise<void> {
    await this.db.run(sql`
      INSERT INTO runtime_controllers (id, name, kind, placement, config, secret_config, created_by, updated_by)
      VALUES (${c.id}, ${c.name}, ${c.kind}, ${c.placement}, ${jsonText(c.configJson)}, ${c.secretConfig}, ${c.actor}, ${c.actor})`);
  }

  async updateController(id: string, u: RuntimeControllerUpdate): Promise<void> {
    await this.db.run(sql`
      UPDATE runtime_controllers SET name = ${u.name}, kind = ${u.kind}, placement = ${u.placement},
        config = ${jsonText(u.configJson)}, secret_config = ${u.secretConfig},
        updated_by = COALESCE(${u.actor}, updated_by), updated_at = ${u.now}
      WHERE id = ${id}`);
  }

  async deleteController(id: string): Promise<void> {
    await this.db.run(sql`DELETE FROM runtime_controllers WHERE id = ${id}`);
  }

  async setControllerConfigStatus(
    id: string,
    u: {
      status: string;
      prefix: string;
      error: string | null;
      errorAt: string | null;
      now: string;
    },
  ): Promise<void> {
    const ours = sql`(last_error IS NULL OR substr(last_error, 1, ${u.prefix.length}) = ${u.prefix})`;
    await this.db.run(sql`
      UPDATE runtime_controllers SET status = ${u.status},
        last_error = CASE WHEN ${ours} THEN ${u.error} ELSE last_error END,
        last_error_at = CASE WHEN ${ours} THEN ${u.errorAt} ELSE last_error_at END,
        updated_at = ${u.now}
      WHERE id = ${id} AND (status != ${u.status} OR (${ours} AND last_error IS DISTINCT FROM ${u.error}))`);
  }

  async setControllerStatus(id: string, status: string, now: string): Promise<void> {
    await this.db.run(
      sql`UPDATE runtime_controllers SET status = ${status}, updated_at = ${now} WHERE id = ${id}`,
    );
  }

  async markRemoteControllerOffline(id: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE runtime_controllers SET status = 'offline', updated_at = ${now}, last_seen_at = ${now}
      WHERE id = ${id} AND status = 'online'`);
  }

  abstract listRemoteControllers(): Promise<RemoteControllerRow[]>;

  async recordControllerError(id: string | null, error: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE runtime_controllers SET last_error = ${error}, last_error_at = ${now}, updated_at = ${now}
      WHERE id = ${id}`);
  }

  // --- pools ---

  listPools(): Promise<RuntimePoolRow[]> {
    return this.db.query<RuntimePoolRow>(
      sql`SELECT ${POOL_COLUMNS} FROM runtime_pools ORDER BY name`,
    );
  }

  findPool(id: string): Promise<RuntimePoolRow | null> {
    return this.db.get<RuntimePoolRow>(
      sql`SELECT ${POOL_COLUMNS} FROM runtime_pools WHERE id = ${id}`,
    );
  }

  async findPoolIdByNameOrId(name: string, id: string): Promise<string | null> {
    const row = await this.db.get<{ id: string }>(
      sql`SELECT id FROM runtime_pools WHERE name = ${name} OR id = ${id}`,
    );
    return row?.id ?? null;
  }

  async poolNameTaken(name: string, exceptId: string): Promise<boolean> {
    return (
      (await this.db.get(
        sql`SELECT id FROM runtime_pools WHERE name = ${name} AND id != ${exceptId}`,
      )) !== null
    );
  }

  async insertPool(p: NewRuntimePool): Promise<void> {
    await this.db.run(sql`
      INSERT INTO runtime_pools (id, name, kind, placements, image, lifecycle, idle_minutes,
        slots_per_runtime, max_runtimes, min_runtimes, delivery, env, resources, cache, workspace,
        ttl_sec, enabled, created_by, updated_by)
      VALUES (${p.id}, ${p.name}, ${p.kind}, ${jsonText(p.placementsJson)}, ${p.image}, ${p.lifecycle},
        ${p.idleMinutes}, ${p.slotsPerRuntime}, ${p.maxRuntimes}, ${p.minRuntimes}, ${p.delivery},
        ${jsonText(p.envJson)}, ${p.resourcesJson}, ${jsonText(p.cacheJson)}, ${jsonText(p.workspaceJson)}, ${p.ttlSec},
        ${p.enabled}, ${p.actor}, ${p.actor})`);
  }

  async updatePool(id: string, u: RuntimePoolUpdate): Promise<void> {
    await this.db.run(sql`
      UPDATE runtime_pools SET name = ${u.name}, kind = ${u.kind}, placements = ${jsonText(u.placementsJson)},
        image = ${u.image}, resolved_image = ${u.resolvedImage}, lifecycle = ${u.lifecycle},
        idle_minutes = ${u.idleMinutes}, slots_per_runtime = ${u.slotsPerRuntime},
        max_runtimes = ${u.maxRuntimes}, min_runtimes = ${u.minRuntimes}, delivery = ${u.delivery},
        env = ${jsonText(u.envJson)}, resources = ${u.resourcesJson}, cache = ${jsonText(u.cacheJson)},
        workspace = ${jsonText(u.workspaceJson)}, ttl_sec = ${u.ttlSec}, enabled = ${u.enabled},
        updated_by = COALESCE(${u.actor}, updated_by), updated_at = ${u.now}
      WHERE id = ${id}`);
  }

  async deletePool(id: string): Promise<void> {
    await this.db.run(sql`DELETE FROM runtime_pools WHERE id = ${id}`);
  }

  findPoolCache(poolId: string): Promise<{ cache: string | null; placements: string } | null> {
    return this.db.get<{ cache: string | null; placements: string }>(
      sql`SELECT cache, placements FROM runtime_pools WHERE id = ${poolId}`,
    );
  }

  abstract setResolvedImage(
    poolId: string,
    update: { name: string; image: string; cpu: number; memoryMb: number; now: string },
  ): Promise<number>;

  recordPoolProvisionFailure(
    poolId: string | null,
    u: { error: string; now: string; threshold: number; openUntil: string },
  ): Promise<{ circuit_open_until: string | null } | null> {
    return this.db.get<{ circuit_open_until: string | null }>(sql`
      UPDATE runtime_pools SET consecutive_failures = consecutive_failures + 1,
        last_error = ${u.error}, last_error_at = ${u.now}, updated_at = ${u.now},
        circuit_open_until = CASE WHEN consecutive_failures + 1 >= ${u.threshold} OR circuit_open_until IS NOT NULL
          THEN ${u.openUntil} ELSE circuit_open_until END
      WHERE id = ${poolId}
      RETURNING circuit_open_until`);
  }

  async setPoolCacheError(
    poolId: string,
    u: { error: string | null; errorAt: string | null; prefix: string },
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE runtime_pools SET last_error = ${u.error}, last_error_at = ${u.errorAt}
      WHERE id = ${poolId} AND (last_error IS NULL OR substr(last_error, 1, ${u.prefix.length}) = ${u.prefix})`);
  }

  // --- cache releases ---

  async hasCacheReleaseForController(controllerId: string): Promise<boolean> {
    return (
      (await this.db.get(
        sql`SELECT id FROM runtime_cache_releases WHERE controller_id = ${controllerId} LIMIT 1`,
      )) !== null
    );
  }

  async insertCacheRelease(r: NewRuntimeCacheRelease): Promise<void> {
    await this.db.run(sql`
      INSERT INTO runtime_cache_releases
        (id, pool_id, controller_id, owner_id, cache_key, runtime_ids, created_by, updated_by)
      VALUES (${r.id}, ${r.poolId}, ${r.controllerId}, ${r.ownerId}, ${r.cacheKey}, ${jsonText(r.runtimeIdsJson)},
        ${r.actor}, ${r.actor})
      ON CONFLICT (controller_id, owner_id, cache_key) DO NOTHING`);
  }

  abstract listCacheReleases(): Promise<RuntimeCacheReleaseRow[]>;

  abstract claimCacheRelease(id: string, claimedAt: string, staleBefore: string): Promise<number>;

  async deleteClaimedCacheRelease(id: string, claimedAt: string): Promise<void> {
    await this.db.run(sql`
      DELETE FROM runtime_cache_releases
      WHERE id = ${id} AND state = 'deleting' AND updated_at = ${claimedAt}`);
  }

  async releaseCacheReleaseClaim(
    id: string,
    claimedAt: string,
    error: string,
    now: string,
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE runtime_cache_releases SET state = 'pending', last_error = ${error}, updated_at = ${now}
      WHERE id = ${id} AND state = 'deleting' AND updated_at = ${claimedAt}`);
  }

  // --- runtime instances ---

  async hasNonOfflinePoolRuntime(poolId: string): Promise<boolean> {
    return (
      (await this.db.get(
        sql`SELECT id FROM runtime_instances WHERE pool_id = ${poolId} AND status != 'offline' LIMIT 1`,
      )) !== null
    );
  }

  async hasNonOfflineAgentPoolRuntime(agentId: string): Promise<boolean> {
    return (
      (await this.db.get(sql`
        SELECT id FROM runtime_instances
        WHERE agent_id = ${agentId} AND pool_id IS NOT NULL AND status != 'offline' LIMIT 1`)) !==
      null
    );
  }

  async hasProvisioningRuntime(agentId: string, poolId: string): Promise<boolean> {
    return (
      (await this.db.get(sql`
        SELECT id FROM runtime_instances WHERE agent_id = ${agentId} AND pool_id = ${poolId}
          AND status = 'provisioning' AND draining = ${false} LIMIT 1`)) !== null
    );
  }

  abstract listNonOfflinePoolRuntimeIds(poolId: string, controllerId: string): Promise<string[]>;

  abstract listNonOfflineControllerRuntimeIds(controllerId: string): Promise<string[]>;

  abstract listControllerRuntimes(controllerId: string): Promise<ControllerRuntimeRow[]>;

  adoptRemoteProvision(u: {
    runtimeId: string;
    controllerId: string;
    agentId: string;
    poolId: string;
    handleJson: string;
    now: string;
  }): Promise<{ agent_id: string; workspace_slot: number | null } | null> {
    return this.db.get<{ agent_id: string; workspace_slot: number | null }>(sql`
      UPDATE runtime_instances SET external_handle = ${u.handleJson}, updated_at = ${u.now}
      WHERE id = ${u.runtimeId} AND controller_id = ${u.controllerId} AND agent_id = ${u.agentId}
        AND pool_id = ${u.poolId} AND status != 'offline' AND external_handle IS NULL
      RETURNING agent_id, workspace_slot`);
  }

  abstract listUnadoptedProvisioningIds(controllerId: string): Promise<string[]>;

  async markRuntimeResumed(runtimeId: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE runtime_instances SET last_seen_at = ${now}, lease_expires_at = NULL
      WHERE id = ${runtimeId} AND status != 'offline'`);
  }

  async setProvisionError(runtimeId: string, error: string): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE runtime_instances SET provision_error = ${error}
      WHERE id = ${runtimeId} AND status = 'provisioning' AND provision_error IS NULL`);
    return result.changes;
  }

  async setProvisionErrorIfUnset(runtimeId: string, error: string): Promise<void> {
    await this.db.run(sql`
      UPDATE runtime_instances SET provision_error = COALESCE(provision_error, ${error})
      WHERE id = ${runtimeId}`);
  }

  async recordProvisionRequest(runtimeId: string, agentId: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE runtime_instances SET provision_attempts =
          (SELECT runtime_provision_attempts + 1 FROM agents WHERE id = ${agentId}),
        provision_requested_at = ${now}
      WHERE id = ${runtimeId}`);
  }

  async recordProvisioned(
    runtimeId: string,
    u: { handleJson: string; leaseExpiresAt: string | null; createdAt: string | null; now: string },
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE runtime_instances SET external_handle = ${u.handleJson},
        lease_expires_at = ${u.leaseExpiresAt}, created_at = COALESCE(${u.createdAt}, created_at),
        updated_at = ${u.now}
      WHERE id = ${runtimeId}`);
  }

  async setRuntimeLease(runtimeId: string, leaseExpiresAt: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE runtime_instances SET lease_expires_at = ${leaseExpiresAt}, updated_at = ${now}
      WHERE id = ${runtimeId} AND status != 'offline'`);
  }

  async markRuntimeBusy(
    runtimeId: string,
    draining: boolean,
    taskId: string | null,
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE runtime_instances SET idle_since = NULL, draining = ${draining},
        task_id = COALESCE((SELECT id FROM agent_tasks WHERE id = ${taskId}), task_id)
      WHERE id = ${runtimeId}`);
  }

  async setRuntimeIdleSince(runtimeId: string, idleSince: string): Promise<void> {
    await this.db.run(
      sql`UPDATE runtime_instances SET idle_since = ${idleSince} WHERE id = ${runtimeId}`,
    );
  }

  async setRuntimeDraining(runtimeId: string, draining: boolean): Promise<void> {
    await this.db.run(
      sql`UPDATE runtime_instances SET draining = ${draining} WHERE id = ${runtimeId}`,
    );
  }

  async listRotatingRuntimeIds(
    poolId: string,
    expiresBy: string,
    rotateAt: string | null,
  ): Promise<string[]> {
    const aged = rotateAt === null ? EMPTY : sql` OR r.created_at <= ${rotateAt}`;
    const rows = await this.db.query<{ runtimeId: string }>(sql`
      SELECT DISTINCT r.id AS "runtimeId" FROM runtime_instances r
      LEFT JOIN session_tokens t ON r.id = t."runtimeId"
      WHERE r.pool_id = ${poolId}
        AND ((t."revokedAt" IS NULL AND t."expiresAt" <= ${expiresBy})${aged})
      ORDER BY r.id`);
    return rows.map((row) => row.runtimeId);
  }

  // --- agents ---

  abstract listAgentsForPool<T>(poolId: string): Promise<T[]>;

  bindAgent<T>(
    agentId: string,
    poolId: string | null,
    actor: string | null,
    now: string,
  ): Promise<T | null> {
    return this.db.get<T>(sql`
      UPDATE agents SET runtime_pool_id = ${poolId}, "lastUpdatedAt" = ${now},
        updated_by = COALESCE(${actor}, updated_by)
      WHERE id = ${agentId}
      RETURNING *`);
  }

  async unbindPoolAgents(poolId: string, actor: string | null, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE agents SET runtime_pool_id = NULL, "lastUpdatedAt" = ${now},
        updated_by = COALESCE(${actor}, updated_by)
      WHERE runtime_pool_id = ${poolId}`);
  }

  async setAgentCreatedBy(agentId: string, actor: string | null): Promise<void> {
    await this.db.run(
      sql`UPDATE agents SET created_by = ${actor}, updated_by = ${actor} WHERE id = ${agentId}`,
    );
  }

  async incrementProvisionAttempts(agentId: string): Promise<number | null> {
    const row = await this.db.get<{ runtime_provision_attempts: number }>(sql`
      UPDATE agents SET runtime_provision_attempts = runtime_provision_attempts + 1
      WHERE id = ${agentId}
      RETURNING runtime_provision_attempts`);
    return row?.runtime_provision_attempts ?? null;
  }

  async setProvisionRetryAt(agentId: string, retryAt: string): Promise<void> {
    await this.db.run(
      sql`UPDATE agents SET runtime_provision_retry_at = ${retryAt} WHERE id = ${agentId}`,
    );
  }

  async resetProvisionRetry(agentId: string): Promise<void> {
    await this.db.run(sql`
      UPDATE agents SET runtime_provision_attempts = 0, runtime_provision_retry_at = NULL
      WHERE id = ${agentId}`);
  }

  async resetPoolProvisionRetry(poolId: string | null): Promise<void> {
    await this.db.run(sql`
      UPDATE agents SET runtime_provision_attempts = 0, runtime_provision_retry_at = NULL
      WHERE runtime_pool_id = ${poolId}`);
  }

  getProvisionRetry(agentId: string): Promise<{
    runtime_provision_retry_at: string | null;
    runtime_provision_attempts: number;
  } | null> {
    return this.db.get<{
      runtime_provision_retry_at: string | null;
      runtime_provision_attempts: number;
    }>(sql`
      SELECT runtime_provision_retry_at, runtime_provision_attempts FROM agents WHERE id = ${agentId}`);
  }

  // --- tasks and sessions ---

  abstract listPendingTaskIds(agentId: string): Promise<string[]>;

  abstract listPendingWork<T>(agentId: string): Promise<T[]>;

  async countUnreadMentionChannels(agentId: string): Promise<number> {
    // mentions is a JSON array (jsonb on Postgres): the match runs on its text
    // form, where each id stays a quoted JSON string on both engines.
    const pattern = `%"${agentId}"%`;
    const row = await this.db.get<{ count: number }>(sql`
      SELECT COUNT(DISTINCT m."channelId") AS count FROM channel_messages m
      JOIN channels c ON c.id = m."channelId"
      LEFT JOIN channel_read_state s ON s."channelId" = m."channelId" AND s."agentId" = ${agentId}
      WHERE ${likeAsciiCi(sql`CAST(m.mentions AS TEXT)`, sql`${pattern}`)} AND s.processing_since IS NULL
        AND (s."lastReadAt" IS NULL OR m."createdAt" > s."lastReadAt")`);
    return Number(row?.count ?? 0);
  }

  abstract listRuntimeSessionTaskIds(runtimeId: string): Promise<string[]>;

  abstract listDispatchedTaskIdsWithoutSession(runtimeId: string): Promise<string[]>;

  async deleteRuntimeSession(taskId: string, runtimeId: string): Promise<void> {
    await this.db.run(sql`
      DELETE FROM active_sessions WHERE "taskId" = ${taskId} AND "runtimeInstanceId" = ${runtimeId}`);
  }

  async hasRuntimeSession(runtimeId: string): Promise<boolean> {
    return (
      (await this.db.get(
        sql`SELECT "taskId" FROM active_sessions WHERE "runtimeInstanceId" = ${runtimeId} LIMIT 1`,
      )) !== null
    );
  }

  async countRuntimeSessions(runtimeId: string): Promise<number> {
    const row = await this.db.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM active_sessions WHERE "runtimeInstanceId" = ${runtimeId}`,
    );
    return Number(row?.count ?? 0);
  }

  private staleSessionWhere(
    runtimeId: string,
    terminalStatuses: readonly string[],
    sessionCutoff: string,
  ) {
    return sql`"runtimeInstanceId" = ${runtimeId} AND NOT EXISTS (
        SELECT 1 FROM agent_tasks WHERE id = active_sessions."taskId"
          AND status NOT IN (${sqlList(terminalStatuses)})
      ) AND (EXISTS (SELECT 1 FROM agent_tasks WHERE id = active_sessions."taskId")
        OR "triggerType" NOT IN (${TASKLESS_TRIGGERS}) OR "lastHeartbeatAt" < ${sessionCutoff})`;
  }

  async hasStaleRuntimeSession(
    runtimeId: string,
    terminalStatuses: readonly string[],
    sessionCutoff: string,
  ): Promise<boolean> {
    return (
      (await this.db.get(sql`
        SELECT id FROM active_sessions
        WHERE ${this.staleSessionWhere(runtimeId, terminalStatuses, sessionCutoff)} LIMIT 1`)) !==
      null
    );
  }

  async deleteStaleRuntimeSessions(
    runtimeId: string,
    terminalStatuses: readonly string[],
    sessionCutoff: string,
  ): Promise<void> {
    await this.db.run(sql`
      DELETE FROM active_sessions
      WHERE ${this.staleSessionWhere(runtimeId, terminalStatuses, sessionCutoff)}`);
  }

  abstract findBusyRuntimeSession(
    runtimeId: string,
    terminalStatuses: readonly string[],
    sessionCutoff: string,
  ): Promise<{ taskId: string } | null>;

  // --- controller tokens ---

  async getSessionTokenExpiry(tokenId: string): Promise<string | null> {
    const row = await this.db.get<{ expiresAt: string }>(
      sql`SELECT "expiresAt" FROM session_tokens WHERE id = ${tokenId}`,
    );
    return row?.expiresAt ?? null;
  }

  async listActiveControllerTokenIds(controllerId: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT id FROM session_tokens
      WHERE "controllerId" = ${controllerId} AND "revokedAt" IS NULL
      ORDER BY id`);
    return rows.map((row) => row.id);
  }

  async revokeControllerTokens(controllerId: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE session_tokens SET "revokedAt" = ${now}
      WHERE "controllerId" = ${controllerId} AND "revokedAt" IS NULL`);
  }

  // --- seed marker ---

  async hasSeedMarker(kind: string, key: string): Promise<boolean> {
    return (
      (await this.db.get(sql`SELECT key FROM seed_state WHERE kind = ${kind} AND key = ${key}`)) !==
      null
    );
  }

  async insertSeedMarker(kind: string, key: string, seededHash: string): Promise<void> {
    await this.db.run(
      sql`INSERT INTO seed_state (kind, key, "seededHash") VALUES (${kind}, ${key}, ${seededHash})`,
    );
  }

  // --- runtime instance lifecycle ---

  findRuntimeInstance(id: string): Promise<RuntimeInstanceRow | null> {
    return this.db.get<RuntimeInstanceRow>(sql`SELECT * FROM runtime_instances WHERE id = ${id}`);
  }

  async isProvisioningRuntimeOf(id: string, agentId: string): Promise<boolean> {
    const row = await this.db.get<{ id: string }>(sql`
      SELECT id FROM runtime_instances
       WHERE id = ${id} AND status = 'provisioning' AND agent_id = ${agentId}`);
    return row !== null;
  }

  upsertActiveRuntime(r: {
    id: string;
    agentId: string;
    reportedSlots: number;
    metadata: string | null;
  }): Promise<RuntimeInstanceRow | null> {
    return this.db.get<RuntimeInstanceRow>(sql`
      INSERT INTO runtime_instances (id, agent_id, status, reported_slots, metadata)
      VALUES (${r.id}, ${r.agentId}, 'active', ${r.reportedSlots}, ${jsonText(r.metadata)})
      ON CONFLICT (id) DO UPDATE SET
        status = 'active',
        reported_slots = excluded.reported_slots,
        metadata = COALESCE(excluded.metadata, runtime_instances.metadata),
        last_seen_at = ${nowIso},
        updated_at = ${nowIso}
      WHERE runtime_instances.agent_id = excluded.agent_id
      RETURNING *`);
  }

  async resetPoolCircuit(poolId: string): Promise<void> {
    await this.db.run(sql`
      UPDATE runtime_pools SET consecutive_failures = 0, circuit_open_until = NULL
       WHERE id = ${poolId}`);
  }

  insertProvisioningRuntime(r: {
    id: string;
    agentId: string;
    poolId: string;
    controllerId: string;
    reportedSlots: number;
    workspaceSlot: number | null;
    now: string;
  }): Promise<RuntimeInstanceRow | null> {
    return this.db.get<RuntimeInstanceRow>(sql`
      INSERT INTO runtime_instances (id, agent_id, pool_id, controller_id, status,
        reported_slots, provision_requested_at, workspace_slot)
      VALUES (${r.id}, ${r.agentId}, ${r.poolId}, ${r.controllerId}, 'provisioning',
        ${r.reportedSlots}, ${r.now}, ${r.workspaceSlot})
      RETURNING *`);
  }

  async listWorkspaceSlotsInUse(agentId: string): Promise<number[]> {
    const rows = await this.db.query<{ slot: number }>(sql`
      SELECT workspace_slot AS slot FROM runtime_instances
       WHERE agent_id = ${agentId} AND workspace_slot IS NOT NULL AND status != 'offline'
       ORDER BY workspace_slot`);
    return rows.map((row) => row.slot);
  }

  async overwriteProvisionError(runtimeId: string, error: string): Promise<void> {
    await this.db.run(
      sql`UPDATE runtime_instances SET provision_error = ${error} WHERE id = ${runtimeId}`,
    );
  }

  async touchLiveRuntime(id: string, agentId: string, since: string): Promise<boolean> {
    const { changes } = await this.db.run(sql`
      UPDATE runtime_instances SET last_seen_at = ${nowIso}, updated_at = ${nowIso}
       WHERE ${liveConfirmedRuntime(id, agentId, since)}`);
    return changes > 0;
  }

  async isLiveConfirmedRuntime(id: string, agentId: string, since: string): Promise<boolean> {
    const row = await this.db.get<{ id: string }>(
      sql`SELECT id FROM runtime_instances WHERE ${liveConfirmedRuntime(id, agentId, since)}`,
    );
    return row !== null;
  }

  markRuntimeOffline(id: string, agentId: string): Promise<RuntimeInstanceRow | null> {
    return this.db.get<RuntimeInstanceRow>(sql`
      UPDATE runtime_instances SET status = 'offline', updated_at = ${nowIso}
       WHERE id = ${id} AND agent_id = ${agentId} RETURNING *`);
  }

  async countLiveRuntimes(agentId: string, since: string): Promise<number> {
    const row = await this.db.get<{ count: number }>(sql`
      SELECT COUNT(*) AS count FROM runtime_instances
       WHERE agent_id = ${agentId} AND status = 'active' AND last_seen_at >= ${since}`);
    return row?.count ?? 0;
  }

  listRuntimesForAgent(
    agentId: string,
    since: string,
  ): Promise<(RuntimeInstanceRow & { is_live: number })[]> {
    return this.db.query<RuntimeInstanceRow & { is_live: number }>(sql`
      SELECT *, CASE WHEN status = 'active' AND last_seen_at >= ${since} THEN 1 ELSE 0 END AS is_live
        FROM runtime_instances
       WHERE agent_id = ${agentId}
       ORDER BY created_at ASC, id ASC`);
  }

  async setRuntimeCredentialReady(
    id: string,
    agentId: string,
    ready: boolean,
    since: string,
  ): Promise<boolean> {
    const { changes } = await this.db.run(sql`
      UPDATE runtime_instances SET credential_ready = ${ready}, updated_at = ${nowIso}
       WHERE id = ${id} AND agent_id = ${agentId} AND status = 'active' AND last_seen_at >= ${since}`);
    return changes > 0;
  }

  async hasReadyLiveRuntime(agentId: string, since: string): Promise<boolean> {
    const row = await this.db.get<{ c: number }>(sql`
      SELECT COUNT(*) AS c FROM runtime_instances
       WHERE agent_id = ${agentId} AND status = 'active' AND last_seen_at >= ${since}
         AND (credential_ready IS NULL OR credential_ready = ${true})`);
    return (row?.c ?? 0) > 0;
  }

  async listAgentIdsWithLiveRuntime(since: string): Promise<string[]> {
    const rows = await this.db.query<{ agent_id: string }>(sql`
      SELECT DISTINCT agent_id FROM runtime_instances
       WHERE status = 'active' AND last_seen_at >= ${since}
       ORDER BY agent_id`);
    return rows.map((row) => row.agent_id);
  }

  /** Insertion order differs per engine (SQLite `rowid`). */
  abstract listStaleUnpooledRuntimes(cutoff: string): Promise<{ id: string; agent_id: string }[]>;

  async pruneStaleRuntimes(cutoff: string): Promise<number> {
    const { changes } = await this.db.run(sql`
      DELETE FROM runtime_instances
       WHERE last_seen_at < ${cutoff} AND status != 'provisioning'
         AND (pool_id IS NULL OR status = 'offline')`);
    return changes;
  }

  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listRuntimesForPool(poolId: string): Promise<RuntimeInstanceRow[]>;
  /** Insertion-order tiebreak differs per engine (SQLite `rowid`). */
  abstract listRuntimesForPools(poolIds: readonly string[]): Promise<RuntimeInstanceRow[]>;

  // --- remote controller connection ---

  async recordControllerConnectionError(id: string, error: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE runtime_controllers
         SET last_error = ${error}, last_error_at = ${now},
             status = CASE WHEN status = 'online' THEN status ELSE 'offline' END
       WHERE id = ${id}`);
  }

  async setControllerStatusOnly(id: string, status: string): Promise<void> {
    await this.db.run(sql`UPDATE runtime_controllers SET status = ${status} WHERE id = ${id}`);
  }

  async markControllerOnline(id: string, seenAt: string, updatedAt: string): Promise<void> {
    await this.db.run(sql`
      UPDATE runtime_controllers
         SET status = 'online', last_seen_at = ${seenAt}, updated_at = ${updatedAt},
             last_error = NULL, last_error_at = NULL
       WHERE id = ${id}`);
  }

  async touchControllerSeen(id: string, now: string): Promise<void> {
    await this.db.run(sql`UPDATE runtime_controllers SET last_seen_at = ${now} WHERE id = ${id}`);
  }

  async markControllerDisconnected(id: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE runtime_controllers SET status = 'offline', updated_at = ${now}, last_seen_at = ${now}
       WHERE id = ${id}`);
  }

  async setRuntimeTask(runtimeId: string, agentId: string, taskId: string): Promise<void> {
    await this.db.run(sql`
      UPDATE runtime_instances SET task_id = ${taskId}
       WHERE id = ${runtimeId} AND agent_id = ${agentId}`);
  }

  // --- pool routing and auth modes ---

  /** Scalar max of two values: kept per engine (SQLite `MAX(a, b)`). */
  abstract listEligibleRuntimeSlots(
    seenSince: string,
    agentId?: string,
  ): Promise<{ agent_id: string; free_slots: number }[]>;

  async listProvisioningAgentIds(): Promise<string[]> {
    const rows = await this.db.query<{ agent_id: string }>(sql`
      SELECT DISTINCT agent_id FROM runtime_instances
       WHERE status = 'provisioning' AND draining = ${false}`);
    return rows.map((row) => row.agent_id);
  }

  listLiveRuntimeAuthModes(
    now: string,
    seenSince: string,
  ): Promise<{ agent_id: string; runtime_token: number }[]> {
    return this.db.query<{ agent_id: string; runtime_token: number }>(sql`
      SELECT r.agent_id, CASE WHEN EXISTS(
         SELECT 1 FROM session_tokens s
         WHERE s."runtimeId" = r.id AND s."agentId" = r.agent_id
           AND s."revokedAt" IS NULL AND s."expiresAt" > ${now}
       ) THEN 1 ELSE 0 END AS runtime_token
       FROM runtime_instances r
       WHERE r.status = 'active' AND r.last_seen_at >= ${seenSince}`);
  }
}

/** The task-session triggers that run without a task, for engine overrides. */
export const RUNTIME_TASKLESS_TRIGGERS = TASKLESS_TRIGGERS;
