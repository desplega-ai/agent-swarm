import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDb, createAgent, createInboxMessage, getInboxMessageById, initDb } from "../be/db";

const TEST_DB_PATH = "./test-get-inbox-message.sqlite";

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(() => {
  closeDb();
  try {
    unlinkSync(TEST_DB_PATH);
    unlinkSync(`${TEST_DB_PATH}-wal`);
    unlinkSync(`${TEST_DB_PATH}-shm`);
  } catch {
    // ignore if files don't exist
  }
});

describe("Inbox Message - Structured Content", () => {
  test("creates inbox message with structured content format", () => {
    const agent = createAgent({
      name: "lead-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    const content = `<new_message>
Any update?
</new_message>

<thread_history>
John: Help with bug
[Agent]: I'll look into that
</thread_history>`;

    const msg = createInboxMessage(agent.id, content, {
      source: "slack",
      slackChannelId: "C123",
      slackThreadTs: "1234.5678",
    });

    expect(msg.content).toBe(content);
    expect(msg.slackChannelId).toBe("C123");
    expect(msg.slackThreadTs).toBe("1234.5678");
  });

  test("creates inbox message without thread history for new threads", () => {
    const agent = createAgent({
      name: "lead-agent-2",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    const content = "Please help me with this task";

    const msg = createInboxMessage(agent.id, content, {
      source: "slack",
      slackChannelId: "C456",
      slackThreadTs: "5678.1234",
    });

    expect(msg.content).toBe(content);
    // No structured tags when no thread history
    expect(msg.content).not.toContain("<new_message>");
    expect(msg.content).not.toContain("<thread_history>");
  });

  test("retrieves inbox message by ID with full content", () => {
    const agent = createAgent({
      name: "lead-agent-3",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    const content = `<new_message>
What's the status?
</new_message>

<thread_history>
User: Can you deploy the feature?
[Agent]: Starting deployment now
</thread_history>`;

    const msg = createInboxMessage(agent.id, content, {
      source: "slack",
      slackChannelId: "C789",
      slackThreadTs: "9012.3456",
    });

    const retrieved = getInboxMessageById(msg.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved?.content).toBe(content);
    expect(retrieved?.agentId).toBe(agent.id);
    expect(retrieved?.slackChannelId).toBe("C789");
    expect(retrieved?.status).toBe("unread");
  });

  test("returns null for non-existent inbox message ID", () => {
    const nonExistentId = crypto.randomUUID();
    const retrieved = getInboxMessageById(nonExistentId);

    expect(retrieved).toBeNull();
  });

  test("structured content can be parsed with regex", () => {
    const agent = createAgent({
      name: "lead-agent-4",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    const newMessage = "Any update on the deployment?";
    const threadHistory = "User: Please deploy\n[Agent]: On it";

    const content = `<new_message>
${newMessage}
</new_message>

<thread_history>
${threadHistory}
</thread_history>`;

    const msg = createInboxMessage(agent.id, content, { source: "slack" });

    // Parse the structured content (same regex used in runner.ts)
    const newMessageMatch = msg.content.match(/<new_message>\n([\s\S]*?)\n<\/new_message>/);
    const threadHistoryMatch = msg.content.match(
      /<thread_history>\n([\s\S]*?)\n<\/thread_history>/,
    );

    expect(newMessageMatch).not.toBeNull();
    expect(newMessageMatch?.[1]).toBe(newMessage);

    expect(threadHistoryMatch).not.toBeNull();
    expect(threadHistoryMatch?.[1]).toBe(threadHistory);
  });
});
