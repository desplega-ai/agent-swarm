/**
 * Read-only views for the dashboard memory browser.
 *
 * A long memory is stored as several `agent_memory` rows (chunks) that share
 * `key`, `scope` and `agentId` and carry `chunkIndex` / `totalChunks`. These
 * helpers group the rows back into documents:
 *   - `listMemoryKeys` — one aggregate row per keyed document (usage, rating,
 *     estimated tokens), for the key tree.
 *   - `getMemoryChunks` — every chunk row of one document, in chunkIndex
 *     order, plus an integrity check of the chunk set.
 *
 * Nothing here writes: reads do not bump `accessCount` / `accessedAt`.
 */
import { getDbClient } from "@/be/db";
import type { AgentMemoryRow } from "./providers/sqlite-store";

export const MEMORY_KEYS_DEFAULT_PREFIX = "/longterm/";
export const MEMORY_KEYS_MAX_LIMIT = 2000;

/** Token estimate used across the dashboard: ceil(chars / 4). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** Beta-posterior mean alpha / (alpha + beta); 0.5 at the Beta(1,1) prior. */
export function posteriorMean(alpha: number, beta: number): number {
  const total = alpha + beta;
  return total > 0 ? alpha / total : 0.5;
}

export interface MemoryKeySummary {
  key: string;
  scope: string;
  agentId: string | null;
  /** Id of the lowest-chunkIndex row; opens the document in the detail view. */
  memoryId: string;
  /** Name of the lowest-chunkIndex row (names can differ across chunks). */
  name: string;
  source: string;
  /** Chunk rows present for this document. */
  chunkRows: number;
  /** Largest `totalChunks` any row claims. */
  totalChunks: number;
  /** False when the rows present disagree with `totalChunks` (see `checkChunkIntegrity`). */
  complete: boolean;
  /** Sum of content length over all chunk rows. */
  chars: number;
  estTokens: number;
  /** Sum of `accessCount` over all chunk rows. */
  accessCount: number;
  lastAccessedAt: string | null;
  /** Pooled posterior over all chunk rows: Σalpha / (Σalpha + Σbeta). */
  rating: number;
  alpha: number;
  beta: number;
  /** memory_rating rows with signal > 0 / < 0 across all chunk rows. */
  usefulRatings: number;
  notUsefulRatings: number;
  createdAt: string;
  /** Latest `updatedAt` (falls back to `createdAt`) across chunk rows. */
  updatedAt: string;
}

type KeySummaryRow = Omit<MemoryKeySummary, "complete" | "estTokens" | "rating"> & {
  minTotalChunks: number;
  distinctIndexes: number;
  maxIndex: number;
};

/**
 * One row per keyed document under `prefix`. A document is the set of rows
 * sharing (key, scope, agentId): two agents can hold agent-scope memories
 * under the same key, and those stay separate.
 */
