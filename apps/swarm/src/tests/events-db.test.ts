import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, initDb } from "../be/db";
import {
  createEvent,
  createEventsBatch,
  getAllEvents,
  getEventCounts,
  getEventCountsFiltered,
  getEventCountsForAgent,
  getEventsByAgentId,
  getEventsByCategory,
  getEventsByEvent,
  getEventsBySessionId,
  getEventsByTaskId,
  getEventsFiltered,
} from "../be/events";

const TEST_DB_PATH = "./test-events-db.sqlite";

let testAgent: { id: string };

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {}
  initDb(TEST_DB_PATH);
  testAgent = createAgent({ name: "Events Test Agent", isLead: false, status: "idle" });
});

afterAll(async () => {
  closeDb();
  try {
    await unlink(TEST_DB_PATH);
    await unlink(`${TEST_DB_PATH}-wal`);
    await unlink(`${TEST_DB_PATH}-shm`);
  } catch {}
});

describe("createEvent", () => {
  test("creates a single event with required fields", () => {
    const evt = createEvent({
      category: "tool",
      event: "tool.start",
      source: "worker",
    });
    expect(evt.id).toBeDefined();
    expect(evt.category).toBe("tool");
    expect(evt.event).toBe("tool.start");
    expect(evt.status).toBe("ok");
    expect(evt.source).toBe("worker");
    expect(evt.createdAt).toBeDefined();
  });

  test("creates event with all optional fields", () => {
    const evt = createEvent({
      category: "tool",
      event: "tool.start",
      source: "worker",
      status: "error",
      agentId: testAgent.id,
      taskId: "task-123",
      sessionId: "session-456",
      parentEventId: "parent-789",
      numericValue: 42.5,
      durationMs: 1500,
      data: { toolName: "Read", filePath: "/tmp/test.txt" },
    });
    expect(evt.status).toBe("error");
    expect(evt.agentId).toBe(testAgent.id);
    expect(evt.taskId).toBe("task-123");
    expect(evt.sessionId).toBe("session-456");
    expect(evt.parentEventId).toBe("parent-789");
    expect(evt.numericValue).toBe(42.5);
    expect(evt.durationMs).toBe(1500);
    expect(evt.data).toEqual({ toolName: "Read", filePath: "/tmp/test.txt" });
  });

  test("defaults status to ok", () => {
    const evt = createEvent({ category: "system", event: "system.boot", source: "api" });
    expect(evt.status).toBe("ok");
  });
});

describe("createEventsBatch", () => {
  test("inserts multiple events in a transaction", () => {
    const before = getAllEvents(1000).length;
    const count = createEventsBatch([
      { category: "tool", event: "tool.start", source: "worker", agentId: testAgent.id },
      { category: "tool", event: "tool.end", source: "worker", agentId: testAgent.id },
      { category: "skill", event: "skill.invoke", source: "worker", agentId: testAgent.id },
    ]);
    expect(count).toBe(3);
    const after = getAllEvents(1000).length;
    expect(after - before).toBe(3);
  });

  test("returns 0 for empty batch", () => {
    const count = createEventsBatch([]);
    expect(count).toBe(0);
  });
});

