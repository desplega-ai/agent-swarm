import {
  BaseRuntimePoolsRepository,
  type ControllerRuntimeRow,
  EMPTY,
  type RemoteControllerRow,
  RUNTIME_TASKLESS_TRIGGERS,
  type RuntimeCacheReleaseRow,
  type RuntimeInstanceRow,
  type SqlQuery,
  sql,
  sqlList,
} from "@desplega/storage";

/**
 * `resources` (TEXT holding a JSON object) has the number `value` under `key`,
 * or no value there and `value` equals `fallback` (SQLite:
 * `COALESCE(json_extract(resources, '$.key'), fallback) = value`). The values
 * compare as JSON, so a JSON string never equals a number, as on SQLite.
 */
function resourceEquals(key: string, fallback: number, value: number): SqlQuery {
  return sql`COALESCE(
      NULLIF(CAST(resources AS jsonb) -> CAST(${key} AS text), 'null'::jsonb),
      to_jsonb(CAST(${fallback} AS numeric))
    ) = to_jsonb(CAST(${value} AS numeric))`;
}

/** Insertion order is `_rowid`; JSON paths use the jsonb operators. */
export class PostgresRuntimePoolsRepository extends BaseRuntimePoolsRepository {
  listRemoteControllers(): Promise<RemoteControllerRow[]> {
    return this.db.query<RemoteControllerRow>(sql`
      SELECT id, status, updated_at, last_seen_at FROM runtime_controllers
      WHERE placement = 'remote' ORDER BY "_rowid"`);
  }

