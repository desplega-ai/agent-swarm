import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import { expandCandidatesWithGraph } from "../be/memory/graph-expansion";
import { SqliteMemoryStore } from "../be/memory/providers/sqlite-store";
import { handleMemory } from "../http/memory";
import { registerMemoryEditTool } from "../tools/memory-edit";
import { registerMemorySearchTool } from "../tools/memory-search";
import { registerMemoryStoreTool } from "../tools/memory-store";
import type { AgentMemoryScope } from "../types";

// Logical memory paths: `key` on memory-store, `newKey` on memory-edit,
// `keyPrefix` on memory-search and POST /api/memory/search, and the lead-only
// guard on the consolidated roots.

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
      key: "/facts/memory/multi-chunk",
    });

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.chunks).toBeGreaterThan(1);
    const keys = await keysOf(result.structuredContent.memoryIds);
    expect(keys).toEqual(keys.map(() => "/facts/memory/multi-chunk"));
  });

  test("refuses a second memory under a key the owner already uses in that scope", async () => {
    const first = await storeTool(worker, {
      content: "first body of the path",
      name: "first",
      scope: "swarm",
      key: "/facts/memory/taken",
    });
    expect(first.structuredContent.success).toBe(true);

    const second = await storeTool(worker, {
      content: "second body of the same path",
      name: "second",
      scope: "swarm",
      key: "/facts/memory/taken",
    });
    expect(second.isError).toBe(true);
    expect(second.structuredContent.message).toContain('key "/facts/memory/taken" is already used');
    const rows = await getDbClient().query("SELECT id FROM agent_memory WHERE name = 'second'");
    expect(rows).toHaveLength(0);
  });

  // The lead-only roots are /company-story, /entities and /timeline. Every
  // other root, and a root-lookalike such as /entities-archive, stays open.
  test.each([
    ["worker", worker, "/company-story", false],
    ["worker", worker, "/entities/people/taras", false],
    ["worker", worker, "/timeline/daily/2026-10-01", false],
    ["worker", worker, "/inbox/note", true],
    ["worker", worker, "/facts/memory/note", true],
    ["worker", worker, "/entities-archive/note", true],
    ["lead", lead, "/company-story", true],
    ["lead", lead, "/entities/people/taras", true],
    ["lead", lead, "/timeline/daily/2026-10-01", true],
  ] as const)("%s writing %s: allowed=%p", async (_who, caller, key, allowed) => {
    const result = await storeTool(caller, {
      content: "guard probe body for the path",
      name: "guard probe",
      scope: "swarm",
      key,
    });
    const stored = await getDbClient().query("SELECT id FROM agent_memory WHERE key = ?", [key]);

    expect(result.structuredContent.success).toBe(allowed);
    expect(stored).toHaveLength(allowed ? 1 : 0);
    if (!allowed) expect(result.structuredContent.message).toContain("lead-only");
  });

  test("the input schema rejects keys that could dodge the guard", () => {
    const schema = toolFor(registerMemoryStoreTool, "memory-store").inputSchema!;
    const accepts = (key: string) => schema.safeParse({ content: "x", key }).success;

    expect(accepts("/entities/repos/desplega-ai/agent-swarm")).toBe(true);
    expect(accepts("/Entities/people/taras")).toBe(false);
    expect(accepts("/entities//taras")).toBe(false);
    expect(accepts("/entities/taras/")).toBe(false);
    expect(accepts("entities/taras")).toBe(false);
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
    const [memory] = await seed("/inbox/draft");
    await getDbClient().run(
      "UPDATE agent_memory SET alpha = 4.5, beta = 1.5, accessCount = 7 WHERE id = ?",
      [memory!.id],
    );
    const before = await snapshot(memory!.id);

    const result = await editTool(worker, {
      memoryId: memory!.id,
      newKey: "/facts/memory/draft",
      intent: "classify the inbox note",
    });
    const after = await snapshot(memory!.id);

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.changed).toBe(true);
    expect(after).toEqual({ ...before, key: "/facts/memory/draft", version: 2 });
    const versions = await getDbClient().query<{ version: number; intent: string }>(
      "SELECT version, intent FROM agent_memory_version WHERE memory_id = ? ORDER BY version",
      [memory!.id],
    );
    expect(versions.map((row) => row.version)).toEqual([1, 2]);
    expect(versions[1]!.intent).toBe(
      "classify the inbox note [key /inbox/draft -> /facts/memory/draft]",
    );
  });

  test("a move addressed by key and scope reaches the same document", async () => {
    const [memory] = await seed("/inbox/by-key");

    const result = await editTool(worker, {
      key: "/inbox/by-key",
      scope: "swarm",
      newKey: "/facts/memory/by-key",
      intent: "move by key",
    });

    expect(result.structuredContent.success).toBe(true);
    expect((await snapshot(memory!.id))?.key).toBe("/facts/memory/by-key");
  });

  test("a move updates every chunk of a multi-chunk document", async () => {
    const chunks = await seed("/inbox/long", { chunks: 3 });

    const result = await editTool(worker, {
      memoryId: chunks[0]!.id,
      newKey: "/facts/memory/long",
      intent: "move a long document",
    });

    expect(result.structuredContent.success).toBe(true);
    const rows = await getDbClient().query<{ id: string; key: string; chunkIndex: number }>(
      "SELECT id, key, chunkIndex FROM agent_memory ORDER BY chunkIndex",
    );
    expect(rows.map((row) => row.id)).toEqual(chunks.map((chunk) => chunk.id));
    expect(rows.map((row) => row.key)).toEqual(chunks.map(() => "/facts/memory/long"));
  });

  test("a key already in use is refused and nothing moves", async () => {
    const [mover] = await seed("/inbox/mover");
    await seed("/facts/memory/occupied");

    const result = await editTool(worker, {
      memoryId: mover!.id,
      newKey: "/facts/memory/occupied",
      intent: "collide",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.message).toContain("already used");
    expect((await snapshot(mover!.id))?.key).toBe("/inbox/mover");
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
      newKey: "/facts/memory/legacy",
      intent: "move a legacy document",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.message).toContain("do not share one");
    expect(await keysOf([first.id, second.id])).toEqual([first.key!, second.key!]);
  });

  test("a non-lead cannot move a memory into a lead-only path; the lead can", async () => {
    const [mine] = await seed("/inbox/mine");

    const refused = await editTool(worker, {
      memoryId: mine!.id,
      newKey: "/company-story",
      intent: "try to promote",
    });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.message).toContain("lead-only");
    expect((await snapshot(mine!.id))?.key).toBe("/inbox/mine");

    const allowed = await editTool(lead, {
      memoryId: mine!.id,
      newKey: "/company-story",
      intent: "lead consolidates",
    });
    expect(allowed.structuredContent.success).toBe(true);
    expect((await snapshot(mine!.id))?.key).toBe("/company-story");
  });
});

describe("keyPrefix search", () => {
  const prefix = "/facts/probe/";
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
      keyPrefix: "/facts/absent/",
    });
    const wildcard = await store.search(queryEmbedding, worker, {
      scope: "all",
      limit: LIMIT,
      queryText: "pathprobe",
      keyPrefix: "/facts/pro*",
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
      keyPrefix: "/facts/absent/",
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
