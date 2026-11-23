import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  ModelCatalogFactValues,
  ModelsRepository,
  NewModelProfile,
  Storage,
  TaskHoldWindow,
} from "../../src";
import { sql } from "../../src";
import type { ContractEngine } from "./env";

const T0 = "2026-11-21T10:00:00.000Z";
const T1 = "2026-11-21T11:00:00.000Z";
const WINDOW: TaskHoldWindow = {
  repairWindowStart: "2026-11-21T09:00:00.000Z",
  supersededWorkflowReason: "workflow-step-cut",
};
const CONFIG_KEY = "MODEL_PROFILE";

function newProfile(overrides: Partial<NewModelProfile> = {}): NewModelProfile {
  const name = overrides.name ?? `p-${crypto.randomUUID().slice(0, 8)}`;
  return {
    id: crypto.randomUUID(),
    name,
    harness: "claude",
    model: "opus",
    effort: null,
    allowCustomModel: false,
    description: null,
    seededFrom: null,
    credentialAllowlist: null,
    fallbacks: "[]",
    actor: null,
    now: T0,
    ...overrides,
  };
}

const NO_FACTS: ModelCatalogFactValues = {
  name: null,
  family: null,
  releaseDate: null,
  contextWindow: null,
  maxOutput: null,
  reasoning: null,
  reasoningOptions: null,
  pricing: null,
  status: null,
};

