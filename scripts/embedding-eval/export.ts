// Export a read-only snapshot of the prod memory corpus + real recall labels.
// Raw prod text stays in DATA_DIR (/tmp). Every text field is passed through
// scrubSecrets before it is written, so later steps (which send text to
// embedding / LLM APIs) only ever see scrubbed text.
//
// Usage:
//   EMBED_EVAL_SSH_HOST=<ssh alias> EMBED_EVAL_DB_PATH=<sqlite path on that host> \
//     bun scripts/embedding-eval/export.ts
// The host needs the sqlite3 CLI. The DB is opened read-only (?mode=ro).

import { mkdirSync } from "node:fs";
import { $ } from "bun";
import { scrubSecrets } from "../../src/utils/secret-scrubber";
import { DATA_DIR, writeJson } from "./common";

const HOST = process.env.EMBED_EVAL_SSH_HOST;
const DB = process.env.EMBED_EVAL_DB_PATH;
if (!HOST || !DB) throw new Error("set EMBED_EVAL_SSH_HOST and EMBED_EVAL_DB_PATH");

async function query<T>(sql: string): Promise<T[]> {
  const out = await $`ssh ${HOST} ${`sqlite3 -json 'file:${DB}?mode=ro'`} < ${new Response(sql)}`
    .quiet()
    .text();
  return out.trim() ? (JSON.parse(out) as T[]) : [];
}

mkdirSync(DATA_DIR, { recursive: true });

// 1. Memory corpus: every non-expired row (the rows prod search can see).
const memories = await query<Record<string, unknown>>(`
  SELECT id, agentId, scope, name, content, source, sourceTaskId, sourcePath,
         chunkIndex, totalChunks, createdAt, contentHash,
         (embedding IS NOT NULL) AS hasEmbedding, embeddingModel
  FROM agent_memory
  WHERE expiresAt IS NULL OR expiresAt > datetime('now');
`);
for (const m of memories) {
  m.name = scrubSecrets(m.name as string);
  m.content = scrubSecrets(m.content as string);
}
await writeJson("memories.json", memories);

// 2. Prod-stored vectors for a random sample: checks that our re-embedding
//    reproduces what prod stores (harness-fidelity check).
const prodVectors = await query<{ id: string; hex: string }>(`
  SELECT id, hex(embedding) AS hex FROM agent_memory
  WHERE embedding IS NOT NULL AND embeddingModel = 'openai/text-embedding-3-small'
    AND length(content) < 8000
    AND (expiresAt IS NULL OR expiresAt > datetime('now'))
  ORDER BY random() LIMIT 100;
`);
await writeJson("prod-vectors.json", prodVectors);

// 3. Real pre-task recall queries with positive ratings (last 90 days).
//    Prod embeds task.task verbatim as the pre-task recall query.
const realQueries = await query<Record<string, unknown>>(`
  WITH pos AS (
    SELECT r.taskId, r.memoryId
    FROM memory_retrieval r
    JOIN memory_rating mr ON mr.taskId = r.taskId AND mr.memoryId = r.memoryId
    WHERE r.intent = 'pre-task memory recall' AND mr.signal > 0
      AND r.retrievedAt > datetime('now', '-90 days')
    GROUP BY r.taskId, r.memoryId
  ),
  firstRecall AS (
    SELECT taskId, MIN(retrievedAt) AS recalledAt,
           json_group_array(DISTINCT memoryId) AS retrieved
    FROM memory_retrieval
    WHERE intent = 'pre-task memory recall' AND taskId IN (SELECT taskId FROM pos)
    GROUP BY taskId
  )
  SELECT t.id AS taskId, t.agentId, t.task, f.recalledAt, f.retrieved,
         json_group_array(DISTINCT pos.memoryId) AS positives
  FROM pos
  JOIN agent_tasks t ON t.id = pos.taskId
  JOIN firstRecall f ON f.taskId = pos.taskId
  GROUP BY t.id
  ORDER BY random()
  LIMIT 800;
`);
for (const q of realQueries) {
  q.task = scrubSecrets(q.task as string);
  q.positives = JSON.parse(q.positives as string);
  q.retrieved = JSON.parse(q.retrieved as string);
}
await writeJson("real-queries-raw.json", realQueries);

console.log(
  JSON.stringify({
    memories: memories.length,
    prodVectors: prodVectors.length,
    realQueries: realQueries.length,
  }),
);