export async function listMemoryKeys(
  options: { prefix?: string; limit?: number; visibleToAgentId?: string } = {},
): Promise<{ keys: MemoryKeySummary[]; truncated: boolean }> {
  const prefix = options.prefix ?? MEMORY_KEYS_DEFAULT_PREFIX;
  const limit = Math.min(options.limit ?? MEMORY_KEYS_MAX_LIMIT, MEMORY_KEYS_MAX_LIMIT);
  // Set for an agent viewer: only its own rows plus swarm-scope rows.
  const visibility =
    options.visibleToAgentId !== undefined ? "AND (m.agentId = ? OR m.scope = 'swarm')" : "";
  const visibilityParams = options.visibleToAgentId !== undefined ? [options.visibleToAgentId] : [];

  // substr/length: literal prefix match, so `%`, `_`, `*` in a key are text.
  const rows = await getDbClient().query<KeySummaryRow>(
    `WITH docs AS (
       SELECT m.*,
              ROW_NUMBER() OVER (
                PARTITION BY m.key, m.scope, COALESCE(m.agentId, '')
                ORDER BY m.chunkIndex, m.createdAt, m.id
              ) AS rn
         FROM agent_memory m
        WHERE m.key IS NOT NULL AND substr(m.key, 1, length(?)) = ? ${visibility}
     ),
     ratings AS (
       SELECT memoryId,
              SUM(CASE WHEN signal > 0 THEN 1 ELSE 0 END) AS useful,
              SUM(CASE WHEN signal < 0 THEN 1 ELSE 0 END) AS notUseful
         FROM memory_rating
        WHERE memoryId IN (SELECT id FROM docs)
        GROUP BY memoryId
     )
     SELECT d.key AS key,
            d.scope AS scope,
            d.agentId AS agentId,
            MAX(CASE WHEN d.rn = 1 THEN d.id END) AS memoryId,
            MAX(CASE WHEN d.rn = 1 THEN d.name END) AS name,
            MAX(CASE WHEN d.rn = 1 THEN d.source END) AS source,
            COUNT(*) AS chunkRows,
            MAX(d.totalChunks) AS totalChunks,
            MIN(d.totalChunks) AS minTotalChunks,
            COUNT(DISTINCT d.chunkIndex) AS distinctIndexes,
            MAX(d.chunkIndex) AS maxIndex,
            SUM(length(d.content)) AS chars,
            SUM(d.accessCount) AS accessCount,
            MAX(d.accessedAt) AS lastAccessedAt,
            SUM(d.alpha) AS alpha,
            SUM(d.beta) AS beta,
            COALESCE(SUM(r.useful), 0) AS usefulRatings,
            COALESCE(SUM(r.notUseful), 0) AS notUsefulRatings,
            MIN(d.createdAt) AS createdAt,
            MAX(COALESCE(d.updatedAt, d.createdAt)) AS updatedAt
       FROM docs d
       LEFT JOIN ratings r ON r.memoryId = d.id
      GROUP BY d.key, d.scope, COALESCE(d.agentId, '')
      ORDER BY d.key, d.scope, COALESCE(d.agentId, '')
      LIMIT ?`,
    [prefix, prefix, ...visibilityParams, limit + 1],
  );

  const truncated = rows.length > limit;
  const keys = rows.slice(0, limit).map(
    ({ minTotalChunks, distinctIndexes, maxIndex, ...row }): MemoryKeySummary => ({
      ...row,
      complete:
        minTotalChunks === row.totalChunks &&
        row.chunkRows === row.totalChunks &&
        distinctIndexes === row.chunkRows &&
        maxIndex === row.chunkRows - 1,
      estTokens: estimateTokens(row.chars),
      rating: posteriorMean(row.alpha, row.beta),
    }),
  );
  return { keys, truncated };
}

export interface ChunkIntegrity {
  ok: boolean;
  /** Largest `totalChunks` any row claims. */
  expectedChunks: number;
  presentIndexes: number[];
  missingIndexes: number[];
  duplicateIndexes: number[];
  /** Distinct `totalChunks` values when the rows disagree; empty when they agree. */
  conflictingTotals: number[];
  /** Ids of rows whose chunkIndex is outside their own totalChunks. */
  outOfRangeIds: string[];
  /** Plain-language problems, one per finding. */
  issues: string[];
}

/** Compare the chunk rows present against the counts they claim. */
export function checkChunkIntegrity(
  rows: { id: string; chunkIndex: number; totalChunks: number }[],
): ChunkIntegrity {
  const totals = [...new Set(rows.map((r) => r.totalChunks))].sort((a, b) => a - b);
  const expectedChunks = totals.length > 0 ? Math.max(...totals) : 0;
  const seen = new Map<number, number>();
  for (const row of rows) seen.set(row.chunkIndex, (seen.get(row.chunkIndex) ?? 0) + 1);
  const presentIndexes = [...seen.keys()].sort((a, b) => a - b);
  const duplicateIndexes = presentIndexes.filter((i) => (seen.get(i) ?? 0) > 1);
  const missingIndexes: number[] = [];
  for (let i = 0; i < expectedChunks; i++) if (!seen.has(i)) missingIndexes.push(i);
  const outOfRangeIds = rows
    .filter((r) => r.chunkIndex < 0 || r.chunkIndex >= r.totalChunks)
    .map((r) => r.id);
  const conflictingTotals = totals.length > 1 ? totals : [];

  const issues: string[] = [];
  if (conflictingTotals.length > 0) {
    issues.push(`Chunk rows disagree on the chunk count: ${conflictingTotals.join(" vs ")}.`);
  }
  if (missingIndexes.length > 0) {
    issues.push(
      `Missing chunk ${missingIndexes.map((i) => i + 1).join(", ")} of ${expectedChunks}.`,
    );
  }
  if (duplicateIndexes.length > 0) {
    issues.push(`More than one row for chunk ${duplicateIndexes.map((i) => i + 1).join(", ")}.`);
  }
  if (outOfRangeIds.length > 0) {
    issues.push(`${outOfRangeIds.length} row(s) have a chunk index beyond their own chunk count.`);
  }
  if (rows.length !== expectedChunks && issues.length === 0) {
    issues.push(`${rows.length} chunk rows present, ${expectedChunks} expected.`);
  }

  return {
    ok: issues.length === 0,
    expectedChunks,
    presentIndexes,
    missingIndexes,
    duplicateIndexes,
    conflictingTotals,
    outOfRangeIds,
    issues,
  };
}

