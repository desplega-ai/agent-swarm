/**
 * POST /api/github/installation-token: the worker endpoint that hands git and gh
 * a GitHub App installation token. A `Bun.serve` on port 0 stands in for the
 * GitHub host (GHES mode, so the API base is the mock) and records every mint
 * and every installation lookup.
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
import {
  closeDb,
  createAgent,
  createSwarmRepo,
  createTaskExtended,
  createUser,
  initDb,
} from "../be/db";
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
/** Repo -> installation id the mock App reports for `GET /repos/{repo}/installation`. */
let installations: Record<string, number> = {};
let lookups: string[] = [];
let lookupAuth: string[] = [];
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

function call(headers: Record<string, string>, body: Record<string, unknown> = {}) {
  return fetch(`http://localhost:${port}/api/github/installation-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
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
      // Repo-aware resolution: the App JWT asks which installation owns a repo.
      const lookup = path.match(/^\/api\/v3\/repos\/([^/]+\/[^/]+)\/installation$/);
      if (lookup) {
        const repo = lookup[1]!;
        lookups.push(repo);
        lookupAuth.push(req.headers.get("authorization") ?? "");
        const id = installations[repo];
        if (id === undefined) return new Response("no installation", { status: 404 });
        return Response.json({ id });
      }
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
  installations = {};
  lookups = [];
  lookupAuth = [];
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

  describe("repo-aware installation", () => {
    const audb = "clovellyapps/audb";

    test("a registered repo with its own installation mints for that installation", async () => {
      installations[audb] = 88;
      // Registered with a URL in a different case and with `.git`: the check
      // normalizes both sides, so the shorthand below matches.
      await createSwarmRepo({ url: "https://github.com/ClovellyApps/Audb.git", name: "audb" });

      const res = await call(asAgent(agentId), { repo: audb });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(((await res.json()) as { token: string }).token).toBe(INSTALLATION_TOKEN);
      expect(lookups).toEqual([audb]);
      // The lookup authenticated as the App (a JWT), never with a worker token.
      expect(lookupAuth[0]).toMatch(/^Bearer eyJ/);
      expect(mints).toEqual(["/api/v3/app/installations/88/access_tokens"]);

      // Second call: the installation cache and the token cache both serve it.
      expect((await call(asAgent(agentId), { repo: audb })).status).toBe(200);
      expect(lookups).toEqual([audb]);
      expect(mints).toEqual(["/api/v3/app/installations/88/access_tokens"]);

      // The no-repo path is untouched: the fixed installation, still 77.
      expect((await call(asAgent(agentId))).status).toBe(200);
      expect(mints).toEqual([
        "/api/v3/app/installations/88/access_tokens",
        "/api/v3/app/installations/77/access_tokens",
      ]);
      for (const spy of [logSpy, errorSpy]) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain(INSTALLATION_TOKEN);
      }
    });

    test("403 for a repo the swarm has not registered, and nothing is minted", async () => {
      // The App could mint for it; the swarm registration gate is what refuses it.
      installations["desplega-ai/agent-swarm"] = 99;
      const res = await call(asAgent(agentId), { repo: "desplega-ai/agent-swarm" });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe(
        "The repo is not registered in the swarm",
      );
      // A `.`/`..` segment is not a repository and never reaches the lookup.
      const traversal = await call(asAgent(agentId), { repo: "../x" });
      expect(traversal.status).toBe(403);
      // The registration gate runs before the App JWT lookup.
      expect(lookups).toEqual([]);
      expect(mints).toEqual([]);
    });

    test("502 when the registered repo has no App installation", async () => {
      await createSwarmRepo({
        url: "https://github.com/spanishkangaroo/recadame",
        name: "recadame",
      });
      const res = await call(asAgent(agentId), { repo: "spanishkangaroo/recadame" });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toBe(
        "GitHub did not mint an installation token",
      );
      expect(lookups).toEqual(["spanishkangaroo/recadame"]);
      expect(mints).toEqual([]);
    });

    test("400 for a repo that is not owner/name, and nothing is minted", async () => {
      for (const repo of ["audb", "clovellyapps/audb/pulls", "clovellyapps audb", ""]) {
        const res = await call(asAgent(agentId), { repo });
        expect({ repo, status: res.status }).toEqual({ repo, status: 400 });
        expect(await res.text()).toContain("Validation error");
      }
      expect(lookups).toEqual([]);
      expect(mints).toEqual([]);
    });
  });
});
