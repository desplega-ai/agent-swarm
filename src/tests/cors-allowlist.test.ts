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
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, initDb } from "../be/db";
import { handlePages } from "../http/pages";
import { handlePagesPublic } from "../http/pages-public";
import {
  isOriginAllowedForCredentials,
  setCorsHeaders,
  warnIfCorsAllowsAnyOrigin,
} from "../http/utils";
import { listenOnFreePort } from "./test-net";

const ENV_KEY = "CORS_ALLOWED_ORIGINS";
const originalEnv = process.env[ENV_KEY];
const originalOptOut = process.env.CORS_ALLOW_ANY_ORIGIN;
beforeEach(() => {
  delete process.env.CORS_ALLOW_ANY_ORIGIN;
});

afterEach(() => {
  if (originalOptOut === undefined) delete process.env.CORS_ALLOW_ANY_ORIGIN;
  else process.env.CORS_ALLOW_ANY_ORIGIN = originalOptOut;
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
});

function fakeReq(origin: string | undefined): IncomingMessage {
  return { headers: origin ? { origin } : {} } as unknown as IncomingMessage;
}

function fakeRes(): { res: ServerResponse; headers: Map<string, string> } {
  const headers = new Map<string, string>();
  const res = {
    setHeader: (name: string, value: string) => {
      headers.set(name.toLowerCase(), value);
    },
  } as unknown as ServerResponse;
  return { res, headers };
}

describe("isOriginAllowedForCredentials", () => {
  test("denies arbitrary origins when CORS_ALLOWED_ORIGINS is unset", () => {
    delete process.env[ENV_KEY];
    expect(isOriginAllowedForCredentials("https://evil.example")).toBe(false);
  });

  test("denies arbitrary origins when CORS_ALLOWED_ORIGINS is blank", () => {
    process.env[ENV_KEY] = "  ";
    expect(isOriginAllowedForCredentials("https://evil.example")).toBe(false);
  });

  test("allows only listed origins when set", () => {
    process.env[ENV_KEY] = "https://app.example.com, https://dashboard.example.com";
    expect(isOriginAllowedForCredentials("https://app.example.com")).toBe(true);
    expect(isOriginAllowedForCredentials("https://dashboard.example.com")).toBe(true);
    expect(isOriginAllowedForCredentials("https://evil.example")).toBe(false);
  });

  test.each([
    ["matches a subdomain", "https://app.agent-swarm.dev", true],
    ["matches multiple subdomain labels", "https://a.b.agent-swarm.dev", true],
    ["rejects suffix confusion", "https://evil-agent-swarm.dev", false],
    ["rejects trailing-domain attacks", "https://app.agent-swarm.dev.evil.com", false],
    ["rejects scheme mismatch", "http://app.agent-swarm.dev", false],
    ["compares scheme exactly", "HTTPS://app.agent-swarm.dev", false],
    ["rejects the apex", "https://agent-swarm.dev", false],
    ["compares host case-insensitively", "https://APP.AGENT-SWARM.DEV", true],
    ["rejects an unlisted port", "https://app.agent-swarm.dev:8443", false],
    ["rejects empty labels", "https://.agent-swarm.dev", false],
    ["rejects credentials", "https://evil.com@app.agent-swarm.dev", false],
    ["rejects paths", "https://app.agent-swarm.dev/evil", false],
  ])("wildcard %s", (_name, origin, allowed) => {
    process.env[ENV_KEY] = "https://*.agent-swarm.dev";
    expect(isOriginAllowedForCredentials(origin)).toBe(allowed);
  });

  test.each([
    "*",
    "https://*",
    "https://*.*.agent-swarm.dev",
    "https://app*.agent-swarm.dev",
  ])("ignores invalid wildcard entry %s", (entry) => {
    process.env[ENV_KEY] = entry;
    expect(isOriginAllowedForCredentials("https://app.agent-swarm.dev")).toBe(false);
    expect(isOriginAllowedForCredentials(entry)).toBe(false);
  });

  test("wildcard supports uppercase suffixes and requires the configured port", () => {
    process.env[ENV_KEY] = "https://*.AGENT-SWARM.DEV:8443";
    expect(isOriginAllowedForCredentials("https://app.agent-swarm.dev:8443")).toBe(true);
    expect(isOriginAllowedForCredentials("https://app.agent-swarm.dev")).toBe(false);
    expect(isOriginAllowedForCredentials("https://app.agent-swarm.dev:443")).toBe(false);
  });

  test("mixes wildcard and exact entries including a separately listed apex", () => {
    process.env[ENV_KEY] =
      "https://*.agent-swarm.dev,https://agent-swarm.dev,http://localhost:5274";
    expect(isOriginAllowedForCredentials("https://app.agent-swarm.dev")).toBe(true);
    expect(isOriginAllowedForCredentials("https://agent-swarm.dev")).toBe(true);
    expect(isOriginAllowedForCredentials("http://localhost:5274")).toBe(true);
    expect(isOriginAllowedForCredentials("http://localhost:5275")).toBe(false);
  });

  test("is an exact match, not a suffix/subdomain match", () => {
    process.env[ENV_KEY] = "https://app.example.com";
    expect(isOriginAllowedForCredentials("https://evil.app.example.com")).toBe(false);
    expect(isOriginAllowedForCredentials("https://app.example.com.evil.example")).toBe(false);
  });
});

