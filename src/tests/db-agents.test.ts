import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as db from "../be/db";

beforeEach(() => db.initDb(":memory:"));
afterEach(() => db.closeDb());

const worker = { name: "Worker", isLead: false, status: "idle" as const };

test("facade registration installs defaults and records lifecycle logs", async () => {
  const skill = await db.createSkill({
    name: "test-default",
    description: "Default",
    content: "Instructions",
    type: "personal",
    scope: "swarm",
    systemDefault: true,
  });
  const agent = await db.createAgent(worker);
  expect(
    await db.getDbClient().get("SELECT skillId FROM agent_skills WHERE agentId = ?", [agent.id]),
  ).toEqual({ skillId: skill.id });
  await db.updateAgentStatus(agent.id, "busy");
  expect(
    (await db.getLogsByAgentId(agent.id)).map(({ eventType, oldValue, newValue }) => ({
      eventType,
      oldValue,
      newValue,
    })),
  ).toEqual(
    expect.arrayContaining([
      { eventType: "agent_joined", oldValue: undefined, newValue: "idle" },
      { eventType: "agent_status_change", oldValue: "idle", newValue: "busy" },
    ]),
  );
  // Logging precedes deletion, including when the existing log FK rejects deletion.
  await db.getDbClient().run("CREATE TABLE deletion_probe (eventType TEXT, oldValue TEXT)");
  await db
    .getDbClient()
    .run(
      "CREATE TRIGGER deletion_log AFTER INSERT ON agent_log WHEN NEW.eventType = 'agent_left' BEGIN INSERT INTO deletion_probe VALUES (NEW.eventType, NEW.oldValue); END",
    );
  await expect(db.deleteAgent(agent.id)).rejects.toThrow("FOREIGN KEY constraint failed");
  expect(await db.getDbClient().get("SELECT * FROM deletion_probe")).toEqual({
    eventType: "agent_left",
    oldValue: "busy",
  });
});

test("skill and log failures retain the original catch boundaries", async () => {
  await db.getDbClient().run("DROP TABLE skills");
  await db
    .getDbClient()
    .run(
      "CREATE TRIGGER reject_logs BEFORE INSERT ON agent_log BEGIN SELECT RAISE(FAIL, 'log failure'); END",
    );
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const agent = await db.createAgent(worker);
    expect(warning).toHaveBeenCalledWith(
      "[db] Failed to install system-default skills for new agent:",
      expect.any(String),
    );
    expect((await db.updateAgentStatus(agent.id, "busy"))?.status).toBe("busy");
    expect(await db.deleteAgent(agent.id)).toBe(true);
  } finally {
    warning.mockRestore();
  }
});

test("unmoved profile and idle-worker callers share agent mapping defaults", async () => {
  const agent = await db.createAgent(worker);
  expect(agent).toMatchObject({
    maxTasks: 1,
    emptyPollCount: 0,
    capabilities: [],
    credentialMissing: null,
    credStatus: null,
    harnessProvider: null,
    avatar: null,
  });
  const updated = await db.updateAgentProfile(agent.id, {
    role: "coder",
    capabilities: ["typescript"],
  });
  expect(updated).toEqual(await db.getAgentById(agent.id));
  expect(await db.getIdleWorkersWithCapacity()).toEqual([updated!]);
  await db
    .getDbClient()
    .run("UPDATE agents SET avatar = ? WHERE id = ?", ["invalid json", agent.id]);
  expect((await db.getAgentById(agent.id))?.avatar).toBeNull();
});
