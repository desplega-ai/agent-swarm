// Operator-only agent soft delete and restore (migration 334): blockers,
// warnings hash, read-path filtering, ingress guards, RBAC and the audit trail.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import * as db from "../be/db";
import {
  closeDb,
  createAgent,
  createScheduledTask,
  createTaskExtended,
  createUser,
  getAgentById,
  getAgentStatusCounts,
  getAllAgents,
  getDbClient,
  getIdleWorkersWithCapacity,
  getScheduledTaskById,
  initDb,
} from "../be/db";
import {
  AgentLifecycleError,
  listAgentLifecycleEvents,
  previewAgentDeletion,
  restoreAgent,
  softDeleteAgent,
} from "../be/db/agent-lifecycle";
import {
  bindAgentToPool,
  createRuntimeController,
  createRuntimePool,
  listAgentsForPool,
} from "../be/runtime-pools/db";
import {
  mintAgentToken,
  mintRuntimeToken,
  mintScriptRunToken,
  mintSessionToken,
} from "../be/users";
import { exitIfAgentDeleted } from "../commands/runner";
import { ensureExtensionAgent } from "../extensions/identity";
import { handleAgentLifecycle } from "../http/agent-lifecycle";
import { handleAgentRegister, handleAgentsRest } from "../http/agents";
import { handleCore } from "../http/core";
import { handlePoll } from "../http/poll";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { createStandaloneScheduleTask } from "../scheduler/schedule-task";
import { workflowEventBus } from "../workflows/event-bus";
import { AgentTaskExecutor } from "../workflows/executors/agent-task";
import { interpolate } from "../workflows/template";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = `./test-agent-soft-delete-${crypto.randomUUID()}.sqlite`;
const API_KEY = "agent-soft-delete-key";
const OPERATOR = { kind: "operator" as const, ref: "op:test", userId: null };
const DELETED_ERROR = /was deleted on .*Restore it or pick another agent/;

let server: Server;
let baseUrl = "";
let leadId = "";

async function api(method: string, path: string, body?: unknown, agentId?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };
  if (agentId) headers["X-Agent-ID"] = agentId;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function offlineWorker(name: string) {
  return await createAgent({ name, isLead: false, status: "offline" });
}

async function deleteNow(agentId: string, actor = OPERATOR) {
  const { warningsHash } = await previewAgentDeletion(agentId);
  return await softDeleteAgent(agentId, { reason: "retired worker", warningsHash }, actor);
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AgentLifecycleError) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) await unlink(TEST_DB_PATH + suffix).catch(() => {});
  initDb(TEST_DB_PATH);
  leadId = (await createAgent({ name: "sd-lead", isLead: true, status: "idle" })).id;
  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleCore(req, res, myAgentId, API_KEY)) return;
    const pathSegments = getPathSegments(req.url ?? "");
    const query = parseQueryParams(req.url ?? "");
    if (await handleAgentRegister(req, res, pathSegments, myAgentId)) return;
    for (const handler of [handlePoll, handleAgentLifecycle, handleAgentsRest, handleTasks]) {
      if (await handler(req, res, pathSegments, query, myAgentId)) return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) await unlink(TEST_DB_PATH + suffix).catch(() => {});
});

describe("blockers", () => {
  test("open task, offered task, live worker, pool binding, lead and already deleted refuse", async () => {
    const busy = await offlineWorker("sd-open-task");
    await createTaskExtended("pinned work", { agentId: busy.id });
    expect(await refusal(deleteNow(busy.id))).toBe("open_tasks");

    const offered = await offlineWorker("sd-offered");
    await createTaskExtended("offer", { offeredTo: offered.id });
    expect(await refusal(deleteNow(offered.id))).toBe("open_tasks");

    const live = await createAgent({ name: "sd-live", isLead: false, status: "idle" });
    expect(await refusal(deleteNow(live.id))).toBe("not_offline");

    const bound = await offlineWorker("sd-bound");
    const controller = await createRuntimeController({ name: "sd-docker", kind: "docker" });
    const pool = await createRuntimePool({
      name: "sd-pool",
      kind: "docker",
      placements: [controller.id],
      image: "test-worker",
    });
    await bindAgentToPool(bound.id, pool.id);
    expect(await refusal(deleteNow(bound.id))).toBe("pool_bound");

    await getDbClient().run("UPDATE agents SET status = 'offline' WHERE id = ?", [leadId]);
    expect(await refusal(deleteNow(leadId))).toBe("lead");
    await getDbClient().run("UPDATE agents SET status = 'idle' WHERE id = ?", [leadId]);

    const extId = await ensureExtensionAgent("sd-tracker");
    await getDbClient().run("UPDATE agents SET status = 'offline' WHERE id = ?", [extId]);
    expect(await refusal(deleteNow(extId))).toBe("extension");

    const gone = await offlineWorker("sd-twice");
    await deleteNow(gone.id);
    expect(await refusal(deleteNow(gone.id))).toBe("already_deleted");
  });

  test("a stale warnings hash refuses with warnings_changed", async () => {
    const agent = await offlineWorker("sd-hash");
    const { warningsHash } = await previewAgentDeletion(agent.id);
    await getDbClient().run(
      "INSERT INTO swarm_config (id, scope, scopeId, key, value, isSecret, createdAt, lastUpdatedAt) VALUES (?, 'agent', ?, 'SD_KEY', 'v', 0, ?, ?)",
      [crypto.randomUUID(), agent.id, new Date().toISOString(), new Date().toISOString()],
    );
    const code = await refusal(
      softDeleteAgent(agent.id, { reason: "retired worker", warningsHash }, OPERATOR),
    );
    expect(code).toBe("warnings_changed");
    const fresh = await previewAgentDeletion(agent.id);
    expect(fresh.warnings.find((w) => w.kind === "config")?.items[0]?.name).toBe("SD_KEY");
    expect((await deleteNow(agent.id)).agent.deletedAt).toBeString();
  });
});

