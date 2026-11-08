import type { Resource, ResourceCost } from "../../types";
import { getDbClient } from "../db";
import { insertResourceCost } from "./db";

export type { ResourceRate } from "../../resource-providers/types";

import type { ResourceRate } from "../../resource-providers/types";
export type BillingRow = {
  resourceId: string;
  generation: number;
  dimension: string;
  rateUsdPerMs: number;
  rateEffectiveAt: string;
  agentId: string;
  requestedByUserId: string | null;
  sourceTaskId: string;
  checkpointAt: string;
  leaseEndsAt: string;
  billableEndsAt: string | null;
  active: number;
  reserved: number;
  reservationStartsAt: string;
};
export function validateRates(rates: readonly ResourceRate[]) {
  if (!rates.length || new Set(rates.map((r) => r.dimension)).size !== rates.length)
    throw new Error("Explicit, unique billing dimensions are required.");
  for (const rate of rates)
    if (
      !rate.dimension ||
      !Number.isFinite(rate.usdPerMs) ||
      rate.usdPerMs < 0 ||
      !Number.isFinite(Date.parse(rate.effectiveAt))
    )
      throw new Error("Each billing rate requires a finite price and an effective date.");
}

export async function startBilling(
  resource: Resource,
  rates: readonly ResourceRate[],
  now: Date,
  end: Date,
) {
  validateRates(rates);
  for (const rate of rates)
    await getDbClient().run(
      `INSERT INTO resource_billing
      (resourceId,generation,dimension,rateUsdPerMs,rateEffectiveAt,agentId,requestedByUserId,sourceTaskId,checkpointAt,leaseEndsAt,active,reserved,reservationStartsAt,createdAt,updatedAt,created_by,updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,0,1,?,?,?,?,?)
      ON CONFLICT(resourceId,generation,dimension) DO UPDATE SET reserved=1, leaseEndsAt=excluded.leaseEndsAt, reservationStartsAt=excluded.reservationStartsAt, updatedAt=excluded.updatedAt`,
      [
        resource.id,
        resource.generation,
        rate.dimension,
        rate.usdPerMs,
        rate.effectiveAt,
        resource.creatorAgentId,
        resource.requestedByUserId,
        resource.sourceTaskId,
        now.toISOString(),
        end.toISOString(),
        now.toISOString(),
        now.toISOString(),
        now.toISOString(),
        null,
        null,
      ],
    );
}

/** Split half-open intervals at UTC midnight, the existing budget boundary. */
export function splitDays(start: string, end: string): [string, string][] {
  const parts: [string, string][] = [];
  let cursor = Date.parse(start);
  const until = Date.parse(end);
  if (!Number.isFinite(cursor) || !Number.isFinite(until))
    throw new Error("Invalid billing interval.");
  while (cursor < until) {
    const day = new Date(cursor);
    const next = Math.min(
      until,
      Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1),
    );
    parts.push([new Date(cursor).toISOString(), new Date(next).toISOString()]);
    cursor = next;
  }
  return parts;
}

async function writeCost(
  row: BillingRow,
  start: string,
  end: string,
  amount: number,
  source: ResourceCost["costSource"],
) {
  await insertResourceCost(
    {
      resourceId: row.resourceId,
      generation: row.generation,
      dimension: row.dimension,
      agentId: row.agentId,
      requestedByUserId: row.requestedByUserId,
      sourceTaskId: row.sourceTaskId,
      intervalStart: start,
      intervalEnd: end,
      amountUsd: amount,
      costSource: source,
      checkpointKey: `${row.resourceId}:${row.generation}:${row.dimension}:${start}:${end}`,
      rateUsdPerMs: row.rateUsdPerMs,
      rateEffectiveAt: row.rateEffectiveAt,
    },
    null,
  );
}

export async function checkpointCosts(now: Date, resourceId?: string) {
  await getDbClient().transaction(async (tx) => {
    const rows = await tx.query<BillingRow>(
      `SELECT * FROM resource_billing WHERE active=1${resourceId ? " AND resourceId=?" : ""}`,
      resourceId ? [resourceId] : [],
    );
    for (const row of rows) {
      const end = new Date(
        Math.min(now.getTime(), Date.parse(row.billableEndsAt ?? row.leaseEndsAt)),
      ).toISOString();
      for (const [start, until] of splitDays(row.checkpointAt, end)) {
        // Provider reports can precede the next estimate checkpoint.
        const reports = await tx.query<{ intervalStart: string; intervalEnd: string }>(
          `SELECT intervalStart,intervalEnd FROM resource_costs WHERE resourceId=? AND generation=? AND dimension=? AND costSource='provider' AND intervalStart<? AND intervalEnd>? ORDER BY intervalStart`,
          [row.resourceId, row.generation, row.dimension, until, start],
        );
        let cursor = start;
        for (const report of reports) {
          const before = report.intervalStart < until ? report.intervalStart : until;
          if (cursor < before)
            await writeCost(
              row,
              cursor,
              before,
              (Date.parse(before) - Date.parse(cursor)) * row.rateUsdPerMs,
              "estimated",
            );
          if (report.intervalEnd > cursor) cursor = report.intervalEnd;
        }
        if (cursor < until)
          await writeCost(
            row,
            cursor,
            until,
            (Date.parse(until) - Date.parse(cursor)) * row.rateUsdPerMs,
            "estimated",
          );
      }
      if (end > row.checkpointAt)
        await tx.run(
          "UPDATE resource_billing SET checkpointAt=?,updatedAt=? WHERE resourceId=? AND generation=? AND dimension=?",
          [end, now.toISOString(), row.resourceId, row.generation, row.dimension],
        );
    }
  });
}

