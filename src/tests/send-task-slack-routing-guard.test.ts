import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { closeDb, createAgent, createTaskExtended, getTaskById, initDb } from "../be/db";
import { slackContextKey } from "../tasks/context-key";
import { registerSendTaskTool, sendTaskInputSchema } from "../tools/send-task";

const TEST_DB_PATH = "./test-send-task-slack-routing-guard.sqlite";

const LEAD_ID = "33333333-3333-4333-a333-333333333333";
const WORKER_ID = "44444444-4444-4444-a444-444444444444";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
};

function callSendTask(
  server: McpServer,
  args: Record<string, unknown>,
  callerAgentId: string,
  sourceTaskId?: string,
): Promise<CallToolResult> {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = tools["send-task"];
  if (!tool) throw new Error("send-task not registered");
  const headers: Record<string, string> = { "x-agent-id": callerAgentId };
  if (sourceTaskId) headers["x-source-task-id"] = sourceTaskId;
  const extra = {
    sessionId: "test-session",
    requestInfo: { headers },
  };
  return tool.handler(args, extra);
}

function structuredOf(result: CallToolResult) {
  return result.structuredContent as {
    success: boolean;
    task?: { id: string };
    message: string;
  };
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
  closeDb();
  initDb(TEST_DB_PATH);
  createAgent({ id: LEAD_ID, name: "Routing Lead", isLead: true, status: "idle" });
  createAgent({ id: WORKER_ID, name: "Routing Worker", isLead: false, status: "idle" });
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
});

