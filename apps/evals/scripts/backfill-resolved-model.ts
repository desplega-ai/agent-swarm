#!/usr/bin/env bun
/**
 * One-off, idempotent backfill of `attempts.resolved_model`.
 *
 *   bun scripts/backfill-resolved-model.ts           # dry run (default): counts only, no writes
 *   bun scripts/backfill-resolved-model.ts --write   # apply (runs initDb, which adds the column)
 *
 * Rules, per attempt whose resolved_model is NULL:
 *   1. the harness-reported model in tokens_json, when it is a concrete id;
 *   2. else, for graded attempts (passed/failed) of a pinned config, the config's `model`;
 *   3. else stay NULL. Bare aliases ("opus") are never written: the read-time
 *      alias map keeps covering those rows, as before.
 * Re-running only touches rows that are still NULL.
 */
import type { Client } from "@libsql/client";
import { configs } from "../configs/index.ts";
import { getDb, initDb } from "../src/db/client.ts";
import type { HarnessConfig } from "../src/types.ts";

export interface BackfillSourceRow {
  id: string;
  configId: string;
  status: string;
  tokenModel: string | null;
}

export type BackfillSource = "tokens" | "config";

export interface BackfillUpdate {
  id: string;
  resolvedModel: string;
  source: BackfillSource;
}

/** A bare family alias ("opus", "haiku") is not a concrete model id. */
function isConcrete(model: string | null | undefined): model is string {
  return !!model && model.trim().length > 0 && !/^[a-z]+$/i.test(model.trim());
}

/** Pure planner: which NULL rows get which model. */
export function planBackfill(
  rows: BackfillSourceRow[],
  configsById: Map<string, HarnessConfig>,
): BackfillUpdate[] {
  const out: BackfillUpdate[] = [];
  for (const row of rows) {
    if (isConcrete(row.tokenModel)) {
      out.push({ id: row.id, resolvedModel: row.tokenModel.trim(), source: "tokens" });
      continue;
    }
    if (row.status !== "passed" && row.status !== "failed") continue;
    const config = configsById.get(row.configId);
    if (config && !config.modelAlias && isConcrete(config.model)) {
      out.push({ id: row.id, resolvedModel: config.model, source: "config" });
    }
  }
  return out;
}

async function hasResolvedModelColumn(db: Client): Promise<boolean> {
  const res = await db.execute("PRAGMA table_info(attempts)");
  return res.rows.some((r) => r.name === "resolved_model");
}

export async function loadBackfillRows(db: Client): Promise<BackfillSourceRow[]> {
  const nullFilter = (await hasResolvedModelColumn(db)) ? "WHERE resolved_model IS NULL" : "";
  const res = await db.execute(
    `SELECT id, config_id, status,
            CASE WHEN json_valid(tokens_json) THEN json_extract(tokens_json, '$.model') END AS token_model
     FROM attempts ${nullFilter}`,
  );
  return res.rows.map((r) => ({
    id: String(r.id),
    configId: String(r.config_id),
    status: String(r.status),
    tokenModel: r.token_model == null ? null : String(r.token_model),
  }));
}

export async function applyBackfill(db: Client, updates: BackfillUpdate[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < updates.length; i += 200) {
    const chunk = updates.slice(i, i + 200);
    const results = await db.batch(
      chunk.map((u) => ({
        sql: "UPDATE attempts SET resolved_model = ? WHERE id = ? AND resolved_model IS NULL",
        args: [u.resolvedModel, u.id],
      })),
      "write",
    );
    written += results.reduce((n, r) => n + r.rowsAffected, 0);
  }
  return written;
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  // Dry run never runs DDL: it reads a synced replica and treats a missing
  // column as "every row is NULL".
  const db = write ? await initDb() : getDb();
  if (!write) await db.sync().catch(() => undefined);
  const rows = await loadBackfillRows(db);
  const updates = planBackfill(rows, new Map(configs.map((c) => [c.id, c])));
  const bySource = { tokens: 0, config: 0 };
  for (const u of updates) bySource[u.source]++;
  console.log(
    `${write ? "write" : "dry run"}: ${rows.length} attempt(s) with NULL resolved_model; ` +
      `${updates.length} to backfill (${bySource.tokens} from tokens_json, ${bySource.config} from config model); ` +
      `${rows.length - updates.length} stay NULL`,
  );
  if (!write) return;
  const written = await applyBackfill(db, updates);
  console.log(`wrote resolved_model on ${written} attempt(s)`);
}

if (import.meta.main) {
  await main();
}