/** Reports replace estimates for equivalent periods. Conflicting report overlaps require operator reconciliation. */
export async function reportResourceCost(
  input: {
    resourceId: string;
    generation: number;
    dimension: string;
    start: string;
    end: string;
    amountUsd: number;
  },
  now: Date,
) {
  if (
    !Number.isFinite(Date.parse(input.start)) ||
    !Number.isFinite(Date.parse(input.end)) ||
    new Date(input.start).toISOString() !== input.start ||
    new Date(input.end).toISOString() !== input.end ||
    !Number.isFinite(input.amountUsd) ||
    input.amountUsd < 0 ||
    input.start >= input.end ||
    Date.parse(input.end) > now.getTime()
  )
    throw new Error("Invalid provider billing report.");
  await getDbClient().transaction(async (tx) => {
    await checkpointCosts(now, input.resourceId);
    const row = await tx.get<BillingRow>(
      "SELECT * FROM resource_billing WHERE resourceId=? AND generation=? AND dimension=?",
      [input.resourceId, input.generation, input.dimension],
    );
    if (!row) throw new Error("The billing snapshot does not exist.");
    for (const [start, end] of splitDays(input.start, input.end)) {
      const overlapping = await tx.query<ResourceCost & { id: string }>(
        "SELECT * FROM resource_costs WHERE resourceId=? AND generation=? AND dimension=? AND intervalStart<? AND intervalEnd>?",
        [row.resourceId, row.generation, row.dimension, end, start],
      );
      for (const cost of overlapping) {
        if (
          cost.costSource === "provider" &&
          (cost.intervalStart !== start || cost.intervalEnd !== end)
        )
          throw new Error("Provider billing periods overlap.");
        await tx.run("DELETE FROM resource_costs WHERE id=?", [cost.id]);
        const duration = Date.parse(cost.intervalEnd) - Date.parse(cost.intervalStart);
        if (cost.intervalStart < start)
          await writeCost(
            row,
            cost.intervalStart,
            start,
            (cost.amountUsd * (Date.parse(start) - Date.parse(cost.intervalStart))) / duration,
            cost.costSource,
          );
        if (cost.intervalEnd > end)
          await writeCost(
            row,
            end,
            cost.intervalEnd,
            (cost.amountUsd * (Date.parse(cost.intervalEnd) - Date.parse(end))) / duration,
            cost.costSource,
          );
      }
      await writeCost(
        row,
        start,
        end,
        (input.amountUsd * (Date.parse(end) - Date.parse(start))) /
          (Date.parse(input.end) - Date.parse(input.start)),
        "provider",
      );
    }
  });
}

/** Read-only accrued spend also covers future task claims without mutating canClaim. */
export async function resourceSpend(
  date: string,
  scope?: { agentId?: string; userId?: string },
  now = new Date(),
): Promise<number> {
  const start = `${date}T00:00:00.000Z`;
  const end = new Date(Date.parse(start) + 86_400_000).toISOString();
  const filter = scope?.agentId
    ? " AND agentId=?"
    : scope?.userId
      ? " AND requestedByUserId=?"
      : "";
  const args = scope?.agentId ? [scope.agentId] : scope?.userId ? [scope.userId] : [];
  const stored = await getDbClient().get<{ total: number }>(
    `SELECT COALESCE(SUM(amountUsd),0) total FROM resource_costs WHERE intervalStart>=? AND intervalStart<?${filter}`,
    [start, end, ...args],
  );
  const active = await getDbClient().query<BillingRow>(
    `SELECT * FROM resource_billing WHERE active=1${filter}`,
    args,
  );
  let total = stored?.total ?? 0;
  for (const row of active) {
    const from = Math.max(Date.parse(row.checkpointAt), Date.parse(start));
    const until = Math.min(
      now.getTime(),
      Date.parse(row.billableEndsAt ?? row.leaseEndsAt),
      Date.parse(end),
    );
    total += Math.max(0, until - from) * row.rateUsdPerMs;
  }
  return total;
}
