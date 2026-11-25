import { sql } from "../db";
import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function records(value: unknown, field: string): Record<string, unknown>[] {
  const list = asRecord(value)[field];
  expect(Array.isArray(list), `Expected ${field} to be an array`);
  return list.map(asRecord);
}

export const taskLifecycle: Scenario = {
  name: "task-lifecycle",
  order: 30,
  async run(ctx) {
    const agentResponse = await ctx.api("POST", "/api/agents", {
      body: { name: `e2e-worker-${ctx.nonce}`, role: "worker", status: "online" },
    });
    expectStatus(agentResponse, [201], "register worker");
    const agentId = asRecord(agentResponse.json).id;
    expect(typeof agentId === "string" && UUID.test(agentId), "Registered agent id is not a UUID");

    const marker = `E2E marker ${ctx.nonce}`;
    const createResponse = await ctx.api("POST", "/api/tasks", {
      body: { task: marker, routingReason: "human_pinned", agentId, source: "api" },
    });
    expectStatus(createResponse, [201], "create assigned task");
    const taskId = asRecord(createResponse.json).id;
    expect(typeof taskId === "string" && UUID.test(taskId), "Created task id is not a UUID");

    let response = await ctx.api("GET", `/api/tasks/${taskId}`);
    expectStatus(response, [200], "read assigned task");
    const initial = asRecord(response.json);
    expect(initial.id === taskId, "Task detail returned the wrong task");
    expect(
      !["completed", "failed", "cancelled", "superseded"].includes(String(initial.status)),
      "Task started terminal",
    );

    response = await ctx.api("GET", "/api/poll", { agentId });
    expectStatus(response, [200], "poll assigned task");
    const trigger = asRecord(asRecord(response.json).trigger);
    expect(
      trigger.type === "task_assigned" && trigger.taskId === taskId,
      "Poll did not return the assigned task",
    );

    const progress = `progress ${ctx.nonce}`;
    response = await ctx.api("POST", `/api/tasks/${taskId}/progress`, {
      agentId,
      body: { progress },
    });
    expectStatus(response, [200], "store HTTP progress");
    response = await ctx.api("GET", `/api/tasks/${taskId}`);
    expectStatus(response, [200], "read progress");
    expect(asRecord(response.json).progress === progress, "Task progress was not persisted");

    const output = `completed ${ctx.nonce}`;
    response = await ctx.api("POST", `/api/tasks/${taskId}/finish`, {
      agentId,
      body: { status: "completed", output },
    });
    expectStatus(response, [200], "finish task");
    response = await ctx.api("GET", `/api/tasks/${taskId}`);
    expectStatus(response, [200], "read completed task");
    const finished = asRecord(response.json);
    expect(finished.status === "completed", "Task did not reach completed status");
    expect(String(finished.output).includes(ctx.nonce), "Task output does not contain the nonce");

    const taskRow = ctx.db.get<{ status: string }>(
      sql`SELECT status FROM agent_tasks WHERE id = ${String(taskId)}`,
    );
    expect(
      taskRow?.status === "completed",
      `agent_tasks row for ${String(taskId)} has status ${taskRow?.status ?? "<missing row>"}`,
    );
    const agentRow = ctx.db.get<{ id: string }>(
      sql`SELECT id FROM agents WHERE id = ${String(agentId)}`,
    );
    expect(agentRow?.id === agentId, `No agents row for the registered worker ${String(agentId)}`);

    response = await ctx.api("GET", "/api/tasks?status=completed");
    expectStatus(response, [200], "filter completed tasks");
    expect(
      records(response.json, "tasks").some((task) => task.id === taskId),
      "Status filter omitted the task",
    );
    response = await ctx.api("GET", `/api/tasks?agentId=${agentId}`);
    expectStatus(response, [200], "filter tasks by agent");
    expect(
      records(response.json, "tasks").some((task) => task.id === taskId),
      "Agent filter omitted the task",
    );
    response = await ctx.api("GET", `/api/tasks?search=${encodeURIComponent(ctx.nonce)}`);
    expectStatus(response, [200], "search tasks");
    const searchResults = records(response.json, "tasks");
    expect(
      searchResults.length === 1 && searchResults[0]?.id === taskId,
      "Search did not return exactly the created task",
    );

    // An alert task (obs-lite) is found again by its fingerprint tag.
    const alertTag = `alert:${ctx.nonce}`;
    response = await ctx.api("POST", "/api/tasks", {
      body: { task: `E2E alert ${ctx.nonce}`, source: "alert", tags: ["obs-lite", alertTag] },
    });
    expectStatus(response, [201], "create alert task");
    const alertTaskId = asRecord(response.json).id;
    expect(asRecord(response.json).source === "alert", "Alert task did not keep source=alert");
    response = await ctx.api(
      "GET",
      `/api/tasks?source=alert&tags=${encodeURIComponent(`${alertTag},unused-${ctx.nonce}`)}`,
    );
    expectStatus(response, [200], "filter tasks by source and tag");
    const tagged = records(response.json, "tasks");
    expect(
      tagged.length === 1 && tagged[0]?.id === alertTaskId,
      "Tag filter did not return exactly the alert task",
    );
    response = await ctx.api("GET", `/api/tasks?tags=${encodeURIComponent(`unused-${ctx.nonce}`)}`);
    expectStatus(response, [200], "filter tasks by an unused tag");
    expect(records(response.json, "tasks").length === 0, "An unused tag matched a task");

    expectStatus(await ctx.api("GET", `/api/agents/${agentId}`), [200], "read agent");
    response = await ctx.api("GET", "/api/agents");
    expectStatus(response, [200], "list agents");
    expect(
      records(response.json, "agents").some((agent) => agent.id === agentId),
      "Agent list omitted the worker",
    );
  },
};
