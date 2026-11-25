import type { DbClient } from "@desplega/storage";

export type BusClaim = { eventId: string; payload: unknown; claimedBy: string };

/** All ownership changes commit before the caller executes a handler. */
export class PostgresBusRepository {
  constructor(private readonly client: DbClient) {}

  async publish(id: string, topic: string, payload: unknown, groups: string[]): Promise<void> {
    await this.client.run(
      'INSERT INTO bus_events (id, topic, payload, "createdAt") VALUES ($1,$2,$3::text::jsonb,$4)',
      [id, topic, JSON.stringify(payload), Date.now()],
    );
    for (const group of groups) {
      await this.client.run(
        'INSERT INTO bus_deliveries ("eventId", "groupName", "availableAt") VALUES ($1,$2,$3)',
        [id, group, Date.now()],
      );
    }
  }

  async claim(topic: string, group: string, leaseMs: number): Promise<BusClaim | null> {
    return this.client.transaction(async () => {
      const now = Date.now();
      const row = await this.client.get<{ eventId: string }>(
        `SELECT d."eventId" FROM bus_deliveries d JOIN bus_events e ON e.id=d."eventId"
         WHERE e.topic=$1 AND d."groupName"=$2 AND
         ((d.status='pending' AND d."availableAt" <= $3) OR
          (d.status='claimed' AND d."leaseExpiresAt" <= $3))
         ORDER BY d."availableAt", d."eventId" LIMIT 1 FOR UPDATE OF d SKIP LOCKED`,
        [topic, group, now],
      );
      if (!row) return null;
      const claimedBy = crypto.randomUUID();
      await this.client.run(
        `UPDATE bus_deliveries SET status='claimed', attempts=attempts+1,
         "claimedBy"=$1,"leaseExpiresAt"=$2 WHERE "eventId"=$3 AND "groupName"=$4`,
        [claimedBy, now + leaseMs, row.eventId, group],
      );
      const event = await this.client.get<{ payload: unknown }>(
        "SELECT payload::text AS payload FROM bus_events WHERE id=$1",
        [row.eventId],
      );
      return event
        ? {
            ...row,
            payload: typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload,
            claimedBy,
          }
        : null;
    });
  }

  async settle(claim: BusClaim, group: string, success: boolean, retryMs: number): Promise<void> {
    await this.client.transaction(async () => {
      await this.client.run(
        `UPDATE bus_deliveries SET status=$1,"deliveredAt"=$2,"claimedBy"=NULL,
         "leaseExpiresAt"=NULL,"availableAt"=$3
         WHERE "eventId"=$4 AND "groupName"=$5 AND "claimedBy"=$6 AND status='claimed'`,
        [
          success ? "delivered" : "pending",
          success ? Date.now() : null,
          Date.now() + retryMs,
          claim.eventId,
          group,
          claim.claimedBy,
        ],
      );
    });
  }

  async prune(cutoff: number): Promise<number> {
    return this.client.transaction(async () => {
      const result = await this.client.run(
        `DELETE FROM bus_events WHERE id IN (
          SELECT e.id FROM bus_events e WHERE e."createdAt" < $1
          AND NOT EXISTS (SELECT 1 FROM bus_deliveries d WHERE d."eventId"=e.id
            AND (d.status != 'delivered' OR d."deliveredAt" >= $1))
          ORDER BY e."createdAt" LIMIT 500)`,
        [cutoff],
      );
      return result.changes;
    });
  }
}
