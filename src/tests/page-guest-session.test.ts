/**
 * A page session with no signed-in user and no operator launch is a guest. A guest
 * reaches only its own page record and its own KV through the proxy, and every
 * server-side gate denies it.
 * A user session and an operator-launched session keep working.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { type IncomingMessage, ServerResponse } from "node:http";
import type { Subprocess } from "bun";
import { getOperatorActor } from "../http/operator-actor";
import { isGuestAllowedProxyPath } from "../http/page-proxy";
import { agentFirstPrincipal, requestPrincipal } from "../http/request-principal";
import { can } from "../rbac";
import { signPageSession } from "../utils/page-session";
import { setRequestAuth } from "../utils/request-auth-context";
import { getFreePort, SERVER_BOOT_HOOK_TIMEOUT_MS, waitForServer } from "./test-net";

let BASE = "";
const TEST_DB_PATH = `/tmp/test-page-guest-${Date.now()}.sqlite`;
const API_KEY = "example-test-page-guest-key-12345";
const PAGE_SECRET = "example-test-page-guest-secret-67890";
let serverProc: Subprocess;
const agentId = randomUUID();

const exp = () => Math.floor(Date.now() / 1000) + 3600;

async function api(path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

async function createPage(): Promise<string> {
  const res = await api("/api/pages", {
    method: "POST",
    headers: { "X-Agent-ID": agentId },
    body: JSON.stringify({
      slug: `g-${randomUUID().slice(0, 8)}`,
      title: "Guest Test",
      contentType: "text/html",
      authMode: "public",
      body: "<h1>guest</h1>",
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Call the API the way the page proxy does: shared key plus the signed page session. */
function asSession(cookie: string, pageId: string, path: string, init: RequestInit = {}) {
  return api(path, {
    ...init,
    headers: { "X-Page-Session": cookie, "X-Page-Id": pageId },
  });
}

let pageId = "";
let guestCookie = "";
let operatorCookie = "";
let userCookie = "";

