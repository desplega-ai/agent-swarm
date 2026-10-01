import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import { expandCandidatesWithGraph } from "../be/memory/graph-expansion";
import { indexMemoryContent } from "../be/memory/index-content";
import {
  isConsolidatedKey,
  LONGTERM_ENTITY_TYPES,
  LONGTERM_ROOTS,
  longtermKeyError,
} from "../be/memory/key-paths";
import { SqliteMemoryStore } from "../be/memory/providers/sqlite-store";
import { computeScore } from "../be/memory/reranker";
import type { MemoryCandidate } from "../be/memory/types";
import { handleMemory } from "../http/memory";
import { registerMemoryEditTool } from "../tools/memory-edit";
import { registerMemorySearchTool } from "../tools/memory-search";
import { registerMemoryStoreTool } from "../tools/memory-store";
import type { AgentMemoryScope } from "../types";

// Logical memory paths: `key` on memory-store, `newKey` on memory-edit,
// `keyPrefix` on memory-search and POST /api/memory/search, the lead-only
// guard on the consolidated roots, the closed root allowlist under /longterm,
// and the /longterm tier (a /longterm key gets a manual memory's lifecycle).

const lead = randomUUID();
const worker = randomUUID();

type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };
type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<ToolResult>;
  inputSchema?: { safeParse: (value: unknown) => { success: boolean } };
};

function toolFor(register: (server: McpServer) => void, name: string): RegisteredTool {
  const server = new McpServer({ name: "memory-key-paths", version: "1.0.0" });
  register(server);
  const tool = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools[name];
  if (!tool) throw new Error(`${name} not registered`);
  return tool;
}

function callTool(
  register: (server: McpServer) => void,
  name: string,
  caller: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return toolFor(register, name).handler(args, {
    sessionId: "memory-key-paths",
    requestInfo: { headers: { "x-agent-id": caller } },
  });
}

const storeTool = (caller: string, args: Record<string, unknown>) =>
  callTool(registerMemoryStoreTool, "memory-store", caller, args);
const editTool = (caller: string, args: Record<string, unknown>) =>
  callTool(registerMemoryEditTool, "memory-edit", caller, args);
const searchTool = (caller: string, args: Record<string, unknown>) =>
  callTool(registerMemorySearchTool, "memory-search", caller, args);

