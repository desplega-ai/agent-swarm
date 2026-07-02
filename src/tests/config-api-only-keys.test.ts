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

// Regression guard for the agent-fs bootstrap-key leak (PR #850 review): the
// API-owned API_AGENT_FS_API_KEY must never be handed out over /api/config
// routes. The original filter only stripped it when the agentId query param was
// present, but the docker entrypoint and runner fetch resolved/global config
// WITHOUT agentId — so the bootstrap admin key reached every worker.

const TEST_DB_PATH = "./test-config-api-only-keys.sqlite";
const API_KEY = "test-config-key";
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

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

let server: Server;
let port: number;
let agentId: string;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);

  const agent = createAgent({ name: "worker-under-test", isLead: false, status: "idle" });
  agentId = agent.id;

  // The API-owned bootstrap key + a normal global secret a worker legitimately reads.
  upsertSwarmConfig({
    scope: "global",
    key: BOOTSTRAP_KEY,
    value: BOOTSTRAP_VALUE,
    isSecret: true,
  });
  upsertSwarmConfig({ scope: "global", key: "SOME_WORKER_SECRET", value: "ok", isSecret: true });

  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const ok = await handleConfig(req, res, pathSegments, queryParams);
    if (!ok) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
  port = await listen(server);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

async function getJson(path: string): Promise<{ configs: Array<{ key: string; value?: string }> }> {
  const res = await fetch(`http://localhost:${port}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  return (await res.json()) as { configs: Array<{ key: string; value?: string }> };
}

describe("API-only config keys are never served over HTTP", () => {
  test("GET /api/config/resolved WITHOUT agentId strips the bootstrap key", async () => {
    const { configs } = await getJson("/api/config/resolved?includeSecrets=true");
    expect(configs.some((c) => c.key === BOOTSTRAP_KEY)).toBe(false);
    // A legitimate worker secret still comes through.
    expect(configs.some((c) => c.key === "SOME_WORKER_SECRET")).toBe(true);
  });

  test("GET /api/config/resolved WITH agentId strips the bootstrap key", async () => {
    const { configs } = await getJson(
      `/api/config/resolved?includeSecrets=true&agentId=${agentId}`,
    );
    expect(configs.some((c) => c.key === BOOTSTRAP_KEY)).toBe(false);
  });

  test("GET /api/config?scope=global strips the bootstrap key", async () => {
    const { configs } = await getJson("/api/config?scope=global&includeSecrets=true");
    expect(configs.some((c) => c.key === BOOTSTRAP_KEY)).toBe(false);
    expect(configs.some((c) => c.key === "SOME_WORKER_SECRET")).toBe(true);
  });
});
