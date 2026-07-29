import { describe, expect, test } from "bun:test";
import { acceptSteerOutputSchema } from "@/tools/accept-steer";
import { getTaskDetailsOutputSchema } from "@/tools/get-task-details";
import { getTasksOutputSchema } from "@/tools/get-tasks";
import { memorySearchOutputSchema } from "@/tools/memory-search";
import { sendTaskInputSchema } from "@/tools/send-task";
import { steerTaskOutputSchema } from "@/tools/steer-task";
import { storeProgressOutputSchema } from "@/tools/store-progress";
import { AgentMemorySchema, AgentSchema, AgentTaskSchema } from "@/types";

// Regression guard for the "MCP error -32602: Output validation error" class of
// bug: agents may register with custom NON-UUID IDs (`AGENT_ID=e2e-lead` env or
// a requested id at join-swarm). The MCP server validates `structuredContent`
// against the output schema AFTER the handler ran, so a `.uuid()` constraint on
// an agent-id field lets the write land and then fails the response — and the
// client's retry double-writes.

const SLUG_AGENT_ID = "e2e-lead";
const SLUG_WORKER_ID = "e2e-worker-1";
const TASK_UUID = "6f1b2c9e-0f2a-4a9b-8f0f-9a1b2c3d4e5f";
const NOW = new Date().toISOString();

const slugTask = {
  id: TASK_UUID,
  key: "shared/tasks/regression",
  agentId: SLUG_AGENT_ID,
  creatorAgentId: SLUG_WORKER_ID,
  task: "verify slug agent ids survive output validation",
  status: "in_progress" as const,
  offeredTo: SLUG_WORKER_ID,
  createdAt: NOW,
  lastUpdatedAt: NOW,
};

describe("agent-id fields accept non-UUID agent ids", () => {
  test("AgentTaskSchema accepts slug agentId / creatorAgentId / offeredTo", () => {
    const parsed = AgentTaskSchema.parse(slugTask);
    expect(parsed.agentId).toBe(SLUG_AGENT_ID);
    expect(parsed.creatorAgentId).toBe(SLUG_WORKER_ID);
    expect(parsed.offeredTo).toBe(SLUG_WORKER_ID);
  });

  test("AgentSchema accepts a slug agent id", () => {
    const parsed = AgentSchema.parse({
      id: SLUG_AGENT_ID,
      name: "E2E Lead",
      status: "idle",
      createdAt: NOW,
      lastUpdatedAt: NOW,
    });
    expect(parsed.id).toBe(SLUG_AGENT_ID);
  });

  test("AgentMemorySchema accepts a slug agentId", () => {
    const parsed = AgentMemorySchema.parse({
      id: "1f4c0f36-7c4b-4a0e-9a4a-1b2c3d4e5f60",
      agentId: SLUG_AGENT_ID,
      scope: "agent",
      name: "auth flow",
      content: "…",
      summary: null,
      source: "manual",
      sourceTaskId: null,
      sourcePath: null,
      tags: [],
      createdAt: NOW,
      accessedAt: NOW,
    });
    expect(parsed.agentId).toBe(SLUG_AGENT_ID);
  });

  test("get-tasks output accepts a slug yourAgentId and slug task agent ids", () => {
    // Envelope keys (success, message) are required by swarmToolEnvelopeShape —
    // every tool output schema built via swarmToolOutputSchema() demands them.
    const parsed = getTasksOutputSchema.parse({
      success: true,
      message: "Found 1 task(s).",
      yourAgentId: SLUG_AGENT_ID,
      tasks: [
        {
          id: TASK_UUID,
          key: "shared/tasks/regression",
          agentId: SLUG_AGENT_ID,
          taskPreview: "verify slug agent ids",
          status: "in_progress",
          tags: [],
          priority: 50,
          dependsOn: [],
          offeredTo: SLUG_WORKER_ID,
          createdAt: NOW,
          lastUpdatedAt: NOW,
        },
      ],
    });
    expect(parsed.yourAgentId).toBe(SLUG_AGENT_ID);
    expect(parsed.tasks[0]?.agentId).toBe(SLUG_AGENT_ID);
  });

  test("get-task-details output accepts a slug yourAgentId and embedded task", () => {
    const parsed = getTaskDetailsOutputSchema.parse({
      yourAgentId: SLUG_AGENT_ID,
      success: true,
      message: "ok",
      task: slugTask,
    });
    expect(parsed.yourAgentId).toBe(SLUG_AGENT_ID);
    expect(parsed.task?.agentId).toBe(SLUG_AGENT_ID);
  });

  test("store-progress output accepts a slug yourAgentId and embedded task", () => {
    const parsed = storeProgressOutputSchema.parse({
      success: true,
      message: "Progress stored",
      task: slugTask,
      yourAgentId: SLUG_AGENT_ID,
    });
    expect(parsed.yourAgentId).toBe(SLUG_AGENT_ID);
    expect(parsed.task?.agentId).toBe(SLUG_AGENT_ID);
  });

  test("memory-search output accepts a slug yourAgentId", () => {
    const parsed = memorySearchOutputSchema.parse({
      yourAgentId: SLUG_AGENT_ID,
      success: true,
      message: "1 result",
      results: [
        {
          id: "1f4c0f36-7c4b-4a0e-9a4a-1b2c3d4e5f60",
          name: "auth flow",
          summary: null,
          source: "manual",
          scope: "agent",
          createdAt: NOW,
        },
      ],
    });
    expect(parsed.yourAgentId).toBe(SLUG_AGENT_ID);
  });

  test("accept-steer output accepts a slug yourAgentId", () => {
    const parsed = acceptSteerOutputSchema.parse({
      yourAgentId: SLUG_AGENT_ID,
      success: true,
      message: "acknowledged",
    });
    expect(parsed.yourAgentId).toBe(SLUG_AGENT_ID);
  });

  test("steer-task output accepts a slug yourAgentId", () => {
    const parsed = steerTaskOutputSchema.parse({
      yourAgentId: SLUG_AGENT_ID,
      success: true,
      message: "queued",
    });
    expect(parsed.yourAgentId).toBe(SLUG_AGENT_ID);
  });

  test("send-task input accepts a slug agentId target", () => {
    const parsed = sendTaskInputSchema.parse({
      agentId: SLUG_WORKER_ID,
      task: "do the thing",
    });
    expect(parsed.agentId).toBe(SLUG_WORKER_ID);
  });

  // INVERTED (see runbooks/mcp-tool-results.md §5): output schemas never pin a
  // string field to a format — every tool-declared id field is a plain
  // z.string(), even for server-generated ids like memory result ids, because
  // the -32602-after-write trap can hit any strict output field, not just
  // agent-id ones. The internal AgentTaskSchema (src/types.ts) is a separate,
  // still-strict DB/runtime-parsing schema — it is never used as a tool
  // outputSchema (tools mirror it loosely via looseAgentTaskOutputSchema), so
  // its own `.uuid()` pin on `id` is untouched by this refactor.
  test("internal AgentTaskSchema keeps its id UUID constraint, but tool output schemas no longer pin any id format", () => {
    expect(() => AgentTaskSchema.parse({ ...slugTask, id: "not-a-uuid" })).toThrow();
    expect(() =>
      memorySearchOutputSchema.parse({
        yourAgentId: SLUG_AGENT_ID,
        success: true,
        message: "1 result",
        results: [
          {
            id: "not-a-uuid",
            name: "auth flow",
            summary: null,
            source: "manual",
            scope: "agent",
            createdAt: NOW,
          },
        ],
      }),
    ).not.toThrow();
  });
});