export type MemoryChunkRow = Omit<AgentMemoryRow, "embedding" | "tags"> & { tags: string[] };

/**
 * Every chunk row of the document that `memoryId` belongs to, or of the
 * document identified by (key, scope, agentId). A row without a key is a
 * document of its own. A key lookup that leaves scope or agentId open returns
 * only the first matching document, never rows of several owners. With
 * `visibleToAgentId`, rows outside that agent's own and swarm scope do not
 * match. Returns null when nothing matches.
 */
export async function getMemoryChunks(
  target: { memoryId: string } | { key: string; scope?: string; agentId?: string | null },
  options: { visibleToAgentId?: string } = {},
): Promise<{
  key: string | null;
  scope: string;
  agentId: string | null;
  chunks: MemoryChunkRow[];
} | null> {
  const db = getDbClient();
  const columns = `id, agentId, scope, key, name, content, summary, source, sourceTaskId,
    sourcePath, chunkIndex, totalChunks, tags, createdAt, updatedAt, accessedAt, expiresAt,
    accessCount, embeddingModel, alpha, beta, contentHash, version`;
  type Row = Omit<AgentMemoryRow, "embedding">;

  const visible = (row: Row) =>
    options.visibleToAgentId === undefined ||
    row.scope === "swarm" ||
    row.agentId === options.visibleToAgentId;

  let rows: Row[];
  if ("memoryId" in target) {
    const anchor = await db.get<Row>(`SELECT ${columns} FROM agent_memory WHERE id = ?`, [
      target.memoryId,
    ]);
    if (!anchor || !visible(anchor)) return null;
    rows =
      anchor.key === null
        ? [anchor]
        : await db.query<Row>(
            `SELECT ${columns} FROM agent_memory
              WHERE key = ? AND scope = ? AND COALESCE(agentId, '') = ?
              ORDER BY chunkIndex, createdAt, id`,
            [anchor.key, anchor.scope, anchor.agentId ?? ""],
          );
  } else {
    const conditions = ["key = ?"];
    const params: string[] = [target.key];
    if (target.scope) {
      conditions.push("scope = ?");
      params.push(target.scope);
    }
    if (target.agentId !== undefined) {
      conditions.push("COALESCE(agentId, '') = ?");
      params.push(target.agentId ?? "");
    }
    if (options.visibleToAgentId !== undefined) {
      conditions.push("(agentId = ? OR scope = 'swarm')");
      params.push(options.visibleToAgentId);
    }
    const matches = await db.query<Row>(
      `SELECT ${columns} FROM agent_memory WHERE ${conditions.join(" AND ")}
        ORDER BY scope, COALESCE(agentId, ''), chunkIndex, createdAt, id`,
      params,
    );
    const doc = matches[0];
    rows = doc
      ? matches.filter(
          (row) => row.scope === doc.scope && (row.agentId ?? "") === (doc.agentId ?? ""),
        )
      : [];
  }

  const first = rows[0];
  if (!first) return null;
  return {
    key: first.key,
    scope: first.scope,
    agentId: first.agentId,
    chunks: rows.map((row) => ({ ...row, tags: JSON.parse(row.tags || "[]") as string[] })),
  };
}

/** Posterior (alpha, beta) for a page of memory ids, keyed by id. */
export async function getPosteriorsByIds(
  ids: string[],
): Promise<Map<string, { alpha: number; beta: number }>> {
  if (ids.length === 0) return new Map();
  const rows = await getDbClient().query<{ id: string; alpha: number; beta: number }>(
    `SELECT id, alpha, beta FROM agent_memory WHERE id IN (${ids.map(() => "?").join(", ")})`,
    ids,
  );
  return new Map(rows.map(({ id, ...rest }) => [id, rest]));
}
