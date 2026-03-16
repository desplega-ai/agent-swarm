import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { chunkContent } from "../be/chunking";
import {
  createMemory,
  deleteMemoriesBySourcePath,
  getDb,
  searchMemoriesByVector,
  updateMemoryEmbedding,
} from "../be/db";
import { getEmbedding, serializeEmbedding } from "../be/embedding";
import { AgentMemoryScopeSchema, AgentMemorySourceSchema } from "../types";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const indexMemory = route({
  method: "post",
  path: "/api/memory/index",
  pattern: ["api", "memory", "index"],
  summary: "Ingest content into memory system (async embedding)",
  tags: ["Memory"],
  body: z.object({
    agentId: z.string().uuid().optional(),
    content: z.string().min(1),
    name: z.string().min(1),
    scope: AgentMemoryScopeSchema,
    source: AgentMemorySourceSchema,
    sourceTaskId: z.string().uuid().optional(),
    sourcePath: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
  responses: {
    202: { description: "Content queued for embedding" },
    400: { description: "Validation error" },
  },
});

const searchMemory = route({
  method: "post",
  path: "/api/memory/search",
  pattern: ["api", "memory", "search"],
  summary: "Search memories by natural language query",
  tags: ["Memory"],
  auth: { apiKey: true, agentId: true },
  body: z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(20).default(5),
  }),
  responses: {
    200: { description: "Search results" },
    400: { description: "Missing query or agent ID" },
  },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleMemory(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  myAgentId: string | undefined,
): Promise<boolean> {
  if (indexMemory.match(req.method, pathSegments)) {
    const parsed = await indexMemory.parse(req, res, pathSegments, new URLSearchParams());
    if (!parsed) return true;

    const { agentId, content, name, scope, source, sourceTaskId, sourcePath, tags } = parsed.body;

    // Chunk content and create memories in a transaction (with dedup)
    const contentChunks = chunkContent(content);
    if (contentChunks.length === 0) {
      // Content too small to chunk — create a single memory
      contentChunks.push({
        content: content.trim(),
        chunkIndex: 0,
        totalChunks: 1,
        headings: [],
      });
    }

    const memoryIds = getDb().transaction(() => {
      // Delete old chunks if re-indexing same file
      if (sourcePath && agentId) {
        deleteMemoriesBySourcePath(sourcePath, agentId);
      }

      const ids: string[] = [];
      for (const chunk of contentChunks) {
        const memory = createMemory({
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
        });
        ids.push(memory.id);
      }
      return ids;
    })();

    // Async embedding — fire and forget
    (async () => {
      for (let i = 0; i < contentChunks.length; i++) {
        try {
          const embedding = await getEmbedding(contentChunks[i]!.content);
          if (embedding) {
            updateMemoryEmbedding(memoryIds[i]!, serializeEmbedding(embedding));
          }
        } catch (err) {
          console.error(`[memory] Failed to embed chunk ${memoryIds[i]}:`, (err as Error).message);
        }
      }
    })();

    json(res, { queued: true, memoryIds }, 202);
    return true;
  }

  if (searchMemory.match(req.method, pathSegments)) {
    if (!myAgentId) {
      jsonError(res, "Missing required fields: query, X-Agent-ID header", 400);
      return true;
    }

    const parsed = await searchMemory.parse(req, res, pathSegments, new URLSearchParams());
    if (!parsed) return true;

    const { query, limit } = parsed.body;

    try {
      const queryEmbedding = await getEmbedding(query);
      if (!queryEmbedding) {
        json(res, { results: [] });
        return true;
      }

      const results = searchMemoriesByVector(queryEmbedding, myAgentId, {
        scope: "all",
        limit: Math.min(limit, 20),
        isLead: false,
      });

      json(res, {
        results: results.map((r) => ({
          id: r.id,
          name: r.name,
          content: r.content,
          similarity: r.similarity,
          source: r.source,
          scope: r.scope,
        })),
      });
    } catch (err) {
      console.error("[memory-search] Error:", (err as Error).message);
      json(res, { results: [] });
    }
    return true;
  }

  return false;
}
