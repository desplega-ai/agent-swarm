import type { Client } from "@libsql/client";
import type { HarnessConfig, HarnessProvider, ReasoningEffortLevel } from "../types.ts";

/**
 * DB-backed harness configs (`harness_configs`). `configs/index.ts` stays the
 * reviewed seed list: every boot upserts it with `source='seed'`, and a seed
 * row keeps following the code until someone edits it through the API, which
 * flips it to `source='user'` so later boots leave it alone. Configs created
 * through the API start as `source='user'`.
 */

export type HarnessConfigSource = "seed" | "user";

export interface HarnessConfigRow {
  config: HarnessConfig;
  source: HarnessConfigSource;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

function envJson(config: HarnessConfig): string | null {
  return config.env && Object.keys(config.env).length > 0 ? JSON.stringify(config.env) : null;
}

/** Upsert the code seeds. Rows edited in the DB (`source='user'`) are never overwritten. */
export async function syncSeedConfigs(db: Client, seeds: HarnessConfig[]): Promise<void> {
  for (const c of seeds) {
    await db.execute({
      sql: `INSERT INTO harness_configs
              (id, label, provider, model, model_alias, model_tier, reasoning_effort, env_json, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'seed')
            ON CONFLICT(id) DO UPDATE SET
              label = excluded.label,
              provider = excluded.provider,
              model = excluded.model,
              model_alias = excluded.model_alias,
              model_tier = excluded.model_tier,
              reasoning_effort = excluded.reasoning_effort,
              env_json = excluded.env_json,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE harness_configs.source = 'seed'`,
      args: [
        c.id,
        c.label ?? null,
        c.provider,
        c.model ?? null,
        c.modelAlias ?? null,
        c.modelTier ?? null,
        c.reasoningEffort ?? null,
        envJson(c),
      ],
    });
  }
}

function rowToConfig(r: Record<string, unknown>): HarnessConfigRow {
  const config: HarnessConfig = { id: String(r.id), provider: r.provider as HarnessProvider };
  if (r.label != null) config.label = String(r.label);
  if (r.model != null) config.model = String(r.model);
  if (r.model_alias != null) config.modelAlias = String(r.model_alias);
  if (r.model_tier != null) config.modelTier = r.model_tier as HarnessConfig["modelTier"];
  if (r.reasoning_effort != null)
    config.reasoningEffort = r.reasoning_effort as ReasoningEffortLevel;
  if (r.env_json != null) config.env = JSON.parse(String(r.env_json));
  return {
    config,
    source: r.source === "user" ? "user" : "seed",
    archived: Number(r.archived) === 1,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function listHarnessConfigs(db: Client): Promise<HarnessConfigRow[]> {
  const res = await db.execute("SELECT * FROM harness_configs ORDER BY created_at, id");
  return res.rows.map((r) => rowToConfig(r as Record<string, unknown>));
}

export async function getHarnessConfig(db: Client, id: string): Promise<HarnessConfigRow | null> {
  const res = await db.execute({ sql: "SELECT * FROM harness_configs WHERE id = ?", args: [id] });
  const row = res.rows[0];
  return row ? rowToConfig(row as Record<string, unknown>) : null;
}

/** Insert a user config. Returns false when the id is taken. */
export async function insertUserConfig(db: Client, c: HarnessConfig): Promise<boolean> {
  const res = await db.execute({
    sql: `INSERT INTO harness_configs
            (id, label, provider, model, model_alias, reasoning_effort, source)
          VALUES (?, ?, ?, ?, ?, ?, 'user')
          ON CONFLICT(id) DO NOTHING`,
    args: [
      c.id,
      c.label ?? null,
      c.provider,
      c.model ?? null,
      c.modelAlias ?? null,
      c.reasoningEffort ?? null,
    ],
  });
  return res.rowsAffected === 1;
}

/** Overwrite the editable fields and mark the row `source='user'` so seeds stop touching it. */
export async function updateUserConfig(
  db: Client,
  c: HarnessConfig,
  archived: boolean,
): Promise<void> {
  await db.execute({
    sql: `UPDATE harness_configs SET
            label = ?, provider = ?, model = ?, model_alias = ?, reasoning_effort = ?, archived = ?,
            source = 'user', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`,
    args: [
      c.label ?? null,
      c.provider,
      c.model ?? null,
      c.modelAlias ?? null,
      c.reasoningEffort ?? null,
      archived ? 1 : 0,
      c.id,
    ],
  });
}