describe("delete and restore", () => {
  test("hides the agent everywhere, disables its schedules, restores lossless", async () => {
    const agent = await offlineWorker("sd-cycle");
    const schedule = await createScheduledTask({
      name: `sd-schedule-${Date.now()}`,
      intervalMs: 60_000,
      taskTemplate: "scheduled work",
      createdByAgentId: leadId,
      targetAgentId: agent.id,
      timezone: "UTC",
    });
    const preview = await previewAgentDeletion(agent.id);
    expect(preview.blockers).toEqual([]);
    expect(preview.warnings.find((w) => w.kind === "schedules")?.items).toEqual([
      { id: schedule.id, name: schedule.name },
    ]);

    const user = await createUser({ name: "Operator Person", email: `sd-${Date.now()}@x.test` });
    const actor = { kind: "user" as const, ref: `user:${user.id}`, userId: user.id };
    const result = await softDeleteAgent(
      agent.id,
      { reason: "  retired worker  ", warningsHash: preview.warningsHash },
      actor,
    );
    expect(result.disabledScheduleIds).toEqual([schedule.id]);
    expect(result.agent.deletedBy).toBe(user.id);
    expect((await getScheduledTaskById(schedule.id))?.enabled).toBe(false);

    expect(await getAgentById(agent.id)).toBeNull();
    expect((await getAgentById(agent.id, { includeDeleted: true }))?.deletedAt).toBeString();
    expect((await getAllAgents()).map((a) => a.id)).not.toContain(agent.id);
    expect((await getAllAgents({ deleted: "only" })).map((a) => a.id)).toEqual(
      expect.arrayContaining([agent.id]),
    );
    const offlineBefore = (await getAgentStatusCounts()).offline;
    await getDbClient().run("UPDATE agents SET status = 'idle' WHERE id = ?", [agent.id]);
    // Even a stray status write leaves it out of dispatch and counts.
    expect((await getIdleWorkersWithCapacity()).map((a) => a.id)).not.toContain(agent.id);
    expect((await getAgentStatusCounts()).idle).toBe(
      (await getAllAgents()).filter((a) => a.status === "idle").length,
    );
    await getDbClient().run("UPDATE agents SET status = 'offline' WHERE id = ?", [agent.id]);
    expect((await getAgentStatusCounts()).offline).toBe(offlineBefore);

    // Its name is freed for a new agent.
    const twin = await offlineWorker("sd-cycle");
    expect(await refusal(restoreAgent(agent.id, { reason: "came back" }, OPERATOR))).toBe(
      "name_taken",
    );
    const restored = await restoreAgent(
      agent.id,
      { reason: "came back", newName: "sd-cycle-2" },
      OPERATOR,
    );
    expect(restored.agent).toMatchObject({ name: "sd-cycle-2", status: "offline" });
    expect(restored.agent.deletedAt).toBeUndefined();
    expect(restored.agent.runtimePoolId).toBeNull();
    expect(restored.disabledScheduleIds).toEqual([schedule.id]);
    expect((await getScheduledTaskById(schedule.id))?.enabled).toBe(false);
    expect(twin.name).toBe("sd-cycle");

    const events = await listAgentLifecycleEvents(agent.id);
    expect(events.map((e) => e.action)).toEqual(["restored", "deleted"]);
    expect(events[1]).toMatchObject({
      actorKind: "user",
      actorRef: `user:${user.id}`,
      createdBy: user.id,
      reason: "retired worker",
    });
    expect(events[1]!.snapshot).toMatchObject({
      name: "sd-cycle",
      disabledScheduleIds: [schedule.id],
    });
    expect(events[0]).toMatchObject({ actorKind: "operator", createdBy: null });
  });

  test("a deleted pool agent is not listed for its pool", async () => {
    const agent = await offlineWorker("sd-pool-list");
    const controller = await createRuntimeController({ name: "sd-docker-2", kind: "docker" });
    const pool = await createRuntimePool({
      name: "sd-pool-2",
      kind: "docker",
      placements: [controller.id],
      image: "test-worker",
    });
    await bindAgentToPool(agent.id, pool.id);
    await bindAgentToPool(agent.id, null);
    await deleteNow(agent.id);
    await getDbClient().run("UPDATE agents SET runtime_pool_id = ? WHERE id = ?", [
      pool.id,
      agent.id,
    ]);
    expect((await listAgentsForPool(pool.id)).map((a) => a.id)).not.toContain(agent.id);
    await expect(bindAgentToPool(agent.id, pool.id)).rejects.toThrow();
  });
});

