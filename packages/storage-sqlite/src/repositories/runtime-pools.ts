import {
  BaseRuntimePoolsRepository,
  type ControllerRuntimeRow,
  type RemoteControllerRow,
  RUNTIME_TASKLESS_TRIGGERS,
  type RuntimeCacheReleaseRow,
  type RuntimeInstanceRow,
  sql,
  sqlList,
} from "@desplega/storage";

/** Insertion order is rowid; JSON paths use json_extract / json_each. */
export class SqliteRuntimePoolsRepository extends BaseRuntimePoolsRepository {
  listRemoteControllers(): Promise<RemoteControllerRow[]> {
    return this.db.query<RemoteControllerRow>(sql`
      SELECT id, status, updated_at, last_seen_at FROM runtime_controllers
      WHERE placement = 'remote' ORDER BY rowid`);
  }

  async setResolvedImage(
    poolId: string,
    u: { name: string; image: string; cpu: number; memoryMb: number; now: string },
  ): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE runtime_pools SET resolved_image = ${u.name}, updated_at = ${u.now}
      WHERE id = ${poolId} AND image = ${u.image}
        AND COALESCE(json_extract(resources, '$.cpu'), 4) = ${u.cpu}
        AND COALESCE(json_extract(resources, '$.memoryMb'), 8192) = ${u.memoryMb}`);
    return result.changes;
  }

  listCacheReleases(): Promise<RuntimeCacheReleaseRow[]> {
    return this.db.query<RuntimeCacheReleaseRow>(sql`
      SELECT id, pool_id AS "poolId", controller_id AS "controllerId", owner_id AS "ownerId",
        cache_key AS key
      FROM runtime_cache_releases ORDER BY created_at, rowid`);
  }

  async claimCacheRelease(id: string, claimedAt: string, staleBefore: string): Promise<number> {
    const result = await this.db.run(sql`
      UPDATE runtime_cache_releases SET state = 'deleting', updated_at = ${claimedAt}
      WHERE id = ${id} AND (state = 'pending' OR updated_at < ${staleBefore}) AND NOT EXISTS (
        SELECT 1 FROM runtime_instances WHERE status != 'offline'
        AND id IN (SELECT value FROM json_each(runtime_cache_releases.runtime_ids))
      )`);
    return result.changes;
  }

  async listNonOfflinePoolRuntimeIds(poolId: string, controllerId: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT id FROM runtime_instances WHERE pool_id = ${poolId}
        AND (controller_id = ${controllerId} OR controller_id IS NULL) AND status != 'offline'
      ORDER BY rowid`);
    return rows.map((row) => row.id);
  }

  async listNonOfflineControllerRuntimeIds(controllerId: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT id FROM runtime_instances WHERE controller_id = ${controllerId} AND status != 'offline'
      ORDER BY rowid`);
    return rows.map((row) => row.id);
  }

  listControllerRuntimes(controllerId: string): Promise<ControllerRuntimeRow[]> {
    return this.db.query<ControllerRuntimeRow>(sql`
      SELECT id, status, external_handle FROM runtime_instances WHERE controller_id = ${controllerId}
      ORDER BY rowid`);
  }

  async listUnadoptedProvisioningIds(controllerId: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT id FROM runtime_instances
      WHERE controller_id = ${controllerId} AND status = 'provisioning' AND external_handle IS NULL
      ORDER BY rowid`);
    return rows.map((row) => row.id);
  }

  listAgentsForPool<T>(poolId: string): Promise<T[]> {
    return this.db.query<T>(
      sql`SELECT * FROM agents WHERE runtime_pool_id = ${poolId} ORDER BY name, rowid`,
    );
  }

  async listPendingTaskIds(agentId: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT id FROM agent_tasks WHERE "agentId" = ${agentId} AND status = 'pending'
      ORDER BY "createdAt", rowid`);
    return rows.map((row) => row.id);
  }

  listPendingWork<T>(agentId: string): Promise<T[]> {
    return this.db.query<T>(sql`
      SELECT * FROM agent_tasks WHERE ("agentId" = ${agentId} AND status = 'pending')
        OR ("offeredTo" = ${agentId} AND status = 'offered')
      ORDER BY priority DESC, "createdAt", rowid`);
  }

  async listRuntimeSessionTaskIds(runtimeId: string): Promise<string[]> {
    const rows = await this.db.query<{ taskId: string }>(sql`
      SELECT "taskId" FROM active_sessions WHERE "runtimeInstanceId" = ${runtimeId} ORDER BY rowid`);
    return rows.map((row) => row.taskId);
  }

  async listDispatchedTaskIdsWithoutSession(runtimeId: string): Promise<string[]> {
    const rows = await this.db.query<{ taskId: string }>(sql`
      SELECT t.id AS "taskId" FROM agent_tasks t
      WHERE (t.runtime_instance_id = ${runtimeId} OR t.id IN (
        SELECT task_id FROM runtime_instances WHERE id = ${runtimeId} AND agent_id = t."agentId"
      )) AND t.status = 'in_progress'
      AND NOT EXISTS (SELECT 1 FROM active_sessions s WHERE s."taskId" = t.id)
      ORDER BY t.rowid`);
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
      ORDER BY s.rowid LIMIT 1`);
  }

  listStaleUnpooledRuntimes(cutoff: string): Promise<{ id: string; agent_id: string }[]> {
    return this.db.query<{ id: string; agent_id: string }>(sql`
      SELECT id, agent_id FROM runtime_instances
       WHERE status = 'active' AND last_seen_at < ${cutoff} AND pool_id IS NULL
       ORDER BY rowid`);
  }

  listRuntimesForPool(poolId: string): Promise<RuntimeInstanceRow[]> {
    return this.db.query<RuntimeInstanceRow>(
      sql`SELECT * FROM runtime_instances WHERE pool_id = ${poolId} ORDER BY created_at, rowid`,
    );
  }
}
