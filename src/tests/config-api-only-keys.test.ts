import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, createAgent, initDb, upsertSwarmConfig } from "../be/db";
import { handleConfig } from "../http/config";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { setRequestAuth } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

// Regression guard for the agent-fs bootstrap-key leak (PR #850 review): the
// API-owned API_AGENT_FS_API_KEY must never be handed out over /api/config
// routes. The original filter only stripped it when the agentId query param was
// present, but the docker entrypoint and runner fetch resolved/global config
// WITHOUT agentId — so the bootstrap admin key reached every worker.

const TEST_DB_PATH = "./test-config-api-only-keys.sqlite";
const API_KEY = "example-test-config-key";
const BOOTSTRAP_KEY = "API_AGENT_FS_API_KEY";
const BOOTSTRAP_VALUE = "af_bootstrap_secret_should_never_leak";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

let server: Server;
let port: number;
let agentId: string;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);

  const agent = await createAgent({ name: "worker-under-test", isLead: false, status: "idle" });
  agentId = agent.id;

  // The API-owned bootstrap key + a normal global secret a worker legitimately reads.
  await upsertSwarmConfig({
    scope: "global",
    key: BOOTSTRAP_KEY,
    value: BOOTSTRAP_VALUE,
    isSecret: true,
  });
  await upsertSwarmConfig({
    scope: "global",
    key: "SLACK_SIGNING_SECRET",
    value: "synthetic-api-only-signing-secret",
    isSecret: true,
  });
  await upsertSwarmConfig({
    scope: "global",
    key: "SOME_WORKER_SECRET",
    value: "ok",
    isSecret: true,
  });

  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    if (req.headers["x-test-operator"] === "1") setRequestAuth(req, { kind: "operator" });
    const ok = await handleConfig(req, res, pathSegments, queryParams);
    if (!ok) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
  port = await listenOnFreePort(server);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

async function getJson(
  path: string,
  options: { operator?: boolean } = {},
): Promise<{ configs: Array<{ key: string; value?: string }> }> {
  const res = await fetch(`http://localhost:${port}${path}`, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(options.operator ? { "X-Test-Operator": "1" } : {}),
    },
  });
  return (await res.json()) as { configs: Array<{ key: string; value?: string }> };
}

describe("API-only config keys are never served over HTTP", () => {
  test("GET /api/config/resolved WITHOUT agentId strips the bootstrap key", async () => {
    const { configs } = await getJson("/api/config/resolved?includeSecrets=true");
    expect(configs.some((c) => c.key === BOOTSTRAP_KEY)).toBe(false);
    expect(configs.some((c) => c.key === "SLACK_SIGNING_SECRET")).toBe(false);
    // A legitimate worker secret still comes through.
    expect(configs.some((c) => c.key === "SOME_WORKER_SECRET")).toBe(true);
  });

  test("GET /api/config/resolved WITH agentId strips the bootstrap key", async () => {
    const { configs } = await getJson(
      `/api/config/resolved?includeSecrets=true&agentId=${agentId}`,
    );
    expect(configs.some((c) => c.key === BOOTSTRAP_KEY)).toBe(false);
    expect(configs.some((c) => c.key === "SLACK_SIGNING_SECRET")).toBe(false);
  });

  test("GET /api/config?scope=global strips the bootstrap key", async () => {
    const { configs } = await getJson("/api/config?scope=global&includeSecrets=true");
    expect(configs.some((c) => c.key === BOOTSTRAP_KEY)).toBe(false);
    expect(configs.some((c) => c.key === "SLACK_SIGNING_SECRET")).toBe(false);
    expect(configs.some((c) => c.key === "SOME_WORKER_SECRET")).toBe(true);
  });

  test("an operator principal gets the same strip on every list route", async () => {
    for (const path of [
      "/api/config/resolved?includeSecrets=true",
      `/api/config/resolved?includeSecrets=true&agentId=${agentId}`,
      "/api/config?scope=global&includeSecrets=true",
    ]) {
      const { configs } = await getJson(path, { operator: true });
      expect(configs.some((c) => c.key === BOOTSTRAP_KEY)).toBe(false);
      expect(configs.some((c) => c.key === "SLACK_SIGNING_SECRET")).toBe(false);
      expect(configs.some((c) => c.key === "SOME_WORKER_SECRET")).toBe(true);
    }
  });

  test("a row override cannot widen an API-only key", async () => {
    const res = await fetch(`http://localhost:${port}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Test-Operator": "1" },
      body: JSON.stringify({
        scope: "global",
        key: BOOTSTRAP_KEY,
        value: `synthetic-${crypto.randomUUID()}`,
        isSecret: true,
        exposure: "worker",
      }),
    });
    expect(res.status).toBe(400);
    const { configs } = await getJson("/api/config?scope=global&includeSecrets=true", {
      operator: true,
    });
    expect(configs.some((c) => c.key === BOOTSTRAP_KEY)).toBe(false);
  });
});
