// Trigger group: immutable rows and columns.
// Covers: agent_history_no_update, agent_history_no_delete (agent_history is append-only),
// session_task_parent_immutable (agent_tasks.parentTaskId).
//
// No API route updates or deletes an agent_history row or changes a task's parentTaskId, so
// the refusals themselves cannot be provoked from outside. The scenario proves the visible
// rule instead: every delete and restore appends a new event and leaves the earlier events
// byte-for-byte unchanged, and a chain move keeps each task's parent.
import { sql } from "../db";
import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";

type HistoryRow = {
  id: string;
  agent_id: string;
  event: string;
  reason: string;
  snapshot_json: string;
  created_at: string;
};

function historyRows(ctx: ScenarioContext, agentId: string): HistoryRow[] {
  return ctx.db.query<HistoryRow>(
    sql`SELECT id, agent_id, event, reason, snapshot_json, created_at
        FROM agent_history WHERE agent_id = ${agentId} ORDER BY created_at, id`,
  );
}

async function registerWorker(ctx: ScenarioContext, label: string): Promise<string> {
  const response = await ctx.api("POST", "/api/agents", {
    body: { name: `trg-imm-${label}-${ctx.nonce}`, role: "worker", status: "online" },
  });
  expectStatus(response, [201], `register ${label}`);
  return asString(asRecord(response.json).id, `${label} id`);
}

async function close(ctx: ScenarioContext, agentId: string): Promise<void> {
  expectStatus(await ctx.api("POST", "/close", { agentId, body: {} }), [204], "close agent");
}

export const triggerImmutability: Scenario = {
  name: "trigger-immutability",
  order: 9_360,
  async run(ctx) {
    // ── agent_history is append-only ─────────────────────────────────────────
    const agentId = await registerWorker(ctx, "history");
    await close(ctx, agentId);
    let response = await ctx.api("POST", `/api/agents/${agentId}/delete`, {
      body: { reason: `first delete ${ctx.nonce}` },
    });
    expectStatus(response, [200], "delete the agent");
    const first = historyRows(ctx, agentId);
    expect(first.length === 1 && first[0]?.event === "deleted", "one deleted event");
    const original = first[0] as HistoryRow;

    response = await ctx.api("POST", `/api/agents/${agentId}/restore`, {
      body: { reason: `restore ${ctx.nonce}` },
    });
    expectStatus(response, [200], "restore the agent");
    await close(ctx, agentId);
    response = await ctx.api("POST", `/api/agents/${agentId}/delete`, {
      body: { reason: `second delete ${ctx.nonce}` },
    });
    expectStatus(response, [200], "delete the agent again");

    const after = historyRows(ctx, agentId);
    expect(
      after.length === 3 && after.map((row) => row.event).join() === "deleted,restored,deleted",
      `history appends one event per action: ${JSON.stringify(after.map((row) => row.event))}`,
    );
    const kept = after.find((row) => row.id === original.id);
    expect(
      kept !== undefined && JSON.stringify(kept) === JSON.stringify(original),
      "the first event row is unchanged after later events",
    );
    response = await ctx.api("GET", `/api/agent-history?agentId=${agentId}`);
    expectStatus(response, [200], "list agent history");
    const events = asRecords(response.json, "events");
    expect(
      events.length === 3 && events.some((event) => event.reason === `first delete ${ctx.nonce}`),
      "the API lists all three events with the first reason intact",
    );

    // ── agent_tasks.parentTaskId never changes ───────────────────────────────
    const workerId = await registerWorker(ctx, "chain");
    const base = `shared/trg-imm-${ctx.nonce}`;
    const create = async (label: string, extra: Record<string, unknown>) => {
      const created = await ctx.api("POST", "/api/tasks", {
        body: {
          task: `immutability ${label} ${ctx.nonce}`,
          agentId: workerId,
          routingReason: "human_pinned",
          source: "api",
          key: `${base}/a/`,
          ...extra,
        },
      });
      expectStatus(created, [201], `create ${label}`);
      return asString(asRecord(created.json).id, `${label} id`);
    };
    const rootId = await create("root", {});
    const childId = await create("child", { parentTaskId: rootId });
    const parentOf = (id: string) =>
      ctx.db.get<{ parentTaskId: string | null }>(
        sql`SELECT "parentTaskId" FROM agent_tasks WHERE id = ${id}`,
      )?.parentTaskId;
    expect(parentOf(childId) === rootId, "the child records its parent");

    response = await ctx.api("PATCH", `/api/assets/task/${rootId}/key`, {
      body: { key: `${base}/b/`, cascade: true },
    });
    expectStatus(response, [200], "move the chain");
    expect(parentOf(childId) === rootId, "a chain move keeps the child's parent");
    expect(parentOf(rootId) === null, "a chain move keeps the root parentless");
    const member = ctx.db.get<{ rootId: string }>(
      sql`SELECT "rootId" FROM session_members WHERE "taskId" = ${childId}`,
    );
    expect(member?.rootId === rootId, "the child stays in its root's session");

    for (const id of [childId, rootId]) {
      await ctx.api("POST", `/api/tasks/${id}/cancel`, { body: { reason: "trigger cleanup" } });
    }
    await close(ctx, workerId);
  },
};
