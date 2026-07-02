import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  acceptTask,
  claimInboxMessages,
  claimMentions,
  claimOfferedTask,
  closeDb,
  createAgent,
  createChannel,
  createInboxMessage,
  createTaskExtended,
  getInboxMessageById,
  getTaskById,
  initDb,
  markInboxMessageDelegated,
  markInboxMessageResponded,
  postMessage,
  rejectTask,
  releaseMentionProcessing,
  releaseStaleMentionProcessing,
  releaseStaleProcessingInbox,
  releaseStaleReviewingTasks,
  updateReadState,
} from "../be/db";

const TEST_DB_PATH = "./test-trigger-claiming.sqlite";

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

describe("Trigger Claiming - Inbox Messages", () => {
  test("claimInboxMessages marks messages as processing atomically", () => {
    const agent = createAgent({
      name: "lead-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // Create 5 inbox messages
    const msg1 = createInboxMessage(agent.id, "Message 1");
    const msg2 = createInboxMessage(agent.id, "Message 2");
    const msg3 = createInboxMessage(agent.id, "Message 3");
    const msg4 = createInboxMessage(agent.id, "Message 4");
    const msg5 = createInboxMessage(agent.id, "Message 5");

    // All should be unread
    expect(msg1.status).toBe("unread");
    expect(msg2.status).toBe("unread");
    expect(msg3.status).toBe("unread");
    expect(msg4.status).toBe("unread");
    expect(msg5.status).toBe("unread");

    // Claim messages
    const claimed = claimInboxMessages(agent.id, 5);

    // Should claim all 5
    expect(claimed.length).toBe(5);

    // All claimed messages should be in processing status
    for (const msg of claimed) {
      expect(msg.status).toBe("processing");
    }

    // Verify in database
    const dbMsg1 = getInboxMessageById(msg1.id);
    expect(dbMsg1?.status).toBe("processing");
  });

  test("concurrent claims do not return duplicate messages", () => {
    const agent = createAgent({
      name: "concurrent-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // Create 3 messages
    createInboxMessage(agent.id, "Message A");
    createInboxMessage(agent.id, "Message B");
    createInboxMessage(agent.id, "Message C");

    // Simulate concurrent polls
    const claim1 = claimInboxMessages(agent.id, 5);
    const claim2 = claimInboxMessages(agent.id, 5);
    const claim3 = claimInboxMessages(agent.id, 5);

    // First claim should get all messages
    expect(claim1.length).toBe(3);

    // Subsequent claims should get nothing
    expect(claim2.length).toBe(0);
    expect(claim3.length).toBe(0);

    // Verify no duplicates
    const allIds = [...claim1, ...claim2, ...claim3].map((m) => m.id);
    const uniqueIds = new Set(allIds);
    expect(allIds.length).toBe(uniqueIds.size);
  });

  test("claimInboxMessages respects limit parameter", () => {
    const agent = createAgent({
      name: "limit-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // Create 10 messages
    for (let i = 0; i < 10; i++) {
      createInboxMessage(agent.id, `Message ${i}`);
    }

    // Claim only 3
    const claimed = claimInboxMessages(agent.id, 3);

    expect(claimed.length).toBe(3);

    // Should have 7 remaining unread
    const remaining = claimInboxMessages(agent.id, 10);
    expect(remaining.length).toBe(7);
  });

  test("markInboxMessageResponded accepts processing status", () => {
    const agent = createAgent({
      name: "respond-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    const _msg = createInboxMessage(agent.id, "Test message");

    // Claim it (sets to processing)
    const claimed = claimInboxMessages(agent.id, 1);
    expect(claimed[0].status).toBe("processing");

    // Mark as responded - should work with processing status
    const responded = markInboxMessageResponded(claimed[0].id, "Response text");

    expect(responded).not.toBeNull();
    expect(responded?.status).toBe("responded");
    expect(responded?.responseText).toBe("Response text");
  });

  test("markInboxMessageDelegated accepts processing status", () => {
    const agent = createAgent({
      name: "delegate-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    const _msg = createInboxMessage(agent.id, "Test message");

    // Create a task to delegate to
    const task = createTaskExtended("Delegated task", { agentId: agent.id });

    // Claim it (sets to processing)
    const claimed = claimInboxMessages(agent.id, 1);
    expect(claimed[0].status).toBe("processing");

    // Mark as delegated - should work with processing status
    const delegated = markInboxMessageDelegated(claimed[0].id, task.id);

    expect(delegated).not.toBeNull();
    expect(delegated?.status).toBe("delegated");
    expect(delegated?.delegatedToTaskId).toBe(task.id);
  });

  test("releaseStaleProcessingInbox releases old processing messages", async () => {
    const agent = createAgent({
      name: "stale-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // Create and claim a message
    createInboxMessage(agent.id, "Stale message");
    const claimed = claimInboxMessages(agent.id, 1);

    expect(claimed[0].status).toBe("processing");

    // Wait a tiny bit to ensure timestamp is in the past
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Release stale messages with timeout = 0 (any age)
    // Note: This will release ALL processing messages, not just this agent's
    const releasedCount = releaseStaleProcessingInbox(0);

    // Should have released at least 1 message (possibly more from other tests)
    expect(releasedCount).toBeGreaterThanOrEqual(1);

    // Message should be back to unread
    const msg = getInboxMessageById(claimed[0].id);
    expect(msg?.status).toBe("unread");

    // Should be claimable again
    const reclaimed = claimInboxMessages(agent.id, 1);
    expect(reclaimed.length).toBe(1);
    expect(reclaimed[0].id).toBe(claimed[0].id);
  });

  test("claimInboxMessages returns empty array when no messages", () => {
    const agent = createAgent({
      name: "empty-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    const claimed = claimInboxMessages(agent.id, 5);
    expect(claimed.length).toBe(0);
  });

  test("claimed messages maintain order (oldest first)", () => {
    const agent = createAgent({
      name: "order-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // Create messages with small delays to ensure different timestamps
    const _msg1 = createInboxMessage(agent.id, "First");
    // Small delay
    const _msg2 = createInboxMessage(agent.id, "Second");
    const _msg3 = createInboxMessage(agent.id, "Third");

    const claimed = claimInboxMessages(agent.id, 3);

    // Should be in creation order (oldest first)
    expect(claimed[0].content).toBe("First");
    expect(claimed[1].content).toBe("Second");
    expect(claimed[2].content).toBe("Third");
  });

  test("only unread messages are claimable", () => {
    const agent = createAgent({
      name: "filter-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    const _msg1 = createInboxMessage(agent.id, "Unread 1");
    const _msg2 = createInboxMessage(agent.id, "Unread 2");
    const _msg3 = createInboxMessage(agent.id, "Unread 3");

    // Claim and respond to msg2
    claimInboxMessages(agent.id, 1); // Claims msg1
    const claim2 = claimInboxMessages(agent.id, 1); // Claims msg2
    markInboxMessageResponded(claim2[0].id, "Done");

    // Now try to claim again - should only get msg3
    const remaining = claimInboxMessages(agent.id, 10);
    expect(remaining.length).toBe(1);
    expect(remaining[0].content).toBe("Unread 3");
  });
});

describe("Trigger Claiming - Offered Tasks", () => {
  test("claimOfferedTask marks task as reviewing atomically", () => {
    const agent = createAgent({
      name: "claim-agent",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // Create and offer a task
    const task = createTaskExtended("Test task", { offeredTo: agent.id });

    expect(task.status).toBe("offered");
    expect(task.offeredTo).toBe(agent.id);

    // Claim it
    const claimed = claimOfferedTask(task.id, agent.id);

    expect(claimed).not.toBeNull();
    expect(claimed?.status).toBe("reviewing");
    expect(claimed?.offeredTo).toBe(agent.id);

    // Verify in database
    const dbTask = getTaskById(task.id);
    expect(dbTask?.status).toBe("reviewing");
  });

  test("concurrent claims do not return duplicate offered tasks", () => {
    const agent = createAgent({
      name: "concurrent-offer-agent",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // Create and offer a task
    const task = createTaskExtended("Concurrent task", { offeredTo: agent.id });

    // Simulate concurrent polls
    const claim1 = claimOfferedTask(task.id, agent.id);
    const claim2 = claimOfferedTask(task.id, agent.id);
    const claim3 = claimOfferedTask(task.id, agent.id);

    // First claim should succeed
    expect(claim1).not.toBeNull();
    expect(claim1?.status).toBe("reviewing");

    // Subsequent claims should fail (task already reviewing)
    expect(claim2).toBeNull();
    expect(claim3).toBeNull();
  });

  test("claimOfferedTask returns null for non-offered task", () => {
    const agent = createAgent({
      name: "non-offered-agent",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // Create a pending task (not offered)
    const task = createTaskExtended("Pending task", { agentId: agent.id });

    // Try to claim - should fail
    const claimed = claimOfferedTask(task.id, agent.id);
    expect(claimed).toBeNull();
  });

  test("claimOfferedTask returns null for wrong agent", () => {
    const agent1 = createAgent({
      name: "agent1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const agent2 = createAgent({
      name: "agent2",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // Offer task to agent1
    const task = createTaskExtended("Task for agent1", { offeredTo: agent1.id });

    // Agent2 tries to claim - should fail
    const claimed = claimOfferedTask(task.id, agent2.id);
    expect(claimed).toBeNull();
  });

  test("acceptTask works with reviewing status", () => {
    const agent = createAgent({
      name: "accept-agent",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // Create, offer, and claim task
    const task = createTaskExtended("Task to accept", { offeredTo: agent.id });
    const claimed = claimOfferedTask(task.id, agent.id);

    expect(claimed?.status).toBe("reviewing");

    // Accept it
    const accepted = acceptTask(task.id, agent.id);

    expect(accepted).not.toBeNull();
    expect(accepted?.status).toBe("pending");
    expect(accepted?.agentId).toBe(agent.id);
  });

  test("rejectTask works with reviewing status", () => {
    const agent = createAgent({
      name: "reject-agent",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // Create, offer, and claim task
    const task = createTaskExtended("Task to reject", { offeredTo: agent.id });
    const claimed = claimOfferedTask(task.id, agent.id);

    expect(claimed?.status).toBe("reviewing");

    // Reject it
    const rejected = rejectTask(task.id, agent.id, "Not interested");

    expect(rejected).not.toBeNull();
    expect(rejected?.status).toBe("unassigned");
    expect(rejected?.offeredTo).toBeUndefined();
    expect(rejected?.rejectionReason).toBe("Not interested");
  });

  test("releaseStaleReviewingTasks releases old reviewing tasks", async () => {
    const agent = createAgent({
      name: "stale-review-agent",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // Create, offer, and claim task
    const task = createTaskExtended("Stale review task", { offeredTo: agent.id });
    const claimed = claimOfferedTask(task.id, agent.id);

    expect(claimed?.status).toBe("reviewing");

    // Wait a bit to ensure timestamp is in the past
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Release stale reviewing tasks
    const released = releaseStaleReviewingTasks(0);

    // Should have released at least 1 task
    expect(released).toBeGreaterThanOrEqual(1);

    // Task should be back to offered
    const dbTask = getTaskById(task.id);
    expect(dbTask?.status).toBe("offered");

    // Should be claimable again
    const reclaimed = claimOfferedTask(task.id, agent.id);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.id).toBe(task.id);
  });
});

describe("Trigger Claiming - Mentions", () => {
  test("claimMentions marks channels as processing atomically", () => {
    const agent = createAgent({
      name: "mention-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // Create channels
    const channel1 = createChannel("test-channel-1", "public");
    const channel2 = createChannel("test-channel-2", "public");

    // Post messages with mentions
    postMessage(channel1.id, agent.id, `Hey @${agent.id}, check this out!`, {
      mentions: [agent.id],
    });
    postMessage(channel2.id, agent.id, `@${agent.id} urgent task`, { mentions: [agent.id] });

    // Claim mentions
    const claimed = claimMentions(agent.id);

    // Should claim both channels
    expect(claimed.length).toBe(2);
    expect(claimed.map((c) => c.channelId).sort()).toEqual([channel1.id, channel2.id].sort());
  });

  test("concurrent claims do not return duplicate mentions", () => {
    const agent = createAgent({
      name: "concurrent-mention-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // Create channel and post mentions
    const channel = createChannel("concurrent-channel", "public");
    postMessage(channel.id, agent.id, `@${agent.id} message 1`, { mentions: [agent.id] });
    postMessage(channel.id, agent.id, `@${agent.id} message 2`, { mentions: [agent.id] });

    // Simulate concurrent polls
    const claim1 = claimMentions(agent.id);
    const claim2 = claimMentions(agent.id);
    const claim3 = claimMentions(agent.id);

    // First claim should succeed
    expect(claim1.length).toBe(1);
    expect(claim1[0].channelId).toBe(channel.id);

    // Subsequent claims should fail (channel already processing)
    expect(claim2.length).toBe(0);
    expect(claim3.length).toBe(0);
  });

  test("releaseMentionProcessing allows reclaiming", () => {
    const agent = createAgent({
      name: "release-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // Create channel and post mention
    const channel = createChannel("release-channel", "public");
    postMessage(channel.id, agent.id, `@${agent.id} test`, { mentions: [agent.id] });

    // Claim
    const claimed = claimMentions(agent.id);
    expect(claimed.length).toBe(1);

    // Subsequent claim should fail
    const claim2 = claimMentions(agent.id);
    expect(claim2.length).toBe(0);

    // Release processing
    releaseMentionProcessing(agent.id, [channel.id]);

    // Now should be claimable again (but no NEW mentions, so count depends on read state)
    // Actually, since we didn't mark as read, the same mentions should still be there
    const claim3 = claimMentions(agent.id);
    expect(claim3.length).toBe(1);
  });

  test("releaseStaleMentionProcessing releases old processing channels", async () => {
    const agent = createAgent({
      name: "stale-mention-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // Create channel and post mention
    const channel = createChannel("stale-channel", "public");
    postMessage(channel.id, agent.id, `@${agent.id} stale test`, { mentions: [agent.id] });

    // Claim
    const claimed = claimMentions(agent.id);
    expect(claimed.length).toBe(1);

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Release stale (timeout = 0 means any age)
    const released = releaseStaleMentionProcessing(0);
    expect(released).toBeGreaterThanOrEqual(1);

    // Should be claimable again
    const reclaimed = claimMentions(agent.id);
    expect(reclaimed.length).toBe(1);
    expect(reclaimed[0].channelId).toBe(channel.id);
  });

  test("claimMentions returns empty array when no mentions", () => {
    const agent = createAgent({
      name: "no-mention-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    const claimed = claimMentions(agent.id);
    expect(claimed.length).toBe(0);
  });

  test("claimMentions only claims channels with unread mentions", () => {
    const agent = createAgent({
      name: "read-mention-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // Create channel and post mention
    const channel = createChannel("read-channel", "public");
    const _msg = postMessage(channel.id, agent.id, `@${agent.id} test message`, {
      mentions: [agent.id],
    });

    // Mark as read BEFORE claiming
    updateReadState(agent.id, channel.id);

    // Try to claim - should get nothing (already read)
    const claimed = claimMentions(agent.id);
    expect(claimed.length).toBe(0);
  });

  test("releasing processing allows subsequent polling to claim", async () => {
    const agent = createAgent({
      name: "repolling-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // Create channel and post mentions
    const channel = createChannel("repoll-channel", "public");
    postMessage(channel.id, agent.id, `@${agent.id} first`, { mentions: [agent.id] });
    postMessage(channel.id, agent.id, `@${agent.id} second`, { mentions: [agent.id] });

    // Poll 1: Claim
    const poll1 = claimMentions(agent.id);
    expect(poll1.length).toBe(1);

    // Poll 2: Nothing (processing)
    const poll2 = claimMentions(agent.id);
    expect(poll2.length).toBe(0);

    // Agent marks as read and releases
    updateReadState(agent.id, channel.id);
    releaseMentionProcessing(agent.id, [channel.id]);

    // Poll 3: Nothing (no NEW unread mentions)
    const poll3 = claimMentions(agent.id);
    expect(poll3.length).toBe(0);

    // Wait a bit to ensure new message has later timestamp
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Post new mention
    postMessage(channel.id, agent.id, `@${agent.id} third`, { mentions: [agent.id] });

    // Poll 4: Should claim new mention
    const poll4 = claimMentions(agent.id);
    expect(poll4.length).toBe(1);
  });
});
