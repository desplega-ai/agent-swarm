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

beforeAll(async () => {
  await initDb(TEST_DB_PATH);
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
  test("claimInboxMessages marks messages as processing atomically", async () => {
    const agent = await createAgent({
      name: "lead-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // Create 5 inbox messages
    const msg1 = await createInboxMessage(agent.id, "Message 1");
    const msg2 = await createInboxMessage(agent.id, "Message 2");
    const msg3 = await createInboxMessage(agent.id, "Message 3");
    const msg4 = await createInboxMessage(agent.id, "Message 4");
    const msg5 = await createInboxMessage(agent.id, "Message 5");

    // All should be unread
    expect(msg1.status).toBe("unread");
    expect(msg2.status).toBe("unread");
    expect(msg3.status).toBe("unread");
    expect(msg4.status).toBe("unread");
    expect(msg5.status).toBe("unread");

    // Claim messages
    const claimed = await claimInboxMessages(agent.id, 5);

    // Should claim all 5
    expect(claimed.length).toBe(5);

    // All claimed messages should be in processing status
    for (const msg of claimed) {
      expect(msg.status).toBe("processing");
    }

    // Verify in database
    const dbMsg1 = await getInboxMessageById(msg1.id);
    expect(dbMsg1?.status).toBe("processing");
  });

  test("concurrent claims do not return duplicate messages", async () => {
    const agent = await createAgent({
      name: "concurrent-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // Create 3 messages
    await createInboxMessage(agent.id, "Message A");
    await createInboxMessage(agent.id, "Message B");
    await createInboxMessage(agent.id, "Message C");

    // Simulate concurrent polls
    const claim1 = await claimInboxMessages(agent.id, 5);
    const claim2 = await claimInboxMessages(agent.id, 5);
    const claim3 = await claimInboxMessages(agent.id, 5);

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

  test("claimInboxMessages respects limit parameter", async () => {
    const agent = await createAgent({
      name: "limit-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // Create 10 messages
    for (let i = 0; i < 10; i++) {
      await createInboxMessage(agent.id, `Message ${i}`);
    }

    // Claim only 3
    const claimed = await claimInboxMessages(agent.id, 3);

    expect(claimed.length).toBe(3);

    // Should have 7 remaining unread
    const remaining = await claimInboxMessages(agent.id, 10);
    expect(remaining.length).toBe(7);
  });

  test("markInboxMessageResponded accepts processing status", async () => {
    const agent = await createAgent({
      name: "respond-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    const _msg = await createInboxMessage(agent.id, "Test message");

    // Claim it (sets to processing)
    const claimed = await claimInboxMessages(agent.id, 1);
    expect(claimed[0].status).toBe("processing");

    // Mark as responded - should work with processing status
    const responded = await markInboxMessageResponded(claimed[0].id, "Response text");

    expect(responded).not.toBeNull();
    expect(responded?.status).toBe("responded");
    expect(responded?.responseText).toBe("Response text");
  });

  test("markInboxMessageDelegated accepts processing status", async () => {
    const agent = await createAgent({
      name: "delegate-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    const _msg = await createInboxMessage(agent.id, "Test message");

    // Create a task to delegate to
    const task = await createTaskExtended("Delegated task", { agentId: agent.id });

    // Claim it (sets to processing)
    const claimed = await claimInboxMessages(agent.id, 1);
    expect(claimed[0].status).toBe("processing");

    // Mark as delegated - should work with processing status
    const delegated = await markInboxMessageDelegated(claimed[0].id, task.id);

    expect(delegated).not.toBeNull();
    expect(delegated?.status).toBe("delegated");
    expect(delegated?.delegatedToTaskId).toBe(task.id);
  });

  test("releaseStaleProcessingInbox releases old processing messages", async () => {
    const agent = await createAgent({
      name: "stale-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // Create and claim a message
    await createInboxMessage(agent.id, "Stale message");
    const claimed = await claimInboxMessages(agent.id, 1);

    expect(claimed[0].status).toBe("processing");

    // Wait a tiny bit to ensure timestamp is in the past
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Release stale messages with timeout = 0 (any age)
    // Note: This will release ALL processing messages, not just this agent's
    const releasedCount = await releaseStaleProcessingInbox(0);

    // Should have released at least 1 message (possibly more from other tests)
    expect(releasedCount).toBeGreaterThanOrEqual(1);

    // Message should be back to unread
    const msg = await getInboxMessageById(claimed[0].id);
    expect(msg?.status).toBe("unread");

    // Should be claimable again
    const reclaimed = await claimInboxMessages(agent.id, 1);
    expect(reclaimed.length).toBe(1);
    expect(reclaimed[0].id).toBe(claimed[0].id);
  });

  test("claimInboxMessages returns empty array when no messages", async () => {
    const agent = await createAgent({
      name: "empty-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    const claimed = await claimInboxMessages(agent.id, 5);
    expect(claimed.length).toBe(0);
  });

  test("claimed messages maintain order (oldest first)", async () => {
    const agent = await createAgent({
      name: "order-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // Create messages with small delays to ensure different timestamps
    const _msg1 = await createInboxMessage(agent.id, "First");
    // Small delay
    const _msg2 = await createInboxMessage(agent.id, "Second");
    const _msg3 = await createInboxMessage(agent.id, "Third");

    const claimed = await claimInboxMessages(agent.id, 3);

    // Should be in creation order (oldest first)
    expect(claimed[0].content).toBe("First");
    expect(claimed[1].content).toBe("Second");
    expect(claimed[2].content).toBe("Third");
  });

  test("only unread messages are claimable", async () => {
    const agent = await createAgent({
      name: "filter-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    const _msg1 = await createInboxMessage(agent.id, "Unread 1");
    const _msg2 = await createInboxMessage(agent.id, "Unread 2");
    const _msg3 = await createInboxMessage(agent.id, "Unread 3");

    // Claim and respond to msg2
    await claimInboxMessages(agent.id, 1); // Claims msg1
    const claim2 = await claimInboxMessages(agent.id, 1); // Claims msg2
    await markInboxMessageResponded(claim2[0].id, "Done");

    // Now try to claim again - should only get msg3
    const remaining = await claimInboxMessages(agent.id, 10);
    expect(remaining.length).toBe(1);
    expect(remaining[0].content).toBe("Unread 3");
  });
});

describe("Trigger Claiming - Offered Tasks", () => {
  test("claimOfferedTask marks task as reviewing atomically", async () => {
    const agent = await createAgent({
      name: "claim-agent",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // Create and offer a task
    const task = await createTaskExtended("Test task", { offeredTo: agent.id });

    expect(task.status).toBe("offered");
    expect(task.offeredTo).toBe(agent.id);

    // Claim it
    const claimed = await claimOfferedTask(task.id, agent.id);

    expect(claimed).not.toBeNull();
    expect(claimed?.status).toBe("reviewing");
    expect(claimed?.offeredTo).toBe(agent.id);

    // Verify in database
    const dbTask = await getTaskById(task.id);
    expect(dbTask?.status).toBe("reviewing");
  });

  test("concurrent claims do not return duplicate offered tasks", async () => {
    const agent = await createAgent({
      name: "concurrent-offer-agent",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // Create and offer a task
    const task = await createTaskExtended("Concurrent task", { offeredTo: agent.id });

    // Simulate concurrent polls
    const claim1 = await claimOfferedTask(task.id, agent.id);
    const claim2 = await claimOfferedTask(task.id, agent.id);
    const claim3 = await claimOfferedTask(task.id, agent.id);

    // First claim should succeed
    expect(claim1).not.toBeNull();
    expect(claim1?.status).toBe("reviewing");

    // Subsequent claims should fail (task already reviewing)
    expect(claim2).toBeNull();
    expect(claim3).toBeNull();
  });

  test("claimOfferedTask returns null for non-offered task", async () => {
    const agent = await createAgent({
      name: "non-offered-agent",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // Create a pending task (not offered)
    const task = await createTaskExtended("Pending task", { agentId: agent.id });

    // Try to claim - should fail
    const claimed = await claimOfferedTask(task.id, agent.id);
    expect(claimed).toBeNull();
  });

  test("claimOfferedTask returns null for wrong agent", async () => {
    const agent1 = await createAgent({
      name: "agent1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const agent2 = await createAgent({
      name: "agent2",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // Offer task to agent1
    const task = await createTaskExtended("Task for agent1", { offeredTo: agent1.id });

    // Agent2 tries to claim - should fail
    const claimed = await claimOfferedTask(task.id, agent2.id);
    expect(claimed).toBeNull();
  });

  test("acceptTask works with reviewing status", async () => {
    const agent = await createAgent({
      name: "accept-agent",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // Create, offer, and claim task
    const task = await createTaskExtended("Task to accept", { offeredTo: agent.id });
    const claimed = await claimOfferedTask(task.id, agent.id);

    expect(claimed?.status).toBe("reviewing");

    // Accept it
    const accepted = await acceptTask(task.id, agent.id);

    expect(accepted).not.toBeNull();
    expect(accepted?.status).toBe("pending");
    expect(accepted?.agentId).toBe(agent.id);
  });

  test("rejectTask works with reviewing status", async () => {
    const agent = await createAgent({
      name: "reject-agent",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // Create, offer, and claim task
    const task = await createTaskExtended("Task to reject", { offeredTo: agent.id });
    const claimed = await claimOfferedTask(task.id, agent.id);

    expect(claimed?.status).toBe("reviewing");

    // Reject it
    const rejected = await rejectTask(task.id, agent.id, "Not interested");

    expect(rejected).not.toBeNull();
    expect(rejected?.status).toBe("unassigned");
    expect(rejected?.offeredTo).toBeUndefined();
    expect(rejected?.rejectionReason).toBe("Not interested");
  });

  test("releaseStaleReviewingTasks releases old reviewing tasks", async () => {
    const agent = await createAgent({
      name: "stale-review-agent",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // Create, offer, and claim task
    const task = await createTaskExtended("Stale review task", { offeredTo: agent.id });
    const claimed = await claimOfferedTask(task.id, agent.id);

    expect(claimed?.status).toBe("reviewing");

    // Wait a bit to ensure timestamp is in the past
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Release stale reviewing tasks
    const released = await releaseStaleReviewingTasks(0);

    // Should have released at least 1 task
    expect(released).toBeGreaterThanOrEqual(1);

    // Task should be back to offered
    const dbTask = await getTaskById(task.id);
    expect(dbTask?.status).toBe("offered");

    // Should be claimable again
    const reclaimed = await claimOfferedTask(task.id, agent.id);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.id).toBe(task.id);
  });
});

describe("Trigger Claiming - Mentions", () => {
  test("claimMentions marks channels as processing atomically", async () => {
    const agent = await createAgent({
      name: "mention-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // Create channels
    const channel1 = await createChannel("test-channel-1", "public");
    const channel2 = await createChannel("test-channel-2", "public");

    // Post messages with mentions
    await postMessage(channel1.id, agent.id, `Hey @${agent.id}, check this out!`, {
      mentions: [agent.id],
    });
    await postMessage(channel2.id, agent.id, `@${agent.id} urgent task`, { mentions: [agent.id] });

    // Claim mentions
    const claimed = await claimMentions(agent.id);

    // Should claim both channels
    expect(claimed.length).toBe(2);
    expect(claimed.map((c) => c.channelId).sort()).toEqual([channel1.id, channel2.id].sort());
  });

  test("concurrent claims do not return duplicate mentions", async () => {
    const agent = await createAgent({
      name: "concurrent-mention-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // Create channel and post mentions
    const channel = await createChannel("concurrent-channel", "public");
    await postMessage(channel.id, agent.id, `@${agent.id} message 1`, { mentions: [agent.id] });
    await postMessage(channel.id, agent.id, `@${agent.id} message 2`, { mentions: [agent.id] });

    // Simulate concurrent polls
    const claim1 = await claimMentions(agent.id);
    const claim2 = await claimMentions(agent.id);
    const claim3 = await claimMentions(agent.id);

    // First claim should succeed
    expect(claim1.length).toBe(1);
    expect(claim1[0].channelId).toBe(channel.id);

    // Subsequent claims should fail (channel already processing)
    expect(claim2.length).toBe(0);
    expect(claim3.length).toBe(0);
  });

  test("releaseMentionProcessing allows reclaiming", async () => {
    const agent = await createAgent({
      name: "release-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // Create channel and post mention
    const channel = await createChannel("release-channel", "public");
    await postMessage(channel.id, agent.id, `@${agent.id} test`, { mentions: [agent.id] });

    // Claim
    const claimed = await claimMentions(agent.id);
    expect(claimed.length).toBe(1);

    // Subsequent claim should fail
    const claim2 = await claimMentions(agent.id);
    expect(claim2.length).toBe(0);

    // Release processing
    await releaseMentionProcessing(agent.id, [channel.id]);

    // Now should be claimable again (but no NEW mentions, so count depends on read state)
    // Actually, since we didn't mark as read, the same mentions should still be there
    const claim3 = await claimMentions(agent.id);
    expect(claim3.length).toBe(1);
  });

  test("releaseStaleMentionProcessing releases old processing channels", async () => {
    const agent = await createAgent({
      name: "stale-mention-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // Create channel and post mention
    const channel = await createChannel("stale-channel", "public");
    await postMessage(channel.id, agent.id, `@${agent.id} stale test`, { mentions: [agent.id] });

    // Claim
    const claimed = await claimMentions(agent.id);
    expect(claimed.length).toBe(1);

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Release stale (timeout = 0 means any age)
    const released = await releaseStaleMentionProcessing(0);
    expect(released).toBeGreaterThanOrEqual(1);

    // Should be claimable again
    const reclaimed = await claimMentions(agent.id);
    expect(reclaimed.length).toBe(1);
    expect(reclaimed[0].channelId).toBe(channel.id);
  });

  test("claimMentions returns empty array when no mentions", async () => {
    const agent = await createAgent({
      name: "no-mention-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    const claimed = await claimMentions(agent.id);
    expect(claimed.length).toBe(0);
  });

  test("claimMentions only claims channels with unread mentions", async () => {
    const agent = await createAgent({
      name: "read-mention-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // Create channel and post mention
    const channel = await createChannel("read-channel", "public");
    const _msg = await postMessage(channel.id, agent.id, `@${agent.id} test message`, {
      mentions: [agent.id],
    });

    // Mark as read BEFORE claiming
    await updateReadState(agent.id, channel.id);

    // Try to claim - should get nothing (already read)
    const claimed = await claimMentions(agent.id);
    expect(claimed.length).toBe(0);
  });

  test("releasing processing allows subsequent polling to claim", async () => {
    const agent = await createAgent({
      name: "repolling-agent",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // Create channel and post mentions
    const channel = await createChannel("repoll-channel", "public");
    await postMessage(channel.id, agent.id, `@${agent.id} first`, { mentions: [agent.id] });
    await postMessage(channel.id, agent.id, `@${agent.id} second`, { mentions: [agent.id] });

    // Poll 1: Claim
    const poll1 = await claimMentions(agent.id);
    expect(poll1.length).toBe(1);

    // Poll 2: Nothing (processing)
    const poll2 = await claimMentions(agent.id);
    expect(poll2.length).toBe(0);

    // Agent marks as read and releases
    await updateReadState(agent.id, channel.id);
    await releaseMentionProcessing(agent.id, [channel.id]);

    // Poll 3: Nothing (no NEW unread mentions)
    const poll3 = await claimMentions(agent.id);
    expect(poll3.length).toBe(0);

    // Wait a bit to ensure new message has later timestamp
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Post new mention
    await postMessage(channel.id, agent.id, `@${agent.id} third`, { mentions: [agent.id] });

    // Poll 4: Should claim new mention
    const poll4 = await claimMentions(agent.id);
    expect(poll4.length).toBe(1);
  });
});
