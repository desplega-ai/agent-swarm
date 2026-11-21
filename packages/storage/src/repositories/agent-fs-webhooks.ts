import type { SqlExecutor } from "../executor";
import { sql } from "../sql";

/**
 * Domain: integrations, the agent-fs object webhook part
 * (`agent_fs_object_webhooks`). One row per agent-fs drive that holds
 * primitive objects. Rows come back in the SQLite value shape; timestamps are
 * the ISO text the caller wrote.
 */
export type AgentFsObjectWebhookRow = {
  id: string;
  orgId: string;
  driveId: string;
  subscriptionId: string | null;
  url: string | null;
  secretCiphertext: string | null;
  status: "pending" | "active" | "failed";
  lastError: string | null;
  claimedAt: string | null;
  attemptedAt: string | null;
  createdAt: string;
  updatedAt: string;
  created_by: string | null;
  updated_by: string | null;
};

export interface AgentFsWebhooksRepository {
  /** Inserts a `pending` row for the drive unless one exists. */
  insertPendingIfAbsent(id: string, orgId: string, driveId: string, now: string): Promise<void>;
  findByDrive(orgId: string, driveId: string): Promise<AgentFsObjectWebhookRow | null>;
  findById(id: string): Promise<AgentFsObjectWebhookRow | null>;
  /**
   * Takes the registration lease: sets `claimedAt = now` when no live lease
   * exists (`claimedAt` NULL or before `leaseCutoff`) and the row is not a
   * failure attempted after `retryCutoff`. True when this call took it.
   */
  claim(id: string, now: string, leaseCutoff: string, retryCutoff: string): Promise<boolean>;
  /** Marks the row registered and frees the lease. */
  markActive(
    id: string,
    update: { subscriptionId: string; url: string; secretCiphertext: string; now: string },
  ): Promise<void>;
  /** Marks the row failed and frees the lease; the stored secret stays. */
  markFailed(id: string, lastError: string, now: string): Promise<void>;
}

export abstract class BaseAgentFsWebhooksRepository implements AgentFsWebhooksRepository {
  constructor(protected readonly db: SqlExecutor) {}

  async insertPendingIfAbsent(
    id: string,
    orgId: string,
    driveId: string,
    now: string,
  ): Promise<void> {
    await this.db.run(sql`
      INSERT INTO agent_fs_object_webhooks (id, "orgId", "driveId", status, "createdAt", "updatedAt")
      VALUES (${id}, ${orgId}, ${driveId}, 'pending', ${now}, ${now})
      ON CONFLICT ("orgId", "driveId") DO NOTHING`);
  }

  findByDrive(orgId: string, driveId: string): Promise<AgentFsObjectWebhookRow | null> {
    return this.db.get<AgentFsObjectWebhookRow>(sql`
      SELECT * FROM agent_fs_object_webhooks WHERE "orgId" = ${orgId} AND "driveId" = ${driveId}`);
  }

  findById(id: string): Promise<AgentFsObjectWebhookRow | null> {
    return this.db.get<AgentFsObjectWebhookRow>(
      sql`SELECT * FROM agent_fs_object_webhooks WHERE id = ${id}`,
    );
  }

  async claim(id: string, now: string, leaseCutoff: string, retryCutoff: string): Promise<boolean> {
    const { changes } = await this.db.run(sql`
      UPDATE agent_fs_object_webhooks SET "claimedAt" = ${now}
       WHERE id = ${id} AND ("claimedAt" IS NULL OR "claimedAt" < ${leaseCutoff})
         AND NOT (status = 'failed' AND "attemptedAt" > ${retryCutoff})`);
    return changes > 0;
  }

  async markActive(
    id: string,
    u: { subscriptionId: string; url: string; secretCiphertext: string; now: string },
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE agent_fs_object_webhooks
         SET "subscriptionId" = ${u.subscriptionId}, url = ${u.url},
             "secretCiphertext" = ${u.secretCiphertext}, status = 'active',
             "lastError" = NULL, "claimedAt" = NULL, "attemptedAt" = ${u.now}, "updatedAt" = ${u.now}
       WHERE id = ${id}`);
  }

  async markFailed(id: string, lastError: string, now: string): Promise<void> {
    await this.db.run(sql`
      UPDATE agent_fs_object_webhooks
         SET status = 'failed', "lastError" = ${lastError}, "claimedAt" = NULL,
             "attemptedAt" = ${now}, "updatedAt" = ${now}
       WHERE id = ${id}`);
  }
}
