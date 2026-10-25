import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { defaultAssetKey } from "../assets/key";
import {
  effectiveSource,
  SESSION_SOURCES,
  sessionSourceKey,
  sourceMoveError,
  sourceOfKey,
} from "../assets/source-key";
import { closeDb, createAgent, createTask, createTaskExtended, initDb } from "../be/db";
import { chatSdkContextKey } from "../tasks/context-key";
import { registerSendTaskTool } from "../tools/send-task";

const slack = { slackChannelId: "C0AR967K0KZ", slackThreadTs: "1729000000.123456" };
const slackKey = "shared/slack/c0ar967k0kz/thread:1729000000.123456/";

test("effective source uses a complete source prefix or retains the raw source", () => {
  for (const source of SESSION_SOURCES) {
    expect(effectiveSource(`shared/${source}/channel/thread:1/`, "mcp")).toBe(source);
    expect(effectiveSource(`shared/${source}-other/`, "chat")).toBe("chat");
  }
  expect(effectiveSource("shared/research/", "slack")).toBe("slack");
  expect(effectiveSource("shared/research/", "chat")).toBe("chat");
});

test("source move guard permits only exact own source keys under source prefixes", () => {
  const root = { id: "root", ...slack };
  for (const destination of [null, "shared/research/", "shared/slack-other/", slackKey]) {
    expect(sourceMoveError(destination, root)).toBeNull();
  }
  for (const destination of [
    "shared/slack/",
    "shared/slack/c0ar967k0kz/",
    "shared/slack/c0ar967k0kz/thread:other/",
    "shared/telegram/123/",
    "shared/discord/c1/",
  ]) {
    expect(sourceMoveError(destination, root)).toBe("Source groups are read-only.");
  }
  expect(sourceMoveError(slackKey, { id: "other" })).toBe("Source groups are read-only.");
  const chatRoot = { id: "root", contextKey: chatSdkContextKey("telegram:-100") };
  expect(sourceMoveError("shared/telegram/-100/task:root/", chatRoot)).toBeNull();
  expect(sourceMoveError("shared/telegram/-100/", chatRoot)).toBe("Source groups are read-only.");
});

describe("session source key shapes", () => {
  test("Slack fields produce a lowercase channel key", () => {
    expect(sessionSourceKey({ id: "root", ...slack })).toBe(slackKey);
  });

  test("Slack DMs use the same thread shape", () => {
    expect(sessionSourceKey({ id: "root", ...slack, slackChannelId: "D123" })).toBe(
      "shared/slack/d123/thread:1729000000.123456/",
    );
  });

  test.each([
    ["slack:C123:1729000000.123456", "shared/slack/c123/thread:1729000000.123456/"],
    ["telegram:123:42", "shared/telegram/123/thread:42/"],
    ["telegram:123", "shared/telegram/123/task:root/"],
    ["telegram:-1001234567890:42", "shared/telegram/-1001234567890/thread:42/"],
    ["telegram:-1001234567890", "shared/telegram/-1001234567890/task:root/"],
    ["discord:guild:channel:thread", "shared/discord/channel/thread:thread/"],
    ["discord:guild:channel", "shared/discord/channel/task:root/"],
    ["discord:@me:dm:thread", "shared/discord/dm/thread:thread/"],
    ["discord:@me:dm", "shared/discord/dm/task:root/"],
    ["teams:conversation:thread", null],
    ["other:thread", null],
    ["slack:D123:", "shared/slack/d123/task:root/"],
    ["slack:D123", "shared/slack/d123/task:root/"],
    ["slack:C123::", null],
    ["telegram:chat:", null],
    ["discord:guild", null],
    ["discord:guild:a/b:thread", null],
  ])("chat-sdk %s", (threadId, expected) => {
    expect(
      sessionSourceKey({ id: "root", contextKey: chatSdkContextKey(threadId as string) }),
    ).toBe(expected);
  });

  test("Slack fields take precedence over a chat context", () => {
    expect(
      sessionSourceKey({
        id: "root",
        ...slack,
        contextKey: chatSdkContextKey("telegram:123:42"),
      }),
    ).toBe(slackKey);
  });

  test("missing or malformed context produces no source key", () => {
    for (const contextKey of [undefined, null, "", "task:chat-sdk:telegram:%ZZ", "task:ui:abc"]) {
      expect(sessionSourceKey({ id: "root", contextKey })).toBeNull();
    }
    expect(sessionSourceKey({ id: "root", slackChannelId: "C123" })).toBeNull();
    expect(sessionSourceKey({ id: "root", slackThreadTs: "1.2" })).toBeNull();
  });

  test("normalization failures produce no source key", () => {
    for (const slackChannelId of ["x".repeat(255), "..", "bad\\channel", "bad\0channel", "a/b"]) {
      expect(sessionSourceKey({ id: "root", ...slack, slackChannelId })).toBeNull();
    }
    expect(
      sessionSourceKey({
        id: "root",
        contextKey: chatSdkContextKey(`telegram:${"x".repeat(255)}`),
      }),
    ).toBeNull();
  });

  test("source prefixes require the complete source segment", () => {
    for (const source of SESSION_SOURCES) {
      expect(sourceOfKey(`shared/${source}/`)).toBe(source);
      expect(sourceOfKey(`shared/${source}/channel/thread:123/`)).toBe(source);
      expect(sourceOfKey(`shared/${source}-other/`)).toBeNull();
    }
    for (const key of ["shared/", "shared/slack", "personal/user/slack/", "shared/task:root/"]) {
      expect(sourceOfKey(key)).toBeNull();
    }
  });
});

