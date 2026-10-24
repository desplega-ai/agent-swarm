import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { closeDb, createAgent, initDb, upsertSwarmConfig } from "../be/db";
import { mintAgentToken, mintScriptRunToken, revokeSessionToken } from "../be/users";
import { handleConfig } from "../http/config";
import { handleCore } from "../http/core";
import { handleSessions } from "../http/sessions";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

// A script run presents a token minted by `mintScriptRunToken` (the api does
// this per run instead of handing the script the operator key). These tests
// pin that the token is scoped to its executing agent at the config layer, so
// a worker's inline script cannot read another agent's secret or delete its
// config row — the escalation that running as the operator allowed.
const API_KEY = `script-run-config-operator-${randomBytes(8).toString("hex")}`;
const WORKER_SECRET = `worker-secret-${randomBytes(8).toString("hex")}`;
const OTHER_SECRET = `other-secret-${randomBytes(8).toString("hex")}`;
const GLOBAL_SECRET = `global-secret-${randomBytes(8).toString("hex")}`;
const SHADOWED_GLOBAL = `shadowed-global-${randomBytes(8).toString("hex")}`;
const SHADOWING_AGENT = `shadowing-agent-${randomBytes(8).toString("hex")}`;

let server: Server;
let baseUrl: string;
let workerId: string;
let otherId: string;
let otherConfigId: string;
let ownConfigId: string;

function headers(bearer: string, agentId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    ...(agentId ? { "X-Agent-ID": agentId } : {}),
  };
}

beforeAll(async () => {
  initDb(":memory:");
  workerId = (await createAgent({ name: "script-run-worker", isLead: false, status: "idle" })).id;
  otherId = (await createAgent({ name: "script-run-other", isLead: false, status: "idle" })).id;
  ownConfigId = (
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: workerId,
      key: "OWN_SECRET",
      value: WORKER_SECRET,
      isSecret: true,
    })
  ).id;
  await upsertSwarmConfig({
    scope: "global",
    key: "GLOBAL_SECRET",
    value: GLOBAL_SECRET,
    isSecret: true,
  });
  await upsertSwarmConfig({
    scope: "global",
    key: "SHADOWED",
    value: SHADOWED_GLOBAL,
    isSecret: true,
  });
  await upsertSwarmConfig({
    scope: "agent",
    scopeId: workerId,
    key: "SHADOWED",
    value: SHADOWING_AGENT,
    isSecret: true,
  });
  otherConfigId = (
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: otherId,
      key: "OTHER_SECRET",
      value: OTHER_SECRET,
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

describe("script run token is scoped to its executing agent", () => {
  test("reads its own agent's secret", async () => {
    const run = await mintScriptRunToken(workerId, 60_000);
    try {
      const res = await fetch(`${baseUrl}/api/config/resolved?includeSecrets=true`, {
        headers: headers(run.plaintext),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(WORKER_SECRET);
    } finally {
      await revokeSessionToken(run.tokenId);
    }
  });

  test("cannot read another agent's secret", async () => {
    const run = await mintScriptRunToken(workerId, 60_000);
    try {
      const res = await fetch(
        `${baseUrl}/api/config/resolved?includeSecrets=true&agentId=${otherId}`,
        { headers: headers(run.plaintext) },
      );
      // X-Agent-ID is forced to the token's agent, so this reads the worker's
      // own scope; either way the other agent's secret never comes back.
      const body = await res.text();
      expect(body).not.toContain(OTHER_SECRET);
    } finally {
      await revokeSessionToken(run.tokenId);
    }
  });

  test("cannot delete another agent's config row", async () => {
    const run = await mintScriptRunToken(workerId, 60_000);
    try {
      const res = await fetch(`${baseUrl}/api/config/${otherConfigId}`, {
        method: "DELETE",
        headers: headers(run.plaintext),
      });
      await res.text();
      expect(res.status).toBe(403);
      // The row is still there, read back as operator.
      const check = await fetch(`${baseUrl}/api/config/${otherConfigId}`, {
        headers: headers(API_KEY),
      });
      expect(check.status).toBe(200);
    } finally {
      await revokeSessionToken(run.tokenId);
    }
  });
});

// `ctx.swarm.config` holds the run's resolved config (own agent over global).
// The raw list and by-id reads must hand the run's token those same values,
// and only those, or a script that reads a key through `config_list` gets a
// masked placeholder and fails while the run already holds the real value.
describe("script run token reads its held secrets on the raw config routes", () => {
  test("list reveals the rows the run holds and masks the rest", async () => {
    const run = await mintScriptRunToken(workerId, 60_000);
    try {
      const res = await fetch(`${baseUrl}/api/config?includeSecrets=true`, {
        headers: headers(run.plaintext),
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(WORKER_SECRET);
      expect(body).toContain(GLOBAL_SECRET);
      expect(body).toContain(SHADOWING_AGENT);
      // The run holds the agent row for SHADOWED, not the global one.
      expect(body).not.toContain(SHADOWED_GLOBAL);
      expect(body).not.toContain(OTHER_SECRET);
    } finally {
      await revokeSessionToken(run.tokenId);
    }
  });

  test("by-id reveals an own row and masks another agent's row", async () => {
    const run = await mintScriptRunToken(workerId, 60_000);
    try {
      const own = await fetch(`${baseUrl}/api/config/${ownConfigId}?includeSecrets=true`, {
        headers: headers(run.plaintext),
      });
      expect(await own.text()).toContain(WORKER_SECRET);
      const other = await fetch(`${baseUrl}/api/config/${otherConfigId}?includeSecrets=true`, {
        headers: headers(run.plaintext),
      });
      expect(other.status).toBe(200);
      expect(await other.text()).not.toContain(OTHER_SECRET);
    } finally {
      await revokeSessionToken(run.tokenId);
    }
  });

  test("without includeSecrets the run token still gets masked values", async () => {
    const run = await mintScriptRunToken(workerId, 60_000);
    try {
      const res = await fetch(`${baseUrl}/api/config`, { headers: headers(run.plaintext) });
      expect(await res.text()).not.toContain(WORKER_SECRET);
    } finally {
      await revokeSessionToken(run.tokenId);
    }
  });

  test("the worker's own agent token keeps the masked list", async () => {
    const worker = await mintAgentToken(workerId);
    const res = await fetch(`${baseUrl}/api/config?includeSecrets=true`, {
      headers: headers(worker.plaintext),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(WORKER_SECRET);
    expect(body).not.toContain(GLOBAL_SECRET);
  });
});
