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
      expect(ids(await repo.searchRankedSkills(["deploy"], "deploy", 10, "skills.id"))).toEqual([
        "s2",
        "s1",
      ]);
      expect(ids(await repo.searchRankedSkills(["deploy"], "deploy", 1, "skills.id"))).toEqual([
        "s2",
      ]);
      expect(await repo.searchRankedSkills(["zzz"], "zzz", 10, "skills.id")).toEqual([]);
    });

    test("ranked search: weights, OR of terms, phrases, stems, disabled skills", async () => {
      const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(20);
      await skill({
        id: "k1",
        name: "release-notes",
        description: "writes the changelog",
        content: "steps for shipping",
      });
      await skill({ id: "k2", name: "shipper", description: "ships builds", content: "a train" });
      await skill({
        id: "k3",
        name: "misc",
        description: "other",
        content: `${filler} release ${filler} release`,
      });
      await skill({ id: "k4", name: "release-guard", description: "guard", content: "release" });
      await storage.executor.run(sql`UPDATE skills SET "isEnabled" = ${false} WHERE id = ${"k4"}`);
      await skill({ id: "k5", name: "notes", description: "release notes archive", content: "x" });
      const ids = async (terms: string[], exact = terms.join(" ")) =>
        (await repo.searchRankedSkills<{ id: string }>(terms, exact, 10, "skills.id")).map(
          (row) => row.id,
        );
      const sorted = (list: string[]) => [...list].sort();

      // A name hit beats a description hit, which beats a body hit.
      const release = await ids(["release"]);
      expect(sorted(release)).toEqual(["k1", "k3", "k5"]);
      expect(release[0]).toBe("k1");
      expect(release.at(-1)).toBe("k3");
      // Terms are OR-ed.
      expect(sorted(await ids(["changelog", "builds"]))).toEqual(["k1", "k2"]);
      // A term with a hyphen is a phrase: its words in order, in one column.
      expect(sorted(await ids(["release-notes"]))).toEqual(["k1", "k5"]);
      expect(await ids(["notes-release"])).toEqual([]);
      // Stems: "shipping" and "ships" share one.
      expect(sorted(await ids(["shipping"]))).toEqual(["k1", "k2"]);
      // A disabled skill never matches, not even by its exact name.
      expect(await ids(["guard"])).toEqual([]);
      expect(await ids(["release-guard"])).toEqual([]);
    });

    test("ranked search: the divergence corpus (same set and top hit on every engine)", async () => {
      // scripts/e2e/scenarios/divergence-fulltext-search.ts, with a fixed nonce.
      const w = (stem: string) => `${stem}x7f3a9c`;
      const [A, B, C, D] = [w("zephyr"), w("quokka"), w("marlin"), w("tundra")];
      const filler =
        "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore";
      const corpus: Record<string, { description: string; body: string }> = {
        d1: { description: `${A} ${B} handbook`, body: `Use ${A} carefully.` },
        d2: { description: `${B} reference`, body: `${filler} ${A} ${filler}` },
        d3: { description: `${C} notes`, body: `${A} ${C}` },
        d4: { description: `${D} ${B} guide`, body: "Nothing else here." },
        d5: { description: "plain words only", body: `${C} ${C} ${C}` },
      };
      for (const [id, spec] of Object.entries(corpus)) {
        const name = `div-fts-7f3a9c-${id}`;
        await skill({
          id,
          name,
          description: spec.description,
          content: `---\nname: ${name}\ndescription: ${spec.description}\n---\n\n${spec.body}\n`,
        });
      }
      const search = async (terms: string[], exact: string) =>
        (await repo.searchRankedSkills<{ id: string }>(terms, exact, 10, "skills.id")).map(
          (row) => row.id,
        );
      const a = await search([A], A);
      expect([...a].sort()).toEqual(["d1", "d2", "d3"]);
      expect(a[0]).toBe("d1");
      const bd = await search([B, D], `${B} ${D}`);
      expect([...bd].sort()).toEqual(["d1", "d2", "d4"]);
      expect(bd[0]).toBe("d4");
      const exact = "DIV-FTS-7F3A9C-D5";
      expect(await search([exact], exact)).toEqual(["d5"]);
      expect(await search([A.slice(0, -3)], A.slice(0, -3))).toEqual([]);
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

    test("findOldestSkillIdByName picks the lowest createdAt in any scope", async () => {
      await agent("a1", "Ann");
      await skill({
        id: "late",
        name: "beta",
        scope: "swarm",
        createdAt: "2026-11-21T12:00:00.000Z",
      });
      await skill({
        id: "early",
        name: "beta",
        scope: "agent",
        owner: "a1",
        createdAt: "2026-11-21T09:00:00.000Z",
      });
      expect(await repo.findOldestSkillIdByName("beta")).toBe("early");
      expect(await repo.findOldestSkillIdByName("none")).toBeNull();
    });

    const newSkill = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      name: id,
      description: `desc ${id}`,
      content: `content ${id}`,
      type: "personal",
      scope: "agent",
      ownerAgentId: null,
      sourceUrl: null,
      sourceRepo: null,
      sourcePath: null,
      sourceBranch: "main",
      sourceHash: null,
      isComplex: false,
      allowedTools: null,
      model: null,
      effort: null,
      context: null,
      agent: null,
      disableModelInvocation: false,
      userInvocable: true,
      isEnabled: true,
      systemDefault: false,
      createdAt: "2026-11-21T10:00:00.000Z",
      lastUpdatedAt: "2026-11-21T10:00:00.000Z",
      createdByAgentId: null,
      updatedByAgentId: null,
      created_by: null,
      updated_by: null,
      ...extra,
    });

    test("skill CRUD: flags, version bump on content, lookups and lists", async () => {
      await storage.executor.run(sql`DELETE FROM skills`);
      const s = await repo.insertSkill(newSkill("zz-b", { isComplex: true }));
      expect(s).toMatchObject({ version: 1, isComplex: 1, userInvocable: 1, invocationCount: 0 });
      await repo.insertSkill(newSkill("zz-a", { scope: "swarm", type: "remote" }));
      await repo.insertSkill(newSkill("zz-c", { isEnabled: false, systemDefault: true }));
      const u = await repo.updateSkill(
        "zz-b",
        { description: "x", isEnabled: false },
        "2026-11-21T11:00:00.000Z",
      );
      expect([u?.version, u?.isEnabled, u?.description]).toEqual([1, 0, "x"]);
      const c = await repo.updateSkill(
        "zz-b",
        { content: "new", model: null },
        "2026-11-21T12:00:00.000Z",
      );
      expect([c?.version, c?.lastUpdatedAt]).toEqual([2, "2026-11-21T12:00:00.000Z"]);
      await repo.bumpSkillVersion("zz-b", "2026-11-21T12:00:00.000Z");
      expect((await repo.findSkillById("zz-b"))?.version).toBe(3);
      expect((await repo.findSkillByName("zz-a", "swarm", ""))?.id).toBe("zz-a");
      expect(await repo.findSkillByName("zz-a", "agent", "")).toBeNull();
      const names = async (f: object) =>
        (await repo.listSkills({ slim: false, ...f })).map((r) => r.id);
      expect(await names({})).toEqual(["zz-a", "zz-b", "zz-c"]);
      expect(await names({ isEnabled: false })).toEqual(["zz-b", "zz-c"]);
      expect(await names({ search: "DESC ZZ-A" })).toEqual(["zz-a"]);
      expect(await names({ limit: 1, scope: "agent" })).toEqual(["zz-b"]);
      expect((await repo.listSkills({ slim: true }))[0]?.content).toBe("");
      expect(
        (await repo.searchSkillsBySubstring(["content"], "zz-a", 10, false)).map((r) => r.id),
      ).toEqual(["zz-a"]);
      await repo.updateSkill("zz-b", { isEnabled: true }, "2026-11-21T12:00:00.000Z");
      expect(
        (await repo.searchSkillsBySubstring(["zz"], "ZZ-B", 10, true)).map((r) => r.id),
      ).toEqual(["zz-b", "zz-a"]);
      expect(await repo.listSystemDefaultSkills()).toEqual([]);
      expect(await repo.deleteSkill("zz-c")).toBe(1);
    });

    test("agent skills: installed first, personal before others; skill files upsert by path", async () => {
      await storage.executor.run(sql`DELETE FROM skills`);
      await storage.executor.run(sql`
        INSERT INTO agents (id, name, status, "createdAt", "lastUpdatedAt")
        VALUES ('ag', 'ag', 'idle', '2026-11-21T10:00:00.000Z', '2026-11-21T10:00:00.000Z')`);
      await repo.insertSkill(newSkill("mine"));
      await repo.insertSkill(newSkill("off"));
      await repo.insertSkill(newSkill("sw", { scope: "swarm", type: "remote" }));
      await repo.insertSkill(newSkill("sw2", { scope: "swarm" }));
      await storage.executor.run(sql`
        INSERT INTO agent_skills (id, "agentId", "skillId", "isActive", "installedAt")
        VALUES ('i1', 'ag', 'mine', ${true}, '2026-11-21T10:00:00.000Z'), ('i2', 'ag', 'off', ${false}, '2026-11-21T10:00:01.000Z')`);
      const rows = await repo.listAgentSkills("ag", true);
      expect(rows.map((r) => [r.id, r.sourceRank, r.typeRank, r.isActive])).toEqual([
        ["mine", 0, 0, 1],
        ["sw2", 1, 0, 1],
        ["sw", 1, 1, 1],
      ]);
      expect((await repo.listAgentSkills("ag", false)).map((r) => r.id)).toEqual([
        "mine",
        "off",
        "sw2",
        "sw",
      ]);
      const file = (path: string, content: string) => ({
        id: `f-${path}-${content}`,
        skillId: "mine",
        path,
        content,
        mimeType: "text/plain",
        isBinary: false,
        size: content.length,
        createdAt: "2026-11-21T10:00:00.000Z",
        lastUpdatedAt: "2026-11-21T10:00:00.000Z",
      });
      expect(await repo.upsertSkillFile(file("b.md", "1"))).toMatchObject({
        isBinary: 0,
        path: "b.md",
      });
      await repo.upsertSkillFile(file("a.md", "1"));
      const again = await repo.upsertSkillFile(file("b.md", "22"));
      expect([again?.id, again?.content, again?.size]).toEqual(["f-b.md-1", "22", 2]);
      expect((await repo.listSkillFiles("mine")).map((f) => f.path)).toEqual(["a.md", "b.md"]);
      expect((await repo.findSkillFile("mine", "a.md"))?.content).toBe("1");
      expect(await repo.deleteSkillFile("mine", "a.md")).toBe(1);
      expect(await repo.deleteSkillFile("mine", "a.md")).toBe(0);
    });
  });
}
