/**
 * Harness CLI model support (model-catalog phase 4).
 *
 * A catalog model can exist before the pinned `claude` / `codex` CLI accepts
 * it. Workers report their CLI version on register and record each model's
 * first-run outcome here; claim-time resolution reads it:
 *
 *   - `unknown` (no row) and `ok` are allowed at claim.
 *   - `unsupported` + an alias/tier resolution → fall back to the newest
 *     `ok`/`unknown` model in the same family (modelSource
 *     `fallback:cli-unsupported`), with one notice per (harness, CLI, model).
 *   - `unsupported` + an explicit task `model` → fail fast at claim.
 *
 * See runbooks/model-catalog.md.
 */
import { harnessCatalogSection, harnessModelIds, modelFamilyKey } from "@desplega/model-catalog";
import { scrubSecrets } from "../utils/secret-scrubber";
import { getDbClient } from "./db";

export type HarnessModelSupportStatus = "ok" | "unsupported" | "unknown";

export interface HarnessModelSupportRow {
  harness: string;
  cliVersion: string;
  modelId: string;
  status: HarnessModelSupportStatus;
  checkedAt: number;
  error: string | null;
}

/** Harnesses whose CLI pins the set of accepted model ids. */
export const CLI_PINNED_HARNESSES = new Set(["claude", "codex"]);

export async function getHarnessModelSupport(
  harness: string,
  cliVersion: string,
  modelId: string,
): Promise<HarnessModelSupportStatus> {
  const row = await getDbClient().get<{ status: HarnessModelSupportStatus }>(
    "SELECT status FROM harness_model_support WHERE harness = ? AND cliVersion = ? AND modelId = ?",
    [harness, cliVersion, modelId],
  );
  return row?.status ?? "unknown";
}

export async function listHarnessModelSupport(filter?: {
  harness?: string;
  cliVersion?: string;
}): Promise<HarnessModelSupportRow[]> {
  const where: string[] = [];
  const params: string[] = [];
  if (filter?.harness) {
    where.push("harness = ?");
    params.push(filter.harness);
  }
  if (filter?.cliVersion) {
    where.push("cliVersion = ?");
    params.push(filter.cliVersion);
  }
  return await getDbClient().query<HarnessModelSupportRow>(
    `SELECT harness, cliVersion, modelId, status, checkedAt, error FROM harness_model_support${
      where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""
    } ORDER BY checkedAt DESC`,
    params,
  );
}

/** Upsert one outcome. An `ok` never downgrades to `unknown`. */
export async function recordHarnessModelSupport(input: {
  harness: string;
  cliVersion: string;
  modelId: string;
  status: HarnessModelSupportStatus;
  error?: string | null;
  now?: number;
}): Promise<HarnessModelSupportRow> {
  const checkedAt = input.now ?? Date.now();
  const error = input.error ? scrubSecrets(input.error).slice(0, 2000) : null;
  await getDbClient().run(
    `INSERT INTO harness_model_support (harness, cliVersion, modelId, status, checkedAt, error)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (harness, cliVersion, modelId) DO UPDATE SET
       status = CASE WHEN excluded.status = 'unknown' THEN harness_model_support.status ELSE excluded.status END,
       checkedAt = excluded.checkedAt,
       error = excluded.error`,
    [input.harness, input.cliVersion, input.modelId, input.status, checkedAt, error],
  );
  const row = await getDbClient().get<HarnessModelSupportRow>(
    "SELECT harness, cliVersion, modelId, status, checkedAt, error FROM harness_model_support WHERE harness = ? AND cliVersion = ? AND modelId = ?",
    [input.harness, input.cliVersion, input.modelId],
  );
  if (!row) throw new Error("harness_model_support upsert returned no row");
  return row;
}

export async function getAgentHarnessCliVersion(agentId: string): Promise<string | null> {
  const row = await getDbClient().get<{ harnessCliVersion: string | null }>(
    "SELECT harnessCliVersion FROM agents WHERE id = ?",
    [agentId],
  );
  return row?.harnessCliVersion ?? null;
}

/** Store the worker's CLI version; no write when unchanged. */
export async function setAgentHarnessCliVersion(
  agentId: string,
  cliVersion: string | null,
): Promise<void> {
  await getDbClient().run(
    "UPDATE agents SET harnessCliVersion = ? WHERE id = ? AND harnessCliVersion IS NOT ?",
    [cliVersion, agentId, cliVersion],
  );
}

export function unsupportedModelMessage(harness: string, cliVersion: string, model: string) {
  return `Model "${model}" is not supported by the ${harness} CLI ${cliVersion} on this worker. A CLI bump is needed before tasks can pin it.`;
}

/**
 * Newest model in the same family as `model` that this harness CLI has not
 * rejected. Null when the family has nothing else.
 */
export async function fallbackForUnsupportedModel(
  harness: string,
  cliVersion: string,
  model: string,
  catalogSection: Record<string, { release_date?: string; status?: string; reasoning?: boolean }>,
): Promise<string | null> {
  if (!harnessCatalogSection(harness)) return null;
  const family = modelFamilyKey(model);
  const rejected = new Set(
    (await listHarnessModelSupport({ harness, cliVersion }))
      .filter((r) => r.status === "unsupported")
      .map((r) => r.modelId),
  );
  for (const id of harnessModelIds(harness, catalogSection)) {
    if (id === model || rejected.has(id)) continue;
    if (modelFamilyKey(id) === family) return id;
  }
  return null;
}

const noticed = new Set<string>();

/** One console notice per (harness, CLI, model) per process. */
export function noticeCliUnsupported(
  harness: string,
  cliVersion: string,
  model: string,
  fallback: string,
): void {
  const key = `${harness}|${cliVersion}|${model}`;
  if (noticed.has(key)) return;
  noticed.add(key);
  console.warn(
    `[model-tiers] ${model} is unsupported on ${harness} CLI ${cliVersion}; tier/alias tasks fall back to ${fallback} until the CLI is bumped`,
  );
}
