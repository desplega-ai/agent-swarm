import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { closeDb, initDb } from "../be/db";
import { handleConfig } from "../http/config";
import {
  __resetInjectedEnvTracking,
  _resetAutoReloadForTests,
  loadGlobalConfigsIntoEnv,
} from "../http/core";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { completedStatusIcon, reactionName } from "../slack/reaction-shortcode";
import { beginRequestAuthScope, setRequestAuth } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

const dbPath = "./test-slack-empty-icon-config.sqlite";
const key = "SLACK_REACTION_COMPLETED";
const original = process.env[key];
const templateGlobals = globalThis as typeof globalThis & { __testMigrationTemplate?: Uint8Array };
const template = templateGlobals.__testMigrationTemplate;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  // This suite verifies a real reopen. The usual template fast path creates
  // a fresh in-memory database on every initDb call.
  delete templateGlobals.__testMigrationTemplate;
  initDb(dbPath);
  server = createServer(async (req, res) => {
    beginRequestAuthScope();
    setRequestAuth(req, { kind: "operator", fingerprint: "slack-empty-icon-test" });
    if (
      !(await handleConfig(
        req,
        res,
        getPathSegments(req.url ?? ""),
        parseQueryParams(req.url ?? ""),
      ))
    ) {
      res.writeHead(404).end();
    }
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  _resetAutoReloadForTests();
  __resetInjectedEnvTracking();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  templateGlobals.__testMigrationTemplate = template;
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
  for (const suffix of ["", "-wal", "-shm"])
    await Bun.file(dbPath + suffix)
      .delete()
      .catch(() => {});
});

test("empty round-trips through HTTP, hydration, restart and restoring deployment inheritance", async () => {
  process.env[key] = "owl";
  const saved = await fetch(`${baseUrl}/api/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "global", key, value: "", isSecret: false }),
  });
  expect(saved.status).toBe(200);
  const row = await saved.json();
  expect(row.value).toBe("");
  _resetAutoReloadForTests();
  for (const path of ["/api/config?scope=global", "/api/config/resolved"]) {
    const result = await (await fetch(baseUrl + path)).json();
    expect(result.configs.find((entry: { key: string }) => entry.key === key).value).toBe("");
  }
  await loadGlobalConfigsIntoEnv(true);
  expect(process.env[key]).toBe("");
  expect(reactionName("completed")).toBeNull();
  const presence = await (await fetch(`${baseUrl}/api/config/env-presence?keys=${key}`)).json();
  expect(presence.presence[key]).toBe(true);

  // Reopen the persisted database and restore deployment env like a new process.
  closeDb();
  __resetInjectedEnvTracking();
  process.env[key] = "owl";
  initDb(dbPath);
  await loadGlobalConfigsIntoEnv(true);
  expect(reactionName("completed")).toBeNull();
  expect((await fetch(`${baseUrl}/api/config/${row.id}`, { method: "DELETE" })).status).toBe(200);
  _resetAutoReloadForTests();
  await loadGlobalConfigsIntoEnv(true);
  expect(process.env[key]).toBe("owl");
  expect(reactionName("completed")).toBe("owl");
});

test("empty deployment presence is scoped to Slack icons", async () => {
  const textKey = "SLACK_STATUS_ICON_COMPLETED";
  const unrelated = "HEARTBEAT_INTERVAL_MS";
  const previousText = process.env[textKey];
  const previousOther = process.env[unrelated];
  try {
    process.env[textKey] = "";
    process.env[unrelated] = "";
    const result = await (
      await fetch(`${baseUrl}/api/config/env-presence?keys=${textKey},${unrelated}`)
    ).json();
    expect(result.presence).toEqual({ [textKey]: true, [unrelated]: false });
    expect(completedStatusIcon()).toBe("");
  } finally {
    if (previousText === undefined) delete process.env[textKey];
    else process.env[textKey] = previousText;
    if (previousOther === undefined) delete process.env[unrelated];
    else process.env[unrelated] = previousOther;
  }
});
