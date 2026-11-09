/**
 * GitHub Enterprise Server: every API-server GitHub call goes to the host in
 * GITHUB_URL, never to api.github.com.
 *
 * A `Bun.serve` on port 0 stands in for the GHES instance and records every
 * request. `fetch` is wrapped so any non-loopback request fails the test, which
 * proves no call (or token) reaches the public host. The default-mode block
 * pins today's exact github.com URLs.
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
import { getInstallationToken, initGitHub, resetGitHub } from "../github/app";
import { addGraphQLReaction, addIssueReaction, postComment } from "../github/reactions";

const INSTALLATION_TOKEN = "ghs_fixtureGhesInstallationToken0000"; // gitleaks:allow (synthetic)
const ENV_KEYS = [
  "GITHUB_URL",
  "GITHUB_API_URL",
  "GITHUB_TOKEN",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_DISABLE",
];

interface Recorded {
  method: string;
  path: string;
  authorization: string | null;
}

let server: ReturnType<typeof Bun.serve>;
let recorded: Recorded[] = [];
let outbound: string[] = [];
let privateKeyPem = "";
const savedEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
let fetchSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

beforeAll(() => {
  privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      recorded.push({
        method: req.method,
        path: url.pathname,
        authorization: req.headers.get("authorization"),
      });
      if (url.pathname.endsWith("/access_tokens")) {
        return Response.json(
          { token: INSTALLATION_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
          { status: 201 },
        );
      }
      if (url.pathname === "/api/graphql") return Response.json({ data: { addReaction: {} } });
      return Response.json({ id: 1 }, { status: 201 });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

function enableApp(): void {
  process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
  process.env.GITHUB_APP_ID = "424242";
  process.env.GITHUB_APP_PRIVATE_KEY = privateKeyPem;
  resetGitHub();
  expect(initGitHub()).toBe(true);
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  recorded = [];
  outbound = [];
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  fetchSpy?.mockRestore();
  logSpy.mockRestore();
  errorSpy.mockRestore();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetGitHub();
});

describe("GHES mode (GITHUB_URL set)", () => {
  beforeEach(() => {
    process.env.GITHUB_URL = `http://127.0.0.1:${server.port}`;
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input instanceof Request ? input.url : input);
      outbound.push(url);
      if (new URL(url).hostname !== "127.0.0.1") {
        throw new Error(`GHES test: request left the mock host: ${url}`);
      }
      return realFetch(input, init);
    }) as typeof fetch);
    enableApp();
  });

  test("App installation token is minted on /api/v3", async () => {
    expect(await getInstallationToken(7)).toBe(INSTALLATION_TOKEN);
    expect(recorded).toEqual([
      {
        method: "POST",
        path: "/api/v3/app/installations/7/access_tokens",
        authorization: expect.stringMatching(/^Bearer ey/),
      },
    ]);
  });

  test("REST reaction, GraphQL reaction and comment all hit the GHES host", async () => {
    expect(await addIssueReaction("o/r", 5, "eyes", 7)).toBe(true);
    expect(await addGraphQLReaction("NODE_1", "EYES", 7)).toBe(true);
    expect(await postComment("o/r", 5, "hi", 7)).toBe(true);

    expect(recorded.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /api/v3/app/installations/7/access_tokens",
      "POST /api/v3/repos/o/r/issues/5/reactions",
      "POST /api/graphql",
      "POST /api/v3/repos/o/r/issues/5/comments",
    ]);
    // Every call after the mint carries the installation token, to the mock only.
    for (const r of recorded.slice(1)) expect(r.authorization).toBe(`Bearer ${INSTALLATION_TOKEN}`);
    expect(outbound.every((u) => !u.includes("github.com"))).toBe(true);
  });

  test("GITHUB_API_URL overrides the REST base and its GraphQL sibling", async () => {
    process.env.GITHUB_API_URL = `http://127.0.0.1:${server.port}/custom/api/v3`;
    expect(await addIssueReaction("o/r", 5, "eyes", 7)).toBe(true);
    expect(await addGraphQLReaction("NODE_1", "EYES", 7)).toBe(true);
    expect(recorded.map((r) => r.path)).toEqual([
      "/custom/api/v3/app/installations/7/access_tokens",
      "/custom/api/v3/repos/o/r/issues/5/reactions",
      "/custom/api/graphql",
    ]);
  });

  test("an invalid GITHUB_URL disables the integration instead of falling back", () => {
    process.env.GITHUB_URL = "ftp://ghe.test";
    resetGitHub();
    expect(initGitHub()).toBe(false);
  });
});

describe("default mode (GITHUB_URL unset)", () => {
  test("request URLs are today's github.com literals", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      outbound.push(url);
      if (url.endsWith("/access_tokens")) {
        return Response.json(
          { token: INSTALLATION_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
          { status: 201 },
        );
      }
      return Response.json({ data: {} }, { status: 201 });
    }) as typeof fetch);
    enableApp();

    await addIssueReaction("o/r", 5, "eyes", 7);
    await addGraphQLReaction("NODE_1", "EYES", 7);
    await postComment("o/r", 5, "hi", 7);
    expect(outbound).toEqual([
      "https://api.github.com/app/installations/7/access_tokens",
      "https://api.github.com/repos/o/r/issues/5/reactions",
      "https://api.github.com/graphql",
      "https://api.github.com/repos/o/r/issues/5/comments",
    ]);
  });
});
