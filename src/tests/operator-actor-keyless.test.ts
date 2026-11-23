import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { closeDb, createAgent, createUser, initDb } from "../be/db";
import { mintScriptRunToken } from "../be/users";
import { handleCore } from "../http/core";
import { handleUsers } from "../http/users";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

// Identity routes resolve the caller through getOperatorActor. With no swarm
// key configured, an agent session token must not be promoted to operator.

const ORIGINAL_SWARM_KEY = process.env.AGENT_SWARM_API_KEY;
const ORIGINAL_LEGACY_KEY = process.env.API_KEY;
const DUMMY_KEY = "example-operator-actor-key";

let serverKey = "";
let server: Server;
let baseUrl: string;
let agentBearer: string;
let targetUserId: string;

function setEnvKey(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.AGENT_SWARM_API_KEY;
    delete process.env.API_KEY;
  } else {
    process.env.AGENT_SWARM_API_KEY = value;
  }
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (await handleCore(req, res, req.headers["x-agent-id"] as string | undefined, serverKey)) {
    return;
  }
  const ok = await handleUsers(
    req,
    res,
    getPathSegments(req.url ?? ""),
    parseQueryParams(req.url ?? ""),
  );
  if (!ok) res.writeHead(404).end();
}

async function post(path: string, bearer: string, body: unknown): Promise<number> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await res.text();
  return res.status;
}

beforeAll(async () => {
  initDb(":memory:");
  const agent = await createAgent({ name: "keyless-worker", isLead: false, status: "idle" });
  agentBearer = (await mintScriptRunToken(agent.id, 60_000)).plaintext;
  targetUserId = (await createUser({ name: "Target", email: "target@example.com" })).id;
  server = createServer((req, res) => {
    void dispatch(req, res).catch(() => res.writeHead(500).end());
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  if (ORIGINAL_SWARM_KEY === undefined) delete process.env.AGENT_SWARM_API_KEY;
  else process.env.AGENT_SWARM_API_KEY = ORIGINAL_SWARM_KEY;
  if (ORIGINAL_LEGACY_KEY === undefined) delete process.env.API_KEY;
  else process.env.API_KEY = ORIGINAL_LEGACY_KEY;
});

describe("getOperatorActor without a configured swarm key", () => {
  test("an agent session token cannot mint a user MCP token", async () => {
    serverKey = "";
    setEnvKey(undefined);
    const status = await post(`/api/users/${targetUserId}/mcp-tokens`, agentBearer, {});
    expect(status).toBe(401);
  });

  test("an agent session token cannot create a user", async () => {
    serverKey = "";
    setEnvKey(undefined);
    const status = await post("/api/users", agentBearer, { name: "New", email: "n@example.com" });
    expect(status).toBe(401);
  });

  test("control: with a key configured, the same agent token is refused", async () => {
    serverKey = DUMMY_KEY;
    setEnvKey(DUMMY_KEY);
    const status = await post(`/api/users/${targetUserId}/mcp-tokens`, agentBearer, {});
    expect(status).toBe(401);
  });

  test("control: with a key configured, the operator key mints a token", async () => {
    serverKey = DUMMY_KEY;
    setEnvKey(DUMMY_KEY);
    const status = await post(`/api/users/${targetUserId}/mcp-tokens`, DUMMY_KEY, {});
    expect(status).toBe(200);
  });
});
