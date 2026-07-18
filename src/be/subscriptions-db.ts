import type {
  Subscription,
  SubscriptionDelivery,
  SubscriptionDeliveryStatus,
  SubscriptionTargetType,
  SwarmBusEvent,
} from "../subscriptions/types";
import { getDb } from "./db";

// SPIKE (extension system, Layer 1): CRUD for swarm_events / subscriptions /
// subscription_deliveries. Kept out of db.ts, following src/be/scripts/db.ts.

interface SubscriptionRow {
  id: string;
  name: string;
  description: string | null;
  eventPattern: string;
  filter: string | null;
  targetType: string;
  scriptName: string | null;
  scriptArgs: string | null;
  workflowId: string | null;
  enabled: number;
  createdByAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    eventPattern: row.eventPattern,
    filter: row.filter ? JSON.parse(row.filter) : undefined,
    targetType: row.targetType as SubscriptionTargetType,
    scriptName: row.scriptName ?? undefined,
    scriptArgs: row.scriptArgs ? JSON.parse(row.scriptArgs) : undefined,
    workflowId: row.workflowId ?? undefined,
    enabled: row.enabled === 1,
    createdByAgentId: row.createdByAgentId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createSubscription(args: {
  name: string;
  description?: string;
  eventPattern: string;
  filter?: unknown;
  targetType: SubscriptionTargetType;
  scriptName?: string;
  scriptArgs?: Record<string, unknown>;
  workflowId?: string;
  enabled?: boolean;
  createdByAgentId?: string;
}): Subscription {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO subscriptions
         (id, name, description, eventPattern, filter, targetType, scriptName,
          scriptArgs, workflowId, enabled, createdByAgentId, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      args.name,
      args.description ?? null,
      args.eventPattern,
      args.filter === undefined ? null : JSON.stringify(args.filter),
      args.targetType,
      args.scriptName ?? null,
      args.scriptArgs === undefined ? null : JSON.stringify(args.scriptArgs),
      args.workflowId ?? null,
      args.enabled === false ? 0 : 1,
      args.createdByAgentId ?? null,
      now,
      now,
    );
  const created = getSubscriptionById(id);
  if (!created) throw new Error("Failed to create subscription");
  return created;
}

export function getSubscriptionById(id: string): Subscription | null {
  const row = getDb()
    .prepare("SELECT * FROM subscriptions WHERE id = ?")
    .get(id) as SubscriptionRow | null;
  return row ? rowToSubscription(row) : null;
}

export function getSubscriptionByName(name: string): Subscription | null {
  const row = getDb()
    .prepare("SELECT * FROM subscriptions WHERE name = ?")
    .get(name) as SubscriptionRow | null;
  return row ? rowToSubscription(row) : null;
}

export function listSubscriptions(args?: { enabledOnly?: boolean }): Subscription[] {
  const rows = (
    args?.enabledOnly
      ? getDb().prepare("SELECT * FROM subscriptions WHERE enabled = 1 ORDER BY name")
      : getDb().prepare("SELECT * FROM subscriptions ORDER BY name")
  ).all() as SubscriptionRow[];
  return rows.map(rowToSubscription);
}

export function setSubscriptionEnabled(id: string, enabled: boolean): boolean {
  const res = getDb()
    .prepare("UPDATE subscriptions SET enabled = ?, updatedAt = ? WHERE id = ?")
    .run(enabled ? 1 : 0, new Date().toISOString(), id);
  return res.changes > 0;
}

export function updateSubscription(
  id: string,
  patch: {
    description?: string;
    eventPattern?: string;
    filter?: unknown | null;
    scriptArgs?: Record<string, unknown> | null;
    enabled?: boolean;
  },
): Subscription | null {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.description !== undefined) {
    sets.push("description = ?");
    values.push(patch.description);
  }
  if (patch.eventPattern !== undefined) {
    sets.push("eventPattern = ?");
    values.push(patch.eventPattern);
  }
  if (patch.filter !== undefined) {
    sets.push("filter = ?");
    values.push(patch.filter === null ? null : JSON.stringify(patch.filter));
  }
  if (patch.scriptArgs !== undefined) {
    sets.push("scriptArgs = ?");
    values.push(patch.scriptArgs === null ? null : JSON.stringify(patch.scriptArgs));
  }
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    values.push(patch.enabled ? 1 : 0);
  }
  if (sets.length === 0) return getSubscriptionById(id);
  sets.push("updatedAt = ?");
  values.push(new Date().toISOString());
  values.push(id);
  getDb()
    .prepare(`UPDATE subscriptions SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(values as (string | number | null)[]));
  return getSubscriptionById(id);
}

export function deleteSubscription(id: string): boolean {
  const res = getDb().prepare("DELETE FROM subscriptions WHERE id = ?").run(id);
  return res.changes > 0;
}

// --- events -----------------------------------------------------------------

export function recordSwarmBusEvent(name: string, data: unknown): SwarmBusEvent {
  const event: SwarmBusEvent = {
    id: crypto.randomUUID(),
    name,
    data,
    emittedAt: new Date().toISOString(),
  };
  getDb()
    .prepare("INSERT INTO swarm_events (id, name, data, emittedAt) VALUES (?, ?, ?, ?)")
    .run(event.id, event.name, data === undefined ? null : JSON.stringify(data), event.emittedAt);
  return event;
}

export function getSwarmBusEventById(id: string): SwarmBusEvent | null {
  const row = getDb().prepare("SELECT * FROM swarm_events WHERE id = ?").get(id) as {
    id: string;
    name: string;
    data: string | null;
    emittedAt: string;
  } | null;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    data: row.data ? JSON.parse(row.data) : undefined,
    emittedAt: row.emittedAt,
  };
}

// --- deliveries -------------------------------------------------------------

interface DeliveryRow {
  id: string;
  subscriptionId: string;
  eventId: string;
  status: string;
  attempts: number;
  claimedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  result: string | null;
  createdAt: string;
}

function rowToDelivery(row: DeliveryRow): SubscriptionDelivery {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    eventId: row.eventId,
    status: row.status as SubscriptionDeliveryStatus,
    attempts: row.attempts,
    claimedAt: row.claimedAt ?? undefined,
    finishedAt: row.finishedAt ?? undefined,
    error: row.error ?? undefined,
    result: row.result ? JSON.parse(row.result) : undefined,
    createdAt: row.createdAt,
  };
}

export function createDelivery(subscriptionId: string, eventId: string): SubscriptionDelivery {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO subscription_deliveries (id, subscriptionId, eventId, createdAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (subscriptionId, eventId) DO NOTHING`,
    )
    .run(id, subscriptionId, eventId, now);
  const row = getDb()
    .prepare("SELECT * FROM subscription_deliveries WHERE subscriptionId = ? AND eventId = ?")
    .get(subscriptionId, eventId) as DeliveryRow;
  return rowToDelivery(row);
}