export function modelsContract(engine: ContractEngine): void {
  describe(`models repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: ModelsRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.models;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    async function insertTask(fields: {
      id: string;
      status: string;
      profile?: string | null;
      resolvedProfile?: string | null;
      modelGroup?: string | null;
      finishedAt?: string | null;
      failureReason?: string | null;
      workflowRunStepId?: string | null;
      parentTaskId?: string | null;
      taskType?: string | null;
    }): Promise<void> {
      await storage.executor.run(sql`
        INSERT INTO agent_tasks
          (id, task, status, "createdAt", "lastUpdatedAt", profile, "resolvedProfile",
           "modelGroup", "finishedAt", "failureReason", "workflowRunStepId", "parentTaskId", "taskType")
        VALUES (
          ${fields.id}, 't', ${fields.status}, ${T0}, ${T0}, ${fields.profile ?? null},
          ${fields.resolvedProfile ?? null}, ${fields.modelGroup ?? null}, ${fields.finishedAt ?? null},
          ${fields.failureReason ?? null}, ${fields.workflowRunStepId ?? null},
          ${fields.parentTaskId ?? null}, ${fields.taskType ?? null}
        )`);
    }

    test("profiles: insert returns the stored shape, a taken name returns null", async () => {
      const row = await repo.insertProfile(
        newProfile({
          name: "alpha",
          allowCustomModel: true,
          effort: "high",
          credentialAllowlist: '{"ANTHROPIC_API_KEY":["k1"]}',
          fallbacks: '["beta"]',
          actor: null,
        }),
      );
      expect(row).toMatchObject({
        name: "alpha",
        harness: "claude",
        model: "opus",
        effort: "high",
        allowCustomModel: 1,
        description: null,
        seededFrom: null,
        credentialAllowlist: '{"ANTHROPIC_API_KEY":["k1"]}',
        fallbacks: '["beta"]',
        createdAt: T0,
        lastUpdatedAt: T0,
      });
      expect(await repo.findProfileByName("alpha")).toEqual(row);
      expect(await repo.findProfileByName("missing")).toBeNull();
      expect(await repo.insertProfile(newProfile({ name: "alpha" }))).toBeNull();
    });

    test("profiles: list orders by harness, then name; filters by harness", async () => {
      await repo.insertProfile(newProfile({ name: "b", harness: "codex" }));
      await repo.insertProfile(newProfile({ name: "z", harness: "claude" }));
      await repo.insertProfile(newProfile({ name: "a", harness: "codex" }));
      await repo.insertProfile(newProfile({ name: "B", harness: "claude" }));
      expect((await repo.listProfiles()).map((row) => row.name)).toEqual(["B", "z", "a", "b"]);
      expect((await repo.listProfiles({ harness: "codex" })).map((row) => row.name)).toEqual([
        "a",
        "b",
      ]);
      expect(await repo.listExistingProfileNames(["b", "nope", "B"])).toEqual(["B", "b"]);
      expect(await repo.listExistingProfileNames([])).toEqual([]);
      expect((await repo.listProfileFallbackGraph()).map((row) => row.name)).toEqual([
        "B",
        "a",
        "b",
        "z",
      ]);
    });

    test("profiles: update sets only the given columns plus audit", async () => {
      await repo.insertProfile(newProfile({ name: "p", effort: "low", description: "d" }));
      const updated = await repo.updateProfile(
        "p",
        { model: "sonnet", allowCustomModel: true, credentialAllowlist: null },
        { actor: null, now: T1 },
      );
      expect(updated).toMatchObject({
        model: "sonnet",
        effort: "low",
        description: "d",
        allowCustomModel: 1,
        credentialAllowlist: null,
        lastUpdatedAt: T1,
        createdAt: T0,
      });
      expect(await repo.updateProfile("missing", { model: "x" }, { actor: null, now: T1 })).toBe(
        null,
      );
    });

    test("profiles: references by fallback, group and holding task", async () => {
      await repo.insertProfile(newProfile({ name: "target" }));
      await repo.insertProfile(newProfile({ name: "b", fallbacks: '["target"]' }));
      await repo.insertProfile(newProfile({ name: "a", fallbacks: '["x","target"]' }));
      // fallbacks is jsonb on Postgres, so unparseable text cannot be stored;
      // a stored document that is not a list of names lists nothing.
      await repo.insertProfile(newProfile({ name: "bad", fallbacks: '{"k":"x"}' }));
      expect(await repo.listProfilesWithFallback("target")).toEqual(["a", "b"]);

      const group = await repo.insertGroup({
        id: "g1",
        name: "grp",
        description: null,
        seededFrom: null,
        actor: null,
        now: T0,
      });
      expect(group).not.toBeNull();
      await repo.replaceGroupMembers("g1", ["target"]);
      expect(await repo.listGroupsWithMember("target")).toEqual(["grp"]);

      expect(await repo.countTasksHoldingProfile("target", WINDOW)).toBe(0);
      await insertTask({ id: "t1", status: "pending", profile: "target" });
      await insertTask({ id: "t2", status: "completed", resolvedProfile: "target" });
      await insertTask({ id: "t3", status: "in_progress", resolvedProfile: "target" });
      expect(await repo.countTasksHoldingProfile("target", WINDOW)).toBe(2);
    });

    test("profiles: superseded tasks hold only inside the resume window", async () => {
      await repo.insertProfile(newProfile({ name: "p" }));
      // Inside the window, no resume yet: holds.
      await insertTask({ id: "s1", status: "superseded", profile: "p", finishedAt: T0 });
      // Outside the window: released.
      await insertTask({
        id: "s2",
        status: "superseded",
        profile: "p",
        finishedAt: "2026-11-21T08:00:00.000Z",
      });
      // A workflow-step cut never gets a resume.
      await insertTask({
        id: "s3",
        status: "superseded",
        profile: "p",
        finishedAt: T0,
        failureReason: WINDOW.supersededWorkflowReason,
      });
      // Already resumed.
      await insertTask({ id: "s4", status: "superseded", profile: "p", finishedAt: T0 });
      await insertTask({ id: "s4r", status: "completed", parentTaskId: "s4", taskType: "resume" });
      // Unfinished, a NULL failureReason still holds (IS DISTINCT FROM).
      await insertTask({ id: "s5", status: "superseded", profile: "p", finishedAt: null });
      expect(await repo.countTasksHoldingProfile("p", WINDOW)).toBe(2);
    });

    test("profiles: delete refuses while referenced, in the statement", async () => {
      await repo.insertProfile(newProfile({ name: "free" }));
      expect(await repo.deleteUnreferencedProfile("free", WINDOW, CONFIG_KEY)).toBe(true);
      expect(await repo.findProfileByName("free")).toBeNull();
      expect(await repo.deleteUnreferencedProfile("free", WINDOW, CONFIG_KEY)).toBe(false);

      await repo.insertProfile(newProfile({ name: "fb" }));
      await repo.insertProfile(newProfile({ name: "user", fallbacks: '["fb"]' }));
      expect(await repo.deleteUnreferencedProfile("fb", WINDOW, CONFIG_KEY)).toBe(false);
      // A profile listing itself does not count as a reference.
      await repo.insertProfile(newProfile({ name: "self", fallbacks: '["self"]' }));
      expect(await repo.deleteUnreferencedProfile("self", WINDOW, CONFIG_KEY)).toBe(true);

      await repo.insertProfile(newProfile({ name: "member" }));
      await repo.insertGroup({
        id: "g1",
        name: "grp",
        description: null,
        seededFrom: null,
        actor: null,
        now: T0,
      });
      await repo.replaceGroupMembers("g1", ["member"]);
      expect(await repo.deleteUnreferencedProfile("member", WINDOW, CONFIG_KEY)).toBe(false);

      await repo.insertProfile(newProfile({ name: "held" }));
      await insertTask({ id: "t1", status: "pending", profile: "held" });
      expect(await repo.deleteUnreferencedProfile("held", WINDOW, CONFIG_KEY)).toBe(false);
      expect(await repo.findProfileByName("held")).not.toBeNull();
    });

    test("groups: insert, members in position order, update, name conflict", async () => {
      for (const name of ["p1", "p2", "p3"]) await repo.insertProfile(newProfile({ name }));
      const g = await repo.insertGroup({
        id: "g2",
        name: "beta",
        description: "d",
        seededFrom: "tier:smol",
        actor: null,
        now: T0,
      });
      expect(g).toMatchObject({
        id: "g2",
        name: "beta",
        description: "d",
        seededFrom: "tier:smol",
        createdAt: T0,
        lastUpdatedAt: T0,
      });
      expect(
        await repo.insertGroup({
          id: "g9",
          name: "beta",
          description: null,
          seededFrom: null,
          actor: null,
          now: T0,
        }),
      ).toBeNull();
      await repo.insertGroup({
        id: "g1",
        name: "alpha",
        description: null,
        seededFrom: null,
        actor: null,
        now: T0,
      });
      await repo.replaceGroupMembers("g2", ["p3", "p1"]);
      await repo.replaceGroupMembers("g1", ["p2"]);
      expect(await repo.listGroupMembers()).toEqual([
        { groupId: "g1", profileName: "p2" },
        { groupId: "g2", profileName: "p3" },
        { groupId: "g2", profileName: "p1" },
      ]);
      await repo.replaceGroupMembers("g2", ["p1", "p2", "p3"]);
      expect((await repo.listGroupMembers("g2")).map((m) => m.profileName)).toEqual([
        "p1",
        "p2",
        "p3",
      ]);
      expect((await repo.listGroups()).map((row) => row.name)).toEqual(["alpha", "beta"]);
      expect(await repo.findGroupByName("beta")).toEqual(g);

      const kept = await repo.updateGroup("g2", {}, { actor: null, now: T1 });
      expect(kept).toMatchObject({ description: "d", lastUpdatedAt: T1 });
      const cleared = await repo.updateGroup("g2", { description: null }, { actor: null, now: T1 });
      expect(cleared).toMatchObject({ description: null });
      expect(await repo.updateGroup("nope", {}, { actor: null, now: T1 })).toBeNull();
    });

    test("groups: member harnesses in position order; an empty group gives a null row", async () => {
      await repo.insertProfile(newProfile({ name: "c1", harness: "codex" }));
      await repo.insertProfile(newProfile({ name: "a1", harness: "claude" }));
      await repo.insertGroup({
        id: "g1",
        name: "mixed",
        description: null,
        seededFrom: null,
        actor: null,
        now: T0,
      });
      await repo.replaceGroupMembers("g1", ["c1", "a1"]);
      expect(await repo.listGroupMemberHarnesses("mixed")).toEqual([
        { profile: "c1", harness: "codex" },
        { profile: "a1", harness: "claude" },
      ]);
      await repo.insertGroup({
        id: "g2",
        name: "empty",
        description: null,
        seededFrom: null,
        actor: null,
        now: T0,
      });
      expect(await repo.listGroupMemberHarnesses("empty")).toEqual([
        { profile: null, harness: null },
      ]);
      expect(await repo.listGroupMemberHarnesses("missing")).toEqual([]);
    });

    test("groups: delete refuses while a task holds the group, members cascade", async () => {
      await repo.insertProfile(newProfile({ name: "p1" }));
      await repo.insertGroup({
        id: "g1",
        name: "grp",
        description: null,
        seededFrom: null,
        actor: null,
        now: T0,
      });
      await repo.replaceGroupMembers("g1", ["p1"]);
      await insertTask({ id: "t1", status: "pending", modelGroup: "grp" });
      expect(await repo.countTasksHoldingGroup("grp", WINDOW)).toBe(1);
      expect(await repo.deleteUnreferencedGroup("grp", WINDOW)).toBe(false);
      await storage.executor.run(sql`UPDATE agent_tasks SET status = 'completed' WHERE id = 't1'`);
      expect(await repo.countTasksHoldingGroup("grp", WINDOW)).toBe(0);
      expect(await repo.deleteUnreferencedGroup("grp", WINDOW)).toBe(true);
      expect(await repo.listGroupMembers("g1")).toEqual([]);
      expect(await repo.deleteUnreferencedGroup("grp", WINDOW)).toBe(false);
    });

    test("catalog: rows, keys order, count, touch and delete", async () => {
      for (const [provider, modelId] of [
        ["openai", "b"],
        ["anthropic", "z"],
        ["openai", "a"],
      ] as const) {
        await repo.insertCatalogRow({
          provider,
          modelId,
          ...NO_FACTS,
          reasoning: modelId === "a" ? true : modelId === "b" ? false : null,
          pricing: modelId === "a" ? '{"input":1}' : null,
          providerName: provider.toUpperCase(),
          checkedAt: 1000,
        });
      }
      expect(await repo.listCatalogKeys()).toEqual([
        { provider: "anthropic", modelId: "z" },
        { provider: "openai", modelId: "a" },
        { provider: "openai", modelId: "b" },
      ]);
      const rows = await repo.listCatalog();
      expect(rows.map((row) => [row.modelId, row.reasoning])).toEqual([
        ["z", null],
        ["a", 1],
        ["b", 0],
      ]);
      expect(rows[1]).toMatchObject({ pricing: '{"input":1}', providerName: "OPENAI" });
      expect(await repo.countCatalog()).toBe(3);
      await repo.touchCatalogCheckedAt(2000);
      expect((await repo.listCatalog()).every((row) => row.checkedAt === 2000)).toBe(true);
      await repo.deleteAllCatalog();
      expect(await repo.countCatalog()).toBe(0);
    });

    test("catalog meta: absent, then upserted on the single row", async () => {
      expect(await repo.getCatalogMeta()).toBeNull();
      await repo.upsertCatalogMeta({
        etag: "e1",
        lastModified: null,
        lastFetchAt: 10,
        lastCheckedAt: 11,
      });
      await repo.upsertCatalogMeta({
        etag: "e2",
        lastModified: "Mon",
        lastFetchAt: 10,
        lastCheckedAt: 12,
      });
      expect(await repo.getCatalogMeta()).toEqual({
        etag: "e2",
        lastModified: "Mon",
        lastFetchAt: 10,
        lastCheckedAt: 12,
      });
    });

    test("overlay: upsert keeps createdAt, integer epoch-ms timestamps, delete count", async () => {
      const base = {
        provider: "openai",
        modelId: "m1",
        ...NO_FACTS,
        reason: "r1",
        verifiedBy: null,
        expiresWhenUpstreamMatches: true,
        actor: null,
      };
      await repo.upsertOverlay({ ...base, now: 1_700_000_000_000 });
      await repo.upsertOverlay({
        ...base,
        reason: "r2",
        reasoning: true,
        expiresWhenUpstreamMatches: false,
        now: 1_700_000_000_500,
      });
      await repo.upsertOverlay({ ...base, provider: "anthropic", now: 5 });
      const row = await repo.findOverlay("openai", "m1");
      expect(row).toMatchObject({
        reason: "r2",
        reasoning: 1,
        expiresWhenUpstreamMatches: 0,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_500,
      });
      expect(typeof row?.createdAt).toBe("number");
      expect((await repo.listOverlay()).map((r) => r.provider)).toEqual(["anthropic", "openai"]);
      expect(await repo.deleteOverlay("openai", "m1")).toBe(1);
      expect(await repo.deleteOverlay("openai", "m1")).toBe(0);
      expect(await repo.findOverlay("openai", "m1")).toBeNull();
    });

    test("alias resolutions: the newest row wins", async () => {
      expect(await repo.lastAliasResolution("latest:opus")).toBeNull();
      await repo.insertAliasResolution({
        alias: "latest:opus",
        previousModel: null,
        newModel: "m1",
        changedAt: 2,
      });
      await repo.insertAliasResolution({
        alias: "latest:opus",
        previousModel: "m1",
        newModel: "m2",
        changedAt: 1,
      });
      expect(await repo.lastAliasResolution("latest:opus")).toBe("m2");
    });

    test("harness support: unknown never downgrades, list newest first with filters", async () => {
      const rec = {
        harness: "claude",
        cliVersion: "1.0",
        modelId: "m1",
        status: "ok" as const,
        checkedAt: 1,
        error: null,
      };
      await repo.upsertHarnessModelSupport(rec);
      await repo.upsertHarnessModelSupport({ ...rec, status: "unknown", checkedAt: 2, error: "e" });
      expect(await repo.findHarnessModelSupport("claude", "1.0", "m1")).toEqual({
        ...rec,
        checkedAt: 2,
        error: "e",
      });
      await repo.upsertHarnessModelSupport({ ...rec, status: "unsupported", checkedAt: 3 });
      expect((await repo.findHarnessModelSupport("claude", "1.0", "m1"))?.status).toBe(
        "unsupported",
      );
      await repo.upsertHarnessModelSupport({ ...rec, modelId: "m2", checkedAt: 5 });
      await repo.upsertHarnessModelSupport({ ...rec, cliVersion: "2.0", checkedAt: 4 });
      await repo.upsertHarnessModelSupport({ ...rec, harness: "codex", checkedAt: 6 });
      expect((await repo.listHarnessModelSupport()).map((r) => r.checkedAt)).toEqual([6, 5, 4, 3]);
      expect(
        (await repo.listHarnessModelSupport({ harness: "claude" })).map((r) => r.checkedAt),
      ).toEqual([5, 4, 3]);
      expect(
        (await repo.listHarnessModelSupport({ harness: "claude", cliVersion: "1.0" })).map(
          (r) => r.modelId,
        ),
      ).toEqual(["m2", "m1"]);
      expect(await repo.findHarnessModelSupport("claude", "9", "m1")).toBeNull();
    });
  });
}