describe("send-task: Slack-routing coherence guard", () => {
  const server = new McpServer({ name: "test-send-task-slack-routing", version: "1.0.0" });
  registerSendTaskTool(server);

  test("incident replay: explicit channel disagrees with parent + contextKey → rejected, names both sources", async () => {
    const contextKey = slackContextKey({
      channelId: "D0ATCHCQR4M",
      threadTs: "1783596696.921879",
    });
    const parentTask = createTaskExtended("parent task in Gerard's DM", {
      slackChannelId: "D0ATCHCQR4M",
      slackThreadTs: "1783596696.921879",
      slackUserId: "U03QP36M2V7",
      contextKey,
    });

    const result = await callSendTask(
      server,
      {
        task: "follow-up dispatched to the wrong channel",
        slackChannelId: "D0ASZJS6HUN", // Daniel's DM — wrong
        slackThreadTs: "1783596696.921879",
        allowDuplicate: true,
      },
      LEAD_ID,
      parentTask.id,
    );

    const s = structuredOf(result);
    expect(s.success).toBe(false);
    expect(s.message).toContain("Slack routing mismatch");
    expect(s.message).toContain("D0ASZJS6HUN");
    expect(s.message).toContain("D0ATCHCQR4M");
  });

  test("explicit channel matches the parent's but explicit thread diverges → rejected, names both threads", async () => {
    const parentTask = createTaskExtended("parent task in a channel", {
      slackChannelId: "C_SAME_CHANNEL",
      slackThreadTs: "111.111",
    });

    const result = await callSendTask(
      server,
      {
        task: "same-channel dispatch to the wrong thread",
        slackChannelId: "C_SAME_CHANNEL",
        slackThreadTs: "999.999", // wrong thread — parent's is 111.111
        allowDuplicate: true,
      },
      LEAD_ID,
      parentTask.id,
    );

    const s = structuredOf(result);
    expect(s.success).toBe(false);
    expect(s.message).toContain("Slack routing mismatch");
    expect(s.message).toContain("999.999");
    expect(s.message).toContain("111.111");
  });

  test("overrideSlackContext: true allows a deliberate same-channel, different-thread dispatch", async () => {
    const parentTask = createTaskExtended("parent task in a channel", {
      slackChannelId: "C_SAME_CHANNEL_OVERRIDE",
      slackThreadTs: "111.111",
    });

    const result = await callSendTask(
      server,
      {
        task: "deliberate same-channel escalation to a new thread",
        slackChannelId: "C_SAME_CHANNEL_OVERRIDE",
        slackThreadTs: "999.999",
        overrideSlackContext: true,
        allowDuplicate: true,
      },
      LEAD_ID,
      parentTask.id,
    );

    const s = structuredOf(result);
    expect(s.success).toBe(true);
    const created = getTaskById(s.task!.id);
    expect(created?.slackChannelId).toBe("C_SAME_CHANNEL_OVERRIDE");
    expect(created?.slackThreadTs).toBe("999.999");
  });

  test("overrideSlackContext: true allows the deliberate cross-channel dispatch", async () => {
    const parentTask = createTaskExtended("parent task", {
      slackChannelId: "C_ORIGINAL",
      slackThreadTs: "111.111",
    });

    const result = await callSendTask(
      server,
      {
        task: "deliberate escalation to another channel",
        slackChannelId: "C_ESCALATION",
        slackThreadTs: "222.222",
        overrideSlackContext: true,
        allowDuplicate: true,
      },
      LEAD_ID,
      parentTask.id,
    );

    const s = structuredOf(result);
    expect(s.success).toBe(true);
    const created = getTaskById(s.task!.id);
    expect(created?.slackChannelId).toBe("C_ESCALATION");
    expect(created?.slackThreadTs).toBe("222.222");
  });

  test("overrideSlackContext survives the DB residual-mismatch guard when the parent carries a contextKey", async () => {
    const contextKey = slackContextKey({ channelId: "C_ORIGINAL_CTX", threadTs: "111.111" });
    const parentTask = createTaskExtended("parent task with contextKey", {
      slackChannelId: "C_ORIGINAL_CTX",
      slackThreadTs: "111.111",
      contextKey,
    });

    const result = await callSendTask(
      server,
      {
        task: "deliberate escalation to another channel, parent has a contextKey",
        slackChannelId: "C_ESCALATION_CTX",
        slackThreadTs: "222.222",
        overrideSlackContext: true,
        allowDuplicate: true,
      },
      LEAD_ID,
      parentTask.id,
    );

    const s = structuredOf(result);
    expect(s.success).toBe(true);
    const created = getTaskById(s.task!.id);
    // Without overrideSlackContext propagating into createTaskExtended, the
    // DB's residual-mismatch normalization would silently pull this back to
    // the parent's contextKey channel — defeating the deliberate override.
    expect(created?.slackChannelId).toBe("C_ESCALATION_CTX");
    expect(created?.slackThreadTs).toBe("222.222");
  });

  test("explicit Slack unit identical to parent's → accepted, no behavior change", async () => {
    const parentTask = createTaskExtended("parent task same channel", {
      slackChannelId: "C_SAME",
      slackThreadTs: "333.333",
    });

    const result = await callSendTask(
      server,
      {
        task: "verbatim-copy dispatch",
        slackChannelId: "C_SAME",
        slackThreadTs: "333.333",
        allowDuplicate: true,
      },
      LEAD_ID,
      parentTask.id,
    );

    const s = structuredOf(result);
    expect(s.success).toBe(true);
  });

  test("partial unit (channel without threadTs) is rejected", async () => {
    const result = await callSendTask(
      server,
      {
        task: "partial slack unit",
        slackChannelId: "C_PARTIAL",
        allowDuplicate: true,
      },
      LEAD_ID,
    );

    const s = structuredOf(result);
    expect(s.success).toBe(false);
    expect(s.message).toContain("Slack routing rejected");
  });

  test("no Slack fields at all → accepted (inheritance path)", async () => {
    const parentTask = createTaskExtended("parent for inheritance", {
      slackChannelId: "C_INHERIT",
      slackThreadTs: "444.444",
    });

    const result = await callSendTask(
      server,
      { task: "omit slack fields — inherit", allowDuplicate: true },
      LEAD_ID,
      parentTask.id,
    );

    const s = structuredOf(result);
    expect(s.success).toBe(true);
    const created = getTaskById(s.task!.id);
    expect(created?.slackChannelId).toBe("C_INHERIT");
    expect(created?.slackThreadTs).toBe("444.444");
  });

  test("direct-assign path is guarded identically to the pool path", async () => {
    const parentTask = createTaskExtended("parent for direct assign", {
      slackChannelId: "C_DIRECT_PARENT",
      slackThreadTs: "555.555",
    });

    const result = await callSendTask(
      server,
      {
        task: "direct assign with wrong channel",
        agentId: WORKER_ID,
        slackChannelId: "C_WRONG_DIRECT",
        slackThreadTs: "555.555",
        allowDuplicate: true,
      },
      LEAD_ID,
      parentTask.id,
    );

    const s = structuredOf(result);
    expect(s.success).toBe(false);
    expect(s.message).toContain("Slack routing mismatch");
  });

  test("offerMode path is guarded identically to the pool path", async () => {
    const parentTask = createTaskExtended("parent for offer", {
      slackChannelId: "C_OFFER_PARENT",
      slackThreadTs: "666.666",
    });

    const result = await callSendTask(
      server,
      {
        task: "offer with wrong channel",
        agentId: WORKER_ID,
        offerMode: true,
        slackChannelId: "C_WRONG_OFFER",
        slackThreadTs: "666.666",
        allowDuplicate: true,
      },
      LEAD_ID,
      parentTask.id,
    );

    const s = structuredOf(result);
    expect(s.success).toBe(false);
    expect(s.message).toContain("Slack routing mismatch");
  });

  test("user-context root (no parent, no contextKey) accepts a fresh, complete Slack unit", async () => {
    const result = await callSendTask(
      server,
      {
        task: "brand new slack root",
        slackChannelId: "C_NEW_ROOT",
        slackThreadTs: "777.777",
        allowDuplicate: true,
      },
      LEAD_ID,
    );

    const s = structuredOf(result);
    expect(s.success).toBe(true);
  });

  test("schema rejects a partial unit at the zod layer (both-or-neither)", () => {
    const channelOnly = sendTaskInputSchema.safeParse({
      task: "partial unit",
      slackChannelId: "C_ONLY",
    });
    expect(channelOnly.success).toBe(false);

    const threadOnly = sendTaskInputSchema.safeParse({
      task: "partial unit",
      slackThreadTs: "111.111",
    });
    expect(threadOnly.success).toBe(false);

    const bothOmitted = sendTaskInputSchema.safeParse({ task: "no slack fields" });
    expect(bothOmitted.success).toBe(true);

    const bothSet = sendTaskInputSchema.safeParse({
      task: "full unit",
      slackChannelId: "C_FULL",
      slackThreadTs: "222.222",
    });
    expect(bothSet.success).toBe(true);
  });
});
