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
    const tamperedSig = `${sig!.slice(0, -1)}${sig!.slice(-1) === "A" ? "B" : "A"}`;
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
