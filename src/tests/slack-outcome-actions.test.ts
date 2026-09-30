import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { App } from "@slack/bolt";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  failTask,
  getAllTasks,
  initDb,
  startTask,
} from "../be/db";
import { listTaskFeedback, recordTaskFeedback } from "../be/db-queries/task-feedback";
import {
  _resetOutcomeActionsForTests,
  registerOutcomeActionHandlers,
} from "../slack/outcome-actions";
import {
  classifyFailure,
  fallbackFooterParts,
  outcomeActionBlocks,
  parseFeedbackValue,
  sendWithBlocksFallback,
} from "../slack/outcome-card-blocks";
import { registerFeedbackListTool } from "../tools/feedback-list";

const TEST_DB_PATH = "./test-slack-outcome-actions.sqlite";

type Handler = (args: Record<string, unknown>) => Promise<void>;
const actionHandlers = new Map<string, Handler>();
const viewHandlers = new Map<string, Handler>();
const slackCalls: Array<{ method: string; payload: Record<string, unknown> }> = [];

const fakeApp = {
  action: (id: string, handler: Handler) => actionHandlers.set(id, handler),
  view: (id: string, handler: Handler) => viewHandlers.set(id, handler),
};

const fakeClient = {
  views: {
    open: async (payload: Record<string, unknown>) => {
      slackCalls.push({ method: "views.open", payload });
      return { ok: true };
    },
  },
  chat: {
    postEphemeral: async (payload: Record<string, unknown>) => {
      slackCalls.push({ method: "chat.postEphemeral", payload });
      return { ok: true };
    },
  },
  users: {
    info: async () => ({
      ok: true,
      user: { real_name: "Rater", profile: { email: "rater@example.com", real_name: "Rater" } },
    }),
  },
};

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
}

const ack = async () => {};

async function slackTask(label: string) {
  const agent = await createAgent({ name: `${label} Agent`, isLead: true, status: "idle" });
  const task = await createTaskExtended(`${label} prompt`, {
    agentId: agent.id,
    source: "slack",
    slackChannelId: "C_OUTCOME",
    slackThreadTs: `${label.length}.1`,
    slackTriggerMessageTs: `${label.length}.1`,
    slackUserId: "U_ASKER",
    tags: ["ask"],
  });
  return { agent, task };
}

