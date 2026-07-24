import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, createAgent, initDb } from "../be/db";
import {
  createEdgeHandler,
  listEdgeHandlers,
  listEnabledHandlersForEdge,
} from "../be/edge-handlers-db";
import { upsertScriptByName } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { handleRouting } from "../http/routing";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = "./test-edge-handlers.sqlite";
const TEST_PORT = 13066;
const BASE = `http://localhost:${TEST_PORT}`;

const noOpEmbeddingProvider = {
  name: "test/noop-edge-handler-embedding",
  dimensions: 1,
  async embed() {
    return null;
  },
  async embedBatch(texts: string[]) {
    return texts.map(() => null);
  },
};

let server: Server;
let leadAgentId: string;
let ownerAgentId: string;
let otherAgentId: string;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    const handled = await handleRouting(
      req,
      res,
      getPathSegments(url),
      parseQueryParams(url),
      req.headers["x-agent-id"] as string | undefined,
    );
    if (!handled) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
}

async function request(
  path: string,
  agentId: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: options.method ?? "GET",
    headers: { "Content-Type": "application/json", "X-Agent-ID": agentId },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function saveGlobalScript(name: string): Promise<void> {
  await upsertScriptByName({
    name,
    scope: "global",
    source: "export default async function run() { return { ok: true }; }",
    description: `${name} fixture`,
    intent: "edge handler test fixture",
    signatureJson: JSON.stringify({ args: { type: "object" }, result: { type: "object" } }),
    agentId: leadAgentId,
    typeChecked: true,
  });
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  setScriptEmbeddingProviderForTests(noOpEmbeddingProvider);
  leadAgentId = createAgent({ name: "edge-handler-lead", isLead: true, status: "idle" }).id;
  ownerAgentId = createAgent({ name: "edge-handler-owner", isLead: false, status: "idle" }).id;
  otherAgentId = createAgent({ name: "edge-handler-other", isLead: false, status: "idle" }).id;
  await saveGlobalScript("edge-handler-fixture");
  server = createTestServer();
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setScriptEmbeddingProviderForTests(null);
  closeDb();
  await removeDbFiles();
});

describe("edge handler registration routes", () => {
  test("CRUD roundtrip", async () => {
    const created = await request("/api/routing/handlers", leadAgentId, {
      method: "POST",
      body: {
        name: "route-roundtrip",
        edge: "task.before_assign",
        scriptName: "edge-handler-fixture",
        flavor: "route",
        mode: "soft",
        priority: 25,
        matcher: { via: "creation", taskType: "review" },
      },
    });
    expect(created.status).toBe(201);
    const { handler } = (await created.json()) as {
      handler: { id: string; matcher?: { via?: string } };
    };
    expect(handler.matcher?.via).toBe("creation");

    const listed = await request("/api/routing/handlers", otherAgentId);
    expect(listed.status).toBe(200);
    const listPayload = (await listed.json()) as { handlers: Array<{ id: string }> };
    expect(listPayload.handlers.some((candidate) => candidate.id === handler.id)).toBe(true);

    const patched = await request(`/api/routing/handlers/${handler.id}`, leadAgentId, {
      method: "PATCH",
      body: { description: "updated", enabled: false, priority: 30 },
    });
    expect(patched.status).toBe(200);
    const patchPayload = (await patched.json()) as {
      handler: { description?: string; enabled: boolean; priority: number };
    };
    expect(patchPayload.handler).toMatchObject({
      description: "updated",
      enabled: false,
      priority: 30,
    });

    const deleted = await request(`/api/routing/handlers/${handler.id}`, leadAgentId, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });
  });

  test("rejects unknown edges, missing scripts, invalid matcher via, and invalid filters", async () => {
    const base = {
      name: "invalid-handler",
      edge: "task.before_assign",
      scriptName: "edge-handler-fixture",
      flavor: "route",
      mode: "soft",
    };

    const unknownEdge = await request("/api/routing/handlers", leadAgentId, {
      method: "POST",
      body: { ...base, name: "invalid-edge", edge: "task.after_assign" },
    });
    expect(unknownEdge.status).toBe(400);

    const missingScript = await request("/api/routing/handlers", leadAgentId, {
      method: "POST",
      body: { ...base, name: "missing-script", scriptName: "does-not-exist" },
    });
    expect(missingScript.status).toBe(400);
    expect((await missingScript.json()) as { error: string }).toEqual({
      error: "Global script not found: does-not-exist",
    });

    const badVia = await request("/api/routing/handlers", leadAgentId, {
      method: "POST",
      body: { ...base, name: "bad-via", matcher: { via: "manual" } },
    });
    expect(badVia.status).toBe(400);

    const invalidFilter = await request("/api/routing/handlers", leadAgentId, {
      method: "POST",
      body: { ...base, name: "bad-filter", matcher: { filter: "(payload) => {" } },
    });
    expect(invalidFilter.status).toBe(400);
    expect((await invalidFilter.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("wait filter compile error"),
    });
  });

  test("enforces lead-only create and resource-owner patch", async () => {
    const nonLeadCreate = await request("/api/routing/handlers", otherAgentId, {
      method: "POST",
      body: {
        name: "worker-cannot-create",
        edge: "task.before_assign",
        scriptName: "edge-handler-fixture",
        flavor: "guard",
        mode: "hard",
      },
    });
    expect(nonLeadCreate.status).toBe(403);

    const owned = createEdgeHandler({
      name: "worker-owned-handler",
      edge: "prompt.compose",
      scriptName: "edge-handler-fixture",
      flavor: "route",
      mode: "soft",
      createdByAgentId: ownerAgentId,
    });

    const ownerPatch = await request(`/api/routing/handlers/${owned.id}`, ownerAgentId, {
      method: "PATCH",
      body: { priority: 10 },
    });
    expect(ownerPatch.status).toBe(200);

    const nonOwnerPatch = await request(`/api/routing/handlers/${owned.id}`, otherAgentId, {
      method: "PATCH",
      body: { priority: 20 },
    });
    expect(nonOwnerPatch.status).toBe(403);

    const nonOwnerDelete = await request(`/api/routing/handlers/${owned.id}`, otherAgentId, {
      method: "DELETE",
    });
    expect(nonOwnerDelete.status).toBe(403);
    expect(listEdgeHandlers().some((handler) => handler.id === owned.id)).toBe(true);
  });

  test("enabled edge lookup excludes disabled handlers without hiding them from plain lists", () => {
    const disabled = createEdgeHandler({
      name: "disabled-routing-handler",
      edge: "task.before_assign",
      scriptName: "edge-handler-fixture",
      flavor: "guard",
      mode: "soft",
      enabled: false,
      createdByAgentId: leadAgentId,
    });

    expect(listEdgeHandlers().some((handler) => handler.id === disabled.id)).toBe(true);
    expect(
      listEnabledHandlersForEdge("task.before_assign").some(
        (handler) => handler.id === disabled.id,
      ),
    ).toBe(false);
  });
});
