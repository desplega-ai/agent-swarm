import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, initDb } from "../be/db";
import { handlePages } from "../http/pages";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = "./test-pages-actions-endpoint.sqlite";
const TEST_PORT = 13062;
const baseUrl = `http://localhost:${TEST_PORT}`;

interface ActionListResponse {
  actions: Array<{
    name: string;
    description: string;
    params: Record<string, unknown>;
    sdkMethods?: string[];
  }>;
}

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const handled = await handlePages(req, res, pathSegments, queryParams, myAgentId);
    if (!handled) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });
}

describe("GET /api/pages/actions — JSON-page action allowlist", () => {
  let server: Server;

  beforeAll(async () => {
    process.env.DB_PATH = TEST_DB_PATH;
    initDb();
    server = createTestServer();
    await new Promise<void>((r) => server.listen(TEST_PORT, r));
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    closeDb();
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      /* ok */
    }
  });

  test("returns both swarm.sdk and swarm.call action descriptors", async () => {
    const res = await fetch(`${baseUrl}/api/pages/actions`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as ActionListResponse;
    const names = json.actions.map((a) => a.name);
    expect(names).toContain("swarm.sdk");
    expect(names).toContain("swarm.call");
  });

  test("swarm.sdk descriptor surfaces the full SDK method allowlist", async () => {
    const res = await fetch(`${baseUrl}/api/pages/actions`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as ActionListResponse;
    const sdk = json.actions.find((a) => a.name === "swarm.sdk");
    expect(sdk).toBeDefined();
    expect(sdk?.sdkMethods).toEqual([
      "createTask",
      "getTasks",
      "getTaskDetails",
      "storeProgress",
      "postMessage",
      "readMessages",
      "getSwarm",
      "listServices",
      "slackReply",
    ]);
    // params is a JSON Schema 7 object with `sdk` enum + optional `args`
    expect(sdk?.params).toBeDefined();
    expect((sdk?.params as { type?: string }).type).toBe("object");
  });

  test("swarm.call descriptor describes the {method, endpoint, body} shape", async () => {
    const res = await fetch(`${baseUrl}/api/pages/actions`);
    const json = (await res.json()) as ActionListResponse;
    const call = json.actions.find((a) => a.name === "swarm.call");
    expect(call).toBeDefined();
    const params = call?.params as { properties?: Record<string, unknown> };
    expect(params.properties).toBeDefined();
    expect(params.properties).toHaveProperty("method");
    expect(params.properties).toHaveProperty("endpoint");
    expect(params.properties).toHaveProperty("body");
  });
});
