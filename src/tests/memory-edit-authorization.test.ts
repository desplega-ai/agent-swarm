import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import { getEmbeddingProvider, getMemoryStore } from "../be/memory";
import { runBootReembed } from "../be/memory/boot-reembed";
import { EMBEDDING_DIMENSIONS } from "../be/memory/constants";
import { storeLinks } from "../be/memory/link-resolver";
import { handleMemory } from "../http/memory";
import { registerMemoryEditTool } from "../tools/memory-edit";
import type { AgentMemoryScope } from "../types";

const owner = randomUUID();
const stranger = randomUUID();
const lead = randomUUID();
const vector = new Float32Array(EMBEDDING_DIMENSIONS).fill(0.1);
const provider = getEmbeddingProvider();
const embed = spyOn(provider, "embed").mockResolvedValue(vector);
const embedBatch = spyOn(provider, "embedBatch").mockImplementation(async (texts) =>
  texts.map(() => vector),
);
const store = getMemoryStore();

beforeAll(async () => {
  initDb(":memory:");
  for (const id of [owner, stranger, lead]) {
    await createAgent({ id, name: id, isLead: id === lead, status: "idle" });
  }
});

afterAll(() => {
  embed.mockRestore();
  embedBatch.mockRestore();
  closeDb();
});

async function httpCall(caller: string, route: string, body: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  req.method = "POST";
  req.url = `/api/memory/${route}`;
  req.headers = { "x-agent-id": caller };
  const captured = { status: 0, body: {} as Record<string, unknown> };
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
  expect(await handleMemory(req, res, ["api", "memory", route], caller)).toBe(true);
  return captured;
}

async function mcpCall(caller: string, args: Record<string, unknown>) {
  const server = new McpServer({ name: "memory-edit-authorization", version: "1.0.0" });
  registerMemoryEditTool(server);
  const tool = (
    server as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (
            args: unknown,
            extra: unknown,
          ) => Promise<{
            isError: boolean;
            structuredContent: Record<string, unknown>;
          }>;
        }
      >;
    }
  )._registeredTools["memory-edit"]!;
  return tool.handler(args, {
    sessionId: "memory-edit-authorization",
    requestInfo: { headers: { "x-agent-id": caller } },
  });
}

for (const entrypoint of ["MCP", "HTTP"] as const) {
  describe(`${entrypoint} memory edit authorization`, () => {
    async function edit(caller: string, args: Record<string, unknown>, allowed: boolean) {
      const body = {
        mode: "replace",
        content: "new body",
        intent: "authorization regression",
        ...args,
      };
      if (entrypoint === "MCP") {
        const result = await mcpCall(caller, body);
        expect(result.isError).toBe(!allowed);
        expect(result.structuredContent.success).toBe(allowed);
        if (!allowed) {
          expect(result.structuredContent.yourAgentId).toBe(caller);
          expect(result.structuredContent.message).toBe(
            "Permission denied. You can only edit your own memories unless you are the lead.",
          );
        }
      } else {
        const result = await httpCall(caller, "edit", body);
        expect(result.status).toBe(allowed ? 200 : 403);
        if (!allowed)
          expect(result.body).toEqual({
            error:
              "Permission denied. You can only edit your own memories unless you are the lead.",
          });
      }
    }

    for (const scope of ["agent", "swarm"] satisfies AgentMemoryScope[]) {
      for (const [label, caller, allowed] of [
        ["owner", owner, true],
        ["non-owner worker", stranger, false],
        ["lead", lead, true],
      ] as const) {
        test(`${label} editing another/own ${scope} memory by ID: ${allowed ? "allow" : "deny"}`, async () => {
          const memory = await store.store({
            agentId: owner,
            scope,
            name: randomUUID(),
            content: "old body",
            source: "manual",
          });
          const before = await store.peek(memory.id);
          const embedCalls = embed.mock.calls.length;
          await edit(
            caller,
            { memoryId: memory.id, key: "cannot-override-id", scope: "swarm" },
            allowed,
          );
          const after = await store.peek(memory.id);
          expect(after?.content).toBe(allowed ? "new body" : "old body");
          expect(after?.agentId).toBe(owner);
          expect(after?.version).toBe(allowed ? 2 : 1);
          if (!allowed) {
            expect(after).toEqual(before);
            expect(embed.mock.calls.length).toBe(embedCalls);
            const versions = await getDbClient().query(
              "SELECT version FROM agent_memory_version WHERE memory_id = ?",
              [memory.id],
            );
            expect(versions).toHaveLength(1);
          }
        });
      }
    }

    test("key+scope continues to select only the caller's memory", async () => {
      const key = randomUUID();
      const own = await store.store({
        agentId: stranger,
        scope: "swarm",
        key,
        name: key,
        content: "own",
        source: "manual",
      });
      const other = await store.store({
        agentId: owner,
        scope: "swarm",
        key,
        name: key,
        content: "other",
        source: "manual",
      });
      await edit(stranger, { key, scope: "swarm" }, true);
      expect((await store.peek(own.id))?.content).toBe("new body");
      expect((await store.peek(other.id))?.content).toBe("other");
    });

    test("Lead edits resolve private wikilinks in the memory owner's namespace", async () => {
      const name = randomUUID();
      const ownerTarget = await store.store({
        agentId: owner,
        scope: "agent",
        name,
        content: "owner target",
        source: "manual",
      });
      const leadTarget = await store.store({
        agentId: lead,
        scope: "agent",
        name,
        content: "lead target",
        source: "manual",
      });
      const memory = await store.store({
        agentId: owner,
        scope: "agent",
        name: randomUUID(),
        content: "before link",
        source: "manual",
      });
      await edit(lead, { memoryId: memory.id, content: `See [[${name}]]` }, true);
      const links = await getDbClient().query<{ targetId: string }>(
        "SELECT targetId FROM memory_link WHERE from_memory_id = ? AND linkType = 'wikilink'",
        [memory.id],
      );
      expect(links).toEqual([{ targetId: ownerTarget.id }]);
      expect(links.some((link) => link.targetId === leadTarget.id)).toBe(false);
    });

    test("unowned swarm memory requires Lead", async () => {
      const memory = await store.store({
        agentId: null,
        scope: "swarm",
        name: randomUUID(),
        content: "unowned",
        source: "manual",
      });
      await edit(stranger, { memoryId: memory.id }, false);
      await edit(lead, { memoryId: memory.id }, true);
    });
  });
}

