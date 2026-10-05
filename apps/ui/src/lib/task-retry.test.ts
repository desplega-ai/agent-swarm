import { describe, expect, test } from "bun:test";
import { buildRetryInput } from "./task-retry";

const failed = {
  id: "failed-1",
  task: "Bump the pi harness to 1.0.3 in Dockerfile.worker.",
  agentId: "worker-a",
  taskType: "chore",
  tags: ["docker", "harness"],
  priority: 70,
  model: "opus",
  modelTier: "smart" as const,
  effort: "high" as const,
  resolvedModel: "claude-opus-5-5",
};

describe("buildRetryInput", () => {
  test("copies the prompt, agent and settings into a child of the original", () => {
    expect(buildRetryInput(failed, "user-1")).toEqual({
      task: "Bump the pi harness to 1.0.3 in Dockerfile.worker.",
      agentId: "worker-a",
      routingReason: "continuity",
      parentTaskId: "failed-1",
      taskType: "chore",
      tags: ["docker", "harness"],
      priority: 70,
      model: "opus",
      modelTier: "smart",
      effort: "high",
      requestedByUserId: "user-1",
      source: "ui",
    });
  });

  test("asks for the requested model, not the one the server resolved", () => {
    const input = buildRetryInput(failed, "user-1");
    expect(input.model).toBe("opus");
    expect(JSON.stringify(input)).not.toContain("claude-opus-5-5");
  });

  test("a pool task stays in the pool: no agent and no routing reason", () => {
    const input = buildRetryInput({ ...failed, agentId: null }, "user-1");
    expect(input.agentId).toBeUndefined();
    expect(input.routingReason).toBeUndefined();
    expect(JSON.parse(JSON.stringify(input))).not.toHaveProperty("agentId");
  });

  test("without a picked identity the requester is left to the server", () => {
    expect(buildRetryInput(failed, null).requestedByUserId).toBeUndefined();
  });
});
