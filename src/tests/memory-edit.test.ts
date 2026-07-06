import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import { storeLinks, storeSequelLink } from "../be/memory/link-resolver";
import { applyEditMode, SqliteMemoryStore } from "../be/memory/providers/sqlite-store";
import { registerMemoryEditTool } from "../tools/memory-edit";

const TEST_DB_PATH = "./test-memory-edit.sqlite";
const agentId = "aaaa0000-0000-4000-8000-000000000201";

describe("applyEditMode", () => {
  test("replace mode returns new content", () => {
    const result = applyEditMode("replace", "old body", { content: "new body" });
    expect(result).toBe("new body");
  });

  test("replace mode throws without content", () => {
    expect(() => applyEditMode("replace", "old body", {})).toThrow("replace mode requires content");
  });

  test("exact mode performs surgical replacement", () => {
    const result = applyEditMode("exact", "hello world foo", {
      oldString: "world",
      newString: "earth",
    });
    expect(result).toBe("hello earth foo");
  });

  test("exact mode with empty newString deletes the substring", () => {
    const result = applyEditMode("exact", "hello world", {
      oldString: " world",
      newString: "",
    });
    expect(result).toBe("hello");
  });

  test("exact mode throws when oldString is not found", () => {
    expect(() =>
      applyEditMode("exact", "hello world", { oldString: "missing", newString: "x" }),
    ).toThrow("oldString not found");
  });

  test("exact mode throws when oldString is ambiguous", () => {
    expect(() =>
      applyEditMode("exact", "alpha beta alpha", { oldString: "alpha", newString: "x" }),
    ).toThrow("oldString is ambiguous");
  });

  test("exact mode throws without required fields", () => {
    expect(() => applyEditMode("exact", "content", { newString: "x" })).toThrow(
      "exact mode requires oldString and newString",
    );
    expect(() => applyEditMode("exact", "content", { oldString: "c" })).toThrow(
      "exact mode requires oldString and newString",
    );
  });
});

