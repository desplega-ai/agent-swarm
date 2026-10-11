import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  closeDb,
  createAgent,
  createSkill,
  createTaskExtended,
  getAgentSkills,
  getDbClient,
  initDb,
  installSkill,
  startTask,
} from "../be/db";
import { getSkillUsageDetail, getSkillUsageSummary } from "../be/skill-usage";
import { handleSkills } from "../http/skills";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = `./test-skill-usage-${process.pid}.sqlite`;
const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => {});
  }
}

async function dispatch(path: string): Promise<{ status: number; body: unknown }> {
  const req = Readable.from([]) as IncomingMessage;
  req.method = "GET";
  req.url = path;
  req.headers = {};
  let status = 200;
  let text = "";
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) text += String(chunk);
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;
  const handled = await handleSkills(
    req,
    res,
    getPathSegments(path),
    parseQueryParams(path),
    undefined,
  );
  if (!handled) return { status: 404, body: null };
  return { status, body: text ? JSON.parse(text) : null };
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
  harness?: string;
  via?: string;
  createdAt: number;
  tokenCount?: number | null;
}): Promise<void> {
  n++;
  await getDbClient().run(
    `INSERT INTO skill_invocations
       (id, skillId, skillName, skillVersion, tokenCount, agentId, taskId, sessionId, harness, via, eventId, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `inv-${n}`,
      row.skillId,
      row.skillName,
      row.skillId ? 1 : null,
      row.tokenCount === undefined ? (row.skillId ? 100 : null) : row.tokenCount,
      row.agentId,
      row.taskId ?? null,
      `session-${n}`,
      row.harness ?? "claude",
      row.via ?? "tool",
      `event-${n}`,
      new Date(row.createdAt).toISOString(),
    ],
  );
}

let agentA: { id: string };
let agentB: { id: string };
let offlineIdle: { id: string };
let usedSkill: { id: string };
let oldSkill: { id: string };
let neverSkill: { id: string };
let notInstalled: { id: string };
let taskWithSkill: { id: string };

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);

  agentA = await createAgent({ name: "Usage Agent A", isLead: false, status: "idle" });
  agentB = await createAgent({ name: "Usage Agent B", isLead: true, status: "busy" });
  offlineIdle = await createAgent({ name: "Usage Offline", isLead: false, status: "offline" });

  usedSkill = await createSkill({
    name: "usage-used",
    description: "used",
    content: skillContent("usage-used"),
    type: "personal",
    scope: "global",
  });
  oldSkill = await createSkill({
    name: "usage-old",
    description: "old",
    content: skillContent("usage-old"),
    type: "personal",
    scope: "global",
  });
  neverSkill = await createSkill({
    name: "usage-never",
    description: "never",
    content: skillContent("usage-never"),
    type: "personal",
    scope: "swarm",
  });
  notInstalled = await createSkill({
    name: "usage-not-installed",
    description: "not installed",
    content: skillContent("usage-not-installed"),
    type: "personal",
    scope: "global",
  });
  await installSkill(agentA.id, usedSkill.id);
  await installSkill(agentA.id, oldSkill.id);
  await installSkill(agentB.id, usedSkill.id);

  taskWithSkill = await createTaskExtended("task that loaded a skill", { agentId: agentA.id });
  const taskWithout = await createTaskExtended("task without skills", { agentId: agentB.id });
  const pendingTask = await createTaskExtended("never started", { agentId: agentB.id });
  const iso = (t: number) => new Date(t).toISOString();
  // Started, then failed: still a started task.
  await startTask(taskWithout.id);
  await getDbClient().run(
    "UPDATE agent_tasks SET status = 'completed', createdAt = ? WHERE id = ?",
    [iso(NOW - 2 * DAY), taskWithSkill.id],
  );
  await getDbClient().run("UPDATE agent_tasks SET status = 'failed', createdAt = ? WHERE id = ?", [
    iso(NOW - 2 * DAY),
    taskWithout.id,
  ]);
  await getDbClient().run("UPDATE agent_tasks SET status = 'pending', createdAt = ? WHERE id = ?", [
    iso(NOW - 2 * DAY),
    pendingTask.id,
  ]);

  // Inside 7d: two loads of usage-used (A, B), one unresolved harness-native skill.
  await insertInvocation({
    skillId: usedSkill.id,
    skillName: "usage-used",
    agentId: agentA.id,
    taskId: taskWithSkill.id,
    createdAt: NOW - 2 * DAY,
  });
  await insertInvocation({
    skillId: usedSkill.id,
    skillName: "usage-used",
    agentId: agentB.id,
    harness: "pi",
    via: "prompt",
    // 23:30 UTC: still Oct 10 in UTC, already Oct 11 at UTC+2.
    createdAt: Date.parse("2026-10-10T23:30:00.000Z"),
  });
  await insertInvocation({
    skillId: null,
    skillName: "native-thing",
    agentId: agentA.id,
    createdAt: NOW - 3 * DAY,
  });
  // Outside 7d, inside 30d: usage-old by A.
  await insertInvocation({
    skillId: oldSkill.id,
    skillName: "usage-old",
    agentId: agentA.id,
    createdAt: NOW - 20 * DAY,
  });
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

describe("getSkillUsageSummary", () => {
  test("7d window counts only recent invocations", async () => {
    const summary = await getSkillUsageSummary("7d", 0, NOW);
    expect(summary.since).toBe(new Date(NOW - 7 * DAY).toISOString());
    expect(summary.totals).toEqual({
      invocations: 3,
      distinctSkills: 2,
      distinctAgents: 2,
      distinctTasks: 1,
      unresolved: 1,
      tokens: 200,
    });
    expect(summary.trackingSince).toBe(new Date(NOW - 20 * DAY).toISOString());
    expect(summary.byHarness).toEqual([
      { key: "claude", invocations: 2 },
      { key: "pi", invocations: 1 },
    ]);
    const used = summary.bySkill.find((row) => row.skillId === usedSkill.id);
    expect(used).toMatchObject({ skillName: "usage-used", invocations: 2, agents: 2, tokens: 200 });
    const native = summary.bySkill.find((row) => row.skillName === "native-thing");
    expect(native).toMatchObject({ skillId: null, invocations: 1 });
    expect(summary.bySkill.some((row) => row.skillId === oldSkill.id)).toBe(false);
  });

  test("all window includes everything", async () => {
    const summary = await getSkillUsageSummary("all", 0, NOW);
    expect(summary.since).toBeNull();
    expect(summary.totals.invocations).toBe(4);
    expect(summary.bySkill.find((row) => row.skillId === oldSkill.id)?.invocations).toBe(1);
  });

  test("daily buckets follow the viewer offset", async () => {
    const utc = await getSkillUsageSummary("7d", 0, NOW);
    expect(utc.daily.map((d) => [d.date, d.invocations])).toEqual([
      ["2026-10-08", 1],
      ["2026-10-09", 1],
      ["2026-10-10", 1],
    ]);
    const bcn = await getSkillUsageSummary("7d", 120, NOW);
    expect(bcn.daily.map((d) => [d.date, d.invocations])).toEqual([
      ["2026-10-08", 1],
      ["2026-10-09", 1],
      ["2026-10-11", 1],
    ]);
  });

  test("task adoption counts started tasks with at least one load", async () => {
    const summary = await getSkillUsageSummary("7d", 0, NOW);
    expect(summary.taskAdoption.tasks).toBe(2);
    expect(summary.taskAdoption.tasksWithSkill).toBe(1);
  });

  test("per-agent adoption compares used against installed", async () => {
    const summary = await getSkillUsageSummary("7d", 0, NOW);
    const a = summary.agents.find((row) => row.agentId === agentA.id);
    const b = summary.agents.find((row) => row.agentId === agentB.id);
    // The oracle is getAgentSkills, the list a runner actually receives.
    expect(a).toMatchObject({
      installed: (await getAgentSkills(agentA.id)).length,
      installedUsed: 1,
      skillsUsed: 2,
      invocations: 2,
      isLead: false,
    });
    expect(b).toMatchObject({
      installed: (await getAgentSkills(agentB.id)).length,
      installedUsed: 1,
      isLead: true,
    });
    expect(a?.installed).toBe((b?.installed ?? 0) + 1);
    expect(summary.agents.some((row) => row.agentId === offlineIdle.id)).toBe(false);
  });

  test("unused lists installed skills with no load in the window", async () => {
    const week = await getSkillUsageSummary("7d", 0, NOW);
    const names = week.unused.map((row) => row.name);
    expect(names).toContain("usage-old");
    expect(names).toContain("usage-never");
    expect(names).not.toContain("usage-used");
    expect(names).not.toContain("usage-not-installed");
    expect(week.unused.find((row) => row.id === neverSkill.id)?.installedEverywhere).toBe(true);
    expect(week.unused.find((row) => row.id === oldSkill.id)?.installedAgents).toBe(1);

    const month = await getSkillUsageSummary("30d", 0, NOW);
    expect(month.unused.map((row) => row.name)).not.toContain("usage-old");
    expect(month.unused.some((row) => row.id === notInstalled.id)).toBe(false);
  });
});

describe("getSkillUsageDetail", () => {
  test("breaks one skill down by agent, harness, via and recent loads", async () => {
    const detail = await getSkillUsageDetail(usedSkill.id, "30d", 0, NOW);
    expect(detail.totals).toEqual({
      invocations: 2,
      distinctAgents: 2,
      distinctTasks: 1,
      tokens: 200,
    });
    expect(detail.byAgent.map((row) => row.agentName).sort()).toEqual([
      "Usage Agent A",
      "Usage Agent B",
    ]);
    expect(detail.byHarness).toEqual([
      { key: "claude", invocations: 1 },
      { key: "pi", invocations: 1 },
    ]);
    expect(detail.byVia).toEqual([
      { key: "prompt", invocations: 1 },
      { key: "tool", invocations: 1 },
    ]);
    expect(detail.recent).toHaveLength(2);
    expect(detail.recent[0]?.agentName).toBe("Usage Agent B");
    const withTask = detail.recent.find((row) => row.taskId === taskWithSkill.id);
    expect(withTask?.taskTitle).toContain("task that loaded a skill");
  });
});

describe("skill usage HTTP routes", () => {
  test("GET /api/skills/usage defaults to 30d and validates the window", async () => {
    const ok = await dispatch("/api/skills/usage");
    expect(ok.status).toBe(200);
    expect((ok.body as { window: string }).window).toBe("30d");

    const bad = await dispatch("/api/skills/usage?window=1y");
    expect(bad.status).toBe(400);
  });

  test("GET /api/skills/:id/usage returns the skill's usage or 404", async () => {
    const ok = await dispatch(`/api/skills/${usedSkill.id}/usage?window=all&tzOffset=120`);
    expect(ok.status).toBe(200);
    expect((ok.body as { skillId: string; totals: { invocations: number } }).skillId).toBe(
      usedSkill.id,
    );

    const missing = await dispatch("/api/skills/does-not-exist/usage");
    expect(missing.status).toBe(404);
  });

  test("GET /api/skills/:id still returns the skill", async () => {
    const res = await dispatch(`/api/skills/${usedSkill.id}`);
    expect(res.status).toBe(200);
    expect((res.body as { name: string }).name).toBe("usage-used");
  });
});
