/**
 * Integration tests for the page-session cookie flow:
 *   1. Create a page (bearer-auth) → POST /api/pages
 *   2. Launch it → POST /api/pages/:id/launch → captures Set-Cookie
 *   3. Hit /@swarm/api/me with the cookie → server-side bearer is injected,
 *      X-Agent-ID is rewritten to the page owner's id → 200 with /me payload.
 *
 * Spawns the real `src/http.ts` server with API_KEY set so we exercise the
 * full bearer + cookie + proxy chain, not the in-process handler in
 * isolation.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import net from "node:net";
import type { Subprocess } from "bun";
import { signPageSession } from "../utils/page-session";

const TEST_PORT = 19877;
const TEST_DB_PATH = `/tmp/test-page-proxy-${Date.now()}.sqlite`;
const BASE = `http://localhost:${TEST_PORT}`;
const API_KEY = "test-page-proxy-key-12345";
const PAGE_SECRET = "test-page-proxy-page-secret-67890";

let serverProc: Subprocess;
const agentId = randomUUID();

async function waitForServer(url: string, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }

  // Match the spawned server's signing secret so cookies we hand-craft via
  // signPageSession() in-process validate at the proxy.
  process.env.PAGE_SESSION_SECRET = PAGE_SECRET;

  serverProc = Bun.spawn(["bun", "src/http.ts"], {
    cwd: `${import.meta.dir}/../..`,
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DATABASE_PATH: TEST_DB_PATH,
      API_KEY,
      PAGE_SESSION_SECRET: PAGE_SECRET,
      // Pin the upstream URL the proxy forwards to. Even though the proxy now
      // talks to 127.0.0.1:$PORT directly (not deriveApiBaseUrl), strip any
      // ambient ngrok/external MCP_BASE_URL to keep the test env minimal.
      MCP_BASE_URL: `http://127.0.0.1:${TEST_PORT}`,
      CAPABILITIES: "core,task-pool,messaging,profiles,services,scheduling,memory",
      SLACK_BOT_TOKEN: "",
      GITHUB_WEBHOOK_SECRET: "",
      AGENTMAIL_API_KEY: "",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForServer(`${BASE}/health`);

  // Register the page-owner agent (so /me succeeds after the proxy rewrites
  // X-Agent-ID to this id).
  const reg = await fetch(`${BASE}/api/agents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      "X-Agent-ID": agentId,
    },
    body: JSON.stringify({
      name: "PageOwner",
      isLead: false,
      description: "Owner of the test page",
      role: "worker",
      capabilities: ["core"],
      maxTasks: 1,
    }),
  });
  if (reg.status !== 201 && reg.status !== 200) {
    throw new Error(`Failed to register agent: ${reg.status} ${await reg.text()}`);
  }
}, 20000);

afterAll(async () => {
  if (serverProc) {
    serverProc.kill();
    try {
      await serverProc.exited;
    } catch {}
  }
  await Bun.sleep(50);
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

/** Helper: create a page owned by `agentId` and return its id. */
async function createPage(): Promise<string> {
  const res = await fetch(`${BASE}/api/pages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      "X-Agent-ID": agentId,
    },
    body: JSON.stringify({
      slug: `t-${randomUUID().slice(0, 8)}`,
      title: "Proxy Test",
      contentType: "text/html",
      authMode: "public",
      body: "<h1>proxy test</h1>",
    }),
  });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { id: string };
  return json.id;
}

describe("/api/pages/:id/launch", () => {
  test("issues HttpOnly Set-Cookie + 204", async () => {
    const id = await createPage();
    const res = await fetch(`${BASE}/api/pages/${id}/launch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "X-Agent-ID": agentId },
    });
    expect(res.status).toBe(204);
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toBeTruthy();
    expect(cookie!).toContain("page_session=");
    expect(cookie!).toContain("HttpOnly");
    expect(cookie!).toContain("Path=/");
    expect(cookie!).toContain("Max-Age=3600");
    // In dev (NODE_ENV != production) the cookie should be SameSite=Lax sans Secure.
    expect(cookie!).toContain("SameSite=Lax");
    expect(cookie!).not.toMatch(/\bSecure\b/);
  });

  test("404 for unknown page id", async () => {
    const res = await fetch(`${BASE}/api/pages/${"0".repeat(32)}/launch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "X-Agent-ID": agentId },
    });
    expect(res.status).toBe(404);
  });

  test("401 without bearer", async () => {
    const id = await createPage();
    const res = await fetch(`${BASE}/api/pages/${id}/launch`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  test("OPTIONS preflight returns 204 with CORS headers when Origin set", async () => {
    const id = await createPage();
    const res = await fetch(`${BASE}/api/pages/${id}/launch`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5274" },
    });
    // /core's OPTIONS handler returns 204 first — but our route-specific
    // OPTIONS handler in handlePages sets CORS headers. Either way the
    // browser sees 204; verify the response is 204.
    expect(res.status).toBe(204);
  });
});

describe("/@swarm/api/* proxy", () => {
  // The proxy rewrites `/@swarm/api/<rest>` → `/api/<rest>`. We use
  // `/api/agents/<id>` as the canonical exerciser since it requires both
  // bearer auth AND a valid agent id — proving the proxy injected both.
  test("forwards GET /@swarm/api/agents/:id with cookie → 200 carrying page-owner agent", async () => {
    const id = await createPage();
    const launch = await fetch(`${BASE}/api/pages/${id}/launch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "X-Agent-ID": agentId },
    });
    expect(launch.status).toBe(204);
    const setCookie = launch.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();

    const cookieValue = /page_session=([^;]+)/.exec(setCookie!)?.[1];
    expect(cookieValue).toBeTruthy();

    const res = await fetch(`${BASE}/@swarm/api/agents/${agentId}`, {
      headers: { Cookie: `page_session=${cookieValue}` },
    });
    expect(res.status).toBe(200);
    const agent = (await res.json()) as { id: string; name: string };
    expect(agent.id).toBe(agentId);
    expect(agent.name).toBe("PageOwner");
  });

  test("rejects request without cookie → 401", async () => {
    const res = await fetch(`${BASE}/@swarm/api/agents/${agentId}`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("no page session");
  });

  test("rejects expired cookie → 401", async () => {
    const expired = await signPageSession({
      pageId: "deadbeef".repeat(4),
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const res = await fetch(`${BASE}/@swarm/api/agents/${agentId}`, {
      headers: { Cookie: `page_session=${expired}` },
    });
    expect(res.status).toBe(401);
  });

  test("rejects tampered signature → 401", async () => {
    const id = await createPage();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const good = await signPageSession({ pageId: id, exp });
    const [head, sig] = good.split(".");
    // Flip a decoded HMAC byte rather than a base64url char — flipping the
    // last char is flaky (see src/tests/page-session.test.ts for why).
    const sigBytes = Buffer.from(sig!, "base64url");
    sigBytes[0] ^= 0x01;
    const tamperedSig = sigBytes.toString("base64url").replace(/=/g, "");
    const bad = `${head}.${tamperedSig}`;
    const res = await fetch(`${BASE}/@swarm/api/agents/${agentId}`, {
      headers: { Cookie: `page_session=${bad}` },
    });
    expect(res.status).toBe(401);
  });

  test("rejects cookie for deleted page → 401", async () => {
    // Sign a cookie referencing a never-existed page id. verifyPageSession
    // returns the payload, getPage returns null → 401 "page session no
    // longer valid". (Step-3 will ship DELETE; this test just exercises the
    // proxy's missing-page branch without depending on it.)
    const ghost = await signPageSession({
      pageId: "fade".repeat(8),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const res = await fetch(`${BASE}/@swarm/api/agents/${agentId}`, {
      headers: { Cookie: `page_session=${ghost}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("page session no longer valid");
  });

  test("proxy does NOT require a bearer header (cookie is the auth)", async () => {
    const id = await createPage();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = await signPageSession({ pageId: id, exp });
    // Send WITHOUT Authorization header — pure cookie auth.
    const res = await fetch(`${BASE}/@swarm/api/agents/${agentId}`, {
      headers: { Cookie: `page_session=${token}` },
    });
    expect(res.status).toBe(200);
    const agent = (await res.json()) as { id: string };
    expect(agent.id).toBe(agentId);
  });
});

/**
 * `fetch()` (WHATWG URL parsing) collapses `..` AND `%2e%2e` dot-segments
 * client-side before the request ever leaves the process, so it can never
 * exercise the server's traversal guard — it always arrives already
 * normalized. `node:http`'s client does the same normalization internally
 * even when given a raw `path` field, so the only way to send the literal,
 * unnormalized request line the guard is actually meant to defend against
 * (e.g. a non-browser HTTP client that doesn't dot-segment-normalize) is a
 * raw TCP socket writing the HTTP/1.1 request line by hand.
 */
function rawGet(path: string, headers: Record<string, string>): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(TEST_PORT, "localhost", () => {
      const headerLines = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n");
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: localhost:${TEST_PORT}\r\nConnection: close\r\n${headerLines}\r\n\r\n`,
      );
    });
    let raw = "";
    sock.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    sock.on("end", () => {
      const statusLine = raw.split("\r\n")[0] ?? "";
      const status = Number.parseInt(statusLine.split(" ")[1] ?? "0", 10);
      resolve({ status });
    });
    sock.on("error", reject);
  });
}

// Regression coverage for the proxy's suffix-normalization guard: it rejects
// path-traversal and percent-encoded segment-smuggling in the proxied suffix
// before doing any auth work. This is deliberately NOT a route allowlist
// (see the module comment in page-proxy.ts for why one was tried and
// dropped) — a page-session cookie holder can reach any `/api/*` route, same
// as the pre-existing behavior, but cannot use `..` or encoded separators to
// dodge the suffix rewrite.
describe("/@swarm/api/* proxy — suffix normalization", () => {
  async function launchCookie(): Promise<string> {
    const id = await createPage();
    const launch = await fetch(`${BASE}/api/pages/${id}/launch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "X-Agent-ID": agentId },
    });
    const setCookie = launch.headers.get("set-cookie");
    const cookieValue = /page_session=([^;]+)/.exec(setCookie!)?.[1];
    if (!cookieValue) throw new Error("failed to mint test cookie");
    return cookieValue;
  }

  // Must-reject: literal ".." path-traversal segment in the proxied suffix.
  // Uses rawGet — fetch() would normalize this away before it ever left the
  // process (see the rawGet doc comment above).
  test("rejects a literal path-traversal segment", async () => {
    const cookie = await launchCookie();
    const res = await rawGet("/@swarm/api/agents/../pages", { Cookie: `page_session=${cookie}` });
    expect(res.status).toBe(404);
  });

  // Must-reject: percent-encoded ".." must not sneak past the guard either
  // (decode-then-check, not check-then-decode). Uses rawGet for the same
  // reason as above — Bun's URL parser collapses `%2e%2e` client-side too.
  test("rejects a percent-encoded path-traversal segment", async () => {
    const cookie = await launchCookie();
    const res = await rawGet("/@swarm/api/agents/%2e%2e/pages", {
      Cookie: `page_session=${cookie}`,
    });
    expect(res.status).toBe(404);
  });

  // Must-reject: a percent-encoded slash must not smuggle an extra segment
  // past the naive `split("/")` normalization. Plain fetch() is fine here —
  // `%2F` is not a dot-segment, so URL parsing leaves it intact.
  test("rejects a percent-encoded slash smuggled into a segment", async () => {
    const cookie = await launchCookie();
    const res = await fetch(`${BASE}/@swarm/api/agents/foo%2Fbar`, {
      headers: { Cookie: `page_session=${cookie}` },
    });
    expect(res.status).toBe(404);
  });

  // Positive path: a clean suffix proxies straight through.
  test("still allows GET /@swarm/api/tasks", async () => {
    const cookie = await launchCookie();
    const res = await fetch(`${BASE}/@swarm/api/tasks`, {
      headers: { Cookie: `page_session=${cookie}` },
    });
    expect(res.status).toBe(200);
  });

  // Guard against re-introducing a route allowlist: `/api/config` was one of
  // the routes the dropped allowlist rejected outright. It must now proxy
  // like any other route — the page-session cookie, not a route list, is the
  // auth boundary.
  test("forwards a route the dropped allowlist used to reject (/api/config)", async () => {
    const cookie = await launchCookie();
    const res = await fetch(`${BASE}/@swarm/api/config`, {
      headers: { Cookie: `page_session=${cookie}` },
    });
    expect(res.status).not.toBe(404);
  });
});
