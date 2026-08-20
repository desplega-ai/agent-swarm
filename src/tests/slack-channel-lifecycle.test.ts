import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WebClient } from "@slack/web-api";
import { closeDb, createAgent, initDb } from "../be/db";
import {
  archiveChannel,
  createChannel,
  inviteToChannel,
  normalizeChannelName,
} from "../slack/channel-lifecycle";
import { registerSlackArchiveChannelTool } from "../tools/slack-archive-channel";
import { registerSlackCreateChannelTool } from "../tools/slack-create-channel";
import { registerSlackInviteToChannelTool } from "../tools/slack-invite-to-channel";

const TEST_DB_PATH = "./test-slack-channel-lifecycle.sqlite";
const LEAD_ID = "aaaaaaaa-0000-4000-8000-000000000121";

const mockCreate = mock(() => Promise.resolve({ channel: { id: "C123", name: "project-alpha" } }));
const mockInvite = mock(() => Promise.resolve({ ok: true }));
const mockArchive = mock(() => Promise.resolve({ ok: true }));

mock.module("../slack/app", () => ({
  getSlackApp: () => ({
    client: {
      conversations: {
        create: mockCreate,
        invite: mockInvite,
        archive: mockArchive,
      },
    },
  }),
}));

function makePlatformError(code: string, needed?: string): Error {
  const error = new Error(`An API error occurred: ${code}`);
  (error as unknown as { data: { error: string; needed?: string } }).data = { error: code, needed };
  return error;
}

function makeClient(
  overrides: { create?: () => unknown; invite?: () => unknown; archive?: () => unknown } = {},
) {
  const create = mock(
    overrides.create ?? (() => Promise.resolve({ channel: { id: "C123", name: "project-alpha" } })),
  );
  const invite = mock(overrides.invite ?? (() => Promise.resolve({ ok: true })));
  const archive = mock(overrides.archive ?? (() => Promise.resolve({ ok: true })));
  const client = { conversations: { create, invite, archive } } as unknown as WebClient;

  return { client, create, invite, archive };
}

type RegisteredTool = {
  handler: (
    args: unknown,
    extra: unknown,
  ) => Promise<{ isError?: boolean; structuredContent: { success: boolean; message: string } }>;
};

let tools: Record<string, RegisteredTool>;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function callTool(name: string, args: Record<string, unknown>) {
  const tool = tools[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);

  return tool.handler(args, {
    sessionId: "slack-channel-lifecycle-test",
    requestInfo: { headers: { "x-agent-id": LEAD_ID } },
  });
}

