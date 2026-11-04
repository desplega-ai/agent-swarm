import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { createServer } from "node:http";
import { listChecklist, mutateChecklist } from "../be/checklist";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getDbClient,
  getTaskById,
  initDb,
} from "../be/db";
import { attachRole, detachRole } from "../be/rbac-roles";
import { handlePoll } from "../http/poll";
import { getPathSegments, parseQueryParams } from "../http/utils";
import type { AgentTask, ChecklistItem } from "../types";
import { setRequestAuth } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

const dbPath = "./test-checklist-nudge.sqlite";
const envKeys = [
  "RBAC_ENABLED",
  "APP_URL",
  "DASHBOARD_URL",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "BITBUCKET_TOKEN",
  "SLACK_DISABLE",
  "CHAT_SDK_ADAPTERS",
  "DESPLEGA_TELEMETRY_ENV",
] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let userId: string;
let leadId: string;
let base: string;

const server = createServer(async (req, res) => {
  setRequestAuth(req, { kind: "operator", fingerprint: "op:checklist-nudge" });
  await handlePoll(
    req,
    res,
    getPathSegments(req.url ?? ""),
    parseQueryParams(req.url ?? ""),
    req.headers["x-agent-id"] as string | undefined,
  );
});

beforeAll(async () => {
  process.env.DESPLEGA_TELEMETRY_ENV = "test";
  initDb(dbPath);
  base = `http://localhost:${await listenOnFreePort(server)}`;
});

beforeEach(async () => {
  for (const key of envKeys) delete process.env[key];
  process.env.DESPLEGA_TELEMETRY_ENV = "test";
  process.env.RBAC_ENABLED = "true";
  process.env.SLACK_DISABLE = "true";
  process.env.CHAT_SDK_ADAPTERS = "{}";
  await getDbClient().run("DELETE FROM checklist_items");
  userId = (await createUser({ name: "Nudge requester" })).id;
  leadId = crypto.randomUUID();
  await createAgent({ id: leadId, name: leadId, isLead: true, status: "idle" });
});

afterEach(() => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    await Bun.file(dbPath + suffix)
      .delete()
      .catch(() => {});
  }
});

async function pollTask(
  source: AgentTask["source"] = "ui",
  requester: string | null = userId,
  agentId = leadId,
) {
  const task = await createTaskExtended("Checklist nudge test", {
    agentId,
    source,
    requestedByUserId: requester ?? undefined,
  });
  const response = await fetch(`${base}/api/poll`, { headers: { "X-Agent-ID": agentId } });
  expect(response.status).toBe(200);
  const { trigger } = (await response.json()) as {
    trigger: {
      type: string;
      taskId: string;
      checklistNudge?: { itemId: string; kind: string; label: string; href: string };
    };
  };
  expect(trigger.type).toBe("task_assigned");
  expect(trigger.taskId).toBe(task.id);
  expect((await getTaskById(task.id))?.status).toBe("in_progress");
  await getDbClient().run("UPDATE agent_tasks SET status = 'completed' WHERE id = ?", [task.id]);
  return trigger;
}

test("an admin gets channel then tool, with an absolute URL and persisted nudge attribution", async () => {
  process.env.APP_URL = "https://app.example.test/";
  const first = await pollTask();
  expect(first.checklistNudge).toEqual({
    itemId: "swarm:channel",
    kind: "channel",
    label: "Connect a chat channel",
    href: "https://app.example.test/integrations/channels",
  });
  expect((await listChecklist(userId, true))[0]).toMatchObject({
    nudgedAt: expect.any(String),
    nudgedTaskId: first.taskId,
  });
  expect((await pollTask()).checklistNudge?.itemId).toBe("swarm:tool");
});

test.each(["slack", "chat", "comb"] as const)("a %s human task gets a nudge", async (source) => {
  expect((await pollTask(source)).checklistNudge?.itemId).toBe("swarm:channel");
});

test("concurrent lead polls never repeat a swarm item across requesters", async () => {
  const otherUserId = (await createUser({ name: "Other nudge requester" })).id;
  const otherLeadId = crypto.randomUUID();
  await createAgent({ id: otherLeadId, name: otherLeadId, isLead: true, status: "idle" });
  const triggers = await Promise.all([pollTask(), pollTask("ui", otherUserId, otherLeadId)]);
  expect(triggers.map((trigger) => trigger.checklistNudge?.itemId).sort()).toEqual([
    "swarm:channel",
    "swarm:tool",
  ]);
});

test.each([
  "schedule",
  "system",
  "api",
  "mcp",
] as const)("a %s task gets no nudge", async (source) => {
  expect((await pollTask(source)).checklistNudge).toBeUndefined();
  expect((await listChecklist(userId, true))[0]?.nudgedAt).toBeNull();
});

test("a task without a requester gets no nudge", async () => {
  expect((await pollTask("ui", null)).checklistNudge).toBeUndefined();
});

test("a worker gets no nudge for a human task", async () => {
  const workerId = crypto.randomUUID();
  await createAgent({ id: workerId, name: workerId, isLead: false, status: "idle" });
  expect((await pollTask("ui", userId, workerId)).checklistNudge).toBeUndefined();
});

test("a member gets only their use case, once, with a relative root for a null href", async () => {
  await detachRole(userId, "admin");
  await attachRole(userId, "requester");
  await listChecklist(userId);
  await getDbClient().run("UPDATE checklist_items SET href = NULL WHERE userId = ?", [userId]);
  expect((await pollTask()).checklistNudge).toMatchObject({
    itemId: `user:${userId}:use_case`,
    href: "/",
  });
  expect((await pollTask()).checklistNudge).toBeUndefined();
  expect((await listChecklist(userId))[0]?.nudgedAt).toBeNull();
});

test("removed and done items never receive a nudge", async () => {
  const actor = { id: userId, userId, canEditSwarm: true };
  await mutateChecklist(actor, { action: "remove", id: "swarm:channel" });
  await mutateChecklist(actor, { action: "done", id: "swarm:tool" });
  expect((await pollTask()).checklistNudge?.itemId).toBe(`user:${userId}:use_case`);
  expect((await listChecklist(userId, true)).slice(0, 2).map((item) => item.nudgedAt)).toEqual([
    null,
    null,
  ]);
});

test("a checklist write failure rolls back the nudge but still hands out the task", async () => {
  await listChecklist(userId, true);
  await getDbClient().run(`CREATE TRIGGER fail_checklist_nudge AFTER UPDATE OF nudgedAt ON checklist_items
    BEGIN SELECT RAISE(FAIL, 'Checklist fixture failure'); END`);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const trigger = await pollTask();
    expect(trigger.checklistNudge).toBeUndefined();
    expect((await getTaskById(trigger.taskId))?.status).toBe("completed");
    const channel = await getDbClient().get<ChecklistItem>(
      "SELECT * FROM checklist_items WHERE id = 'swarm:channel'",
    );
    expect(channel?.nudgedAt).toBeNull();
    expect(channel?.nudgedTaskId).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[/api/poll] Checklist nudge failed:",
      "Checklist fixture failure",
    );
  } finally {
    warn.mockRestore();
    await getDbClient().run("DROP TRIGGER fail_checklist_nudge");
  }
  expect((await pollTask()).checklistNudge?.itemId).toBe("swarm:channel");
});
