/**
 * Post-listen backfill: embed scripts that are missing embeddings (e.g. after
 * boot seeding with scriptEmbeddingMode: "skip"). Runs once per boot,
 * async/non-blocking, idempotent, no-op when every non-scratch script already
 * has an embedding row.
 *
 * Mirrors the memory boot-reembed pattern (src/be/memory/boot-reembed.ts).
 */

import { getDb } from "@/be/db";
import type { ScriptScope } from "@/types";
import { embedScript } from "./embeddings";

type ScriptMissingEmbedding = {
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

export async function runBootReembedScripts(): Promise<void> {
  const db = getDb();

  const missing = db
    .prepare<ScriptMissingEmbedding, []>(
      `SELECT s.* FROM scripts s
       LEFT JOIN script_embeddings e ON e.scriptId = s.id
       WHERE s.isScratch = 0 AND e.scriptId IS NULL`,
    )
    .all();

  if (missing.length === 0) {
    return;
  }

  console.log(`[boot-reembed-scripts] starting: ${missing.length} scripts missing embeddings`);

  let embedded = 0;
  let failed = 0;

  for (const row of missing) {
    try {
      await embedScript({
        ...row,
        scopeId: row.scopeId ?? null,
        isScratch: row.isScratch === 1,
        typeChecked: row.typeChecked === 1,
        createdByAgentId: row.createdByAgentId ?? null,
      });
      embedded++;
    } catch (err) {
      failed++;
      console.error(
        `[boot-reembed-scripts] failed to embed "${row.name}":`,
        (err as Error).message,
      );
    }
  }

  console.log(`[boot-reembed-scripts] complete: embedded=${embedded} failed=${failed}`);
}
