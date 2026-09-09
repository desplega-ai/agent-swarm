import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  completeTask,
  createAgent,
  createScheduledTask,
  createSessionCost,
  createTaskExtended,
  createUser,
  createWorkflow,
  createWorkflowRun,
  deleteScheduledTask,
  getAllSessionCosts,
  getAttributionByPerson,
  getDashboardCostSummary,
  getDbClient,
  getSessionCostSummary,
  getSessionCostsByAgentId,
  getSessionCostsByTaskId,
  getSessionCostsFiltered,
  initDb,
  insertTaskAttachment,
  UNATTRIBUTED_USER_ID,
} from "../be/db";
import type { SessionCost } from "../types";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-session-costs.sqlite";

// Helper to parse path segments
function getPathSegments(url: string): string[] {
  const pathEnd = url.indexOf("?");
  const path = pathEnd === -1 ? url : url.slice(0, pathEnd);
  return path.split("/").filter(Boolean);
}

function parseQueryParams(url: string): URLSearchParams {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return new URLSearchParams();
  return new URLSearchParams(url.slice(queryIndex + 1));
}

// Minimal HTTP handler for session costs endpoints
async function handleRequest(
  req: { method: string; url: string },
  body: string,
): Promise<{ status: number; body: unknown }> {
  const pathSegments = getPathSegments(req.url || "");
  const queryParams = parseQueryParams(req.url || "");

  // POST /api/session-costs - Store session cost record
  if (req.method === "POST" && pathSegments[0] === "api" && pathSegments[1] === "session-costs") {
    const parsedBody = JSON.parse(body);

    // Validate required fields
    if (!parsedBody.sessionId || typeof parsedBody.sessionId !== "string") {
      return { status: 400, body: { error: "Missing or invalid 'sessionId' field" } };
    }

    if (!parsedBody.agentId || typeof parsedBody.agentId !== "string") {
      return { status: 400, body: { error: "Missing or invalid 'agentId' field" } };
    }

    if (typeof parsedBody.totalCostUsd !== "number") {
      return { status: 400, body: { error: "Missing or invalid 'totalCostUsd' field" } };
    }

    try {
      const cost = await createSessionCost({
        sessionId: parsedBody.sessionId,
        taskId: parsedBody.taskId || undefined,
        agentId: parsedBody.agentId,
        totalCostUsd: parsedBody.totalCostUsd,
        inputTokens: parsedBody.inputTokens ?? 0,
        outputTokens: parsedBody.outputTokens ?? 0,
        cacheReadTokens: parsedBody.cacheReadTokens ?? 0,
        cacheWriteTokens: parsedBody.cacheWriteTokens ?? 0,
        durationMs: parsedBody.durationMs ?? 0,
        numTurns: parsedBody.numTurns ?? 1,
        model: parsedBody.model || "opus",
        isError: parsedBody.isError ?? false,
      });

      return { status: 201, body: { success: true, cost } };
    } catch (error) {
      console.error("[TEST] Failed to create session cost:", error);
      return { status: 500, body: { error: "Failed to store session cost" } };
    }
  }

  // GET /api/session-costs/summary - Aggregated usage summary
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "session-costs" &&
    pathSegments[2] === "summary"
  ) {
    const rawGroupBy = queryParams.get("groupBy");
    const validGroupBy = ["day", "agent", "both"] as const;
    if (rawGroupBy && !validGroupBy.includes(rawGroupBy as (typeof validGroupBy)[number])) {
      return {
        status: 400,
        body: {
          error: `Invalid groupBy value '${rawGroupBy}'. Must be one of: ${validGroupBy.join(", ")}`,
        },
      };
    }
    const summary = await getSessionCostSummary({
      startDate: queryParams.get("startDate") || undefined,
      endDate: queryParams.get("endDate") || undefined,
      agentId: queryParams.get("agentId") || undefined,
      groupBy: (rawGroupBy as "day" | "agent" | "both") || "both",
    });
    return { status: 200, body: summary };
  }

  // GET /api/session-costs/dashboard - Cost today and MTD
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "session-costs" &&
    pathSegments[2] === "dashboard"
  ) {
    const dashboardCosts = await getDashboardCostSummary();
    return { status: 200, body: dashboardCosts };
  }

  // GET /api/session-costs - Query session costs with filters
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "session-costs" &&
    !pathSegments[2]
  ) {
    const agentId = queryParams.get("agentId");
    const taskId = queryParams.get("taskId");
    const startDate = queryParams.get("startDate");
    const endDate = queryParams.get("endDate");
    const limitParam = queryParams.get("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : 100;

    let costs: SessionCost[];
    if (taskId) {
      costs = await getSessionCostsByTaskId(taskId, limit);
    } else if (startDate || endDate) {
      costs = await getSessionCostsFiltered({
        agentId: agentId || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        limit,
      });
    } else if (agentId) {
      costs = await getSessionCostsByAgentId(agentId, limit);
    } else {
      costs = await getAllSessionCosts(limit);
    }

    return { status: 200, body: { costs } };
  }

  return { status: 404, body: { error: "Not found" } };
}

// Create test HTTP server
function createTestServer(): Server {
  return createHttpServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString();

    const result = await handleRequest({ method: req.method || "GET", url: req.url || "/" }, body);

    res.writeHead(result.status);
    res.end(JSON.stringify(result.body));
  });
}

