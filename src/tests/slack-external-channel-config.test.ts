import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { closeDb, getSwarmConfigs, initDb } from "../be/db";
import { handleConfig } from "../http/config";
import { handleCore } from "../http/core";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

// A typo such as 'treu' must not reach the DB: parseEnvFlag would read it as
// false and silently turn the external-channel block off.

const API_KEY = "example-slack-external-config-test-key";
const KEY = "SLACK_BLOCK_EXTERNAL_CHANNELS";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  initDb(":memory:");
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

function putConfig(value: string): Promise<Response> {
  return fetch(`${baseUrl}/api/config`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "global", key: KEY, value }),
  });
}

async function storedValue(): Promise<string | undefined> {
  const rows = await getSwarmConfigs({ scope: "global", key: KEY });
  return rows[0]?.value;
}

describe("SLACK_BLOCK_EXTERNAL_CHANNELS config write", () => {
  test("PUT /api/config rejects a non-boolean value and stores nothing", async () => {
    const response = await putConfig("treu");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(`Invalid ${KEY}`);
    expect(await storedValue()).toBeUndefined();
  });

  test("PUT /api/config accepts boolean literals", async () => {
    for (const value of ["true", "false", "1", "0"]) {
      const response = await putConfig(value);
      expect(response.status).toBe(200);
      expect(await storedValue()).toBe(value);
    }
  });
});
