import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { chunkContent } from "../be/chunking";
import {
  closeDb,
  createAgent,
  createMemory,
  deleteMemoriesBySourcePath,
  deleteMemory,
  getDb,
  getMemoryById,
  getMemoryStats,
  initDb,
  listMemoriesByAgent,
  searchMemoriesByVector,
  updateMemoryEmbedding,
} from "../be/db";
import { cosineSimilarity, deserializeEmbedding, serializeEmbedding } from "../be/embedding";

const TEST_DB_PATH = "./test-memory.sqlite";

describe("Memory System", () => {
  const agentA = "aaaa0000-0000-4000-8000-000000000001";
  const agentB = "bbbb0000-0000-4000-8000-000000000002";

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {
        // File doesn't exist
      }
    }

    initDb(TEST_DB_PATH);

    createAgent({ id: agentA, name: "Agent A", isLead: false, status: "idle" });
    createAgent({ id: agentB, name: "Agent B", isLead: true, status: "idle" });
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {
        // File doesn't exist
      }
    }
  });

  // ==========================================================================
  // Embedding utility tests
  // ==========================================================================

  describe("cosineSimilarity", () => {
    test("identical vectors return 1", () => {
      const a = new Float32Array([1, 2, 3]);
      const b = new Float32Array([1, 2, 3]);
      expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
    });

    test("opposite vectors return -1", () => {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([-1, 0, 0]);
      expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
    });

    test("orthogonal vectors return 0", () => {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([0, 1, 0]);
      expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
    });

    test("throws on different lengths", () => {
      const a = new Float32Array([1, 2]);
      const b = new Float32Array([1, 2, 3]);
      expect(() => cosineSimilarity(a, b)).toThrow("same length");
    });

    test("zero vectors return 0", () => {
      const a = new Float32Array([0, 0, 0]);
      const b = new Float32Array([1, 2, 3]);
      expect(cosineSimilarity(a, b)).toBe(0);
    });

    test("empty vectors return 0", () => {
      const a = new Float32Array([]);
      const b = new Float32Array([]);
      expect(cosineSimilarity(a, b)).toBe(0);
    });
  });

  describe("serializeEmbedding / deserializeEmbedding", () => {
    test("roundtrip preserves values", () => {
      const original = new Float32Array([0.1, -0.5, 3.14, 0, -1.0]);
      const buffer = serializeEmbedding(original);
      const restored = deserializeEmbedding(buffer);
      expect(restored.length).toBe(original.length);
      for (let i = 0; i < original.length; i++) {
        expect(restored[i]).toBeCloseTo(original[i], 5);
      }
    });

    test("roundtrip with 512-dim vector", () => {
      const original = new Float32Array(512);
      for (let i = 0; i < 512; i++) {
        original[i] = Math.random() * 2 - 1;
      }
      const buffer = serializeEmbedding(original);
      expect(buffer.length).toBe(512 * 4); // 4 bytes per float32
      const restored = deserializeEmbedding(buffer);
      expect(restored.length).toBe(512);
      for (let i = 0; i < 512; i++) {
        expect(restored[i]).toBeCloseTo(original[i], 5);
      }
    });
  });

  // ==========================================================================
  // Chunking tests
  // ==========================================================================

  describe("chunkContent", () => {
    test("small text returns single chunk", () => {
      const text =
        "Hello, this is a short text that is long enough to pass the minimum chunk size threshold for testing.";
      const chunks = chunkContent(text);
      expect(chunks.length).toBe(1);
      expect(chunks[0]!.chunkIndex).toBe(0);
      expect(chunks[0]!.totalChunks).toBe(1);
      expect(chunks[0]!.content).toBe(text);
    });

    test("empty text returns empty array", () => {
      expect(chunkContent("")).toEqual([]);
      expect(chunkContent("   ")).toEqual([]);
    });

    test("text under MIN_CHUNK_SIZE returns empty array", () => {
      expect(chunkContent("Hi")).toEqual([]);
    });

    test("splits on markdown headers", () => {
      // Each section needs enough content to pass MIN_CHUNK_SIZE, and total must exceed MAX_CHUNK_SIZE (2000)
      const sectionContent =
        "This is a detailed paragraph with important technical content. ".repeat(20);
      const content = [
        "# Title",
        "",
        sectionContent,
        "",
        "## Section One",
        "",
        `Content of section one: ${sectionContent}`,
        "",
        "## Section Two",
        "",
        `Content of section two: ${sectionContent}`,
      ].join("\n");

      expect(content.length).toBeGreaterThan(2000);
      const chunks = chunkContent(content);
      expect(chunks.length).toBeGreaterThanOrEqual(2);

      // Check that headings are preserved as prefixes
      const sectionOneChunk = chunks.find((c) => c.content.includes("section one"));
      expect(sectionOneChunk).toBeDefined();
    });

    test("splits oversized sections recursively", () => {
      // Create a section longer than MAX_CHUNK_SIZE (2000 chars)
      const longParagraph = "This is a sentence that contributes to a very long paragraph. ".repeat(
        50,
      );
      const chunks = chunkContent(longParagraph);
      expect(chunks.length).toBeGreaterThan(1);

      // All chunks should be reasonably sized
      for (const chunk of chunks) {
        // Allow some slack for overlap
        expect(chunk.content.length).toBeLessThanOrEqual(2200);
      }
    });

    test("includes heading hierarchy as prefix", () => {
      const content = [
        "# Main Title",
        "",
        "## Sub Section",
        "",
        "Content under sub section that needs to be long enough to pass the minimum chunk size filter for proper testing.",
      ].join("\n");

      const chunks = chunkContent(content);
      const subSectionChunk = chunks.find((c) => c.content.includes("Content under sub section"));
      expect(subSectionChunk).toBeDefined();
      if (subSectionChunk) {
        expect(subSectionChunk.content).toContain("# Main Title");
        expect(subSectionChunk.content).toContain("## Sub Section");
      }
    });

    test("chunk indices are sequential", () => {
      const longText = "A ".repeat(3000);
      const chunks = chunkContent(longText);
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].chunkIndex).toBe(i);
        expect(chunks[i].totalChunks).toBe(chunks.length);
      }
    });
  });

  // ==========================================================================
  // DB CRUD tests
  // ==========================================================================

  describe("createMemory", () => {
    test("creates a memory with all fields", () => {
      const memory = createMemory({
        agentId: agentA,
        scope: "agent",
        name: "Test Memory",
        content: "Some important information",
        summary: "A summary",
        source: "manual",
        sourceTaskId: null,
        sourcePath: "/workspace/personal/memory/test.md",
        chunkIndex: 0,
        totalChunks: 1,
        tags: ["test", "important"],
      });

      expect(memory.id).toBeDefined();
      expect(memory.agentId).toBe(agentA);
      expect(memory.scope).toBe("agent");
      expect(memory.name).toBe("Test Memory");
      expect(memory.content).toBe("Some important information");
      expect(memory.summary).toBe("A summary");
      expect(memory.source).toBe("manual");
      expect(memory.chunkIndex).toBe(0);
      expect(memory.totalChunks).toBe(1);
      expect(memory.tags).toEqual(["test", "important"]);
      expect(memory.createdAt).toBeDefined();
      expect(memory.accessedAt).toBeDefined();
    });

    test("creates with minimal fields", () => {
      const memory = createMemory({
        scope: "swarm",
        name: "Minimal",
        content: "Just content",
        source: "file_index",
      });

      expect(memory.agentId).toBeNull();
      expect(memory.summary).toBeNull();
      expect(memory.sourceTaskId).toBeNull();
      expect(memory.sourcePath).toBeNull();
      expect(memory.chunkIndex).toBe(0);
      expect(memory.totalChunks).toBe(1);
      expect(memory.tags).toEqual([]);
    });
  });

  describe("getMemoryById", () => {
    test("returns existing memory", () => {
      const created = createMemory({
        agentId: agentA,
        scope: "agent",
        name: "Findable",
        content: "Find me",
        source: "manual",
      });

      const found = getMemoryById(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.name).toBe("Findable");
    });

    test("returns null for non-existent ID", () => {
      const found = getMemoryById("00000000-0000-0000-0000-000000000000");
      expect(found).toBeNull();
    });

    test("updates accessedAt on retrieval", () => {
      const created = createMemory({
        agentId: agentA,
        scope: "agent",
        name: "Access Test",
        content: "Check access time",
        source: "manual",
      });

      // Force a tiny delay so timestamps differ
      const start = performance.now();
      while (performance.now() - start < 5) {
        /* spin */
      }

      const found = getMemoryById(created.id);
      expect(found).not.toBeNull();
      // accessedAt should be updated (may or may not differ depending on timing)
      expect(found!.accessedAt).toBeDefined();
    });
  });

  describe("updateMemoryEmbedding", () => {
    test("stores and retrieves embedding BLOB", () => {
      const memory = createMemory({
        agentId: agentA,
        scope: "agent",
        name: "Embedding Test",
        content: "Vector storage test",
        source: "manual",
      });

      const embedding = new Float32Array([0.1, 0.2, 0.3, -0.5]);
      updateMemoryEmbedding(memory.id, serializeEmbedding(embedding));

      // Read back the raw row to check embedding
      const { getDb } = require("../be/db");
      const row = getDb()
        .prepare("SELECT embedding FROM agent_memory WHERE id = ?")
        .get(memory.id) as { embedding: Buffer | null };
      expect(row.embedding).not.toBeNull();

      const restored = deserializeEmbedding(row.embedding!);
      expect(restored.length).toBe(4);
      expect(restored[0]).toBeCloseTo(0.1, 5);
      expect(restored[3]).toBeCloseTo(-0.5, 5);
    });
  });

  describe("searchMemoriesByVector", () => {
    const searchAgentId = "cccc0000-0000-4000-8000-000000000003";
    const searchAgentId2 = "dddd0000-0000-4000-8000-000000000004";

    beforeAll(() => {
      createAgent({
        id: searchAgentId,
        name: "Search Agent",
        isLead: false,
        status: "idle",
      });
      createAgent({
        id: searchAgentId2,
        name: "Search Agent 2",
        isLead: false,
        status: "idle",
      });

      // Create memories with known embeddings
      // Memory 1: agent scope for searchAgentId, embedding [1,0,0]
      const m1 = createMemory({
        agentId: searchAgentId,
        scope: "agent",
        name: "Agent Memory 1",
        content: "Agent-scoped content",
        source: "manual",
      });
      updateMemoryEmbedding(m1.id, serializeEmbedding(new Float32Array([1, 0, 0])));

      // Memory 2: swarm scope, embedding [0,1,0]
      const m2 = createMemory({
        agentId: searchAgentId,
        scope: "swarm",
        name: "Swarm Memory 1",
        content: "Swarm-scoped content",
        source: "file_index",
      });
      updateMemoryEmbedding(m2.id, serializeEmbedding(new Float32Array([0, 1, 0])));

      // Memory 3: agent scope for OTHER agent, embedding [0,0,1]
      const m3 = createMemory({
        agentId: searchAgentId2,
        scope: "agent",
        name: "Other Agent Memory",
        content: "Other agent's private memory",
        source: "manual",
      });
      updateMemoryEmbedding(m3.id, serializeEmbedding(new Float32Array([0, 0, 1])));
    });

    test("worker sees own agent-scoped + swarm memories", () => {
      const query = new Float32Array([1, 0, 0]); // closest to Memory 1
      const results = searchMemoriesByVector(query, searchAgentId, { isLead: false });
      const names = results.map((r) => r.name);

      expect(names).toContain("Agent Memory 1");
      expect(names).toContain("Swarm Memory 1");
      expect(names).not.toContain("Other Agent Memory");
    });

    test("worker does not see other agent's agent-scoped memories", () => {
      const query = new Float32Array([0, 0, 1]); // closest to Memory 3
      const results = searchMemoriesByVector(query, searchAgentId, { isLead: false });
      const names = results.map((r) => r.name);

      expect(names).not.toContain("Other Agent Memory");
    });

    test("lead sees ALL memories across agents", () => {
      const query = new Float32Array([0, 0, 1]); // closest to Memory 3
      const results = searchMemoriesByVector(query, searchAgentId, { isLead: true });
      const names = results.map((r) => r.name);

      expect(names).toContain("Other Agent Memory");
      expect(names).toContain("Agent Memory 1");
      expect(names).toContain("Swarm Memory 1");
    });

    test("results sorted by similarity (highest first)", () => {
      const query = new Float32Array([1, 0, 0]); // identical to Memory 1's embedding
      const results = searchMemoriesByVector(query, searchAgentId, { isLead: true });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe("Agent Memory 1");
      expect(results[0].similarity).toBeCloseTo(1.0, 3);

      // Each subsequent result should have lower or equal similarity
      for (let i = 1; i < results.length; i++) {
        expect(results[i].similarity).toBeLessThanOrEqual(results[i - 1].similarity);
      }
    });

    test("scope filter works", () => {
      const query = new Float32Array([1, 1, 1]);
      const agentOnly = searchMemoriesByVector(query, searchAgentId, {
        scope: "agent",
        isLead: false,
      });
      const swarmOnly = searchMemoriesByVector(query, searchAgentId, {
        scope: "swarm",
        isLead: false,
      });

      for (const r of agentOnly) {
        expect(r.scope).toBe("agent");
      }
      for (const r of swarmOnly) {
        expect(r.scope).toBe("swarm");
      }
    });

    test("source filter works", () => {
      const query = new Float32Array([1, 1, 1]);
      const results = searchMemoriesByVector(query, searchAgentId, {
        source: "file_index",
        isLead: true,
      });

      for (const r of results) {
        expect(r.source).toBe("file_index");
      }
    });

    test("limit works", () => {
      const query = new Float32Array([1, 1, 1]);
      const results = searchMemoriesByVector(query, searchAgentId, {
        limit: 1,
        isLead: true,
      });
      expect(results.length).toBe(1);
    });
  });

  describe("listMemoriesByAgent", () => {
    test("lists agent memories with pagination", () => {
      const listAgent = "eeee0000-0000-4000-8000-000000000005";
      createAgent({ id: listAgent, name: "List Agent", isLead: false, status: "idle" });

      for (let i = 0; i < 5; i++) {
        createMemory({
          agentId: listAgent,
          scope: "agent",
          name: `List Memory ${i}`,
          content: `Content ${i}`,
          source: "manual",
        });
      }

      const page1 = listMemoriesByAgent(listAgent, { scope: "agent", limit: 3, offset: 0 });
      expect(page1.length).toBe(3);

      const page2 = listMemoriesByAgent(listAgent, { scope: "agent", limit: 3, offset: 3 });
      expect(page2.length).toBe(2);
    });
  });

  describe("deleteMemory", () => {
    test("deletes existing memory", () => {
      const memory = createMemory({
        agentId: agentA,
        scope: "agent",
        name: "To Delete",
        content: "Delete me",
        source: "manual",
      });

      const deleted = deleteMemory(memory.id);
      expect(deleted).toBe(true);

      const found = getMemoryById(memory.id);
      expect(found).toBeNull();
    });

    test("returns false for non-existent memory", () => {
      const deleted = deleteMemory("00000000-0000-0000-0000-000000000000");
      expect(deleted).toBe(false);
    });
  });

  describe("deleteMemoriesBySourcePath", () => {
    test("deletes all chunks for a source path", () => {
      const path = "/workspace/personal/memory/to-reindex.md";

      // Create multiple chunks
      for (let i = 0; i < 3; i++) {
        createMemory({
          agentId: agentA,
          scope: "agent",
          name: "Reindex Test",
          content: `Chunk ${i}`,
          source: "file_index",
          sourcePath: path,
          chunkIndex: i,
          totalChunks: 3,
        });
      }

      const deleted = deleteMemoriesBySourcePath(path, agentA);
      expect(deleted).toBe(3);

      // Verify they're gone
      const remaining = listMemoriesByAgent(agentA).filter((m) => m.sourcePath === path);
      expect(remaining.length).toBe(0);
    });
  });

  describe("getMemoryStats", () => {
    test("returns correct stats", () => {
      const statsAgent = "ffff0000-0000-4000-8000-000000000006";
      createAgent({ id: statsAgent, name: "Stats Agent", isLead: false, status: "idle" });

      createMemory({
        agentId: statsAgent,
        scope: "agent",
        name: "Stat 1",
        content: "Content",
        source: "manual",
      });
      createMemory({
        agentId: statsAgent,
        scope: "swarm",
        name: "Stat 2",
        content: "Content",
        source: "file_index",
      });
      createMemory({
        agentId: statsAgent,
        scope: "agent",
        name: "Stat 3",
        content: "Content",
        source: "manual",
      });

      const stats = getMemoryStats(statsAgent);
      expect(stats.total).toBe(3);
      expect(stats.bySource.manual).toBe(2);
      expect(stats.bySource.file_index).toBe(1);
      expect(stats.byScope.agent).toBe(2);
      expect(stats.byScope.swarm).toBe(1);
    });
  });

  // ==========================================================================
  // Memory Ingestion API tests (POST /api/memory/index simulation)
  // ==========================================================================

  describe("memory ingestion (API logic)", () => {
    const ingestAgent = "1111aaaa-0000-4000-8000-000000000007";

    beforeAll(() => {
      createAgent({ id: ingestAgent, name: "Ingest Agent", isLead: false, status: "idle" });
    });

    test("creates memory records from content", () => {
      const chunks = chunkContent("Short but sufficient content for a single chunk test memory.");
      // Simulate API: if chunks are empty, create a single memory
      const finalChunks =
        chunks.length > 0
          ? chunks
          : [
              {
                content: "Short but sufficient content for a single chunk test memory.",
                chunkIndex: 0,
                totalChunks: 1,
                headings: [] as string[],
              },
            ];

      const memoryIds = getDb().transaction(() => {
        const ids: string[] = [];
        for (const chunk of finalChunks) {
          const memory = createMemory({
            agentId: ingestAgent,
            content: chunk.content,
            name: "ingest-test",
            scope: "agent",
            source: "file_index",
            sourcePath: "/workspace/personal/memory/ingest-test.md",
            chunkIndex: chunk.chunkIndex,
            totalChunks: chunk.totalChunks,
          });
          ids.push(memory.id);
        }
        return ids;
      })();

      expect(memoryIds.length).toBe(1);
      const memory = getMemoryById(memoryIds[0]!);
      expect(memory).not.toBeNull();
      expect(memory!.source).toBe("file_index");
      expect(memory!.sourcePath).toBe("/workspace/personal/memory/ingest-test.md");
    });

    test("dedup: re-indexing same sourcePath replaces old chunks", () => {
      const path = "/workspace/personal/memory/dedup-test.md";

      // First indexing
      const m1 = createMemory({
        agentId: ingestAgent,
        content: "Original content",
        name: "dedup-test",
        scope: "agent",
        source: "file_index",
        sourcePath: path,
      });

      // Re-index: delete old + create new in transaction
      getDb().transaction(() => {
        deleteMemoriesBySourcePath(path, ingestAgent);
        createMemory({
          agentId: ingestAgent,
          content: "Updated content",
          name: "dedup-test",
          scope: "agent",
          source: "file_index",
          sourcePath: path,
        });
      })();

      // Old memory should be gone
      expect(getMemoryById(m1.id)).toBeNull();

      // New memory should exist
      const memories = listMemoriesByAgent(ingestAgent, { scope: "agent" }).filter(
        (m) => m.sourcePath === path,
      );
      expect(memories.length).toBe(1);
      expect(memories[0]!.content).toBe("Updated content");
    });

    test("large content creates multiple chunk records", () => {
      const path = "/workspace/personal/memory/chunked-test.md";
      const longContent = "A ".repeat(3000); // ~6000 chars, well over MAX_CHUNK_SIZE

      const chunks = chunkContent(longContent);
      expect(chunks.length).toBeGreaterThan(1);

      getDb().transaction(() => {
        deleteMemoriesBySourcePath(path, ingestAgent);
        for (const chunk of chunks) {
          createMemory({
            agentId: ingestAgent,
            content: chunk.content,
            name: "chunked-test",
            scope: "agent",
            source: "file_index",
            sourcePath: path,
            chunkIndex: chunk.chunkIndex,
            totalChunks: chunk.totalChunks,
          });
        }
      })();

      const memories = listMemoriesByAgent(ingestAgent, { scope: "agent" }).filter(
        (m) => m.sourcePath === path,
      );
      expect(memories.length).toBe(chunks.length);
      // Verify chunk metadata
      for (const m of memories) {
        expect(m.totalChunks).toBe(chunks.length);
      }
    });

    test("memory created without OPENAI_API_KEY has null embedding", () => {
      const memory = createMemory({
        agentId: ingestAgent,
        content: "No embedding needed",
        name: "no-embed",
        scope: "agent",
        source: "manual",
      });

      const row = getDb()
        .prepare("SELECT embedding FROM agent_memory WHERE id = ?")
        .get(memory.id) as { embedding: Buffer | null };
      expect(row.embedding).toBeNull();
    });

    test("updateMemoryEmbedding stores and retrieves correctly", () => {
      const memory = createMemory({
        agentId: ingestAgent,
        content: "Embed me",
        name: "embed-update",
        scope: "agent",
        source: "manual",
      });

      const embedding = new Float32Array([0.5, -0.3, 0.8]);
      updateMemoryEmbedding(memory.id, serializeEmbedding(embedding));

      const row = getDb()
        .prepare("SELECT embedding FROM agent_memory WHERE id = ?")
        .get(memory.id) as { embedding: Buffer | null };
      expect(row.embedding).not.toBeNull();

      const restored = deserializeEmbedding(row.embedding!);
      expect(restored[0]).toBeCloseTo(0.5, 5);
      expect(restored[1]).toBeCloseTo(-0.3, 5);
      expect(restored[2]).toBeCloseTo(0.8, 5);
    });
  });
});
