import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  getChildTasks,
  getLatestActiveTaskInThread,
  getSteeringMessagesForTask,
  initDb,
  startTask,
} from "../be/db";

process.env.SLACK_RENDER_V2 = "false";

import { buildTreeBlocks } from "../slack/blocks";
import { routeMessage } from "../slack/router";
import { requestSlackThreadSteering } from "../slack/steering";
import { bufferThreadMessage, instantFlush } from "../slack/thread-buffer";

const TEST_DB_PATH = `/tmp/agent-swarm-slack-steering-${process.pid}.sqlite`;
const previousSteering = process.env.SLACK_THREAD_STEERING;
const previousSteeringMode = process.env.SLACK_THREAD_STEERING_MODE;
const previousRequireMention = process.env.SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION;

let leadId: string;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function createRunningSlackTask(
  agentId: string,
  channelId: string,
  threadTs: string,
  task = "existing Slack task",
) {
  const created = createTaskExtended(task, {
    agentId,
    source: "slack",
    slackChannelId: channelId,
    slackThreadTs: threadTs,
    slackUserId: "U_REQUESTER",
  });
  const started = startTask(created.id);
  expect(started?.status).toBe("in_progress");
  return started!;
}

const previousSteeringEnabled = process.env.STEERING_ENABLED;

beforeAll(() => {
  process.env.STEERING_ENABLED = "true";
  initDb(TEST_DB_PATH);
  leadId = createAgent({
    name: "slack-steering-lead",
    isLead: true,
    status: "busy",
    capabilities: [],
    harnessProvider: "pi",
  }).id;
});

afterAll(() => {
  restoreEnv("STEERING_ENABLED", previousSteeringEnabled);
  restoreEnv("SLACK_THREAD_STEERING", previousSteering);
  restoreEnv("SLACK_THREAD_STEERING_MODE", previousSteeringMode);
  restoreEnv("SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION", previousRequireMention);
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {
      // Test database may not have created every SQLite sidecar.
    }
  }
});

