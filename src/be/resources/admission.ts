import { ResourceProviderError } from "../../resource-providers/types";
import type { Resource } from "../../types";
import { isEnvFlagEnabled } from "../../utils/env-flag";
import { canClaim } from "../budget-admission";
import {
  getBudget,
  getDailySpendForAgent,
  getDailySpendForUser,
  getDailySpendGlobal,
  getDbClient,
} from "../db";
import { resourceConfig } from "./config";
import { type BillingRow, checkpointCosts, type ResourceRate, startBilling } from "./costs";

/** Call inside a short admission transaction. Provider calls are forbidden here. */
export async function admitResource(
  resource: Resource,
  rates: readonly ResourceRate[],
  maxContinuousMs: number,
  now: Date,
) {
  const previous = await getDbClient().query<BillingRow>(
    "SELECT * FROM resource_billing WHERE resourceId=? AND generation=?",
    [resource.id, resource.generation],
  );
  if (previous.length)
    rates = previous.map((row) => ({
      dimension: row.dimension,
      usdPerMs: row.rateUsdPerMs,
      effectiveAt: row.rateEffectiveAt,
    }));
  const continuous = await getDbClient().get<{ continuousStartedAt: string | null }>(
    "SELECT continuousStartedAt FROM resources WHERE id=?",
    [resource.id],
  );
  const restarting = ["paused", "stopped", "provisioning"].includes(resource.state);
  const continuousStart =
    restarting || !continuous?.continuousStartedAt ? now : new Date(continuous.continuousStartedAt);
  const config = await resourceConfig();
  if (config.access !== "public") throw new Error("Private resource previews are not supported.");
  const counts = await getDbClient().get<{ swarm: number; tree: number }>(
    "SELECT COUNT(*) swarm, COALESCE(SUM(CASE WHEN rootTaskId=? THEN 1 ELSE 0 END),0) tree FROM resources WHERE liveReservation=1 AND id<>?",
    [resource.rootTaskId, resource.id],
  );
  if (
    (counts?.swarm ?? 0) >= config.RESOURCE_SWARM_CAP ||
    (counts?.tree ?? 0) >= config.RESOURCE_TREE_CAP
  )
    throw new ResourceProviderError("capacity", "The live resource capacity is exhausted.");
  if (
    resource.profileId &&
    (await getDbClient().get(
      "SELECT 1 FROM resources WHERE profileId=? AND liveReservation=1 AND id<>?",
      [resource.profileId, resource.id],
    ))
  )
    throw new ResourceProviderError(
      "conflict",
      "The browser profile already has an active session.",
    );
  await checkpointCosts(now);
  const claim = await canClaim(
    resource.creatorAgentId,
    now,
    resource.requestedByUserId ?? undefined,
  );
  if (!claim.allowed) throw new Error(`The ${claim.cause} resource budget is exhausted.`);
  let duration = Math.min(
    config.RESOURCE_LEASE_MS,
    maxContinuousMs - (now.getTime() - continuousStart.getTime()),
  );
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error("A finite provider lease is required.");
  const rate = rates.reduce((sum, r) => sum + r.usdPerMs, 0);
  if (!isEnvFlagEnabled("BUDGET_ADMISSION_DISABLED", false) && rate > 0) {
    const future = await getDbClient().query<BillingRow>(
      "SELECT * FROM resource_billing WHERE reserved=1 AND resourceId<>?",
      [resource.id],
    );
    // Check each UTC day, including leases already reserved for tomorrow.
    for (let cursor = now.getTime(); cursor < now.getTime() + duration; ) {
      const date = new Date(cursor).toISOString().slice(0, 10);
      const dayStart = Date.parse(`${date}T00:00:00.000Z`);
      const dayEnd = dayStart + 86_400_000;
      for (const [scope, id] of [
        ["global", ""],
        ["agent", resource.creatorAgentId],
        ["user", resource.requestedByUserId],
      ] as const) {
        if (id === null) continue;
        const budget = await getBudget(scope, id);
        if (!budget) continue;
        const spend =
          scope === "global"
            ? await getDailySpendGlobal(date, now)
            : scope === "agent"
              ? await getDailySpendForAgent(id, date, now)
              : await getDailySpendForUser(id, date, now);
        const reserved = future
          .filter(
            (r) =>
              scope === "global" ||
              (scope === "agent" ? r.agentId === id : r.requestedByUserId === id),
          )
          .reduce(
            (sum, r) =>
              sum +
              Math.max(
                0,
                Math.min(dayEnd, Date.parse(r.leaseEndsAt)) -
                  Math.max(now.getTime(), dayStart, Date.parse(r.reservationStartsAt)),
              ) *
                r.rateUsdPerMs,
            0,
          );
        const availableMs = Math.max(
          0,
          Math.floor((budget.dailyBudgetUsd - spend - reserved) / rate),
        );
        duration = Math.min(duration, cursor - now.getTime() + availableMs);
      }
      cursor = dayEnd;
    }
  }
  if (duration < 1) throw new Error("The resource budget cannot admit another lease.");
  const end = new Date(now.getTime() + duration);
  if (
    resource.state === "running" &&
    end.getTime() < Date.parse(resource.runningLeaseExpiresAt ?? "")
  )
    throw new Error(
      "The available budget or configured limits cannot renew the existing lease. Stop it explicitly before requesting a shorter lease.",
    );
  await startBilling(resource, rates, now, end);
  await getDbClient().run(
    "UPDATE resources SET continuousStartedAt=?,liveReservation=1,runningLeaseExpiresAt=?,lastActivityAt=?,expiresAt=?,updatedAt=? WHERE id=? AND generation=?",
    [
      continuousStart.toISOString(),
      end.toISOString(),
      now.toISOString(),
      new Date(now.getTime() + config.RESOURCE_EXPIRY_MS).toISOString(),
      now.toISOString(),
      resource.id,
      resource.generation,
    ],
  );
  return end;
}
