/**
 * Card Button clicks in Slack: the `swarm_ui:` action handler runs the shared
 * executor once, for the task requester only, and only behind the flag.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { closeDb, createTaskExtended, createUser, getDbClient, initDb } from "../be/db";
import { upsertTaskUiSpec } from "../be/task-ui-spec";
import { registerActionHandlers } from "../slack/actions";
import * as slackEnrichModule from "../slack/enrich";
import * as externalChannelModule from "../slack/external-channel";

const TEST_DB_PATH = "./test-task-ui-actions.sqlite";
const previousEnv = {
  UI_SPEC_ACTIONS_ENABLED: process.env.UI_SPEC_ACTIONS_ENABLED,
  SLACK_RENDER_V2: process.env.SLACK_RENDER_V2,
};

type Handler = (args: Record<string, unknown>) => Promise<void>;
let uiActionPattern: RegExp | undefined;
let uiAction: Handler;
const resolveSlackUserIdSpy = spyOn(slackEnrichModule, "resolveSlackUserId");
const shouldBlockChannelSpy = spyOn(externalChannelModule, "shouldBlockChannel");

let requesterId = "";
let otherUserId = "";

beforeAll(async () => {
  initDb(TEST_DB_PATH);
  process.env.SLACK_RENDER_V2 = "false";
  shouldBlockChannelSpy.mockImplementation(async () => false);
  // U_REQUESTER resolves to the task requester; any other Slack user to a bystander.
  resolveSlackUserIdSpy.mockImplementation(async (_client, slackUserId) =>
    slackUserId === "U_REQUESTER" ? requesterId : otherUserId,
  );
  registerActionHandlers({
    action: (id: string | RegExp, handler: Handler) => {
      if (id instanceof RegExp) {
        uiActionPattern = id;
        uiAction = handler;
      }
    },
    view: () => {},
  } as never);
  requesterId = (await createUser({ name: "Requester" })).id;
  otherUserId = (await createUser({ name: "Bystander" })).id;
});

afterAll(async () => {
  resolveSlackUserIdSpy.mockRestore();
  shouldBlockChannelSpy.mockRestore();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) await rm(`${TEST_DB_PATH}${suffix}`, { force: true });
});

beforeEach(() => {
  process.env.UI_SPEC_ACTIONS_ENABLED = "true";
});

async function taskWithButton(): Promise<string> {
  const task = await createTaskExtended("Weekly deploys", {
    source: "slack",
    slackChannelId: "C_TEST",
    slackThreadTs: "1960000000.000100",
    slackUserId: "U_REQUESTER",
    requestedByUserId: requesterId,
  });
  await upsertTaskUiSpec(task.id, {
    spec: {
      root: "c",
      elements: {
        c: { type: "Card", props: { title: "Deploys" }, children: ["a"] },
        a: { type: "Actions", props: {}, children: ["b"] },
        b: { type: "Button", props: { id: "rerun", label: "Run again" }, children: [] },
      },
    },
    actions: { rerun: { kind: "follow_up", prompt: "Run the weekly deploys report again." } },
    fallbackText: "Deploys",
  });
  return task.id;
}

function slackClient() {
  return { chat: { postEphemeral: mock(async () => ({ ok: true })) } };
}

async function click(taskId: string, slackUserId: string) {
  const client = slackClient();
  await uiAction({
    ack: async () => {},
    action: { type: "button", action_id: "swarm_ui:rerun", value: taskId },
    body: { user: { id: slackUserId, team_id: "T_TEST" }, channel: { id: "C_TEST" } },
    client,
  });
  return client.chat.postEphemeral;
}

async function followUps(taskId: string) {
  return getDbClient().query<{ id: string; task: string; requestedByUserId: string | null }>(
    "SELECT id, task, requestedByUserId FROM agent_tasks WHERE parentTaskId = ?",
    [taskId],
  );
}

describe("Slack card Button clicks", () => {
  test("the handler listens on the swarm_ui: action prefix", () => {
    expect(uiActionPattern?.test("swarm_ui:rerun")).toBe(true);
    expect(uiActionPattern?.test("follow_up_task")).toBe(false);
  });

  test("a requester click creates one follow-up task", async () => {
    const taskId = await taskWithButton();
    const ephemeral = await click(taskId, "U_REQUESTER");
    expect(ephemeral).not.toHaveBeenCalled();
    const created = await followUps(taskId);
    expect(created).toHaveLength(1);
    expect(created[0]?.task).toContain("Run the weekly deploys report again.");
    expect(created[0]?.requestedByUserId).toBe(requesterId);
    const run = await getDbClient().get<{ surface: string; resultTaskId: string | null }>(
      `SELECT surface, result_task_id AS resultTaskId FROM task_ui_action_runs
      WHERE task_id = ? AND action_id = 'rerun'`,
      [taskId],
    );
    expect(run).toEqual({ surface: "slack", resultTaskId: created[0]?.id ?? null });
  });

  test("a second click creates no task and replies already_done", async () => {
    const taskId = await taskWithButton();
    await click(taskId, "U_REQUESTER");
    const ephemeral = await click(taskId, "U_REQUESTER");
    expect(await followUps(taskId)).toHaveLength(1);
    expect(ephemeral).toHaveBeenCalledTimes(1);
    expect(ephemeral.mock.calls[0]?.[0]).toMatchObject({
      channel: "C_TEST",
      user: "U_REQUESTER",
      text: "This button already ran.",
    });
  });

  test("another user's click creates no task and replies forbidden", async () => {
    const taskId = await taskWithButton();
    const ephemeral = await click(taskId, "U_OTHER");
    expect(await followUps(taskId)).toHaveLength(0);
    expect(ephemeral.mock.calls[0]?.[0]).toMatchObject({
      user: "U_OTHER",
      text: "Only the person who asked for this task can use its buttons.",
    });
  });

  test("with the flag off a click creates no task and replies disabled", async () => {
    process.env.UI_SPEC_ACTIONS_ENABLED = "false";
    const taskId = await taskWithButton();
    const ephemeral = await click(taskId, "U_REQUESTER");
    expect(await followUps(taskId)).toHaveLength(0);
    expect(ephemeral.mock.calls[0]?.[0]).toMatchObject({
      text: "Card buttons are turned off on this swarm.",
    });
  });
});
