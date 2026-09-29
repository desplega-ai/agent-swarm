import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, initDb } from "../be/db";
import { setAgentHarnessCliVersion } from "../be/harness-model-support";
import {
  MODEL_CATALOG_FORCE_COOLDOWN_MS,
  refreshModelCatalog,
  requestModelCatalogRefresh,
  resetModelCatalogRefreshGuardForTests,
} from "../be/pricing-refresh";
import { handleModelsCatalog } from "../http/models-catalog";
import {
  registerModelCatalogOverlayUpsertTool,
  registerModelCatalogRefreshTool,
} from "../tools/model-catalog";
import type { User } from "../types";
import { setRequestAuth } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-model-catalog-write-access.sqlite";
const LEAD_ID = "11111111-1111-4111-8111-111111111111";
const WORKER_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function catalogPayload() {
  return {
    openai: {
      name: "OpenAI",
      models: { "gpt-base": { name: "GPT Base", cost: { input: 1, output: 4 } } },
    },
  };
}

/** A models.dev stand-in that counts fetches and answers after `delayMs`. */
function countingFetch(delayMs = 0) {
  const state = { calls: 0 };
  const impl = (async () => {
    state.calls += 1;
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return new Response(JSON.stringify(catalogPayload()), {
      status: 200,
      headers: { "content-type": "application/json", etag: `"v${state.calls}"` },
    });
  }) as unknown as typeof fetch;
  return { state, impl };
}

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  await createAgent({ id: LEAD_ID, name: "catalog-lead", isLead: true, status: "idle" });
  await createAgent({
    id: WORKER_ID,
    name: "catalog-worker",
    isLead: false,
    status: "idle",
    harnessProvider: "codex",
  });
  await setAgentHarnessCliVersion(WORKER_ID, "9.9.9");

  // The shared API key resolves to an operator; `x-test-auth` picks the auth kind the real
  // pipeline would attach. `x-agent-id` rides along exactly as a worker sends it.
  server = createServer((req, res) => {
    const kind = req.headers["x-test-auth"];
    if (kind === "operator") setRequestAuth(req, { kind: "operator", fingerprint: "test" });
    // A dashboard session user: no admin flag, not an agent.
    if (kind === "user") {
      setRequestAuth(req, { kind: "user", userId: USER_ID, user: { id: USER_ID } as User });
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);
    void handleModelsCatalog(req, res, segments, url.searchParams).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  baseUrl = `http://localhost:${await listenOnFreePort(server)}`;
});

afterEach(() => resetModelCatalogRefreshGuardForTests());

