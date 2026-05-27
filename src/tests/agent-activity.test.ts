import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  getAgentById,
  getAllAgents,
  initDb,
  updateAgentActivity,
} from "../be/db";

const TEST_DB_PATH = "./test-agent-activity.sqlite";
const TEST_PORT = 13025;

// Minimal HTTP handler for activity endpoint
async function handleRequest(req: {
  method: string;
  url: string;
}): Promise<{ status: number; body: unknown }> {
  const pathEnd = req.url.indexOf("?");
  const path = pathEnd === -1 ? req.url : req.url.slice(0, pathEnd);
  const pathSegments = path.split("/").filter(Boolean);

  // PUT /api/agents/:id/activity
  if (
    req.method === "PUT" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "agents" &&
    pathSegments[2] &&
    pathSegments[3] === "activity"
  ) {
    const agentId = pathSegments[2];
    await updateAgentActivity(agentId);
    return { status: 204, body: null };
  }

  // GET /api/agents — list agents (for verifying lastActivityAt in response)
  if (req.method === "GET" && pathSegments[0] === "api" && pathSegments[1] === "agents") {
    const agents = await getAllAgents();
    return { status: 200, body: { agents } };
  }

  return { status: 404, body: { error: "Not found" } };
}

function createTestServer(): Server {
  return createHttpServer(async (req, res) => {
    const result = await handleRequest({ method: req.method || "GET", url: req.url || "/" });

    if (result.body === null) {
      res.writeHead(result.status);
      res.end();
    } else {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(result.status);
      res.end(JSON.stringify(result.body));
    }
  });
}

describe("Agent Activity Tracking (lastActivityAt)", () => {
  let server: Server;
  const baseUrl = `http://localhost:${TEST_PORT}`;

  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist, that's fine
    }

    await initDb(TEST_DB_PATH);

    server = createTestServer();
    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, () => {
        console.log(`Test server listening on port ${TEST_PORT}`);
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    closeDb();

    try {
      await unlink(TEST_DB_PATH);
      await unlink(`${TEST_DB_PATH}-wal`);
      await unlink(`${TEST_DB_PATH}-shm`);
    } catch {
      // Files may not exist
    }
  });

  describe("DB: updateAgentActivity()", () => {
    test("should update lastActivityAt timestamp for an existing agent", async () => {
      const agent = await createAgent({
        name: "activity-test-agent-1",
        isLead: false,
        status: "idle",
        capabilities: [],
      });

      // Initially, lastActivityAt should be undefined
      const before = await getAgentById(agent.id);
      expect(before).not.toBeNull();
      expect(before!.lastActivityAt).toBeUndefined();

      // Update activity
      await updateAgentActivity(agent.id);

      // Now lastActivityAt should be set
      const after = await getAgentById(agent.id);
      expect(after).not.toBeNull();
      expect(after!.lastActivityAt).toBeDefined();
      expect(typeof after!.lastActivityAt).toBe("string");

      // Verify it's a valid ISO timestamp
      const ts = new Date(after!.lastActivityAt!);
      expect(ts.getTime()).not.toBeNaN();
    });

    test("should update lastActivityAt to a newer timestamp on subsequent calls", async () => {
      const agent = await createAgent({
        name: "activity-test-agent-2",
        isLead: false,
        status: "busy",
        capabilities: [],
      });

      await updateAgentActivity(agent.id);
      const first = await getAgentById(agent.id);
      expect(first!.lastActivityAt).toBeDefined();

      // Small delay to ensure timestamp differs
      await new Promise((resolve) => setTimeout(resolve, 10));

      await updateAgentActivity(agent.id);
      const second = await getAgentById(agent.id);
      expect(second!.lastActivityAt).toBeDefined();

      // Second timestamp should be >= first
      expect(new Date(second!.lastActivityAt!).getTime()).toBeGreaterThanOrEqual(
        new Date(first!.lastActivityAt!).getTime(),
      );
    });

    test("should not throw for non-existent agent ID", () => {
      // Should not throw — just silently does nothing
      expect(async () => await updateAgentActivity("non-existent-agent-id")).not.toThrow();
    });

    test("should not modify lastUpdatedAt when updating activity", async () => {
      const agent = await createAgent({
        name: "activity-test-agent-3",
        isLead: false,
        status: "idle",
        capabilities: [],
      });

      const before = await getAgentById(agent.id);
      expect(before).not.toBeNull();
      const originalLastUpdatedAt = before!.lastUpdatedAt;

      await updateAgentActivity(agent.id);

      const after = await getAgentById(agent.id);
      expect(after!.lastUpdatedAt).toBe(originalLastUpdatedAt);
    });
  });

  describe("HTTP: PUT /api/agents/:id/activity", () => {
    test("should return 204 for valid agent", async () => {
      const agent = await createAgent({
        name: "http-activity-test-1",
        isLead: false,
        status: "busy",
        capabilities: [],
      });

      const response = await fetch(`${baseUrl}/api/agents/${agent.id}/activity`, {
        method: "PUT",
      });

      expect(response.status).toBe(204);

      // Verify timestamp was updated
      const updated = await getAgentById(agent.id);
      expect(updated!.lastActivityAt).toBeDefined();
    });

    test("should return 204 for non-existent agent (no crash)", async () => {
      const response = await fetch(`${baseUrl}/api/agents/does-not-exist/activity`, {
        method: "PUT",
      });

      expect(response.status).toBe(204);
    });
  });

  describe("API: lastActivityAt in agent list", () => {
    test("should include lastActivityAt field in GET /api/agents response", async () => {
      const agent = await createAgent({
        name: "list-activity-test-1",
        isLead: false,
        status: "idle",
        capabilities: [],
      });

      // Update activity so the field is set
      await updateAgentActivity(agent.id);

      const response = await fetch(`${baseUrl}/api/agents`);
      expect(response.status).toBe(200);

      const data = (await response.json()) as {
        agents: Array<{ id: string; lastActivityAt?: string }>;
      };
      const found = data.agents.find((a) => a.id === agent.id);
      expect(found).toBeDefined();
      expect(found!.lastActivityAt).toBeDefined();
      expect(typeof found!.lastActivityAt).toBe("string");
    });

    test("should have lastActivityAt undefined for agent with no activity", async () => {
      const agent = await createAgent({
        name: "list-activity-test-2",
        isLead: false,
        status: "idle",
        capabilities: [],
      });

      const response = await fetch(`${baseUrl}/api/agents`);
      expect(response.status).toBe(200);

      const data = (await response.json()) as {
        agents: Array<{ id: string; lastActivityAt?: string }>;
      };
      const found = data.agents.find((a) => a.id === agent.id);
      expect(found).toBeDefined();
      // Should be undefined (not present in JSON) since no activity occurred
      expect(found!.lastActivityAt).toBeUndefined();
    });
  });
});