/**
 * Atomically claim up to `limit` pending deliveries (pending → running).
 * The UPDATE-with-subselect is atomic per statement under SQLite, which is
 * enough to prevent double-claims across this process's timers; multi-replica
 * claim/lease semantics are out of scope for the spike (gap #12 in the
 * research doc).
 */
export function claimPendingDeliveries(limit: number): SubscriptionDelivery[] {
  const now = new Date().toISOString();
  const db = getDb();
  const claimed = db
    .prepare(
      `UPDATE subscription_deliveries
       SET status = 'running', claimedAt = ?, attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM subscription_deliveries
         WHERE status = 'pending'
         ORDER BY createdAt
         LIMIT ?
       )
       RETURNING *`,
    )
    .all(now, limit) as DeliveryRow[];
  return claimed.map(rowToDelivery);
}

export function finishDelivery(
  id: string,
  outcome:
    | { status: "succeeded"; result?: unknown }
    | { status: "failed"; error: string; retry: boolean },
): void {
  const now = new Date().toISOString();
  if (outcome.status === "succeeded") {
    getDb()
      .prepare(
        `UPDATE subscription_deliveries
         SET status = 'succeeded', finishedAt = ?, result = ?, error = NULL
         WHERE id = ?`,
      )
      .run(now, outcome.result === undefined ? null : JSON.stringify(outcome.result), id);
    return;
  }
  if (outcome.retry) {
    getDb()
      .prepare("UPDATE subscription_deliveries SET status = 'pending', error = ? WHERE id = ?")
      .run(outcome.error, id);
    return;
  }
  getDb()
    .prepare(
      `UPDATE subscription_deliveries
       SET status = 'failed', finishedAt = ?, error = ?
       WHERE id = ?`,
    )
    .run(now, outcome.error, id);
}

export function getDeliveryById(id: string): SubscriptionDelivery | null {
  const row = getDb()
    .prepare("SELECT * FROM subscription_deliveries WHERE id = ?")
    .get(id) as DeliveryRow | null;
  return row ? rowToDelivery(row) : null;
}

export function listDeliveriesForSubscription(
  subscriptionId: string,
  limit = 20,
): SubscriptionDelivery[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM subscription_deliveries
       WHERE subscriptionId = ? ORDER BY createdAt DESC LIMIT ?`,
    )
    .all(subscriptionId, limit) as DeliveryRow[];
  return rows.map(rowToDelivery);
}

/**
 * Journal retention: prune finished deliveries (succeeded after 14 days,
 * failed after 30) and swarm_events rows that no delivery references anymore.
 * Called opportunistically from the dispatcher (~hourly).
 */
export function pruneSubscriptionJournal(now = new Date()): {
  deliveries: number;
  events: number;
} {
  const iso = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
  const db = getDb();
  const deliveries =
    db
      .prepare(
        `DELETE FROM subscription_deliveries
         WHERE (status = 'succeeded' AND finishedAt < ?)
            OR (status = 'failed' AND finishedAt < ?)`,
      )
      .run(iso(14), iso(30)).changes ?? 0;
  const events =
    db
      .prepare(
        `DELETE FROM swarm_events
         WHERE emittedAt < ?
           AND id NOT IN (SELECT eventId FROM subscription_deliveries)`,
      )
      .run(iso(30)).changes ?? 0;
  return { deliveries, events };
}
