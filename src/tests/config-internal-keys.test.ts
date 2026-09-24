import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { closeDb, getInjectableGlobalConfigs, initDb, upsertSwarmConfig } from "../be/db";
import { handleConfig } from "../http/config";
import { handleCore } from "../http/core";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const API_KEY = "example-internal-config-test-key";
const INTERNAL_KEY = "onboarding_state";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  initDb(":memory:");
  await upsertSwarmConfig({
    scope: "global",
    key: INTERNAL_KEY,
    value: JSON.stringify({ version: 1 }),
  });
  await upsertSwarmConfig({ scope: "global", key: "VISIBLE_CONFIG", value: "visible" });

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
});
