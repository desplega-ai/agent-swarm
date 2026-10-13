/**
 * The OpenCode 2 swarm plugin, driven through a fake plugin context against a
 * local stand-in for the swarm API.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolveTemplateFromCode } from "../prompts/resolver";
import { createOpencodeSwarmPlugin } from "../providers/opencode-swarm-plugin";
import type { SwarmHooksConfig } from "../providers/pi-mono-extension";

type Hook = (event: any) => unknown;

let server: ReturnType<typeof Bun.serve>;
let cancelled = false;
let blockPolling = false;
const requests: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push(`${req.method} ${url.pathname}`);
      if (url.pathname === "/cancelled-tasks") {
        return Response.json({
          cancelled: cancelled ? [{ id: "task-1", failureReason: "lead said stop" }] : [],
        });
      }
      if (url.pathname === "/me") return Response.json({ shouldBlockPolling: blockPolling });
      if (url.pathname === "/api/tasks/task-1") {
        return Response.json({ id: "task-1", task: "ship the thing", progress: "half way" });
      }
      if (url.pathname === "/api/concurrent-context") {
        return Response.json({
          processingInboxMessages: [],
          recentTaskDelegations: [],
          activeSwarmTasks: [{ task: "other work", agentName: "Bob", status: "in_progress" }],
        });
      }
      return Response.json({});
    },
  });
});
afterAll(() => server.stop(true));

async function setup(overrides: Partial<SwarmHooksConfig> = {}) {
  const hooks: Record<string, Hook> = {};
  const register = (prefix: string) => ({
    hook: async (name: string, fn: Hook) => {
      hooks[`${prefix}.${name}`] = fn;
      return { dispose: async () => {} };
    },
  });
  const ctx = { tool: register("tool"), session: register("session") };
  const config: SwarmHooksConfig = {
    apiUrl: `http://127.0.0.1:${server.port}`,
    apiKey: "k",
    agentId: "agent-1",
    taskId: "task-1",
    isLead: false,
    ...overrides,
  };
  const plugin = createOpencodeSwarmPlugin(config);
  await plugin.setup(ctx as never);
  return { plugin, hooks };
}

describe("opencode swarm plugin", () => {
  test("blocks tools once the task is cancelled", async () => {
    const { hooks } = await setup();
    cancelled = false;
    await expect(hooks["tool.execute.before"]?.({ tool: "shell" })).resolves.toBeUndefined();
    cancelled = true;
    try {
      await expect(hooks["tool.execute.before"]?.({ tool: "shell" })).rejects.toThrow(
        /TASK CANCELLED.*lead said stop/,
      );
    } finally {
      cancelled = false;
    }
  });

  test("blocks poll-task at the polling limit", async () => {
    const { hooks } = await setup();
    blockPolling = true;
    try {
      await expect(hooks["tool.execute.before"]?.({ tool: "swarm_poll-task" })).rejects.toThrow(
        /POLLING LIMIT REACHED/,
      );
    } finally {
      blockPolling = false;
    }
  });

  test("injects concurrent context for leads only", async () => {
    const worker = await setup();
    const workerEvent = { system: [] as unknown[] };
    await worker.hooks["session.context"]?.(workerEvent);
    expect(workerEvent.system).toEqual([]);

    const lead = await setup({ isLead: true });
    const leadEvent = { system: [] as Array<{ type: string; text: string }> };
    await lead.hooks["session.context"]?.(leadEvent);
    expect(leadEvent.system[0]?.text).toContain("CONCURRENT SESSION AWARENESS");
    expect(leadEvent.system[0]?.text).toContain("other work");
  });

  test("adds the task goal to compaction from the registered template", async () => {
    const { hooks } = await setup();
    const event = { system: [] as Array<{ type: string; text: string }> };
    await hooks["session.compaction"]?.(event);
    expect(event.system[0]?.text).toContain("Task: ship the thing");
    expect(event.system[0]?.text).toContain("Current Progress: half way");
    expect(event.system[0]?.text).toBe(
      resolveTemplateFromCode("system.agent.compaction.goal_reminder", {
        taskId: "task-1",
        task: "ship the thing",
        progressLine: "\nCurrent Progress: half way",
      }).text,
    );
  });

  test("heartbeats after a worker tool call", async () => {
    const { hooks } = await setup();
    requests.length = 0;
    await hooks["tool.execute.after"]?.({ status: "completed" });
    await Bun.sleep(50);
    expect(requests).toContain("PUT /api/agents/agent-1/activity");
  });
});
