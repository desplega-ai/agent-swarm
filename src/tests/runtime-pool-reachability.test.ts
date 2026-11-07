import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  claimOfferedTask,
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getDbClient,
  getTaskById,
  initDb,
  releaseStaleOfferedTasksForOfflineAgents,
} from "../be/db";
import {
  createPoolAgent,
  createRuntimeController,
  createRuntimePool,
  updateRuntimePool,
} from "../be/runtime-pools/db";
import {
  isAgentOnDemand,
  isAgentReachable,
  isRuntimePoolWakeable,
} from "../be/runtime-pools/reachability";
import { codeLevelTriage, gatherSystemStatus, getBootTriageFindings } from "../heartbeat/heartbeat";
import { handleAgentsRest } from "../http/agents";
import { routeMessage } from "../slack/router";
import { resolveLeadOnlyRecoveryAssignment } from "../tasks/worker-follow-up";
import { registerGetSwarmTool } from "../tools/get-swarm";
import { sendTaskHandler } from "../tools/send-task";
import { userCtx } from "../tools/task-tool-ctx";
import type { RuntimePool } from "../types";
import { listenOnFreePort } from "./test-net";

const dbPath = "./test-runtime-pool-reachability.sqlite";
const savedFlag = process.env.RUNTIME_POOLS_ENABLED;
const savedMultiRuntime = process.env.MULTI_RUNTIME_ENABLED;
let pool: RuntimePool;
async function cleanup() {
  for (const suffix of ["", "-wal", "-shm"])
    await Bun.file(dbPath + suffix)
      .delete()
      .catch(() => {});
}
beforeAll(async () => {
  await cleanup();
  closeDb();
  initDb(dbPath);
});
afterAll(async () => {
  closeDb();
  await cleanup();
  if (savedFlag === undefined) delete process.env.RUNTIME_POOLS_ENABLED;
  else process.env.RUNTIME_POOLS_ENABLED = savedFlag;
  if (savedMultiRuntime === undefined) delete process.env.MULTI_RUNTIME_ENABLED;
  else process.env.MULTI_RUNTIME_ENABLED = savedMultiRuntime;
});
beforeEach(async () => {
  process.env.RUNTIME_POOLS_ENABLED = "true";
  process.env.MULTI_RUNTIME_ENABLED = "true";
  for (const table of [
    "active_sessions",
    "agent_tasks",
    "runtime_instances",
    "agents",
    "runtime_pools",
    "runtime_controllers",
  ])
    await getDbClient().run(`DELETE FROM ${table}`);
  const controller = await createRuntimeController({ name: "docker", kind: "docker" });
  pool = await createRuntimePool({
    name: "coders",
    kind: "docker",
    placements: [controller.id],
    image: "test-worker",
  });
});
async function sleepingLead() {
  return await createPoolAgent(pool.id, { name: "sleeping-lead", isLead: true });
}