beforeAll(async () => {
  const port = await getFreePort();
  BASE = `http://localhost:${port}`;
  process.env.PAGE_SESSION_SECRET = PAGE_SECRET;
  serverProc = Bun.spawn(["bun", "src/http.ts"], {
    cwd: `${import.meta.dir}/../..`,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: TEST_DB_PATH,
      API_KEY,
      AGENT_SWARM_API_KEY: API_KEY,
      PAGE_SESSION_SECRET: PAGE_SECRET,
      MCP_BASE_URL: `http://127.0.0.1:${port}`,
      CAPABILITIES: "core,task-pool,messaging,profiles,services,scheduling,memory",
      EMBEDDING_API_KEY: "",
      OPENAI_API_KEY: "",
      SLACK_BOT_TOKEN: "",
      GITHUB_WEBHOOK_SECRET: "",
      AGENTMAIL_API_KEY: "",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForServer(`${BASE}/health`);
  await api("/api/agents", {
    method: "POST",
    headers: { "X-Agent-ID": agentId },
    body: JSON.stringify({
      name: "Owner",
      isLead: false,
      role: "worker",
      capabilities: ["core"],
      maxTasks: 1,
    }),
  });
  pageId = await createPage();

  const created = await api("/api/users", {
    method: "POST",
    body: JSON.stringify({ name: "Viewer" }),
  });
  const userId = ((await created.json()) as { user: { id: string } }).user.id;
  userCookie = await signPageSession({ pageId, exp: exp(), uid: userId, name: "Viewer" });
  guestCookie = await signPageSession({ pageId, exp: exp() });
  operatorCookie = await signPageSession({ pageId, exp: exp(), name: "guest-op", op: true });

  await api("/api/config", {
    method: "PUT",
    body: JSON.stringify({
      scope: "global",
      key: "GUEST_PROBE_SECRET",
      value: "s3cret-value",
      isSecret: true,
    }),
  });
}, SERVER_BOOT_HOOK_TIMEOUT_MS);

afterAll(async () => {
  serverProc?.kill();
  await serverProc?.exited.catch(() => {});
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
});

describe("proxy allowlist for a guest session", () => {
  test("allows the page's own record and its KV", async () => {
    const own = await fetch(`${BASE}/@swarm/api/pages/${pageId}`, {
      headers: { Cookie: `page_session=${guestCookie}` },
    });
    expect(own.status).toBe(200);
    const put = await fetch(`${BASE}/@swarm/api/kv/probe`, {
      method: "PUT",
      headers: { Cookie: `page_session=${guestCookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ value: "v" }),
    });
    expect(put.status).toBe(200);
    const get = await fetch(`${BASE}/@swarm/api/kv/probe`, {
      headers: { Cookie: `page_session=${guestCookie}` },
    });
    expect(get.status).toBe(200);
  });

  for (const [method, path] of [
    ["GET", "config?includeSecrets=true"],
    ["GET", "tasks"],
    ["GET", `agents/${agentId}`],
    ["GET", "whoami"],
    ["POST", "memory/search"],
    ["GET", "pages/not-this-page"],
    ["GET", "pages"],
    ["DELETE", "pages/not-this-page"],
  ] as const) {
    test(`refuses ${method} ${path} with 403`, async () => {
      const res = await fetch(`${BASE}/@swarm/api/${path}`, {
        method,
        headers: { Cookie: `page_session=${guestCookie}`, "Content-Type": "application/json" },
        body: method === "POST" ? "{}" : undefined,
      });
      expect(res.status).toBe(403);
    });
  }

  test("allowlist helper", () => {
    expect(isGuestAllowedProxyPath("GET", `pages/${pageId}`, pageId)).toBe(true);
    expect(isGuestAllowedProxyPath("GET", "kv/a/incr", pageId)).toBe(true);
    expect(isGuestAllowedProxyPath("PUT", `pages/${pageId}`, pageId)).toBe(false);
    expect(isGuestAllowedProxyPath("GET", `pages/${pageId}/versions`, pageId)).toBe(false);
    expect(isGuestAllowedProxyPath("GET", "kvx", pageId)).toBe(false);
  });
});

describe("a password-page guest is isolated from another page", () => {
  test("cannot read page B's record or KV, and gets its own KV without passwordHash", async () => {
    const created = await api("/api/pages", {
      method: "POST",
      headers: { "X-Agent-ID": agentId },
      body: JSON.stringify({
        slug: `pw-${randomUUID().slice(0, 8)}`,
        title: "Password Page",
        contentType: "text/html",
        authMode: "password",
        password: "open-sesame",
        body: "<h1>a</h1>",
      }),
    });
    expect(created.status).toBe(201);
    const pageA = ((await created.json()) as { id: string }).id;
    const pageB = await createPage();
    const nsB = `task:page:${pageB}`;

    const seedB = await api("/api/kv/shared", {
      method: "PUT",
      headers: { "X-Page-Id": pageB },
      body: JSON.stringify({ value: "b-value" }),
    });
    expect(seedB.status).toBe(200);

    const unlock = await fetch(`${BASE}/p/${pageA}?key=open-sesame`);
    expect(unlock.status).toBe(200);
    const cookieA = /page_session=([^;]+)/.exec(unlock.headers.get("set-cookie") ?? "")?.[1];
    expect(cookieA).toBeTruthy();
    const asGuest = (path: string, init: RequestInit = {}) =>
      fetch(`${BASE}/@swarm/api/${path}`, {
        ...init,
        headers: {
          Cookie: `page_session=${cookieA}`,
          "Content-Type": "application/json",
          "X-Page-Id": pageB,
          "X-Agent-ID": agentId,
        },
      });

    const putA = await asGuest("kv/shared", {
      method: "PUT",
      body: JSON.stringify({ value: "a-value" }),
    });
    expect(putA.status).toBe(200);

    expect((await asGuest(`pages/${pageB}`)).status).toBe(403);

    for (const path of ["kv/shared", `kv/_/${encodeURIComponent(nsB)}/shared`]) {
      const res = await asGuest(path);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        namespace: `task:page:${pageA}`,
        key: "shared",
        value: "a-value",
      });
    }

    const list = await asGuest(`kv/_/${encodeURIComponent(nsB)}`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(await list.json())).not.toContain("b-value");

    const own = await asGuest(`pages/${pageA}`);
    expect(own.status).toBe(200);
    expect(await own.json()).not.toHaveProperty("passwordHash");

    const stillB = await api("/api/kv/shared", { headers: { "X-Page-Id": pageB } });
    expect(await stillB.json()).toMatchObject({ namespace: nsB, value: "b-value" });
  });
});

describe("server-side gates deny a guest and keep the operator and user", () => {
  test("config reads by session kind", async () => {
    const guest = await (
      await asSession(guestCookie, pageId, "/api/config?includeSecrets=true&key=GUEST_PROBE_SECRET")
    ).json();
    expect(JSON.stringify(guest)).not.toContain("s3cret-value");
    const op = await (
      await asSession(
        operatorCookie,
        pageId,
        "/api/config?includeSecrets=true&key=GUEST_PROBE_SECRET",
      )
    ).json();
    expect(JSON.stringify(op)).toContain("s3cret-value");
  });

  test("config resolved: guest masked", async () => {
    const guest = await (
      await asSession(
        guestCookie,
        pageId,
        "/api/config/resolved?includeSecrets=true&key=GUEST_PROBE_SECRET",
      )
    ).json();
    expect(JSON.stringify(guest)).not.toContain("s3cret-value");
  });

  test("config write (ensureConfigAdmin)", async () => {
    const body = JSON.stringify({ scope: "global", key: "GUEST_WRITE", value: "x" });
    expect(
      (await asSession(guestCookie, pageId, "/api/config", { method: "PUT", body })).status,
    ).toBe(403);
    expect(
      (await asSession(operatorCookie, pageId, "/api/config", { method: "PUT", body })).status,
    ).toBe(200);
    expect(
      (await asSession(userCookie, pageId, "/api/config", { method: "PUT", body })).status,
    ).toBe(200);
  });

  test("tasks (resolveTaskWritePrincipal, canSteerTask, canActOnOwnTask)", async () => {
    const id = randomUUID();
    for (const path of [
      `/api/tasks/${id}/cancel`,
      `/api/tasks/${id}/progress`,
      `/api/tasks/${id}/steer`,
      `/api/tasks/${id}/promote-draft`,
    ]) {
      expect(
        (await asSession(guestCookie, pageId, path, { method: "POST", body: "{}" })).status,
      ).toBe(403);
    }
    expect(
      (
        await asSession(operatorCookie, pageId, `/api/tasks/${id}/cancel`, {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await asSession(userCookie, pageId, `/api/tasks/${id}/cancel`, {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(404);
  });

  test("memory (ingestPrincipal)", async () => {
    const body = JSON.stringify({ content: "c", name: "n", scope: "swarm", source: "manual" });
    expect(
      (await asSession(guestCookie, pageId, "/api/memory/index", { method: "POST", body })).status,
    ).toBe(403);
    expect(
      (await asSession(guestCookie, pageId, "/api/memory/list", { method: "POST", body: "{}" }))
        .status,
    ).toBe(403);
    expect(
      (await asSession(operatorCookie, pageId, "/api/memory/index", { method: "POST", body }))
        .status,
    ).not.toBe(403);
  });

  test("admin surfaces: script-connections, mcp-servers, extensions, apps", async () => {
    const probes: [string, string, string][] = [
      ["POST", `/api/script-connections/${randomUUID()}/refresh`, "{}"],
      [
        "POST",
        "/api/mcp-servers",
        JSON.stringify({ name: "m", transport: "http", url: "http://127.0.0.1:1" }),
      ],
      ["POST", `/api/extensions/${randomUUID()}/enable`, "{}"],
      ["POST", "/api/apps", JSON.stringify({ name: "a", definition: {} })],
    ];
    for (const [method, path, body] of probes) {
      const guest = await asSession(guestCookie, pageId, path, { method, body });
      expect([method, path, guest.status]).toEqual([method, path, 403]);
      const op = await asSession(operatorCookie, pageId, path, { method, body });
      expect([method, path, op.status === 403]).toEqual([method, path, false]);
    }
  });

  test("approval cancel (approvalCancelPrincipal)", async () => {
    const created = await api("/api/approval-requests", {
      method: "POST",
      body: JSON.stringify({
        title: "t",
        questions: [{ id: "q", type: "approval", label: "ok" }],
        approvers: { policy: "any" },
      }),
    });
    expect(created.status).toBe(201);
    const { approvalRequest } = (await created.json()) as { approvalRequest: { id: string } };
    const path = `/api/approval-requests/${approvalRequest.id}/cancel`;
    expect(
      (await asSession(guestCookie, pageId, path, { method: "POST", body: "{}" })).status,
    ).toBe(403);
    expect(
      (await asSession(operatorCookie, pageId, path, { method: "POST", body: "{}" })).status,
    ).toBe(200);
  });

  test("a user session through the proxy and an operator-launched session still work", async () => {
    for (const cookie of [userCookie, operatorCookie]) {
      const res = await fetch(`${BASE}/@swarm/api/tasks`, {
        headers: { Cookie: `page_session=${cookie}` },
      });
      expect(res.status).toBe(200);
    }
    const whoami = await fetch(`${BASE}/@swarm/api/whoami`, {
      headers: { Cookie: `page_session=${userCookie}` },
    });
    expect(((await whoami.json()) as { kind: string }).kind).toBe("user");
  });
});

describe("in-process principal helpers", () => {
  const fakeReq = () => ({ headers: {} }) as unknown as IncomingMessage;

  test("requestPrincipal and agentFirstPrincipal map a guest to guest", async () => {
    const req = fakeReq();
    setRequestAuth(req, { kind: "guest" });
    expect(await requestPrincipal(req, undefined)).toEqual({ kind: "guest" });
    expect(await agentFirstPrincipal(req, undefined)).toEqual({ kind: "guest" });
    const op = fakeReq();
    setRequestAuth(op, { kind: "operator", fingerprint: "fp" });
    expect(await requestPrincipal(op, undefined)).toEqual({ kind: "operator" });
    expect(await agentFirstPrincipal(op, undefined)).toEqual({ kind: "operator" });
  });

  test("getOperatorActor refuses a guest", () => {
    const req = fakeReq();
    setRequestAuth(req, { kind: "guest" });
    const res = new ServerResponse(req);
    expect(getOperatorActor(req, res)).toBeNull();
    expect(res.statusCode).toBe(403);
  });

  test("can() denies every verb for a guest and still allows the operator", () => {
    expect(
      can({ principal: { kind: "guest" }, verb: "config.read.secrets", source: "http" }).allow,
    ).toBe(false);
    expect(
      can({ principal: { kind: "guest" }, verb: "memory.read.any", source: "http" }).allow,
    ).toBe(false);
    expect(
      can({ principal: { kind: "operator" }, verb: "memory.read.any", source: "http" }).allow,
    ).toBe(true);
  });
});
