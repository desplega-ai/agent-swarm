import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  initDb,
  setSlackMessageTracking,
} from "../be/db";
import { registerSlackUploadFileTool } from "../tools/slack-upload-file";

const TEST_DB_PATH = "./test-slack-upload-file.sqlite";

const mockFilesUploadV2 = mock(() =>
  Promise.resolve({
    files: [{ files: [{ id: "F_TEST_UPLOAD" }] }],
  }),
);

mock.module("../slack/app", () => ({
  getSlackApp: () => ({
    client: {
      filesUploadV2: mockFilesUploadV2,
    },
  }),
}));

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

function buildTool() {
  const server = new McpServer({ name: "slack-upload-file-test", version: "1.0.0" });
  registerSlackUploadFileTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = registered["slack-upload-file"];
  if (!tool) throw new Error("slack-upload-file tool not registered");
  return tool;
}

function meta(agentId: string) {
  return { sessionId: "s1", requestInfo: { headers: { "x-agent-id": agentId } } };
}

describe("slack-upload-file", () => {
  let agentId: string;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    const agent = createAgent({ name: "Upload Worker", isLead: false, status: "idle" });
    agentId = agent.id;
  });

  beforeEach(() => {
    mockFilesUploadV2.mockClear();
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("uses the visible DM tree message as thread_ts for task uploads", async () => {
    const task = createTaskExtended("dm upload task", {
      agentId,
      source: "slack",
      slackChannelId: "D_UPLOAD",
      slackThreadTs: "1783331585.399049",
      slackUserId: "U_UPLOAD",
    });
    setSlackMessageTracking(task.id, {
      slackProgressMessageTs: "1783331590.000001",
      slackTreeRootMessageTs: "1783331590.000001",
    });

    const tool = buildTool();
    await tool.handler(
      {
        taskId: task.id,
        content: Buffer.from("asset").toString("base64"),
        filename: "asset.txt",
      },
      meta(agentId),
    );

    expect(mockFilesUploadV2).toHaveBeenCalledTimes(1);
    expect(mockFilesUploadV2.mock.calls[0][0]).toMatchObject({
      channel_id: "D_UPLOAD",
      thread_ts: "1783331590.000001",
      filename: "asset.txt",
    });
  });

  test("keeps channel task uploads threaded under the original Slack thread", async () => {
    const task = createTaskExtended("channel upload task", {
      agentId,
      source: "slack",
      slackChannelId: "C_UPLOAD",
      slackThreadTs: "1783332000.000001",
      slackUserId: "U_UPLOAD",
    });
    setSlackMessageTracking(task.id, {
      slackProgressMessageTs: "1783332001.000001",
      slackTreeRootMessageTs: "1783332001.000001",
    });

    const tool = buildTool();
    await tool.handler(
      {
        taskId: task.id,
        content: Buffer.from("asset").toString("base64"),
        filename: "asset.txt",
      },
      meta(agentId),
    );

    expect(mockFilesUploadV2).toHaveBeenCalledTimes(1);
    expect(mockFilesUploadV2.mock.calls[0][0]).toMatchObject({
      channel_id: "C_UPLOAD",
      thread_ts: "1783332000.000001",
      filename: "asset.txt",
    });
  });
});