describe("query functions", () => {
  const sessionId = `query-test-session-${Date.now()}`;
  const taskId = `query-test-task-${Date.now()}`;

  beforeAll(() => {
    // Seed events for query tests
    createEventsBatch([
      {
        category: "tool",
        event: "tool.start",
        source: "worker",
        agentId: testAgent.id,
        sessionId,
        taskId,
        data: { toolName: "Read" },
      },
      {
        category: "tool",
        event: "tool.start",
        source: "worker",
        agentId: testAgent.id,
        sessionId,
        taskId,
        data: { toolName: "Bash" },
      },
      {
        category: "skill",
        event: "skill.invoke",
        source: "worker",
        agentId: testAgent.id,
        sessionId,
        taskId,
        data: { skillName: "commit" },
      },
      {
        category: "session",
        event: "session.start",
        source: "worker",
        agentId: testAgent.id,
        sessionId,
        taskId,
      },
      {
        category: "api",
        event: "api.request",
        source: "api",
        data: { method: "GET", path: "/health" },
      },
    ]);
  });

  test("getEventsByCategory filters by category", () => {
    const tools = getEventsByCategory("tool");
    expect(tools.length).toBeGreaterThanOrEqual(2);
    for (const evt of tools) {
      expect(evt.category).toBe("tool");
    }
  });

  test("getEventsByEvent filters by event name", () => {
    const starts = getEventsByEvent("tool.start");
    expect(starts.length).toBeGreaterThanOrEqual(2);
    for (const evt of starts) {
      expect(evt.event).toBe("tool.start");
    }
  });

  test("getEventsByAgentId filters by agentId", () => {
    const agentEvents = getEventsByAgentId(testAgent.id);
    expect(agentEvents.length).toBeGreaterThanOrEqual(4);
    for (const evt of agentEvents) {
      expect(evt.agentId).toBe(testAgent.id);
    }
  });

  test("getEventsByTaskId filters by taskId", () => {
    const taskEvents = getEventsByTaskId(taskId);
    expect(taskEvents.length).toBeGreaterThanOrEqual(4);
    for (const evt of taskEvents) {
      expect(evt.taskId).toBe(taskId);
    }
  });

  test("getEventsBySessionId filters by sessionId", () => {
    const sessionEvents = getEventsBySessionId(sessionId);
    expect(sessionEvents.length).toBeGreaterThanOrEqual(4);
    for (const evt of sessionEvents) {
      expect(evt.sessionId).toBe(sessionId);
    }
  });

  test("getAllEvents respects limit", () => {
    const events = getAllEvents(2);
    expect(events.length).toBe(2);
  });

  test("getAllEvents returns descending createdAt order", () => {
    const events = getAllEvents(10);
    for (let i = 1; i < events.length; i++) {
      expect(events[i - 1].createdAt >= events[i].createdAt).toBe(true);
    }
  });

  test("getEventCounts groups by event name", () => {
    const counts = getEventCounts();
    expect(counts.length).toBeGreaterThanOrEqual(1);
    const toolStart = counts.find((c) => c.event === "tool.start");
    expect(toolStart).toBeDefined();
    expect(toolStart!.count).toBeGreaterThanOrEqual(2);
  });

  test("getEventCountsForAgent scopes to agent", () => {
    const counts = getEventCountsForAgent(testAgent.id);
    expect(counts.length).toBeGreaterThanOrEqual(1);
    // All counted events should belong to this agent
    const total = counts.reduce((sum, c) => sum + c.count, 0);
    const agentEvents = getEventsByAgentId(testAgent.id);
    expect(total).toBe(agentEvents.length);
  });
});

describe("getEventsFiltered", () => {
  test("filters by multiple criteria", () => {
    const events = getEventsFiltered({
      category: "tool",
      source: "worker",
      agentId: testAgent.id,
      limit: 5,
    });
    for (const evt of events) {
      expect(evt.category).toBe("tool");
      expect(evt.source).toBe("worker");
      expect(evt.agentId).toBe(testAgent.id);
    }
    expect(events.length).toBeLessThanOrEqual(5);
  });

  test("filters by status", () => {
    createEvent({
      category: "api",
      event: "api.error",
      source: "api",
      status: "error",
      data: { message: "timeout" },
    });
    const errors = getEventsFiltered({ status: "error" });
    expect(errors.length).toBeGreaterThanOrEqual(1);
    for (const evt of errors) {
      expect(evt.status).toBe("error");
    }
  });

  test("defaults limit to 100", () => {
    const events = getEventsFiltered({});
    expect(events.length).toBeLessThanOrEqual(100);
  });
});

describe("getEventCountsFiltered", () => {
  test("filters counts by category", () => {
    const counts = getEventCountsFiltered({ category: "tool" });
    for (const c of counts) {
      // Each counted event name should be a tool event
      expect(c.event.startsWith("tool.")).toBe(true);
    }
  });

  test("filters counts by source", () => {
    const counts = getEventCountsFiltered({ source: "api" });
    expect(counts.length).toBeGreaterThanOrEqual(1);
  });

  test("returns empty for non-matching filters", () => {
    const counts = getEventCountsFiltered({ agentId: "nonexistent-agent-id" });
    expect(counts.length).toBe(0);
  });
});

describe("data JSON round-trip", () => {
  test("preserves nested objects in data field", () => {
    const data = {
      toolName: "Read",
      nested: { deep: { value: 42 } },
      array: [1, "two", { three: true }],
    };
    const evt = createEvent({
      category: "tool",
      event: "tool.start",
      source: "worker",
      data,
    });
    // Re-fetch from DB to verify round-trip
    const fetched = getEventsFiltered({ limit: 1 });
    const found = fetched.find((e) => e.id === evt.id);
    expect(found).toBeDefined();
    expect(found!.data).toEqual(data);
  });

  test("handles null data gracefully", () => {
    const evt = createEvent({
      category: "system",
      event: "system.boot",
      source: "api",
    });
    const fetched = getEventsFiltered({ limit: 1000 });
    const found = fetched.find((e) => e.id === evt.id);
    expect(found).toBeDefined();
    expect(found!.data).toBeUndefined();
  });
});