describe("memory editing", () => {
  let store: SqliteMemoryStore;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    createAgent({ id: agentId, name: "Edit Test Agent", isLead: false, status: "idle" });
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

  test("preserves id and posterior while writing a version row", () => {
    const memory = store.store({
      agentId,
      scope: "agent",
      name: "editable",
      content: "old body",
      source: "manual",
      key: "notes/editable.md",
      intent: "seed test memory",
    });
    getDb().prepare("UPDATE agent_memory SET alpha = 3, beta = 2 WHERE id = ?").run(memory.id);

    const result = store.edit({
      id: memory.id,
      mode: "replace",
      content: "new body",
      intent: "correct stale body",
      changedByAgentId: agentId,
    });

    expect(result.changed).toBe(true);
    expect(result.memory.id).toBe(memory.id);
    expect(result.version).toBe(2);
    const row = getDb()
      .prepare<{ alpha: number; beta: number; content: string; version: number }, [string]>(
        "SELECT alpha, beta, content, version FROM agent_memory WHERE id = ?",
      )
      .get(memory.id);
    expect(row).toEqual({ alpha: 3, beta: 2, content: "new body", version: 2 });

    const versions = getDb()
      .prepare<{ version: number; operation: string; intent: string }, [string]>(
        "SELECT version, operation, intent FROM agent_memory_version WHERE memory_id = ? ORDER BY version",
      )
      .all(memory.id);
    expect(versions.map((version) => [version.version, version.operation])).toEqual([
      [1, "create"],
      [2, "edit"],
    ]);
    expect(versions[1]?.intent).toBe("correct stale body");
  });

  test("short-circuits unchanged content", () => {
    const memory = store.store({
      agentId,
      scope: "agent",
      name: "same",
      content: "same body",
      source: "manual",
    });

    const result = store.edit({
      id: memory.id,
      mode: "replace",
      content: "same body",
      intent: "noop",
    });

    expect(result.changed).toBe(false);
    expect(result.version).toBe(1);
    const versionCount = getDb()
      .prepare<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM agent_memory_version WHERE memory_id = ?",
      )
      .get(memory.id)?.count;
    expect(versionCount).toBe(1);
  });

  test("exact mode rejects missing and ambiguous old strings", () => {
    const memory = store.store({
      agentId,
      scope: "agent",
      name: "exact",
      content: "alpha beta alpha",
      source: "manual",
    });

    expect(() =>
      store.edit({
        id: memory.id,
        mode: "exact",
        oldString: "missing",
        newString: "x",
        intent: "test missing",
      }),
    ).toThrow("oldString not found");

    expect(() =>
      store.edit({
        id: memory.id,
        mode: "exact",
        oldString: "alpha",
        newString: "x",
        intent: "test ambiguous",
      }),
    ).toThrow("oldString is ambiguous");
  });

  // ─── Edit-path callers prune stale links (DES-639b regression) ────────────
  //
  // Before Phase 5 the callers re-ran the additive storeLinks() on edit, so
  // links derived from deleted content lingered forever. The memory-edit MCP
  // tool is a real caller — drive it end-to-end and assert pruning.

  describe("memory-edit tool prunes stale links", () => {
    function buildTool() {
      const server = new McpServer({ name: "memory-edit-test", version: "1.0.0" });
      registerMemoryEditTool(server);
      const registered = (
        server as unknown as {
          _registeredTools: Record<
            string,
            { handler: (args: unknown, extra: unknown) => Promise<unknown> }
          >;
        }
      )._registeredTools;
      const tool = registered["memory-edit"];
      if (!tool) throw new Error("memory-edit tool not registered");
      return tool;
    }

    function meta() {
      return {
        sessionId: "memory-edit-test-session",
        requestInfo: { headers: { "x-agent-id": agentId } },
      };
    }

    function linkRowsFor(memoryId: string) {
      return getDb()
        .prepare<{ linkType: string; targetId: string }, [string]>(
          "SELECT linkType, targetId FROM memory_link WHERE from_memory_id = ? ORDER BY targetId",
        )
        .all(memoryId);
    }

    test("editing away a wikilink deletes its link row, keeps survivors + sequel", async () => {
      // Ensure the embedding provider stays keyless/deterministic in tests.
      process.env.EMBEDDING_API_KEY = "";
      process.env.OPENAI_API_KEY = "";

      const b = store.store({
        agentId,
        scope: "agent",
        name: "edit-b-target",
        content: "target B",
        source: "manual",
      });
      const c = store.store({
        agentId,
        scope: "agent",
        name: "edit-c-target",
        content: "target C",
        source: "manual",
      });
      const a = store.store({
        agentId,
        scope: "agent",
        name: "edit-a-source",
        content: "See [[edit-b-target]] and [[edit-c-target]].",
        source: "manual",
      });
      storeLinks(a.id, agentId, a.content);
      storeSequelLink(a.id, b.id);
      expect(linkRowsFor(a.id)).toHaveLength(3);

      const result = (await buildTool().handler(
        {
          memoryId: a.id,
          mode: "replace",
          content: "See [[edit-b-target]] only.",
          intent: "test stale-link pruning",
        },
        meta(),
      )) as { structuredContent: { success: boolean; message: string; changed?: boolean } };

      // Assert on the message first — on failure it carries the tool's error
      // (a bare success:false told us nothing when this flaked in CI).
      expect(result.structuredContent.message).toStartWith("Memory edited to version");
      expect(result.structuredContent.success).toBe(true);
      expect(result.structuredContent.changed).toBe(true);

      const rows = linkRowsFor(a.id);
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.linkType === "wikilink").map((r) => r.targetId)).toEqual([b.id]);
      expect(rows.find((r) => r.linkType === "sequel")?.targetId).toBe(b.id);
      expect(rows.some((r) => r.targetId === c.id)).toBe(false);
    });
  });
});
