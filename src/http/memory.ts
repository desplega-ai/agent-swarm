import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createMemory,
  deleteMemoriesBySourcePath,
  getDb,
  searchMemoriesByVector,
  updateMemoryEmbedding,
} from "../be/db";
import { getEmbedding, serializeEmbedding } from "../be/embedding";
import { chunkContent } from "../be/chunking";

export async function handleMemory(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  myAgentId: string | undefined,
): Promise<boolean> {
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "memory" &&
    pathSegments[2] === "index" &&
    !pathSegments[3]
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    const { agentId, content, name, scope, source, sourceTaskId, sourcePath, tags } = body;

    if (!content || !name || !scope || !source) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required fields: content, name, scope, source" }));
      return true;

    }

    if (!["agent", "swarm"].includes(scope)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "scope must be 'agent' or 'swarm'" }));
      return true;

    }

    if (!["manual", "file_index", "session_summary", "task_completion"].includes(source)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid source type" }));
      return true;

    }

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

    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ queued: true, memoryIds }));
    return true;

  }

  // POST /api/memory/search - Search memories by natural language query
  if (
    req.method === "POST" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "memory" &&
    pathSegments[2] === "search" &&
    !pathSegments[3]
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const { query, limit = 5 } = body;
    const searchAgentId = myAgentId;

    if (!query || !searchAgentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required fields: query, X-Agent-ID header" }));
      return true;

    }

    try {
      const queryEmbedding = await getEmbedding(query);
      if (!queryEmbedding) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
        return true;

      }

      const results = searchMemoriesByVector(queryEmbedding, searchAgentId, {
        scope: "all",
        limit: Math.min(limit, 20),
        isLead: false,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          results: results.map((r) => ({
            id: r.id,
            name: r.name,
            content: r.content,
            similarity: r.similarity,
            source: r.source,
            scope: r.scope,
          })),
        }),
      );
    } catch (err) {
      console.error("[memory-search] Error:", (err as Error).message);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    }
    return true;

  }


  return false;
}