beforeAll(async () => {
  await removeDbFiles();
  closeDb();
  initDb(TEST_DB_PATH);
  await createAgent({ id: LEAD_ID, name: "Slack Lifecycle Lead", isLead: true, status: "idle" });

  const server = new McpServer({ name: "slack-channel-lifecycle-test", version: "1.0.0" });
  registerSlackCreateChannelTool(server);
  registerSlackInviteToChannelTool(server);
  registerSlackArchiveChannelTool(server);
  tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

describe("Slack channel lifecycle", () => {
  test("normalizes channel names to Slack's naming rules", () => {
    expect(normalizeChannelName("  Project.Alpha / Launch!  ")).toBe("project-alpha-launch");
    expect(normalizeChannelName(`A${"B".repeat(100)}`)).toHaveLength(80);
  });

  test("rejects a name that normalizes to an empty value", () => {
    expect(() => normalizeChannelName("... !!!")).toThrow("at least one letter or number");
  });

  test("creates a channel with the normalized name and returns it", async () => {
    const { client, create } = makeClient();

    const result = await createChannel(client, { name: "Project.Alpha", isPrivate: true });

    expect(result).toEqual({ channelId: "C123", name: "project-alpha" });
    expect(create).toHaveBeenCalledWith({ name: "project-alpha", is_private: true });
  });

  test("surfaces name_taken with the normalized name", async () => {
    const { client } = makeClient({
      create: () => {
        throw makePlatformError("name_taken");
      },
    });

    await expect(createChannel(client, { name: "Project.Alpha" })).rejects.toThrow(
      'Slack channel name "project-alpha" is already taken.',
    );
  });

  test("treats already_in_channel as invite success", async () => {
    const { client, invite } = makeClient({
      invite: () => {
        throw makePlatformError("already_in_channel");
      },
    });

    const result = await inviteToChannel(client, "C123", ["U1", "U2"]);

    expect(result).toEqual({ alreadyInChannel: true });
    expect(invite).toHaveBeenCalledTimes(3);
    expect(invite).toHaveBeenNthCalledWith(1, { channel: "C123", users: "U1,U2" });
    expect(invite).toHaveBeenNthCalledWith(2, { channel: "C123", users: "U1" });
    expect(invite).toHaveBeenNthCalledWith(3, { channel: "C123", users: "U2" });
  });

  test("retries a mixed already_in_channel batch so new users are still invited", async () => {
    const inviteResults = [
      () => {
        throw makePlatformError("already_in_channel");
      },
      () => {
        throw makePlatformError("already_in_channel");
      },
      () => Promise.resolve({ ok: true }),
    ];
    const { client, invite } = makeClient({
      invite: () => inviteResults.shift()?.(),
    });

    const result = await inviteToChannel(client, "C123", ["U1", "U2"]);

    expect(result).toEqual({ alreadyInChannel: false });
    expect(invite).toHaveBeenNthCalledWith(2, { channel: "C123", users: "U1" });
    expect(invite).toHaveBeenNthCalledWith(3, { channel: "C123", users: "U2" });
  });

  test("treats already_archived as archive success", async () => {
    const { client, archive } = makeClient({
      archive: () => {
        throw makePlatformError("already_archived");
      },
    });

    const result = await archiveChannel(client, "C123");

    expect(result).toEqual({ alreadyArchived: true });
    expect(archive).toHaveBeenCalledWith({ channel: "C123" });
  });

  test("explains that Slack's general channel cannot be archived", async () => {
    const { client } = makeClient({
      archive: () => {
        throw makePlatformError("cant_archive_general");
      },
    });

    await expect(archiveChannel(client, "CGENERAL")).rejects.toThrow(
      "Slack's general channel cannot be archived.",
    );
  });
});

describe("Slack channel lifecycle tool scope errors", () => {
  test("create names Slack's required scope and the reinstall step", async () => {
    mockCreate.mockImplementationOnce(() =>
      Promise.reject(makePlatformError("missing_scope", "channels:manage")),
    );

    const result = await callTool("slack-create-channel", { name: "project-alpha" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Failed to create Slack channel: Slack requires the `channels:manage` scope. Add it to slack-manifest.json, apply the updated manifest to the Slack app, then reinstall the app to the workspace for the change to take effect.",
    );
  });

  test("invite names Slack's required scope and the reinstall step", async () => {
    mockInvite.mockImplementationOnce(() =>
      Promise.reject(makePlatformError("missing_scope", "groups:write")),
    );

    const result = await callTool("slack-invite-to-channel", {
      channelId: "G123",
      userIds: ["U123"],
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Failed to invite users to Slack channel: Slack requires the `groups:write` scope. Add it to slack-manifest.json, apply the updated manifest to the Slack app, then reinstall the app to the workspace for the change to take effect.",
    );
  });

  test("archive names Slack's required scope and the reinstall step", async () => {
    mockArchive.mockImplementationOnce(() =>
      Promise.reject(makePlatformError("missing_scope", "channels:manage")),
    );

    const result = await callTool("slack-archive-channel", { channelId: "C123" });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.success).toBe(false);
    expect(result.structuredContent.message).toBe(
      "Failed to archive Slack channel: Slack requires the `channels:manage` scope. Add it to slack-manifest.json, apply the updated manifest to the Slack app, then reinstall the app to the workspace for the change to take effect.",
    );
  });
});
