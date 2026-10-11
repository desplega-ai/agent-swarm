import { expect, test } from "bun:test";
import type { ScenarioContext } from "../../scripts/e2e/run";
import { runtimePools } from "../../scripts/e2e/scenarios/runtime-pools";

test("runtime pool cleanup preserves the primary failure and attempts every remaining step", async () => {
  const controllerId = crypto.randomUUID();
  const poolId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const baseUrl = "http://api.invalid";
  const primary = new Error("wake assignment failed");
  const calls: string[] = [];
  const responses = new Map<string, unknown>([
    ["GET /status", { runtime_pools: { enabled: true, supervisor: "running" } }],
    ["POST /api/runtime-controllers", { controller: { id: controllerId } }],
    [
      `GET /api/runtime-controllers/${controllerId}`,
      { controller: { config: { WORKER_API_URL: baseUrl } } },
    ],
    ["GET /api/runtime-controllers", { controllers: [{ id: controllerId }] }],
    ["POST /api/runtime-pools", { pool: { id: poolId } }],
    [`GET /api/runtime-pools/${poolId}`, { pool: { slotsPerRuntime: 2 } }],
    ["GET /api/runtime-pools", { pools: [{ id: poolId }] }],
    [`POST /api/runtime-pools/${poolId}/agents`, { agent: { id: agentId, status: "offline" } }],
    ["POST /api/tasks", { id: taskId, status: "unassigned" }],
  ]);
  const ctx = {
    baseUrl,
    nonce: "cleanup",
    log: () => {},
    api: async (method: string, path: string) => {
      const call = `${method} ${path}`;
      calls.push(call);
      if (call === `GET /api/tasks/${taskId}`) throw primary;
      if (call === `POST /api/tasks/${taskId}/cancel` || method === "DELETE")
        throw new Error("cleanup request failed");
      const status = method === "PUT" ? 500 : call === "POST /api/tasks" ? 201 : 200;
      return { status, json: responses.get(call) ?? {}, text: "" };
    },
  } as ScenarioContext;

  await expect(runtimePools.run(ctx)).rejects.toBe(primary);
  expect(calls.slice(-6)).toEqual([
    `POST /api/tasks/${taskId}/cancel`,
    `PUT /api/agents/${agentId}/runtime-pool`,
    `DELETE /api/runtime-pools/${poolId}`,
    `GET /api/runtime-pools/${poolId}`,
    `DELETE /api/runtime-controllers/${controllerId}`,
    `GET /api/runtime-controllers/${controllerId}`,
  ]);
});
