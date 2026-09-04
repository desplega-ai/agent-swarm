import { z } from "zod";
import {
  aggregateShards,
  APP_NAME,
  configNumber,
  CONFIG_DEFAULTS,
  createRow,
  KV_NAMESPACE,
  listRows,
  patchRow,
  runKeyFor,
  swarmHttp,
  unwrapList,
  utcDay,
} from "./ui-e2e-core";

export const argsSchema = z.object({
  nowIso: z.string().optional().describe("Clock override for tests"),
  dryRun: z.boolean().optional().describe("Report what would change without writing"),
});

async function resolveAppId(ctx: any): Promise<string | null> {
  const cached: any = await ctx.swarm.kv_getOrNull({ namespace: KV_NAMESPACE, key: "appId" });
  const cachedId = cached?.data?.value ?? cached?.value;
  if (typeof cachedId === "string" && cachedId.length > 0) return cachedId;
  const apps = unwrapList(await ctx.swarm.app_list({}), "apps");
  return apps.find((a: any) => a?.name === APP_NAME)?.id ?? null;
}

/**
 * Close out UI E2E run groups whose shards never reported, and re-dispatch work
 * that yesterday's PR cap deferred.
 *
 * A shard that dies without posting leaves its group `running` forever — the
 * page would show a run that never resolves and the group would never be
 * eligible for retention. This is the only writer of the `incomplete` status.
 */
export default async function uiE2eSweep(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) throw new Error(`invalid args: ${parsed.error.message}`);
  const { nowIso, dryRun } = parsed.data;

  const appId = await resolveAppId(ctx);
  if (!appId) return { ok: true, skipped: "app not created yet" };

  const http = swarmHttp(ctx);
  const nowMs = nowIso ? Date.parse(nowIso) : Date.now();
  const now = new Date(nowMs).toISOString();
  const timeoutMin = await configNumber(
    ctx,
    "UI_E2E_SHARD_TIMEOUT_MIN",
    CONFIG_DEFAULTS.UI_E2E_SHARD_TIMEOUT_MIN,
  );

  const running = await listRows(ctx, http, appId, "runGroups", { status: "running" }, { limit: 500 });
  const markedIncomplete: string[] = [];
  let synthesizedShards = 0;

  for (const group of running) {
    const startedMs = Date.parse(group.startedAt || "");
    if (Number.isNaN(startedMs) || nowMs - startedMs <= timeoutMin * 60_000) continue;

    const shardRows = await listRows(ctx, http, appId, "runs", { groupKey: group.groupKey }, { limit: 100 });
    const aggregate = aggregateShards(shardRows as any, { nowMs, timeoutMin });
    if (aggregate.status !== "incomplete") continue;

    if (!dryRun) {
      // Materialize a row per missing shard so the page shows WHICH shard is
      // absent rather than an unexplained count mismatch.
      for (const shardIndex of aggregate.missingShards) {
        await createRow(ctx, http, appId, "runs", {
          runKey: runKeyFor(group.groupKey, shardIndex),
          groupKey: group.groupKey,
          repo: group.repo,
          target: group.target,
          sha: group.sha,
          trigger: group.trigger,
          runner: group.runner,
          shardIndex,
          shardTotal: aggregate.shardTotal,
          attempt: 0,
          status: "incomplete",
          ingestedAt: now,
        });
        synthesizedShards++;
      }
      await patchRow(ctx, http, appId, "runGroups", group.id, {
        status: "incomplete",
        shardsReported: aggregate.shardsReported,
        lastIngestAt: now,
      });
    }
    markedIncomplete.push(group.groupKey);
  }

  // Deferred work waits for the daily cap to roll over. Nothing is lost by a
  // cap hit — only delayed until this sweep picks it back up.
  const cap = await configNumber(
    ctx,
    "UI_E2E_MAX_PRS_PER_DAY",
    CONFIG_DEFAULTS.UI_E2E_MAX_PRS_PER_DAY,
  );
  const usedRes: any = await ctx.swarm.kv_getOrNull({
    namespace: KV_NAMESPACE,
    key: `dispatch:${utcDay(nowMs)}`,
  });
  const usedToday = Number(usedRes?.data?.value ?? usedRes?.value ?? 0) || 0;

  const deferredIncidents = await listRows(
    ctx,
    http,
    appId,
    "incidents",
    { status: "open", triageStatus: "deferred" },
    { limit: 100 },
  );
  const deferredFindings = await listRows(
    ctx,
    http,
    appId,
    "findings",
    { status: "deferred" },
    { limit: 100 },
  );

  // Flip deferred rows back to pending/open when there is budget again; the
  // next ingest for that fingerprint dispatches them. The sweep deliberately
  // does not fire webhooks itself — one dispatcher (ingest) is easier to reason
  // about than two racing for the same counter.
  const requeued: string[] = [];
  let budget = Math.max(0, cap - usedToday);
  for (const incident of deferredIncidents) {
    if (budget <= 0) break;
    if (!dryRun) {
      await patchRow(ctx, http, appId, "incidents", incident.id, { triageStatus: "pending" });
    }
    requeued.push(incident.incidentKey);
    budget--;
  }
  for (const finding of deferredFindings) {
    if (budget <= 0) break;
    if (!dryRun) {
      await patchRow(ctx, http, appId, "findings", finding.id, { status: "open" });
    }
    requeued.push(finding.findingKey);
    budget--;
  }

  return {
    ok: true,
    appId,
    dryRun: dryRun === true,
    timeoutMin,
    markedIncomplete,
    synthesizedShards,
    requeued,
    dispatchBudgetLeft: budget,
  };
}
