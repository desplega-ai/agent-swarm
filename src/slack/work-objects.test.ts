import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import type { EntityPresentDetailsArguments } from "@slack/web-api";
import * as db from "../be/db";
import { AgentTaskSchema } from "../types";
import * as handlers from "./handlers";
import { registerWorkObjectHandlers } from "./work-objects";

const taskId = "11111111-2222-4333-8444-555555555555";
const task = AgentTaskSchema.parse({
  id: taskId,
  key: `shared/task:${taskId}/`,
  agentId: null,
  task: "Implement Work Object details",
  title: "Slack flexpane support",
  status: "completed",
  output: "Implemented and tested.",
  createdAt: "2026-09-15T09:00:00.000Z",
  lastUpdatedAt: "2026-09-15T10:00:00.000Z",
  slackChannelId: "C_TASK",
});

type DetailsEvent = SlackEventMiddlewareArgs<"entity_details_requested">["event"];
const event: DetailsEvent = {
  type: "entity_details_requested",
  user: "U_ALLOWED",
  trigger_id: "trigger-123",
  external_ref: { type: "task", id: taskId },
  entity_url: `https://swarm.example/tasks/${taskId}`,
  link: { url: `https://swarm.example/tasks/${taskId}`, domain: "swarm.example" },
  user_locale: "en-US",
  event_ts: "1757923200.000001",
  channel: "C_TASK",
};

