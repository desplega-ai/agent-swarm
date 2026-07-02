/**
 * Startup backfill: detect agent_memory rows with wrong-dimension embeddings
 * (not 512d) and re-embed them in the background. Runs once per boot,
 * async/non-blocking, idempotent, no-op when the DB is clean.
 *
 * This is the app-level equivalent of a forward-only migration — SQL can't
 * call OpenAI, so the backfill runs at startup instead.
 */

import { getDb } from "@/be/db";
import { EMBEDDING_DIMENSIONS } from "./constants";
import { getEmbeddingProvider, getMemoryStore } from "./index";

const VECTOR_BYTES = EMBEDDING_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT;
const BATCH_SIZE = 20;

export async function runBootReembed(): Promise<void> {
  const db = getDb();

  const invalidCount =
    db
      .prepare<{ count: number }, []>(
        `SELECT COUNT(*) as count FROM agent_memory
       WHERE embedding IS NOT NULL AND length(embedding) != ${VECTOR_BYTES}`,
      )
      .get()?.count ?? 0;

  if (invalidCount === 0) {
    return;
  }

  const provider = getEmbeddingProvider();
  const testEmbed = await provider.embed("test");
  if (!testEmbed) {
    console.warn(
      `[boot-reembed] skipped: ${invalidCount} wrong-dimension rows found but no OpenAI key configured`,
    );
    return;
  }

  console.log(`[boot-reembed] starting: ${invalidCount} rows with wrong embedding dimensions`);

  const store = getMemoryStore();
  const rows = db
    .prepare<{ id: string; content: string }, []>(
      `SELECT id, content FROM agent_memory
       WHERE embedding IS NOT NULL AND length(embedding) != ${VECTOR_BYTES}`,
    )
    .all();

  let reembedded = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    try {
      const embeddings = await provider.embedBatch(batch.map((m) => m.content));
      for (let j = 0; j < embeddings.length; j++) {
        if (embeddings[j]) {
          store.updateEmbedding(batch[j]!.id, embeddings[j]!, provider.name);
          reembedded++;
        }
      }
    } catch (err) {
      failed += batch.length;
      console.error(
        `[boot-reembed] batch ${Math.floor(i / BATCH_SIZE) + 1} failed:`,
        (err as Error).message,
      );
    }
  }

  const afterInvalid =
    db
      .prepare<{ count: number }, []>(
        `SELECT COUNT(*) as count FROM agent_memory
       WHERE embedding IS NOT NULL AND length(embedding) != ${VECTOR_BYTES}`,
      )
      .get()?.count ?? 0;

  console.log(
    `[boot-reembed] complete: reembedded=${reembedded} failed=${failed} remaining_invalid=${afterInvalid}`,
  );
}
