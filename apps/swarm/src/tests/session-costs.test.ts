import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createSessionCost,
  createTaskExtended,
  getAllSessionCosts,
  getDashboardCostSummary,
  getSessionCostSummary,
  getSessionCostsByAgentId,
  getSessionCostsByTaskId,
  getSessionCostsFiltered,
  initDb,
} from "../be/db";
import type { SessionCost } from "../types";

const TEST_DB_PATH = "./test-session-costs.sqlite";
const TEST_PORT = 13016;

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
  const baseUrl = `http://localhost:${TEST_PORT}`;
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
    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, () => {
        console.log(`Test server listening on port ${TEST_PORT}`);
        resolve();
      });
    });
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
});
