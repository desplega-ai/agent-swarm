/**
 * POST /api/github/installation-token: the worker endpoint that hands git and gh
 * a GitHub App installation token. A `Bun.serve` on port 0 stands in for the
 * GitHub host (GHES mode, so the API base is the mock) and records every mint.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { unlinkSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { closeDb, createAgent, createTaskExtended, createUser, initDb } from "../be/db";
import { mintRuntimeToken, mintSessionToken, mintToken } from "../be/users";
import { resetGitHub } from "../github/app";
import { handleCore } from "../http/core";
import { handleGitHubToken } from "../http/github-token";
import { getPathSegments } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-github-installation-token-route.sqlite";
const API_KEY = "example-test-api-key";
const INSTALLATION_TOKEN = "ghs_fixtureWorkerInstallationToken000"; // gitleaks:allow (synthetic)
const ENV_KEYS = [
  "GITHUB_URL",
  "GITHUB_API_URL",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_DISABLE",
];

let github: ReturnType<typeof Bun.serve>;
let githubStatus = 201;
let mints: string[] = [];
let server: Server;
let port: number;
let agentId: string;
let privateKeyPem = "";
const savedEnv: Record<string, string | undefined> = {};
let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

function cleanupDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

function call(headers: Record<string, string>) {
  return fetch(`http://localhost:${port}/api/github/installation-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: "{}",
  });
}

const asAgent = (id: string) => ({ Authorization: `Bearer ${API_KEY}`, "X-Agent-ID": id });

beforeAll(async () => {
  privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  github = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      mints.push(path);
      if (githubStatus !== 201) return new Response("nope", { status: githubStatus });
      return Response.json(
        { token: INSTALLATION_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        { status: 201 },
      );
    },
  });
  cleanupDb();
  initDb(TEST_DB_PATH);
  agentId = (await createAgent({ name: "Worker", isLead: false, status: "idle" })).id;
  server = createHttpServer(async (req, res) => {
    const pathSegments = getPathSegments(req.url || "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleCore(req, res, myAgentId, API_KEY)) return;
    if (await handleGitHubToken(req, res, pathSegments, myAgentId)) return;
    res.writeHead(404);
    res.end("Not Found");
  });
  port = await listenOnFreePort(server);
});

afterAll(() => {
  server.close();
  github.stop(true);
  closeDb();
  cleanupDb();
});

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.GITHUB_URL = `http://127.0.0.1:${github.port}`;
  process.env.GITHUB_APP_ID = "424242";
  process.env.GITHUB_APP_PRIVATE_KEY = privateKeyPem;
  process.env.GITHUB_APP_INSTALLATION_ID = "77";
  githubStatus = 201;
  mints = [];
  resetGitHub();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetGitHub();
});

describe("POST /api/github/installation-token", () => {
  test("a registered agent gets the configured installation's token, cached", async () => {
    const res = await call(asAgent(agentId));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { token: string; expiresAt: string };
    expect(body.token).toBe(INSTALLATION_TOKEN);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect((await call(asAgent(agentId))).status).toBe(200);
    // One mint for the fixed installation; the second call reused the cache.
    expect(mints).toEqual(["/api/v3/app/installations/77/access_tokens"]);
    // The token never reaches a log line.
    for (const spy of [logSpy, errorSpy]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(INSTALLATION_TOKEN);
    }
  });

  test("a worker runtime token is an agent and gets the token", async () => {
    const runtime = await mintRuntimeToken(agentId, crypto.randomUUID(), 60_000);
    const res = await call({ Authorization: `Bearer ${runtime.plaintext}` });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { token: string }).token).toBe(INSTALLATION_TOKEN);
  });

  test("refuses callers that are not a registered agent", async () => {
    const user = await createUser({ name: "Dashboard user" });
    const { plaintext } = await mintToken(user.id, "rest", { kind: "operator", id: "op:test" });
    // ACP harnesses hold task tokens: they never get a GitHub token.
    const task = await createTaskExtended("acp task", { agentId });
    const taskToken = await mintSessionToken(agentId, task.id, 60_000);
    const cases: [string, Record<string, string>, number][] = [
      ["ACP task token", { Authorization: `Bearer ${taskToken.plaintext}` }, 403],
      ["no key", { "X-Agent-ID": agentId }, 401],
      ["wrong key", { Authorization: "Bearer wrong", "X-Agent-ID": agentId }, 401],
      ["operator key without agent id", { Authorization: `Bearer ${API_KEY}` }, 403],
      ["unregistered agent id", asAgent(crypto.randomUUID()), 403],
      ["user token", { Authorization: `Bearer ${plaintext}`, "X-Agent-ID": agentId }, 403],
    ];
    for (const [label, headers, status] of cases) {
      const res = await call(headers);
      expect({ label, status: res.status }).toEqual({ label, status });
      expect(await res.text()).not.toContain(INSTALLATION_TOKEN);
    }
    expect(mints).toEqual([]);
  });

  test.each([
    ["no installation id", "GITHUB_APP_INSTALLATION_ID", undefined],
    ["malformed installation id", "GITHUB_APP_INSTALLATION_ID", "77/../1"],
    ["no App id", "GITHUB_APP_ID", undefined],
    ["no private key", "GITHUB_APP_PRIVATE_KEY", undefined],
    ["GITHUB_DISABLE", "GITHUB_DISABLE", "true"],
  ])("404 when App worker auth is not configured: %s", async (_label, key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    const res = await call(asAgent(agentId));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      "GitHub App worker auth is not configured",
    );
    expect(mints).toEqual([]);
  });

  test("502 when GitHub refuses the mint", async () => {
    githubStatus = 403;
    const res = await call(asAgent(agentId));
    expect(res.status).toBe(502);
    expect(mints).toEqual(["/api/v3/app/installations/77/access_tokens"]);
  });
});
