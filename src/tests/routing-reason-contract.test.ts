import { describe, expect, test } from "bun:test";
import delegate from "../be/seed-scripts/catalog/delegate";
import { sendTaskHandler, sendTaskInputSchema } from "../tools/send-task";

const ROUTING_REASONS = [
  "skill",
  "continuity",
  "overflow",
  "human_pinned",
  "reroute_fault",
] as const;

describe("send-task routing decision input", () => {
  test.each(ROUTING_REASONS)("accepts routingReason %s", (routingReason) => {
    expect(
      sendTaskInputSchema.safeParse({ task: "delegate", agentId: "worker", routingReason }).success,
    ).toBe(true);
  });

  test("rejects an invalid routingReason", () => {
    expect(
      sendTaskInputSchema.safeParse({
        task: "delegate",
        agentId: "worker",
        routingReason: "round_robin",
      }).success,
    ).toBe(false);
  });

  test("requires routingReason only when caller supplies agentId", () => {
    expect(sendTaskInputSchema.safeParse({ task: "pool" }).success).toBe(true);
    expect(sendTaskInputSchema.safeParse({ task: "delegate", agentId: "worker" }).success).toBe(
      false,
    );
  });

  test("accepts a 200-character routingNote and rejects 201", () => {
    expect(
      sendTaskInputSchema.safeParse({
        task: "delegate",
        agentId: "worker",
        routingReason: "skill",
        routingNote: "x".repeat(200),
      }).success,
    ).toBe(true);
    expect(
      sendTaskInputSchema.safeParse({
        task: "delegate",
        agentId: "worker",
        routingReason: "skill",
        routingNote: "x".repeat(201),
      }).success,
    ).toBe(false);
  });

  test("handler rejects direct callers that bypass schema parsing", async () => {
    const result = await sendTaskHandler({ kind: "owner", agentId: "sender" }, {
      task: "delegate",
      agentId: "worker",
      offerMode: false,
      allowDuplicate: false,
    } as never);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("routingReason is required");
  });
});

test("the delegate script requires the caller's reason and forwards it without relabeling", async () => {
  const sent: unknown[] = [];
  const ctx = {
    swarm: {
      swarm_get: async () => ({ agents: [{ id: "worker", name: "Worker" }] }),
      task_send: async (args: unknown) => {
        sent.push(args);
        return { id: "task" };
      },
    },
  };
  expect((await delegate({ agentName: "Worker", task: "work" }, ctx)).ok).toBe(false);
  expect(sent).toHaveLength(0);
  const result = await delegate(
    { agentName: "Worker", task: "work", routingReason: "continuity", routingNote: "same PR" },
    ctx,
  );
  expect(result.ok).toBe(true);
  expect(sent).toEqual([
    { agentId: "worker", task: "work", routingReason: "continuity", routingNote: "same PR" },
  ]);
});
