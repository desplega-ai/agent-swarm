import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import { createServer } from "../server";
import { ALL_TOOLS, CORE_TOOLS, DEFERRED_TOOLS } from "../tools/tool-config";

const TEST_DB_PATH = "./test-tool-annotations.sqlite";

/**
 * Access registered tools from the MCP server.
 * _registeredTools is private, so we cast through `any`.
 */
function getRegisteredTools(server: ReturnType<typeof createServer>) {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  return tools;
}

type RegisteredTool = {
  title?: string;
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  enabled: boolean;
};

describe("Tool Annotations & Classification", () => {
  let server: ReturnType<typeof createServer>;
  let tools: Record<string, RegisteredTool>;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {
        // File doesn't exist
      }
    }
    initDb(TEST_DB_PATH);
    server = createServer();
    tools = getRegisteredTools(server);
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {
        // ignore
      }
    }
  });

  // === Annotation Completeness ===

  test("every registered tool has annotations set", () => {
    const toolNames = Object.keys(tools);
    const missingAnnotations: string[] = [];

    for (const name of toolNames) {
      if (!tools[name].annotations) {
        missingAnnotations.push(name);
      }
    }

    expect(missingAnnotations).toEqual([]);
  });

  test("every registered tool has a title", () => {
    const toolNames = Object.keys(tools);
    const missingTitle: string[] = [];

    for (const name of toolNames) {
      if (!tools[name].title) {
        missingTitle.push(name);
      }
    }

    expect(missingTitle).toEqual([]);
  });

  test("every registered tool has a description", () => {
    const toolNames = Object.keys(tools);
    const missingDesc: string[] = [];

    for (const name of toolNames) {
      if (!tools[name].description) {
        missingDesc.push(name);
      }
    }

    expect(missingDesc).toEqual([]);
  });

  // === Annotation Correctness ===

  test("destructive tools have destructiveHint: true", () => {
    const expectedDestructive = [
      "cancel-task",
      "delete-channel",
      "delete-schedule",
      "delete-config",
      "delete-workflow",
      "unregister-service",
    ];

    for (const name of expectedDestructive) {
      if (tools[name]) {
        expect(tools[name].annotations?.destructiveHint).toBe(true);
      }
    }
  });

  test("read-only tools have readOnlyHint: true", () => {
    const expectedReadOnly = [
      "get-swarm",
      "get-task-details",
      "get-tasks",
      "get-config",
      "list-channels",
      "list-services",
      "list-schedules",
      "list-config",
      "memory-search",
      "memory-get",
      "my-agent-info",
      "poll-task",
      "read-messages",
      "context-history",
      "context-diff",
    ];

    for (const name of expectedReadOnly) {
      if (tools[name]) {
        expect(tools[name].annotations?.readOnlyHint).toBe(true);
      }
    }
  });

  test("no tool has both readOnlyHint and destructiveHint set to true", () => {
    const contradictions: string[] = [];

    for (const [name, tool] of Object.entries(tools)) {
      if (tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === true) {
        contradictions.push(name);
      }
    }

    expect(contradictions).toEqual([]);
  });

  test("Slack integration tools have openWorldHint: true", () => {
    const slackTools = [
      "slack-reply",
      "slack-read",
      "slack-post",
      "slack-upload-file",
      "slack-download-file",
      "slack-list-channels",
    ];

    for (const name of slackTools) {
      if (tools[name]) {
        expect(tools[name].annotations?.openWorldHint).toBe(true);
      }
    }
  });

  // === Core vs Deferred Classification ===

  test("CORE_TOOLS and DEFERRED_TOOLS have no overlap", () => {
    const overlap = [...CORE_TOOLS].filter((t) => DEFERRED_TOOLS.has(t));
    expect(overlap).toEqual([]);
  });

  test("CORE_TOOLS contains exactly 13 tools", () => {
    expect(CORE_TOOLS.size).toBe(13);
  });

  test("ALL_TOOLS equals CORE_TOOLS union DEFERRED_TOOLS", () => {
    const union = new Set([...CORE_TOOLS, ...DEFERRED_TOOLS]);
    expect(ALL_TOOLS.size).toBe(union.size);
    for (const tool of ALL_TOOLS) {
      expect(union.has(tool)).toBe(true);
    }
  });

  test("every registered tool is classified as either core or deferred", () => {
    const toolNames = Object.keys(tools);
    const unclassified: string[] = [];

    for (const name of toolNames) {
      if (!ALL_TOOLS.has(name)) {
        unclassified.push(name);
      }
    }

    expect(unclassified).toEqual([]);
  });

  test("all core tools are registered in the server", () => {
    const toolNames = new Set(Object.keys(tools));
    const missingCore: string[] = [];

    for (const name of CORE_TOOLS) {
      if (!toolNames.has(name)) {
        missingCore.push(name);
      }
    }

    expect(missingCore).toEqual([]);
  });

  test("core tools include essential session bootstrap tools", () => {
    const bootstrapTools = ["join-swarm", "my-agent-info", "poll-task"];
    for (const tool of bootstrapTools) {
      expect(CORE_TOOLS.has(tool)).toBe(true);
    }
  });

  test("core tools include essential task lifecycle tools", () => {
    const lifecycleTools = [
      "get-task-details",
      "store-progress",
      "task-action",
      "send-task",
      "get-tasks",
    ];
    for (const tool of lifecycleTools) {
      expect(CORE_TOOLS.has(tool)).toBe(true);
    }
  });

  test("core tools include essential communication tools", () => {
    const commTools = ["read-messages", "post-message"];
    for (const tool of commTools) {
      expect(CORE_TOOLS.has(tool)).toBe(true);
    }
  });

  test("core tools include memory tools", () => {
    const memTools = ["memory-search", "memory-get"];
    for (const tool of memTools) {
      expect(CORE_TOOLS.has(tool)).toBe(true);
    }
  });

  test("scheduling tools are all deferred", () => {
    const scheduleTools = [
      "list-schedules",
      "create-schedule",
      "update-schedule",
      "delete-schedule",
      "run-schedule-now",
    ];
    for (const tool of scheduleTools) {
      expect(DEFERRED_TOOLS.has(tool)).toBe(true);
    }
  });

  test("workflow tools are all deferred", () => {
    const workflowTools = [
      "create-workflow",
      "list-workflows",
      "get-workflow",
      "update-workflow",
      "delete-workflow",
      "trigger-workflow",
      "list-workflow-runs",
      "get-workflow-run",
      "retry-workflow-run",
      "cancel-workflow-run",
    ];
    for (const tool of workflowTools) {
      expect(DEFERRED_TOOLS.has(tool)).toBe(true);
    }
  });

  test("all 10 workflow tools are registered in the server", () => {
    const workflowTools = [
      "create-workflow",
      "list-workflows",
      "get-workflow",
      "update-workflow",
      "delete-workflow",
      "trigger-workflow",
      "list-workflow-runs",
      "get-workflow-run",
      "retry-workflow-run",
      "cancel-workflow-run",
    ];
    const missing = workflowTools.filter((t) => !tools[t]);
    expect(missing).toEqual([]);
  });

  test("service tools are all deferred", () => {
    const serviceTools = [
      "register-service",
      "unregister-service",
      "list-services",
      "update-service-status",
    ];
    for (const tool of serviceTools) {
      expect(DEFERRED_TOOLS.has(tool)).toBe(true);
    }
  });

  test("config tools are all deferred", () => {
    const configTools = ["set-config", "get-config", "list-config", "delete-config"];
    for (const tool of configTools) {
      expect(DEFERRED_TOOLS.has(tool)).toBe(true);
    }
  });

  // === Token Impact Estimation ===

  test("registered tool count matches expected total", () => {
    const count = Object.keys(tools).length;
    // We expect all tools to be registered when all capabilities are enabled (default)
    // Includes 11 skill tools and 7 MCP server tools
    expect(count).toBeGreaterThanOrEqual(45);
    expect(count).toBeLessThanOrEqual(95);
  });

  test("core tools are fewer than deferred tools", () => {
    expect(CORE_TOOLS.size).toBeLessThan(DEFERRED_TOOLS.size);
  });

  // === Annotation Coverage Statistics ===

  test("annotation breakdown is reasonable", () => {
    const toolEntries = Object.entries(tools);
    let readOnly = 0;
    let destructive = 0;
    let idempotent = 0;
    let openWorld = 0;

    for (const [, tool] of toolEntries) {
      if (tool.annotations?.readOnlyHint) readOnly++;
      if (tool.annotations?.destructiveHint) destructive++;
      if (tool.annotations?.idempotentHint) idempotent++;
      if (tool.annotations?.openWorldHint) openWorld++;
    }

    // Most tools should have at least one hint set
    expect(readOnly).toBeGreaterThan(15); // many read-only tools
    expect(destructive).toBeGreaterThanOrEqual(5); // delete-* tools
    expect(idempotent).toBeGreaterThanOrEqual(5); // update/register tools
    expect(openWorld).toBeGreaterThanOrEqual(3); // Slack tools
  });
});
