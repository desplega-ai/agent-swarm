import { z } from "zod";
import {
  APP_NAME,
  artifactPathPrefix,
  configNumber,
  configString,
  CONFIG_DEFAULTS,
  deleteRow,
  KV_NAMESPACE,
  listRows,
  swarmHttp,
  unwrapList,
} from "./ui-e2e-core";

export const argsSchema = z.object({
  nowIso: z.string().optional().describe("Clock override for tests"),
  retentionDays: z.number().int().positive().optional().describe("Override the retention window"),
  dryRun: z.boolean().optional().describe("Report what would be deleted without deleting"),
  pruneAgentFs: z.boolean().optional().describe("Also delete stale agent-fs paths (default true)"),
});

async function resolveAppId(ctx: any): Promise<string | null> {
  const cached: any = await ctx.swarm.kv_getOrNull({ namespace: KV_NAMESPACE, key: "appId" });
  const cachedId = cached?.data?.value ?? cached?.value;
  if (typeof cachedId === "string" && cachedId.length > 0) return cachedId;
  const apps = unwrapList(await ctx.swarm.app_list({}), "apps");
  return apps.find((a: any) => a?.name === APP_NAME)?.id ?? null;
}

/** Same server-side secret resolution the gh-pr-snapshot catalog script uses. */
async function resolveSecret(ctx: any, key: string): Promise<string | null> {
  try {
    const base = ctx.stdlib.Redacted.value(ctx.swarm.config.mcpBaseUrl).replace(/\/+$/, "");
    const apiKey = ctx.stdlib.Redacted.value(ctx.swarm.config.apiKey);
    const res: any = await ctx.stdlib.fetchJson(`${base}/api/config/resolved?includeSecrets=true`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const configs: any[] = res && Array.isArray(res.configs) ? res.configs : [];
    for (const c of configs) {
      if (c?.key === key && typeof c.value === "string" && c.value.length > 0) return c.value;
    }
  } catch {
    // Best-effort: a missing config row means agent-fs pruning is skipped.
  }
  return null;
}

function isOlderThan(value: unknown, cutoffMs: number): boolean {
  const ms = Date.parse(String(value ?? ""));
  return !Number.isNaN(ms) && ms < cutoffMs;
}

/**
 * 30-day retention for the UI E2E tracker: app rows first, then the agent-fs
 * artifact paths those rows referenced.
 *
 * Open incidents are NEVER pruned regardless of age. An incident open for 40
 * days is exactly the record you must not lose — deleting it would let the next
 * failure open a fresh one with occurrences=1 and no history.
 */
export default async function uiE2ePrune(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) throw new Error(`invalid args: ${parsed.error.message}`);
  const { nowIso, dryRun } = parsed.data;

  const appId = await resolveAppId(ctx);
  if (!appId) return { ok: true, skipped: "app not created yet" };

  const http = swarmHttp(ctx);
  const nowMs = nowIso ? Date.parse(nowIso) : Date.now();
  const retentionDays =
    parsed.data.retentionDays ??
    (await configNumber(ctx, "UI_E2E_RETENTION_DAYS", CONFIG_DEFAULTS.UI_E2E_RETENTION_DAYS));
  const cutoffMs = nowMs - retentionDays * 86_400_000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const deleted = {
    runGroups: 0,
    runs: 0,
    results: 0,
    artifacts: 0,
    findings: 0,
    incidents: 0,
  };
  const stalePrefixes: string[] = [];

  // Groups go first so their prefixes are known before their artifact rows die.
  const groups = await listRows(ctx, http, appId, "runGroups", {}, { limit: 1000 });
  const staleGroupKeys = new Set<string>();
  for (const group of groups) {
    if (!isOlderThan(group.lastIngestAt, cutoffMs)) continue;
    staleGroupKeys.add(group.groupKey);
    const shardTotal = Number(group.shardTotal) || 1;
    for (let shardIndex = 1; shardIndex <= shardTotal; shardIndex++) {
      stalePrefixes.push(
        artifactPathPrefix(String(group.repo), String(group.target), String(group.sha), shardIndex),
      );
    }
    if (!dryRun) await deleteRow(ctx, http, appId, "runGroups", group.id);
    deleted.runGroups++;
  }

  for (const model of ["runs", "results", "artifacts"] as const) {
    const rows = await listRows(ctx, http, appId, model, {}, { limit: 1000 });
    for (const row of rows) {
      const orphaned = staleGroupKeys.has(String(row.groupKey));
      if (!orphaned && !isOlderThan(row.ingestedAt, cutoffMs)) continue;
      if (!dryRun) await deleteRow(ctx, http, appId, model, row.id);
      deleted[model]++;
    }
  }

  const findings = await listRows(ctx, http, appId, "findings", {}, { limit: 1000 });
  for (const finding of findings) {
    const settled = finding.status === "promoted" || finding.status === "dismissed";
    if (!settled || !isOlderThan(finding.ingestedAt, cutoffMs)) continue;
    if (!dryRun) await deleteRow(ctx, http, appId, "findings", finding.id);
    deleted.findings++;
  }

  const incidents = await listRows(ctx, http, appId, "incidents", { status: "closed" }, { limit: 1000 });
  for (const incident of incidents) {
    if (!isOlderThan(incident.lastSeenAt, cutoffMs)) continue;
    if (!dryRun) await deleteRow(ctx, http, appId, "incidents", incident.id);
    deleted.incidents++;
  }

  // ── agent-fs paths ───────────────────────────────────────────────────────
  // Requires an operator-configured base URL, org/drive, and token. When any is
  // missing we report the stale prefixes instead of failing: losing the app-row
  // prune because a storage credential is absent would be the worse outcome.
  const agentFs: Record<string, unknown> = { pruned: 0, prefixes: stalePrefixes.length };
  const wantAgentFs = parsed.data.pruneAgentFs !== false && stalePrefixes.length > 0 && !dryRun;
  if (wantAgentFs) {
    const baseUrl = await configString(ctx, "UI_E2E_AGENT_FS_BASE_URL");
    const orgId = await configString(ctx, "UI_E2E_AGENT_FS_ORG_ID");
    const token = await resolveSecret(ctx, "UI_E2E_AGENT_FS_TOKEN");
    if (!baseUrl || !orgId || !token) {
      agentFs.skipped = "missing UI_E2E_AGENT_FS_BASE_URL, UI_E2E_AGENT_FS_ORG_ID or UI_E2E_AGENT_FS_TOKEN";
      agentFs.stalePrefixes = stalePrefixes.slice(0, 50);
    } else {
      let pruned = 0;
      const failures: string[] = [];
      for (const prefix of stalePrefixes) {
        try {
          const res = await ctx.stdlib.fetch(`${baseUrl.replace(/\/+$/, "")}/orgs/${orgId}/ops`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ op: "rm", path: `/${prefix}`, recursive: true }),
          });
          if (res.ok) pruned++;
          else failures.push(`${prefix}: ${res.status}`);
        } catch (error) {
          failures.push(`${prefix}: ${(error as Error).message}`);
        }
      }
      agentFs.pruned = pruned;
      if (failures.length) agentFs.failures = failures.slice(0, 20);
    }
  } else if (stalePrefixes.length > 0) {
    agentFs.skipped = dryRun ? "dryRun" : "pruneAgentFs=false";
    agentFs.stalePrefixes = stalePrefixes.slice(0, 50);
  }

  return {
    ok: true,
    appId,
    dryRun: dryRun === true,
    retentionDays,
    cutoff: cutoffIso,
    deleted,
    agentFs,
  };
}
