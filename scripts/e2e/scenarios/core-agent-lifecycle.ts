import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { registerLead, registerWorker, retireAgent } from "./core-helpers";

function listedIds(json: unknown): string[] {
  return asRecords(json, "agents").map((agent) => String(agent.id));
}

/** Operator-only soft delete: blocker, preview, delete, 410 on reconnect, restore, audit. */
async function softDeleteAndRestore(ctx: ScenarioContext): Promise<void> {
  const agentId = await registerWorker(ctx, "lifecycle");

  // A live worker is a blocker; the delete names it and changes nothing.
  let response = await ctx.api("GET", `/api/agents/${agentId}/delete-preview`);
  expectStatus(response, [200], "preview a live worker");
  let preview = asRecord(response.json);
  expect(
    asRecords(preview, "blockers").some((b) => b.code === "not_offline"),
    `Live worker preview has no not_offline blocker: ${JSON.stringify(preview)}`,
  );
  response = await ctx.api("POST", `/api/agents/${agentId}/delete`, {
    body: { reason: "retire e2e worker", warningsHash: String(preview.warningsHash) },
  });
  expectStatus(response, [409], "delete a live worker");
  expect(asRecord(response.json).code === "not_offline", "Wrong refusal code for a live worker");

  await retireAgent(ctx, agentId);
  response = await ctx.api("GET", `/api/agents/${agentId}/delete-preview`);
  expectStatus(response, [200], "preview an offline worker");
  preview = asRecord(response.json);
  expect(asRecords(preview, "blockers").length === 0, `Unexpected blockers ${JSON.stringify(preview)}`);

  response = await ctx.api("POST", `/api/agents/${agentId}/delete`, {
    body: { reason: "retire e2e worker", warningsHash: String(preview.warningsHash) },
  });
  expectStatus(response, [200], "delete an offline worker");
  expect(asRecord(asRecord(response.json).agent).deletedAt !== undefined, "No deletedAt");

  response = await ctx.api("GET", "/api/agents");
  expectStatus(response, [200], "list agents");
  expect(!listedIds(response.json).includes(agentId), "Deleted agent is still listed");
  response = await ctx.api("GET", "/api/agents?deleted=only");
  expectStatus(response, [200], "list deleted agents");
  expect(listedIds(response.json).includes(agentId), "Deleted agent missing from deleted=only");
  expectStatus(await ctx.api("GET", `/api/agents/${agentId}`), [404], "read a deleted agent");

  // The worker cannot come back on its own.
  response = await ctx.api("POST", "/api/agents", {
    agentId,
    body: { name: `core-lifecycle-${ctx.nonce}` },
  });
  expectStatus(response, [410], "re-register a deleted agent");
  expect(asRecord(response.json).error === "agent_deleted", "Register did not say agent_deleted");
  expectStatus(await ctx.api("POST", "/ping", { agentId }), [410], "ping a deleted agent");
  expectStatus(await ctx.api("GET", "/api/poll", { agentId }), [410], "poll a deleted agent");

  response = await ctx.api("POST", `/api/agents/${agentId}/restore`, {
    body: { reason: "bring it back" },
  });
  expectStatus(response, [200], "restore");
  const restored = asRecord(asRecord(response.json).agent);
  expect(restored.status === "offline" && restored.deletedAt === undefined, "Restore state wrong");
  expectStatus(
    await ctx.api("POST", `/api/agents/${agentId}/restore`, { body: { reason: "again please" } }),
    [409],
    "restore an agent that is not deleted",
  );

  response = await ctx.api("GET", `/api/agents/${agentId}/lifecycle-events`);
  expectStatus(response, [200], "lifecycle events");
  const events = asRecords(response.json, "events");
  expect(
    events.map((e) => e.action).join(",") === "restored,deleted" &&
      events.every((e) => e.actorKind === "operator" && typeof e.createdAt === "string"),
    `Unexpected audit ${JSON.stringify(events)}`,
  );
  expect(events[1]?.reason === "retire e2e worker", "Delete reason not recorded");
}

/** Every agent caller, the lead included, is refused. */
async function agentsAreRefused(ctx: ScenarioContext): Promise<void> {
  const target = await registerWorker(ctx, "lifecycle-target");
  const leadId = await registerLead(ctx, "lifecycle");
  for (const caller of [target, leadId]) {
    expectStatus(
      await ctx.api("GET", `/api/agents/${target}/delete-preview`, { agentId: caller }),
      [403],
      "agent previews a delete",
    );
    expectStatus(
      await ctx.api("POST", `/api/agents/${target}/delete`, {
        agentId: caller,
        body: { reason: "not allowed", warningsHash: "x" },
      }),
      [403],
      "agent deletes an agent",
    );
    expectStatus(
      await ctx.api("POST", `/api/agents/${target}/restore`, {
        agentId: caller,
        body: { reason: "not allowed" },
      }),
      [403],
      "agent restores an agent",
    );
    expectStatus(
      await ctx.api("GET", `/api/agents/${target}/lifecycle-events`, { agentId: caller }),
      [403],
      "agent reads the lifecycle audit",
    );
    expectStatus(
      await ctx.api("GET", "/api/agents?deleted=only", { agentId: caller }),
      [403],
      "agent lists deleted agents",
    );
  }
  await retireAgent(ctx, leadId);
  await retireAgent(ctx, target);
}

export const coreAgentLifecycle: Scenario = {
  name: "core-agent-lifecycle",
  order: 206,
  async run(ctx) {
    await softDeleteAndRestore(ctx);
    await agentsAreRefused(ctx);
  },
};
