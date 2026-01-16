import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { closeDb, createAgent, createScheduledTask, getScheduledTasks, initDb } from "../be/db";
import type { ScheduledTask } from "../types";

const TEST_DB_PATH = "./test-scheduled-tasks-api.sqlite";
const TEST_PORT = 13020;

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

// Minimal HTTP handler for scheduled tasks REST API endpoint
async function handleRequest(
  req: { method: string; url: string },
  _body: string,
): Promise<{ status: number; body: unknown }> {
  const pathSegments = getPathSegments(req.url || "");
  const queryParams = parseQueryParams(req.url || "");

  // GET /api/scheduled-tasks - List all scheduled tasks (with optional filters: enabled, name)
  if (
    req.method === "GET" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "scheduled-tasks" &&
    !pathSegments[2]
  ) {
    const enabledParam = queryParams.get("enabled");
    const name = queryParams.get("name");
    const scheduledTasks = getScheduledTasks({
      enabled: enabledParam !== null ? enabledParam === "true" : undefined,
      name: name || undefined,
    });
    return { status: 200, body: { scheduledTasks } };
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

describe("Scheduled Tasks REST API", () => {
  let server: Server;
  let testAgent: { id: string; name: string };
  const baseUrl = `http://localhost:${TEST_PORT}`;

  beforeAll(async () => {
    // Clean up any existing test database
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist, that's fine
    }

    // Initialize test database
    initDb(TEST_DB_PATH);

    // Create a test agent for schedule creation
    testAgent = createAgent({
      name: "Test Schedule API Agent",
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

  describe("GET /api/scheduled-tasks", () => {
    test("should return empty array when no scheduled tasks exist", async () => {
      const response = await fetch(`${baseUrl}/api/scheduled-tasks`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as { scheduledTasks: ScheduledTask[] };
      expect(data.scheduledTasks).toBeInstanceOf(Array);
    });

    test("should return all scheduled tasks", async () => {
      // Create some test schedules
      createScheduledTask({
        name: "api-test-schedule-1",
        description: "First test schedule",
        intervalMs: 60000,
        taskTemplate: "Test task 1",
        taskType: "test",
        tags: ["test"],
        priority: 50,
        enabled: true,
      });

      createScheduledTask({
        name: "api-test-schedule-2",
        description: "Second test schedule",
        cronExpression: "0 9 * * *",
        taskTemplate: "Test task 2",
        taskType: "test",
        tags: ["test", "daily"],
        priority: 60,
        enabled: true,
      });

      const response = await fetch(`${baseUrl}/api/scheduled-tasks`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as { scheduledTasks: ScheduledTask[] };
      expect(data.scheduledTasks.length).toBeGreaterThanOrEqual(2);

      const schedule1 = data.scheduledTasks.find((s) => s.name === "api-test-schedule-1");
      expect(schedule1).toBeDefined();
      expect(schedule1?.description).toBe("First test schedule");
      expect(schedule1?.intervalMs).toBe(60000);

      const schedule2 = data.scheduledTasks.find((s) => s.name === "api-test-schedule-2");
      expect(schedule2).toBeDefined();
      expect(schedule2?.cronExpression).toBe("0 9 * * *");
    });

    test("should filter scheduled tasks by enabled=true", async () => {
      // Create enabled and disabled schedules
      createScheduledTask({
        name: "api-filter-enabled-1",
        intervalMs: 60000,
        taskTemplate: "Enabled task",
        enabled: true,
      });

      createScheduledTask({
        name: "api-filter-disabled-1",
        intervalMs: 60000,
        taskTemplate: "Disabled task",
        enabled: false,
      });

      const response = await fetch(`${baseUrl}/api/scheduled-tasks?enabled=true`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as { scheduledTasks: ScheduledTask[] };

      // All returned schedules should be enabled
      expect(data.scheduledTasks.every((s) => s.enabled === true)).toBe(true);

      // The disabled schedule should not be in the results
      const disabledSchedule = data.scheduledTasks.find((s) => s.name === "api-filter-disabled-1");
      expect(disabledSchedule).toBeUndefined();
    });

    test("should filter scheduled tasks by enabled=false", async () => {
      const response = await fetch(`${baseUrl}/api/scheduled-tasks?enabled=false`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as { scheduledTasks: ScheduledTask[] };

      // All returned schedules should be disabled
      expect(data.scheduledTasks.every((s) => s.enabled === false)).toBe(true);

      // Should include the disabled schedule created earlier
      const disabledSchedule = data.scheduledTasks.find((s) => s.name === "api-filter-disabled-1");
      expect(disabledSchedule).toBeDefined();
    });

    test("should filter scheduled tasks by name (partial match)", async () => {
      createScheduledTask({
        name: "unique-api-search-xyz",
        intervalMs: 60000,
        taskTemplate: "Unique search task",
        enabled: true,
      });

      const response = await fetch(`${baseUrl}/api/scheduled-tasks?name=search-xyz`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as { scheduledTasks: ScheduledTask[] };

      expect(data.scheduledTasks.length).toBeGreaterThanOrEqual(1);
      expect(data.scheduledTasks.some((s) => s.name.includes("search-xyz"))).toBe(true);
    });

    test("should combine enabled and name filters", async () => {
      createScheduledTask({
        name: "combo-filter-active",
        intervalMs: 60000,
        taskTemplate: "Active combo task",
        enabled: true,
      });

      createScheduledTask({
        name: "combo-filter-inactive",
        intervalMs: 60000,
        taskTemplate: "Inactive combo task",
        enabled: false,
      });

      // Filter by name AND enabled=true
      const response = await fetch(`${baseUrl}/api/scheduled-tasks?name=combo-filter&enabled=true`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as { scheduledTasks: ScheduledTask[] };

      // Should only return the enabled one
      expect(data.scheduledTasks.some((s) => s.name === "combo-filter-active")).toBe(true);
      expect(data.scheduledTasks.some((s) => s.name === "combo-filter-inactive")).toBe(false);
    });

    test("should return empty array when no schedules match filter", async () => {
      const response = await fetch(
        `${baseUrl}/api/scheduled-tasks?name=nonexistent-schedule-xyz-123`,
      );

      expect(response.status).toBe(200);
      const data = (await response.json()) as { scheduledTasks: ScheduledTask[] };
      expect(data.scheduledTasks).toEqual([]);
    });

    test("should return scheduled task with all fields populated", async () => {
      createScheduledTask({
        name: "full-fields-test",
        description: "Schedule with all fields",
        cronExpression: "30 14 * * 1-5",
        taskTemplate: "Full fields task template",
        taskType: "full-test",
        tags: ["field1", "field2", "field3"],
        priority: 85,
        targetAgentId: testAgent.id,
        createdByAgentId: testAgent.id,
        enabled: true,
        timezone: "America/New_York",
      });

      const response = await fetch(`${baseUrl}/api/scheduled-tasks?name=full-fields-test`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as { scheduledTasks: ScheduledTask[] };

      expect(data.scheduledTasks.length).toBe(1);
      const schedule = data.scheduledTasks[0];

      expect(schedule.name).toBe("full-fields-test");
      expect(schedule.description).toBe("Schedule with all fields");
      expect(schedule.cronExpression).toBe("30 14 * * 1-5");
      expect(schedule.taskTemplate).toBe("Full fields task template");
      expect(schedule.taskType).toBe("full-test");
      expect(schedule.tags).toEqual(["field1", "field2", "field3"]);
      expect(schedule.priority).toBe(85);
      expect(schedule.targetAgentId).toBe(testAgent.id);
      expect(schedule.createdByAgentId).toBe(testAgent.id);
      expect(schedule.enabled).toBe(true);
      expect(schedule.timezone).toBe("America/New_York");
      expect(schedule.id).toBeDefined();
      expect(schedule.createdAt).toBeDefined();
      expect(schedule.lastUpdatedAt).toBeDefined();
    });

    test("should return schedules sorted by name", async () => {
      // Create schedules with names that should sort alphabetically
      createScheduledTask({
        name: "zzz-last-schedule",
        intervalMs: 60000,
        taskTemplate: "Last task",
        enabled: true,
      });

      createScheduledTask({
        name: "aaa-first-schedule",
        intervalMs: 60000,
        taskTemplate: "First task",
        enabled: true,
      });

      const response = await fetch(`${baseUrl}/api/scheduled-tasks`);

      expect(response.status).toBe(200);
      const data = (await response.json()) as { scheduledTasks: ScheduledTask[] };

      // Find the indices of our test schedules
      const firstIndex = data.scheduledTasks.findIndex((s) => s.name === "aaa-first-schedule");
      const lastIndex = data.scheduledTasks.findIndex((s) => s.name === "zzz-last-schedule");

      // The "aaa" schedule should come before "zzz" schedule
      expect(firstIndex).toBeLessThan(lastIndex);
    });
  });

  describe("Error Handling", () => {
    test("should return 404 for unknown endpoints", async () => {
      const response = await fetch(`${baseUrl}/api/unknown-endpoint`);

      expect(response.status).toBe(404);
      const data = (await response.json()) as { error: string };
      expect(data.error).toBe("Not found");
    });

    test("should return 404 for POST request to scheduled-tasks", async () => {
      const response = await fetch(`${baseUrl}/api/scheduled-tasks`, {
        method: "POST",
        body: JSON.stringify({ name: "test" }),
      });

      expect(response.status).toBe(404);
    });
  });
});