afterAll(async () => {
  server.close();
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

function call(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const OVERLAY = {
  provider: "openai",
  modelId: "gpt-overlay-test",
  name: "GPT Overlay",
  reason: "write-access test",
};
const SUPPORT = { harness: "codex", cliVersion: "9.9.9", modelId: "gpt-base", status: "ok" };

// A worker holds the shared API key, so the request is operator-authenticated AND carries its
// own X-Agent-ID. The agent identity has to win, or the lead-only rule is a no-op.
const workerWithSharedKey = { "x-test-auth": "operator", "x-agent-id": WORKER_ID };
const leadWithSharedKey = { "x-test-auth": "operator", "x-agent-id": LEAD_ID };
const operatorOnly = { "x-test-auth": "operator" };
const dashboardUser = { "x-test-auth": "user" };
// A user session can also carry an X-Agent-ID header; the session must not turn it into an agent.
const userClaimingWorker = { "x-test-auth": "user", "x-agent-id": WORKER_ID };

describe("catalog write access", () => {
  test("a worker cannot force a refresh, even with the shared API key", async () => {
    const res = await call(
      "POST",
      "/api/models-catalog/refresh",
      { force: true },
      workerWithSharedKey,
    );
    expect(res.status).toBe(403);
  });

  test("a worker cannot write or delete overlay rows", async () => {
    const put = await call("PUT", "/api/models-catalog/overlay", OVERLAY, workerWithSharedKey);
    expect(put.status).toBe(403);
    const del = await call(
      "DELETE",
      "/api/models-catalog/overlay",
      { provider: OVERLAY.provider, modelId: OVERLAY.modelId },
      workerWithSharedKey,
    );
    expect(del.status).toBe(403);
  });

  test("an unauthenticated caller cannot write overlay rows", async () => {
    const res = await call("PUT", "/api/models-catalog/overlay", OVERLAY, {});
    expect(res.status).toBe(403);
  });

  test("the lead agent and the operator can write overlay rows", async () => {
    const asLead = await call("PUT", "/api/models-catalog/overlay", OVERLAY, leadWithSharedKey);
    expect(asLead.status).toBe(200);
    const asOperator = await call("PUT", "/api/models-catalog/overlay", OVERLAY, operatorOnly);
    expect(asOperator.status).toBe(200);
    const del = await call(
      "DELETE",
      "/api/models-catalog/overlay",
      { provider: OVERLAY.provider, modelId: OVERLAY.modelId },
      operatorOnly,
    );
    expect(del.status).toBe(200);
  });

  test("a worker can record harness support for its own harness and CLI version", async () => {
    const res = await call(
      "PUT",
      "/api/models-catalog/harness-support",
      SUPPORT,
      workerWithSharedKey,
    );
    expect(res.status).toBe(200);
  });

  test("a worker cannot record support for another CLI version or harness", async () => {
    const otherVersion = { ...SUPPORT, cliVersion: "1.0.0", status: "unsupported" };
    const otherHarness = { ...SUPPORT, harness: "claude", status: "unsupported" };
    for (const body of [otherVersion, otherHarness]) {
      const res = await call(
        "PUT",
        "/api/models-catalog/harness-support",
        body,
        workerWithSharedKey,
      );
      expect(res.status).toBe(403);
    }
  });

  test("the operator can record support for any tuple", async () => {
    const body = { ...SUPPORT, cliVersion: "1.0.0" };
    const res = await call("PUT", "/api/models-catalog/harness-support", body, operatorOnly);
    expect(res.status).toBe(200);
  });
});

describe("dashboard users", () => {
  test("cannot force a refresh or write or delete overlay rows", async () => {
    for (const headers of [dashboardUser, userClaimingWorker]) {
      const refresh = await call("POST", "/api/models-catalog/refresh", { force: true }, headers);
      expect(refresh.status).toBe(403);
      const put = await call("PUT", "/api/models-catalog/overlay", OVERLAY, headers);
      expect(put.status).toBe(403);
      const del = await call(
        "DELETE",
        "/api/models-catalog/overlay",
        { provider: OVERLAY.provider, modelId: OVERLAY.modelId },
        headers,
      );
      expect(del.status).toBe(403);
    }
  });

  test("cannot record harness support, for any tuple", async () => {
    // The user tuple is a real one (a worker's own harness and CLI version), so the only thing
    // that can stop it is the principal check, not the ownership binding.
    for (const headers of [dashboardUser, userClaimingWorker]) {
      const own = await call(
        "PUT",
        "/api/models-catalog/harness-support",
        { ...SUPPORT, status: "unsupported" },
        headers,
      );
      expect(own.status).toBe(403);
      const other = await call(
        "PUT",
        "/api/models-catalog/harness-support",
        { ...SUPPORT, cliVersion: "1.0.0", status: "unsupported" },
        headers,
      );
      expect(other.status).toBe(403);
    }
    const rows = await call("GET", "/api/models-catalog/harness-support", undefined, {});
    const body = (await rows.json()) as { rows: { status: string; modelId: string }[] };
    expect(body.rows.some((r) => r.status === "unsupported" && r.modelId === "gpt-base")).toBe(
      false,
    );
  });

  test("an unauthenticated caller cannot record harness support", async () => {
    const res = await call("PUT", "/api/models-catalog/harness-support", SUPPORT, {});
    expect(res.status).toBe(403);
  });
});

type RegisteredTool = { handler: (args: unknown, extra: unknown) => Promise<unknown> };

function catalogTools(): Record<string, RegisteredTool> {
  const toolServer = new McpServer({ name: "catalog-write-access-test", version: "1.0.0" });
  registerModelCatalogRefreshTool(toolServer);
  registerModelCatalogOverlayUpsertTool(toolServer);
  return (toolServer as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
}

async function callTool(name: string, args: unknown, agentId?: string) {
  const handler = catalogTools()[name]?.handler;
  if (!handler) throw new Error(`Tool not registered: ${name}`);
  return (await handler(args, {
    sessionId: "catalog-write-access-test",
    requestInfo: { headers: agentId ? { "x-agent-id": agentId } : {} },
  })) as { isError?: boolean; content?: { text?: string }[] };
}

describe("MCP catalog tools", () => {
  const overlayArgs = { ...OVERLAY, reason: "write-access test" };

  test("a worker is denied both tools", async () => {
    const refresh = await callTool("model-catalog-refresh", { force: true }, WORKER_ID);
    expect(refresh.isError).toBe(true);
    expect(refresh.content?.[0]?.text).toContain("requires the lead agent");
    const overlay = await callTool("model-catalog-overlay-upsert", overlayArgs, WORKER_ID);
    expect(overlay.isError).toBe(true);
    expect(overlay.content?.[0]?.text).toContain("requires the lead agent");
  });

  test("a call without an agent identity is denied", async () => {
    const overlay = await callTool("model-catalog-overlay-upsert", overlayArgs);
    expect(overlay.isError).toBe(true);
  });

  test("the lead can write an overlay", async () => {
    const overlay = await callTool("model-catalog-overlay-upsert", overlayArgs, LEAD_ID);
    expect(overlay.isError).toBeFalsy();
  });
});

describe("forced refresh guard", () => {
  test("concurrent refreshes share one fetch", async () => {
    const { state, impl } = countingFetch(50);
    const results = await Promise.all([
      refreshModelCatalog({ force: true, now: 5_000, fetchImpl: impl }),
      refreshModelCatalog({ force: true, now: 5_000, fetchImpl: impl }),
      refreshModelCatalog({ force: true, now: 5_000, fetchImpl: impl }),
    ]);
    expect(state.calls).toBe(1);
    expect(new Set(results.map((r) => r.status)).size).toBe(1);
  });

  test("a second forced call inside the cooldown does not fetch", async () => {
    const { state, impl } = countingFetch();
    const first = await requestModelCatalogRefresh({ force: true, now: 10_000, fetchImpl: impl });
    expect(first.status).not.toBe("skipped-cooldown");
    expect(state.calls).toBe(1);

    const second = await requestModelCatalogRefresh({
      force: true,
      now: 10_000 + 20_000,
      fetchImpl: impl,
    });
    expect(second.status).toBe("skipped-cooldown");
    expect(second.retryAfterMs).toBe(MODEL_CATALOG_FORCE_COOLDOWN_MS - 20_000);
    expect(state.calls).toBe(1);
  });

  test("a forced call is accepted again once the cooldown has passed", async () => {
    const { state, impl } = countingFetch();
    await requestModelCatalogRefresh({ force: true, now: 20_000, fetchImpl: impl });
    const later = await requestModelCatalogRefresh({
      force: true,
      now: 20_000 + MODEL_CATALOG_FORCE_COOLDOWN_MS,
      fetchImpl: impl,
    });
    expect(later.status).not.toBe("skipped-cooldown");
    expect(state.calls).toBe(2);
  });

  test("unforced calls are not rate limited by the forced cooldown", async () => {
    const { impl } = countingFetch();
    await requestModelCatalogRefresh({ force: true, now: 30_000, fetchImpl: impl });
    const unforced = await requestModelCatalogRefresh({ now: 30_001, fetchImpl: impl });
    expect(unforced.status).not.toBe("skipped-cooldown");
  });
});
