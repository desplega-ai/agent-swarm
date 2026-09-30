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
  getTaskAttachments,
  initDb,
  insertTaskAttachment,
  startTask,
} from "../be/db";
import { listTaskFeedback, recordTaskFeedback } from "../be/db-queries/task-feedback";
import { registerActionHandlers } from "../slack/actions";
import { resolveSlackUserId } from "../slack/enrich";
import { _resetOutcomeActionsForTests } from "../slack/outcome-actions";
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
    // One email per Slack user; U_UNMAPPED has none, so it never resolves.
    info: async ({ user }: { user: string }) => ({
      ok: true,
      user:
        user === "U_UNMAPPED"
          ? { real_name: "Guest", profile: { real_name: "Guest" } }
          : {
              real_name: user,
              profile: { email: `${user.toLowerCase()}@example.com`, real_name: user },
            },
    }),
  },
};

/** A Slack error as @slack/web-api throws it. */
function slackError(code: string) {
  return Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } });
}

function ephemeralTexts(): string[] {
  return slackCalls
    .filter((call) => call.method === "chat.postEphemeral")
    .map((call) => String(call.payload.text));
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
}

const ack = async () => {};

let threadCounter = 0;

async function slackTask(label: string, extra: Parameters<typeof createTaskExtended>[1] = {}) {
  const agent = await createAgent({ name: `${label} Agent`, isLead: true, status: "idle" });
  const requestedByUserId = await resolveSlackUserId(fakeClient as never, "U_ASKER", {
    sampleEventType: "message",
    sampleContext: "test",
  });
  // One thread per task: a live sibling in the same thread rewrites the prompt.
  const threadTs = `${++threadCounter}.1`;
  const task = await createTaskExtended(`${label} prompt`, {
    requestedByUserId,
    agentId: agent.id,
    source: "slack",
    slackChannelId: "C_OUTCOME",
    slackThreadTs: threadTs,
    slackTriggerMessageTs: threadTs,
    slackUserId: "U_ASKER",
    tags: ["ask"],
    ...extra,
  });
  return { agent, task };
}

beforeAll(async () => {
  process.env.SLACK_RENDER_V2 = "true";
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  // Registers the outcome handlers too, plus the Follow up modal they reuse.
  registerActionHandlers(fakeApp as unknown as App);
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

  test("falls back on every block-level rejection Slack documents", async () => {
    for (const code of ["invalid_blocks", "invalid_blocks_format", "msg_blocks_too_long"]) {
      const sent: unknown[][] = [];
      const interactive = [{ type: "actions" }];
      const fallback = [{ type: "context" }];
      await sendWithBlocksFallback(
        interactive,
        fallback,
        async (blocks) => {
          sent.push(blocks);
          if (blocks === interactive) throw slackError(code);
          return "ok";
        },
        "test",
      );
      expect(sent).toEqual([interactive, fallback]);
    }
  });

  test("never re-sends on bad credentials, a posting denial or the free-plan cap", async () => {
    for (const code of [
      "invalid_auth",
      "not_authed",
      "token_revoked",
      "account_inactive",
      "missing_scope",
      "no_permission",
      "not_in_channel",
      "restricted_action",
      "ekm_access_denied",
      "message_limit_exceeded",
    ]) {
      let sends = 0;
      await expect(
        sendWithBlocksFallback(
          [{ type: "actions" }],
          [{ type: "context" }],
          async () => {
            sends++;
            throw slackError(code);
          },
          "test",
        ),
      ).rejects.toMatchObject({ data: { error: code } });
      expect(sends).toBe(1);
    }
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
      body: { user: { id: "U_ASKER" } },
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
      slackUserId: "U_ASKER",
      requestedByUserId: task.requestedByUserId,
      tags: expect.arrayContaining(["ask"]),
    });
  });

  test("another user and an unmapped user are denied and create no task", async () => {
    const { task } = await slackTask("retry-denied");
    await startTask(task.id);
    await failTask(task.id, "Worker crashed");
    for (const clicker of ["U_OTHER", "U_UNMAPPED"]) {
      await actionHandlers.get("retry_task")!({
        ack,
        client: fakeClient,
        action: { type: "button", value: task.id },
        body: { user: { id: clicker } },
      });
    }
    const copies = () => getAllTasks().then((all) => all.filter((t) => t.task === task.task));
    expect(await copies()).toHaveLength(1);
    expect(ephemeralTexts()).toEqual([
      "Only the person who asked for this task can retry it.",
      "Only the person who asked for this task can retry it.",
    ]);

    // A denial must not use up the requester's retry.
    await actionHandlers.get("retry_task")!({
      ack,
      client: fakeClient,
      action: { type: "button", value: task.id },
      body: { user: { id: "U_ASKER" } },
    });
    expect(await copies()).toHaveLength(2);
  });

  test("keeps the execution inputs: dir, output contract, model settings, repo and input files", async () => {
    const outputSchema = {
      type: "object",
      properties: { prUrl: { type: "string" } },
      required: ["prUrl"],
    };
    const { task } = await slackTask("retry-contract", {
      dir: "/workspace/repos/special",
      outputSchema,
      model: "sonnet",
      effort: "high",
      vcsProvider: "github",
      vcsRepo: "desplega-ai/agent-swarm",
    });
    await insertTaskAttachment({
      taskId: task.id,
      agentId: null,
      name: "brief.pdf",
      kind: "url",
      url: "https://files.example.com/brief.pdf",
      intent: "user-upload",
    });
    await insertTaskAttachment({
      taskId: task.id,
      agentId: task.agentId ?? null,
      name: "half-done report",
      kind: "url",
      url: "https://files.example.com/report.md",
      intent: "task-deliverable",
    });
    await startTask(task.id);
    await failTask(task.id, "Worker crashed");

    await actionHandlers.get("retry_task")!({
      ack,
      client: fakeClient,
      action: { type: "button", value: task.id },
      body: { user: { id: "U_ASKER" } },
    });

    const retry = (await getAllTasks()).find((t) => t.id !== task.id && t.task === task.task);
    expect(retry).toMatchObject({
      dir: "/workspace/repos/special",
      outputSchema,
      model: "sonnet",
      effort: "high",
      vcsProvider: "github",
      vcsRepo: "desplega-ai/agent-swarm",
      key: task.key,
      status: "pending",
    });
    const files = await getTaskAttachments(retry!.id);
    expect(files.map((file) => [file.name, file.intent])).toEqual([["brief.pdf", "user-upload"]]);
  });

  test("a retry of a lead-only task stays lead-only on the same agent", async () => {
    const { agent, task } = await slackTask("retry-lead-only", {
      routingAffinity: { capabilities: [], leadOnly: true },
    });
    await startTask(task.id);
    await failTask(task.id, "Worker crashed");
    await actionHandlers.get("retry_task")!({
      ack,
      client: fakeClient,
      action: { type: "button", value: task.id },
      body: { user: { id: "U_ASKER" } },
    });
    const retry = (await getAllTasks()).find((t) => t.id !== task.id && t.task === task.task);
    expect(retry).toMatchObject({
      agentId: agent.id,
      status: "pending",
      routingAffinity: { leadOnly: true },
    });
  });

  test("does nothing for a task that did not fail", async () => {
    const { task } = await slackTask("retry-live");
    await actionHandlers.get("retry_task")!({
      ack,
      client: fakeClient,
      action: { type: "button", value: task.id },
      body: { user: { id: "U_ASKER" } },
    });
    const copies = (await getAllTasks()).filter((candidate) => candidate.task === task.task);
    expect(copies).toHaveLength(1);
  });
});

