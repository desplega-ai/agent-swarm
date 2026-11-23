import type { SqlExecutor } from "../executor";
import { sql } from "../sql";

/**
 * Domain: improvements (`improvements`), the drafts of product feedback an
 * install sends upstream after a person approves them. Rows come back in the
 * SQLite value shape; timestamps are the ISO text the caller wrote.
 */
export type ImprovementRow = {
  id: string;
  text: string;
  email: string | null;
  status: string;
  source: string;
  requested_by_agent_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  sent_at: string | null;
  proxy_status: number | null;
  proxy_id: string | null;
  proxy_error: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
};

export type NewImprovement = {
  id: string;
  text: string;
  source: string;
  requestedByAgentId: string | null;
  createdBy: string | null;
  now: string;
};

/** The statuses a person can still act on (approve or discard). */
const ACTIONABLE = sql`('pending_approval', 'failed')`;

export interface ImprovementsRepository {
  findById(id: string): Promise<ImprovementRow | null>;
  /**
   * Every actionable row (`pending_approval`, `failed`) plus the newest
   * `historyLimit` other rows. Ordered by created_at descending, then id descending.
   */
  listActionableAndHistory(historyLimit: number): Promise<ImprovementRow[]>;
  /** Inserts a `pending_approval` row. */
  insert(row: NewImprovement): Promise<void>;
  /**
   * Moves an actionable row to `sending` with its approval and clears the
   * last proxy result. True when this call claimed it.
   */
  claimForSend(
    id: string,
    claim: { approvedBy: string; email: string; now: string; updatedBy: string | null },
  ): Promise<boolean>;
  recordSendResult(
    id: string,
    result: {
      status: string;
      sentAt: string | null;
      proxyStatus: number | null;
      proxyId: string | null;
      proxyError: string | null;
      now: string;
    },
  ): Promise<void>;
  /** Moves an actionable row to `discarded`. True when this call changed it. */
  discard(id: string, now: string, updatedBy: string | null): Promise<boolean>;
}

export abstract class BaseImprovementsRepository implements ImprovementsRepository {
  constructor(protected readonly db: SqlExecutor) {}

  findById(id: string): Promise<ImprovementRow | null> {
    return this.db.get<ImprovementRow>(sql`SELECT * FROM improvements WHERE id = ${id}`);
  }

  listActionableAndHistory(historyLimit: number): Promise<ImprovementRow[]> {
    return this.db.query<ImprovementRow>(sql`
      SELECT * FROM improvements WHERE status IN ${ACTIONABLE}
      UNION ALL
      SELECT * FROM (
        SELECT * FROM improvements WHERE status NOT IN ${ACTIONABLE}
         ORDER BY created_at DESC, id DESC LIMIT ${historyLimit}
      ) AS history
      ORDER BY created_at DESC, id DESC`);
  }

  async insert(r: NewImprovement): Promise<void> {
    await this.db.run(sql`
      INSERT INTO improvements
        (id, text, status, source, requested_by_agent_id, created_at, updated_at, created_by, updated_by)
      VALUES (${r.id}, ${r.text}, 'pending_approval', ${r.source}, ${r.requestedByAgentId},
        ${r.now}, ${r.now}, ${r.createdBy}, ${r.createdBy})`);
  }

  async claimForSend(
    id: string,
    c: { approvedBy: string; email: string; now: string; updatedBy: string | null },
  ): Promise<boolean> {
    const { changes } = await this.db.run(sql`
      UPDATE improvements
         SET status = 'sending', approved_by = ${c.approvedBy}, approved_at = ${c.now},
             email = ${c.email}, proxy_status = NULL, proxy_id = NULL, proxy_error = NULL,
             updated_at = ${c.now}, updated_by = ${c.updatedBy}
       WHERE id = ${id} AND status IN ${ACTIONABLE}`);
    return changes === 1;
  }

  async recordSendResult(
    id: string,
    r: {
      status: string;
      sentAt: string | null;
      proxyStatus: number | null;
      proxyId: string | null;
      proxyError: string | null;
      now: string;
    },
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE improvements
         SET status = ${r.status}, sent_at = ${r.sentAt}, proxy_status = ${r.proxyStatus},
             proxy_id = ${r.proxyId}, proxy_error = ${r.proxyError}, updated_at = ${r.now}
       WHERE id = ${id}`);
  }

  async discard(id: string, now: string, updatedBy: string | null): Promise<boolean> {
    const { changes } = await this.db.run(sql`
      UPDATE improvements SET status = 'discarded', updated_at = ${now}, updated_by = ${updatedBy}
       WHERE id = ${id} AND status IN ${ACTIONABLE}`);
    return changes === 1;
  }
}
