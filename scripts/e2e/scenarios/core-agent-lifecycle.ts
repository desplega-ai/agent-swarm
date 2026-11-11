import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { registerLead, registerWorker, retireAgent } from "./core-helpers";

/** Operator-only delete into agent_history: blocker, delete, 410 on re-register, restore, history. */
async function deleteAndRestore(ctx: ScenarioContext): Promise<void> {
  const agentId = await registerWorker(ctx, "lifecycle");
  const reason = "retire e2e worker";

  // A live worker is a blocker; the delete names it and changes nothing.
  let response = await ctx.api("POST", `/api/agents/${agentId}/delete`, { body: { reason } });
  expectStatus(response, [409], "delete a live worker");
  expect(asRecord(response.json).code === "not_offline", "Wrong refusal code for a live worker");

  await retireAgent(ctx, agentId);
  response = await ctx.api("POST", `/api/agents/${agentId}/delete`, { body: { reason } });
  expectStatus(response, [200], "delete an offline worker");
  expect(asRecord(asRecord(response.json).event).event === "deleted", "No deleted event");
  expectStatus(await ctx.api("GET", `/api/agents/${agentId}`), [404], "read a deleted agent");

  // A restarted worker cannot re-create the id.
  response = await ctx.api("POST", "/api/agents", {
    agentId,
    body: { name: `core-lifecycle-${ctx.nonce}` },
  });
  expectStatus(response, [410], "re-register a deleted agent");
  expect(asRecord(response.json).error === "agent_deleted", "Register did not say agent_deleted");

  response = await ctx.api("POST", `/api/agents/${agentId}/restore`, {
    body: { reason: "bring it back" },
  });
  expectStatus(response, [200], "restore");
  expect(asRecord(asRecord(response.json).agent).id === agentId, "Restore changed the id");
  expectStatus(
    await ctx.api("POST", `/api/agents/${agentId}/restore`, { body: { reason: "again please" } }),
    [409],
    "restore an agent that exists",
  );

  response = await ctx.api("GET", `/api/agent-history?agentId=${agentId}`);
  expectStatus(response, [200], "agent history");
  const events = asRecords(response.json, "events");
  expect(
    events.map((e) => e.event).join(",") === "restored,deleted" &&
      events.every((e) => String(e.actorRef).startsWith("op:")),
    `Unexpected history ${JSON.stringify(events)}`,
  );
  expect(events[1]?.reason === reason, "Delete reason not recorded");
}

/** Every agent caller, the lead included, is refused. */
async function agentsAreRefused(ctx: ScenarioContext): Promise<void> {
  const target = await registerWorker(ctx, "lifecycle-target");
  const leadId = await registerLead(ctx, "lifecycle");
  for (const caller of [target, leadId]) {
    for (const [method, path, body] of [
      ["POST", `/api/agents/${target}/delete`, { reason: "not allowed" }],
      ["POST", `/api/agents/${target}/restore`, { reason: "not allowed" }],
      ["GET", "/api/agent-history", undefined],
    ] as const) {
      expectStatus(await ctx.api(method, path, { agentId: caller, body }), [403], `agent ${method} ${path}`);
    }
  }
  await retireAgent(ctx, leadId);
  await retireAgent(ctx, target);
}

export const coreAgentLifecycle: Scenario = {
  name: "core-agent-lifecycle",
  order: 206,
  async run(ctx) {
    await deleteAndRestore(ctx);
    await agentsAreRefused(ctx);
  },
};
