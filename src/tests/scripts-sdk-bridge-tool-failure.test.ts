/**
 * Outer `success` on generic MCP bridge calls. The bridge answers HTTP 200 with
 * the tool's structuredContent, so a tool refusal (toolErr) arrives as 200 with
 * `data.success === false`. The SDK must surface that as outer `success: false`
 * while leaving `status` and `data` untouched, mirror the refusal `message`,
 * and must not throw.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { closeDb, createAgent, initDb } from "../be/db";
import { handleMcpBridge } from "../http/mcp-bridge";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { SwarmConfig } from "../scripts-runtime/swarm-config";
import { createSwarmSdk } from "../scripts-runtime/swarm-sdk";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-scripts-sdk-bridge-tool-failure.sqlite";
const API_KEY = "example-scripts-sdk-bridge-tool-failure-key-1234567890";
let baseUrl = "";
let server: Server;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => {});
  }
}

function sdkFor(agentId: string, mcpBaseUrl: string) {
  return createSwarmSdk(
    new SwarmConfig({
      system: {
        apiKey: { value: API_KEY, isSecret: true },
        agentId: { value: agentId, isSecret: false },
        mcpBaseUrl: { value: mcpBaseUrl, isSecret: false },
      },
      user: {},
    }),
  );
}

/** Serves one fixed bridge response, to pin the SDK's mapping per body shape. */
async function withBridgeStub<T>(
  body: unknown,
  status: number,
  fn: (url: string) => Promise<T>,
): Promise<T> {
  const stub = Bun.serve({
    port: 0,
    fetch: () => Response.json(body, { status }),
  });
  try {
    return await fn(`http://127.0.0.1:${stub.port}`);
  } finally {
    stub.stop(true);
  }
}

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  server = createHttpServer(async (req, res) => {
    const myAgentId = (req.headers["x-agent-id"] as string | undefined) ?? undefined;
    const segments = getPathSegments(req.url ?? "");
    const query = parseQueryParams(req.url ?? "");
    if (await handleMcpBridge(req, res, segments, query, myAgentId)) return;
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
  const port = await listenOnFreePort(server);
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

describe("generic MCP bridge: tool refusal sets outer success false", () => {
  test("skill_update with the wrong id field is a refusal, not a success", async () => {
    const agentId = crypto.randomUUID();
    await createAgent({
      id: agentId,
      name: "bridge-failure-agent",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const result = (await sdkFor(agentId, baseUrl).skill_update({
      id: crypto.randomUUID(),
    })) as { success: boolean; status: number; data: Record<string, unknown> };

    expect(result.status).toBe(200);
    expect(result.data.success).toBe(false);
    expect(result.data.message).toBe("skillId is required.");
    expect(result.success).toBe(false);
    expect((result as { message?: unknown }).message).toBe("skillId is required.");
  });

  test("an inner success keeps outer success true", async () => {
    const body = { success: true, message: "Posted.", ts: "1" };
    const result = await withBridgeStub(body, 200, (url) =>
      sdkFor("agent-sdk", url).slack_post({ channelId: "C1", message: "hi" }),
    );
    expect(result).toEqual({ success: true, status: 200, data: body });
  });

  test("an inner failure keeps status and data unchanged and mirrors the message", async () => {
    const body = { success: false, message: "Channel not found." };
    const result = await withBridgeStub(body, 200, (url) =>
      sdkFor("agent-sdk", url).slack_post({ channelId: "C1", message: "hi" }),
    );
    expect(result).toEqual({
      success: false,
      status: 200,
      data: body,
      message: "Channel not found.",
    });
  });

  test("a body without a success flag follows the HTTP status", async () => {
    const body = { result: "plain text tool output" };
    const result = await withBridgeStub(body, 200, (url) =>
      sdkFor("agent-sdk", url).slack_post({ channelId: "C1", message: "hi" }),
    );
    expect(result).toEqual({ success: true, status: 200, data: body });
  });

  test("an HTTP error still reports success false without throwing", async () => {
    const body = { error: "Tool 'x' not found in the MCP registry" };
    const result = await withBridgeStub(body, 404, (url) =>
      sdkFor("agent-sdk", url).slack_post({ channelId: "C1", message: "hi" }),
    );
    expect(result).toEqual({ success: false, status: 404, data: body });
  });
});
