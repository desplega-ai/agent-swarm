import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type AgentsRepository, type NewAgent, type Storage, sql } from "../../src";
import type { ContractEngine } from "./env";

const T0 = "2026-11-21T10:00:00.000Z";
const T1 = "2026-11-21T11:00:00.000Z";
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function newAgent(overrides: Partial<NewAgent> = {}): NewAgent {
  const id = overrides.id ?? crypto.randomUUID();
  return {
    id,
    name: `agent-${id.slice(0, 8)}`,
    isLead: false,
    status: "idle",
    maxTasks: 1,
    provider: null,
    harnessProvider: null,
    ...overrides,
  };
}

export function agentsContract(engine: ContractEngine): void {
  describe(`agents repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: AgentsRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.agents;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    test("insertAgent returns the stored value shape", async () => {
      const row = await repo.insertAgent(
        newAgent({ id: "a1", name: "alpha", isLead: true, maxTasks: 3, harnessProvider: "codex" }),
      );
      expect(row).toMatchObject({
        id: "a1",
        name: "alpha",
        isLead: 1,
        status: "idle",
        maxTasks: 3,
        emptyPollCount: 0,
        capabilities: "[]",
        provider: null,
        harness_provider: "codex",
        credentialMissing: null,
        cred_status: null,
        avatar: null,
        runtime_provision_attempts: 0,
      });
      expect(row?.createdAt).toMatch(ISO_MS);
      expect(row?.lastUpdatedAt).toBe(row?.createdAt as string);
      expect(await repo.findAgentById("a1")).toEqual(row);
      expect(await repo.findAgentSnapshot("a1")).toEqual(row as unknown as Record<string, unknown>);
      expect(await repo.findAgentById("missing")).toBeNull();
    });

    test("listings order by name in byte order, ties in insertion order", async () => {
      await repo.insertAgent(newAgent({ id: "3", name: "b", harnessProvider: "claude" }));
      await repo.insertAgent(newAgent({ id: "1", name: "b", harnessProvider: "claude" }));
      await repo.insertAgent(newAgent({ id: "2", name: "B" }));
      await repo.insertAgent(newAgent({ id: "4", name: "a", harnessProvider: "codex" }));
      await repo.insertAgent(newAgent({ id: "x", name: "0ext" }));
      await repo.updateAgentProfile("x", {
        name: null,
        description: null,
        role: "extension",
        capabilities: null,
        claudeMd: null,
        soulMd: null,
        identityMd: null,
        setupScript: null,
        toolsMd: null,
        heartbeatMd: null,
        avatar: { set: false, value: null },
        slackIcon: { set: false, value: null },
        now: T0,
      });
      expect((await repo.listAgents({ includeExtensions: false })).map((r) => r.id)).toEqual([
        "2",
        "4",
        "3",
        "1",
      ]);
      expect((await repo.listAgents({ includeExtensions: true })).map((r) => r.id)).toEqual([
        "x",
        "2",
        "4",
        "3",
        "1",
      ]);
      expect((await repo.listAgentsByHarnessProvider("claude")).map((r) => r.id)).toEqual([
        "3",
        "1",
      ]);
      expect(await repo.countAgentsByHarnessProvider()).toEqual([
        { provider: "claude", count: 2 },
        { provider: "codex", count: 1 },
      ]);
      await repo.setAgentColumns("4", { status: "busy" });
      expect(await repo.countAgentsByStatus()).toEqual([
        { status: "busy", count: 1 },
        { status: "idle", count: 3 },
      ]);
      expect(["3", "1"]).toContain((await repo.findAgentIdByName("b")) as string);
      expect(await repo.findAgentIdByName("b", "3")).toBe("1");
      expect(await repo.findAgentIdByName("zz")).toBeNull();
      expect((await repo.findAgentByNameExcept("a", "x"))?.id).toBe("4");
      expect(await repo.findAgentByNameExcept("a", "4")).toBeNull();
    });

    test("setAgentColumns, profile COALESCE and explicit avatar reset", async () => {
      await repo.insertAgent(newAgent({ id: "a1", name: "alpha" }));
      const set = await repo.setAgentColumns("a1", {
        status: "waiting_for_credentials",
        credentialMissing: '["X"]',
        maxTasks: 4,
      });
      expect(set).toMatchObject({
        status: "waiting_for_credentials",
        credentialMissing: '["X"]',
        maxTasks: 4,
      });
      expect(set?.lastUpdatedAt).toMatch(ISO_MS);
      expect(await repo.setAgentColumns("missing", { status: "idle" })).toBeNull();

      const base = {
        name: null,
        description: null,
        role: null,
        capabilities: null,
        claudeMd: null,
        soulMd: null,
        identityMd: null,
        setupScript: null,
        toolsMd: null,
        heartbeatMd: null,
        avatar: { set: false, value: null },
        slackIcon: { set: false, value: null },
        now: T1,
      };
      const withAvatar = await repo.updateAgentProfile("a1", {
        ...base,
        description: "d",
        claudeMd: "c",
        avatar: { set: true, value: '{"kind":"x"}' },
      });
      expect(withAvatar).toMatchObject({
        name: "alpha",
        description: "d",
        claudeMd: "c",
        avatar: '{"kind":"x"}',
        slack_icon: null,
        lastUpdatedAt: T1,
      });
      const kept = await repo.updateAgentProfile("a1", { ...base, name: "beta" });
      expect(kept).toMatchObject({ name: "beta", description: "d", avatar: '{"kind":"x"}' });
      const reset = await repo.updateAgentProfile("a1", {
        ...base,
        avatar: { set: true, value: null },
      });
      expect(reset).toMatchObject({ avatar: null, claudeMd: "c" });
    });

    test("poll counter, activity and delete", async () => {
      await repo.insertAgent(newAgent({ id: "a1" }));
      expect(await repo.incrementEmptyPollCount("a1")).toBe(1);
      expect(await repo.incrementEmptyPollCount("a1")).toBe(2);
      expect(await repo.incrementEmptyPollCount("missing")).toBeNull();
      await repo.resetEmptyPollCount("a1");
      await repo.touchAgentActivity("a1");
      const row = await repo.findAgentById("a1");
      expect(row?.emptyPollCount).toBe(0);
      expect(row?.lastActivityAt).toMatch(ISO_MS);
      expect(await repo.deleteAgent("a1")).toBe(1);
      expect(await repo.deleteAgent("a1")).toBe(0);
    });

    test("snapshot columns round trip through insertAgentSnapshot", async () => {
      await repo.insertAgent(newAgent({ id: "a1", name: "alpha" }));
      const snapshot = (await repo.findAgentSnapshot("a1")) as Record<
        string,
        string | number | null
      >;
      const columns = (await repo.listAgentColumns()).filter((c) => c in snapshot);
      expect(columns.slice(0, 3)).toEqual(["id", "name", "isLead"]);
      await repo.deleteAgent("a1");
      await repo.insertAgentSnapshot(
        columns,
        columns.map((c) => snapshot[c] ?? null),
      );
      expect(await repo.findAgentSnapshot("a1")).toEqual(snapshot);
    });

    test("delete blockers count other tables", async () => {
      await repo.insertAgent(newAgent({ id: "a1" }));
      expect(await repo.countDeleteBlockers("a1", ["completed", "failed"])).toEqual({
        open_tasks: 0,
        schedules: 0,
        owned_skills: 0,
        owned_mcp_servers: 0,
        inboxes: 0,
      });
    });

    test("history: newest first, ties later insert first", async () => {
      const add = (id: string, agentId: string, createdAt: string) =>
        repo.insertHistory({
          id,
          agent_id: agentId,
          event: id.endsWith("r") ? "restored" : "deleted",
          actor_ref: "op:1",
          reason: "because",
          snapshot_json: "{}",
          created_at: createdAt,
        });
      expect(await add("h1", "a1", T0)).toMatchObject({ id: "h1", event: "deleted" });
      await add("h2r", "a1", T1);
      await add("h3", "a1", T1);
      await add("h4", "a2", T0);
      expect((await repo.latestHistory("a1"))?.id).toBe("h3");
      expect(await repo.latestHistory("zz")).toBeNull();
      expect((await repo.listHistory("a1", 10)).map((r) => r.id)).toEqual(["h3", "h2r", "h1"]);
      expect((await repo.listHistory(undefined, 3)).map((r) => r.id)).toEqual(["h3", "h2r", "h4"]);
    });

    test("context versions: latest, history orders with ties", async () => {
      await repo.insertAgent(newAgent({ id: "a1" }));
      const add = (id: string, field: string, version: number, createdAt: string) =>
        repo.insertContextVersion({
          id,
          agentId: "a1",
          field,
          content: id,
          version,
          changeSource: "api",
          changedByAgentId: null,
          changeReason: null,
          contentHash: id,
          previousVersionId: null,
          createdAt,
        });
      expect(await add("v1", "claudeMd", 1, T0)).toMatchObject({ id: "v1", version: 1 });
      await add("v2", "claudeMd", 2, T1);
      await add("v2b", "claudeMd", 2, T1);
      await add("s1", "soulMd", 1, T1);
      expect((await repo.latestContextVersion("a1", "claudeMd"))?.id).toBe("v2");
      expect(await repo.latestContextVersion("a1", "toolsMd")).toBeNull();
      expect((await repo.findContextVersion("s1"))?.field).toBe("soulMd");
      expect((await repo.listContextVersions("a1", "claudeMd", 10)).map((r) => r.id)).toEqual([
        "v2",
        "v2b",
        "v1",
      ]);
      expect((await repo.listContextVersions("a1", undefined, 3)).map((r) => r.id)).toEqual([
        "v2",
        "v2b",
        "s1",
      ]);
    });

    test("active sessions: insert, heartbeat guard, deletes", async () => {
      await repo.insertAgent(newAgent({ id: "a1" }));
      const row = await repo.insertActiveSession({
        id: "s1",
        agentId: "a1",
        taskId: "t1",
        triggerType: "task_assigned",
        inboxMessageId: null,
        taskDescription: "d",
        runnerSessionId: null,
        runtimeInstanceId: "r1",
        now: T0,
      });
      expect(row).toEqual({
        id: "s1",
        agentId: "a1",
        taskId: "t1",
        triggerType: "task_assigned",
        inboxMessageId: null,
        taskDescription: "d",
        runnerSessionId: null,
        providerSessionId: null,
        runtimeInstanceId: "r1",
        startedAt: T0,
        lastHeartbeatAt: T0,
      });
      expect(await repo.findActiveSessionById("s1")).toEqual(row);
      expect(await repo.heartbeatActiveSession("t1", T1, T0)).toBe(0);
      expect(await repo.heartbeatActiveSession("t1", T1, T1)).toBe(1);
      expect(await repo.heartbeatActiveSession("t1", T1)).toBe(1);
      expect(await repo.setActiveSessionProviderSessionId("t1", "p1")).toBe(1);
      expect(await repo.findActiveSessionByTask("t1")).toMatchObject({
        lastHeartbeatAt: T1,
        providerSessionId: "p1",
      });
      expect(await repo.deleteActiveSessionsBefore(T1)).toBe(0);
      expect(await repo.deleteActiveSessionByTask("t1")).toBe(1);
      for (const id of ["s2", "s3"]) {
        await repo.insertActiveSession({
          id,
          agentId: "a1",
          taskId: null,
          triggerType: "pool",
          inboxMessageId: null,
          taskDescription: null,
          runnerSessionId: null,
          runtimeInstanceId: null,
          now: T0,
        });
      }
      expect(await repo.deleteActiveSessionById("s2")).toBe(1);
      expect(await repo.deleteActiveSessionsByAgent("a1")).toBe(1);
    });

    test("capacity counts in-progress tasks and reviewed offers; daily counts by UTC day", async () => {
      await repo.insertAgent(newAgent({ id: "a1" }));
      const task = (
        id: string,
        status: string,
        createdAt: string,
        agentId: string | null,
        offeredTo: string | null,
      ) =>
        storage.executor.run(sql`
          INSERT INTO agent_tasks (id, task, status, "createdAt", "lastUpdatedAt", "agentId", "offeredTo")
          VALUES (${id}, 't', ${status}, ${createdAt}, ${createdAt}, ${agentId}, ${offeredTo})`);
      await task("t1", "in_progress", "2026-11-19T23:59:59.999Z", "a1", null);
      await task("t2", "reviewing", "2026-11-20T00:00:00.000Z", null, "a1");
      await task("t3", "reviewing", "2026-11-20T10:00:00.000Z", "a1", null);
      await task("t4", "completed", "2026-11-21T10:00:00.000Z", "a1", null);
      await task("t5", "in_progress", "2026-11-21T11:00:00.000Z", null, null);
      expect(await repo.countActiveTasks("a1")).toBe(2);
      expect(await repo.countActiveTasks("nobody")).toBe(0);
      expect(await repo.dailyTaskCounts("a1", "2026-11-20")).toEqual([
        { date: "2026-11-20", count: 1 },
        { date: "2026-11-21", count: 1 },
      ]);
      expect(await repo.dailyTaskCounts("a1", "2026-11-01")).toEqual([
        { date: "2026-11-19", count: 1 },
        { date: "2026-11-20", count: 1 },
        { date: "2026-11-21", count: 1 },
      ]);
    });

    test("worker-reported model columns write only on change (NULL-safe)", async () => {
      await repo.insertAgent(newAgent({ id: "m1" }));
      expect(await repo.getModelTierOverrides("m1")).toBeNull();
      expect(await repo.modelTierOverridesDiffer("m1", null)).toBe(false);
      expect(await repo.modelTierOverridesDiffer("m1", '{"smol":"x"}')).toBe(true);
      expect(await repo.modelTierOverridesDiffer("missing", '{"smol":"x"}')).toBe(false);
      await repo.setModelTierOverrides("m1", '{"smol":"x"}');
      expect(await repo.getModelTierOverrides("m1")).toBe('{"smol":"x"}');
      expect(await repo.modelTierOverridesDiffer("m1", '{"smol":"x"}')).toBe(false);
      await repo.setModelTierOverrides("m1", null);
      expect(await repo.getModelTierOverrides("m1")).toBeNull();
      expect(await repo.getModelTierOverrides("missing")).toBeNull();

      expect(await repo.getHarnessCliVersion("m1")).toBeNull();
      await repo.setHarnessCliVersion("m1", "1.2.3");
      expect(await repo.getHarnessCliVersion("m1")).toBe("1.2.3");
      await repo.setHarnessCliVersion("m1", null);
      expect(await repo.getHarnessCliVersion("m1")).toBeNull();
    });

    test("non-extension agents by name and skill install if absent", async () => {
      await repo.insertAgent(newAgent({ id: "n1", name: "nina" }));
      await repo.insertAgent(newAgent({ id: "x1", name: "xt" }));
      await storage.executor.run(sql`UPDATE agents SET role = 'extension' WHERE id = 'x1'`);
      expect(await repo.listNonExtensionAgentIdsByName("nina", 2)).toEqual(["n1"]);
      expect(await repo.listNonExtensionAgentIdsByName("xt", 2)).toEqual([]);
      expect(await repo.listNonExtensionAgentIdsByName(null, 2)).toEqual([]);

      await storage.executor.run(sql`
        INSERT INTO skills (id, name, description, content, type, scope, "createdAt", "lastUpdatedAt")
        VALUES ('sk1', 'sk', 'd', 'c', 'personal', 'swarm', ${T0}, ${T0})`);
      expect(await repo.installSkillIfAbsent("i1", "n1", "sk1", T0)).toBe(true);
      await repo.setSkillActive("n1", "sk1", false);
      // A present row stays as it is (inactive).
      expect(await repo.installSkillIfAbsent("i2", "n1", "sk1", T1)).toBe(false);
      const row = await storage.executor.get<{ id: string; isActive: number }>(
        sql`SELECT id, "isActive" FROM agent_skills WHERE "agentId" = 'n1'`,
      );
      expect(row).toEqual({ id: "i1", isActive: 0 });
    });

    test("countActiveMcpServerInstalls counts active installs per server", async () => {
      for (const id of ["s1", "s2", "s3"]) {
        await storage.executor.run(sql`
          INSERT INTO mcp_servers (id, name, scope, transport, "createdAt", "lastUpdatedAt")
          VALUES (${id}, ${id}, 'global', 'http', ${T0}, ${T0})`);
      }
      await repo.insertAgent(newAgent({ id: "ma" }));
      await repo.insertAgent(newAgent({ id: "mb" }));
      await repo.installMcpServer("i1", "ma", "s2", T0);
      await repo.installMcpServer("i2", "mb", "s2", T0);
      await repo.installMcpServer("i3", "ma", "s1", T0);
      await repo.installMcpServer("i4", "ma", "s3", T0);
      await storage.executor.run(
        sql`UPDATE agent_mcp_servers SET "isActive" = ${false} WHERE "mcpServerId" = 's3'`,
      );
      expect(await repo.countActiveMcpServerInstalls()).toEqual([
        { mcpServerId: "s1", installs: 1 },
        { mcpServerId: "s2", installs: 2 },
      ]);
    });

    test("listAgentNames returns every name in insertion order", async () => {
      await repo.insertAgent(newAgent({ id: "n2", name: "zed" }));
      await repo.insertAgent(newAgent({ id: "n1", name: "amy" }));
      expect(await repo.listAgentNames()).toEqual(["zed", "amy"]);
    });

    test("firstAgentCreatedAt returns the earliest createdAt", async () => {
      expect(await repo.firstAgentCreatedAt()).toBeNull();
      await repo.insertAgent(newAgent({ id: "f1" }));
      await repo.insertAgent(newAgent({ id: "f2" }));
      await storage.executor.run(sql`UPDATE agents SET "createdAt" = ${T1} WHERE id = 'f1'`);
      await storage.executor.run(
        sql`UPDATE agents SET "createdAt" = ${"2000-01-01T00:00:00.000Z"} WHERE id = 'f2'`,
      );
      expect(await repo.firstAgentCreatedAt()).toBe("2000-01-01T00:00:00.000Z");
    });

    test("steering fields by ids and the total agent count", async () => {
      expect(await repo.listSteeringFieldsByIds([])).toEqual([]);
      await repo.insertAgent(newAgent({ id: "s2", isLead: true, harnessProvider: "codex" }));
      await repo.insertAgent(newAgent({ id: "s1" }));
      await repo.insertAgent(newAgent({ id: "s3" }));
      expect(await repo.listSteeringFieldsByIds(["s2", "s1", "nope"])).toEqual([
        { id: "s1", isLead: 0, provider: null, harness_provider: null },
        { id: "s2", isLead: 1, provider: null, harness_provider: "codex" },
      ]);
      expect(await repo.countAllAgents()).toBe(3);
    });

    test("countNonExtensionAgents skips extension identities", async () => {
      await repo.insertAgent(newAgent({ id: "c1" }));
      await repo.insertAgent(newAgent({ id: "c2" }));
      await storage.executor.run(sql`UPDATE agents SET role = 'extension' WHERE id = 'c2'`);
      expect(await repo.countNonExtensionAgents()).toBe(1);
      expect(await repo.countAllAgents()).toBe(2);
    });

    test("agent log feeds, active sessions, live and ready agent counts", async () => {
      const agent = (id: string, isLead: boolean, status: string, lastActivityAt: string | null) =>
        storage.executor.run(sql`
          INSERT INTO agents (id, name, "isLead", status, "lastActivityAt", "createdAt", "lastUpdatedAt")
          VALUES (${id}, ${id}, ${isLead}, ${status}, ${lastActivityAt}, '2026-11-21T10:00:00.000Z', '2026-11-21T10:00:00.000Z')`);
      const now = new Date().toISOString();
      await agent("lead", true, "idle", now);
      await agent("w1", false, "idle", now);
      await agent("w2", false, "busy", "2020-01-01T00:00:00.000Z");
      await agent("w3", false, "offline", now);
      expect(await repo.countLiveAgents(5)).toEqual({ leads_alive: 1, workers_alive: 1 });
      expect(await repo.countReadyAgents()).toEqual({ leads: 1, workers: 2 });
      expect((await repo.listIdleWorkers()).map((a) => a.id)).toEqual(["w1"]);
      const log = (id: string, eventType: string, agentId: string) =>
        storage.executor.run(sql`
          INSERT INTO agent_log (id, "eventType", "agentId", "createdAt")
          VALUES (${id}, ${eventType}, ${agentId}, '2026-11-21T10:00:00.000Z')`);
      await log("l1", "task_created", "w1");
      await log("l2", "agent_status_change", "w1");
      await log("l3", "task_created", "w2");
      expect((await repo.listLogsByAgent("w1")).map((l) => l.id)).toEqual(["l2", "l1"]);
      expect((await repo.listLogsByAgent("w1", { userId: null })).map((l) => l.id)).toEqual([
        "l2",
        "l1",
      ]);
      expect((await repo.listAllLogs(10)).map((l) => l.id)).toEqual(["l3", "l1"]);
      expect((await repo.listAllLogs(undefined)).map((l) => l.id)).toEqual(["l3", "l2", "l1"]);
      const before = await repo.countActiveSessions();
      for (const id of ["s1", "s2"]) {
        await storage.executor.run(sql`
          INSERT INTO active_sessions (id, "agentId", "triggerType", "startedAt", "lastHeartbeatAt")
          VALUES (${id}, 'w1', 'poll', '2026-11-21T10:00:00.000Z', '2026-11-21T10:00:00.000Z')`);
      }
      expect(await repo.countActiveSessions()).toBe(before + 2);
      expect((await repo.listActiveSessions("w1")).map((s) => s.id)).toEqual(["s2", "s1"]);
      expect((await repo.listActiveSessions(undefined, { userId: null })).map((s) => s.id)).toEqual(
        ["s2", "s1"],
      );
    });

    test("task log lookups: event exists, latest entry, metadata, queue pickups", async () => {
      const log = (id: string, taskId: string, eventType: string, createdAt: string, extra = {}) =>
        storage.executor.run(sql`
          INSERT INTO agent_log (id, "eventType", "taskId", "oldValue", "newValue", metadata, "createdAt")
          VALUES (${id}, ${eventType}, ${taskId}, ${(extra as { oldValue?: string }).oldValue ?? null},
            ${(extra as { newValue?: string }).newValue ?? null}, ${'{"a":1}'}, ${createdAt})`);
      expect(await repo.hasTaskLogEvent("t1", "task_superseded")).toBe(false);
      await log("l1", "t1", "task_superseded", T0);
      await log("l2", "t1", "task_superseded", T1);
      await log("l3", "t2", "task_superseded", T1);
      expect(await repo.hasTaskLogEvent("t1", "task_superseded")).toBe(true);
      expect(await repo.hasTaskLogEvent("t1", "other")).toBe(false);
      expect(await repo.findLatestTaskLog("t1", "task_superseded")).toEqual({
        id: "l2",
        metadata: '{"a":1}',
      });
      expect(await repo.findLatestTaskLog("t9", "task_superseded")).toBeNull();
      expect(await repo.setLogMetadata("l2", '{"b":2}')).toBe(1);
      expect(await repo.setLogMetadata("missing", "{}")).toBe(0);
      expect(await repo.findLatestTaskLog("t1", "task_superseded")).toEqual({
        id: "l2",
        metadata: '{"b":2}',
      });
      const pick = { oldValue: "pending", newValue: "in_progress" };
      await log("p1", "t1", "task_status_change", T1, pick);
      await log("p2", "t1", "task_claimed", T1, {
        oldValue: "unassigned",
        newValue: "in_progress",
      });
      await log("p3", "t1", "task_claimed", T0, pick);
      await log("p4", "t1", "task_status_change", T1, {
        oldValue: "paused",
        newValue: "in_progress",
      });
      await log("p5", "t1", "task_created", T1, pick);
      expect(await repo.countRecentQueuePickups(T1)).toBe(2);
      expect(await repo.countRecentQueuePickups(T0)).toBe(3);
    });
  });
}
