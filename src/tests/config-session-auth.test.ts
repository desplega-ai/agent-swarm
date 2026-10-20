import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { closeDb, createAgent, initDb, upsertSwarmConfig } from "../be/db";
import { mintAgentToken, revokeAgentTokens } from "../be/users";
import { handleConfig } from "../http/config";
import { handleCore } from "../http/core";
import { handleSessions } from "../http/sessions";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const API_KEY = "example-config-session-test-operator";
const SECRET = "example-config-session-test-secret-value";
let server: Server;
let baseUrl: string;
let workerId: string;
let leadId: string;
let configId: string;

function headers(bearer: string, agentId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    ...(agentId ? { "X-Agent-ID": agentId } : {}),
  };
}

async function mint(agentId: string) {
  const res = await fetch(`${baseUrl}/api/sessions/tokens`, {
    method: "POST",
    headers: headers(API_KEY),
    body: JSON.stringify({ agentId, taskId: crypto.randomUUID(), ttlMs: 60_000 }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { tokenId: string; plaintext: string };
}

beforeAll(async () => {
  initDb(":memory:");
  workerId = (await createAgent({ name: "config-worker", isLead: false, status: "idle" })).id;
  leadId = (await createAgent({ name: "config-lead", isLead: true, status: "idle" })).id;
  configId = (
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: workerId,
      key: "ACP_AUTH_TEST_SECRET",
      value: SECRET,
      isSecret: true,
    })
  ).id;
  server = createServer(async (req, res) => {
    if (await handleCore(req, res, req.headers["x-agent-id"] as string | undefined, API_KEY))
      return;
    const segments = getPathSegments(req.url || "");
    const query = parseQueryParams(req.url || "");
    if (await handleSessions(req, res, segments, query)) return;
    if (await handleConfig(req, res, segments, query)) return;
    res.writeHead(404).end();
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

describe("config HTTP session-token authorization", () => {
  for (const route of ["list", "resolved", "by-id"] as const) {
    test(`${route} masks worker task-token secrets, permits lead tokens, and rejects spoofing`, async () => {
      const token = await mint(workerId);
      const lead = await mint(leadId);
      const path =
        route === "by-id"
          ? `/api/config/${configId}`
          : route === "resolved"
            ? "/api/config/resolved"
            : "/api/config";
      const url = `${baseUrl}${path}?includeSecrets=true&agentId=${workerId}`;
      for (const bearer of [API_KEY, lead.plaintext]) {
        const res = await fetch(url, { headers: headers(bearer) });
        expect(res.status).toBe(200);
        expect(await res.text()).toContain(SECRET);
      }
      const responses: string[] = [];
      for (const agentId of [undefined, workerId]) {
        const res = await fetch(url, { headers: headers(token.plaintext, agentId) });
        expect(res.status).toBe(200);
        responses.push(await res.text());
      }
      expect((await fetch(url, { headers: headers(token.plaintext, leadId) })).status).toBe(403);
      const revoked = await fetch(`${baseUrl}/api/sessions/tokens/${token.tokenId}`, {
        method: "DELETE",
        headers: headers(API_KEY),
      });
      expect(revoked.status).toBe(204);
      expect((await fetch(url, { headers: headers(token.plaintext, leadId) })).status).toBe(401);
      for (const body of responses) {
        expect(body).not.toContain(SECRET);
        expect(body).toContain("secret values masked");
      }
    });
  }

  test("ACP resolved config without agentId preserves the global default", async () => {
    await upsertSwarmConfig({ scope: "global", key: "ACP_DEFAULT_SCOPE", value: "global" });
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: workerId,
      key: "ACP_DEFAULT_SCOPE",
      value: "agent",
    });
    const token = await mint(workerId);
    const response = await fetch(`${baseUrl}/api/config/resolved?key=ACP_DEFAULT_SCOPE`, {
      headers: headers(token.plaintext),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).configs[0].value).toBe("global");
  });

  test("agent token resolved config without agentId reads its own agent scope", async () => {
    const token = await mintAgentToken(workerId);
    try {
      const response = await fetch(`${baseUrl}/api/config/resolved?includeSecrets=true`, {
        headers: headers(token.plaintext),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(SECRET);
    } finally {
      await revokeAgentTokens(workerId);
    }
  });

  for (const method of ["PUT", "DELETE"] as const) {
    test(`${method} cannot escalate a non-lead session by changing only X-Agent-ID`, async () => {
      const token = await mint(workerId);
      const key = `ACP_AUTH_TEST_${method}`;
      const config = await upsertSwarmConfig({
        scope: "agent",
        scopeId: workerId,
        key,
        value: "original",
      });
      const url = `${baseUrl}/api/config${method === "DELETE" ? `/${config.id}` : ""}`;
      const request = (bearer: string, agentId?: string) =>
        fetch(url, {
          method,
          headers: headers(bearer, agentId),
          ...(method === "PUT"
            ? { body: JSON.stringify({ scope: "agent", scopeId: workerId, key, value: "changed" }) }
            : {}),
        });
      const own = await request(token.plaintext, workerId);
      expect(own.status).toBe(403);
      await own.text();
      const spoofed = await request(token.plaintext, leadId);
      await spoofed.text();
      const stored = await fetch(`${baseUrl}/api/config/${config.id}`, {
        headers: headers(API_KEY),
      });
      const storedBody = await stored.text();
      // Confirm both the response and persisted state; an error after writing is insufficient.
      expect({
        status: spoofed.status,
        storedStatus: stored.status,
        unchanged: storedBody.includes("original"),
      }).toEqual({ status: 403, storedStatus: 200, unchanged: true });
      const lead = await mint(leadId);
      const allowed = await request(lead.plaintext);
      expect(allowed.ok).toBe(true);
      await allowed.text();
    });
  }
});