describe("ingress for a deleted agent", () => {
  let deletedId = "";
  beforeAll(async () => {
    deletedId = (await offlineWorker("sd-ingress")).id;
    await deleteNow(deletedId);
  });

  test("task creation fails loudly for agentId and offeredTo", async () => {
    await expect(createTaskExtended("x", { agentId: deletedId })).rejects.toThrow(DELETED_ERROR);
    await expect(createTaskExtended("x", { offeredTo: deletedId })).rejects.toThrow(DELETED_ERROR);
    const res = await api(
      "POST",
      "/api/tasks",
      { task: "x", agentId: deletedId, routingReason: "human_pinned" },
      leadId,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(DELETED_ERROR);
  });

  test("a re-enabled schedule and a workflow agent-task node fail with the same message", async () => {
    const schedule = await createScheduledTask({
      name: `sd-reenabled-${Date.now()}`,
      intervalMs: 60_000,
      taskTemplate: "scheduled work",
      createdByAgentId: leadId,
      targetAgentId: deletedId,
      timezone: "UTC",
    });
    await expect(createStandaloneScheduleTask(schedule)).rejects.toThrow(DELETED_ERROR);
    const executor = new AgentTaskExecutor({
      db: db as typeof import("../be/db"),
      eventBus: workflowEventBus,
      interpolate: (template, ctx) => interpolate(template, ctx).result,
    });
    const result = await executor.run({
      config: { template: "workflow work", agentId: deletedId },
      context: {},
      meta: {
        runId: crypto.randomUUID(),
        stepId: crypto.randomUUID(),
        nodeId: "task1",
        workflowId: "",
        dryRun: false,
      },
    });
    expect(result.status).toBe("failed");
    expect((result as { error?: string }).error).toMatch(DELETED_ERROR);
  });

  test("register, ping and poll answer 410 agent_deleted and revive nothing", async () => {
    const register = await api("POST", "/api/agents", { name: "sd-ingress" }, deletedId);
    expect(register).toEqual({ status: 410, body: { error: "agent_deleted" } });
    expect((await api("POST", "/ping", undefined, deletedId)).status).toBe(410);
    expect((await api("GET", "/api/poll", undefined, deletedId)).status).toBe(410);
    const row = await getAgentById(deletedId, { includeDeleted: true });
    expect(row?.status).toBe("offline");
    expect(row?.deletedAt).toBeString();
  });

  test("the runner exits once on 410 and ignores other statuses", () => {
    const codes: number[] = [];
    const exit = ((code: number) => {
      codes.push(code);
    }) as (code: number) => never;
    exitIfAgentDeleted(404, "worker", exit);
    exitIfAgentDeleted(500, "worker", exit);
    exitIfAgentDeleted(410, "worker", exit);
    expect(codes).toEqual([1]);
  });
});

describe("credentials of a deleted agent", () => {
  const HOUR = 60 * 60 * 1000;

  async function createTaskAs(token: string): Promise<number> {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ task: "token probe" }),
    });
    await res.text();
    return res.status;
  }

  async function mintEveryKind(agentId: string) {
    const agent = await mintAgentToken(agentId);
    return {
      agent: agent.plaintext,
      agentChild: (
        await mintSessionToken(agentId, crypto.randomUUID(), HOUR, {
          tokenId: agent.tokenId,
          runtimeId: null,
        })
      ).plaintext,
      runtime: (await mintRuntimeToken(agentId, `rt-${crypto.randomUUID()}`)).plaintext,
      task: (await mintSessionToken(agentId, crypto.randomUUID(), HOUR)).plaintext,
      scriptRun: (await mintScriptRunToken(agentId, HOUR)).plaintext,
    };
  }

  async function statuses(tokens: Record<string, string>) {
    const out: Record<string, number> = {};
    for (const [kind, token] of Object.entries(tokens)) out[kind] = await createTaskAs(token);
    return out;
  }

  test("every token kind minted before the delete gets 401 after it, restore included", async () => {
    const worker = await offlineWorker("sd-tokens");
    const tokens = await mintEveryKind(worker.id);
    // Controls: the agent and runtime kinds create tasks while the agent lives.
    expect(await createTaskAs(tokens.agent)).toBe(201);
    expect(await createTaskAs(tokens.runtime)).toBe(201);

    const { event } = await deleteNow(worker.id);
    const refused = Object.fromEntries(Object.keys(tokens).map((kind) => [kind, 401]));
    expect(await statuses(tokens)).toEqual(refused);
    expect(event.snapshot.revokedTokenCount).toBe(5);

    await restoreAgent(worker.id, { reason: "back" }, OPERATOR);
    expect(await statuses(tokens)).toEqual(refused);
  });

  test("a token minted after the delete is refused; one minted after restore works", async () => {
    const worker = await offlineWorker("sd-token-race");
    await deleteNow(worker.id);
    // A mint that raced past the delete transaction: only the resolver guard stops it.
    const raced = await mintRuntimeToken(worker.id, `rt-${crypto.randomUUID()}`);
    expect(await createTaskAs(raced.plaintext)).toBe(401);

    await restoreAgent(worker.id, { reason: "back" }, OPERATOR);
    const fresh = await mintAgentToken(worker.id);
    expect(await createTaskAs(fresh.plaintext)).toBe(201);
  });
});

