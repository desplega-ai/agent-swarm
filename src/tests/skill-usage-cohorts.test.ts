import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  cancelTask,
  closeDb,
  createAgent,
  createSkill,
  createTaskExtended,
  failPendingResumeIfUnclaimed,
  getAgentSkills,
  getDbClient,
  initDb,
  installSkill,
  startTask,
  toggleAgentSkill,
} from "../be/db";
import { getSkillUsageDetail, getSkillUsageSummary } from "../be/skill-usage";

const TEST_DB_PATH = `./test-skill-usage-cohorts-${process.pid}.sqlite`;
const HOUR = 60 * 60 * 1000;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => {});
  }
}

function skillContent(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} test skill\n---\n\n${"x".repeat(400)}\n`;
}

let n = 0;
async function insertInvocation(row: {
  skillId: string | null;
  skillName: string;
  agentId: string;
  taskId?: string | null;
}): Promise<void> {
  n++;
  await getDbClient().run(
    `INSERT INTO skill_invocations
       (id, skillId, skillName, agentId, taskId, sessionId, harness, via, eventId, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, 'claude', 'tool', ?, ?)`,
    [
      `cohort-inv-${n}`,
      row.skillId,
      row.skillName,
      row.agentId,
      row.taskId ?? null,
      `cohort-session-${n}`,
      `cohort-event-${n}`,
      new Date(Date.now() - HOUR).toISOString(),
    ],
  );
}

let installer: { id: string };
let baseline: { id: string };
let worker: { id: string };

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);

  installer = await createAgent({ name: "Cohort Installer", isLead: false, status: "idle" });
  baseline = await createAgent({ name: "Cohort Baseline", isLead: false, status: "idle" });
  worker = await createAgent({ name: "Cohort Worker", isLead: false, status: "idle" });

  // Same name, two scopes: the swarm copy is implicit for every agent.
  const dupGlobal = await createSkill({
    name: "cohort-dup",
    description: "dup",
    content: skillContent("cohort-dup"),
    type: "personal",
    scope: "global",
  });
  await createSkill({
    name: "cohort-dup",
    description: "dup",
    content: skillContent("cohort-dup"),
    type: "personal",
    scope: "swarm",
  });
  const inactive = await createSkill({
    name: "cohort-inactive",
    description: "inactive",
    content: skillContent("cohort-inactive"),
    type: "personal",
    scope: "global",
  });
  const disabled = await createSkill({
    name: "cohort-disabled",
    description: "disabled",
    content: skillContent("cohort-disabled"),
    type: "personal",
    scope: "global",
  });

  await installSkill(installer.id, dupGlobal.id);
  await installSkill(installer.id, inactive.id);
  await toggleAgentSkill(installer.id, inactive.id, false);
  await installSkill(installer.id, disabled.id);
  await getDbClient().run("UPDATE skills SET isEnabled = 0 WHERE id = ?", [disabled.id]);

  await insertInvocation({ skillId: dupGlobal.id, skillName: "cohort-dup", agentId: installer.id });
  await insertInvocation({
    skillId: inactive.id,
    skillName: "cohort-inactive",
    agentId: installer.id,
  });
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

describe("installed skill math", () => {
  test("ignores inactive installs and disabled skills, and counts a shared name once", async () => {
    const summary = await getSkillUsageSummary("7d");
    const row = summary.agents.find((agent) => agent.agentId === installer.id);
    const base = summary.agents.find((agent) => agent.agentId === baseline.id);
    const runnerList = await getAgentSkills(installer.id);

    expect(runnerList.filter((skill) => skill.name === "cohort-dup")).toHaveLength(1);
    expect(runnerList.some((skill) => skill.name === "cohort-inactive")).toBe(false);
    expect(runnerList.some((skill) => skill.name === "cohort-disabled")).toBe(false);

    // Every explicit install here adds nothing over an agent with none.
    expect(base?.installed).toBe((await getAgentSkills(baseline.id)).length);
    expect(row?.installed).toBe(base?.installed);
    expect(row?.installed).toBe(runnerList.length);
    // Two names loaded, but only cohort-dup is installed.
    expect(row).toMatchObject({ skillsUsed: 2, installedUsed: 1, invocations: 2 });
  });
});

describe("task adoption cohort", () => {
  test("counts tasks that started, including ones cancelled mid-run", async () => {
    const completed = await createTaskExtended("completed", { agentId: worker.id });
    await getDbClient().run("UPDATE agent_tasks SET status = 'completed' WHERE id = ?", [
      completed.id,
    ]);

    const cancelledAfterStart = await createTaskExtended("cancelled mid-run", {
      agentId: worker.id,
    });
    expect(await startTask(cancelledAfterStart.id)).not.toBeNull();
    await insertInvocation({
      skillId: null,
      skillName: "cohort-native",
      agentId: worker.id,
      taskId: cancelledAfterStart.id,
    });
    expect(await cancelTask(cancelledAfterStart.id)).not.toBeNull();

    const failedBeforeStart = await createTaskExtended("resume never reclaimed", {
      agentId: worker.id,
    });
    expect(
      await failPendingResumeIfUnclaimed(failedBeforeStart.id, "failed", "never reclaimed"),
    ).not.toBeNull();

    const cancelledBeforeStart = await createTaskExtended("cancelled while pending", {
      agentId: worker.id,
    });
    expect(await cancelTask(cancelledBeforeStart.id)).not.toBeNull();

    const summary = await getSkillUsageSummary("7d");
    expect(summary.taskAdoption).toMatchObject({ tasks: 2, tasksWithSkill: 1 });
  });
});

describe("query plans", () => {
  test("finite windows range-search skill_invocations on createdAt", async () => {
    const client = getDbClient();
    const captured: { sql: string; params: unknown[] }[] = [];
    const original = { query: client.query, get: client.get };
    const capture =
      <F extends typeof client.query | typeof client.get>(fn: F) =>
      (sql: string, params: unknown[] = []) => {
        if (sql.includes("skill_invocations")) captured.push({ sql, params });
        return fn.call(client, sql, params as never);
      };
    client.query = capture(original.query) as typeof client.query;
    client.get = capture(original.get) as typeof client.get;
    try {
      await getSkillUsageSummary("7d");
      await getSkillUsageSummary("30d");
      await getSkillUsageDetail("missing-skill", "7d");
    } finally {
      client.query = original.query;
      client.get = original.get;
    }

    expect(captured.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const { sql, params } of captured) {
      const plan = await client.query<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${sql}`,
        params as never,
      );
      // MIN(createdAt) reads one end of the time index; everything else must
      // bound its range on createdAt, not just SEARCH some other index.
      const minLookup = sql.includes("MIN(createdAt)");
      for (const { detail } of plan) {
        if (!/\b(si|skill_invocations)\b/.test(detail)) continue;
        if (!detail.startsWith("SEARCH") || !(minLookup || detail.includes("createdAt>"))) {
          offenders.push(`${detail} <- ${sql.replace(/\s+/g, " ").slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("all-time cache", () => {
  test("reuses an all-time summary for five minutes", async () => {
    // The cache is per process and keyed by offset; use one no other test does.
    const tz = 345;
    const now = Date.now();
    const first = await getSkillUsageSummary("all", tz, now);
    await insertInvocation({ skillId: null, skillName: "cohort-late", agentId: worker.id });
    const cached = await getSkillUsageSummary("all", tz, now + 60_000);
    expect(cached).toBe(first);
    const fresh = await getSkillUsageSummary("all", tz, now + 6 * 60_000);
    expect(fresh.totals.invocations).toBe(first.totals.invocations + 1);
    // Finite windows are never cached.
    const week = await getSkillUsageSummary("7d", 0, now + 60_000);
    expect(week.totals.invocations).toBe(fresh.totals.invocations);
  });
});