describe("setCorsHeaders", () => {
  test("opt-out restores reflected credentials even with a custom allowlist", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    process.env.CORS_ALLOW_ANY_ORIGIN = "true";
    process.env[ENV_KEY] = "https://trusted.example";
    warnIfCorsAllowsAnyOrigin();
    warnIfCorsAllowsAnyOrigin();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("CORS_ALLOW_ANY_ORIGIN=true");
    warn.mockRestore();
    const { res, headers } = fakeRes();
    setCorsHeaders(fakeReq("https://evil.example"), res);
    expect(headers.get("access-control-allow-origin")).toBe("https://evil.example");
    expect(headers.get("access-control-allow-credentials")).toBe("true");
  });

  test("denies a non-allowlisted origin: no Allow-Origin, no Allow-Credentials", () => {
    process.env[ENV_KEY] = "https://app.example.com";
    const { res, headers } = fakeRes();
    setCorsHeaders(fakeReq("https://evil.example"), res);
    expect(headers.has("access-control-allow-origin")).toBe(false);
    expect(headers.has("access-control-allow-credentials")).toBe(false);
    // Vary: Origin still set so caches don't serve a denied response to an allowed origin.
    expect(headers.get("vary")).toBe("Origin");
  });

  test("allows a listed origin with credentials", () => {
    process.env[ENV_KEY] = "https://app.example.com";
    const { res, headers } = fakeRes();
    setCorsHeaders(fakeReq("https://app.example.com"), res);
    expect(headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(headers.get("access-control-allow-credentials")).toBe("true");
  });

  test("no-Origin requests still get wildcard regardless of allowlist", () => {
    process.env[ENV_KEY] = "https://app.example.com";
    const { res, headers } = fakeRes();
    setCorsHeaders(fakeReq(undefined), res);
    expect(headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("secure defaults and reload", () => {
  test.each([undefined, "", "  "])("uses defaults for %j", (raw) => {
    if (raw === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = raw;
    for (const origin of [
      "https://app.agent-swarm.dev",
      "https://a.b.agent-swarm.cloud",
      "http://localhost:5274",
      "http://127.0.0.1:5274",
      "http://[::1]:5274",
      "https://ui.swarm.localhost:1355",
    ]) {
      expect(isOriginAllowedForCredentials(origin)).toBe(true);
    }
    for (const origin of [
      "https://evil.example",
      "null",
      "https://agent-swarm.dev",
      "http://localhost:9999",
    ]) {
      const { res, headers } = fakeRes();
      setCorsHeaders(fakeReq(origin), res);
      expect(headers.has("access-control-allow-origin")).toBe(false);
      expect(headers.has("access-control-allow-credentials")).toBe(false);
      expect(headers.get("vary")).toBe("Origin");
    }
  });
  test("custom lists replace defaults and opt-out changes are read dynamically", () => {
    process.env[ENV_KEY] = "https://trusted.example";
    expect(isOriginAllowedForCredentials("https://app.agent-swarm.dev")).toBe(false);
    for (const value of ["true", "1", " TRUE "]) {
      process.env.CORS_ALLOW_ANY_ORIGIN = value;
      expect(isOriginAllowedForCredentials("https://evil.example")).toBe(true);
    }
    for (const value of ["false", "0", "", "typo"]) {
      process.env.CORS_ALLOW_ANY_ORIGIN = value;
      expect(isOriginAllowedForCredentials("https://evil.example")).toBe(false);
    }
    process.env[ENV_KEY] = "https://evil.example";
    expect(isOriginAllowedForCredentials("https://evil.example")).toBe(true);
  });
});

describe("page-session CORS over HTTP", () => {
  const dir = mkdtempSync(join(tmpdir(), "cors-pages-"));
  const server = createServer(async (req, res) => {
    setCorsHeaders(req, res);
    const url = new URL(req.url!, "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);
    if (
      await handlePages(
        req,
        res,
        segments,
        url.searchParams,
        "38d36438-58a0-45b5-8602-a5d52b07c2f1",
      )
    )
      return;
    if (await handlePagesPublic(req, res, segments, url.searchParams)) return;
    res.writeHead(404).end();
  });
  let base: string;
  let pageId: string;
  beforeAll(async () => {
    initDb(join(dir, "test.sqlite"));
    base = `http://localhost:${await listenOnFreePort(server)}`;
    const response = await fetch(`${base}/api/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "cors-session",
        title: "CORS",
        contentType: "text/html",
        authMode: "authed",
        body: "<h1>Private</h1>",
      }),
    });
    expect(response.status).toBe(201);
    pageId = ((await response.json()) as { id: string }).id;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });
  test.each([
    undefined,
    "",
    "  ",
  ])("launch preflight, session cookie and page JSON use defaults for %j", async (raw) => {
    if (raw === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = raw;
    for (const origin of ["https://app.agent-swarm.dev", "https://evil.example"]) {
      const allowed = origin.includes("agent-swarm.dev");
      for (const method of ["OPTIONS", "POST"]) {
        const response = await fetch(`${base}/api/pages/${pageId}/launch`, {
          method,
          headers: { Origin: origin },
        });
        expect(response.status).toBe(204);
        expect(response.headers.get("access-control-allow-origin")).toBe(allowed ? origin : null);
        expect(response.headers.get("access-control-allow-credentials")).toBe(
          allowed ? "true" : null,
        );
        if (method === "POST") {
          const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
          const page = await fetch(`${base}/p/${pageId}.json`, {
            headers: { Origin: origin, Cookie: cookie },
          });
          expect(page.status).toBe(200);
          expect(page.headers.get("access-control-allow-origin")).toBe(allowed ? origin : null);
          expect(page.headers.get("access-control-allow-credentials")).toBe(
            allowed ? "true" : null,
          );
          await page.text();
        }
      }
    }
  });
});