describe("Session Costs API", () => {
  let server: Server;
  let baseUrl = "";
  let testAgent: { id: string };

  beforeAll(async () => {
    // Clean up any existing test database
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist, that's fine
    }

    // Initialize test database
    initDb(TEST_DB_PATH);

    // Create a test agent
    testAgent = await createAgent({
      name: "Test Cost Agent",
      isLead: false,
      status: "idle",
    });

    // Start test server
    server = createTestServer();
    const port = await listenOnFreePort(server);
    baseUrl = `http://localhost:${port}`;
    console.log(`Test server listening on port ${port}`);
  });

  afterAll(async () => {
    // Close server
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    // Close database
    closeDb();

    // Clean up test database file
    try {
      await unlink(TEST_DB_PATH);
      await unlink(`${TEST_DB_PATH}-wal`);
      await unlink(`${TEST_DB_PATH}-shm`);
    } catch {
      // Files may not exist
    }
  });

  describe("Database Functions", () => {
    test("should create and retrieve session cost by agentId", async () => {
      const cost = await createSessionCost({
        sessionId: "db-test-session-1",
        agentId: testAgent.id,
        totalCostUsd: 0.05,
        durationMs: 5000,
        numTurns: 3,
        model: "opus",
      });

      expect(cost.id).toBeDefined();
      expect(cost.sessionId).toBe("db-test-session-1");
      expect(cost.agentId).toBe(testAgent.id);
      expect(cost.totalCostUsd).toBe(0.05);
      expect(cost.durationMs).toBe(5000);
      expect(cost.numTurns).toBe(3);
      expect(cost.model).toBe("opus");
      expect(cost.isError).toBe(false);
      expect(cost.inputTokens).toBe(0);
      expect(cost.outputTokens).toBe(0);
      expect(cost.cacheReadTokens).toBe(0);
      expect(cost.cacheWriteTokens).toBe(0);

      // Retrieve by agentId
      const costs = await getSessionCostsByAgentId(testAgent.id);
      expect(costs.length).toBeGreaterThanOrEqual(1);
      expect(costs.find((c) => c.id === cost.id)).toBeDefined();
    });

    test("should create session cost with taskId", async () => {
      const task = await createTaskExtended("Test task for session cost");

      const cost = await createSessionCost({
        sessionId: "db-test-session-2",
        taskId: task.id,
        agentId: testAgent.id,
        totalCostUsd: 0.1,
        durationMs: 10000,
        numTurns: 5,
        model: "sonnet",
      });

      expect(cost.taskId).toBe(task.id);

      // Retrieve by taskId
      const costs = await getSessionCostsByTaskId(task.id);
      expect(costs.length).toBe(1);
      expect(costs[0]?.sessionId).toBe("db-test-session-2");
      expect(costs[0]?.totalCostUsd).toBe(0.1);
    });

    test("should create session cost with all optional fields", async () => {
      const cost = await createSessionCost({
        sessionId: "db-test-session-3",
        agentId: testAgent.id,
        totalCostUsd: 0.25,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheWriteTokens: 100,
        durationMs: 15000,
        numTurns: 10,
        model: "opus",
        isError: true,
      });

      expect(cost.inputTokens).toBe(1000);
      expect(cost.outputTokens).toBe(500);
      expect(cost.cacheReadTokens).toBe(200);
      expect(cost.cacheWriteTokens).toBe(100);
      expect(cost.isError).toBe(true);
    });

    test("should retrieve all session costs with limit", async () => {
      // Create multiple costs
      for (let i = 0; i < 5; i++) {
        await createSessionCost({
          sessionId: `db-test-batch-${i}`,
          agentId: testAgent.id,
          totalCostUsd: 0.01 * (i + 1),
          durationMs: 1000 * (i + 1),
          numTurns: i + 1,
          model: "opus",
        });
      }

      const costs = await getAllSessionCosts(3);
      expect(costs.length).toBe(3);
    });

    test("should order session costs by createdAt DESC", async () => {
      const agent2 = await createAgent({ name: "Cost Order Agent", isLead: false, status: "idle" });

      // Create costs with slight delays to ensure different timestamps
      await createSessionCost({
        sessionId: "order-test-1",
        agentId: agent2.id,
        totalCostUsd: 0.01,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });

      await createSessionCost({
        sessionId: "order-test-2",
        agentId: agent2.id,
        totalCostUsd: 0.02,
        durationMs: 2000,
        numTurns: 2,
        model: "opus",
      });

      const costs = await getSessionCostsByAgentId(agent2.id);
      expect(costs.length).toBe(2);
      // Most recent should be first
      expect(costs[0]?.sessionId).toBe("order-test-2");
      expect(costs[1]?.sessionId).toBe("order-test-1");
    });
  });

  describe("POST /api/session-costs", () => {
    test("should return 400 if sessionId is missing", async () => {
      const response = await fetch(`${baseUrl}/api/session-costs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: "test-agent", totalCostUsd: 0.05 }),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toContain("sessionId");
    });

    test("should return 400 if agentId is missing", async () => {
      const response = await fetch(`${baseUrl}/api/session-costs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "test-session", totalCostUsd: 0.05 }),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toContain("agentId");
    });

    test("should return 400 if totalCostUsd is missing", async () => {
      const response = await fetch(`${baseUrl}/api/session-costs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "test-session", agentId: "test-agent" }),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toContain("totalCostUsd");
    });

    test("should return 400 if totalCostUsd is not a number", async () => {
      const response = await fetch(`${baseUrl}/api/session-costs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "test-session",
          agentId: "test-agent",
          totalCostUsd: "not-a-number",
        }),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toContain("totalCostUsd");
    });

    test("should return 201 on successful POST with minimal fields", async () => {
      const response = await fetch(`${baseUrl}/api/session-costs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "api-test-session-1",
          agentId: testAgent.id,
          totalCostUsd: 0.05,
        }),
      });

      expect(response.status).toBe(201);
      const data = (await response.json()) as {
        success: boolean;
        cost: { id: string; sessionId: string };
      };
      expect(data.success).toBe(true);
      expect(data.cost.id).toBeDefined();
      expect(data.cost.sessionId).toBe("api-test-session-1");
    });

    test("should return 201 on successful POST with all fields", async () => {
      const task = await createTaskExtended("API test task for cost");

      const response = await fetch(`${baseUrl}/api/session-costs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "api-test-session-full",
          taskId: task.id,
          agentId: testAgent.id,
          totalCostUsd: 0.15,
          inputTokens: 2000,
          outputTokens: 1000,
          cacheReadTokens: 500,
          cacheWriteTokens: 250,
          durationMs: 30000,
          numTurns: 8,
          model: "sonnet",
          isError: false,
        }),
      });

      expect(response.status).toBe(201);
      const data = (await response.json()) as {
        success: boolean;
        cost: {
          id: string;
          taskId: string;
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheWriteTokens: number;
          model: string;
        };
      };
      expect(data.success).toBe(true);
      expect(data.cost.taskId).toBe(task.id);
      expect(data.cost.inputTokens).toBe(2000);
      expect(data.cost.outputTokens).toBe(1000);
      expect(data.cost.cacheReadTokens).toBe(500);
      expect(data.cost.cacheWriteTokens).toBe(250);
      expect(data.cost.model).toBe("sonnet");
    });

    test("should store session cost with isError = true", async () => {
      const response = await fetch(`${baseUrl}/api/session-costs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "api-test-error-session",
          agentId: testAgent.id,
          totalCostUsd: 0.03,
          isError: true,
        }),
      });

      expect(response.status).toBe(201);
      const data = (await response.json()) as { success: boolean; cost: { isError: boolean } };
      expect(data.success).toBe(true);
      expect(data.cost.isError).toBe(true);
    });
  });

  describe("GET /api/session-costs", () => {
    test("should return all session costs without filters", async () => {
      const response = await fetch(`${baseUrl}/api/session-costs`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as { costs: unknown[] };
      expect(Array.isArray(data.costs)).toBe(true);
      expect(data.costs.length).toBeGreaterThan(0);
    });

    test("should filter session costs by agentId", async () => {
      // Create a unique agent for this test
      const uniqueAgent = await createAgent({
        name: "Filter Test Agent",
        isLead: false,
        status: "idle",
      });

      // Create costs for this agent via API
      await fetch(`${baseUrl}/api/session-costs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "filter-test-session",
          agentId: uniqueAgent.id,
          totalCostUsd: 0.07,
        }),
      });

      const response = await fetch(`${baseUrl}/api/session-costs?agentId=${uniqueAgent.id}`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as { costs: Array<{ agentId: string }> };
      expect(data.costs.length).toBe(1);
      expect(data.costs.every((c) => c.agentId === uniqueAgent.id)).toBe(true);
    });

    test("should filter session costs by taskId", async () => {
      const task = await createTaskExtended("Filter test task");

      // Create cost for this task via API
      await fetch(`${baseUrl}/api/session-costs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "task-filter-test-session",
          taskId: task.id,
          agentId: testAgent.id,
          totalCostUsd: 0.08,
        }),
      });

      const response = await fetch(`${baseUrl}/api/session-costs?taskId=${task.id}`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as { costs: Array<{ taskId: string }> };
      expect(data.costs.length).toBe(1);
      expect(data.costs[0]?.taskId).toBe(task.id);
    });

    test("should respect limit parameter", async () => {
      const response = await fetch(`${baseUrl}/api/session-costs?limit=2`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as { costs: unknown[] };
      expect(data.costs.length).toBeLessThanOrEqual(2);
    });

    test("should return empty array for non-existent agentId", async () => {
      const response = await fetch(`${baseUrl}/api/session-costs?agentId=non-existent-agent-id`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as { costs: unknown[] };
      expect(data.costs).toEqual([]);
    });

    test("should return empty array for non-existent taskId", async () => {
      const response = await fetch(
        `${baseUrl}/api/session-costs?taskId=00000000-0000-0000-0000-000000000000`,
      );

      expect(response.status).toBe(200);
      const data = (await response.json()) as { costs: unknown[] };
      expect(data.costs).toEqual([]);
    });
  });

  describe("Zod Schema Validation", () => {
    test("session cost object should match SessionCost type structure", async () => {
      const cost = await createSessionCost({
        sessionId: "schema-test-session",
        agentId: testAgent.id,
        totalCostUsd: 0.12,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 25,
        cacheWriteTokens: 10,
        durationMs: 5000,
        numTurns: 2,
        model: "opus",
        isError: false,
      });

      // Verify all required fields exist
      expect(typeof cost.id).toBe("string");
      expect(typeof cost.sessionId).toBe("string");
      expect(typeof cost.agentId).toBe("string");
      expect(typeof cost.totalCostUsd).toBe("number");
      expect(typeof cost.inputTokens).toBe("number");
      expect(typeof cost.outputTokens).toBe("number");
      expect(typeof cost.cacheReadTokens).toBe("number");
      expect(typeof cost.cacheWriteTokens).toBe("number");
      expect(typeof cost.durationMs).toBe("number");
      expect(typeof cost.numTurns).toBe("number");
      expect(typeof cost.model).toBe("string");
      expect(typeof cost.isError).toBe("boolean");
      expect(typeof cost.createdAt).toBe("string");

      // taskId is optional
      expect(cost.taskId === undefined || typeof cost.taskId === "string").toBe(true);
    });

    test("session cost should have valid UUID id", async () => {
      const cost = await createSessionCost({
        sessionId: "uuid-test-session",
        agentId: testAgent.id,
        totalCostUsd: 0.01,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });

      // UUID v4 format
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(cost.id).toMatch(uuidRegex);
    });

    test("session cost createdAt should be valid ISO datetime", async () => {
      const cost = await createSessionCost({
        sessionId: "datetime-test-session",
        agentId: testAgent.id,
        totalCostUsd: 0.01,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });

      // Should be parseable as a date
      const parsedDate = new Date(cost.createdAt);
      expect(parsedDate.toString()).not.toBe("Invalid Date");
    });
  });

  describe("Token Fields Extraction", () => {
    test("should store and retrieve token counts correctly", async () => {
      // Simulate the data that would be extracted from Claude's result JSON
      // Claude returns: usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens
      const response = await fetch(`${baseUrl}/api/session-costs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "token-extraction-test",
          agentId: testAgent.id,
          totalCostUsd: 0.25,
          inputTokens: 1500,
          outputTokens: 750,
          cacheReadTokens: 100,
          cacheWriteTokens: 50,
          durationMs: 5000,
          numTurns: 3,
          model: "opus",
          isError: false,
        }),
      });

      expect(response.status).toBe(201);
      const data = (await response.json()) as {
        success: boolean;
        cost: {
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheWriteTokens: number;
        };
      };
      expect(data.success).toBe(true);
      expect(data.cost.inputTokens).toBe(1500);
      expect(data.cost.outputTokens).toBe(750);
      expect(data.cost.cacheReadTokens).toBe(100);
      expect(data.cost.cacheWriteTokens).toBe(50);
    });

    test("should default token counts to 0 when not provided", async () => {
      const response = await fetch(`${baseUrl}/api/session-costs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "token-default-test",
          agentId: testAgent.id,
          totalCostUsd: 0.05,
          durationMs: 1000,
          numTurns: 1,
          model: "opus",
        }),
      });

      expect(response.status).toBe(201);
      const data = (await response.json()) as {
        success: boolean;
        cost: {
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheWriteTokens: number;
        };
      };
      expect(data.success).toBe(true);
      expect(data.cost.inputTokens).toBe(0);
      expect(data.cost.outputTokens).toBe(0);
      expect(data.cost.cacheReadTokens).toBe(0);
      expect(data.cost.cacheWriteTokens).toBe(0);
    });

    test("should compute total tokens correctly in queries", async () => {
      // Create a session cost with known token values
      const agent = await createAgent({ name: "Token Query Agent", isLead: false, status: "idle" });

      await fetch(`${baseUrl}/api/session-costs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "token-query-test",
          agentId: agent.id,
          totalCostUsd: 0.1,
          inputTokens: 500,
          outputTokens: 300,
          cacheReadTokens: 200,
          cacheWriteTokens: 100,
          durationMs: 2000,
          numTurns: 2,
          model: "opus",
        }),
      });

      // Retrieve and verify
      const response = await fetch(`${baseUrl}/api/session-costs?agentId=${agent.id}`);
      expect(response.status).toBe(200);

      const data = (await response.json()) as {
        costs: Array<{
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheWriteTokens: number;
        }>;
      };

      expect(data.costs.length).toBe(1);
      const cost = data.costs[0];
      // Total tokens = inputTokens + outputTokens = 500 + 300 = 800
      expect((cost?.inputTokens ?? 0) + (cost?.outputTokens ?? 0)).toBe(800);
    });

    test("should handle large token counts", async () => {
      const response = await fetch(`${baseUrl}/api/session-costs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "large-token-test",
          agentId: testAgent.id,
          totalCostUsd: 5.5,
          inputTokens: 150000, // Large context window
          outputTokens: 50000, // Large output
          cacheReadTokens: 100000,
          cacheWriteTokens: 25000,
          durationMs: 120000,
          numTurns: 15,
          model: "opus",
        }),
      });

      expect(response.status).toBe(201);
      const data = (await response.json()) as {
        success: boolean;
        cost: {
          inputTokens: number;
          outputTokens: number;
        };
      };
      expect(data.success).toBe(true);
      expect(data.cost.inputTokens).toBe(150000);
      expect(data.cost.outputTokens).toBe(50000);
    });
  });

  describe("Database: getSessionCostsFiltered", () => {
    test("should filter by date range", async () => {
      const agent = await createAgent({ name: "Filter DB Agent", isLead: false, status: "idle" });

      await createSessionCost({
        sessionId: "filtered-db-1",
        agentId: agent.id,
        totalCostUsd: 0.1,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });

      // All records created today, so filtering with today's date should return them
      const today = new Date().toISOString().slice(0, 10);
      const results = await getSessionCostsFiltered({
        agentId: agent.id,
        startDate: today,
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => r.agentId === agent.id)).toBe(true);
    });

    test("should return empty for future date range", async () => {
      const results = await getSessionCostsFiltered({
        startDate: "2099-01-01",
      });

      expect(results.length).toBe(0);
    });

    test("should respect limit parameter", async () => {
      const agent = await createAgent({
        name: "Filter Limit Agent",
        isLead: false,
        status: "idle",
      });

      for (let i = 0; i < 5; i++) {
        await createSessionCost({
          sessionId: `filter-limit-${i}`,
          agentId: agent.id,
          totalCostUsd: 0.01,
          durationMs: 1000,
          numTurns: 1,
          model: "opus",
        });
      }

      const results = await getSessionCostsFiltered({ agentId: agent.id, limit: 2 });
      expect(results.length).toBe(2);
    });
  });

  describe("Database: getSessionCostSummary", () => {
    test("should return totals, daily, and byAgent", async () => {
      const agent = await createAgent({ name: "Summary DB Agent", isLead: false, status: "idle" });

      await createSessionCost({
        sessionId: "summary-db-1",
        agentId: agent.id,
        totalCostUsd: 0.5,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 100,
        cacheWriteTokens: 50,
        durationMs: 5000,
        numTurns: 3,
        model: "opus",
      });

      const today = new Date().toISOString().slice(0, 10);
      const summary = await getSessionCostSummary({
        agentId: agent.id,
        startDate: today,
        groupBy: "both",
      });

      expect(summary.totals.totalCostUsd).toBeGreaterThanOrEqual(0.5);
      expect(summary.totals.totalSessions).toBeGreaterThanOrEqual(1);
      expect(summary.totals.totalInputTokens).toBeGreaterThanOrEqual(1000);
      expect(summary.totals.avgCostPerSession).toBeGreaterThan(0);
      expect(summary.daily.length).toBeGreaterThanOrEqual(1);
      expect(summary.byAgent.length).toBeGreaterThanOrEqual(1);
    });

    test("should return only daily when groupBy=day", async () => {
      const summary = await getSessionCostSummary({ groupBy: "day" });

      expect(summary.totals).toBeDefined();
      expect(summary.daily.length).toBeGreaterThanOrEqual(1);
      expect(summary.byAgent.length).toBe(0);
    });

    test("should return only byAgent when groupBy=agent", async () => {
      const summary = await getSessionCostSummary({ groupBy: "agent" });

      expect(summary.totals).toBeDefined();
      expect(summary.daily.length).toBe(0);
      expect(summary.byAgent.length).toBeGreaterThanOrEqual(1);
    });

    test("should return empty results for future date range", async () => {
      const summary = await getSessionCostSummary({
        startDate: "2099-01-01",
        groupBy: "both",
      });

      expect(summary.totals.totalSessions).toBe(0);
      expect(summary.totals.totalCostUsd).toBe(0);
      expect(summary.daily.length).toBe(0);
      expect(summary.byAgent.length).toBe(0);
      expect(summary.byUser.length).toBe(0);
    });

    test("byUser splits requester spend from unattributed spend", async () => {
      const agent = await createAgent({ name: "ByUser Agent", isLead: false, status: "idle" });
      const user = await createUser({ name: "ByUser Requester" });
      const attributed = await createTaskExtended("Requested task", { requestedByUserId: user.id });
      const autonomous = await createTaskExtended("Heartbeat task");

      await createSessionCost({
        sessionId: "by-user-attributed",
        taskId: attributed.id,
        agentId: agent.id,
        totalCostUsd: 0.75,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      await createSessionCost({
        sessionId: "by-user-unattributed",
        taskId: autonomous.id,
        agentId: agent.id,
        totalCostUsd: 0.25,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });

      const summary = await getSessionCostSummary({ agentId: agent.id, groupBy: "user" });

      expect(summary.daily.length).toBe(0);
      expect(summary.byAgent.length).toBe(0);
      // The unattributed bucket is a row of its own, never folded into a person.
      const byUser = new Map(summary.byUser.map((r) => [r.userId, r]));
      expect(byUser.get(user.id)?.costUsd).toBeCloseTo(0.75, 5);
      expect(byUser.get(user.id)?.tasks).toBe(1);
      expect(byUser.get(null)?.costUsd).toBeCloseTo(0.25, 5);
      // Coverage stat: 0.75 of 1.00 carries a named requester.
      expect(summary.totals.attributedCostUsd).toBeCloseTo(0.75, 5);
      expect(summary.totals.totalCostUsd).toBeCloseTo(1.0, 5);
    });

    test("userId filter selects one requester, and `unattributed` selects the rest", async () => {
      const agent = await createAgent({ name: "UserFilter Agent", isLead: false, status: "idle" });
      const user = await createUser({ name: "UserFilter Requester" });
      const attributed = await createTaskExtended("Requested task", { requestedByUserId: user.id });
      const autonomous = await createTaskExtended("Autonomous task");

      await createSessionCost({
        sessionId: "user-filter-attributed",
        taskId: attributed.id,
        agentId: agent.id,
        totalCostUsd: 0.4,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      await createSessionCost({
        sessionId: "user-filter-unattributed",
        taskId: autonomous.id,
        agentId: agent.id,
        totalCostUsd: 0.6,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });

      const mine = await getSessionCostSummary({
        agentId: agent.id,
        userId: user.id,
        groupBy: "user",
      });
      expect(mine.totals.totalCostUsd).toBeCloseTo(0.4, 5);
      expect(mine.byUser.length).toBe(1);
      expect(mine.byUser[0]?.userId).toBe(user.id);

      const none = await getSessionCostSummary({
        agentId: agent.id,
        userId: UNATTRIBUTED_USER_ID,
        groupBy: "user",
      });
      expect(none.totals.totalCostUsd).toBeCloseTo(0.6, 5);
      expect(none.totals.attributedCostUsd).toBe(0);
      expect(none.byUser.length).toBe(1);
      expect(none.byUser[0]?.userId).toBe(null);
    });

    test("attributableCostUsd excludes structurally-human-free cost from the coverage denominator", async () => {
      const agent = await createAgent({ name: "Denominator Agent", isLead: false, status: "idle" });
      const user = await createUser({ name: "Denominator Requester" });
      const workflowUser = await createUser({ name: "Workflow Schedule Requester" });
      const humanWork = await createTaskExtended("Human-requested work", {
        requestedByUserId: user.id,
      });
      // Structurally human-free: no human requester belongs on a heartbeat-checklist
      // task by construction, even though this row carries one (a stale/inherited
      // id) — it must be excluded from BOTH sides of the coverage ratio.
      const heartbeat = await createTaskExtended("Heartbeat checklist", {
        taskType: "heartbeat-checklist",
        requestedByUserId: user.id,
      });
      const legacyHeartbeat = await createTaskExtended("Legacy heartbeat", {
        taskType: "heartbeat",
        requestedByUserId: user.id,
      });
      const tagOnlyHeartbeat = await createTaskExtended("Tag-only heartbeat", {
        tags: ["heartbeat"],
        requestedByUserId: user.id,
      });
      const scheduled = await createTaskExtended("Scheduled run", { source: "schedule" });
      const scheduledChild = await createTaskExtended("Autonomous schedule child", {
        parentTaskId: scheduled.id,
      });
      const scheduledGrandchild = await createTaskExtended("Autonomous schedule grandchild", {
        parentTaskId: scheduledChild.id,
      });
      const scheduledHumanHandoff = await createTaskExtended("Schedule handed to a human", {
        parentTaskId: scheduled.id,
        requestedByUserId: user.id,
      });
      const humanScheduled = await createTaskExtended("Human-created scheduled run", {
        source: "schedule",
        requestedByUserId: user.id,
      });
      const workflow = await createWorkflow({
        name: `denominator-workflow-${crypto.randomUUID()}`,
        definition: { nodes: [] },
      });
      const autonomousWorkflowSchedule = await createScheduledTask({
        name: `denominator-autonomous-workflow-schedule-${crypto.randomUUID()}`,
        intervalMs: 60_000,
        targetType: "workflow",
        workflowId: workflow.id,
      });
      const autonomousWorkflowRun = await createWorkflowRun({
        id: crypto.randomUUID(),
        workflowId: workflow.id,
        triggerType: "schedule",
        triggerData: { scheduleId: autonomousWorkflowSchedule.id },
      });
      const autonomousWorkflowRoot = await createTaskExtended(
        "Autonomous scheduled workflow root",
        {
          source: "workflow",
          workflowRunId: autonomousWorkflowRun.id,
        },
      );
      const humanWorkflowSchedule = await createScheduledTask({
        name: `denominator-human-workflow-schedule-${crypto.randomUUID()}`,
        intervalMs: 60_000,
        targetType: "workflow",
        workflowId: workflow.id,
        createdBy: workflowUser.id,
      });
      const humanWorkflowRun = await createWorkflowRun({
        id: crypto.randomUUID(),
        workflowId: workflow.id,
        triggerType: "schedule",
        triggerData: { scheduleId: humanWorkflowSchedule.id },
        createdBy: workflowUser.id,
      });
      const humanWorkflowRoot = await createTaskExtended("Human-created scheduled workflow root", {
        source: "workflow",
        workflowRunId: humanWorkflowRun.id,
        requestedByUserId: workflowUser.id,
      });
      const manualWorkflowRun = await createWorkflowRun({
        id: crypto.randomUUID(),
        workflowId: workflow.id,
        // Caller-controlled trigger data can mimic the scheduled payload; the
        // server-owned workflow_runs.triggerType must remain authoritative.
        triggerData: {
          triggerType: "schedule",
          scheduleId: autonomousWorkflowSchedule.id,
          scheduleName: autonomousWorkflowSchedule.name,
          scheduleCreatedBy: null,
          firedAt: new Date().toISOString(),
        },
      });
      const manualWorkflowRoot = await createTaskExtended("Requester-less manual workflow root", {
        source: "workflow",
        workflowRunId: manualWorkflowRun.id,
      });
      // Historical classification must not depend on the live schedule row.
      expect(await deleteScheduledTask(autonomousWorkflowSchedule.id)).toBe(true);

      await createSessionCost({
        sessionId: "denom-human",
        taskId: humanWork.id,
        agentId: agent.id,
        totalCostUsd: 1.0,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      await createSessionCost({
        sessionId: "denom-heartbeat",
        taskId: heartbeat.id,
        agentId: agent.id,
        totalCostUsd: 2.0,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      await createSessionCost({
        sessionId: "denom-legacy-heartbeat",
        taskId: legacyHeartbeat.id,
        agentId: agent.id,
        totalCostUsd: 4.0,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      await createSessionCost({
        sessionId: "denom-scheduled",
        taskId: scheduled.id,
        agentId: agent.id,
        totalCostUsd: 3.0,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      await createSessionCost({
        sessionId: "denom-tag-only-heartbeat",
        taskId: tagOnlyHeartbeat.id,
        agentId: agent.id,
        totalCostUsd: 5.0,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      await createSessionCost({
        sessionId: "denom-human-scheduled",
        taskId: humanScheduled.id,
        agentId: agent.id,
        totalCostUsd: 6.0,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      await createSessionCost({
        sessionId: "denom-scheduled-grandchild",
        taskId: scheduledGrandchild.id,
        agentId: agent.id,
        totalCostUsd: 8.0,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      await createSessionCost({
        sessionId: "denom-scheduled-human-handoff",
        taskId: scheduledHumanHandoff.id,
        agentId: agent.id,
        totalCostUsd: 9.0,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      await createSessionCost({
        sessionId: "denom-autonomous-workflow-root",
        taskId: autonomousWorkflowRoot.id,
        agentId: agent.id,
        totalCostUsd: 10.0,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      await createSessionCost({
        sessionId: "denom-human-workflow-root",
        taskId: humanWorkflowRoot.id,
        agentId: agent.id,
        totalCostUsd: 11.0,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      await createSessionCost({
        sessionId: "denom-manual-workflow-root",
        taskId: manualWorkflowRoot.id,
        agentId: agent.id,
        totalCostUsd: 12.0,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });

      const summary = await getSessionCostSummary({ agentId: agent.id, groupBy: "both" });

      expect(summary.totals.totalCostUsd).toBeCloseTo(71.0, 5);
      // Direct human work, a human-created schedule, and an explicitly
      // attributed handoff stay attributed, including a workflow root launched
      // by a human-created schedule. Stale heartbeat requesters, autonomous
      // schedule descendants, and creatorless scheduled workflow roots do not.
      expect(summary.totals.attributedCostUsd).toBeCloseTo(27.0, 5);
      // Denominator drops both heartbeat task types, the tag-only legacy
      // representation, autonomous scheduled cost and its grandchild, and the
      // creatorless scheduled workflow root (2.0 + 4.0 + 5.0 + 3.0 + 8.0 +
      // 10.0), leaving the human work plus the requester-less manual workflow
      // run in the population that could carry a human requester.
      expect(summary.totals.attributableCostUsd).toBeCloseTo(39.0, 5);
      expect(summary.totals.excludedCostUsd).toBeCloseTo(32.0, 5);
      expect(summary.totals.excludedTaskCount).toBe(6);

      expect(summary.byUser.find((row) => row.userId === user.id)?.costUsd).toBeCloseTo(16.0, 5);
      expect(summary.byUser.find((row) => row.userId === workflowUser.id)?.costUsd).toBeCloseTo(
        11.0,
        5,
      );
      expect(summary.byUser.find((row) => row.userId === null)?.costUsd).toBeCloseTo(44.0, 5);

      const mine = await getSessionCostSummary({
        agentId: agent.id,
        userId: user.id,
        groupBy: "user",
      });
      expect(mine.totals.totalCostUsd).toBeCloseTo(16.0, 5);
      expect(mine.byUser).toHaveLength(1);
      expect(mine.byUser[0]?.userId).toBe(user.id);

      const autonomous = await getSessionCostSummary({
        agentId: agent.id,
        userId: UNATTRIBUTED_USER_ID,
        groupBy: "user",
      });
      expect(autonomous.totals.totalCostUsd).toBeCloseTo(44.0, 5);
      expect(autonomous.byUser).toHaveLength(1);
      expect(autonomous.byUser[0]?.userId).toBe(null);

      const attribution = await getAttributionByPerson({});
      const workflowPerson = attribution.find((row) => row.userId === workflowUser.id);
      // Of the two workflow roots above, only the one launched by the
      // human-created schedule belongs in the per-person report.
      expect(workflowPerson?.problemsInitiated).toBe(1);
    });

    test("inherited requesters do not end human-free propagation", async () => {
      const agent = await createAgent({
        name: "Inherited Requester Agent",
        isLead: false,
        status: "idle",
      });
      const user = await createUser({ name: "Inherited Requester" });
      const heartbeat = await createTaskExtended("Stale attributed heartbeat", {
        taskType: "heartbeat-checklist",
        requestedByUserId: user.id,
      });
      const inheritedChild = await createTaskExtended("Autonomous heartbeat child", {
        parentTaskId: heartbeat.id,
      });
      const explicitHandoff = await createTaskExtended("Explicit human handoff", {
        parentTaskId: heartbeat.id,
        requestedByUserId: user.id,
      });

      await createSessionCost({
        sessionId: "inherited-requester-child",
        taskId: inheritedChild.id,
        agentId: agent.id,
        totalCostUsd: 2,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      await createSessionCost({
        sessionId: "explicit-requester-handoff",
        taskId: explicitHandoff.id,
        agentId: agent.id,
        totalCostUsd: 3,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });

      const summary = await getSessionCostSummary({ agentId: agent.id, groupBy: "user" });
      expect(summary.totals.totalCostUsd).toBe(5);
      expect(summary.totals.attributedCostUsd).toBe(3);
      expect(summary.totals.attributableCostUsd).toBe(3);
      expect(summary.totals.excludedCostUsd).toBe(2);
      expect(summary.byUser.find((row) => row.userId === user.id)?.costUsd).toBe(3);
      expect(summary.byUser.find((row) => row.userId === null)?.costUsd).toBe(2);
    });
  });

  describe("Database: getDashboardCostSummary", () => {
    test("should return costToday and costMtd", async () => {
      const result = await getDashboardCostSummary();

      expect(typeof result.costToday).toBe("number");
      expect(typeof result.costMtd).toBe("number");
      // costMtd should be >= costToday since MTD includes today
      expect(result.costMtd).toBeGreaterThanOrEqual(result.costToday);
    });
  });

  describe("GET /api/session-costs with date filtering", () => {
    test("should filter by startDate", async () => {
      const agent = await createAgent({ name: "Date Filter Agent", isLead: false, status: "idle" });

      await createSessionCost({
        sessionId: "date-filter-1",
        agentId: agent.id,
        totalCostUsd: 0.05,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });

      const today = new Date().toISOString().slice(0, 10);
      const response = await fetch(
        `${baseUrl}/api/session-costs?agentId=${agent.id}&startDate=${today}`,
      );

      expect(response.status).toBe(200);
      const data = (await response.json()) as { costs: SessionCost[] };
      expect(data.costs.length).toBeGreaterThanOrEqual(1);
    });

    test("should return empty for future startDate", async () => {
      const response = await fetch(`${baseUrl}/api/session-costs?startDate=2099-01-01`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as { costs: SessionCost[] };
      expect(data.costs.length).toBe(0);
    });
  });

  describe("GET /api/session-costs/summary", () => {
    test("should return aggregated summary", async () => {
      const response = await fetch(`${baseUrl}/api/session-costs/summary`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        totals: { totalCostUsd: number; totalSessions: number };
        daily: unknown[];
        byAgent: unknown[];
      };
      expect(data.totals).toBeDefined();
      expect(data.totals.totalSessions).toBeGreaterThan(0);
      expect(data.daily.length).toBeGreaterThan(0);
      expect(data.byAgent.length).toBeGreaterThan(0);
    });

    test("should filter by startDate and endDate", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const response = await fetch(
        `${baseUrl}/api/session-costs/summary?startDate=${today}&endDate=${today}`,
      );

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        totals: { totalSessions: number };
      };
      expect(data.totals.totalSessions).toBeGreaterThanOrEqual(0);
    });

    test("should respect groupBy=day", async () => {
      const response = await fetch(`${baseUrl}/api/session-costs/summary?groupBy=day`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        daily: unknown[];
        byAgent: unknown[];
      };
      expect(data.daily.length).toBeGreaterThan(0);
      expect(data.byAgent.length).toBe(0);
    });

    test("should reject invalid groupBy", async () => {
      const response = await fetch(`${baseUrl}/api/session-costs/summary?groupBy=invalid`);

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toContain("Invalid groupBy");
    });
  });

  describe("GET /api/session-costs/dashboard", () => {
    test("should return costToday and costMtd", async () => {
      const response = await fetch(`${baseUrl}/api/session-costs/dashboard`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as { costToday: number; costMtd: number };
      expect(typeof data.costToday).toBe("number");
      expect(typeof data.costMtd).toBe("number");
      expect(data.costMtd).toBeGreaterThanOrEqual(data.costToday);
    });
  });

  describe("Database: getAttributionByPerson", () => {
    test("excludes inherited requesters below human-free roots from reach", async () => {
      const rootAgent = await createAgent({
        name: "Reach Root Agent",
        isLead: false,
        status: "idle",
      });
      const inheritedAgent = await createAgent({
        name: "Reach Inherited Agent",
        isLead: false,
        status: "idle",
      });
      const handoffAgent = await createAgent({
        name: "Reach Handoff Agent",
        isLead: false,
        status: "idle",
      });
      const user = await createUser({ name: "Reach Requester" });
      await createTaskExtended("Human root", {
        requestedByUserId: user.id,
        agentId: rootAgent.id,
        source: "slack",
        vcsRepo: "example/human-root",
      });
      const heartbeat = await createTaskExtended("Heartbeat root", {
        requestedByUserId: user.id,
        taskType: "heartbeat-checklist",
      });
      await createTaskExtended("Inherited autonomous child", {
        parentTaskId: heartbeat.id,
        agentId: inheritedAgent.id,
        source: "jira",
        vcsRepo: "example/autonomous",
      });
      await createTaskExtended("Explicit handoff child", {
        parentTaskId: heartbeat.id,
        requestedByUserId: user.id,
        agentId: handoffAgent.id,
        source: "linear",
        vcsRepo: "example/handoff",
      });

      const mine = (await getAttributionByPerson({})).find((row) => row.userId === user.id);
      expect(mine?.problemsInitiated).toBe(1);
      expect(mine?.agentsReached).toBe(2);
      expect(mine?.reposReached).toBe(2);
      expect(mine?.surfacesReached).toBe(2);
    });

    test("counts root tasks only, and reach across the full task tree", async () => {
      const agentA = await createAgent({
        name: "Attribution Agent A",
        isLead: false,
        status: "idle",
      });
      const agentB = await createAgent({
        name: "Attribution Agent B",
        isLead: false,
        status: "idle",
      });
      const user = await createUser({ name: "Attribution Requester" });

      const root = await createTaskExtended("Root problem", {
        requestedByUserId: user.id,
        vcsRepo: "desplega-ai/agent-swarm",
        agentId: agentA.id,
      });
      // Fan-out child of the same root — must NOT inflate problemsInitiated,
      // but DOES count toward reach (a second agent engaged).
      await createTaskExtended("Fan-out child", {
        requestedByUserId: user.id,
        parentTaskId: root.id,
        agentId: agentB.id,
        vcsRepo: "desplega-ai/agent-swarm",
      });
      // Structurally human-free despite a (stale) requester — excluded from
      // both problemsInitiated and reach.
      await createTaskExtended("Heartbeat noise", {
        requestedByUserId: user.id,
        taskType: "heartbeat-checklist",
      });
      await createTaskExtended("Legacy heartbeat noise", {
        requestedByUserId: user.id,
        taskType: "heartbeat",
      });
      await createTaskExtended("Tag-only heartbeat noise", {
        requestedByUserId: user.id,
        tags: ["heartbeat"],
      });
      await createTaskExtended("Human-created schedule", {
        requestedByUserId: user.id,
        source: "schedule",
        agentId: agentA.id,
        vcsRepo: "desplega-ai/agent-swarm",
      });

      const rows = await getAttributionByPerson({});
      const mine = rows.find((r) => r.userId === user.id);
      expect(mine).toBeDefined();
      expect(mine?.problemsInitiated).toBe(2);
      expect(mine?.agentsReached).toBe(2);
      expect(mine?.reposReached).toBe(1);
      expect(mine?.firstPassYield).toBe(null);
    });

    test("counts GitHub PR and GitLab MR evidence as shipped", async () => {
      const agent = await createAgent({ name: "Shipped Agent", isLead: false, status: "idle" });
      const user = await createUser({ name: "Shipped Requester" });

      const shippedViaAttachment = await createTaskExtended("Shipped via attachment", {
        requestedByUserId: user.id,
      });
      const attachmentChild = await createTaskExtended("Child with shipping evidence", {
        parentTaskId: shippedViaAttachment.id,
        requestedByUserId: user.id,
      });
      await insertTaskAttachment({
        taskId: attachmentChild.id,
        agentId: agent.id,
        name: "PR",
        kind: "url",
        url: "https://github.com/desplega-ai/agent-swarm/pull/1234",
      });
      await completeTask(shippedViaAttachment.id);

      const shippedViaOutput = await createTaskExtended("Shipped via output fallback", {
        requestedByUserId: user.id,
      });
      await completeTask(
        shippedViaOutput.id,
        "Opened https://github.com/desplega-ai/agent-swarm/pull/5678",
      );

      const shippedViaGitLabAttachment = await createTaskExtended("Shipped via GitLab attachment", {
        requestedByUserId: user.id,
        vcsProvider: "gitlab",
      });
      const gitLabAttachmentChild = await createTaskExtended(
        "Child with GitLab shipping evidence",
        {
          parentTaskId: shippedViaGitLabAttachment.id,
          requestedByUserId: user.id,
        },
      );
      await insertTaskAttachment({
        taskId: gitLabAttachmentChild.id,
        agentId: agent.id,
        name: "MR",
        kind: "url",
        url: "https://gitlab.example.com/group/project/-/merge_requests/1234",
      });
      await completeTask(shippedViaGitLabAttachment.id);

      const shippedViaGitLabOutput = await createTaskExtended("Shipped via GitLab output", {
        requestedByUserId: user.id,
        vcsProvider: "gitlab",
      });
      await completeTask(
        shippedViaGitLabOutput.id,
        "Opened https://gitlab.internal/group/project/-/merge_requests/5678",
      );

      const notShipped = await createTaskExtended("Not shipped", { requestedByUserId: user.id });
      await completeTask(notShipped.id, "Just some notes, no PR");

      const rows = await getAttributionByPerson({});
      const mine = rows.find((r) => r.userId === user.id);
      expect(mine?.problemsInitiated).toBe(5);
      expect(mine?.problemsShipped).toBe(4);
    });

    test("respects the date range filter", async () => {
      const user = await createUser({ name: "Date Range Requester" });
      const inRange = await createTaskExtended("In range", { requestedByUserId: user.id });
      await getDbClient().run("UPDATE agent_tasks SET createdAt = ? WHERE id = ?", [
        "2026-08-19T23:59:59.000Z",
        inRange.id,
      ]);

      const past = await getAttributionByPerson({ endDate: "2026-08-18" });
      expect(past.find((r) => r.userId === user.id)).toBeUndefined();

      const present = await getAttributionByPerson({
        startDate: "2026-08-19",
        endDate: "2026-08-19",
      });
      expect(present.find((r) => r.userId === user.id)?.problemsInitiated).toBe(1);
    });

    test("seeds task traversal with the report's root predicates", async () => {
      const querySpy = spyOn(getDbClient(), "query");
      try {
        await getAttributionByPerson({ startDate: "2026-08-19", endDate: "2026-08-19" });
        const call = querySpy.mock.calls.find(([sql]) =>
          String(sql).includes("task_tree(rootId, taskId, output)"),
        );
        const sql = String(call?.[0] ?? "");
        const seed = sql.slice(0, sql.indexOf("task_tree(rootId, taskId, output)"));

        expect(seed).toContain("selected_roots");
        expect(seed).toContain("t.requestedByUserId IS NOT NULL");
        expect(seed).toContain("t.createdAt >= ?");
        expect(seed).toContain("t.createdAt < ?");
        expect(seed).toContain("t.parentTaskId IS NULL");
        expect(seed).not.toContain("human_free_tasks");
        expect(sql).toMatch(
          /task_tree\(rootId, taskId, output\) AS \(\s*SELECT id, id, output\s*FROM selected_roots/,
        );
        expect(sql.match(/\?/g)).toHaveLength(2);

        const reachCall = querySpy.mock.calls.find(([preparedSql]) =>
          String(preparedSql).includes("task_ancestry("),
        );
        const reachSql = String(reachCall?.[0] ?? "");
        const reachSeed = reachSql.slice(0, reachSql.indexOf("task_ancestry("));
        expect(reachSeed).toContain("report_tasks");
        expect(reachSeed).toContain("t.requestedByUserId IS NOT NULL");
        expect(reachSeed).toContain("t.createdAt >= ?");
        expect(reachSeed).toContain("t.createdAt < ?");
        expect(reachSql).toContain("JOIN task_ancestry child ON parent.id = child.parentTaskId");
        expect(reachSql.match(/\?/g)).toHaveLength(2);
      } finally {
        querySpy.mockRestore();
      }
    });
  });

  describe("Database: getAttributionByPerson — old/new SQL parity", () => {
    // Test-only copy of the pre-rewrite `rootRows` statement (src/be/db.ts,
    // the "Old" SQL in the perf plan). ROOT_HUMAN_FREE_SQL is inlined verbatim
    // because the production constant is module-private. Kept here so this
    // suite pins the OLD semantics as an independent oracle: it must agree
    // with `getAttributionByPerson` both before the GROUP BY rewrite (where
    // the two are byte-identical) and after (where they must stay
    // equivalent), so a future edit that drifts the SQL's meaning fails here.
    function oldRootRowsSql(extraCondition?: string): string {
      return `WITH RECURSIVE selected_roots(id, requestedByUserId, status, output) AS (
    SELECT t.id, t.requestedByUserId, t.status, t.output
    FROM agent_tasks t
    WHERE t.requestedByUserId IS NOT NULL${extraCondition ? ` ${extraCondition}` : ""} AND t.parentTaskId IS NULL AND NOT (
        COALESCE(t.taskType, '') IN ('heartbeat', 'heartbeat-checklist', 'boot-triage')
        OR COALESCE(t.tags, '[]') LIKE '%"heartbeat"%'
        OR (COALESCE(t.source, '') = 'schedule' AND t.requestedByUserId IS NULL)
        OR (
          COALESCE(t.source, '') = 'workflow'
          AND t.requestedByUserId IS NULL
          AND EXISTS (
            SELECT 1
            FROM workflow_runs run
            WHERE run.id = t.workflowRunId
              AND run.triggerType = 'schedule'
              AND run.created_by IS NULL
          )
        )
      )
  ),
  task_tree(rootId, taskId, output) AS (
    SELECT id, id, output
    FROM selected_roots

    UNION ALL

    SELECT tree.rootId, child.id, child.output
    FROM agent_tasks child
    JOIN task_tree tree ON child.parentTaskId = tree.taskId
  )
  SELECT
    t.requestedByUserId as userId,
    COUNT(*) as initiated,
    SUM(CASE WHEN t.status = 'completed' AND (
      EXISTS (
        SELECT 1
        FROM task_tree tree
        JOIN task_attachments ta ON ta.task_id = tree.taskId
        WHERE tree.rootId = t.id
          AND ta.kind = 'url'
          AND (
            ta.url LIKE '%github.com/%/pull/%'
            OR ta.url LIKE '%/-/merge_requests/%'
          )
      )
      OR EXISTS (
        SELECT 1 FROM task_attachments ta
        JOIN task_tree tree ON tree.taskId = ta.task_id
        WHERE tree.rootId = t.id AND ta.kind = 'page'
      )
      OR EXISTS (
        SELECT 1 FROM task_tree tree
        WHERE tree.rootId = t.id
          AND (
            tree.output LIKE '%github.com/%/pull/%'
            OR tree.output LIKE '%/-/merge_requests/%'
          )
      )
    ) THEN 1 ELSE 0 END) as shipped
  FROM selected_roots t
  GROUP BY t.requestedByUserId`;
    }

    type OldRootRow = { userId: string; initiated: number; shipped: number };

    async function oldRowForUser(
      userId: string,
      extraCondition?: string,
      extraParams: string[] = [],
    ): Promise<OldRootRow | undefined> {
      const rows = await getDbClient().query<OldRootRow>(
        oldRootRowsSql(extraCondition),
        extraParams,
      );
      return rows.find((r) => r.userId === userId);
    }

    test("case 1: root with no descendants and no evidence is not shipped", async () => {
      const user = await createUser({ name: "Parity Case 1" });
      const root = await createTaskExtended("Lonely root", { requestedByUserId: user.id });
      await completeTask(root.id);

      const oldRow = await oldRowForUser(user.id);
      const newRow = (await getAttributionByPerson({})).find((r) => r.userId === user.id);

      expect(oldRow?.initiated).toBe(1);
      expect(oldRow?.shipped).toBe(0);
      expect(newRow?.problemsInitiated).toBe(oldRow?.initiated);
      expect(newRow?.problemsShipped).toBe(oldRow?.shipped);
    });

    test("case 2: root whose grandchild carries a GitHub PR url attachment is shipped", async () => {
      const agent = await createAgent({ name: "Parity Agent 2", isLead: false, status: "idle" });
      const user = await createUser({ name: "Parity Case 2" });
      const root = await createTaskExtended("Root", { requestedByUserId: user.id });
      const child = await createTaskExtended("Child", {
        parentTaskId: root.id,
        requestedByUserId: user.id,
      });
      const grandchild = await createTaskExtended("Grandchild", {
        parentTaskId: child.id,
        requestedByUserId: user.id,
      });
      await insertTaskAttachment({
        taskId: grandchild.id,
        agentId: agent.id,
        name: "PR",
        kind: "url",
        url: "https://github.com/desplega-ai/agent-swarm/pull/9001",
      });
      await completeTask(root.id);

      const oldRow = await oldRowForUser(user.id);
      const newRow = (await getAttributionByPerson({})).find((r) => r.userId === user.id);

      expect(oldRow?.shipped).toBe(1);
      expect(newRow?.problemsShipped).toBe(oldRow?.shipped);
      expect(newRow?.problemsInitiated).toBe(oldRow?.initiated);
    });

    test("case 3: root whose child carries a page attachment is shipped", async () => {
      const agent = await createAgent({ name: "Parity Agent 3", isLead: false, status: "idle" });
      const user = await createUser({ name: "Parity Case 3" });
      const root = await createTaskExtended("Root", { requestedByUserId: user.id });
      const child = await createTaskExtended("Child", {
        parentTaskId: root.id,
        requestedByUserId: user.id,
      });
      await insertTaskAttachment({
        taskId: child.id,
        agentId: agent.id,
        name: "Published page",
        kind: "page",
        pageId: crypto.randomUUID(),
      });
      await completeTask(root.id);

      const oldRow = await oldRowForUser(user.id);
      const newRow = (await getAttributionByPerson({})).find((r) => r.userId === user.id);

      expect(oldRow?.shipped).toBe(1);
      expect(newRow?.problemsShipped).toBe(oldRow?.shipped);
      expect(newRow?.problemsInitiated).toBe(oldRow?.initiated);
    });

    test("case 4: root whose own output holds a self-hosted GitLab MR URL is shipped", async () => {
      const user = await createUser({ name: "Parity Case 4" });
      const root = await createTaskExtended("Root", { requestedByUserId: user.id });
      await completeTask(
        root.id,
        "Opened https://gitlab.internal.example.com/team/proj/-/merge_requests/42",
      );

      const oldRow = await oldRowForUser(user.id);
      const newRow = (await getAttributionByPerson({})).find((r) => r.userId === user.id);

      expect(oldRow?.shipped).toBe(1);
      expect(newRow?.problemsShipped).toBe(oldRow?.shipped);
      expect(newRow?.problemsInitiated).toBe(oldRow?.initiated);
    });

    test("case 5: root whose child's output holds a GitHub PR URL is shipped", async () => {
      const user = await createUser({ name: "Parity Case 5" });
      const root = await createTaskExtended("Root", { requestedByUserId: user.id });
      const child = await createTaskExtended("Child", {
        parentTaskId: root.id,
        requestedByUserId: user.id,
      });
      await completeTask(child.id, "Opened https://github.com/desplega-ai/agent-swarm/pull/9002");
      await completeTask(root.id);

      const oldRow = await oldRowForUser(user.id);
      const newRow = (await getAttributionByPerson({})).find((r) => r.userId === user.id);

      expect(oldRow?.shipped).toBe(1);
      expect(newRow?.problemsShipped).toBe(oldRow?.shipped);
      expect(newRow?.problemsInitiated).toBe(oldRow?.initiated);
    });

    test("case 6: two qualifying attachments on the same task keep problemsInitiated at 1", async () => {
      const agent = await createAgent({ name: "Parity Agent 6", isLead: false, status: "idle" });
      const user = await createUser({ name: "Parity Case 6" });
      const root = await createTaskExtended("Root", { requestedByUserId: user.id });
      await insertTaskAttachment({
        taskId: root.id,
        agentId: agent.id,
        name: "PR",
        kind: "url",
        url: "https://github.com/desplega-ai/agent-swarm/pull/9003",
      });
      await insertTaskAttachment({
        taskId: root.id,
        agentId: agent.id,
        name: "Published page",
        kind: "page",
        pageId: crypto.randomUUID(),
      });
      await completeTask(root.id);

      const oldRow = await oldRowForUser(user.id);
      const newRow = (await getAttributionByPerson({})).find((r) => r.userId === user.id);

      expect(oldRow?.initiated).toBe(1);
      expect(oldRow?.shipped).toBe(1);
      expect(newRow?.problemsInitiated).toBe(1);
      expect(newRow?.problemsShipped).toBe(1);
    });

    test("case 7: qualifying evidence on two different descendants of one root keeps problemsInitiated at 1", async () => {
      const agent = await createAgent({ name: "Parity Agent 7", isLead: false, status: "idle" });
      const user = await createUser({ name: "Parity Case 7" });
      const root = await createTaskExtended("Root", { requestedByUserId: user.id });
      const childA = await createTaskExtended("Child A", {
        parentTaskId: root.id,
        requestedByUserId: user.id,
      });
      const childB = await createTaskExtended("Child B", {
        parentTaskId: root.id,
        requestedByUserId: user.id,
      });
      await insertTaskAttachment({
        taskId: childA.id,
        agentId: agent.id,
        name: "PR",
        kind: "url",
        url: "https://github.com/desplega-ai/agent-swarm/pull/9004",
      });
      await completeTask(childB.id, "Opened https://github.com/desplega-ai/agent-swarm/pull/9005");
      await completeTask(root.id);

      const oldRow = await oldRowForUser(user.id);
      const newRow = (await getAttributionByPerson({})).find((r) => r.userId === user.id);

      expect(oldRow?.initiated).toBe(1);
      expect(oldRow?.shipped).toBe(1);
      expect(newRow?.problemsInitiated).toBe(1);
      expect(newRow?.problemsShipped).toBe(1);
    });

    test("case 8: a url attachment matching neither PR nor MR pattern is not shipped", async () => {
      const agent = await createAgent({ name: "Parity Agent 8", isLead: false, status: "idle" });
      const user = await createUser({ name: "Parity Case 8" });
      const root = await createTaskExtended("Root", { requestedByUserId: user.id });
      await insertTaskAttachment({
        taskId: root.id,
        agentId: agent.id,
        name: "Not a PR",
        kind: "url",
        url: "https://example.com/not-a-pr",
      });
      await completeTask(root.id);

      const oldRow = await oldRowForUser(user.id);
      const newRow = (await getAttributionByPerson({})).find((r) => r.userId === user.id);

      expect(oldRow?.shipped).toBe(0);
      expect(newRow?.problemsShipped).toBe(0);
    });

    test("case 9: an agent-fs attachment only is not shipped", async () => {
      const agent = await createAgent({ name: "Parity Agent 9", isLead: false, status: "idle" });
      const user = await createUser({ name: "Parity Case 9" });
      const root = await createTaskExtended("Root", { requestedByUserId: user.id });
      await insertTaskAttachment({
        taskId: root.id,
        agentId: agent.id,
        name: "Artifact",
        kind: "agent-fs",
        path: "reports/artifact.md",
      });
      await completeTask(root.id);

      const oldRow = await oldRowForUser(user.id);
      const newRow = (await getAttributionByPerson({})).find((r) => r.userId === user.id);

      expect(oldRow?.shipped).toBe(0);
      expect(newRow?.problemsShipped).toBe(0);
    });

    test("case 10: evidence present but status is not completed is not shipped", async () => {
      const agent = await createAgent({ name: "Parity Agent 10", isLead: false, status: "idle" });
      const user = await createUser({ name: "Parity Case 10" });
      const root = await createTaskExtended("Root", { requestedByUserId: user.id });
      await insertTaskAttachment({
        taskId: root.id,
        agentId: agent.id,
        name: "PR",
        kind: "url",
        url: "https://github.com/desplega-ai/agent-swarm/pull/9006",
      });
      // Deliberately left in its default (non-completed) status.

      const oldRow = await oldRowForUser(user.id);
      const newRow = (await getAttributionByPerson({})).find((r) => r.userId === user.id);

      expect(oldRow?.initiated).toBe(1);
      expect(oldRow?.shipped).toBe(0);
      expect(newRow?.problemsShipped).toBe(0);
    });

    test("case 11: output IS NULL is not shipped and raises no error", async () => {
      const user = await createUser({ name: "Parity Case 11" });
      const root = await createTaskExtended("Root", { requestedByUserId: user.id });
      await completeTask(root.id);

      const oldRow = await oldRowForUser(user.id);
      const newRow = (await getAttributionByPerson({})).find((r) => r.userId === user.id);

      expect(oldRow?.shipped).toBe(0);
      expect(newRow?.problemsShipped).toBe(0);
    });

    test("case 12: two roots for the same user, one shipped and one not — initiated 2, shipped 1", async () => {
      const user = await createUser({ name: "Parity Case 12" });
      const shippedRoot = await createTaskExtended("Shipped root", {
        requestedByUserId: user.id,
      });
      await completeTask(
        shippedRoot.id,
        "Opened https://github.com/desplega-ai/agent-swarm/pull/9007",
      );
      const unshippedRoot = await createTaskExtended("Unshipped root", {
        requestedByUserId: user.id,
      });
      await completeTask(unshippedRoot.id);

      const oldRow = await oldRowForUser(user.id);
      const newRow = (await getAttributionByPerson({})).find((r) => r.userId === user.id);

      expect(oldRow?.initiated).toBe(2);
      expect(oldRow?.shipped).toBe(1);
      expect(newRow?.problemsInitiated).toBe(2);
      expect(newRow?.problemsShipped).toBe(1);
    });

    test("case 13: evidence on a child created after endDate still ships the root — the walk has no date filter", async () => {
      const agent = await createAgent({ name: "Parity Agent 13", isLead: false, status: "idle" });
      const user = await createUser({ name: "Parity Case 13" });
      const root = await createTaskExtended("Root", { requestedByUserId: user.id });
      await getDbClient().run("UPDATE agent_tasks SET createdAt = ? WHERE id = ?", [
        "2026-08-10T00:00:00.000Z",
        root.id,
      ]);
      const child = await createTaskExtended("Child after window", {
        parentTaskId: root.id,
        requestedByUserId: user.id,
      });
      await getDbClient().run("UPDATE agent_tasks SET createdAt = ? WHERE id = ?", [
        "2026-08-25T00:00:00.000Z",
        child.id,
      ]);
      await insertTaskAttachment({
        taskId: child.id,
        agentId: agent.id,
        name: "PR",
        kind: "url",
        url: "https://github.com/desplega-ai/agent-swarm/pull/9008",
      });
      await completeTask(root.id);

      const endDate = "2026-08-20T23:59:59.999Z";
      const oldRow = await oldRowForUser(user.id, "AND t.createdAt <= ?", [endDate]);
      const newRow = (await getAttributionByPerson({ endDate })).find((r) => r.userId === user.id);

      expect(oldRow?.shipped).toBe(1);
      expect(newRow?.problemsShipped).toBe(1);
      expect(newRow?.problemsInitiated).toBe(oldRow?.initiated);
    });

    test("shape guard: shipped_roots stays a non-correlated LEFT JOIN deduped with UNION", async () => {
      const querySpy = spyOn(getDbClient(), "query");
      try {
        await getAttributionByPerson({});
        const call = querySpy.mock.calls.find(([sql]) =>
          String(sql).includes("task_tree(rootId, taskId, output)"),
        );
        const sql = String(call?.[0] ?? "");

        // Rule 2: LEFT JOIN, never a correlated EXISTS against shipped_roots.
        // Measured regression if this reverts: 4,189 ms for a 2-day window.
        expect(sql).toContain("LEFT JOIN shipped_roots s ON s.rootId = t.id");
        expect(sql).not.toMatch(/EXISTS\s*\(\s*SELECT[^)]*FROM\s+shipped_roots/);

        // Rule 1: UNION, never UNION ALL, inside shipped_roots — the only
        // UNION ALL in this statement belongs to the task_tree recursion.
        // Strip `--` comments first: the explanatory comment above
        // shipped_roots mentions "UNION ALL" in prose.
        const sqlWithoutComments = sql.replace(/--[^\n]*/g, "");
        expect((sqlWithoutComments.match(/UNION ALL/g) ?? []).length).toBe(1);
        const shippedRootsIdx = sqlWithoutComments.indexOf("shipped_roots(rootId) AS (");
        expect(shippedRootsIdx).toBeGreaterThan(-1);
        const afterShippedRoots = sqlWithoutComments.slice(shippedRootsIdx);
        const finalSelectIdx = afterShippedRoots.indexOf(
          "SELECT\n        t.requestedByUserId as userId,",
        );
        expect(finalSelectIdx).toBeGreaterThan(-1);
        const shippedRootsBody = afterShippedRoots.slice(0, finalSelectIdx);
        expect(shippedRootsBody).toMatch(/\bUNION\b(?!\s*ALL)/);
        expect(shippedRootsBody).not.toContain("UNION ALL");
      } finally {
        querySpy.mockRestore();
      }
    });
  });
});
