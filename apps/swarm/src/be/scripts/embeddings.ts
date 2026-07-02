import type { ScriptRecord, ScriptScope } from "../../types";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { getDb } from "../db";
import { cosineSimilarity, deserializeEmbedding, serializeEmbedding } from "../embedding";
import { getEmbeddingProvider } from "../memory";
import type { EmbeddingProvider } from "../memory/types";

type ScriptEmbeddingRow = {
  scriptId: string;
  embedding: Buffer;
  embeddingModel: string;
  embeddedText: string;
  embeddedAt: string;
};

type ScriptEmbeddingCandidateRow = ScriptEmbeddingRow & {
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

export type ScriptSearchResult = {
  script: ScriptRecord;
  score: number;
  semanticScore: number;
  nameMatchBonus: number;
};

let providerOverride: EmbeddingProvider | null = null;

export function embeddingProvider(): EmbeddingProvider {
  return providerOverride ?? getEmbeddingProvider();
}

export function setScriptEmbeddingProviderForTests(provider: EmbeddingProvider | null): void {
  providerOverride = provider;
}

export function scriptEmbeddingText(script: ScriptRecord): string {
  return scrubSecrets([script.description, script.intent, script.signatureJson].join("\n"));
}

function rowToScript(row: ScriptEmbeddingCandidateRow): ScriptRecord {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    scopeId: row.scopeId ?? null,
    source: row.source,
    description: row.description,
    intent: row.intent,
    signatureJson: row.signatureJson,
    argsJsonSchema: row.argsJsonSchema ?? null,
    contentHash: row.contentHash,
    version: row.version,
    isScratch: row.isScratch === 1,
    typeChecked: row.typeChecked === 1,
    fsMode: row.fsMode,
    createdByAgentId: row.createdByAgentId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function embedScript(script: ScriptRecord): Promise<void> {
  const text = scriptEmbeddingText(script);
  const provider = embeddingProvider();
  const embedding = await provider.embed(text);
  if (!embedding) return;

  if (embedding.length !== provider.dimensions) {
    console.error(
      `[script-embed] dimension mismatch for "${script.name}": expected=${provider.dimensions} got=${embedding.length}, skipping`,
    );
    return;
  }

  getDb()
    .prepare(
      `INSERT INTO script_embeddings (
        scriptId, embedding, embeddingModel, embeddedText, embeddedAt
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(scriptId) DO UPDATE SET
        embedding = excluded.embedding,
        embeddingModel = excluded.embeddingModel,
        embeddedText = excluded.embeddedText,
        embeddedAt = excluded.embeddedAt`,
    )
    .run(script.id, serializeEmbedding(embedding), provider.name, text, new Date().toISOString());
}

function candidateRows(
  scope?: ScriptScope,
  scopeId?: string | null,
): ScriptEmbeddingCandidateRow[] {
  const params: string[] = [];
  let where = "s.isScratch = 0";

  if (scope === "global") {
    where += " AND s.scope = 'global' AND s.scopeId IS NULL";
  } else if (scope === "agent") {
    where += " AND s.scope = 'agent' AND s.scopeId = ?";
    params.push(scopeId ?? "");
  } else if (scopeId) {
    where +=
      " AND ((s.scope = 'agent' AND s.scopeId = ?) OR (s.scope = 'global' AND s.scopeId IS NULL))";
    params.push(scopeId);
  } else {
    where += " AND s.scope = 'global' AND s.scopeId IS NULL";
  }

  return getDb()
    .prepare<ScriptEmbeddingCandidateRow, string[]>(
      `SELECT
        s.*,
        e.scriptId,
        e.embedding,
        e.embeddingModel,
        e.embeddedText,
        e.embeddedAt
      FROM script_embeddings e
      JOIN scripts s ON s.id = e.scriptId
      WHERE ${where}`,
    )
    .all(...params);
}

function scriptRows(scope?: ScriptScope, scopeId?: string | null): ScriptEmbeddingCandidateRow[] {
  const params: string[] = [];
  let where = "isScratch = 0";

  if (scope === "global") {
    where += " AND scope = 'global' AND scopeId IS NULL";
  } else if (scope === "agent") {
    where += " AND scope = 'agent' AND scopeId = ?";
    params.push(scopeId ?? "");
  } else if (scopeId) {
    where += " AND ((scope = 'agent' AND scopeId = ?) OR (scope = 'global' AND scopeId IS NULL))";
    params.push(scopeId);
  } else {
    where += " AND scope = 'global' AND scopeId IS NULL";
  }

  return getDb()
    .prepare<ScriptEmbeddingCandidateRow, string[]>(
      `SELECT *, NULL as scriptId, NULL as embedding, NULL as embeddingModel, NULL as embeddedText, NULL as embeddedAt FROM scripts WHERE ${where}`,
    )
    .all(...params);
}

function nameMatchBonus(script: ScriptRecord, query: string): number {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return 0;
  return script.name.toLowerCase().includes(trimmed) ? 1 : 0;
}

function lexicalFallback(args: {
  query: string;
  scope?: ScriptScope;
  scopeId?: string | null;
  limit?: number;
}): ScriptSearchResult[] {
  const query = args.query.trim().toLowerCase();
  return scriptRows(args.scope, args.scopeId)
    .map(rowToScript)
    .filter((script) => {
      if (!query) return true;
      return [script.name, script.description, script.intent]
        .join("\n")
        .toLowerCase()
        .includes(query);
    })
    .map((script) => {
      const bonus = nameMatchBonus(script, args.query);
      return {
        script,
        score: bonus || 0.5,
        semanticScore: 0,
        nameMatchBonus: bonus,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, args.limit ?? 10);
}

export async function searchScripts(args: {
  query: string;
  scope?: ScriptScope;
  scopeId?: string | null;
  limit?: number;
}): Promise<ScriptSearchResult[]> {
  const provider = embeddingProvider();
  const queryEmbedding = await provider.embed(args.query);
  if (!queryEmbedding) return lexicalFallback(args);

  const candidates = candidateRows(args.scope, args.scopeId);
  if (candidates.length === 0) return lexicalFallback(args);

  const results: ScriptSearchResult[] = [];
  for (const row of candidates) {
    const stored = deserializeEmbedding(row.embedding);
    if (stored.length !== queryEmbedding.length) continue;
    const script = rowToScript(row);
    const semanticScore = cosineSimilarity(queryEmbedding, stored);
    const bonus = nameMatchBonus(script, args.query);
    results.push({
      script,
      score: 0.7 * semanticScore + 0.3 * bonus,
      semanticScore,
      nameMatchBonus: bonus,
    });
  }

  if (results.length === 0) return lexicalFallback(args);

  return results.sort((a, b) => b.score - a.score).slice(0, args.limit ?? 10);
}

export async function reembedAllScripts(): Promise<void> {
  const rows = getDb()
    .prepare<ScriptEmbeddingCandidateRow, []>(
      "SELECT *, NULL as scriptId, NULL as embedding, NULL as embeddingModel, NULL as embeddedText, NULL as embeddedAt FROM scripts WHERE isScratch = 0 ORDER BY updatedAt ASC",
    )
    .all();

  for (const row of rows) {
    await embedScript(rowToScript(row));
  }
}
