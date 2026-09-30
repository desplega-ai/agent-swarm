import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodType } from "zod";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getTaskAttachments,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import { registerStoreProgressTool } from "../tools/store-progress";
import type { SwarmToolResult } from "../tools/utils";

// Regression: a workflow foreach child saw a sibling's task id in its prompt
// and completed that sibling's task with its own report. Only the assignee
// (or a lead) may write a task's progress, status, or attachments.
const ownerId = "aaaa0000-0000-4000-8000-000000000a01";
const siblingId = "bbbb0000-0000-4000-8000-000000000a02";
const leadId = "cccc0000-0000-4000-8000-000000000a03";

const server = new McpServer({ name: "store-progress-ownership", version: "1.0.0" });
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

async function call(args: unknown, callerId: string, sourceTaskId?: string) {
  return tool.handler(tool.inputSchema.parse(args), {
    sessionId: "store-progress-ownership-session",
    requestInfo: {
      headers: {
        "x-agent-id": callerId,
        ...(sourceTaskId ? { "x-source-task-id": sourceTaskId } : {}),
      },
    },
  });
}

async function task(owner: string | null) {
  const row = await createTaskExtended("ownership regression", {
    ...(owner ? { agentId: owner } : {}),
    source: "system",
    followUpConfig: { disabled: true },
  });
  if (owner) await startTask(row.id);
  return row;
}

const originalEmbeddingKey = process.env.EMBEDDING_API_KEY;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
beforeAll(async () => {
  process.env.EMBEDDING_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  initDb(":memory:");
  await createAgent({ id: ownerId, name: "Owner worker", isLead: false, status: "idle" });
  await createAgent({ id: siblingId, name: "Sibling worker", isLead: false, status: "idle" });
  await createAgent({ id: leadId, name: "Lead", role: "lead", isLead: true, status: "idle" });
});
afterAll(() => {
  closeDb();
  if (originalEmbeddingKey === undefined) delete process.env.EMBEDDING_API_KEY;
  else process.env.EMBEDDING_API_KEY = originalEmbeddingKey;
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
});

describe("store-progress task ownership", () => {
  test("a non-lead non-owner cannot complete another agent's task", async () => {
    const target = await task(ownerId);
    const own = await task(siblingId);
    const result = await call(
      {
        taskId: target.id,
        status: "completed",
        output: "sibling report",
        attachments: [{ kind: "url", name: "report", url: "https://example.com/r" }],
      },
      siblingId,
      own.id,
    );
    expect(result.structuredContent?.success).toBe(false);
    expect(result.structuredContent?.message).toContain("assigned to another agent");
    // The refusal names the caller's own task so it can retry correctly.
    expect(result.structuredContent?.message).toContain(own.id);
    const after = await getTaskById(target.id);
    expect(after?.status).toBe("in_progress");
    expect(after?.output).toBeUndefined();
    expect(await getTaskAttachments(target.id)).toHaveLength(0);
  });

  test("a non-lead non-owner cannot write progress, and the retry hint falls back to its in-progress task", async () => {
    const target = await task(ownerId);
    const own = await task(siblingId);
    const result = await call({ taskId: target.id, progress: "not mine" }, siblingId);
    expect(result.structuredContent?.success).toBe(false);
    expect(result.structuredContent?.message).toContain(own.id);
    expect((await getTaskById(target.id))?.progress).toBeUndefined();
  });

  test("the owner can write progress and complete its task", async () => {
    const own = await task(ownerId);
    expect(
      (await call({ taskId: own.id, progress: "halfway" }, ownerId)).structuredContent?.success,
    ).toBe(true);
    expect((await getTaskById(own.id))?.progress).toBe("halfway");
    const result = await call({ taskId: own.id, status: "completed", output: "done" }, ownerId);
    expect(result.structuredContent?.success).toBe(true);
    expect((await getTaskById(own.id))?.status).toBe("completed");
  });

  test("a lead can still complete a worker's task", async () => {
    const target = await task(ownerId);
    const result = await call(
      { taskId: target.id, status: "completed", output: "closed by lead" },
      leadId,
    );
    expect(result.structuredContent?.success).toBe(true);
    expect((await getTaskById(target.id))?.status).toBe("completed");
  });

  test("an unassigned task stays writable, matching POST /api/tasks/:id/finish", async () => {
    const target = await task(null);
    const result = await call({ taskId: target.id, progress: "pool note" }, siblingId);
    expect(result.structuredContent?.success).toBe(true);
  });
});
