import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NewSkillInvocation, SkillsRepository, Storage } from "../../src";
import { sql } from "../../src";
import type { ContractEngine } from "./env";

const T0 = "2026-11-21T10:00:00.000Z";
const T1 = "2026-11-21T11:00:00.000Z";
const T2 = "2026-11-22T01:00:00.000Z";

type SkillSeed = {
  id: string;
  name: string;
  scope?: string;
  owner?: string | null;
  content?: string;
  createdAt?: string;
  systemDefault?: boolean;
  description?: string;
};

function invocation(overrides: Partial<NewSkillInvocation> = {}): NewSkillInvocation {
  return {
    id: crypto.randomUUID(),
    skillId: "s1",
    skillName: "alpha",
    skillVersion: 1,
    tokenCount: 10,
    agentId: "a1",
    taskId: null,
    sessionId: null,
    harness: "claude",
    via: "tool",
    eventId: crypto.randomUUID(),
    createdAt: T0,
    ...overrides,
  };
}

export function skillsContract(engine: ContractEngine): void {
  describe(`skills repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: SkillsRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.skills;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    const skill = (s: SkillSeed) =>
      storage.executor.run(sql`
        INSERT INTO skills (id, name, description, content, type, scope, "ownerAgentId",
          "systemDefault", "createdAt", "lastUpdatedAt")
        VALUES (${s.id}, ${s.name}, ${s.description ?? "d"}, ${s.content ?? "12345"}, 'personal',
          ${s.scope ?? "swarm"}, ${s.owner ?? null}, ${s.systemDefault ?? false},
          ${s.createdAt ?? T0}, ${s.createdAt ?? T0})`);
    const agent = (id: string, name: string, status = "idle") =>
      storage.executor.run(sql`
        INSERT INTO agents (id, name, status, "createdAt", "lastUpdatedAt")
        VALUES (${id}, ${name}, ${status}, ${T0}, ${T0})`);

    test("resolution by id, then by name with agent > swarm > global precedence", async () => {
      await agent("a1", "Ann");
      await skill({ id: "g", name: "alpha", scope: "global" });
      await skill({ id: "w", name: "alpha", scope: "swarm" });
      await skill({ id: "m", name: "alpha", scope: "agent", owner: "a1", content: "123" });
      expect(await repo.findResolvedSkillById("w")).toEqual({
        id: "w",
        name: "alpha",
        version: 1,
        chars: 5,
      });
      expect((await repo.findResolvedSkillByName("alpha", "a1"))?.id).toBe("m");
      expect((await repo.findResolvedSkillByName("alpha", "a2"))?.id).toBe("w");
      expect((await repo.findResolvedSkillByName("alpha", null))?.id).toBe("w");
      expect(await repo.findResolvedSkillByName("nope", null)).toBeNull();
    });

    test("counter, audit columns, swarm-name list order and the ownerless id", async () => {
      await agent("a1", "Ann");
      await agent("a2", "Bob");
      await skill({ id: "b", name: "alpha", owner: "a2", createdAt: T0 });
      await skill({ id: "a", name: "alpha", owner: "a1", createdAt: T0 });
      await skill({ id: "c", name: "alpha", createdAt: T1 });
      expect(await repo.listSwarmSkillsByName("alpha")).toEqual([
        { id: "a", ownerAgentId: "a1" },
        { id: "b", ownerAgentId: "a2" },
        { id: "c", ownerAgentId: null },
      ]);
      expect(await repo.findOwnerlessSkillId("alpha", "swarm")).toBe("c");
      expect(await repo.findOwnerlessSkillId("alpha", "global")).toBeNull();

      await repo.bumpInvocationCount("c", T1);
      await repo.bumpInvocationCount("c", T2);
      await repo.setUpdatedBy("c", null, "agent-x");
      const row = await storage.executor.get<Record<string, unknown>>(
        sql`SELECT "invocationCount", "lastInvokedAt", updated_by, "updatedByAgentId" FROM skills WHERE id = ${"c"}`,
      );
      expect(row).toEqual({
        invocationCount: 2,
        lastInvokedAt: T2,
        updated_by: null,
        updatedByAgentId: "agent-x",
      });
    });

    test("insertSkillInvocation skips a repeat of the skill in the same session", async () => {
      await agent("a1", "Ann");
      await skill({ id: "s1", name: "alpha" });
      expect(await repo.insertSkillInvocation(invocation({ sessionId: "sess" }))).toBe(true);
      expect(await repo.insertSkillInvocation(invocation({ sessionId: "sess" }))).toBe(false);
      expect(await repo.insertSkillInvocation(invocation({ sessionId: null }))).toBe(true);
      expect(await repo.insertSkillInvocation(invocation({ sessionId: null }))).toBe(true);
      expect(await repo.firstInvocationAt()).toBe(T0);
    });

    test("ranked search: exact name first, then score, enabled skills only", async () => {
      await skill({ id: "s1", name: "deploy-helper", description: "ships builds to prod" });
      await skill({ id: "s2", name: "deploy", description: "the deploy runbook" });
      await skill({ id: "s3", name: "notes", description: "unrelated" });
      const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
      expect(ids(await repo.searchRankedSkills('"deploy"', "deploy", 10, "skills.id"))).toEqual([
        "s2",
        "s1",
      ]);
      expect(ids(await repo.searchRankedSkills('"deploy"', "deploy", 1, "skills.id"))).toEqual([
        "s2",
      ]);
      expect(await repo.searchRankedSkills('"zzz"', "zzz", 10, "skills.id")).toEqual([]);
    });

    test("usage analytics: totals, local days, harness and skill groups, agents, unused", async () => {
      await agent("a1", "Ann");
      await agent("a2", "Bob", "offline");
      await agent("a3", "Cid", "offline");
      await skill({ id: "s1", name: "alpha" });
      await skill({ id: "s2", name: "beta", systemDefault: true });
      await skill({ id: "s3", name: "gamma" });
      await repo.insertSkillInvocation(invocation({ createdAt: T0 }));
      await repo.insertSkillInvocation(invocation({ agentId: "a2", createdAt: T1, harness: null }));
      await repo.insertSkillInvocation(
        invocation({ skillId: null, skillName: "ghost", tokenCount: null, createdAt: T2 }),
      );

      expect(await repo.usageTotals(null)).toEqual({
        invocations: 3,
        distinctSkills: 2,
        distinctAgents: 2,
        distinctTasks: 0,
        unresolved: 1,
        tokens: 20,
      });
      expect((await repo.usageTotals(T1))?.invocations).toBe(2);
      expect(await repo.usageDaily(null, 0)).toEqual([
        { date: "2026-11-21", invocations: 2, skills: 1, tasks: 0 },
        { date: "2026-11-22", invocations: 1, skills: 1, tasks: 0 },
      ]);
      // UTC-3: the 01:00 invocation lands on the previous local day.
      expect(await repo.usageDaily(null, -180)).toEqual([
        { date: "2026-11-21", invocations: 3, skills: 2, tasks: 0 },
      ]);
      expect(await repo.usageByHarness(null)).toEqual([
        { key: "claude", invocations: 2 },
        { key: "unknown", invocations: 1 },
      ]);
      expect(
        (await repo.usageBySkill(null)).map((row) => [row.skillName, row.invocations]),
      ).toEqual([
        ["alpha", 2],
        ["ghost", 1],
      ]);
      expect(
        (await repo.usageByAgent(null)).map((row) => [row.agentId, row.invocations, row.installed]),
      ).toEqual([
        // Swarm-scope skills install everywhere.
        ["a1", 2, 3],
        ["a2", 1, 3],
      ]);
      expect((await repo.unusedSkills(null)).map((row) => row.name)).toEqual(["beta", "gamma"]);
      expect((await repo.unusedSkills(T2)).map((row) => row.name)).toEqual([
        "alpha",
        "beta",
        "gamma",
      ]);
    });

    test("skill detail and task adoption", async () => {
      await agent("a1", "Ann");
      await skill({ id: "s1", name: "alpha" });
      await storage.executor.run(sql`
        INSERT INTO agent_tasks (id, task, title, status, "createdAt", "lastUpdatedAt")
        VALUES (${"t1"}, ${"do it"}, ${""}, 'completed', ${T0}, ${T0}),
               (${"t2"}, ${"later"}, ${"Later"}, 'pending', ${T0}, ${T0})`);
      await repo.insertSkillInvocation(invocation({ taskId: "t1", createdAt: T0, via: null }));
      await repo.insertSkillInvocation(invocation({ taskId: "t1", createdAt: T1 }));
      await repo.insertSkillInvocation(invocation({ agentId: null, createdAt: T2 }));

      expect(await repo.detailTotals("s1", null)).toEqual({
        invocations: 3,
        distinctAgents: 1,
        distinctTasks: 1,
        tokens: 30,
      });
      expect((await repo.detailTotals("s1", T1))?.invocations).toBe(2);
      expect((await repo.detailDaily("s1", null, 0)).map((row) => row.date)).toEqual([
        "2026-11-21",
        "2026-11-22",
      ]);
      expect(await repo.detailByAgent("s1", null)).toEqual([
        { agentId: "a1", agentName: "Ann", invocations: 2, lastInvokedAt: T1 },
      ]);
      expect(await repo.detailCountBy("s1", null, "via")).toEqual([
        { key: "tool", invocations: 2 },
        { key: "unknown", invocations: 1 },
      ]);
      const recent = await repo.detailRecent("s1", null, 2);
      expect(recent.map((row) => row.createdAt)).toEqual([T2, T1]);
      expect(recent[1]).toMatchObject({ agentName: "Ann", taskTitle: "do it" });

      // t1 completed and invoked a skill; t2 never started.
      expect(await repo.taskAdoption(T0)).toEqual({ tasks: 1, tasksWithSkill: 1 });
    });
  });
}