test("internal cross-agent re-index still edits, embeds and refreshes links", async () => {
  const targetName = randomUUID();
  const target = await store.store({
    agentId: owner,
    scope: "agent",
    name: targetName,
    content: "target",
    source: "manual",
  });
  const sourcePath = `notes/${randomUUID()}.md`;
  const memory = await store.store({
    agentId: owner,
    scope: "agent",
    sourcePath,
    name: "indexed",
    content: `See [[${targetName}]]`,
    source: "file_index",
  });
  await storeLinks(memory.id, owner, memory.content);
  expect(
    await getDbClient().query("SELECT * FROM memory_link WHERE from_memory_id = ?", [memory.id]),
  ).toHaveLength(1);

  // The file-index route writes for the supplied owner, independently of the caller.
  const result = await httpCall(stranger, "index", {
    agentId: owner,
    scope: "agent",
    sourcePath,
    name: "indexed",
    content: "reindexed content",
    source: "file_index",
  });
  expect(result.status).toBe(202);
  expect(result.body).toMatchObject({ edited: true, memoryIds: [memory.id] });
  expect(await store.peek(memory.id)).toMatchObject({
    agentId: owner,
    content: "reindexed content",
    version: 2,
    embeddingModel: provider.name,
  });
  expect(
    await getDbClient().query("SELECT * FROM memory_link WHERE from_memory_id = ?", [memory.id]),
  ).toHaveLength(0);
  expect((await store.peek(target.id))?.content).toBe("target");
});

test("boot re-embedding still updates rows belonging to multiple agents", async () => {
  const memories = [];
  for (const agentId of [owner, stranger]) {
    const memory = await store.store({
      agentId,
      scope: "agent",
      name: randomUUID(),
      content: "re-embed me",
      source: "manual",
    });
    await getDbClient().run("UPDATE agent_memory SET embedding = ? WHERE id = ?", [
      new Uint8Array(4),
      memory.id,
    ]);
    memories.push(memory);
  }
  await runBootReembed();
  for (const memory of memories) {
    const row = await getDbClient().get(
      "SELECT agentId, length(embedding) AS bytes, embeddingModel FROM agent_memory WHERE id = ?",
      [memory.id],
    );
    expect(row).toEqual({
      agentId: memory.agentId,
      bytes: EMBEDDING_DIMENSIONS * 4,
      embeddingModel: provider.name,
    });
  }
});