describe("HTTP routes", () => {
  test("operator walks preview, delete, list, restore and audit", async () => {
    const agent = await offlineWorker("sd-http");
    const preview = await api("GET", `/api/agents/${agent.id}/delete-preview`);
    expect(preview.status).toBe(200);
    expect(preview.body.blockers).toEqual([]);

    const short = await api("POST", `/api/agents/${agent.id}/delete`, {
      reason: "x",
      warningsHash: preview.body.warningsHash,
    });
    expect(short.status).toBe(400);
    const stale = await api("POST", `/api/agents/${agent.id}/delete`, {
      reason: "retired worker",
      warningsHash: "stale",
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "warnings_changed", preview: { agentId: agent.id } });

    const deleted = await api("POST", `/api/agents/${agent.id}/delete`, {
      reason: "retired worker",
      warningsHash: preview.body.warningsHash,
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body.event).toMatchObject({ action: "deleted", actorKind: "operator" });

    const listed = await api("GET", "/api/agents");
    expect(listed.body.agents.map((a: { id: string }) => a.id)).not.toContain(agent.id);
    const onlyDeleted = await api("GET", "/api/agents?deleted=only");
    expect(onlyDeleted.body.agents.map((a: { id: string }) => a.id)).toContain(agent.id);
    expect((await api("GET", `/api/agents/${agent.id}`)).status).toBe(404);

    const restored = await api("POST", `/api/agents/${agent.id}/restore`, { reason: "came back" });
    expect(restored.status).toBe(200);
    const events = await api("GET", `/api/agents/${agent.id}/lifecycle-events`);
    expect(events.body.events.map((e: { action: string }) => e.action)).toEqual([
      "restored",
      "deleted",
    ]);
  });

  test("every agent caller, the lead included, gets 403", async () => {
    const target = await offlineWorker("sd-rbac");
    const worker = await offlineWorker("sd-rbac-caller");
    for (const caller of [leadId, worker.id]) {
      for (const [method, path, body] of [
        ["GET", `/api/agents/${target.id}/delete-preview`, undefined],
        ["POST", `/api/agents/${target.id}/delete`, { reason: "nope", warningsHash: "h" }],
        ["POST", `/api/agents/${target.id}/restore`, { reason: "nope" }],
        ["GET", `/api/agents/${target.id}/lifecycle-events`, undefined],
        ["GET", "/api/agents?deleted=only", undefined],
      ] as const) {
        expect((await api(method, path, body, caller)).status).toBe(403);
      }
    }
    expect(await getAgentById(target.id)).not.toBeNull();
  });
});
