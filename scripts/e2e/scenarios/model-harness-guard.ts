import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

/**
 * Harness model guard over HTTP: a directed task with a model from another harness
 * family is a 400, a modelTier resolves per harness at claim, and a pool task that
 * pins an Anthropic model is skipped by a Codex worker and claimed by a Claude worker.
 */
export const modelHarnessGuard: Scenario = {
  name: "model-harness-guard",
  order: 35,
  async run(ctx) {
    const register = async (name: string, harness: string) => {
      const response = await ctx.api("POST", "/api/agents", {
        body: { name, role: "worker", status: "online", harness_provider: harness },
      });
      expectStatus(response, [201], `register ${harness} worker`);
      return String(asRecord(response.json).id);
    };
    const codexId = await register(`e2e-codex-${ctx.nonce}`, "codex");
    const claudeId = await register(`e2e-claude-${ctx.nonce}`, "claude");

    const directed = {
      task: `harness guard ${ctx.nonce}`,
      agentId: codexId,
      routingReason: "human_pinned",
      source: "api",
    };
    let response = await ctx.api("POST", "/api/tasks", {
      body: { ...directed, model: "claude-opus-5-5" },
    });
    expectStatus(response, [400], "reject an Anthropic model on a Codex agent");
    expect(
      String(asRecord(response.json).error).includes("does not run on the codex harness"),
      `Unexpected rejection message: ${String(asRecord(response.json).error)}`,
    );

    response = await ctx.api("POST", "/api/tasks", { body: { ...directed, modelTier: "smart" } });
    expectStatus(response, [201], "accept a modelTier on a Codex agent");
    const tierTaskId = String(asRecord(response.json).id);
    response = await ctx.api("GET", "/api/poll", { agentId: codexId });
    expectStatus(response, [200], "Codex poll for the tier task");
    let trigger = asRecord(asRecord(response.json).trigger);
    let task = asRecord(trigger.task);
    expect(
      trigger.type === "task_assigned" && trigger.taskId === tierTaskId,
      "Codex poll did not return the tier task",
    );
    expect(
      task.resolvedModel === "gpt-5.6-sol" && task.modelSource === "tier-default",
      `Tier task resolved to ${String(task.resolvedModel)} (${String(task.modelSource)})`,
    );
    response = await ctx.api("POST", `/api/tasks/${tierTaskId}/finish`, {
      agentId: codexId,
      body: { status: "completed", output: "done" },
    });
    expectStatus(response, [200], "finish the tier task");

    response = await ctx.api("POST", "/api/tasks", {
      body: { task: `harness guard pool ${ctx.nonce}`, source: "api", model: "claude-opus-5-5" },
    });
    expectStatus(response, [201], "accept a pool task a Claude agent can run");
    const poolTaskId = String(asRecord(response.json).id);

    response = await ctx.api("GET", "/api/poll", { agentId: codexId });
    expectStatus(response, [200], "Codex poll for the pool task");
    trigger = asRecord(asRecord(response.json).trigger ?? {});
    expect(
      !(trigger.type === "task_assigned" && trigger.taskId === poolTaskId),
      "Codex worker claimed a pool task pinned to an Anthropic model",
    );

    response = await ctx.api("GET", "/api/poll", { agentId: claudeId });
    expectStatus(response, [200], "Claude poll for the pool task");
    trigger = asRecord(asRecord(response.json).trigger);
    task = asRecord(trigger.task);
    expect(
      trigger.type === "task_assigned" && trigger.taskId === poolTaskId,
      "Claude worker did not claim the pool task",
    );
    response = await ctx.api("POST", `/api/tasks/${poolTaskId}/finish`, {
      agentId: claudeId,
      body: { status: "completed", output: "done" },
    });
    expectStatus(response, [200], "finish the pool task");
  },
};
