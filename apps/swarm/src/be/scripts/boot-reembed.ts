/**
 * Post-listen backfill: embed scripts that are missing embeddings (e.g. after
 * boot seeding with scriptEmbeddingMode: "skip") AND re-embed scripts whose
 * stored embedding has the wrong dimension (e.g. 1536d legacy rows vs current
 * 512d). Runs once per boot, async/non-blocking, idempotent, no-op when clean.
 *
 * Mirrors the memory boot-reembed pattern (src/be/memory/boot-reembed.ts).
 */

import { getDb } from "@/be/db";
import type { ScriptScope } from "@/types";
import { embeddingProvider, embedScript } from "./embeddings";

type ScriptRow = {
  id: string;
  name: string;
  scope: ScriptScope;
  scopeId: string | null;
  source: string;
  description: string;
  intent: string;
  signatureJson: string;
  argsJsonSchema: string | null;
  contentHash: string;
  version: number;
  isScratch: number;
  typeChecked: number;
  fsMode: "none" | "workspace-rw";
  createdByAgentId: string | null;
  createdAt: string;
  updatedAt: string;
};

function toScriptRecord(row: ScriptRow) {
  return {
    ...row,
    scopeId: row.scopeId ?? null,
    isScratch: row.isScratch === 1,
    typeChecked: row.typeChecked === 1,
    createdByAgentId: row.createdByAgentId ?? null,
  };
}

export async function runBootReembedScripts(): Promise<void> {
  const db = getDb();
  const provider = embeddingProvider();
  const expectedBytes = provider.dimensions * Float32Array.BYTES_PER_ELEMENT;

  const missing = db
    .prepare<ScriptRow, []>(
      `SELECT s.* FROM scripts s
       LEFT JOIN script_embeddings e ON e.scriptId = s.id
       WHERE s.isScratch = 0 AND e.scriptId IS NULL`,
    )
    .all();

  const wrongDim = db
    .prepare<ScriptRow, []>(
      `SELECT s.* FROM scripts s
       JOIN script_embeddings e ON e.scriptId = s.id
       WHERE s.isScratch = 0 AND length(e.embedding) != ${expectedBytes}`,
    )
    .all();

  if (missing.length === 0 && wrongDim.length === 0) {
    return;
  }

  if (missing.length > 0) {
    console.log(`[boot-reembed-scripts] ${missing.length} scripts missing embeddings`);
  }
  if (wrongDim.length > 0) {
    console.log(
      `[boot-reembed-scripts] ${wrongDim.length} scripts with wrong-dimension embeddings (expected ${expectedBytes} bytes)`,
    );
  }

  // Probe: verify the provider can actually generate embeddings
  const probe = await provider.embed("test");
  if (!probe) {
    console.warn(
      `[boot-reembed-scripts] skipped: no working embedding provider (missing OpenAI key?)`,
    );
    return;
  }

  let embedded = 0;
  let failed = 0;

  for (const row of [...missing, ...wrongDim]) {
    try {
      await embedScript(toScriptRecord(row));
      embedded++;
    } catch (err) {
      failed++;
      console.error(
        `[boot-reembed-scripts] failed to embed "${row.name}":`,
        (err as Error).message,
      );
    }
  }

  const afterWrongDim =
    db
      .prepare<{ count: number }, []>(
        `SELECT COUNT(*) as count FROM script_embeddings
         WHERE length(embedding) != ${expectedBytes}`,
      )
      .get()?.count ?? 0;

  console.log(
    `[boot-reembed-scripts] complete: embedded=${embedded} failed=${failed} remaining_wrong_dim=${afterWrongDim}`,
  );
}