describe("Work Object details handler", () => {
  const originalFlag = process.env.SLACK_WORK_OBJECTS_ENABLED;
  const originalAppUrl = process.env.APP_URL;
  const presentDetails = mock(async (_args: EntityPresentDetailsArguments) => ({ ok: true }));
  const client = { entity: { presentDetails } };
  const logger = { error: mock(() => {}) };
  let listener: (args: {
    event: DetailsEvent;
    client: typeof client;
    logger: typeof logger;
  }) => Promise<void>;
  let getTask: ReturnType<typeof spyOn<typeof db, "getTaskById">>;
  let getAgent: ReturnType<typeof spyOn<typeof db, "getAgentById">>;
  let userAllowed: ReturnType<typeof spyOn<typeof handlers, "isUserAllowed">>;

  beforeEach(() => {
    process.env.SLACK_WORK_OBJECTS_ENABLED = "true";
    process.env.APP_URL = "https://swarm.example";
    getTask = spyOn(db, "getTaskById").mockResolvedValue(task);
    getAgent = spyOn(db, "getAgentById").mockResolvedValue(null);
    userAllowed = spyOn(handlers, "isUserAllowed").mockResolvedValue(true);
    presentDetails.mockReset();
    presentDetails.mockResolvedValue({ ok: true });
    logger.error.mockClear();
    registerWorkObjectHandlers({
      event: (name: string, callback: typeof listener) => {
        expect(name).toBe("entity_details_requested");
        listener = callback;
      },
    } as never);
  });

  afterEach(() => {
    getTask.mockRestore();
    getAgent.mockRestore();
    userAllowed.mockRestore();
    if (originalFlag === undefined) delete process.env.SLACK_WORK_OBJECTS_ENABLED;
    else process.env.SLACK_WORK_OBJECTS_ENABLED = originalFlag;
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;
  });

  async function request(overrides: Partial<DetailsEvent> = {}) {
    await listener({ event: { ...event, ...overrides }, client, logger });
  }

  for (const flag of [undefined, "false", "0", "typo"]) {
    test(`does no work when flag is ${flag}`, async () => {
      if (flag === undefined) delete process.env.SLACK_WORK_OBJECTS_ENABLED;
      else process.env.SLACK_WORK_OBJECTS_ENABLED = flag;
      await request();
      expect(getTask).not.toHaveBeenCalled();
      expect(userAllowed).not.toHaveBeenCalled();
      expect(presentDetails).not.toHaveBeenCalled();
    });
  }

  test("responds with current task data and the requesting trigger", async () => {
    await request();
    expect(presentDetails).toHaveBeenCalledTimes(1);
    const response = presentDetails.mock.calls[0]?.[0];
    expect(response?.trigger_id).toBe(event.trigger_id);
    expect(response?.metadata).toMatchObject({
      entity_type: "slack#/entities/task",
      external_ref: event.external_ref,
      url: event.entity_url,
      entity_payload: {
        attributes: { title: { text: task.title }, product_name: "Agent Swarm" },
        fields: {
          description: { value: task.task },
          status: { value: "completed" },
          assignee: { value: "Unassigned" },
        },
        custom_fields: [{ key: "result", label: "Result", value: task.output }],
      },
    });
    expect(response?.metadata).not.toHaveProperty("entities");
    expect(response?.metadata).not.toHaveProperty("app_unfurl_url");
    expect(response).not.toHaveProperty("error");
    expect(userAllowed).toHaveBeenCalledWith(client, event.user);
    expect(getTask).toHaveBeenCalledWith(taskId);
  });

  test("reloads the task for each refresh and accepts 1 as the flag", async () => {
    process.env.SLACK_WORK_OBJECTS_ENABLED = "1";
    await request();
    getTask.mockResolvedValue({
      ...task,
      status: "in_progress",
      output: undefined,
      progress: "Testing",
    });
    await request({ trigger_id: "refresh-trigger", app_unfurl_url: event.entity_url });
    expect(getTask).toHaveBeenCalledTimes(2);
    expect(presentDetails.mock.calls[1]?.[0]).toMatchObject({
      trigger_id: "refresh-trigger",
      metadata: {
        entity_payload: {
          fields: { status: { value: "in_progress" } },
          custom_fields: [{ label: "Progress", value: "Testing" }],
        },
      },
    });
  });

  test("shows failures and bounds long task text", async () => {
    getTask.mockResolvedValue({
      ...task,
      title: undefined,
      task: "x".repeat(10000),
      status: "failed",
      output: undefined,
      failureReason: "y".repeat(10000),
    });
    await request();
    const payload = presentDetails.mock.calls[0]?.[0].metadata?.entity_payload;
    expect(payload?.attributes.title.text.length).toBe(200);
    expect(payload?.fields).toMatchObject({ description: { value: `${"x".repeat(2799)}…` } });
    expect(payload?.custom_fields?.[0]).toMatchObject({
      label: "Failure",
      value: `${"y".repeat(2799)}…`,
    });
  });

  for (const type of ["file", "item", "content_item", "unknown", undefined]) {
    test(`presents an error for unsupported reference type ${type}`, async () => {
      await request({ external_ref: { id: taskId, type } });
      expect(presentDetails).toHaveBeenCalledWith({
        trigger_id: event.trigger_id,
        error: {
          status: "custom",
          custom_title: "Work Object unavailable",
          custom_message: "Agent Swarm does not support this Work Object reference.",
        },
      });
      expect(getTask).not.toHaveBeenCalled();
    });
  }

  test("presents an error when external_ref is absent or empty", async () => {
    await request({ external_ref: undefined });
    await request({ external_ref: { type: "task", id: "" } });
    expect(presentDetails).toHaveBeenCalledTimes(2);
    expect(getTask).not.toHaveBeenCalled();
    for (const [response] of presentDetails.mock.calls)
      expect(response.error?.status).toBe("custom");
  });

  test("presents not_found when the task was deleted", async () => {
    getTask.mockResolvedValue(null);
    await request();
    expect(presentDetails).toHaveBeenCalledWith({
      trigger_id: event.trigger_id,
      error: { status: "not_found" },
    });
  });

  test("denies filtered users before reading the task", async () => {
    userAllowed.mockResolvedValue(false);
    await request();
    expect(getTask).not.toHaveBeenCalled();
    expect(presentDetails).toHaveBeenCalledWith({
      trigger_id: event.trigger_id,
      error: { status: "restricted" },
    });
  });

  for (const channel of [undefined, "C_OTHER"]) {
    test(`does not disclose task details to channel ${channel}`, async () => {
      await request({ channel });
      expect(presentDetails).toHaveBeenCalledWith({
        trigger_id: event.trigger_id,
        error: { status: "restricted" },
      });
    });
  }

  test("does not disclose tasks without a Slack channel", async () => {
    getTask.mockResolvedValue({ ...task, slackChannelId: undefined });
    await request();
    expect(presentDetails.mock.calls[0]?.[0].error?.status).toBe("restricted");
  });

  test("returns an error view when a task lookup fails", async () => {
    getTask.mockRejectedValue(new Error("database unavailable"));
    await request();
    expect(presentDetails).toHaveBeenCalledWith({
      trigger_id: event.trigger_id,
      error: { status: "internal_error" },
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  test("falls back to an error view when Slack rejects the metadata", async () => {
    presentDetails.mockRejectedValueOnce(new Error("invalid_metadata"));
    await request();
    expect(presentDetails).toHaveBeenCalledTimes(2);
    expect(presentDetails.mock.calls[1]?.[0]).toEqual({
      trigger_id: event.trigger_id,
      error: { status: "internal_error" },
    });
  });

  test("logs a failed fallback without an unhandled rejection or retry loop", async () => {
    presentDetails.mockRejectedValue(new Error("Slack unavailable"));
    await request();
    expect(presentDetails).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  test("logs rejection of an unknown object's error response", async () => {
    presentDetails.mockRejectedValue(new Error("Slack unavailable"));
    await request({ external_ref: undefined });
    expect(presentDetails).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
