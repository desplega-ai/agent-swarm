import type { ScriptSearchScope } from "@desplega/storage";
import type { ScriptRecord, ScriptScope } from "../../types";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { cosineSimilarity, deserializeEmbedding, serializeEmbedding } from "../embedding";
import { getEmbeddingProvider } from "../memory";
import type { EmbeddingProvider } from "../memory/types";
import { getStorage } from "../storage";

type ScriptEmbeddingCandidateRow = import("@desplega/storage").ScriptEmbeddingCandidateRow;

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
    executor: row.executor ?? null,
    createdByAgentId: row.createdByAgentId ?? null,
    updatedByAgentId: row.updatedByAgentId ?? null,
    createdBy: row.created_by ?? null,
    updatedBy: row.updated_by ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type ScriptEmbedding = { text: string; embedding: Float32Array; model: string };

/** Embeds a script's text without writing it. Null when no usable vector came back. */
export async function computeScriptEmbedding(
  script: ScriptRecord,
): Promise<ScriptEmbedding | null> {
  const text = scriptEmbeddingText(script);
  const provider = embeddingProvider();
  const embedding = await provider.embed(text, { kind: "document" });
  if (!embedding) return null;

  if (embedding.length !== provider.dimensions) {
    console.error(
      `[script-embed] dimension mismatch for "${script.name}": expected=${provider.dimensions} got=${embedding.length}, skipping`,
    );
    return null;
  }
  return { text, embedding, model: provider.name };
}

/** Upserts a computed vector. Joins the caller's transaction when there is one. */
export async function writeScriptEmbedding(scriptId: string, e: ScriptEmbedding): Promise<void> {
  await getStorage().repos.scripts.upsertScriptEmbedding({
    scriptId,
    embedding: serializeEmbedding(e.embedding),
    embeddingModel: e.model,
    embeddedText: e.text,
    embeddedAt: new Date().toISOString(),
  });
}

/** Returns whether a vector was stored. */
export async function embedScript(script: ScriptRecord): Promise<boolean> {
  const result = await computeScriptEmbedding(script);
  if (!result) return false;
  await writeScriptEmbedding(script.id, result);
  return true;
}

function searchScope(scope?: ScriptScope, scopeId?: string | null): ScriptSearchScope {
  if (scope === "global") return { kind: "global" };
  if (scope === "agent") return { kind: "agent", scopeId: scopeId ?? "" };
  if (scopeId) return { kind: "agentOrGlobal", scopeId };
  return { kind: "global" };
}

async function candidateRows(
  scope?: ScriptScope,
  scopeId?: string | null,
): Promise<ScriptEmbeddingCandidateRow[]> {
  return getStorage().repos.scripts.listEmbeddedScripts(searchScope(scope, scopeId));
}

async function scriptRows(
  scope?: ScriptScope,
  scopeId?: string | null,
): Promise<ScriptEmbeddingCandidateRow[]> {
  return getStorage().repos.scripts.listSearchableScripts(searchScope(scope, scopeId));
}

function nameMatchBonus(script: ScriptRecord, query: string): number {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return 0;
  return script.name.toLowerCase().includes(trimmed) ? 1 : 0;
}

async function lexicalFallback(args: {
  query: string;
  scope?: ScriptScope;
  scopeId?: string | null;
  limit?: number;
}): Promise<ScriptSearchResult[]> {
  const query = args.query.trim().toLowerCase();
  return (await scriptRows(args.scope, args.scopeId))
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
  const queryEmbedding = await provider.embed(args.query, { kind: "query" });
  if (!queryEmbedding) return lexicalFallback(args);

  const candidates = await candidateRows(args.scope, args.scopeId);
  if (candidates.length === 0) return lexicalFallback(args);

  const results: ScriptSearchResult[] = [];
  for (const row of candidates) {
    const stored = deserializeEmbedding(row.embedding as Buffer);
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
  const rows = await getStorage().repos.scripts.listScriptsForReembed();

  for (const row of rows) {
    await embedScript(rowToScript(row));
  }
}