  async setResolvedImage(
    poolId: string,
    u: { name: string; image: string; cpu: number; memoryMb: number; now: string },
  ): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE runtime_pools SET resolved_image = ${u.name}, updated_at = ${u.now}
      WHERE id = ${poolId} AND image = ${u.image}
        AND ${resourceEquals("cpu", 4, u.cpu)}
        AND ${resourceEquals("memoryMb", 8192, u.memoryMb)}`);
    return result.changes;
  }

  listCacheReleases(): Promise<RuntimeCacheReleaseRow[]> {
    return this.db.query<RuntimeCacheReleaseRow>(sql`
      SELECT id, pool_id AS "poolId", controller_id AS "controllerId", owner_id AS "ownerId",
        cache_key AS key
      FROM runtime_cache_releases ORDER BY created_at, "_rowid"`);
  }

  async claimCacheRelease(id: string, claimedAt: string, staleBefore: string): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE runtime_cache_releases SET state = 'deleting', updated_at = ${claimedAt}
      WHERE id = ${id} AND (state = 'pending' OR updated_at < ${staleBefore}) AND NOT EXISTS (
        SELECT 1 FROM runtime_instances WHERE status != 'offline'
        AND id IN (SELECT jsonb_array_elements_text(runtime_cache_releases.runtime_ids))
      )`);
    return result.changes;
  }

  async listNonOfflinePoolRuntimeIds(poolId: string, controllerId: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT id FROM runtime_instances WHERE pool_id = ${poolId}
        AND (controller_id = ${controllerId} OR controller_id IS NULL) AND status != 'offline'
      ORDER BY "_rowid"`);
    return rows.map((row) => row.id);
  }

  async listNonOfflineControllerRuntimeIds(controllerId: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT id FROM runtime_instances WHERE controller_id = ${controllerId} AND status != 'offline'
      ORDER BY "_rowid"`);
    return rows.map((row) => row.id);
  }

  listControllerRuntimes(controllerId: string): Promise<ControllerRuntimeRow[]> {
    return this.db.query<ControllerRuntimeRow>(sql`
      SELECT id, status, external_handle FROM runtime_instances WHERE controller_id = ${controllerId}
      ORDER BY "_rowid"`);
  }

  async listUnadoptedProvisioningIds(controllerId: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT id FROM runtime_instances
      WHERE controller_id = ${controllerId} AND status = 'provisioning' AND external_handle IS NULL
      ORDER BY "_rowid"`);
    return rows.map((row) => row.id);
  }

  listAgentsForPool<T>(poolId: string): Promise<T[]> {
    return this.db.query<T>(
      sql`SELECT * FROM agents WHERE runtime_pool_id = ${poolId} ORDER BY name, "_rowid"`,
    );
  }

  async listPendingTaskIds(agentId: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT id FROM agent_tasks WHERE "agentId" = ${agentId} AND status = 'pending'
      ORDER BY "createdAt", "_rowid"`);
    return rows.map((row) => row.id);
  }

  listPendingWork<T>(agentId: string): Promise<T[]> {
    // priority is nullable: SQLite sorts NULL last in a descending order.
    return this.db.query<T>(sql`
      SELECT * FROM agent_tasks WHERE ("agentId" = ${agentId} AND status = 'pending')
        OR ("offeredTo" = ${agentId} AND status = 'offered')
      ORDER BY priority DESC NULLS LAST, "createdAt", "_rowid"`);
  }

  async listRuntimeSessionTaskIds(runtimeId: string): Promise<string[]> {
    const rows = await this.db.query<{ taskId: string }>(sql`
      SELECT "taskId" FROM active_sessions WHERE "runtimeInstanceId" = ${runtimeId} ORDER BY "_rowid"`);
    return rows.map((row) => row.taskId);
  }

  async listDispatchedTaskIdsWithoutSession(runtimeId: string): Promise<string[]> {
    const rows = await this.db.query<{ taskId: string }>(sql`
      SELECT t.id AS "taskId" FROM agent_tasks t
      WHERE (t.runtime_instance_id = ${runtimeId} OR t.id IN (
        SELECT task_id FROM runtime_instances WHERE id = ${runtimeId} AND agent_id = t."agentId"
      )) AND t.status = 'in_progress'
      AND NOT EXISTS (SELECT 1 FROM active_sessions s WHERE s."taskId" = t.id)
      ORDER BY t."_rowid"`);
    return rows.map((row) => row.taskId);
  }

  findBusyRuntimeSession(
    runtimeId: string,
    terminalStatuses: readonly string[],
    sessionCutoff: string,
  ): Promise<{ taskId: string } | null> {
    return this.db.get<{ taskId: string }>(sql`
      SELECT s."taskId" FROM active_sessions s LEFT JOIN agent_tasks t ON t.id = s."taskId"
      WHERE s."runtimeInstanceId" = ${runtimeId} AND (t.status NOT IN (${sqlList(terminalStatuses)})
        OR (t.id IS NULL AND s."triggerType" IN (${RUNTIME_TASKLESS_TRIGGERS})
          AND s."lastHeartbeatAt" >= ${sessionCutoff}))
      ORDER BY s."_rowid" LIMIT 1`);
  }

  listStaleUnpooledRuntimes(cutoff: string): Promise<{ id: string; agent_id: string }[]> {
    return this.db.query<{ id: string; agent_id: string }>(sql`
      SELECT id, agent_id FROM runtime_instances
       WHERE status = 'active' AND last_seen_at < ${cutoff} AND pool_id IS NULL
       ORDER BY "_rowid"`);
  }

  listRuntimesForPool(poolId: string): Promise<RuntimeInstanceRow[]> {
    return this.db.query<RuntimeInstanceRow>(
      sql`SELECT * FROM runtime_instances WHERE pool_id = ${poolId} ORDER BY created_at, "_rowid"`,
    );
  }

  listEligibleRuntimeSlots(
    seenSince: string,
    agentId?: string,
  ): Promise<{ agent_id: string; free_slots: number }[]> {
    // SQLite hands the groups over in agent_id order; ORDER BY makes it explicit.
    return this.db.query<{ agent_id: string; free_slots: number }>(sql`
      SELECT r.agent_id, CAST(SUM(GREATEST(0, r.reported_slots - GREATEST(
         (SELECT COUNT(*) FROM active_sessions WHERE "runtimeInstanceId" = r.id),
         CASE WHEN t.status IN ('in_progress', 'reviewing') THEN 1 ELSE 0 END
       ))) AS bigint) AS free_slots
       FROM runtime_instances r JOIN agents a ON a.id = r.agent_id
       LEFT JOIN runtime_pools p ON p.id = a.runtime_pool_id
       LEFT JOIN agent_tasks t ON t.id = r.task_id
       WHERE r.status = 'active' AND r.draining = ${false}
         AND (r.credential_ready IS NULL OR r.credential_ready = ${true})
         AND r.last_seen_at >= ${seenSince}
         AND (a.runtime_pool_id IS NULL OR p.enabled = ${true})
         AND (COALESCE(p.lifecycle, 'idle') != 'per-task' OR t.id IS NULL
           OR t.status NOT IN ('completed', 'failed', 'cancelled', 'superseded', 'skipped'))
         ${agentId ? sql`AND r.agent_id = ${agentId}` : EMPTY}
       GROUP BY r.agent_id
       ORDER BY r.agent_id`);
  }
}
