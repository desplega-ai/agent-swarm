import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  getInjectableGlobalConfigs,
  getSwarmConfigs,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import { handleConfig } from "../http/config";
import { handleCore } from "../http/core";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { registerDeleteConfigTool } from "../tools/swarm-config/delete-config";
import { registerGetConfigTool } from "../tools/swarm-config/get-config";
import { registerListConfigTool } from "../tools/swarm-config/list-config";
import { registerSetConfigTool } from "../tools/swarm-config/set-config";
import { listenOnFreePort } from "./test-net";

const API_KEY = "example-internal-config-test-key";
const INTERNAL_KEY = "onboarding_state";

let server: Server;
let baseUrl: string;
let internalId: string;

type ToolHandler = (args: unknown, meta: unknown) => Promise<unknown> | unknown;

class MockMcpServer {
  handlers = new Map<string, ToolHandler>();

  registerTool(name: string, _config: unknown, handler: ToolHandler) {
    this.handlers.set(name, handler);
    return { name };
  }
}

const mcpServer = new MockMcpServer();
const LEAD_ID = "11111111-1111-1111-1111-111111111111";

function requestInfo() {
  return {
    sessionId: "test-session",
    requestInfo: { headers: { "x-agent-id": LEAD_ID } },
  };
}

beforeAll(async () => {
  initDb(":memory:");
  internalId = (
    await upsertSwarmConfig({
      scope: "global",
      key: INTERNAL_KEY,
      value: JSON.stringify({ version: 1 }),
    })
  ).id;
  await upsertSwarmConfig({ scope: "global", key: "VISIBLE_CONFIG", value: "visible" });
  await createAgent({
    id: LEAD_ID,
    name: "internal-config-test-lead",
    isLead: true,
    status: "idle",
    capabilities: [],
  });
  registerSetConfigTool(mcpServer as unknown as Parameters<typeof registerSetConfigTool>[0]);
  registerDeleteConfigTool(mcpServer as unknown as Parameters<typeof registerDeleteConfigTool>[0]);
  registerGetConfigTool(mcpServer as unknown as Parameters<typeof registerGetConfigTool>[0]);
  registerListConfigTool(mcpServer as unknown as Parameters<typeof registerListConfigTool>[0]);

  server = createServer(async (req, res) => {
    if (await handleCore(req, res, req.headers["x-agent-id"] as string | undefined, API_KEY)) {
      return;
    }
    const segments = getPathSegments(req.url || "");
    const query = parseQueryParams(req.url || "");
    if (await handleConfig(req, res, segments, query)) return;
    res.writeHead(404).end();
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
}

describe("internal config keys", () => {
  test("onboarding_state is not injected into process.env", async () => {
    const configs = await getInjectableGlobalConfigs();
    expect(configs.map((config) => config.key)).toEqual(["VISIBLE_CONFIG"]);
  });

  test("onboarding_state is absent from config list and resolved routes", async () => {
    for (const path of ["/api/config?scope=global", "/api/config/resolved"]) {
      const response = await fetch(`${baseUrl}${path}`, { headers: headers() });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { configs: Array<{ key: string }> };
      expect(body.configs.some((config) => config.key === INTERNAL_KEY)).toBe(false);
      expect(body.configs.some((config) => config.key === "VISIBLE_CONFIG")).toBe(true);
    }
  });

  test("generic config PUT rejects onboarding_state", async () => {
    const response = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ scope: "global", key: INTERNAL_KEY, value: "tampered" }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("managed by /api/onboarding");
  });

  test("config by-id GET hides onboarding_state and DELETE rejects it", async () => {
    const getResponse = await fetch(`${baseUrl}/api/config/${internalId}`, { headers: headers() });
    expect(getResponse.status).toBe(404);

    const deleteResponse = await fetch(`${baseUrl}/api/config/${internalId}`, {
      method: "DELETE",
      headers: headers(),
    });
    expect(deleteResponse.status).toBe(400);
    expect(await deleteResponse.text()).toContain("managed by /api/onboarding");
    expect(await getSwarmConfigs({ key: INTERNAL_KEY })).toHaveLength(1);
  });

  test("MCP config tools hide and protect onboarding_state", async () => {
    const setResult = (await mcpServer.handlers.get("set-config")!(
      { scope: "global", key: INTERNAL_KEY, value: "tampered" },
      requestInfo(),
    )) as { structuredContent: { success: boolean; message: string } };
    expect(setResult.structuredContent).toMatchObject({
      success: false,
      message: "Key 'onboarding_state' is managed by /api/onboarding",
    });

    for (const tool of ["get-config", "list-config"] as const) {
      const result = (await mcpServer.handlers.get(tool)!(
        { key: INTERNAL_KEY },
        requestInfo(),
      )) as {
        structuredContent: { success: boolean; configs?: Array<{ key: string }>; count: number };
      };
      expect(result.structuredContent.success).toBe(true);
      expect(result.structuredContent.count).toBe(0);
      expect(result.structuredContent.configs ?? []).toEqual([]);
    }

    const deleteResult = (await mcpServer.handlers.get("delete-config")!(
      { id: internalId },
      requestInfo(),
    )) as { structuredContent: { success: boolean; message: string } };
    expect(deleteResult.structuredContent).toMatchObject({
      success: false,
      message: "Key 'onboarding_state' is managed by /api/onboarding",
    });
    expect(await getSwarmConfigs({ key: INTERNAL_KEY })).toHaveLength(1);
  });
});