describe("follow up", () => {
  function submission(taskId: string, slackUserId: string, text: string) {
    return {
      ack,
      client: fakeClient,
      body: { user: { id: slackUserId } },
      view: {
        callback_id: "follow_up_submit",
        private_metadata: taskId,
        state: { values: { follow_up_input: { follow_up_text: { value: text } } } },
      },
    };
  }

  test("only the requester's submission creates a follow-up task", async () => {
    const { task } = await slackTask("follow-up-authz");
    const followUps = () =>
      getAllTasks().then((all) => all.filter((t) => t.parentTaskId === task.id));

    await viewHandlers.get("follow_up_submit")!(submission(task.id, "U_OTHER", "other ask"));
    await viewHandlers.get("follow_up_submit")!(submission(task.id, "U_UNMAPPED", "guest ask"));
    expect(await followUps()).toHaveLength(0);
    expect(ephemeralTexts()).toEqual([
      "Only the person who asked for this task can follow up on it.",
      "Only the person who asked for this task can follow up on it.",
    ]);

    await viewHandlers.get("follow_up_submit")!(submission(task.id, "U_ASKER", "now add tests"));
    const [followUp] = await followUps();
    expect(followUp).toMatchObject({
      task: "now add tests",
      requestedByUserId: task.requestedByUserId,
    });
  });

  test("a modal that cannot open sends the clicker the task link instead", async () => {
    const { task } = await slackTask("follow-up-no-modal");
    await actionHandlers.get("follow_up_task")!({
      ack,
      client: {
        ...fakeClient,
        views: {
          open: async () => {
            throw slackError("missing_scope");
          },
        },
      },
      action: { type: "button", value: task.id },
      body: {
        trigger_id: "trigger-2",
        user: { id: "U_ASKER" },
        channel: { id: "C_OUTCOME" },
        message: { ts: "77.7", thread_ts: task.slackThreadTs },
      },
    });
    const [receipt] = slackCalls.filter((call) => call.method === "chat.postEphemeral");
    expect(receipt?.payload).toMatchObject({
      channel: "C_OUTCOME",
      user: "U_ASKER",
      thread_ts: task.slackThreadTs,
    });
    expect(String(receipt?.payload.text)).toContain(`/tasks/${task.id}`);
  });
});
