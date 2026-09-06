import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  ensureAgentFsCredentials,
  fetchResolvedEnv,
  provisionAgentFsAfterRegistration,
  registerAgent,
} from "../commands/runner";
import { listenOnFreePort } from "./test-net";

/**
 * A worker booting with a brand-new AGENT_ID against a fresh API database
 * used to lose agent-fs entirely. `ensureAgentFsCredentials` runs before
 * `registerAgent` (the boot `fetchResolvedEnv` next to it resolves the
 * provider registration needs), so `POST /api/fs/agent-credentials` answered
 * `500 Agent not found`, nothing was written, and every `agent-fs` call in
 * that container failed with "Not logged in" until a restart.
 *
 * These tests drive the real exported boot functions against a fake API and
 * assert the second provisioning attempt happens after registration.
 */

const AGENT_ID = "9b2c4a1e-6d3f-4a55-8f27-1c0e7b5a4d90";
const API_KEY = "test-swarm-key";
const AGENT_FS_KEY = "af_live_key";

type FakeApiState = {
  registered: boolean;
  provisioned: boolean;
  /** Forces the credential route to fail even after registration. */
  forceCredentialFailure: boolean;
};

let server: Server;
let baseUrl: string;
let state: FakeApiState;
let requestLog: string[];

/** Paths the boot sequence is asserted on. Credential-pool probes are noise. */
const TRACKED_PATHS = new Set(["/api/fs/agent-credentials", "/api/agents", "/api/config/resolved"]);

const savedSharedOrgId = process.env.AGENT_FS_SHARED_ORG_ID;

function resetState(): void {
  state = { registered: false, provisioned: false, forceCredentialFailure: false };
  requestLog = [];
}

beforeAll(async () => {
  resetState();

  server = createServer((req, res) => {
    req.resume();
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    if (TRACKED_PATHS.has(url.pathname)) requestLog.push(`${method} ${url.pathname}`);

    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (method === "POST" && url.pathname === "/api/fs/agent-credentials") {
      // Mirrors the real route: it resolves the caller's agent row first.
      if (!state.registered || state.forceCredentialFailure) {
        send(500, {
          error: `Failed to provision agent-fs credentials: Agent not found: ${AGENT_ID}`,
        });
        return;
      }
      state.provisioned = true;
      send(200, { enabled: true, created: true, agentId: AGENT_ID });
      return;
    }

    if (method === "POST" && url.pathname === "/api/agents") {
      state.registered = true;
      send(200, { id: AGENT_ID, enabledCapabilities: [] });
      return;
    }

    if (method === "GET" && url.pathname === "/api/config/resolved") {
      // The AGENT_FS_* rows only exist once provisioning succeeded.
      const configs = state.provisioned
        ? [
            { key: "AGENT_FS_API_KEY", value: AGENT_FS_KEY },
            { key: "AGENT_FS_DEFAULT_ORG_ID", value: "org-late" },
            { key: "AGENT_FS_DEFAULT_DRIVE_ID", value: "drive-late" },
            { key: "AGENT_FS_SHARED_ORG_ID", value: "org-late" },
          ]
        : [];
      send(200, { configs });
      return;
    }

    send(404, { error: "not found" });
  });

  const port = await listenOnFreePort(server);
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
  if (savedSharedOrgId === undefined) delete process.env.AGENT_FS_SHARED_ORG_ID;
  else process.env.AGENT_FS_SHARED_ORG_ID = savedSharedOrgId;
});

beforeEach(() => {
  resetState();
});

describe("agent-fs boot provisioning retry", () => {
  test("retries after registration when the pre-registration attempt failed", async () => {
    const beforeRegistration = await ensureAgentFsCredentials(baseUrl, API_KEY, AGENT_ID);
    expect(beforeRegistration).toBe(false);

    await registerAgent({
      apiUrl: baseUrl,
      apiKey: API_KEY,
      agentId: AGENT_ID,
      name: "worker-cb82b832",
      isLead: false,
    });

    const settled = await provisionAgentFsAfterRegistration({
      apiUrl: baseUrl,
      apiKey: API_KEY,
      agentId: AGENT_ID,
      alreadyProvisioned: beforeRegistration,
    });

    expect(settled).toBe(true);
    expect(state.provisioned).toBe(true);
    expect(requestLog).toEqual([
      "POST /api/fs/agent-credentials",
      "POST /api/agents",
      "POST /api/fs/agent-credentials",
      "GET /api/config/resolved",
    ]);
    // The refresh applies the live-apply allowlist to process.env.
    expect(process.env.AGENT_FS_SHARED_ORG_ID).toBe("org-late");
  });

  test("the per-task env fetch carries the freshly written rows to the harness", async () => {
    await registerAgent({
      apiUrl: baseUrl,
      apiKey: API_KEY,
      agentId: AGENT_ID,
      name: "worker-cb82b832",
      isLead: false,
    });
    await provisionAgentFsAfterRegistration({
      apiUrl: baseUrl,
      apiKey: API_KEY,
      agentId: AGENT_ID,
      alreadyProvisioned: false,
    });

    // Same call `spawnTask` makes per task before it builds the harness env.
    const perTask = await fetchResolvedEnv(baseUrl, API_KEY, AGENT_ID, { PATH: "/usr/bin" });
    expect(perTask.env.AGENT_FS_API_KEY).toBe(AGENT_FS_KEY);
    expect(perTask.env.AGENT_FS_DEFAULT_ORG_ID).toBe("org-late");
    expect(perTask.env.AGENT_FS_DEFAULT_DRIVE_ID).toBe("drive-late");
  });

  test("does nothing when the pre-registration attempt already succeeded", async () => {
    state.registered = true;
    const beforeRegistration = await ensureAgentFsCredentials(baseUrl, API_KEY, AGENT_ID);
    expect(beforeRegistration).toBe(true);
    requestLog = [];

    const settled = await provisionAgentFsAfterRegistration({
      apiUrl: baseUrl,
      apiKey: API_KEY,
      agentId: AGENT_ID,
      alreadyProvisioned: beforeRegistration,
    });

    expect(settled).toBe(true);
    expect(requestLog).toEqual([]);
  });

  test("a failing retry stays non-fatal and skips the env refresh", async () => {
    state.registered = true;
    state.forceCredentialFailure = true;

    const settled = await provisionAgentFsAfterRegistration({
      apiUrl: baseUrl,
      apiKey: API_KEY,
      agentId: AGENT_ID,
      alreadyProvisioned: false,
    });

    expect(settled).toBe(false);
    expect(requestLog).toEqual(["POST /api/fs/agent-credentials"]);
  });
});