describe("Slack thread steering", () => {
  test("off preserves the buffered follow-up task path", async () => {
    process.env.SLACK_THREAD_STEERING = "off";
    const channelId = "C_STEER_OFF";
    const threadTs = "1000.0001";
    const leadTask = createRunningSlackTask(leadId, channelId, threadTs);

    bufferThreadMessage(channelId, threadTs, "follow up after the current task", "U1", "1000.0002");
    await instantFlush(`${channelId}:${threadTs}`);

    expect(getSteeringMessagesForTask(leadTask.id)).toEqual([]);
    expect(getChildTasks(leadTask.id)).toHaveLength(1);
  });

  test("lead mode sends one steering message to an in-progress lead and creates no task", () => {
    process.env.SLACK_THREAD_STEERING = "lead";
    process.env.SLACK_THREAD_STEERING_MODE = "steer";
    const channelId = "C_STEER_LEAD";
    const threadTs = "2000.0001";
    const leadTask = createRunningSlackTask(leadId, channelId, threadTs);

    const result = requestSlackThreadSteering({
      channelId,
      threadTs,
      message: "use the safer approach",
    });

    expect(result).toMatchObject({
      task: { id: leadTask.id },
      result: { outcome: "steered", effectiveMode: "steer" },
    });
    expect(getSteeringMessagesForTask(leadTask.id)).toHaveLength(1);
    expect(getChildTasks(leadTask.id)).toEqual([]);
  });

  test("lead mode excludes an in-progress worker task", async () => {
    process.env.SLACK_THREAD_STEERING = "lead";
    process.env.SLACK_THREAD_STEERING_MODE = "queue";
    const channelId = "C_STEER_WORKER";
    const threadTs = "3000.0001";
    const workerId = createAgent({
      name: "slack-steering-worker",
      isLead: false,
      status: "busy",
      capabilities: [],
      harnessProvider: "pi",
    }).id;
    const workerTask = createRunningSlackTask(workerId, channelId, threadTs);

    expect(
      requestSlackThreadSteering({ channelId, threadTs, message: "do not steer the worker" }),
    ).toBeNull();

    bufferThreadMessage(channelId, threadTs, "create a normal follow-up", "U1", "3000.0002");
    await instantFlush(`${channelId}:${threadTs}`);

    expect(getSteeringMessagesForTask(workerTask.id)).toEqual([]);
    expect(getChildTasks(workerTask.id)).toHaveLength(1);
  });

  test("terminal lead task falls back to task creation", async () => {
    process.env.SLACK_THREAD_STEERING = "lead";
    const channelId = "C_STEER_TERMINAL";
    const threadTs = "4000.0001";
    const leadTask = createRunningSlackTask(leadId, channelId, threadTs);
    expect(completeTask(leadTask.id)?.status).toBe("completed");

    expect(requestSlackThreadSteering({ channelId, threadTs, message: "follow up" })).toBeNull();

    bufferThreadMessage(channelId, threadTs, "normal follow-up", "U1", "4000.0002");
    await instantFlush(`${channelId}:${threadTs}`);

    expect(getSteeringMessagesForTask(leadTask.id)).toEqual([]);
    expect(getChildTasks(leadTask.id)).toHaveLength(1);
  });

  test("a buffered multi-message flush produces exactly one steering message", async () => {
    process.env.SLACK_THREAD_STEERING = "lead";
    process.env.SLACK_THREAD_STEERING_MODE = "queue";
    const channelId = "C_STEER_BUFFER";
    const threadTs = "5000.0001";
    const leadTask = createRunningSlackTask(leadId, channelId, threadTs);

    bufferThreadMessage(channelId, threadTs, "first correction", "U1", "5000.0002");
    bufferThreadMessage(channelId, threadTs, "second correction", "U1", "5000.0003");
    await instantFlush(`${channelId}:${threadTs}`);

    const messages = getSteeringMessagesForTask(leadTask.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toContain("first correction\n---\nsecond correction");
    expect(getChildTasks(leadTask.id)).toEqual([]);
  });

  test("all mode targets the latest active task", () => {
    process.env.SLACK_THREAD_STEERING = "all";
    const channelId = "C_STEER_ALL";
    const threadTs = "6000.0001";
    const workerId = createAgent({
      name: "slack-steering-all-worker",
      isLead: false,
      status: "busy",
      capabilities: [],
      harnessProvider: "pi",
    }).id;
    const workerTask = createRunningSlackTask(workerId, channelId, threadTs);

    expect(
      requestSlackThreadSteering({ channelId, threadTs, message: "all-mode correction" }),
    ).toMatchObject({
      task: { id: workerTask.id },
      result: { outcome: "queued" },
    });
  });

  test("the mention gate is unchanged with steering off and lead modes", () => {
    const channelId = "C_STEER_MENTION";
    const threadTs = "7000.0001";
    createRunningSlackTask(leadId, channelId, threadTs);
    process.env.SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION = "true";

    for (const mode of ["off", "lead"]) {
      process.env.SLACK_THREAD_STEERING = mode;
      expect(routeMessage("plain thread reply", "BOT123", false, { channelId, threadTs })).toEqual(
        [],
      );
      expect(
        routeMessage("<@BOT123> explicit reply", "BOT123", true, { channelId, threadTs }),
      ).toHaveLength(1);
    }
  });

  test("tree blocks render a steered marker", () => {
    const blocks = buildTreeBlocks([
      {
        taskId: "00000000-0000-0000-0000-000000000000",
        agentName: "Lead",
        status: "in_progress",
        steered: true,
        children: [],
      },
    ]);

    expect(blocks[0]?.text.text).toContain("_steered_");
  });

  test("buffered fallback remains discoverable as the newest active task", () => {
    const task = getLatestActiveTaskInThread("C_STEER_WORKER", "3000.0001");
    expect(task?.task).toContain("create a normal follow-up");
  });
});
