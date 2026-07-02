/**
 * Extends the step-2 `page-proxy.test.ts` coverage to authed-mode pages.
 *
 * The proxy's auth model is "cookie is the auth" — it does NOT care whether
 * the underlying page is `public`, `authed`, or `password`. This test simply
 * confirms that an `auth_mode='authed'` page survives the same cookie flow:
 * launch → cookie → /@swarm/api/agents/:id → 200 with the page owner's
 * agent record.
 *
 * Spawns the real `src/http.ts` server (mirrors step-2's pattern) so we
 * exercise the bearer gate + cookie + proxy in the same shape production
 * runs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { Subprocess } from "bun";

const TEST_PORT = 19881;
const TEST_DB_PATH = `/tmp/test-page-proxy-authed-${Date.now()}.sqlite`;
const BASE = `http://localhost:${TEST_PORT}`;
const API_KEY = "test-page-proxy-authed-key";
const PAGE_SECRET = "test-page-proxy-authed-secret";

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

  process.env.PAGE_SESSION_SECRET = PAGE_SECRET;

  serverProc = Bun.spawn(["bun", "apps/swarm/src/http.ts"], {
    cwd: `${import.meta.dir}/../../../..`,
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DATABASE_PATH: TEST_DB_PATH,
      API_KEY,
      PAGE_SESSION_SECRET: PAGE_SECRET,
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

  const reg = await fetch(`${BASE}/api/agents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      "X-Agent-ID": agentId,
    },
    body: JSON.stringify({
      name: "AuthedPageOwner",
      isLead: false,
      description: "Owner of the authed test page",
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

describe("/@swarm/api/* proxy — authed-mode page", () => {
  test("authed page: launch → cookie → proxy /agents/:id resolves to page owner", async () => {
    // Create an authed HTML page owned by `agentId`.
    const createRes = await fetch(`${BASE}/api/pages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
        "X-Agent-ID": agentId,
      },
      body: JSON.stringify({
        slug: `authed-${randomUUID().slice(0, 8)}`,
        title: "Authed Proxy Test",
        contentType: "text/html",
        authMode: "authed",
        body: "<h1>authed</h1>",
      }),
    });
    expect(createRes.status).toBe(201);
    const { id } = (await createRes.json()) as { id: string };

    // Launch.
    const launch = await fetch(`${BASE}/api/pages/${id}/launch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "X-Agent-ID": agentId },
    });
    expect(launch.status).toBe(204);
    const setCookie = launch.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    const cookieValue = /page_session=([^;]+)/.exec(setCookie!)?.[1];
    expect(cookieValue).toBeTruthy();

    // Drive the proxy with the cookie — should resolve to the page owner's
    // /agents/:id record (not a 401, not a different identity).
    const res = await fetch(`${BASE}/@swarm/api/agents/${agentId}`, {
      headers: { Cookie: `page_session=${cookieValue}` },
    });
    expect(res.status).toBe(200);
    const agent = (await res.json()) as { id: string; name: string };
    expect(agent.id).toBe(agentId);
    expect(agent.name).toBe("AuthedPageOwner");
  });
});
