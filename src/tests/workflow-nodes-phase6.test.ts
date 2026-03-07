import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createChannel,
  createWorkflow,
  getAllTasks,
  getChannelMessages,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import { startWorkflowExecution } from "../workflows/engine";
import { executeCodeMatch } from "../workflows/nodes/code-match";
import { executeSendMessage } from "../workflows/nodes/send-message";

const TEST_DB_PATH = "./test-workflow-nodes-phase6.sqlite";

describe("Phase 6 Node Types", () => {
  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist, that's fine
    }
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    try {
      await unlink(TEST_DB_PATH);
      await unlink(`${TEST_DB_PATH}-wal`);
      await unlink(`${TEST_DB_PATH}-shm`);
    } catch {
      // Files may not exist
    }
  });

  // ---------------------------------------------------------------------------
  // code-match
  // ---------------------------------------------------------------------------
  describe("executeCodeMatch()", () => {
    test("returns 'true' port when tag is present", () => {
      const config = {
        code: "(input) => input.trigger.tags.includes('urgent')",
        outputPorts: ["true", "false"],
      };
      const ctx = { trigger: { tags: ["urgent", "bug"] } };
      const result = executeCodeMatch(config, ctx);
      expect(result.mode).toBe("instant");
      expect(result.nextPort).toBe("true");
      expect((result.output as Record<string, unknown>).result).toBe("true");
    });

    test("returns 'false' port when tag is absent", () => {
      const config = {
        code: "(input) => input.trigger.tags.includes('urgent')",
        outputPorts: ["true", "false"],
      };
      const ctx = { trigger: { tags: ["feature"] } };
      const result = executeCodeMatch(config, ctx);
      expect(result.nextPort).toBe("false");
    });

    test("blocks process.env access (sandbox returns undefined for process)", () => {
      const config = {
        code: "(input) => typeof process === 'undefined' ? 'sandboxed' : 'exposed'",
        outputPorts: ["sandboxed", "exposed"],
      };
      const result = executeCodeMatch(config, {});
      expect(result.nextPort).toBe("sandboxed");
    });

    test("blocks Bun access (sandbox returns undefined for Bun)", () => {
      const config = {
        code: "(input) => typeof Bun === 'undefined' ? 'sandboxed' : 'exposed'",
        outputPorts: ["sandboxed", "exposed"],
      };
      const result = executeCodeMatch(config, {});
      expect(result.nextPort).toBe("sandboxed");
    });

    test("handles number return by converting to string", () => {
      const config = {
        code: "(input) => 42",
        outputPorts: ["42", "other"],
      };
      const result = executeCodeMatch(config, {});
      expect(result.nextPort).toBe("42");
    });

    test("throws when user code throws at runtime", () => {
      const config = {
        code: "(input) => { throw new Error('kaboom'); }",
        outputPorts: ["true", "false"],
      };
      expect(() => executeCodeMatch(config, {})).toThrow("kaboom");
    });

    test("blocks require access (sandbox returns undefined for require)", () => {
      const config = {
        code: "(input) => typeof require === 'undefined' ? 'sandboxed' : 'exposed'",
        outputPorts: ["sandboxed", "exposed"],
      };
      const result = executeCodeMatch(config, {});
      expect(result.nextPort).toBe("sandboxed");
    });

    test("blocks fetch access (sandbox returns undefined for fetch)", () => {
      const config = {
        code: "(input) => typeof fetch === 'undefined' ? 'sandboxed' : 'exposed'",
        outputPorts: ["sandboxed", "exposed"],
      };
      const result = executeCodeMatch(config, {});
      expect(result.nextPort).toBe("sandboxed");
    });

    test("blocks setTimeout access (sandbox returns undefined)", () => {
      const config = {
        code: "(input) => typeof setTimeout === 'undefined' ? 'sandboxed' : 'exposed'",
        outputPorts: ["sandboxed", "exposed"],
      };
      const result = executeCodeMatch(config, {});
      expect(result.nextPort).toBe("sandboxed");
    });

    test("blocks globalThis access (sandbox returns undefined)", () => {
      const config = {
        code: "(input) => typeof globalThis === 'undefined' ? 'sandboxed' : 'exposed'",
        outputPorts: ["sandboxed", "exposed"],
      };
      const result = executeCodeMatch(config, {});
      expect(result.nextPort).toBe("sandboxed");
    });

    test("throws when code returns a port not in outputPorts", () => {
      const config = {
        code: "(input) => 'unknown-port'",
        outputPorts: ["true", "false"],
      };
      expect(() => executeCodeMatch(config, {})).toThrow(
        'code-match returned "unknown-port" which is not in outputPorts',
      );
    });

    test("returns string port directly when code returns a string", () => {
      const config = {
        code: "(input) => input.trigger.priority > 5 ? 'high' : 'low'",
        outputPorts: ["high", "low"],
      };
      const result = executeCodeMatch(config, { trigger: { priority: 8 } });
      expect(result.nextPort).toBe("high");
    });
  });

  // ---------------------------------------------------------------------------
  // send-message
  // ---------------------------------------------------------------------------
  describe("executeSendMessage()", () => {
    test("posts a message to the specified channel", () => {
      const channel = createChannel("test-channel-phase6");
      const config = { channelId: channel.id, template: "Alert: {{trigger.event}}" };
      const ctx = { trigger: { event: "deployment-failed" } };

      const result = executeSendMessage(config, ctx);

      expect(result.mode).toBe("instant");
      expect(result.nextPort).toBe("default");
      expect((result.output as Record<string, unknown>).message).toBe("Alert: deployment-failed");

      // Verify the message was actually written to the DB
      const messages = getChannelMessages(channel.id, { limit: 10 });
      expect(messages.length).toBeGreaterThan(0);
      expect(messages[0].content).toBe("Alert: deployment-failed");
    });

    test("skips posting when channelId is not set", () => {
      const channel = createChannel("test-channel-no-post");
      const config = { template: "Should not appear" };
      const ctx = {};

      const result = executeSendMessage(config, ctx);

      expect(result.mode).toBe("instant");
      expect(result.nextPort).toBe("default");

      // No message should have been written to this channel
      const messages = getChannelMessages(channel.id, { limit: 10 });
      expect(messages.length).toBe(0);
    });

    test("interpolates template using context", () => {
      const channel = createChannel("test-channel-interpolate");
      const config = {
        channelId: channel.id,
        template: "Task {{trigger.id}} by {{trigger.author}} is done",
      };
      const ctx = { trigger: { id: "42", author: "alice" } };

      executeSendMessage(config, ctx);

      const messages = getChannelMessages(channel.id, { limit: 10 });
      expect(messages[0].content).toBe("Task 42 by alice is done");
    });
  });

  // ---------------------------------------------------------------------------
  // delegate-to-agent (via full workflow execution)
  // ---------------------------------------------------------------------------
  describe("delegate-to-agent node (via workflow)", () => {
    test("creates a task offered to the specified agent with workflowRunStepId set", async () => {
      const agentId = crypto.randomUUID();

      const workflow = createWorkflow({
        name: "test-delegate-to-agent",
        definition: {
          nodes: [
            { id: "t1", type: "trigger-webhook", config: {} },
            {
              id: "d1",
              type: "delegate-to-agent",
              config: {
                agentId,
                taskTemplate: "Review PR: {{trigger.title}}",
                tags: ["review"],
                offerMode: true,
              },
            },
          ],
          edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "d1" }],
        },
      });

      const tasksBefore = getAllTasks().length;
      const runId = await startWorkflowExecution(workflow, { title: "Add dark mode" });

      // Run should be waiting at the async delegate-to-agent step
      const run = getWorkflowRun(runId);
      expect(run?.status).toBe("waiting");

      // A task should have been created
      const tasksAfter = getAllTasks();
      expect(tasksAfter.length).toBe(tasksBefore + 1);

      const delegatedTask = tasksAfter.find((t) => t.workflowRunId === runId);
      expect(delegatedTask).toBeDefined();
      expect(delegatedTask?.task).toBe("Review PR: Add dark mode");
      expect(delegatedTask?.offeredTo).toBe(agentId);
      expect(delegatedTask?.source).toBe("workflow");

      // Step should be recorded
      const steps = getWorkflowRunStepsByRunId(runId);
      const delegateStep = steps.find((s) => s.nodeId === "d1");
      expect(delegateStep).toBeDefined();
      expect(delegateStep?.status).toBe("waiting");
      expect(delegatedTask?.workflowRunStepId).toBe(delegateStep?.id);
    });

    test("assigns task directly to agent when offerMode is false", async () => {
      const agentId = crypto.randomUUID();

      const workflow = createWorkflow({
        name: "test-delegate-assign",
        definition: {
          nodes: [
            { id: "t1", type: "trigger-webhook", config: {} },
            {
              id: "d1",
              type: "delegate-to-agent",
              config: {
                agentId,
                taskTemplate: "Direct assignment",
                offerMode: false,
              },
            },
          ],
          edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "d1" }],
        },
      });

      const runId = await startWorkflowExecution(workflow, {});
      const tasks = getAllTasks();
      const delegatedTask = tasks.find((t) => t.workflowRunId === runId);

      expect(delegatedTask).toBeDefined();
      // Direct assignment: agentId should be set, offeredTo should not be
      expect(delegatedTask?.agentId).toBe(agentId);
      expect(delegatedTask?.offeredTo).toBeUndefined();
    });
  });
});
