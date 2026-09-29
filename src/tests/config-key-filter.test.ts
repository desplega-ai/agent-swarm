import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { closeDb, initDb, upsertSwarmConfig } from "../be/db";
import { handleConfig } from "../http/config";
import { handleCore } from "../http/core";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

// ctx.swarm.config_get / config_list send `key` to these routes. Both used to
// ignore it and return every row, so a script asking for one secret got all.

const API_KEY = "example-config-key-filter-test-key";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  initDb(":memory:");
  await upsertSwarmConfig({ scope: "global", key: "WANTED_KEY", value: "wanted" });
  await upsertSwarmConfig({
    scope: "global",
    key: "OTHER_SECRET",
    value: "other-secret-value",
    isSecret: true,
  });
  await upsertSwarmConfig({ scope: "global", key: "PLAIN_KEY", value: "plain" });

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

async function getKeys(path: string): Promise<string[]> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { configs: Array<{ key: string }> };
  return body.configs.map((config) => config.key);
}

const ALL_KEYS = ["OTHER_SECRET", "PLAIN_KEY", "WANTED_KEY"];

describe.each([
  ["/api/config/resolved", "?"],
  ["/api/config", "?scope=global&"],
])("GET %s key filter", (path, prefix) => {
  test("?key=<existing> returns exactly that row", async () => {
    expect(await getKeys(`${path}${prefix}key=WANTED_KEY&includeSecrets=true`)).toEqual([
      "WANTED_KEY",
    ]);
  });

  test("?key=<unknown> returns an empty list", async () => {
    expect(await getKeys(`${path}${prefix}key=NO_SUCH_KEY&includeSecrets=true`)).toEqual([]);
  });

  test("no key returns every row", async () => {
    expect((await getKeys(`${path}${prefix}includeSecrets=true`)).sort()).toEqual(ALL_KEYS);
  });

  test("an empty key is rejected instead of returning every row", async () => {
    const response = await fetch(`${baseUrl}${path}${prefix}key=`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(response.status).toBe(400);
  });
});
