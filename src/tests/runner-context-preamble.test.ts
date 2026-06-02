import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  buildContextPreamble,
  CONTEXT_PREAMBLE_MAX_CHARS,
  CONTEXT_PREAMBLE_MAX_TOKENS,
  fetchTaskContextForPreamble,
  type TaskContextForPreamble,
} from "../commands/context-preamble";

const TEST_PORT = 19091;
const API_URL = `http://localhost:${TEST_PORT}`;
const API_KEY = "test-key";

// In-memory task store for the mock server
const mockTasks: Record<string, TaskContextForPreamble> = {};

let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    const match = url.match(/^\/api\/tasks\/([^/?]+)/);
    if (match) {
      const id = match[1];
      const task = mockTasks[id];
      if (task) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(task));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(TEST_PORT, resolve));
});

afterAll(() => {
  server.close();
  // Clear mocks
  for (const k of Object.keys(mockTasks)) delete mockTasks[k];
});

function seedTask(task: TaskContextForPreamble): void {
  mockTasks[task.id] = task;
}

describe("fetchTaskContextForPreamble", () => {
  test("returns null on 404", async () => {
    const result = await fetchTaskContextForPreamble(API_URL, API_KEY, "missing-id");
    expect(result).toBeNull();
  });

  test("fetches task context fields", async () => {
    seedTask({
      id: "task-a",
      task: "Build the widget",
      output: "Widget built successfully",
      status: "completed",
      attachments: [{ kind: "url", name: "Report", url: "https://example.com/report" }],
    });

    const result = await fetchTaskContextForPreamble(API_URL, API_KEY, "task-a");
    expect(result).not.toBeNull();
    expect(result?.id).toBe("task-a");
    expect(result?.task).toBe("Build the widget");
    expect(result?.output).toBe("Widget built successfully");
    expect(result?.attachments).toHaveLength(1);
    expect(result?.attachments?.[0].name).toBe("Report");
  });
});

describe("buildContextPreamble", () => {
  test("returns null when parent task not found", async () => {
    const result = await buildContextPreamble(API_URL, API_KEY, "nonexistent-parent");
    expect(result).toBeNull();
  });

  test("includes parent task subject and output in preamble", async () => {
    seedTask({
      id: "parent-1",
      task: "Fix the auth bug in login flow",
      output: "Fixed by patching jwt validation in auth.ts:42",
      status: "completed",
    });

    const preamble = await buildContextPreamble(API_URL, API_KEY, "parent-1");
    expect(preamble).not.toBeNull();
    expect(preamble).toContain("parent-1");
    expect(preamble).toContain("Fix the auth bug in login flow");
    expect(preamble).toContain("Fixed by patching jwt validation");
    expect(preamble).toContain("get-task-details");
    expect(preamble).toContain("Prior Conversation Context");
  });

  test("includes attachment pointers in preamble", async () => {
    seedTask({
      id: "parent-2",
      task: "Generate a report",
      output: "Report generated",
      status: "completed",
      attachments: [
        { kind: "url", name: "Final Report", url: "https://example.com/report.pdf" },
        {
          kind: "agent-fs",
          name: "Raw Data",
          path: "thoughts/agent/research/data.md",
          orgId: "org-123",
          driveId: "drv-456",
        },
      ],
    });

    const preamble = await buildContextPreamble(API_URL, API_KEY, "parent-2");
    expect(preamble).toContain("Final Report");
    expect(preamble).toContain("https://example.com/report.pdf");
    expect(preamble).toContain("Raw Data");
    expect(preamble).toContain("live.agent-fs.dev");
    expect(preamble).toContain("org-123");
    expect(preamble).toContain("drv-456");
  });

  test("shows 'no output recorded' when task has no output or progress", async () => {
    seedTask({
      id: "parent-no-output",
      task: "A task with no output yet",
      status: "in_progress",
    });

    const preamble = await buildContextPreamble(API_URL, API_KEY, "parent-no-output");
    expect(preamble).toContain("no output recorded");
  });

  test("walks ancestor chain and includes older ancestors as pointers", async () => {
    seedTask({
      id: "grandparent-1",
      task: "Initial research task",
      output: "Research complete",
      status: "completed",
    });
    seedTask({
      id: "child-of-grandparent",
      task: "Second task referencing research",
      output: "Second task done",
      status: "completed",
      parentTaskId: "grandparent-1",
    });

    const preamble = await buildContextPreamble(API_URL, API_KEY, "child-of-grandparent");
    expect(preamble).not.toBeNull();
    // Immediate parent (child-of-grandparent) gets inline detail
    expect(preamble).toContain("child-of-grandparent");
    expect(preamble).toContain("Second task done");
    // Grandparent gets pointer-only entry
    expect(preamble).toContain("grandparent-1");
    expect(preamble).toContain("Older Ancestor Tasks");
    expect(preamble).toContain("Initial research task");
  });

  test("enforces token budget — truncates oversized output", async () => {
    // Generate output that exceeds the budget
    const hugeOutput = "x".repeat(CONTEXT_PREAMBLE_MAX_CHARS + 5000);
    seedTask({
      id: "parent-big",
      task: "Task with very large output",
      output: hugeOutput,
      status: "completed",
    });

    const preamble = await buildContextPreamble(API_URL, API_KEY, "parent-big");
    expect(preamble).not.toBeNull();
    // Preamble must be within budget (some slack for the truncation suffix)
    expect(preamble?.length ?? 0).toBeLessThanOrEqual(
      CONTEXT_PREAMBLE_MAX_CHARS + 300, // 300 chars slack for the truncation message
    );
  });

  test("preamble starts with context section and ends with separator", async () => {
    seedTask({
      id: "parent-structure",
      task: "A well-structured task",
      output: "Done",
      status: "completed",
    });

    const preamble = await buildContextPreamble(API_URL, API_KEY, "parent-structure");
    expect(preamble).toContain("---");
    expect(preamble).toContain("Prior Conversation Context");
    // Should end with trailing separator
    expect(preamble?.trimEnd()).toMatch(/---\s*$/);
  });

  test("CONTEXT_PREAMBLE_MAX_TOKENS is 2000 by default", () => {
    expect(CONTEXT_PREAMBLE_MAX_TOKENS).toBe(2000);
    expect(CONTEXT_PREAMBLE_MAX_CHARS).toBe(8000);
  });
});
