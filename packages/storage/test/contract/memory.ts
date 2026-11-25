import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MemoryRepository, MemorySearchFilter, NewMemory, Storage } from "../../src";
import { jsonText, sql } from "../../src";
import type { ContractEngine } from "./env";

const AGENT = "aaaa0000-0000-4000-8000-00000000a001";
const OTHER = "aaaa0000-0000-4000-8000-00000000a002";
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-02T00:00:00.000Z";
const T2 = "2026-01-03T00:00:00.000Z";

function memory(overrides: Partial<NewMemory> & { id: string }): NewMemory {
  return {
    agentId: AGENT,
    scope: "agent",
    key: `/agent/manual/${overrides.id}`,
    name: `name-${overrides.id}`,
    content: `content-${overrides.id}`,
    summary: null,
    source: "manual",
    sourceTaskId: null,
    sourcePath: null,
    chunkIndex: 0,
    totalChunks: 1,
    tags: "[]",
    now: T0,
    expiresAt: null,
    contextKey: null,
    contentHash: `hash-${overrides.id}`,
    version: 1,
    ...overrides,
  };
}

const searchAll = (agentId = AGENT): MemorySearchFilter => ({
  agentId,
  scope: "all",
  isLead: false,
  includeExpired: true,
});

export function memoryContract(engine: ContractEngine): void {
  describe(`memory repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: MemoryRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.memory;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    const insertTask = async (id: string, taskType: string | null, tags: string) => {
      await storage.executor.run(sql`
        INSERT INTO agent_tasks (id, task, status, "createdAt", "lastUpdatedAt", "taskType", tags)
        VALUES (${id}, 'task', 'completed', ${T0}, ${T0}, ${taskType}, ${jsonText(tags)})`);
    };

    test("insertMemory returns the stored row in the SQLite value shape", async () => {
      const row = await repo.insertMemory(
        memory({ id: "m1", tags: '["a"]', expiresAt: T2, contextKey: "ctx" }),
      );
      expect(row).toMatchObject({
        id: "m1",
        agentId: AGENT,
        scope: "agent",
        key: "/agent/manual/m1",
        tags: '["a"]',
        createdAt: T0,
        updatedAt: T0,
        accessedAt: T0,
        expiresAt: T2,
        accessCount: 0,
        embedding: null,
        embeddingModel: null,
        alpha: 1,
        beta: 1,
        version: 1,
        chunkIndex: 0,
        totalChunks: 1,
      });
      await repo.insertMemoryVersion({
        id: "v1",
        memoryId: "m1",
        version: 1,
        content: "c",
        contentHash: "h",
        intent: "create memory",
        operation: "create",
        changedByAgentId: AGENT,
        now: T0,
      });
      const version = await storage.executor.get<Record<string, unknown>>(
        sql`SELECT operation, "changedByAgentId", created_by, updated_by FROM agent_memory_version WHERE id = 'v1'`,
      );
      expect(version).toEqual({
        operation: "create",
        changedByAgentId: AGENT,
        created_by: AGENT,
        updated_by: AGENT,
      });
      await repo.touchMemory("m1", T1);
      expect(await repo.findMemoryById("m1")).toMatchObject({ accessedAt: T1, accessCount: 1 });
      expect(await repo.findMemoryById("missing")).toBeNull();
    });

    test("documents: owner matching treats NULL as an owner, chunks come in chunkIndex order", async () => {
      await repo.insertMemory(memory({ id: "c1", key: "/doc", chunkIndex: 1, totalChunks: 2 }));
      await repo.insertMemory(memory({ id: "c0", key: "/doc", chunkIndex: 0, totalChunks: 2 }));
      await repo.insertMemory(
        memory({ id: "n0", key: "/doc", agentId: null, scope: "swarm", source: "file_index" }),
      );
      const owner = { key: "/doc", scope: "agent", agentId: AGENT };
      expect((await repo.listChunks(owner)).map((r) => r.id)).toEqual(["c0", "c1"]);
      expect((await repo.findFirstChunk(owner))?.id).toBe("c0");
      expect((await repo.listDocumentIds(owner)).sort()).toEqual(["c0", "c1"]);
      const nullOwner = { key: "/doc", scope: "swarm", agentId: null };
      expect(await repo.listDocumentIdsOfSource(nullOwner, "file_index")).toEqual(["n0"]);
      expect(await repo.listDocumentIdsOfSource(nullOwner, "manual")).toEqual([]);
      expect(await repo.findAnyIdOfDocument(nullOwner)).toBe("n0");
      expect(await repo.findAnyIdOfDocument({ ...owner, key: "/none" })).toBeNull();
      expect(await repo.deleteMemoriesByIds(["c0", "c1"])).toBe(2);
      expect(await repo.deleteMemoriesByIds([])).toBe(0);
      expect(await repo.listChunks(owner)).toEqual([]);
    });

    test("updateChunk keeps the expiry unless resetExpiry", async () => {
      await repo.insertMemory(memory({ id: "e1", expiresAt: T2 }));
      const base = {
        id: "e1",
        content: "new",
        contentHash: "h2",
        version: 2,
        updatedAt: T1,
        key: "/moved",
      };
      await repo.updateChunk({ ...base, resetExpiry: false, expiresAt: null });
      expect(await repo.findMemoryById("e1")).toMatchObject({
        content: "new",
        key: "/moved",
        version: 2,
        expiresAt: T2,
      });
      await repo.updateChunk({ ...base, resetExpiry: true, expiresAt: null });
      expect((await repo.findMemoryById("e1"))?.expiresAt).toBeNull();
    });

    test("rewriteForScrub is a compare-and-set that matches NULL summaries", async () => {
      await repo.insertMemory(memory({ id: "s1", name: "n", content: "secret", summary: null }));
      await repo.setEmbedding("s1", new Uint8Array([1, 2, 3, 4]), "model");
      const before = { name: "n", content: "secret", summary: null };
      const after = { name: "n", content: "[redacted]", summary: null, contentHash: "h" };
      expect(
        await repo.rewriteForScrub(
          "s1",
          { ...before, content: "moved" },
          {
            ...after,
            dropEmbedding: true,
          },
        ),
      ).toBe(0);
      expect(await repo.rewriteForScrub("s1", before, { ...after, dropEmbedding: false })).toBe(1);
      expect(await repo.findMemoryById("s1")).toMatchObject({
        content: "[redacted]",
        embeddingModel: "model",
      });
      const scrubbed = { name: "n", content: "[redacted]", summary: null };
      expect(await repo.rewriteForScrub("s1", scrubbed, { ...after, dropEmbedding: true })).toBe(1);
      expect(await repo.findMemoryById("s1")).toMatchObject({
        embedding: null,
        embeddingModel: null,
      });
    });

    test("setEmbedding reports a missing row; invalid embeddings are counted", async () => {
      expect(await repo.setEmbedding("missing", new Uint8Array([1]), "m")).toBe(0);
      await repo.insertMemory(memory({ id: "a" }));
      await repo.insertMemory(memory({ id: "b" }));
      expect(await repo.setEmbedding("a", new Uint8Array(8), "m")).toBe(1);
      expect(await repo.countInvalidEmbeddings(8)).toBe(1);
      expect(await repo.countInvalidEmbeddings(4)).toBe(2);
      expect((await repo.listInvalidEmbeddings(8)).map((r) => r.id)).toEqual(["b"]);
      await repo.clearEmbedding("a");
      expect(await repo.countInvalidEmbeddings(8)).toBe(2);
      expect(await repo.listContentAfter("a", 10)).toEqual([{ id: "b", content: "content-b" }]);
      expect((await repo.listContentAfter("", 1)).map((r) => r.id)).toEqual(["a"]);
    });

    test("list pages rows with one createdAt in insertion order, with no skip or repeat", async () => {
      const ids = Array.from({ length: 48 }, (_, i) => `tie-${String(47 - i).padStart(2, "0")}`);
      for (const id of ids) await repo.insertMemory(memory({ id, now: T1 }));
      const base = { agentId: AGENT, scope: "all", isLead: false };
      const full = (await repo.list(base, 100, 0)).map((r) => r.id);
      expect(full).toEqual(ids);
      const paged: string[] = [];
      for (let offset = 0; offset < ids.length; offset++) {
        paged.push(...(await repo.list(base, 1, offset)).map((r) => r.id));
      }
      expect(paged).toEqual(full);
    });

    test("list orders by createdAt descending and filters by visibility, owner, source and path", async () => {
      await repo.insertMemory(memory({ id: "old", now: T0, sourcePath: "/Work/Notes.md" }));
      await repo.insertMemory(memory({ id: "new", now: T2, source: "file_index" }));
      await repo.insertMemory(memory({ id: "mid", now: T1, agentId: OTHER, scope: "swarm" }));
      await repo.insertMemory(memory({ id: "hidden", now: T1, agentId: OTHER }));
      const base = { agentId: AGENT, scope: "all", isLead: false };
      expect((await repo.list(base, 10, 0)).map((r) => r.id)).toEqual(["new", "mid", "old"]);
      expect((await repo.list(base, 1, 1)).map((r) => r.id)).toEqual(["mid"]);
      expect(await repo.count(base)).toBe(3);
      expect(await repo.count({ ...base, isLead: true })).toBe(4);
      expect(await repo.count({ ...base, scope: "swarm" })).toBe(1);
      expect(await repo.count({ ...base, source: "file_index" })).toBe(1);
      expect(await repo.count({ ...base, ownerAgentId: OTHER })).toBe(1);
      expect(
        (await repo.list({ ...base, sourcePathNeedle: "work/notes" }, 10, 0)).map((r) => r.id),
      ).toEqual(["old"]);
      expect(await repo.count({ ...base, keyPrefix: "/agent/manual/o" })).toBe(1);
      // A literal prefix: `%` is text.
      expect(await repo.count({ ...base, keyPrefix: "/agent/%" })).toBe(0);
    });

    test("expiry: expired ids come in id order and the recheck keeps only still-expired rows", async () => {
      await repo.insertMemory(memory({ id: "x2", expiresAt: "2000-01-01T00:00:00.000Z" }));
      await repo.insertMemory(memory({ id: "x1", expiresAt: "2000-01-01T00:00:00.000Z" }));
      await repo.insertMemory(memory({ id: "live", expiresAt: "2999-01-01T00:00:00.000Z" }));
      expect(await repo.listExpiredIds()).toEqual(["x1", "x2"]);
      expect((await repo.filterStillExpired(["x1", "live"])).sort()).toEqual(["x1"]);
      expect(await repo.filterStillExpired([])).toEqual([]);
      const stats = await repo.getStatsRows(AGENT);
      expect(stats.total).toBe(3);
      expect(stats.expired).toBe(2);
      expect(stats.withEmbeddings).toBe(0);
      expect(stats.bySource).toEqual([{ source: "manual", count: 3 }]);
    });

    test("curation skips protected sources and /longterm keys", async () => {
      await repo.insertMemory(memory({ id: "auto", source: "task_completion", key: "/t/1" }));
      await repo.insertMemory(memory({ id: "man", source: "manual", key: "/m/1" }));
      await repo.insertMemory(memory({ id: "lt", source: "task_completion", key: "/longterm/f" }));
      await repo.insertMemory(memory({ id: "root", source: "task_completion", key: "/longterm" }));
      await repo.insertMemory(
        memory({ id: "near", source: "task_completion", key: "/longtermx", agentId: OTHER }),
      );
      const ids = async (agentId?: string) =>
        (await repo.listForCuration(agentId, ["manual"], "/longterm")).map((r) => r.id).sort();
      expect(await ids()).toEqual(["auto", "near"]);
      expect(await ids(AGENT)).toEqual(["auto"]);
    });

    test("learning replay matches the root prefix ASCII-case-insensitively", async () => {
      await repo.insertMemory(
        memory({
          id: "l1",
          key: "/LEARNINGS/ops/x",
          scope: "swarm",
          sourceTaskId: null,
          contentHash: "h",
        }),
      );
      await storage.executor.run(
        sql`UPDATE agent_memory SET "sourceTaskId" = 't1' WHERE id = 'l1'`,
      );
      expect(await repo.findLearningReplay("t1", "h", "/learnings")).toEqual({
        id: "l1",
        key: "/LEARNINGS/ops/x",
      });
      expect(await repo.findLearningReplay("t1", "other", "/learnings")).toBeNull();
      expect(await repo.findSwarmIdByKey("/LEARNINGS/ops/x")).toBe("l1");
      expect(await repo.findSwarmIdByKey("/none")).toBeNull();
    });

    test("search arms: brute force and capped sets honour the filter; capped order is updatedAt desc, id", async () => {
      await repo.insertMemory(memory({ id: "b", now: T1 }));
      await repo.insertMemory(memory({ id: "a", now: T1 }));
      await repo.insertMemory(memory({ id: "c", now: T2 }));
      await repo.insertMemory(memory({ id: "none", now: T2 }));
      await repo.insertMemory(memory({ id: "theirs", now: T2, agentId: OTHER }));
      for (const id of ["a", "b", "c", "theirs"])
        await repo.setEmbedding(id, new Uint8Array(4), "m");
      const filter = searchAll();
      expect((await repo.listEmbeddedRows(filter)).map((r) => r.id).sort()).toEqual([
        "a",
        "b",
        "c",
      ]);
      expect((await repo.listCappedEmbeddings(filter, 10)).map((r) => r.id)).toEqual([
        "c",
        "a",
        "b",
      ]);
      expect((await repo.listCappedEmbeddings(filter, 2)).map((r) => r.id)).toEqual(["c", "a"]);
      expect(await repo.countCappedRows(filter, 2)).toBe(2);
      expect(await repo.countCappedRows({ ...filter, isLead: true }, 10)).toBe(4);
      expect((await repo.listRowsByIds(["a", "c"])).map((r) => r.id).sort()).toEqual(["a", "c"]);
      expect(await repo.listRowsByIds([])).toEqual([]);
      expect((await repo.listEmbeddingsByIds(["none"]))[0]).toEqual({
        id: "none",
        embedding: null,
      });
    });

    test("search filter: expiry and the review-task exclusion", async () => {
      await insertTask("review-task", "review", "[]");
      await insertTask("tagged-task", null, '["re-review"]');
      // A JSON scalar that equals a rule tag is not a tag list (jsonb cannot hold invalid JSON).
      await insertTask("plain-task", null, '"re-review"');
      const add = async (id: string, sourceTaskId: string | null, expiresAt: string | null) => {
        await repo.insertMemory(memory({ id, source: "task_completion", sourceTaskId, expiresAt }));
        await repo.setEmbedding(id, new Uint8Array(4), "m");
      };
      await add("r1", "review-task", null);
      await add("r2", "tagged-task", null);
      await add("p1", "plain-task", null);
      await add("gone", null, "2000-01-01T00:00:00.000Z");
      const rule = { taskType: "review", tags: ["re-review", "pr-review-demo"] };
      const ids = async (filter: MemorySearchFilter) =>
        (await repo.listEmbeddedRows(filter)).map((r) => r.id).sort();
      expect(await ids(searchAll())).toEqual(["gone", "p1", "r1", "r2"]);
      expect(await ids({ ...searchAll(), includeExpired: false })).toEqual(["p1", "r1", "r2"]);
      expect(await ids({ ...searchAll(), excludeReviewTaskCompletions: rule })).toEqual([
        "gone",
        "p1",
      ]);
      expect((await repo.listTaskKinds(["review-task"]))[0]).toEqual({
        id: "review-task",
        taskType: "review",
        tags: "[]",
      });
    });

    test("ratings, posteriors and reference edges", async () => {
      await repo.insertMemory(memory({ id: "m" }));
      expect(await repo.memoryExists("m")).toBe(true);
      expect(await repo.memoryExists("nope")).toBe(false);
      await repo.addPosterior("m", 0.5, 0.25);
      expect(await repo.getPosteriorsByIds(["m"])).toEqual([{ id: "m", alpha: 1.5, beta: 1.25 }]);
      for (const [id, source, signal] of [
        ["r1", "explicit-self", 1],
        ["r2", "llm", -0.5],
        ["r3", "llm", 1],
      ] as const) {
        await repo.insertRating({
          id,
          memoryId: "m",
          taskId: null,
          source,
          signal,
          weight: 1,
          reasoning: null,
          createdAt: T0,
          contextKey: null,
          model: source === "llm" ? "x" : null,
        });
      }
      expect(await repo.listDemotionEvidence(["m"])).toEqual([
        { memoryId: "m", selfAlpha: 1, selfBeta: 0, llmAlpha: 1, llmBeta: 0.5, llmCount: 2 },
      ]);
      await repo.upsertReferenceEdge("m", "pr#1", 0.5, 0, T0);
      await repo.upsertReferenceEdge("m", "pr#1", 0, 0.25, T1);
      await repo.upsertReferenceEdge("m", "pr#2", 0, 0, T2);
      expect(await repo.listReferenceEdges("m")).toEqual([
        { to_id: "pr#2", alpha: 1, beta: 1, createdAt: T2 },
        { to_id: "pr#1", alpha: 1.5, beta: 1.25, createdAt: T0 },
      ]);
      expect(await repo.getScopeOwner("m")).toEqual({ scope: "agent", agentId: AGENT });
    });

    test("retrievals: newest first, filtered by agent and task, stale search rows purged in batches", async () => {
      await insertTask("t1", null, "[]");
      await repo.insertMemory(memory({ id: "m", content: "abcdef" }));
      const add = async (id: string, retrievedAt: string, eventType = "search", agentId = AGENT) =>
        repo.insertRetrieval({
          id,
          taskId: "t1",
          agentId,
          sessionId: "s",
          memoryId: "m",
          similarity: 0.5,
          retrievedAt,
          contextKey: null,
          intent: null,
          eventType,
          retrievalId: "g",
          rank: 0,
          retrievalSource: "vec",
          relevance: null,
        });
      await add("r0", T0);
      await add("r2", T2, "get");
      await add("r1", T1);
      await add("theirs", T2, "search", OTHER);
      const rows = await repo.listRetrievalsForAgent(AGENT, { taskId: "t1" }, 3, 10);
      expect(rows.map((r) => r.retrievedAt)).toEqual([T2, T1, T0]);
      expect(rows[0]).toEqual({
        id: "m",
        name: "name-m",
        content: "abc",
        scope: "agent",
        source: "manual",
        scheduleId: null,
        similarity: 0.5,
        retrievalSource: "vec",
        retrievedAt: T2,
      });
      expect(await repo.listRetrievalsForAgent(AGENT, { sessionId: "x" }, 3, 10)).toEqual([]);
      expect(await repo.hasRetrievalForTask("t1", "m")).toBe(true);
      expect(await repo.hasRetrievalForTask("t1", "other")).toBe(false);
      expect((await repo.listRetrievalsForTask("t1")).length).toBe(4);
      const usefulness = await repo.getUsefulnessRows(T0, 0.6);
      expect(usefulness.volume).toEqual({
        retrievals: 3,
        distinctMemories: 1,
        retrievalGroups: 1,
        searchEvents: 2,
        getEvents: 1,
      });
      expect(usefulness.totalRetrievalRows).toBe(4);
      expect(await repo.purgeSearchRetrievalsBefore(T2, 1)).toBe(1);
      expect(await repo.purgeSearchRetrievalsBefore(T2, 5)).toBe(1);
      expect(await repo.purgeSearchRetrievalsBefore(T2, 5)).toBe(0);
      expect((await repo.listRetrievalsForTask("t1")).length).toBe(2);
    });

    test("links: insert-if-absent, content links, outgoing and backlinks in createdAt, id order", async () => {
      await repo.insertMemory(memory({ id: "from" }));
      await repo.insertMemory(memory({ id: "to", scope: "swarm", agentId: OTHER }));
      await repo.insertMemory(memory({ id: "private", agentId: OTHER }));
      const link = (id: string, targetId: string, now: string, linkType = "wikilink") => ({
        id,
        fromMemoryId: "from",
        linkType,
        targetKind: "memory",
        targetId,
        strength: 1,
        resolver: "test",
        sourceText: linkType === "sequel" ? null : `[[${targetId}]]`,
        metadata: null,
        now,
      });
      await repo.insertLinkIfAbsent(link("l2", "to", T1));
      await repo.insertLinkIfAbsent(link("l1", "private", T1));
      await repo.insertLinkIfAbsent(link("dup", "to", T2));
      await repo.insertLinkIfAbsent(link("seq", "to", T0, "sequel"));
      // A row the linkType CHECK refuses is skipped, inside a transaction too.
      await storage.transaction(async () => {
        await repo.insertLinkIfAbsent(link("bad", "to", T1, "not-a-link-type"));
        expect(await repo.memoryExists("from")).toBe(true);
      });
      expect((await repo.listOutgoingLinks("from")).map((r) => r.id)).toEqual(["seq", "l1", "l2"]);
      expect((await repo.listContentLinks("from")).map((r) => r.id).sort()).toEqual(["l1", "l2"]);
      const back = await repo.listBacklinks("to", { isLead: false, viewerAgentId: AGENT });
      expect(back.map((r) => r.id)).toEqual(["seq", "l2"]);
      expect(back[0]).toMatchObject({ fromId: "from", fromScope: "agent" });
      expect(await repo.listBacklinks("to", { isLead: false, viewerAgentId: OTHER })).toEqual([]);
      const neighbors = await repo.listGraphNeighbors(["from"], {
        agentId: AGENT,
        scope: "all",
        isLead: false,
      });
      expect(neighbors.map((r) => r.id).sort()).toEqual(["to", "to"]);
      expect(neighbors[0]).toMatchObject({ fromMemoryId: "from", linkStrength: 1 });
      await repo.deleteLink("l2");
      expect((await repo.listContentLinks("from")).map((r) => r.id)).toEqual(["l1"]);
      expect(await repo.findIdByNameVisible("name-to", AGENT)).toBe("to");
      expect(await repo.findIdByNameVisible("name-private", AGENT)).toBeNull();
    });

    test("key browser: one summary per document in key order; chunk rows in chunk order", async () => {
      await repo.insertMemory(
        memory({ id: "b1", key: "/longterm/b", chunkIndex: 1, totalChunks: 2 }),
      );
      await repo.insertMemory(
        memory({ id: "b0", key: "/longterm/b", chunkIndex: 0, totalChunks: 2 }),
      );
      await repo.insertMemory(memory({ id: "a0", key: "/longterm/a", now: T1 }));
      await repo.insertMemory(memory({ id: "o0", key: "/longterm/a", agentId: OTHER }));
      await repo.insertMemory(memory({ id: "x", key: "/other" }));
      const keys = await repo.listKeySummaries("/longterm/", AGENT, 10);
      expect(keys.map((k) => [k.key, k.memoryId])).toEqual([
        ["/longterm/a", "a0"],
        ["/longterm/b", "b0"],
      ]);
      expect(keys[1]).toMatchObject({
        chunkRows: 2,
        totalChunks: 2,
        distinctIndexes: 2,
        maxIndex: 1,
      });
      expect((await repo.listKeySummaries("/longterm/", undefined, 10)).length).toBe(3);
      expect((await repo.listKeySummaries("/longterm/", undefined, 1)).length).toBe(1);
      const owner = { key: "/longterm/b", scope: "agent", agentId: AGENT };
      expect((await repo.listChunkRowsOfDocument(owner)).map((r) => r.id)).toEqual(["b0", "b1"]);
      expect((await repo.findChunkRowById("b1")) as Record<string, unknown>).not.toHaveProperty(
        "embedding",
      );
      expect((await repo.listChunkRowsByKey({ key: "/longterm/a" })).map((r) => r.id)).toEqual([
        "a0",
        "o0",
      ]);
      expect(
        (await repo.listChunkRowsByKey({ key: "/longterm/a", visibleToAgentId: OTHER })).map(
          (r) => r.id,
        ),
      ).toEqual(["o0"]);
    });

    // ---- D15 search parity on a fixed corpus (no engine branches) ----

    const blob = (values: number[]) => new Uint8Array(new Float32Array(values).buffer);

    /** The fixed full-text corpus: name, content, owner. */
    const FTS_CORPUS: [string, string, string, string][] = [
      ["d1", "deploy runbook", "Restart the worker pods after a failed deploy.", AGENT],
      ["d2", "postgres tuning", "Raise shared buffers; vacuum the memory table nightly.", AGENT],
      ["d3", "slack etiquette", "Reply in the thread, never in the channel.", AGENT],
      [
        "d4",
        "deploy checklist",
        "Run migrations before the deploy, then deploy the workers.",
        AGENT,
      ],
      [
        "d5",
        "vector search",
        "Embeddings use cosine distance with exact nearest neighbours.",
        AGENT,
      ],
      ["d6", "their deploy", "deploy deploy deploy the workers", OTHER],
      ["d7", "worker notes", "The workers restarted twice during the deploy window.", AGENT],
      ["d8", "paths", "See src/be/memory.ts and e-mail ops@example.com about it.", AGENT],
    ];

    const seedFtsCorpus = async () => {
      await engine.prepareMemorySearch(storage, 4);
      for (const [id, name, content, agentId] of FTS_CORPUS) {
        await repo.insertMemory(memory({ id, name, content, agentId }));
      }
      await repo.insertMissingFtsRows(FTS_CORPUS.map(([id]) => id));
    };

    test("full-text parity: the same id set for each query of a fixed corpus", async () => {
      await seedFtsCorpus();
      const ids = async (terms: string[]) =>
        (await repo.searchFtsRows(terms, searchAll(), 50)).map((r) => r.id).sort();
      // The filter applies: d6 is another agent's private memory.
      expect(await ids(["deploy"])).toEqual(["d1", "d4", "d7"]);
      // Stemming: restarting, restart, restarted; workers, worker.
      expect(await ids(["restarting"])).toEqual(["d1", "d7"]);
      expect(await ids(["worker"])).toEqual(["d1", "d4", "d7"]);
      // Stop words are indexed (FTS5 keeps every word).
      expect(await ids(["the"])).toEqual(["d1", "d2", "d3", "d4", "d7"]);
      // Punctuation splits words: src/be/memory.ts, e-mail, ops@example.com.
      expect(await ids(["memory"])).toEqual(["d2", "d8"]);
      expect(await ids(["e-mail"])).toEqual(["d8"]);
      expect(await ids(["example"])).toEqual(["d8"]);
      // A term is a phrase; terms are ORed; case folds.
      expect(await ids(["failed deploy"])).toEqual(["d1"]);
      expect(await ids(["POSTGRES", "cosine"])).toEqual(["d2", "d5"]);
      expect(await ids(["kubernetes"])).toEqual([]);
      expect(await ids([])).toEqual([]);
      // The name is indexed too.
      expect(await ids(["etiquette"])).toEqual(["d3"]);
      expect(
        (await repo.searchFtsRows(["deploy"], { ...searchAll(), isLead: true }, 50))
          .map((r) => r.id)
          .sort(),
      ).toEqual(["d1", "d4", "d6", "d7"]);
      // A deleted memory leaves the index with its FTS rows.
      await repo.deleteMemoriesByIds(["d4"]);
      await repo.deleteFtsRows(["d4"]);
      expect(await ids(["deploy"])).toEqual(["d1", "d7"]);
      expect(await repo.ftsTableSchema()).toBeTruthy();
    });

    test("full-text parity: a phrase matches inside one field, not across name and content", async () => {
      await engine.prepareMemorySearch(storage, 4);
      const rows: [string, string, string][] = [
        ["p1", "heron notes", "A blue heron waded in."],
        ["p2", "blue", "heron nests by the lake"],
      ];
      for (const [id, name, content] of rows) {
        await repo.insertMemory(memory({ id, name, content, agentId: AGENT }));
      }
      await repo.insertMissingFtsRows(rows.map(([id]) => id));
      const ids = async (terms: string[]) =>
        (await repo.searchFtsRows(terms, searchAll(), 50)).map((r) => r.id).sort();
      expect(await ids(["blue-heron"])).toEqual(["p1"]);
      expect(await ids(["blue heron"])).toEqual(["p1"]);
      expect(await ids(["heron"])).toEqual(["p1", "p2"]);
    });

    test("full-text parity: ranked results share at least 4 of the first 5 ids", async () => {
      await seedFtsCorpus();
      const terms = ["deploy", "worker", "the", "memory", "cosine", "thread"];
      const hits = await repo.searchFtsRows(terms, searchAll(), 50);
      expect(hits.map((r) => r.id).sort()).toEqual(["d1", "d2", "d3", "d4", "d5", "d7", "d8"]);
      const top5 = new Set(hits.slice(0, 5).map((r) => r.id));
      // bm25 order on SQLite: rare terms first (thread, cosine; then memory),
      // the words in half the corpus (deploy, worker, the) weigh almost nothing.
      const expected = ["d3", "d5", "d2", "d8", "d4"];
      expect(expected.filter((id) => top5.has(id)).length).toBeGreaterThanOrEqual(4);
      // rank ascending is best first.
      const ranks = hits.map((r) => r.rank);
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
      expect((await repo.searchFtsRows(terms, searchAll(), 2)).length).toBe(2);
    });

    test("vector parity: k-NN order, the k-then-filter width, the engine-scored arm and health", async () => {
      await engine.prepareMemorySearch(storage, 4);
      // The vector table exists once the engine's search indexes do (SQLite: run time, Postgres: migration 369).
      expect(await repo.vecTableSchema()).toContain("memory_vec");
      const corpus: [string, number[], string][] = [
        ["v3", [0.5, 0.5, 0, 0], AGENT],
        ["v1", [1, 0, 0, 0], AGENT],
        ["v5", [-1, 0, 0, 0], AGENT],
        ["v2", [0.9, 0.1, 0, 0], AGENT],
        ["v4", [0, 1, 0, 0], AGENT],
        ["theirs", [1, 0, 0, 0.01], OTHER],
      ];
      for (const [id, values, agentId] of corpus) {
        await repo.insertMemory(memory({ id, agentId }));
        await repo.setEmbedding(id, blob(values), "m");
        await repo.insertVecRow(id, blob(values));
      }
      // Embedded but not in memory_vec: the k-NN arm misses it, the exhaustive arm scores it.
      await repo.insertMemory(memory({ id: "unindexed", now: T1 }));
      await repo.setEmbedding("unindexed", blob([0.8, 0.2, 0, 0]), "m");
      const query = blob([1, 0, 0, 0]);

      const hits = await repo.searchVecRows(query, searchAll(), 10, 10);
      expect(hits.map((r) => r.id)).toEqual(["v1", "v2", "v3", "v4", "v5"]);
      const expectedDistances = [0, 1 - 0.9 / Math.sqrt(0.82), 1 - 0.5 / Math.sqrt(0.5), 1, 2];
      hits.forEach((hit, i) => {
        expect(hit.distance).toBeCloseTo(expectedDistances[i] as number, 5);
      });
      expect((await repo.searchVecRows(query, searchAll(), 10, 2)).map((r) => r.id)).toEqual([
        "v1",
        "v2",
      ]);
      // k nearest first, then the filter: theirs takes one of the two slots.
      expect((await repo.searchVecRows(query, searchAll(), 2, 10)).map((r) => r.id)).toEqual([
        "v1",
      ]);

      const scored = await repo.scoreCappedRows(query, searchAll(), 10, 0.1, 10);
      expect(scored.map((r) => r.id)).toEqual(["v1", "v2", "unindexed", "v3"]);
      expect(scored[0]?.similarity).toBeCloseTo(1, 5);
      expect(scored[2]?.similarity).toBeCloseTo(0.8 / Math.sqrt(0.68), 5);
      expect((await repo.scoreCappedRows(query, searchAll(), 10, 0.1, 1)).map((r) => r.id)).toEqual(
        ["v1"],
      );
      // A query of another dimension scores no row.
      expect(await repo.scoreCappedRows(blob([1, 0]), searchAll(), 10, -2, 10)).toEqual([]);

      await repo.insertVecRow("ghost", blob([0, 0, 1, 0]));
      expect(await repo.healthCounts(16, true)).toEqual({
        total: 7,
        withEmbedding: 7,
        validEmbedding: 7,
        invalidEmbedding: 0,
        searchable: 7,
        memoryVec: 7,
        missingFromVec: 1,
        extraInVec: 1,
      });

      await repo.deleteVecRow("v1");
      await repo.deleteVecRows(["v2", "ghost"]);
      expect((await repo.searchVecRows(query, searchAll(), 10, 10)).map((r) => r.id)).toEqual([
        "v3",
        "v4",
        "v5",
      ]);
      expect(await repo.deleteVecRows([])).toBeUndefined();
    });

    if (engine.name === "sqlite") {
      test("full-text index: backfill batches, sync writes, bm25 search with the filter", async () => {
        await storage.executor.run(sql`
          CREATE VIRTUAL TABLE memory_fts USING fts5(
            memory_id UNINDEXED, name, content, tokenize='porter unicode61')`);
        expect(await repo.ftsTableSchema()).toContain("fts5");
        await repo.insertMemory(memory({ id: "f1", content: "alpha beta" }));
        await repo.insertMemory(memory({ id: "f2", content: "alpha alpha alpha" }));
        await repo.insertMemory(memory({ id: "f3", content: "alpha", agentId: OTHER }));
        expect((await repo.scanMemoryIdBatch(0, 2)).map((r) => r.id)).toEqual(["f1", "f2"]);
        await repo.insertMissingFtsRows(["f1", "f2", "f3"]);
        await repo.insertMissingFtsRows(["f1"]);
        await repo.insertFtsRow("orphan", "n", "alpha");
        const scan = await repo.scanFtsBatch(0, 10);
        expect(scan.map((r) => [r.memoryId, r.orphan])).toEqual([
          ["f1", 0],
          ["f2", 0],
          ["f3", 0],
          ["orphan", 1],
        ]);
        await repo.deleteFtsRowsByRowid([scan[3]!.rowid]);
        const hits = await repo.searchFtsRows(["alpha"], searchAll(), 10);
        expect(hits.map((r) => r.id)).toEqual(["f2", "f1"]);
        await repo.deleteFtsRow("f2");
        await repo.deleteFtsRows(["f1"]);
        expect(await repo.searchFtsRows(["alpha"], searchAll(), 10)).toEqual([]);
        const counts = await repo.healthCounts(4, false);
        expect(counts).toEqual({
          total: 3,
          withEmbedding: 0,
          validEmbedding: 0,
          invalidEmbedding: 0,
          searchable: 0,
          memoryVec: 0,
          missingFromVec: 0,
          extraInVec: 0,
        });
      });
    }
  });
}