async function keysOf(ids: string[]): Promise<string[]> {
  const rows = await getDbClient().query<{ id: string; key: string }>(
    `SELECT id, key FROM agent_memory WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids,
  );
  const byId = new Map(rows.map((row) => [row.id, row.key]));
  return ids.map((id) => byId.get(id) ?? "(missing)");
}

/** Unit vector with `cos` on axis 2 (the query axis) and the remainder on `axis`. */
function mix(cos: number, axis: number): Float32Array {
  const embedding = new Float32Array(512);
  embedding[2] = cos;
  embedding[axis] = Math.sqrt(1 - cos * cos);
  return embedding;
}

const queryEmbedding = mix(1, 3);

// Built after initDb: the constructor creates the vec and FTS tables.
let store: SqliteMemoryStore;

const originalEmbeddingKey = process.env.EMBEDDING_API_KEY;
const originalOpenAiKey = process.env.OPENAI_API_KEY;

beforeAll(async () => {
  // Keyless provider: embed() returns null instead of calling the network.
  process.env.EMBEDDING_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  initDb(":memory:");
  store = new SqliteMemoryStore();
  await createAgent({ id: lead, name: "Key Paths Lead", isLead: true, status: "idle" });
  await createAgent({ id: worker, name: "Key Paths Worker", isLead: false, status: "idle" });
});

afterAll(() => {
  if (originalEmbeddingKey === undefined) delete process.env.EMBEDDING_API_KEY;
  else process.env.EMBEDDING_API_KEY = originalEmbeddingKey;
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
  closeDb();
});

beforeEach(async () => {
  await getDbClient().run("DELETE FROM memory_link");
  await getDbClient().run("DELETE FROM agent_memory");
  // Orphan vec rows would flip retrieval to the fallback arm (health check).
  await getDbClient().run("DELETE FROM memory_vec");
  await getDbClient().run("DELETE FROM memory_fts");
});

describe("memory-store key", () => {
  test("stores the key on every chunk of a multi-chunk memory", async () => {
    const result = await storeTool(worker, {
      content: "The lane writes consolidated paths and never appends. ".repeat(120),
      name: "multi chunk fact",
      scope: "swarm",
      key: "/longterm/facts/memory/multi-chunk",
    });

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.chunks).toBeGreaterThan(1);
    const keys = await keysOf(result.structuredContent.memoryIds);
    expect(keys).toEqual(keys.map(() => "/longterm/facts/memory/multi-chunk"));
  });

  test("refuses a second memory under a key the owner already uses in that scope", async () => {
    const first = await storeTool(worker, {
      content: "first body of the path",
      name: "first",
      scope: "swarm",
      key: "/longterm/facts/memory/taken",
    });
    expect(first.structuredContent.success).toBe(true);

    const second = await storeTool(worker, {
      content: "second body of the same path",
      name: "second",
      scope: "swarm",
      key: "/longterm/facts/memory/taken",
    });
    expect(second.isError).toBe(true);
    expect(second.structuredContent.message).toContain(
      'key "/longterm/facts/memory/taken" is already used',
    );
    const rows = await getDbClient().query("SELECT id FROM agent_memory WHERE name = 'second'");
    expect(rows).toHaveLength(0);
  });

  // The lead-only roots are /longterm/company-story, /longterm/entities and
  // /longterm/timeline. The other allowed roots stay open. A /longterm/ name is
  // used as the key, so the guard must hold for the name route too.
  const guardRows = [
    ["worker", worker, "/longterm/company-story", false],
    ["worker", worker, "/longterm/entities/people/taras", false],
    ["worker", worker, "/longterm/timeline/daily/2026-10-01", false],
    ["worker", worker, "/longterm/facts/memory/note", true],
    ["worker", worker, "/longterm/decisions/2026-10-01-note", true],
    ["worker", worker, "/longterm/workstreams/active/note", true],
    ["lead", lead, "/longterm/company-story", true],
    ["lead", lead, "/longterm/entities/people/taras", true],
    ["lead", lead, "/longterm/timeline/daily/2026-10-01", true],
  ] as const;
  for (const via of ["key", "name"] as const) {
    test.each(
      guardRows,
    )(`${via}: %s writing %s: allowed=%p`, async (_who, caller, path, allowed) => {
      const result = await storeTool(caller, {
        content: "guard probe body for the path",
        scope: "swarm",
        ...(via === "key" ? { name: "guard probe", key: path } : { name: path }),
      });
      const stored = await getDbClient().query("SELECT id FROM agent_memory WHERE key = ?", [path]);

      expect(result.structuredContent.success).toBe(allowed);
      expect(stored).toHaveLength(allowed ? 1 : 0);
      if (!allowed) expect(result.structuredContent.message).toContain("lead-only");
    });
  }

  test("a /longterm/ name is used as the key when no key is given", async () => {
    const result = await storeTool(worker, {
      content: "The lane writes consolidated paths and never appends. ".repeat(120),
      name: "/longterm/facts/memory/by-name",
      scope: "swarm",
    });

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.chunks).toBeGreaterThan(1);
    const ids: string[] = result.structuredContent.memoryIds;
    expect(await keysOf(ids)).toEqual(ids.map(() => "/longterm/facts/memory/by-name"));
    const names = await getDbClient().query<{ name: string }>(
      `SELECT DISTINCT name FROM agent_memory WHERE id IN (${ids.map(() => "?").join(",")})`,
      ids,
    );
    expect(names).toEqual([{ name: "/longterm/facts/memory/by-name" }]);
  });

  test("an explicit key wins over a /longterm/ name", async () => {
    const result = await storeTool(worker, {
      content: "explicit key body",
      name: "/longterm/facts/memory/name-loses",
      scope: "swarm",
      key: "/longterm/facts/memory/key-wins",
    });

    expect(await keysOf(result.structuredContent.memoryIds)).toEqual([
      "/longterm/facts/memory/key-wins",
    ]);
  });

  test("any other name leaves the auto key", async () => {
    const result = await storeTool(worker, {
      content: "plain note body",
      name: "longterm notes without a leading slash",
      scope: "swarm",
    });

    const [key] = await keysOf(result.structuredContent.memoryIds);
    expect(key).toBe(`swarm/manual/${result.structuredContent.memoryIds[0]}`);
  });

  test("a /longterm/ name that is not a valid key is refused and nothing is stored", async () => {
    const result = await storeTool(worker, {
      content: "bad name body",
      name: "/longterm/Facts/Not A Key",
      scope: "swarm",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.message).toContain("not a valid key");
    expect(await getDbClient().query("SELECT id FROM agent_memory")).toHaveLength(0);
  });

  test("the input schema rejects keys that could dodge the guard", () => {
    const schema = toolFor(registerMemoryStoreTool, "memory-store").inputSchema!;
    const accepts = (key: string) => schema.safeParse({ content: "x", key }).success;

    expect(accepts("/longterm/entities/customers/acme")).toBe(true);
    expect(accepts("/Longterm/entities/people/taras")).toBe(false);
    expect(accepts("/longterm/entities//taras")).toBe(false);
    expect(accepts("/longterm/entities/taras/")).toBe(false);
    expect(accepts("longterm/entities/taras")).toBe(false);
  });
});

describe("memory-edit newKey", () => {
  async function seed(key: string | undefined, over: { chunks?: number; owner?: string } = {}) {
    const chunks = over.chunks ?? 1;
    const inputs = Array.from({ length: chunks }, (_, chunkIndex) => ({
      agentId: over.owner ?? worker,
      scope: "swarm" as AgentMemoryScope,
      name: `move seed ${key ?? "auto"}`,
      content: `chunk ${chunkIndex} body of the document`,
      source: "manual" as const,
      key,
      chunkIndex,
      totalChunks: chunks,
    }));
    return store.storeBatch(inputs);
  }

  async function snapshot(id: string) {
    return getDbClient().get<Record<string, unknown>>(
      "SELECT id, agentId, alpha, beta, accessCount, content, key, version FROM agent_memory WHERE id = ?",
      [id],
    );
  }

  test("a pure move keeps id, posterior, access count and author, and writes a version row", async () => {
    const [memory] = await seed(undefined);
    await getDbClient().run(
      "UPDATE agent_memory SET alpha = 4.5, beta = 1.5, accessCount = 7 WHERE id = ?",
      [memory!.id],
    );
    const before = await snapshot(memory!.id);

    const result = await editTool(worker, {
      memoryId: memory!.id,
      newKey: "/longterm/facts/memory/draft",
      intent: "classify the inbox note",
    });
    const after = await snapshot(memory!.id);

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.changed).toBe(true);
    expect(before?.key).toBe(`swarm/manual/${memory!.id}`);
    expect(after).toEqual({ ...before, key: "/longterm/facts/memory/draft", version: 2 });
    const versions = await getDbClient().query<{ version: number; intent: string }>(
      "SELECT version, intent FROM agent_memory_version WHERE memory_id = ? ORDER BY version",
      [memory!.id],
    );
    expect(versions.map((row) => row.version)).toEqual([1, 2]);
    expect(versions[1]!.intent).toBe(
      `classify the inbox note [key swarm/manual/${memory!.id} -> /longterm/facts/memory/draft]`,
    );
  });

  test("a move addressed by key and scope reaches the same document", async () => {
    const [memory] = await seed("/longterm/facts/memory/by-key-old");

    const result = await editTool(worker, {
      key: "/longterm/facts/memory/by-key-old",
      scope: "swarm",
      newKey: "/longterm/facts/memory/by-key",
      intent: "move by key",
    });

    expect(result.structuredContent.success).toBe(true);
    expect((await snapshot(memory!.id))?.key).toBe("/longterm/facts/memory/by-key");
  });

  test("a move updates every chunk of a multi-chunk document", async () => {
    const chunks = await seed("/longterm/facts/memory/long-old", { chunks: 3 });

    const result = await editTool(worker, {
      memoryId: chunks[0]!.id,
      newKey: "/longterm/decisions/2026-10-01-long",
      intent: "move a long document",
    });

    expect(result.structuredContent.success).toBe(true);
    const rows = await getDbClient().query<{ id: string; key: string; chunkIndex: number }>(
      "SELECT id, key, chunkIndex FROM agent_memory ORDER BY chunkIndex",
    );
    expect(rows.map((row) => row.id)).toEqual(chunks.map((chunk) => chunk.id));
    expect(rows.map((row) => row.key)).toEqual(
      chunks.map(() => "/longterm/decisions/2026-10-01-long"),
    );
  });

  test("a key already in use is refused and nothing moves", async () => {
    const [mover] = await seed("/longterm/facts/memory/mover");
    await seed("/longterm/facts/memory/occupied");

    const result = await editTool(worker, {
      memoryId: mover!.id,
      newKey: "/longterm/facts/memory/occupied",
      intent: "collide",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.message).toContain("already used");
    expect((await snapshot(mover!.id))?.key).toBe("/longterm/facts/memory/mover");
  });

  test("a legacy multi-chunk document with a key per chunk is refused instead of split", async () => {
    const [first, second] = await Promise.all([
      store.store({
        agentId: worker,
        scope: "swarm",
        name: "legacy",
        content: "chunk 0 of a legacy document",
        source: "manual",
        chunkIndex: 0,
        totalChunks: 2,
      }),
      store.store({
        agentId: worker,
        scope: "swarm",
        name: "legacy",
        content: "chunk 1 of a legacy document",
        source: "manual",
        chunkIndex: 1,
        totalChunks: 2,
      }),
    ]);

    const result = await editTool(worker, {
      memoryId: first.id,
      newKey: "/longterm/facts/memory/legacy",
      intent: "move a legacy document",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.message).toContain("do not share one");
    expect(await keysOf([first.id, second.id])).toEqual([first.key!, second.key!]);
  });

  test("a non-lead cannot move a memory into a lead-only path; the lead can", async () => {
    const [mine] = await seed(undefined);

    const refused = await editTool(worker, {
      memoryId: mine!.id,
      newKey: "/longterm/company-story",
      intent: "try to promote",
    });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.message).toContain("lead-only");
    expect((await snapshot(mine!.id))?.key).toBe(`swarm/manual/${mine!.id}`);

    const allowed = await editTool(lead, {
      memoryId: mine!.id,
      newKey: "/longterm/company-story",
      intent: "lead consolidates",
    });
    expect(allowed.structuredContent.success).toBe(true);
    expect((await snapshot(mine!.id))?.key).toBe("/longterm/company-story");
  });
});

describe("closed root allowlist under /longterm", () => {
  const allowedRoots = LONGTERM_ROOTS.join(", ");
  const rejected = [
    "/longterm/fact/memory/typo",
    "/longterm/procedures/hn-briefing",
    "/longterm/entities-archive/note",
    "/longterm/entities/agents/jackknife",
    "/longterm/entities/repos/desplega-ai/agent-swarm",
    "/longterm/entities/services/zernio",
    "/longterm/entities",
    "/longterm",
  ];

  test.each(
    rejected,
  )("memory-store refuses %s by key and by name, and stores nothing", async (path) => {
    // A name is only a key when it starts with /longterm/.
    const routes = [
      { name: "allowlist probe", key: path },
      ...(path.startsWith("/longterm/") ? [{ name: path }] : []),
    ];
    for (const args of routes) {
      const result = await storeTool(lead, {
        content: "allowlist probe body",
        scope: "swarm",
        ...args,
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent.message).toContain("is not allowed");
      expect(result.structuredContent.message).toContain(path);
    }
    expect(await getDbClient().query("SELECT id FROM agent_memory")).toHaveLength(0);
  });

  test("the error lists the allowed roots, and the entity types under /longterm/entities", async () => {
    const root = await storeTool(lead, {
      content: "body",
      name: "probe",
      scope: "swarm",
      key: "/longterm/fact/memory/typo",
    });
    expect(root.structuredContent.message).toContain(allowedRoots);

    const entity = await storeTool(lead, {
      content: "body",
      name: "probe",
      scope: "swarm",
      key: "/longterm/entities/agents/jackknife",
    });
    expect(entity.structuredContent.message).toContain(LONGTERM_ENTITY_TYPES.join(", "));
  });

  test.each([
    ["worker", worker, "/longterm/facts/memory/ok"],
    ["worker", worker, "/longterm/decisions/2026-10-01-ok"],
    ["worker", worker, "/longterm/workstreams/active/ok"],
    ["lead", lead, "/longterm/company-story"],
    ["lead", lead, "/longterm/entities/people/taras"],
    ["lead", lead, "/longterm/entities/customers/acme"],
    ["lead", lead, "/longterm/timeline/daily/2026-10-01"],
  ] as const)("%s can still store %s", async (_who, caller, path) => {
    const result = await storeTool(caller, {
      content: "allowed key body",
      name: "allowed",
      scope: "swarm",
      key: path,
    });

    expect(result.structuredContent.success).toBe(true);
    expect(await keysOf(result.structuredContent.memoryIds)).toEqual([path]);
  });

  test("keys outside /longterm are unchanged", async () => {
    for (const key of ["/inbox/note-1", "/scratch/a/b", "/longtermish/x", "/workspace/x.md"]) {
      const result = await storeTool(worker, {
        content: `body for ${key}`,
        name: `outside ${key}`,
        scope: "swarm",
        key,
      });
      expect(result.structuredContent.success).toBe(true);
      expect(await keysOf(result.structuredContent.memoryIds)).toEqual([key]);
    }
  });

  test.each(
    rejected.filter((path) => path !== "/longterm"),
  )("memory-edit newKey refuses %s and nothing moves", async (path) => {
    const [memory] = await store.storeBatch([
      {
        agentId: lead,
        scope: "swarm",
        name: "to move",
        content: "body of the memory to move",
        source: "manual",
        key: "/longterm/facts/memory/stays",
      },
    ]);

    const result = await editTool(lead, { memoryId: memory!.id, newKey: path, intent: "bad move" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.message).toContain("is not allowed");
    expect(await keysOf([memory!.id])).toEqual(["/longterm/facts/memory/stays"]);
  });

  test("a root-lookalike is not lead-only, so the allowlist is what refuses it", () => {
    expect(isConsolidatedKey("/longterm/entities-archive/note")).toBe(false);
    expect(longtermKeyError("/longterm/entities-archive/note")).not.toBeNull();
    expect(longtermKeyError("/inbox/anything")).toBeNull();
  });
});

describe("/longterm is the curated tier", () => {
  const longKey = "/longterm/facts/memory/curated";
  const expiryOf = (ids: string[]) =>
    getDbClient().query<{ id: string; expiresAt: string | null }>(
      `SELECT id, expiresAt FROM agent_memory WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY chunkIndex`,
      ids,
    );

  async function seedTaskCompletion(chunks: number, key?: string) {
    return store.storeBatch(
      Array.from({ length: chunks }, (_, chunkIndex) => ({
        agentId: worker,
        scope: "swarm" as AgentMemoryScope,
        name: "task completion note",
        content: `chunk ${chunkIndex} of a task completion note`,
        source: "task_completion" as const,
        key,
        chunkIndex,
        totalChunks: chunks,
      })),
    );
  }

  test("a task_completion memory moved into /longterm has expiresAt NULL on every chunk and survives the purge", async () => {
    const chunks = await seedTaskCompletion(3, "/inbox/task-note");
    const ids = chunks.map((chunk) => chunk.id);
    expect((await expiryOf(ids)).every((row) => row.expiresAt !== null)).toBe(true);
    // Past its 7-day TTL: search would already hide it and the purge would take it.
    await getDbClient().run(
      `UPDATE agent_memory SET expiresAt = datetime('now', '-1 day') WHERE id IN (${ids.map(() => "?").join(",")})`,
      ids,
    );

    const result = await editTool(worker, {
      memoryId: ids[0],
      newKey: longKey,
      intent: "promote a task note",
    });

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.memory.expiresAt).toBeNull();
    expect(await expiryOf(ids)).toEqual(ids.map((id) => ({ id, expiresAt: null })));
    await store.purgeExpired();
    expect(await keysOf(ids)).toEqual(ids.map(() => longKey));
  });

  test("control: the same memory left outside /longterm is purged once expired", async () => {
    const [memory] = await seedTaskCompletion(1, "/inbox/task-note");
    await getDbClient().run(
      "UPDATE agent_memory SET expiresAt = datetime('now', '-1 day') WHERE id = ?",
      [memory!.id],
    );

    await store.purgeExpired();

    expect(
      await getDbClient().query("SELECT id FROM agent_memory WHERE id = ?", [memory!.id]),
    ).toEqual([]);
  });

  test("moving out of /longterm does not bring a TTL back", async () => {
    const [memory] = await seedTaskCompletion(1, "/inbox/task-note");
    await editTool(worker, { memoryId: memory!.id, newKey: longKey, intent: "promote" });

    const result = await editTool(worker, {
      memoryId: memory!.id,
      newKey: "/inbox/demoted",
      intent: "demote",
    });

    expect(result.structuredContent.success).toBe(true);
    expect(await keysOf([memory!.id])).toEqual(["/inbox/demoted"]);
    expect(await expiryOf([memory!.id])).toEqual([{ id: memory!.id, expiresAt: null }]);
  });

  test("a move between two non-/longterm keys leaves the TTL alone", async () => {
    const [memory] = await seedTaskCompletion(1, "/inbox/a");
    const [before] = await expiryOf([memory!.id]);

    await editTool(worker, { memoryId: memory!.id, newKey: "/inbox/b", intent: "rename" });

    expect(await expiryOf([memory!.id])).toEqual([before!]);
    expect(before!.expiresAt).not.toBeNull();
  });

  test("a /longterm key on store means no expiry, whatever the source", async () => {
    const curated = await seedTaskCompletion(2, longKey);
    const plain = await seedTaskCompletion(1);

    expect((await expiryOf(curated.map((c) => c.id))).map((row) => row.expiresAt)).toEqual([
      null,
      null,
    ]);
    expect((await expiryOf([plain[0]!.id]))[0]!.expiresAt).not.toBeNull();
  });

  test("isSourceProtected follows the key, and falls back to the source", () => {
    expect(store.isSourceProtected("task_completion", longKey)).toBe(true);
    expect(store.isSourceProtected("task_completion", "/inbox/x")).toBe(false);
    expect(store.isSourceProtected("task_completion")).toBe(false);
    expect(store.isSourceProtected("manual")).toBe(true);
  });

  test("a task_completion memory under /longterm scores like a manual one, 100 days on", () => {
    const base = {
      id: "m",
      agentId: worker,
      scope: "swarm",
      name: "n",
      content: "c",
      source: "task_completion",
      createdAt: new Date(Date.now() - 100 * 86_400_000).toISOString(),
      accessedAt: new Date().toISOString(),
      accessCount: 0,
      alpha: 1,
      beta: 1,
      similarity: 1,
      tags: [],
    } as unknown as MemoryCandidate;
    const now = new Date();

    const curated = computeScore({ ...base, key: "/longterm/entities/people/taras" }, now);
    const manual = computeScore(
      { ...base, source: "manual", key: "/longterm/entities/people/taras" },
      now,
    );
    const inbox = computeScore({ ...base, key: "/inbox/x" }, now);

    expect(curated).toBeCloseTo(manual, 10);
    expect(curated).toBeGreaterThan(inbox * 100);
  });

  test("listForCuration skips /longterm memories of any source, and keeps rows with no key", async () => {
    const [curated] = await seedTaskCompletion(1, longKey);
    const [inbox] = await seedTaskCompletion(1, "/inbox/task-note");
    const [keyless] = await seedTaskCompletion(1);
    await getDbClient().run("UPDATE agent_memory SET key = NULL WHERE id = ?", [keyless!.id]);
    const [lookalike] = await seedTaskCompletion(1, "/longtermish/x");

    const ids = (await store.listForCuration()).map((row) => row.id);

    expect(ids).not.toContain(curated!.id);
    expect(ids.sort()).toEqual([inbox!.id, keyless!.id, lookalike!.id].sort());
    expect((await store.listForCuration(worker)).map((row) => row.id)).not.toContain(curated!.id);
  });
});

describe("file-index re-sync leaves /longterm documents alone", () => {
  const key = "/longterm/facts/memory/no-backing-file";
  const filePath = "/workspace/personal/memory/no-backing-file.md";

  const fingerprint = (id: string) =>
    getDbClient().get<Record<string, unknown>>(
      "SELECT id, agentId, scope, source, key, sourcePath, content, version FROM agent_memory WHERE id = ?",
      [id],
    );

  test.each([
    "agent",
    "swarm",
  ] as const)("%s scope: single- and multi-chunk re-index of a same-named file, and a sourcePath equal to the key", async (scope) => {
    const stored = await storeTool(worker, {
      content: "stored through memory-store, so it has no backing file",
      name: key,
      scope,
    });
    const id: string = stored.structuredContent.memoryIds[0];
    const before = await fingerprint(id);
    expect(before?.key).toBe(key);
    expect(before?.sourcePath).toBeNull();

    const index = (content: string, sourcePath: string) =>
      indexMemoryContent({
        agentId: worker,
        content,
        name: "no-backing-file",
        scope,
        source: "file_index",
        sourcePath,
      });

    // Single-chunk path: the first call inserts, the second re-indexes in place.
    await index("first version of the file, long enough to be one chunk of text", filePath);
    await index("second version of the file, long enough to be one chunk of text", filePath);
    // Multi-chunk path: delete by sourcePath, then insert every chunk.
    await index("A long file body that splits into chunks. ".repeat(120), filePath);
    const fileRows = await getDbClient().query(
      "SELECT id FROM agent_memory WHERE source = 'file_index' AND sourcePath = ?",
      [filePath],
    );
    expect(fileRows.length).toBeGreaterThan(1);
    expect(await fingerprint(id)).toEqual(before);

    // A caller that passes the /longterm key as its sourcePath cannot take it over.
    await expect(
      index("body that claims the key as its path, long enough to be a chunk", key),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    expect(await fingerprint(id)).toEqual(before);
  });
});

describe("keyPrefix search", () => {
  const prefix = "/longterm/facts/probe/";
  const LIMIT = 4;

  let decoyIds: string[];
  let targetIds: string[];
  let prevHybridFlag: string | undefined;

  beforeAll(() => {
    prevHybridFlag = process.env.MEMORY_HYBRID_SEARCH;
    process.env.MEMORY_HYBRID_SEARCH = "1";
  });

  afterAll(() => {
    if (prevHybridFlag === undefined) delete process.env.MEMORY_HYBRID_SEARCH;
    else process.env.MEMORY_HYBRID_SEARCH = prevHybridFlag;
  });

  // Six decoys with auto keys sit closer to the query (and repeat the query
  // term, so they also win on keyword rank) than the four prefixed targets.
  // With limit 4 an unfiltered search is all decoys; a filter applied after
  // top-K would return nothing.
  beforeEach(async () => {
    decoyIds = [];
    targetIds = [];
    for (let i = 0; i < 6; i++) {
      const decoy = await store.store({
        agentId: worker,
        scope: "swarm",
        name: `decoy ${i}`,
        content: "pathprobe pathprobe pathprobe pathprobe decoy note",
        source: "manual",
      });
      await store.updateEmbedding(decoy.id, mix(0.95 - i * 0.01, 4 + i), "test");
      decoyIds.push(decoy.id);
    }
    for (let i = 0; i < 4; i++) {
      const target = await store.store({
        agentId: worker,
        scope: "swarm",
        name: `target ${i}`,
        content:
          "pathprobe target note with a much longer body so that the keyword score stays lower than the decoys have",
        source: "manual",
        key: `${prefix}t${i}`,
      });
      await store.updateEmbedding(target.id, mix(0.6 - i * 0.01, 12 + i), "test");
      targetIds.push(target.id);
    }
  });

  const arms = [
    { arm: "hybrid", embedding: queryEmbedding, queryText: "pathprobe", source: "hybrid" },
    { arm: "vec", embedding: queryEmbedding, queryText: undefined, source: "vec" },
    { arm: "fts", embedding: new Float32Array(0), queryText: "pathprobe", source: "fts" },
  ] as const;

  for (const { arm, embedding, queryText, source } of arms) {
    test(`${arm} arm: fills the limit with prefixed rows that sit past the unfiltered top-K`, async () => {
      const search = (keyPrefix?: string, limit = LIMIT) =>
        store.search(embedding, worker, { scope: "all", limit, queryText, keyPrefix });

      const unfiltered = await search();
      expect(unfiltered.map((row) => row.id).sort()).toEqual(
        unfiltered
          .map((row) => row.id)
          .filter((id) => decoyIds.includes(id))
          .sort(),
      );
      expect(unfiltered.some((row) => row.retrievalSource === source)).toBe(true);

      const filtered = await search(prefix);
      expect(filtered).toHaveLength(LIMIT);
      expect(filtered.every((row) => row.key?.startsWith(prefix))).toBe(true);
      expect(filtered.some((row) => row.retrievalSource === source)).toBe(true);

      expect(await search(prefix, 2)).toHaveLength(2);
    });
  }

  test("brute-force fallback arm applies the prefix before the cut", async () => {
    // Emptying the vec table flips retrieval to the fallback arm; the embedding
    // blobs stay, so the fallback scan still scores every row.
    await getDbClient().run("DELETE FROM memory_vec");

    const filtered = await store.search(queryEmbedding, worker, {
      scope: "all",
      limit: LIMIT,
      keyPrefix: prefix,
    });

    expect(filtered).toHaveLength(LIMIT);
    expect(filtered.every((row) => row.key?.startsWith(prefix))).toBe(true);
    expect(filtered.every((row) => row.retrievalSource === "fallback")).toBe(true);
  });

  test("a prefix that matches nothing returns nothing, and `*` is not a wildcard", async () => {
    const none = await store.search(queryEmbedding, worker, {
      scope: "all",
      limit: LIMIT,
      queryText: "pathprobe",
      keyPrefix: "/longterm/facts/absent/",
    });
    const wildcard = await store.search(queryEmbedding, worker, {
      scope: "all",
      limit: LIMIT,
      queryText: "pathprobe",
      keyPrefix: "/longterm/facts/pro*",
    });

    expect(none).toEqual([]);
    expect(wildcard).toEqual([]);
  });

  test("graph expansion adds on-prefix neighbours and skips off-prefix ones", async () => {
    const insertLink = async (from: string, to: string) => {
      const now = new Date().toISOString();
      await getDbClient().run(
        `INSERT INTO memory_link
           (id, from_memory_id, linkType, targetKind, targetId, strength, resolver, sourceText, metadata, createdAt, updatedAt)
         VALUES (?, ?, 'wikilink', 'memory', ?, 1.0, 'wikilink', 'link', NULL, ?, ?)`,
        [randomUUID(), from, to, now, now],
      );
    };
    // Expansion input is target 0 alone; target 3 and decoy 5 are reachable
    // only through links.
    const parent = await store.search(queryEmbedding, worker, {
      scope: "all",
      limit: 1,
      keyPrefix: `${prefix}t0`,
    });
    expect(parent.map((row) => row.id)).toEqual([targetIds[0]!]);
    await insertLink(targetIds[0]!, targetIds[3]!);
    await insertLink(targetIds[0]!, decoyIds[5]!);

    const withPrefix = await expandCandidatesWithGraph(parent, worker, {
      scope: "all",
      keyPrefix: prefix,
    });
    const withoutPrefix = await expandCandidatesWithGraph(parent, worker, { scope: "all" });

    expect(withPrefix.map((row) => row.id).sort()).toEqual([targetIds[0]!, targetIds[3]!].sort());
    expect(withoutPrefix.map((row) => row.id).sort()).toEqual(
      [targetIds[0]!, targetIds[3]!, decoyIds[5]!].sort(),
    );
  });

  test("memory-search tool: returns only prefixed rows, and no unfiltered recents on a miss", async () => {
    const hit = await searchTool(worker, { query: "pathprobe", keyPrefix: prefix, limit: LIMIT });
    expect(hit.structuredContent.results.map((row: { id: string }) => row.id).sort()).toEqual(
      [...targetIds].sort(),
    );

    // No match for the prefix: the tool must not fall back to the unfiltered
    // recent-memories listing it uses when search finds nothing.
    const miss = await searchTool(worker, {
      query: "pathprobe",
      keyPrefix: "/longterm/facts/absent/",
      limit: LIMIT,
    });
    expect(miss.structuredContent.results).toEqual([]);
  });

  test("POST /api/memory/search carries keyPrefix through to the store", async () => {
    const search = async (body: Record<string, unknown>) => {
      const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
      req.method = "POST";
      req.url = "/api/memory/search";
      req.headers = { "x-agent-id": worker };
      const captured = { status: 0, body: {} as { results: { id: string }[] } };
      const res = {
        writeHead(status: number) {
          captured.status = status;
          return this;
        },
        end(chunk: string) {
          captured.body = JSON.parse(chunk);
          return this;
        },
      } as ServerResponse;
      expect(await handleMemory(req, res, ["api", "memory", "search"], worker)).toBe(true);
      return captured;
    };

    const unfiltered = await search({ query: "pathprobe", limit: LIMIT });
    const filtered = await search({ query: "pathprobe", limit: LIMIT, keyPrefix: prefix });

    expect(unfiltered.status).toBe(200);
    expect(unfiltered.body.results.some((row) => targetIds.includes(row.id))).toBe(false);
    expect(filtered.status).toBe(200);
    expect(filtered.body.results.map((row) => row.id).sort()).toEqual([...targetIds].sort());
  });

  test("list filters by key prefix", async () => {
    const listed = await store.list(worker, { scope: "all", limit: 50, keyPrefix: prefix });

    expect(listed.map((row) => row.id).sort()).toEqual([...targetIds].sort());
  });
});