describe("session source keys at insert", () => {
  beforeAll(() => initDb(":memory:"));
  afterAll(() => closeDb());

  test.each([
    "slack",
    "mcp",
  ] as const)("%s roots with Slack fields get a source key", async (source) => {
    const root = await createTaskExtended("Slack root", { source, ...slack });
    expect(root.key).toBe(slackKey);
  });

  test("a child inherits its Slack root key", async () => {
    const root = await createTaskExtended("Slack root", { source: "slack", ...slack });
    const child = await createTaskExtended("Child", { parentTaskId: root.id });
    expect(child.key).toBe(root.key);
  });

  test("send-task permits a child to inherit its Slack root key", async () => {
    const agent = await createAgent({ name: "Source caller", status: "idle", maxTasks: 10 });
    const target = await createAgent({ name: "Source target", status: "idle", maxTasks: 10 });
    const root = await createTaskExtended("Slack root", {
      agentId: agent.id,
      source: "slack",
      ...slack,
    });
    const server = new McpServer({ name: "source-key-test", version: "1.0.0" });
    registerSendTaskTool(server);
    const tools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
          }
        >;
      }
    )._registeredTools;
    const result = await tools["send-task"]!.handler(
      {
        agentId: target.id,
        routingReason: "human_pinned",
        routingNote: "The test selects the target worker.",
        task: "Child in a Slack source group",
        parentTaskId: root.id,
        allowDuplicate: true,
      },
      { requestInfo: { headers: { "x-agent-id": agent.id, "x-source-task-id": root.id } } },
    );
    expect(result.structuredContent).toMatchObject({
      success: true,
      task: { key: slackKey, parentTaskId: root.id },
    });
  });

  test("a child with different Slack fields keeps its parent's custom key", async () => {
    const root = await createTaskExtended("Custom root", { key: "shared/research/", ...slack });
    const child = await createTaskExtended("Child", {
      parentTaskId: root.id,
      slackChannelId: "C_OTHER",
      slackThreadTs: "123.456",
    });
    expect(child.key).toBe(root.key);
  });

  test("a child with chat context inherits its parent's default key", async () => {
    const root = await createTaskExtended("Default root");
    const child = await createTaskExtended("Child", {
      parentTaskId: root.id,
      contextKey: chatSdkContextKey("telegram:123:42"),
    });
    expect(child.key).toBe(root.key);
  });

  test("an explicit key wins for roots and children", async () => {
    const root = await createTaskExtended("Custom root", { key: "shared/Custom/", ...slack });
    const child = await createTaskExtended("Custom child", {
      parentTaskId: root.id,
      key: "shared/Other/",
    });
    expect(root.key).toBe("shared/custom/");
    expect(child.key).toBe("shared/other/");
  });

  test("a Telegram chat-sdk root gets its source key", async () => {
    const root = await createTaskExtended("Telegram root", {
      source: "chat",
      contextKey: chatSdkContextKey("telegram:-1001234567890:42"),
    });
    expect(root.key).toBe("shared/telegram/-1001234567890/thread:42/");
  });

  test("unsupported and invalid source keys retain the per-task default", async () => {
    for (const options of [
      {},
      { contextKey: chatSdkContextKey("teams:conversation:thread") },
      { ...slack, slackChannelId: "x".repeat(255) },
      { ...slack, parentTaskId: crypto.randomUUID() },
    ]) {
      const root = await createTaskExtended("Default key", options);
      expect(root.key).toBe(defaultAssetKey("task", root.id));
    }
  });

  test("legacy createTask derives Slack keys and retains the default otherwise", async () => {
    const agent = await createAgent({ name: "Source key agent", status: "idle", capabilities: [] });
    const root = await createTask(agent.id, "Legacy Slack root", { source: "slack", ...slack });
    const ordinary = await createTask(agent.id, "Legacy ordinary root");
    expect(root.key).toBe(slackKey);
    expect(ordinary.key).toBe(defaultAssetKey("task", ordinary.id));
  });
});