beforeAll(async () => {
  process.env.SLACK_RENDER_V2 = "true";
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  registerOutcomeActionHandlers(fakeApp as unknown as App);
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

beforeEach(() => {
  slackCalls.length = 0;
  _resetOutcomeActionsForTests();
});

describe("outcome card blocks", () => {
  test("A: an answer gets feedback buttons, then Follow up and Open task", () => {
    const blocks = outcomeActionBlocks("task-1", "answer") as Array<Record<string, unknown>>;
    expect(blocks.map((block) => block.type)).toEqual(["context_actions", "actions"]);
    expect(JSON.stringify(blocks[0])).toContain('"type":"feedback_buttons"');
    expect(JSON.stringify(blocks[0])).toContain('"value":"up:task-1"');
    const buttons = (blocks[1]!.elements as Array<Record<string, unknown>>).map((e) => e.action_id);
    expect(buttons).toEqual(["follow_up_task", "view_task_logs"]);
  });

  test("B: a failure gets Retry, Follow up and Open task, no feedback", () => {
    const blocks = outcomeActionBlocks("task-1", "failure") as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    const buttons = (blocks[0]!.elements as Array<Record<string, unknown>>).map((e) => e.action_id);
    expect(buttons).toEqual(["retry_task", "follow_up_task", "view_task_logs"]);
  });

  test("C: the fallback footer links the task and asks for a reaction on answers only", () => {
    expect(fallbackFooterParts("task-1", "answer")).toEqual([
      expect.stringMatching(/^<.+\/tasks\/task-1\|Retry or follow up>$/),
      "react :+1: / :-1: to rate",
    ]);
    expect(fallbackFooterParts("task-1", "failure")).toHaveLength(1);
  });

  test("classifies transient failures apart from can't-do limits", () => {
    expect(classifyFailure("Worker crashed during the run")).toBe("transient");
    expect(classifyFailure("Step timed out after 30000ms")).toBe("transient");
    expect(classifyFailure("script-upsert scope=global is lead-only")).toBe("cant_do");
    expect(classifyFailure("GitHub answered 403 Forbidden")).toBe("cant_do");
    expect(classifyFailure("The PR body is missing a section")).toBeUndefined();
    expect(classifyFailure(null)).toBeUndefined();
  });

  test("parses feedback values", () => {
    expect(parseFeedbackValue("down:abc")).toEqual({ rating: "down", taskId: "abc" });
    expect(parseFeedbackValue("sideways:abc")).toBeUndefined();
  });

  test("retries once without action blocks on invalid_blocks, and only then", async () => {
    const sent: unknown[][] = [];
    const interactive = [{ type: "actions" }];
    const fallback = [{ type: "context" }];
    const result = await sendWithBlocksFallback(
      interactive,
      fallback,
      async (blocks) => {
        sent.push(blocks);
        if (blocks === interactive) throw { data: { error: "invalid_blocks" } };
        return "ok";
      },
      "test",
    );
    expect(result).toBe("ok");
    expect(sent).toEqual([interactive, fallback]);

    await expect(
      sendWithBlocksFallback(
        interactive,
        fallback,
        async () => {
          throw { data: { error: "channel_not_found" } };
        },
        "test",
      ),
    ).rejects.toEqual({ data: { error: "channel_not_found" } });
  });
});

describe("feedback handlers and store", () => {
  test("a thumbs click opens the note modal; submitting records the rating with the note", async () => {
    const { agent, task } = await slackTask("feedback-note");
    await actionHandlers.get("outcome_feedback")!({
      ack,
      client: fakeClient,
      action: { type: "feedback_buttons", value: `down:${task.id}` },
      body: {
        trigger_id: "trigger-1",
        user: { id: "U_RATER" },
        channel: { id: "C_OUTCOME" },
        message: { ts: "99.9", thread_ts: task.slackThreadTs },
      },
    });
    const opened = slackCalls.find((call) => call.method === "views.open");
    const view = opened!.payload.view as { private_metadata: string; callback_id: string };
    expect(view.callback_id).toBe("outcome_feedback_reason");
    expect(await listTaskFeedback({ taskId: task.id })).toHaveLength(0);

    await viewHandlers.get("outcome_feedback_reason")!({
      ack,
      client: fakeClient,
      body: { user: { id: "U_RATER" } },
      view: {
        callback_id: view.callback_id,
        private_metadata: view.private_metadata,
        state: {
          values: { feedback_note: { feedback_note_text: { value: "missed the PR link" } } },
        },
      },
    });

    const [row] = await listTaskFeedback({ taskId: task.id });
    expect(row).toMatchObject({
      taskId: task.id,
      agentId: agent.id,
      rating: -1,
      note: "missed the PR link",
      source: "slack",
      sourceRef: { channelId: "C_OUTCOME", messageTs: "99.9", slackUserId: "U_RATER" },
    });
    expect(row!.requestedByUserId).toBeTruthy();
    expect(slackCalls.some((call) => call.method === "chat.postEphemeral")).toBe(true);
  });

  test("submitting with no note still records the rating", async () => {
    const { task } = await slackTask("feedback-empty");
    await viewHandlers.get("outcome_feedback_reason")!({
      ack,
      client: fakeClient,
      body: { user: { id: "U_RATER" } },
      view: {
        callback_id: "outcome_feedback_reason",
        private_metadata: JSON.stringify({ taskId: task.id, rating: "up" }),
        state: { values: { feedback_note: { feedback_note_text: { value: null } } } },
      },
    });
    const [row] = await listTaskFeedback({ taskId: task.id });
    expect(row).toMatchObject({ rating: 1, note: null });
  });

  test("feedback-list filters by rating and since", async () => {
    const { task } = await slackTask("feedback-list");
    await recordTaskFeedback({ taskId: task.id, rating: 1, source: "api" });
    await recordTaskFeedback({ taskId: task.id, rating: -1, note: "wrong repo", source: "api" });

    const server = new McpServer({ name: "feedback-list-test", version: "1" });
    registerFeedbackListTool(server);
    const tool = (
      server as unknown as {
        _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }>;
      }
    )._registeredTools["feedback-list"]!;
    const result = (await tool.handler(
      { rating: -1, taskId: task.id, since: "2000-01-01T00:00:00.000Z" },
      { sessionId: "t", requestInfo: { headers: {} } },
    )) as { structuredContent: { feedback: Array<{ note: string; rating: number }> } };
    expect(result.structuredContent.feedback).toEqual([
      expect.objectContaining({ rating: -1, note: "wrong repo" }),
    ]);
    expect(await listTaskFeedback({ taskId: task.id, since: "2999-01-01T00:00:00.000Z" })).toEqual(
      [],
    );
  });
});

describe("retry handler", () => {
  test("re-creates a failed task once, with the same prompt, agent and thread", async () => {
    const { agent, task } = await slackTask("retry-failed");
    await startTask(task.id);
    await failTask(task.id, "Worker crashed");
    const click = {
      ack,
      client: fakeClient,
      action: { type: "button", value: task.id },
      body: { user: { id: "U_RETRIER" } },
    };
    await actionHandlers.get("retry_task")!(click);
    await actionHandlers.get("retry_task")!(click);

    const retries = (await getAllTasks()).filter(
      (candidate) => candidate.id !== task.id && candidate.task === task.task,
    );
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({
      agentId: agent.id,
      source: "slack",
      slackChannelId: task.slackChannelId,
      slackThreadTs: task.slackThreadTs,
      slackUserId: "U_RETRIER",
      tags: expect.arrayContaining(["ask"]),
    });
  });

  test("does nothing for a task that did not fail", async () => {
    const { task } = await slackTask("retry-live");
    await actionHandlers.get("retry_task")!({
      ack,
      client: fakeClient,
      action: { type: "button", value: task.id },
      body: { user: { id: "U_RETRIER" } },
    });
    const copies = (await getAllTasks()).filter((candidate) => candidate.task === task.task);
    expect(copies).toHaveLength(1);
  });
});
