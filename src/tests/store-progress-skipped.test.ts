import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodType } from "zod";
import {
  checkDependencies,
  closeDb,
  createAgent,
  createTaskExtended,
  getAgentById,
  getDbClient,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import { registerStoreProgressTool } from "../tools/store-progress";
import type { SwarmToolResult } from "../tools/utils";
import { isTerminalTaskStatus } from "../types";

// `skipped` ends a task the agent decided is not its to handle. It is
// terminal, frees the agent, satisfies dependsOn, and creates no lead
// follow-up, unlike `completed` / `failed`.
const workerId = "aaaa0000-0000-4000-8000-00000000b501";
const leadId = "cccc0000-0000-4000-8000-00000000b503";

const server = new McpServer({ name: "store-progress-skipped", version: "1.0.0" });
registerStoreProgressTool(server);
const tool = (
  server as unknown as {
    _registeredTools: Record<
      string,
      {
        inputSchema: ZodType;
        handler: (args: unknown, meta: unknown) => Promise<SwarmToolResult>;
      }
    >;
  }
)._registeredTools["store-progress"]!;

async function call(args: unknown) {
  return tool.handler(tool.inputSchema.parse(args), {
    sessionId: "store-progress-skipped-session",
    requestInfo: { headers: { "x-agent-id": workerId } },
  });
}

async function startedTask(text: string, options: { dependsOn?: string[] } = {}) {
  const row = await createTaskExtended(text, {
    agentId: workerId,
    source: "slack",
    slackChannelId: "C_SKIP_TEST",
    slackThreadTs: "1700000000.000100",
    ...options,
  });
  await startTask(row.id);
  return row;
}

async function followUpsOf(taskId: string): Promise<number> {
  const row = await getDbClient().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM agent_tasks WHERE parentTaskId = ? AND taskType = 'follow-up'",
    [taskId],
  );
  return row?.n ?? 0;
}

const originalEmbeddingKey = process.env.EMBEDDING_API_KEY;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
beforeAll(async () => {
  process.env.EMBEDDING_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  initDb(":memory:");
  await createAgent({ id: workerId, name: "Skip worker", isLead: false, status: "idle" });
  await createAgent({ id: leadId, name: "Lead", role: "lead", isLead: true, status: "idle" });
});
afterAll(() => {
  closeDb();
  if (originalEmbeddingKey === undefined) delete process.env.EMBEDDING_API_KEY;
  else process.env.EMBEDDING_API_KEY = originalEmbeddingKey;
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
});

describe("store-progress status skipped", () => {
  test("skipped is a terminal status", () => {
    expect(isTerminalTaskStatus("skipped")).toBe(true);
  });

  test("refuses a skip without a reason and leaves the task running", async () => {
    const task = await startedTask("thread follow-up, no reason");
    const result = await call({ taskId: task.id, status: "skipped" });
    expect(result.structuredContent?.success).toBe(false);
    expect(result.structuredContent?.message).toContain("one-line reason");
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
    // End it so the agent's capacity check in the next test starts clean.
    await call({ taskId: task.id, status: "skipped", failureReason: "Not mine." });
  });

  test("ends the task as skipped with the reason, frees the agent, and creates no follow-up", async () => {
    // Positive control: the same kind of task, completed, does get a lead follow-up.
    const control = await startedTask("thread follow-up, answered");
    const completed = await call({ taskId: control.id, status: "completed", output: "answered" });
    expect(completed.structuredContent?.success).toBe(true);
    expect(await followUpsOf(control.id)).toBe(1);

    const task = await startedTask("thread follow-up for someone else");
    const result = await call({
      taskId: task.id,
      status: "skipped",
      failureReason: "Addressed to someone else,\n not to me.",
    });
    expect(result.structuredContent?.success).toBe(true);

    const after = await getTaskById(task.id);
    expect(after?.status).toBe("skipped");
    expect(after?.failureReason).toBe("Addressed to someone else, not to me.");
    expect(after?.output).toBeUndefined();
    expect(after?.finishedAt).toBeTruthy();
    expect(await followUpsOf(task.id)).toBe(0);
    expect((await getAgentById(workerId))?.status).toBe("idle");
  });

  test("takes the reason from output when failureReason is absent", async () => {
    const task = await startedTask("thread chatter");
    const result = await call({ taskId: task.id, status: "skipped", output: "People chatting." });
    expect(result.structuredContent?.success).toBe(true);
    const after = await getTaskById(task.id);
    expect(after?.status).toBe("skipped");
    expect(after?.failureReason).toBe("People chatting.");
    expect(after?.output).toBeUndefined();
  });

  test("a repeated skip is a no-op and a later completion cannot revive the task", async () => {
    const task = await startedTask("skip twice");
    await call({ taskId: task.id, status: "skipped", failureReason: "Not mine." });
    const again = await call({ taskId: task.id, status: "skipped", failureReason: "Not mine." });
    expect(again.structuredContent?.success).toBe(true);
    expect((again.structuredContent as { wasNoOp?: boolean } | undefined)?.wasNoOp).toBe(true);

    await call({ taskId: task.id, status: "completed", output: "late answer" });
    const after = await getTaskById(task.id);
    expect(after?.status).toBe("skipped");
    expect(after?.output).toBeUndefined();
    expect(await followUpsOf(task.id)).toBe(0);
  });

  test("a skipped dependency satisfies dependsOn", async () => {
    const dependency = await startedTask("upstream that turns out not to be mine");
    const dependent = await createTaskExtended("downstream", {
      agentId: workerId,
      source: "mcp",
      dependsOn: [dependency.id],
    });
    expect((await checkDependencies(dependent.id)).ready).toBe(false);
    await call({ taskId: dependency.id, status: "skipped", failureReason: "Not mine." });
    expect((await checkDependencies(dependent.id)).ready).toBe(true);
    // Not cascade-failed, unlike a failed or cancelled dependency.
    expect((await getTaskById(dependent.id))?.status).not.toBe("failed");
  });
});
