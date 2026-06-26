import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import { SqliteMemoryStore } from "../be/memory/providers/sqlite-store";

const TEST_DB_PATH = "./test-memory-edit.sqlite";

describe("Memory edit (Phase 2)", () => {
  const agentA = "aaaa0000-0000-4000-8000-000000000201";
  let store: SqliteMemoryStore;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    createAgent({ id: agentA, name: "Edit Agent", isLead: false, status: "idle" });
    store = new SqliteMemoryStore();
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
  });

  describe("edit() — replace mode", () => {
    test("replaces content and increments version", () => {
      const mem = store.store({
        agentId: agentA,
        scope: "agent",
        name: "edit target",
        content: "original content here",
        source: "manual",
        sourcePath: "/edit/replace-test.md",
      });

      const result = store.edit({
        id: mem.id,
        mode: "replace",
        content: "completely replaced content",
        intent: "test replacement",
      });

      expect(result.changed).toBe(true);
      expect(result.version).toBe(2);
      expect(result.contentHash).toBeDefined();

      const updated = store.peek(mem.id)!;
      expect(updated.content).toBe("completely replaced content");
      expect(updated.id).toBe(mem.id);
    });

    test("returns not_found for nonexistent id", () => {
      const result = store.edit({
        id: "00000000-0000-0000-0000-000000000000",
        mode: "replace",
        content: "does not matter",
        intent: "test",
      });
      expect(result.changed).toBe(false);
      expect(result.reason).toBe("not_found");
    });

    test("returns replace_mode_requires_content when content missing", () => {
      const mem = store.store({
        agentId: agentA,
        scope: "agent",
        name: "no content",
        content: "some text",
        source: "manual",
        sourcePath: "/edit/no-content.md",
      });

      const result = store.edit({
        id: mem.id,
        mode: "replace",
        intent: "test",
      });
      expect(result.changed).toBe(false);
      expect(result.reason).toBe("replace_mode_requires_content");
    });
  });

  describe("edit() — exact mode", () => {
    test("substitutes old string with new string", () => {
      const mem = store.store({
        agentId: agentA,
        scope: "agent",
        name: "exact target",
        content: "The quick brown fox jumps over the lazy dog.",
        source: "manual",
        sourcePath: "/edit/exact-test.md",
      });

      const result = store.edit({
        id: mem.id,
        mode: "exact",
        oldString: "brown fox",
        newString: "red fox",
        intent: "change fox color",
      });

      expect(result.changed).toBe(true);
      const updated = store.peek(mem.id)!;
      expect(updated.content).toBe("The quick red fox jumps over the lazy dog.");
    });

    test("returns old_string_not_found when old string missing", () => {
      const mem = store.store({
        agentId: agentA,
        scope: "agent",
        name: "not found",
        content: "some text here",
        source: "manual",
        sourcePath: "/edit/old-not-found.md",
      });

      const result = store.edit({
        id: mem.id,
        mode: "exact",
        oldString: "nonexistent phrase",
        newString: "replacement",
        intent: "test",
      });
      expect(result.changed).toBe(false);
      expect(result.reason).toBe("old_string_not_found");
    });

    test("returns old_string_ambiguous when old string appears multiple times", () => {
      const mem = store.store({
        agentId: agentA,
        scope: "agent",
        name: "ambiguous",
        content: "foo bar foo baz foo",
        source: "manual",
        sourcePath: "/edit/ambiguous.md",
      });

      const result = store.edit({
        id: mem.id,
        mode: "exact",
        oldString: "foo",
        newString: "qux",
        intent: "test",
      });
      expect(result.changed).toBe(false);
      expect(result.reason).toBe("old_string_ambiguous");
    });

    test("returns exact_mode_requires_old_and_new_string when params missing", () => {
      const mem = store.store({
        agentId: agentA,
        scope: "agent",
        name: "missing params",
        content: "content",
        source: "manual",
        sourcePath: "/edit/missing-params.md",
      });

      const result = store.edit({
        id: mem.id,
        mode: "exact",
        intent: "test",
      });
      expect(result.changed).toBe(false);
      expect(result.reason).toBe("exact_mode_requires_old_and_new_string");
    });
  });

  describe("content-hash dedup", () => {
    test("returns content_unchanged when content is identical", () => {
      const mem = store.store({
        agentId: agentA,
        scope: "agent",
        name: "dedup target",
        content: "identical content that should not change",
        source: "manual",
        sourcePath: "/edit/dedup.md",
      });

      const result = store.edit({
        id: mem.id,
        mode: "replace",
        content: "identical content that should not change",
        intent: "no-op test",
      });
      expect(result.changed).toBe(false);
      expect(result.reason).toBe("content_unchanged");
    });
  });

  describe("version ledger", () => {
    test("creates version entry on store and edit", () => {
      const mem = store.store({
        agentId: agentA,
        scope: "agent",
        name: "versioned",
        content: "version 1",
        source: "manual",
        sourcePath: "/edit/versioned.md",
      });

      store.edit({
        id: mem.id,
        mode: "replace",
        content: "version 2",
        intent: "first edit",
        changedByAgentId: agentA,
      });

      store.edit({
        id: mem.id,
        mode: "replace",
        content: "version 3",
        intent: "second edit",
        changedByAgentId: agentA,
      });

      const versions = getDb()
        .prepare<
          { version: number; content: string; operation: string; intent: string | null },
          [string]
        >(
          "SELECT version, content, operation, intent FROM agent_memory_version WHERE memory_id = ? ORDER BY version",
        )
        .all(mem.id);

      expect(versions).toHaveLength(3);
      expect(versions[0]!.version).toBe(1);
      expect(versions[0]!.operation).toBe("create");
      expect(versions[1]!.version).toBe(2);
      expect(versions[1]!.operation).toBe("edit");
      expect(versions[1]!.content).toBe("version 2");
      expect(versions[2]!.version).toBe(3);
      expect(versions[2]!.operation).toBe("edit");
      expect(versions[2]!.content).toBe("version 3");
    });
  });

  describe("key-based lookup", () => {
    test("edit by key instead of id", () => {
      const mem = store.store({
        agentId: agentA,
        scope: "agent",
        name: "key lookup",
        content: "original via key",
        source: "manual",
        sourcePath: "/edit/key-lookup.md",
      });

      const result = store.edit({
        key: "/edit/key-lookup.md",
        scope: "agent",
        agentId: agentA,
        mode: "replace",
        content: "updated via key",
        intent: "key-based edit test",
      });

      expect(result.changed).toBe(true);
      expect(result.id).toBe(mem.id);
      const updated = store.peek(mem.id)!;
      expect(updated.content).toBe("updated via key");
    });

    test("findByKey returns stored memory", () => {
      store.store({
        agentId: agentA,
        scope: "agent",
        name: "findByKey test",
        content: "findable content",
        source: "manual",
        sourcePath: "/edit/findbykey.md",
      });

      const found = store.findByKey("/edit/findbykey.md", "agent", agentA);
      expect(found).not.toBeNull();
      expect(found!.content).toBe("findable content");
    });

    test("findBySourcePath returns memories", () => {
      const path = `/edit/findbysource-${crypto.randomUUID()}.md`;
      store.store({
        agentId: agentA,
        scope: "agent",
        name: "findBySourcePath test",
        content: "source path content",
        source: "manual",
        sourcePath: path,
      });

      const found = store.findBySourcePath(path, agentA);
      expect(found).toHaveLength(1);
      expect(found[0]!.content).toBe("source path content");
    });
  });

  describe("multi-chunk rejection", () => {
    test("refuses to edit multi-chunk memory", () => {
      const mem = store.store({
        agentId: agentA,
        scope: "agent",
        name: "multi chunk",
        content: "chunk 0 of 2",
        source: "manual",
        sourcePath: "/edit/multi-chunk.md",
        chunkIndex: 0,
        totalChunks: 2,
      });

      const result = store.edit({
        id: mem.id,
        mode: "replace",
        content: "new content",
        intent: "test",
      });
      expect(result.changed).toBe(false);
      expect(result.reason).toBe("multi_chunk");
    });
  });

  describe("structured key column", () => {
    test("key defaults to sourcePath when provided", () => {
      const mem = store.store({
        agentId: agentA,
        scope: "agent",
        name: "key from path",
        content: "content",
        source: "manual",
        sourcePath: "/custom/path.md",
      });

      const row = getDb()
        .prepare<{ key: string | null }, [string]>("SELECT key FROM agent_memory WHERE id = ?")
        .get(mem.id);
      expect(row!.key).toBe("/custom/path.md");
    });

    test("key is generated when no sourcePath", () => {
      const mem = store.store({
        agentId: agentA,
        scope: "agent",
        name: "generated key",
        content: "content",
        source: "manual",
      });

      const row = getDb()
        .prepare<{ key: string | null }, [string]>("SELECT key FROM agent_memory WHERE id = ?")
        .get(mem.id);
      expect(row!.key).toMatch(/^agent\/manual\//);
    });

    test("contentHash is populated on store", () => {
      const mem = store.store({
        agentId: agentA,
        scope: "agent",
        name: "hash check",
        content: "hash me",
        source: "manual",
        sourcePath: `/edit/hash-check-${crypto.randomUUID()}.md`,
      });

      const row = getDb()
        .prepare<{ contentHash: string | null }, [string]>(
          "SELECT contentHash FROM agent_memory WHERE id = ?",
        )
        .get(mem.id);
      expect(row!.contentHash).toBeDefined();
      expect(row!.contentHash!.length).toBe(64);
    });
  });

  describe("FTS sync on edit", () => {
    test("edited content is searchable via FTS", () => {
      const mem = store.store({
        agentId: agentA,
        scope: "agent",
        name: "fts edit sync",
        content: "original fts content here",
        source: "manual",
        sourcePath: `/edit/fts-sync-${crypto.randomUUID()}.md`,
      });

      store.edit({
        id: mem.id,
        mode: "replace",
        content: "phantasmagorical unique search term after edit",
        intent: "test fts sync",
      });

      const results = store.search(new Float32Array(3), agentA, {
        scope: "agent",
        limit: 10,
        queryText: "phantasmagorical",
      });
      expect(results.length).toBe(1);
      expect(results[0]!.id).toBe(mem.id);
    });

    test("old content is not searchable after edit", () => {
      const uniqueWord = `xyzoldunique${Date.now()}`;
      const mem = store.store({
        agentId: agentA,
        scope: "agent",
        name: "fts old removal",
        content: `${uniqueWord} old content`,
        source: "manual",
        sourcePath: `/edit/fts-old-${crypto.randomUUID()}.md`,
      });

      store.edit({
        id: mem.id,
        mode: "replace",
        content: "completely different content now",
        intent: "test old content removal",
      });

      const results = store.search(new Float32Array(3), agentA, {
        scope: "agent",
        limit: 10,
        queryText: uniqueWord,
      });
      expect(results).toHaveLength(0);
    });
  });

  describe("name update on edit", () => {
    test("name updates when provided", () => {
      const mem = store.store({
        agentId: agentA,
        scope: "agent",
        name: "old name",
        content: "some content",
        source: "manual",
        sourcePath: `/edit/name-update-${crypto.randomUUID()}.md`,
      });

      store.edit({
        id: mem.id,
        mode: "replace",
        content: "new content",
        name: "new name",
        intent: "rename test",
      });

      const updated = store.peek(mem.id)!;
      expect(updated.name).toBe("new name");
    });

    test("name unchanged when not provided", () => {
      const mem = store.store({
        agentId: agentA,
        scope: "agent",
        name: "keep this name",
        content: "some content",
        source: "manual",
        sourcePath: `/edit/name-keep-${crypto.randomUUID()}.md`,
      });

      store.edit({
        id: mem.id,
        mode: "replace",
        content: "different content",
        intent: "no rename",
      });

      const updated = store.peek(mem.id)!;
      expect(updated.name).toBe("keep this name");
    });
  });
});
