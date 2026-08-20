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
  getDb,
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
      const cost = createSessionCost({
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
    const summary = getSessionCostSummary({
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
    const dashboardCosts = getDashboardCostSummary();
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
      costs = getSessionCostsByTaskId(taskId, limit);
    } else if (startDate || endDate) {
      costs = getSessionCostsFiltered({
        agentId: agentId || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        limit,
      });
    } else if (agentId) {
      costs = getSessionCostsByAgentId(agentId, limit);
    } else {
      costs = getAllSessionCosts(limit);
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
    testAgent = createAgent({
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
    test("should create and retrieve session cost by agentId", () => {
      const cost = createSessionCost({
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
      const costs = getSessionCostsByAgentId(testAgent.id);
      expect(costs.length).toBeGreaterThanOrEqual(1);
      expect(costs.find((c) => c.id === cost.id)).toBeDefined();
    });

    test("should create session cost with taskId", () => {
      const task = createTaskExtended("Test task for session cost");

      const cost = createSessionCost({
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
      const costs = getSessionCostsByTaskId(task.id);
      expect(costs.length).toBe(1);
      expect(costs[0]?.sessionId).toBe("db-test-session-2");
      expect(costs[0]?.totalCostUsd).toBe(0.1);
    });

    test("should create session cost with all optional fields", () => {
      const cost = createSessionCost({
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

    test("should retrieve all session costs with limit", () => {
      // Create multiple costs
      for (let i = 0; i < 5; i++) {
        createSessionCost({
          sessionId: `db-test-batch-${i}`,
          agentId: testAgent.id,
          totalCostUsd: 0.01 * (i + 1),
          durationMs: 1000 * (i + 1),
          numTurns: i + 1,
          model: "opus",
        });
      }

      const costs = getAllSessionCosts(3);
      expect(costs.length).toBe(3);
    });

    test("should order session costs by createdAt DESC", () => {
      const agent2 = createAgent({ name: "Cost Order Agent", isLead: false, status: "idle" });

      // Create costs with slight delays to ensure different timestamps
      createSessionCost({
        sessionId: "order-test-1",
        agentId: agent2.id,
        totalCostUsd: 0.01,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });

      createSessionCost({
        sessionId: "order-test-2",
        agentId: agent2.id,
        totalCostUsd: 0.02,
        durationMs: 2000,
        numTurns: 2,
        model: "opus",
      });

      const costs = getSessionCostsByAgentId(agent2.id);
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
      const task = createTaskExtended("API test task for cost");

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
      const uniqueAgent = createAgent({ name: "Filter Test Agent", isLead: false, status: "idle" });

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
      const task = createTaskExtended("Filter test task");

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
    test("session cost object should match SessionCost type structure", () => {
      const cost = createSessionCost({
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

    test("session cost should have valid UUID id", () => {
      const cost = createSessionCost({
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

    test("session cost createdAt should be valid ISO datetime", () => {
      const cost = createSessionCost({
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
      const agent = createAgent({ name: "Token Query Agent", isLead: false, status: "idle" });

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
    test("should filter by date range", () => {
      const agent = createAgent({ name: "Filter DB Agent", isLead: false, status: "idle" });

      createSessionCost({
        sessionId: "filtered-db-1",
        agentId: agent.id,
        totalCostUsd: 0.1,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });

      // All records created today, so filtering with today's date should return them
      const today = new Date().toISOString().slice(0, 10);
      const results = getSessionCostsFiltered({
        agentId: agent.id,
        startDate: today,
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => r.agentId === agent.id)).toBe(true);
    });

    test("should return empty for future date range", () => {
      const results = getSessionCostsFiltered({
        startDate: "2099-01-01",
      });

      expect(results.length).toBe(0);
    });

    test("should respect limit parameter", () => {
      const agent = createAgent({ name: "Filter Limit Agent", isLead: false, status: "idle" });

      for (let i = 0; i < 5; i++) {
        createSessionCost({
          sessionId: `filter-limit-${i}`,
          agentId: agent.id,
          totalCostUsd: 0.01,
          durationMs: 1000,
          numTurns: 1,
          model: "opus",
        });
      }

      const results = getSessionCostsFiltered({ agentId: agent.id, limit: 2 });
      expect(results.length).toBe(2);
    });
  });

  describe("Database: getSessionCostSummary", () => {
    test("should return totals, daily, and byAgent", () => {
      const agent = createAgent({ name: "Summary DB Agent", isLead: false, status: "idle" });

      createSessionCost({
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
      const summary = getSessionCostSummary({
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

    test("should return only daily when groupBy=day", () => {
      const summary = getSessionCostSummary({ groupBy: "day" });

      expect(summary.totals).toBeDefined();
      expect(summary.daily.length).toBeGreaterThanOrEqual(1);
      expect(summary.byAgent.length).toBe(0);
    });

    test("should return only byAgent when groupBy=agent", () => {
      const summary = getSessionCostSummary({ groupBy: "agent" });

      expect(summary.totals).toBeDefined();
      expect(summary.daily.length).toBe(0);
      expect(summary.byAgent.length).toBeGreaterThanOrEqual(1);
    });

    test("should return empty results for future date range", () => {
      const summary = getSessionCostSummary({
        startDate: "2099-01-01",
        groupBy: "both",
      });

      expect(summary.totals.totalSessions).toBe(0);
      expect(summary.totals.totalCostUsd).toBe(0);
      expect(summary.daily.length).toBe(0);
      expect(summary.byAgent.length).toBe(0);
      expect(summary.byUser.length).toBe(0);
    });

    test("byUser splits requester spend from unattributed spend", () => {
      const agent = createAgent({ name: "ByUser Agent", isLead: false, status: "idle" });
      const user = createUser({ name: "ByUser Requester" });
      const attributed = createTaskExtended("Requested task", { requestedByUserId: user.id });
      const autonomous = createTaskExtended("Heartbeat task");

      createSessionCost({
        sessionId: "by-user-attributed",
        taskId: attributed.id,
        agentId: agent.id,
        totalCostUsd: 0.75,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      createSessionCost({
        sessionId: "by-user-unattributed",
        taskId: autonomous.id,
        agentId: agent.id,
        totalCostUsd: 0.25,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });

      const summary = getSessionCostSummary({ agentId: agent.id, groupBy: "user" });

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

    test("userId filter selects one requester, and `unattributed` selects the rest", () => {
      const agent = createAgent({ name: "UserFilter Agent", isLead: false, status: "idle" });
      const user = createUser({ name: "UserFilter Requester" });
      const attributed = createTaskExtended("Requested task", { requestedByUserId: user.id });
      const autonomous = createTaskExtended("Autonomous task");

      createSessionCost({
        sessionId: "user-filter-attributed",
        taskId: attributed.id,
        agentId: agent.id,
        totalCostUsd: 0.4,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      createSessionCost({
        sessionId: "user-filter-unattributed",
        taskId: autonomous.id,
        agentId: agent.id,
        totalCostUsd: 0.6,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });

      const mine = getSessionCostSummary({ agentId: agent.id, userId: user.id, groupBy: "user" });
      expect(mine.totals.totalCostUsd).toBeCloseTo(0.4, 5);
      expect(mine.byUser.length).toBe(1);
      expect(mine.byUser[0]?.userId).toBe(user.id);

      const none = getSessionCostSummary({
        agentId: agent.id,
        userId: UNATTRIBUTED_USER_ID,
        groupBy: "user",
      });
      expect(none.totals.totalCostUsd).toBeCloseTo(0.6, 5);
      expect(none.totals.attributedCostUsd).toBe(0);
      expect(none.byUser.length).toBe(1);
      expect(none.byUser[0]?.userId).toBe(null);
    });

    test("attributableCostUsd excludes structurally-human-free cost from the coverage denominator", () => {
      const agent = createAgent({ name: "Denominator Agent", isLead: false, status: "idle" });
      const user = createUser({ name: "Denominator Requester" });
      const workflowUser = createUser({ name: "Workflow Schedule Requester" });
      const humanWork = createTaskExtended("Human-requested work", { requestedByUserId: user.id });
      // Structurally human-free: no human requester belongs on a heartbeat-checklist
      // task by construction, even though this row carries one (a stale/inherited
      // id) — it must be excluded from BOTH sides of the coverage ratio.
      const heartbeat = createTaskExtended("Heartbeat checklist", {
        taskType: "heartbeat-checklist",
        requestedByUserId: user.id,
      });
      const legacyHeartbeat = createTaskExtended("Legacy heartbeat", {
        taskType: "heartbeat",
        requestedByUserId: user.id,
      });
      const tagOnlyHeartbeat = createTaskExtended("Tag-only heartbeat", {
        tags: ["heartbeat"],
        requestedByUserId: user.id,
      });
      const scheduled = createTaskExtended("Scheduled run", { source: "schedule" });
      const scheduledChild = createTaskExtended("Autonomous schedule child", {
        parentTaskId: scheduled.id,
      });
      const scheduledGrandchild = createTaskExtended("Autonomous schedule grandchild", {
        parentTaskId: scheduledChild.id,
      });
      const scheduledHumanHandoff = createTaskExtended("Schedule handed to a human", {
        parentTaskId: scheduled.id,
        requestedByUserId: user.id,
      });
      const humanScheduled = createTaskExtended("Human-created scheduled run", {
        source: "schedule",
        requestedByUserId: user.id,
      });
      const workflow = createWorkflow({
        name: `denominator-workflow-${crypto.randomUUID()}`,
        definition: { nodes: [] },
      });
      const autonomousWorkflowSchedule = createScheduledTask({
        name: `denominator-autonomous-workflow-schedule-${crypto.randomUUID()}`,
        intervalMs: 60_000,
        targetType: "workflow",
        workflowId: workflow.id,
      });
      const autonomousWorkflowRun = createWorkflowRun({
        id: crypto.randomUUID(),
        workflowId: workflow.id,
        triggerType: "schedule",
        triggerData: { scheduleId: autonomousWorkflowSchedule.id },
      });
      const autonomousWorkflowRoot = createTaskExtended("Autonomous scheduled workflow root", {
        source: "workflow",
        workflowRunId: autonomousWorkflowRun.id,
      });
      const humanWorkflowSchedule = createScheduledTask({
        name: `denominator-human-workflow-schedule-${crypto.randomUUID()}`,
        intervalMs: 60_000,
        targetType: "workflow",
        workflowId: workflow.id,
        createdBy: workflowUser.id,
      });
      const humanWorkflowRun = createWorkflowRun({
        id: crypto.randomUUID(),
        workflowId: workflow.id,
        triggerType: "schedule",
        triggerData: { scheduleId: humanWorkflowSchedule.id },
        createdBy: workflowUser.id,
      });
      const humanWorkflowRoot = createTaskExtended("Human-created scheduled workflow root", {
        source: "workflow",
        workflowRunId: humanWorkflowRun.id,
        requestedByUserId: workflowUser.id,
      });
      const manualWorkflowRun = createWorkflowRun({
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
      const manualWorkflowRoot = createTaskExtended("Requester-less manual workflow root", {
        source: "workflow",
        workflowRunId: manualWorkflowRun.id,
      });
      // Historical classification must not depend on the live schedule row.
      expect(deleteScheduledTask(autonomousWorkflowSchedule.id)).toBe(true);

      createSessionCost({
        sessionId: "denom-human",
        taskId: humanWork.id,
        agentId: agent.id,
        totalCostUsd: 1.0,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      createSessionCost({
        sessionId: "denom-heartbeat",
        taskId: heartbeat.id,
        agentId: agent.id,
        totalCostUsd: 2.0,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      createSessionCost({
        sessionId: "denom-legacy-heartbeat",
        taskId: legacyHeartbeat.id,
        agentId: agent.id,
        totalCostUsd: 4.0,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      createSessionCost({
        sessionId: "denom-scheduled",
        taskId: scheduled.id,
        agentId: agent.id,
        totalCostUsd: 3.0,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      createSessionCost({
        sessionId: "denom-tag-only-heartbeat",
        taskId: tagOnlyHeartbeat.id,
        agentId: agent.id,
        totalCostUsd: 5.0,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      createSessionCost({
        sessionId: "denom-human-scheduled",
        taskId: humanScheduled.id,
        agentId: agent.id,
        totalCostUsd: 6.0,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      createSessionCost({
        sessionId: "denom-scheduled-grandchild",
        taskId: scheduledGrandchild.id,
        agentId: agent.id,
        totalCostUsd: 8.0,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      createSessionCost({
        sessionId: "denom-scheduled-human-handoff",
        taskId: scheduledHumanHandoff.id,
        agentId: agent.id,
        totalCostUsd: 9.0,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      createSessionCost({
        sessionId: "denom-autonomous-workflow-root",
        taskId: autonomousWorkflowRoot.id,
        agentId: agent.id,
        totalCostUsd: 10.0,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      createSessionCost({
        sessionId: "denom-human-workflow-root",
        taskId: humanWorkflowRoot.id,
        agentId: agent.id,
        totalCostUsd: 11.0,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      createSessionCost({
        sessionId: "denom-manual-workflow-root",
        taskId: manualWorkflowRoot.id,
        agentId: agent.id,
        totalCostUsd: 12.0,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });

      const summary = getSessionCostSummary({ agentId: agent.id, groupBy: "both" });

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

      const mine = getSessionCostSummary({ agentId: agent.id, userId: user.id, groupBy: "user" });
      expect(mine.totals.totalCostUsd).toBeCloseTo(16.0, 5);
      expect(mine.byUser).toHaveLength(1);
      expect(mine.byUser[0]?.userId).toBe(user.id);

      const autonomous = getSessionCostSummary({
        agentId: agent.id,
        userId: UNATTRIBUTED_USER_ID,
        groupBy: "user",
      });
      expect(autonomous.totals.totalCostUsd).toBeCloseTo(44.0, 5);
      expect(autonomous.byUser).toHaveLength(1);
      expect(autonomous.byUser[0]?.userId).toBe(null);

      const attribution = getAttributionByPerson({});
      const workflowPerson = attribution.find((row) => row.userId === workflowUser.id);
      // Of the two workflow roots above, only the one launched by the
      // human-created schedule belongs in the per-person report.
      expect(workflowPerson?.problemsInitiated).toBe(1);
    });

    test("inherited requesters do not end human-free propagation", () => {
      const agent = createAgent({
        name: "Inherited Requester Agent",
        isLead: false,
        status: "idle",
      });
      const user = createUser({ name: "Inherited Requester" });
      const heartbeat = createTaskExtended("Stale attributed heartbeat", {
        taskType: "heartbeat-checklist",
        requestedByUserId: user.id,
      });
      const inheritedChild = createTaskExtended("Autonomous heartbeat child", {
        parentTaskId: heartbeat.id,
      });
      const explicitHandoff = createTaskExtended("Explicit human handoff", {
        parentTaskId: heartbeat.id,
        requestedByUserId: user.id,
      });

      createSessionCost({
        sessionId: "inherited-requester-child",
        taskId: inheritedChild.id,
        agentId: agent.id,
        totalCostUsd: 2,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
      createSessionCost({
        sessionId: "explicit-requester-handoff",
        taskId: explicitHandoff.id,
        agentId: agent.id,
        totalCostUsd: 3,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });

      const summary = getSessionCostSummary({ agentId: agent.id, groupBy: "user" });
      expect(summary.totals.totalCostUsd).toBe(5);
      expect(summary.totals.attributedCostUsd).toBe(3);
      expect(summary.totals.attributableCostUsd).toBe(3);
      expect(summary.totals.excludedCostUsd).toBe(2);
      expect(summary.byUser.find((row) => row.userId === user.id)?.costUsd).toBe(3);
      expect(summary.byUser.find((row) => row.userId === null)?.costUsd).toBe(2);
    });
  });

  describe("Database: getDashboardCostSummary", () => {
    test("should return costToday and costMtd", () => {
      const result = getDashboardCostSummary();

      expect(typeof result.costToday).toBe("number");
      expect(typeof result.costMtd).toBe("number");
      // costMtd should be >= costToday since MTD includes today
      expect(result.costMtd).toBeGreaterThanOrEqual(result.costToday);
    });
  });

  describe("GET /api/session-costs with date filtering", () => {
    test("should filter by startDate", async () => {
      const agent = createAgent({ name: "Date Filter Agent", isLead: false, status: "idle" });

      createSessionCost({
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
    test("excludes inherited requesters below human-free roots from reach", () => {
      const rootAgent = createAgent({ name: "Reach Root Agent", isLead: false, status: "idle" });
      const inheritedAgent = createAgent({
        name: "Reach Inherited Agent",
        isLead: false,
        status: "idle",
      });
      const handoffAgent = createAgent({
        name: "Reach Handoff Agent",
        isLead: false,
        status: "idle",
      });
      const user = createUser({ name: "Reach Requester" });
      createTaskExtended("Human root", {
        requestedByUserId: user.id,
        agentId: rootAgent.id,
        source: "slack",
        vcsRepo: "example/human-root",
      });
      const heartbeat = createTaskExtended("Heartbeat root", {
        requestedByUserId: user.id,
        taskType: "heartbeat-checklist",
      });
      createTaskExtended("Inherited autonomous child", {
        parentTaskId: heartbeat.id,
        agentId: inheritedAgent.id,
        source: "jira",
        vcsRepo: "example/autonomous",
      });
      createTaskExtended("Explicit handoff child", {
        parentTaskId: heartbeat.id,
        requestedByUserId: user.id,
        agentId: handoffAgent.id,
        source: "linear",
        vcsRepo: "example/handoff",
      });

      const mine = getAttributionByPerson({}).find((row) => row.userId === user.id);
      expect(mine?.problemsInitiated).toBe(1);
      expect(mine?.agentsReached).toBe(2);
      expect(mine?.reposReached).toBe(2);
      expect(mine?.surfacesReached).toBe(2);
    });

    test("counts root tasks only, and reach across the full task tree", () => {
      const agentA = createAgent({ name: "Attribution Agent A", isLead: false, status: "idle" });
      const agentB = createAgent({ name: "Attribution Agent B", isLead: false, status: "idle" });
      const user = createUser({ name: "Attribution Requester" });

      const root = createTaskExtended("Root problem", {
        requestedByUserId: user.id,
        vcsRepo: "desplega-ai/agent-swarm",
        agentId: agentA.id,
      });
      // Fan-out child of the same root — must NOT inflate problemsInitiated,
      // but DOES count toward reach (a second agent engaged).
      createTaskExtended("Fan-out child", {
        requestedByUserId: user.id,
        parentTaskId: root.id,
        agentId: agentB.id,
        vcsRepo: "desplega-ai/agent-swarm",
      });
      // Structurally human-free despite a (stale) requester — excluded from
      // both problemsInitiated and reach.
      createTaskExtended("Heartbeat noise", {
        requestedByUserId: user.id,
        taskType: "heartbeat-checklist",
      });
      createTaskExtended("Legacy heartbeat noise", {
        requestedByUserId: user.id,
        taskType: "heartbeat",
      });
      createTaskExtended("Tag-only heartbeat noise", {
        requestedByUserId: user.id,
        tags: ["heartbeat"],
      });
      createTaskExtended("Human-created schedule", {
        requestedByUserId: user.id,
        source: "schedule",
        agentId: agentA.id,
        vcsRepo: "desplega-ai/agent-swarm",
      });

      const rows = getAttributionByPerson({});
      const mine = rows.find((r) => r.userId === user.id);
      expect(mine).toBeDefined();
      expect(mine?.problemsInitiated).toBe(2);
      expect(mine?.agentsReached).toBe(2);
      expect(mine?.reposReached).toBe(1);
      expect(mine?.firstPassYield).toBe(null);
    });

    test("counts GitHub PR and GitLab MR evidence as shipped", () => {
      const agent = createAgent({ name: "Shipped Agent", isLead: false, status: "idle" });
      const user = createUser({ name: "Shipped Requester" });

      const shippedViaAttachment = createTaskExtended("Shipped via attachment", {
        requestedByUserId: user.id,
      });
      const attachmentChild = createTaskExtended("Child with shipping evidence", {
        parentTaskId: shippedViaAttachment.id,
        requestedByUserId: user.id,
      });
      insertTaskAttachment({
        taskId: attachmentChild.id,
        agentId: agent.id,
        name: "PR",
        kind: "url",
        url: "https://github.com/desplega-ai/agent-swarm/pull/1234",
      });
      completeTask(shippedViaAttachment.id);

      const shippedViaOutput = createTaskExtended("Shipped via output fallback", {
        requestedByUserId: user.id,
      });
      completeTask(
        shippedViaOutput.id,
        "Opened https://github.com/desplega-ai/agent-swarm/pull/5678",
      );

      const shippedViaGitLabAttachment = createTaskExtended("Shipped via GitLab attachment", {
        requestedByUserId: user.id,
        vcsProvider: "gitlab",
      });
      const gitLabAttachmentChild = createTaskExtended("Child with GitLab shipping evidence", {
        parentTaskId: shippedViaGitLabAttachment.id,
        requestedByUserId: user.id,
      });
      insertTaskAttachment({
        taskId: gitLabAttachmentChild.id,
        agentId: agent.id,
        name: "MR",
        kind: "url",
        url: "https://gitlab.example.com/group/project/-/merge_requests/1234",
      });
      completeTask(shippedViaGitLabAttachment.id);

      const shippedViaGitLabOutput = createTaskExtended("Shipped via GitLab output", {
        requestedByUserId: user.id,
        vcsProvider: "gitlab",
      });
      completeTask(
        shippedViaGitLabOutput.id,
        "Opened https://gitlab.internal/group/project/-/merge_requests/5678",
      );

      const notShipped = createTaskExtended("Not shipped", { requestedByUserId: user.id });
      completeTask(notShipped.id, "Just some notes, no PR");

      const rows = getAttributionByPerson({});
      const mine = rows.find((r) => r.userId === user.id);
      expect(mine?.problemsInitiated).toBe(5);
      expect(mine?.problemsShipped).toBe(4);
    });

    test("respects the date range filter", () => {
      const user = createUser({ name: "Date Range Requester" });
      const inRange = createTaskExtended("In range", { requestedByUserId: user.id });
      getDb()
        .prepare("UPDATE agent_tasks SET createdAt = ? WHERE id = ?")
        .run("2026-08-19T23:59:59.000Z", inRange.id);

      const past = getAttributionByPerson({ endDate: "2026-08-18" });
      expect(past.find((r) => r.userId === user.id)).toBeUndefined();

      const present = getAttributionByPerson({
        startDate: "2026-08-19",
        endDate: "2026-08-19",
      });
      expect(present.find((r) => r.userId === user.id)?.problemsInitiated).toBe(1);
    });

    test("seeds task traversal with the report's root predicates", () => {
      const prepareSpy = spyOn(getDb(), "prepare");
      try {
        getAttributionByPerson({ startDate: "2026-08-19", endDate: "2026-08-19" });
        const call = prepareSpy.mock.calls.find(([sql]) =>
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

        const reachCall = prepareSpy.mock.calls.find(([preparedSql]) =>
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
        prepareSpy.mockRestore();
      }
    });
  });
});
