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
  async run(ctx) {
    const agentResponse = await ctx.api("POST", "/api/agents", {
      body: { name: `e2e-worker-${ctx.nonce}`, role: "worker", status: "online" },
    });
    expectStatus(agentResponse, [201], "register worker");
    const agentId = asRecord(agentResponse.json).id;
    expect(typeof agentId === "string" && UUID.test(agentId), "Registered agent id is not a UUID");

    const marker = `E2E marker ${ctx.nonce}`;
    const createResponse = await ctx.api("POST", "/api/tasks", {
      body: { task: marker, agentId, source: "api" },
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

    const taskRow = ctx.db.get<{ status: string }>("SELECT status FROM agent_tasks WHERE id = ?", [
      String(taskId),
    ]);
    expect(
      taskRow?.status === "completed",
      `agent_tasks row for ${String(taskId)} has status ${taskRow?.status ?? "<missing row>"}`,
    );
    const agentRow = ctx.db.get<{ id: string }>("SELECT id FROM agents WHERE id = ?", [
      String(agentId),
    ]);
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

    expectStatus(await ctx.api("GET", `/api/agents/${agentId}`), [200], "read agent");
    response = await ctx.api("GET", "/api/agents");
    expectStatus(response, [200], "list agents");
    expect(
      records(response.json, "agents").some((agent) => agent.id === agentId),
      "Agent list omitted the worker",
    );
  },
};