describe("pool agent reachability", () => {
  test.each([
    "docker",
    "e2b",
  ] as const)("%s pools require capacity and an image to wake", (kind) => {
    expect(isRuntimePoolWakeable({ ...pool, kind, maxRuntimes: 0 })).toBe(false);
    expect(isRuntimePoolWakeable({ ...pool, kind, image: null, resolvedImage: null })).toBe(false);
    expect(
      isRuntimePoolWakeable({ ...pool, kind, image: null, resolvedImage: "resolved-worker" }),
    ).toBe(true);
    expect(isRuntimePoolWakeable({ ...pool, kind, maxRuntimes: null })).toBe(true);
  });
  test.each([
    "zero-capacity",
    "missing-image",
  ])("offline agents in a %s pool are unreachable", async (state) => {
    const lead = await sleepingLead();
    // The API now rejects imageless pools; raw SQL models a row saved before that check.
    if (state === "zero-capacity") await updateRuntimePool(pool.id, { maxRuntimes: 0 });
    else
      await getDbClient().run(
        "UPDATE runtime_pools SET image = NULL, resolved_image = NULL WHERE id = ?",
        [pool.id],
      );
    expect(await isAgentReachable(lead)).toBe(false);
  });
  test.each([
    "zero-capacity",
    "missing-image",
  ])("user send-task rejects a sleeping Lead in a %s pool", async (state) => {
    await sleepingLead();
    // The API now rejects imageless pools; raw SQL models a row saved before that check.
    if (state === "zero-capacity") await updateRuntimePool(pool.id, { maxRuntimes: 0 });
    else
      await getDbClient().run(
        "UPDATE runtime_pools SET image = NULL, resolved_image = NULL WHERE id = ?",
        [pool.id],
      );
    const user = await createUser({ name: "requester" });
    const result = await sendTaskHandler(userCtx(user), {
      task: "delegate",
      offerMode: false,
      allowDuplicate: false,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("No online Lead");
  });
  test.each([
    "zero-capacity",
    "missing-image",
  ])("offer reaper releases a sleeping recipient in a %s pool", async (state) => {
    const agent = await createPoolAgent(pool.id, { name: "offeree" });
    // The API now rejects imageless pools; raw SQL models a row saved before that check.
    if (state === "zero-capacity") await updateRuntimePool(pool.id, { maxRuntimes: 0 });
    else
      await getDbClient().run(
        "UPDATE runtime_pools SET image = NULL, resolved_image = NULL WHERE id = ?",
        [pool.id],
      );
    const task = await createTaskExtended("offer", { offeredTo: agent.id });
    expect(await releaseStaleOfferedTasksForOfflineAgents(isAgentReachable)).toBe(1);
    expect((await getTaskById(task.id))?.status).toBe("unassigned");
    expect((await getTaskById(task.id))?.offeredTo).toBeUndefined();
  });
  test.each([
    "flag-off",
    "disabled",
    "circuit",
    "static",
    "deleted",
  ])("offer reaper retains legacy release behavior for %s recipients", async (state) => {
    const agent = await createPoolAgent(pool.id, { name: "offeree" });
    const task = await createTaskExtended("offer", { offeredTo: agent.id });
    if (state === "flag-off") process.env.RUNTIME_POOLS_ENABLED = "false";
    if (state === "disabled") await updateRuntimePool(pool.id, { enabled: false });
    if (state === "circuit")
      await getDbClient().run("UPDATE runtime_pools SET circuit_open_until = ? WHERE id = ?", [
        new Date(Date.now() + 60000).toISOString(),
        pool.id,
      ]);
    if (state === "static")
      await getDbClient().run("UPDATE runtime_pools SET kind = 'static' WHERE id = ?", [pool.id]);
    if (state === "deleted") await getDbClient().run("DELETE FROM agents WHERE id = ?", [agent.id]);
    expect(await releaseStaleOfferedTasksForOfflineAgents(isAgentReachable)).toBe(1);
    const released = await getTaskById(task.id);
    expect(released?.status).toBe("unassigned");
    expect(released?.offeredTo).toBeUndefined();
    expect(released?.offeredAt).toBeUndefined();
  });
  test("offer reaper preserves a concurrent offer claim", async () => {
    const agent = await createPoolAgent(pool.id, { name: "offeree" });
    await updateRuntimePool(pool.id, { enabled: false });
    const task = await createTaskExtended("offer", { offeredTo: agent.id });
    expect(
      await releaseStaleOfferedTasksForOfflineAgents(async (recipient) => {
        await claimOfferedTask(task.id, recipient.id);
        return await isAgentReachable(recipient);
      }),
    ).toBe(0);
    expect(await getTaskById(task.id)).toMatchObject({ status: "reviewing", offeredTo: agent.id });
  });
  test.each([
    "sleeping",
    "provisioning",
  ])("heartbeat preserves offers to %s pool agents", async (state) => {
    const agent = await createPoolAgent(pool.id, { name: "offeree" });
    if (state === "provisioning") {
      await getDbClient().run(
        "INSERT INTO runtime_instances (id, agent_id, pool_id, status, reported_slots) VALUES (?, ?, ?, 'provisioning', 1)",
        [crypto.randomUUID(), agent.id, pool.id],
      );
      await getDbClient().run("UPDATE runtime_pools SET circuit_open_until = ? WHERE id = ?", [
        new Date(Date.now() + 60000).toISOString(),
        pool.id,
      ]);
    }
    const task = await createTaskExtended("offered work", { offeredTo: agent.id });
    const findings = await codeLevelTriage();
    expect(findings.staleCleanup.staleOfferedTasks).toBe(0);
    expect(await getTaskById(task.id)).toMatchObject({
      status: "offered",
      offeredTo: agent.id,
      offeredAt: task.offeredAt,
    });
    expect(await isAgentReachable(agent)).toBe(true);
  });
  test("online agents remain reachable and unbound offline agents remain unreachable", async () => {
    const agent = await createAgent({ name: "online", status: "idle", isLead: false });
    expect(await isAgentReachable(agent)).toBe(true);
    expect(await isAgentReachable({ ...agent, status: "offline" })).toBe(false);
  });
  test.each([
    "enabled",
    "disabled",
    "open",
    "expired",
    "static",
    "flag-off",
  ])("sleeping agent uses %s pool state", async (state) => {
    const agent = await sleepingLead();
    if (state === "disabled") await updateRuntimePool(pool.id, { enabled: false });
    if (state === "open" || state === "expired")
      await getDbClient().run("UPDATE runtime_pools SET circuit_open_until = ?", [
        new Date(Date.now() + (state === "open" ? 60000 : -60000)).toISOString(),
      ]);
    if (state === "static") await getDbClient().run("UPDATE runtime_pools SET kind = 'static'");
    if (state === "flag-off") process.env.RUNTIME_POOLS_ENABLED = "false";
    expect(await isAgentReachable(agent)).toBe(state === "enabled" || state === "expired");
  });
  test.each([true, false])("user send-task with runtime pools enabled=%s", async (enabled) => {
    process.env.RUNTIME_POOLS_ENABLED = String(enabled);
    const lead = await sleepingLead();
    const user = await createUser({ name: "requester" });
    const result = await sendTaskHandler(userCtx(user), {
      task: "delegate this work",
      offerMode: false,
      allowDuplicate: false,
    });
    expect(result.ok).toBe(enabled);
    if (enabled) {
      const task = (result.data as { task: { id: string } }).task;
      expect(await getTaskById(task.id)).toMatchObject({ status: "pending", agentId: lead.id });
    } else expect(result.message).toContain("No online Lead");
  });
  test.each([true, false])("Slack follow-up with runtime pools enabled=%s", async (enabled) => {
    process.env.RUNTIME_POOLS_ENABLED = String(enabled);
    const lead = await createAgent({ name: "online-lead", isLead: true, status: "idle" });
    const worker = await createPoolAgent(pool.id, { name: "sleeping-worker" });
    await createTaskExtended("thread work", {
      agentId: worker.id,
      source: "slack",
      slackChannelId: "C_REACHABILITY",
      slackThreadTs: "1234.5678",
    });
    const matches = await routeMessage("continue", "BOT", false, {
      channelId: "C_REACHABILITY",
      threadTs: "1234.5678",
    });
    expect(matches.map((match) => match.agent.id)).toEqual([enabled ? worker.id : lead.id]);
  });
  test("Slack fallback and explicit mention can reach a sleeping lead", async () => {
    const lead = await sleepingLead();
    const worker = await createAgent({ name: "gone", isLead: false, status: "offline" });
    await createTaskExtended("thread work", {
      agentId: worker.id,
      source: "slack",
      slackChannelId: "C_REACHABILITY",
      slackThreadTs: "1234.5678",
    });
    expect(
      (
        await routeMessage("continue", "BOT", false, {
          channelId: "C_REACHABILITY",
          threadTs: "1234.5678",
        })
      )[0]?.agent.id,
    ).toBe(lead.id);
    expect((await routeMessage("<@BOT> help", "BOT", true))[0]?.agent.id).toBe(lead.id);
  });
  test.each([true, false])("Lead-only recovery with runtime pools enabled=%s", async (enabled) => {
    process.env.RUNTIME_POOLS_ENABLED = String(enabled);
    const lead = await sleepingLead();
    const result = await resolveLeadOnlyRecoveryAssignment(
      { routingAffinity: { leadOnly: true, capabilities: [] } },
      null,
    );
    expect(result).toEqual(
      enabled
        ? { agentId: lead.id, decision: "rerouted_to_lead" }
        : { decision: "escalated_unassigned" },
    );
  });
  test.each([
    true,
    false,
  ])("stale resume escalation with runtime pools enabled=%s", async (enabled) => {
    process.env.RUNTIME_POOLS_ENABLED = String(enabled);
    const lead = await sleepingLead();
    const worker = await createAgent({ name: "gone", isLead: false, status: "offline" });
    const original = await createTaskExtended("original", { agentId: worker.id });
    await getDbClient().run(
      "UPDATE agent_tasks SET status = 'superseded', finishedAt = ? WHERE id = ?",
      [new Date().toISOString(), original.id],
    );
    const resume = await createTaskExtended("resume", {
      agentId: worker.id,
      parentTaskId: original.id,
      taskType: "resume",
      tags: ["crash-recovery-pin", "resume-generation:1"],
    });
    await getDbClient().run("UPDATE agent_tasks SET createdAt = ? WHERE id = ?", [
      new Date(Date.now() - 3600000).toISOString(),
      resume.id,
    ]);
    await codeLevelTriage();
    expect((await getTaskById(resume.id))?.status).toBe(enabled ? "cancelled" : "pending");
    const decisions = await getDbClient().query<{ agentId: string }>(
      "SELECT agentId FROM agent_tasks WHERE taskType = 'reroute-decision'",
    );
    expect(decisions).toEqual(enabled ? [{ agentId: lead.id }] : []);
  });
  test.each([
    true,
    false,
  ])("boot triage excludes reachable pool tasks with flag=%s", async (enabled) => {
    process.env.RUNTIME_POOLS_ENABLED = String(enabled);
    const worker = await createPoolAgent(pool.id, { name: "sleeping-worker" });
    await createTaskExtended("wake demand", { agentId: worker.id });
    await createTaskExtended("offered demand", { offeredTo: worker.id });
    expect((await getBootTriageFindings()).orphaned).toBe(enabled ? 0 : 2);
    expect((await gatherSystemStatus({ isBootTriage: true })).includes("Orphaned Tasks")).toBe(
      !enabled,
    );
  });
  test.each([
    true,
    false,
  ])("get-swarm marks wakeable pool agents as on demand with pool enabled=%s", async (enabled) => {
    const lead = await createAgent({ name: "online-lead", isLead: true, status: "idle" });
    const worker = await createPoolAgent(pool.id, { name: "sleeping-worker" });
    const gone = await createAgent({ name: "gone", isLead: false, status: "offline" });
    if (!enabled) await updateRuntimePool(pool.id, { enabled: false });
    const mcp = new McpServer({ name: "get-swarm-on-demand", version: "1.0.0" });
    registerGetSwarmTool(mcp);
    const tool = (
      mcp as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: unknown, extra: unknown) => Promise<CallToolResult> }
        >;
      }
    )._registeredTools["get-swarm"];
    const result = await tool!.handler(
      {},
      { sessionId: "test-session", requestInfo: { headers: { "x-agent-id": lead.id } } },
    );
    const agents = (result.structuredContent as { agents: { id: string; onDemand?: boolean }[] })
      .agents;
    const onDemand = (id: string) => agents.find((a) => a.id === id)?.onDemand;
    expect(onDemand(worker.id)).toBe(enabled ? true : undefined);
    expect(onDemand(gone.id)).toBeUndefined();
    expect(onDemand(lead.id)).toBeUndefined();
    const text = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    expect(text.includes("sleeping-worker (offline, on demand: send-task starts it)")).toBe(
      enabled,
    );
    expect(text).toContain("gone (offline)");
  });
  test.each([
    ["the pool is enabled with capacity", null, true],
    ["MULTI_RUNTIME_ENABLED is off", "multi-runtime-off", false],
    ["the pool is at maxRuntimes", "pool-full", false],
    ["maxTasks is below slotsPerRuntime", "slots-too-big", false],
  ] as const)("on demand when %s: %p", async (_label, state, expected) => {
    const worker = await createPoolAgent(pool.id, { name: "sleeping-worker", maxTasks: 2 });
    if (state === "multi-runtime-off") process.env.MULTI_RUNTIME_ENABLED = "false";
    if (state === "pool-full") {
      await updateRuntimePool(pool.id, { maxRuntimes: 1 });
      const other = await createPoolAgent(pool.id, { name: "busy-worker" });
      await getDbClient().run(
        "INSERT INTO runtime_instances (id, agent_id, pool_id, status, reported_slots) VALUES (?, ?, ?, 'provisioning', 1)",
        [crypto.randomUUID(), other.id, pool.id],
      );
    }
    if (state === "slots-too-big") await updateRuntimePool(pool.id, { slotsPerRuntime: 4 });
    expect(await isAgentOnDemand(worker)).toBe(expected);
    // The heartbeat/routing predicate keeps its broader answer.
    expect(await isAgentReachable(worker)).toBe(true);
  });
  test("a pool under maxRuntimes is on demand", async () => {
    await updateRuntimePool(pool.id, { maxRuntimes: 2 });
    const worker = await createPoolAgent(pool.id, { name: "sleeping-worker" });
    await getDbClient().run(
      "INSERT INTO runtime_instances (id, agent_id, pool_id, status, reported_slots) VALUES (?, ?, ?, 'provisioning', 1)",
      [crypto.randomUUID(), worker.id, pool.id],
    );
    expect(await isAgentOnDemand(worker)).toBe(true);
  });
  async function addRuntime(agentId: string, status: "provisioning" | "active", draining = 0) {
    await getDbClient().run(
      "INSERT INTO runtime_instances (id, agent_id, pool_id, status, reported_slots, draining) VALUES (?, ?, ?, ?, 1, ?)",
      [crypto.randomUUID(), agentId, pool.id, status, draining],
    );
  }
  test.each([
    ["an uncapped pool", null],
    ["a pool its runtime fills", 1],
  ] as const)("a booting runtime keeps the agent on demand in %s", async (_label, maxRuntimes) => {
    await updateRuntimePool(pool.id, { maxRuntimes, slotsPerRuntime: 1 });
    const worker = await createPoolAgent(pool.id, { name: "booting-worker", maxTasks: 1 });
    await addRuntime(worker.id, "provisioning");
    expect(await isAgentOnDemand(worker)).toBe(true);
  });
  test.each([
    ["an uncapped pool", null],
    ["a capped pool", 5],
  ] as const)("an agent at its own runtime limit is not on demand in %s", async (_label, maxRuntimes) => {
    await updateRuntimePool(pool.id, { maxRuntimes, slotsPerRuntime: 1 });
    const worker = await createPoolAgent(pool.id, { name: "capped-worker", maxTasks: 1 });
    await addRuntime(worker.id, "active");
    expect(await isAgentOnDemand(worker)).toBe(false);
  });
  test("a draining provisioning runtime does not count as booting", async () => {
    await updateRuntimePool(pool.id, { maxRuntimes: null, slotsPerRuntime: 1 });
    const worker = await createPoolAgent(pool.id, { name: "draining-worker", maxTasks: 1 });
    await addRuntime(worker.id, "provisioning", 1);
    expect(await isAgentOnDemand(worker)).toBe(false);
  });
  test("GET /api/agents and /api/agents/{id} flag on-demand pool agents", async () => {
    const worker = await createPoolAgent(pool.id, { name: "sleeping-worker" });
    const gone = await createAgent({ name: "gone", isLead: false, status: "offline" });
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const segments = url.pathname.split("/").filter(Boolean);
      void handleAgentsRest(req, res, segments, url.searchParams, undefined).then((handled) => {
        if (!handled) res.writeHead(404).end("{}");
      });
    });
    const base = `http://localhost:${await listenOnFreePort(server)}`;
    try {
      const list = (await (await fetch(`${base}/api/agents`)).json()) as {
        agents: { id: string; onDemand?: boolean }[];
      };
      expect(list.agents.find((a) => a.id === worker.id)?.onDemand).toBe(true);
      expect(list.agents.find((a) => a.id === gone.id)?.onDemand).toBeUndefined();
      const one = (await (await fetch(`${base}/api/agents/${worker.id}`)).json()) as {
        onDemand?: boolean;
      };
      expect(one.onDemand).toBe(true);
      process.env.MULTI_RUNTIME_ENABLED = "false";
      const off = (await (await fetch(`${base}/api/agents/${worker.id}`)).json()) as {
        onDemand?: boolean;
      };
      expect(off.onDemand).toBeUndefined();
    } finally {
      server.close();
    }
  });
});
