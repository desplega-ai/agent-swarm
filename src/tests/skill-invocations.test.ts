import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createSkill,
  getDbClient,
  getSkillById,
  initDb,
  listSkills,
} from "../be/db";
import { type CreateEventInput, createEvent, createEventsBatch } from "../be/events";
import { runMigrations } from "../be/migrations/runner";

const TEST_DB_PATH = "./test-skill-invocations.sqlite";
const MIGRATION_DB_PATH = "./test-skill-invocations-migration.sqlite";

type InvocationRow = {
  skillId: string | null;
  skillName: string | null;
  agentId: string | null;
  taskId: string | null;
  sessionId: string | null;
  harness: string | null;
  via: string | null;
  eventId: string | null;
};

let agentA: { id: string };
let agentB: { id: string };

async function removeDb(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch {}
  }
}

function invoke(
  skill: { skillName?: string; skillId?: string },
  overrides: Partial<CreateEventInput> = {},
): CreateEventInput {
  return {
    category: "skill",
    event: "skill.invoke",
    source: "worker",
    agentId: agentA.id,
    taskId: "task-1",
    sessionId: "session-1",
    data: { ...skill, via: "tool", harness: "codex" },
    ...overrides,
  };
}

async function invocationsFor(name: string): Promise<InvocationRow[]> {
  return getDbClient().query<InvocationRow>(
    "SELECT skillId, skillName, agentId, taskId, sessionId, harness, via, eventId FROM skill_invocations WHERE skillName = ? ORDER BY createdAt",
    [name],
  );
}

beforeAll(async () => {
  await removeDb(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  agentA = await createAgent({ name: "Invocation Agent A", isLead: false, status: "idle" });
  agentB = await createAgent({ name: "Invocation Agent B", isLead: false, status: "idle" });
});

afterAll(async () => {
  closeDb();
  await removeDb(TEST_DB_PATH);
  await removeDb(MIGRATION_DB_PATH);
});

describe("migration 196 skill invocations", () => {
  test("fresh DB has the counter columns and the invocations table", () => {
    const db = new Database(MIGRATION_DB_PATH, { create: true });
    try {
      runMigrations(db);
      const columns = db.query<{ name: string }, []>("PRAGMA table_info(skills)").all();
      expect(columns.map((c) => c.name)).toEqual(
        expect.arrayContaining(["invocationCount", "lastInvokedAt"]),
      );
      const indexes = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'skill_invocations'",
        )
        .all()
        .map((row) => row.name);
      expect(indexes).toEqual(
        expect.arrayContaining([
          "idx_skill_invocations_session_skill",
          "idx_skill_invocations_skill_time",
          "idx_skill_invocations_agent_time",
          "idx_skill_invocations_created",
        ]),
      );
    } finally {
      db.close();
    }
  });

  test("existing DB keeps its skills and starts them at zero", async () => {
    await removeDb(MIGRATION_DB_PATH);
    const db = new Database(MIGRATION_DB_PATH, { create: true });
    try {
      runMigrations(db);
      // Roll the file back to the pre-196 shape, with a skill already in it.
      db.run("DROP TABLE skill_invocations");
      db.run("ALTER TABLE skills DROP COLUMN lastInvokedAt");
      db.run("ALTER TABLE skills DROP COLUMN invocationCount");
      db.run("DELETE FROM _migrations WHERE version = 196");
      db.run(
        `INSERT INTO skills (id, name, description, content, type, scope, createdAt, lastUpdatedAt)
         VALUES ('pre-existing', 'pre-existing-skill', 'd', '', 'remote', 'global', '2026-01-01', '2026-01-01')`,
      );

      runMigrations(db);

      const row = db
        .query<{ invocationCount: number; lastInvokedAt: string | null }, []>(
          "SELECT invocationCount, lastInvokedAt FROM skills WHERE id = 'pre-existing'",
        )
        .get();
      expect(row).toEqual({ invocationCount: 0, lastInvokedAt: null });
      const table = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'skill_invocations'",
        )
        .get();
      expect(table?.name).toBe("skill_invocations");
    } finally {
      db.close();
    }
  });
});

describe("skill.invoke ingestion", () => {
  test("counts a resolved skill once per session and records who invoked it", async () => {
    const skill = await createSkill({
      name: "inv-counted",
      description: "d",
      content: "",
      type: "remote",
      scope: "global",
    });

    await createEventsBatch([
      invoke({ skillName: "inv-counted" }, { sessionId: "count-s1" }),
      // Same session again, by name and then by id: still one invocation.
      invoke({ skillName: "inv-counted" }, { sessionId: "count-s1" }),
    ]);
    await createEvent(
      invoke({ skillId: skill.id }, { sessionId: "count-s1", data: { skillId: skill.id } }),
    );
    // A new session counts again.
    await createEvent(
      invoke({ skillName: "inv-counted" }, { sessionId: "count-s2", agentId: agentB.id }),
    );

    const stored = await getSkillById(skill.id);
    expect(stored?.invocationCount).toBe(2);
    expect(stored?.lastInvokedAt).not.toBeNull();
    expect(stored?.lastUpdatedAt).toBe(skill.lastUpdatedAt);

    const rows = await invocationsFor("inv-counted");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      skillId: skill.id,
      agentId: agentA.id,
      taskId: "task-1",
      sessionId: "count-s1",
      harness: "codex",
      via: "tool",
    });
    expect(rows[0]?.eventId).toBeTruthy();
    expect(rows[1]).toMatchObject({ skillId: skill.id, agentId: agentB.id, sessionId: "count-s2" });

    const slim = await listSkills({ includeContent: false, search: "inv-counted" });
    expect(slim.find((s) => s.id === skill.id)?.invocationCount).toBe(2);
  });

  test("an unresolved name stores the invocation without a count", async () => {
    await createEvent(invoke({ skillName: "inv-not-a-swarm-skill" }, { sessionId: "unres-s1" }));

    const rows = await invocationsFor("inv-not-a-swarm-skill");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ skillId: null, skillName: "inv-not-a-swarm-skill" });
  });

  test("a name resolves to the invoking agent's own skill before swarm and global", async () => {
    const global = await createSkill({
      name: "inv-shadowed",
      description: "d",
      content: "",
      type: "remote",
      scope: "global",
    });
    const own = await createSkill({
      name: "inv-shadowed",
      description: "d",
      content: "",
      scope: "agent",
      ownerAgentId: agentA.id,
    });

    await createEvent(invoke({ skillName: "inv-shadowed" }, { sessionId: "shadow-a" }));
    // Agent B cannot see A's personal skill, so its invocation lands on the global one.
    await createEvent(
      invoke({ skillName: "inv-shadowed" }, { sessionId: "shadow-b", agentId: agentB.id }),
    );

    expect((await getSkillById(own.id))?.invocationCount).toBe(1);
    expect((await getSkillById(global.id))?.invocationCount).toBe(1);
  });

  test("events other than skill.invoke never touch the counter or the history", async () => {
    const skill = await createSkill({
      name: "inv-control",
      description: "d",
      content: "",
      type: "remote",
      scope: "global",
    });

    await createEventsBatch([
      { ...invoke({ skillName: "inv-control" }), event: "tool.start", category: "tool" },
    ]);
    await createEvent({
      ...invoke({ skillName: "inv-control" }),
      event: "skill.complete",
      sessionId: "control-s1",
    });

    expect((await getSkillById(skill.id))?.invocationCount).toBe(0);
    expect(await invocationsFor("inv-control")).toHaveLength(0);
  });
});
