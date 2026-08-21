/**
 * Shared memory ingestion: chunk content, persist the chunks, resolve links,
 * and embed in the background.
 *
 * Callers: the POST /api/memory/index route (file-index hook, session
 * summaries) and the `memory-store` MCP tool (any harness, no file system).
 */
import { chunkContent } from "@/be/chunking";
import { getEmbeddingProvider, getMemoryStore } from "@/be/memory";
import { refreshLinks, storeLinks } from "@/be/memory/link-resolver";
import type { AgentMemoryScope, AgentMemorySource } from "@/types";
import { scrubSecrets } from "@/utils/secret-scrubber";

export interface IndexMemoryContentParams {
  /** Owner of the memory rows. null for an unowned swarm memory. */
  agentId: string | null | undefined;
  content: string;
  name: string;
  scope: AgentMemoryScope;
  source: AgentMemorySource;
  sourceTaskId?: string | null;
  sourcePath?: string | null;
  tags?: string[];
  contextKey?: string | null;
  /** Audit-trail reason. Defaults to "index memory content". */
  intent?: string;
}

export interface IndexMemoryContentResult {
  queued: boolean;
  memoryIds: string[];
  /** Present only on the single-chunk re-index path. */
  edited?: boolean;
  /** Number of chunks the content was split into. */
  chunks: number;
}

export async function indexMemoryContent(
  params: IndexMemoryContentParams,
): Promise<IndexMemoryContentResult> {
  const { agentId, content, name, scope, source, sourceTaskId, sourcePath, tags } = params;

  // Chunk content and create memories
  const contentChunks = chunkContent(content);
  if (contentChunks.length === 0) {
    contentChunks.push({
      content: content.trim(),
      chunkIndex: 0,
      totalChunks: 1,
      headings: [],
    });
  }

  const store = getMemoryStore();
  const provider = getEmbeddingProvider();

  if (sourcePath && agentId && contentChunks.length === 1) {
    const existing = (
      await store.list(agentId, {
        scope,
        limit: 2,
        ownerAgentId: agentId,
        sourcePath,
      })
    ).filter((memory) => memory.sourcePath === sourcePath);
    if (existing.length === 1 && existing[0]?.totalChunks === 1) {
      const result = await store.edit({
        id: existing[0].id,
        mode: "replace",
        content: contentChunks[0]!.content,
        intent: "re-index memory source path",
        changedByAgentId: agentId,
      });
      const embedding = await provider.embed(contentChunks[0]!.content);
      if (embedding) await store.updateEmbedding(result.memory.id, embedding, provider.name);
      try {
        // Re-index of an existing memory: prune stale content-derived links.
        await refreshLinks(result.memory.id, agentId, result.memory.content);
      } catch (err) {
        console.error(
          `[memory] Link resolution failed for ${result.memory.id}:`,
          (err as Error).message,
        );
      }
      return { queued: false, memoryIds: [result.memory.id], edited: result.changed, chunks: 1 };
    }
  }

  // Dedup multi-chunk or ambiguous source paths via the existing lossy path.
  if (sourcePath && agentId) {
    await store.deleteBySourcePath(sourcePath, agentId);
  }

  // Atomic batch insert: all chunks or none
  const memories = await store.storeBatch(
    contentChunks.map((chunk) => ({
      agentId: agentId || null,
      content: chunk.content,
      name,
      scope,
      source,
      sourcePath: sourcePath || null,
      sourceTaskId: sourceTaskId || null,
      chunkIndex: chunk.chunkIndex,
      totalChunks: chunk.totalChunks,
      tags: tags || [],
      contextKey: params.contextKey ?? null,
      intent: params.intent ?? "index memory content",
      key: sourcePath || null,
    })),
  );

  // Resolve and store deterministic links (wikilinks, PR refs, agent-fs paths)
  if (agentId) {
    for (const memory of memories) {
      try {
        await storeLinks(memory.id, agentId, memory.content);
      } catch (err) {
        console.error(`[memory] Link resolution failed for ${memory.id}:`, (err as Error).message);
      }
    }
  }

  // Async batch embed (fire and forget)
  (async () => {
    try {
      const embeddings = await provider.embedBatch(contentChunks.map((c) => c.content));
      for (let i = 0; i < embeddings.length; i++) {
        if (embeddings[i]) {
          await store.updateEmbedding(memories[i]!.id, embeddings[i]!, provider.name);
        }
      }
    } catch (err) {
      console.error("[memory] Batch embedding failed:", (err as Error).message);
    }
  })().catch((err) =>
    console.error(
      "[memory] batch embed failed:",
      scrubSecrets(err instanceof Error ? err.message : String(err)),
    ),
  );

  return { queued: true, memoryIds: memories.map((m) => m.id), chunks: contentChunks.length };
}
