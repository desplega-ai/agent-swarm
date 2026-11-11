// Operator-only agent delete and restore through the append-only agent_history
// table (migration 334): blockers, snapshot round trip, append-only triggers, tokens.
// The HTTP routes, the 410 on re-register and RBAC live in the e2e scenario
// scripts/e2e/scenarios/core-agent-lifecycle.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  AgentHistoryError,
  deleteAgentToHistory,
  listAgentHistory,
  restoreAgentFromHistory,
} from "../be/agent-history";
import {
  AgentDeletedError,
  closeDb,
  createAgent,
  createScheduledTask,
  createSkill,
  createTaskExtended,
  getAgentById,
  getDbClient,
  initDb,
  isAgentDeleted,
} from "../be/db";
import {
  mintAgentToken,
  mintRuntimeToken,
  mintScriptRunToken,
  mintSessionToken,
} from "../be/users";
import { ensureExtensionAgent } from "../extensions/identity";
import { handleAgentRegister } from "../http/agents";
import { handleCore } from "../http/core";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = `./test-agent-history-${crypto.randomUUID()}.sqlite`;
const API_KEY = "agent-history-key";
const OP = "op:test";

let server: Server;
let baseUrl = "";
let leadId = "";

async function offlineWorker(name: string) {
  return await createAgent({ name, isLead: false, status: "offline" });
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AgentHistoryError) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
}

const rowOf = (id: string) =>
  getDbClient().get<Record<string, unknown>>("SELECT * FROM agents WHERE id = ?", [id]);

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) await unlink(TEST_DB_PATH + suffix).catch(() => {});
  initDb(TEST_DB_PATH);
  // Every agent gets an agent_skills row, a NO ACTION foreign key the delete must clear.
  await createSkill({
    name: "ah-default",
    description: "Default",
    content: "Instructions",
    type: "personal",
    scope: "swarm",
    systemDefault: true,
  });
  leadId = (await createAgent({ name: "ah-lead", isLead: true, status: "idle" })).id;
  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleCore(req, res, myAgentId, API_KEY)) return;
    const pathSegments = getPathSegments(req.url ?? "");
    const query = parseQueryParams(req.url ?? "");
    if (await handleTasks(req, res, pathSegments, query, myAgentId)) return;
    if (await handleAgentRegister(req, res, pathSegments, myAgentId)) return;
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) await unlink(TEST_DB_PATH + suffix).catch(() => {});
});

describe("blockers", () => {
  test("open or offered task, live worker, schedule, owned skill, lead and extension refuse", async () => {
    const pinned = await offlineWorker("ah-open-task");
    await createTaskExtended("pinned work", { agentId: pinned.id });
    expect(await refusal(deleteAgentToHistory(pinned.id, "retired", OP))).toBe("open_tasks");

    const offered = await offlineWorker("ah-offered");
    await createTaskExtended("offer", { offeredTo: offered.id });
    expect(await refusal(deleteAgentToHistory(offered.id, "retired", OP))).toBe("open_tasks");

    const live = await createAgent({ name: "ah-live", isLead: false, status: "idle" });
    expect(await refusal(deleteAgentToHistory(live.id, "retired", OP))).toBe("not_offline");

    const scheduled = await offlineWorker("ah-scheduled");
    await createScheduledTask({
      name: "ah-schedule",
      taskTemplate: "tick",
      cronExpression: "0 * * * *",
      targetAgentId: scheduled.id,
    });
    expect(await refusal(deleteAgentToHistory(scheduled.id, "retired", OP))).toBe("schedules");

    const owner = await offlineWorker("ah-owner");
    await createSkill({
      name: "ah-owned",
      description: "Owned",
      content: "x",
      type: "personal",
      scope: "agent",
      ownerAgentId: owner.id,
    });
    expect(await refusal(deleteAgentToHistory(owner.id, "retired", OP))).toBe("owned_skills");

    await getDbClient().run("UPDATE agents SET status = 'offline' WHERE id = ?", [leadId]);
    expect(await refusal(deleteAgentToHistory(leadId, "retired", OP))).toBe("lead");
    await getDbClient().run("UPDATE agents SET status = 'idle' WHERE id = ?", [leadId]);

    const extId = await ensureExtensionAgent("ah-tracker");
    await getDbClient().run("UPDATE agents SET status = 'offline' WHERE id = ?", [extId]);
    expect(await refusal(deleteAgentToHistory(extId, "retired", OP))).toBe("extension");

    for (const id of [pinned.id, offered.id, live.id, scheduled.id, owner.id, leadId, extId]) {
      expect(await getAgentById(id)).not.toBeNull();
    }
    expect(await listAgentHistory()).toEqual([]);
  });
});

describe("delete and restore", () => {
  test("delete removes the row; restore reinserts the same columns under the same id", async () => {
    const agent = await offlineWorker("ah-roundtrip");
    await getDbClient().run(
      "UPDATE agents SET description = 'keeps', identityMd = '# me', maxTasks = 3 WHERE id = ?",
      [agent.id],
    );
    const before = await rowOf(agent.id);

    const deleted = await deleteAgentToHistory(agent.id, "retired worker", OP);
    expect(deleted).toMatchObject({ event: "deleted", actorRef: OP, snapshot: before! });
    expect(await rowOf(agent.id)).toBeNull();
    expect(await isAgentDeleted(agent.id)).toBe(true);
    expect(await refusal(deleteAgentToHistory(agent.id, "again", OP))).toBe("not_found");

    const { agent: restored, event } = await restoreAgentFromHistory(
      agent.id,
      { reason: "came back" },
      OP,
    );
    expect(event.event).toBe("restored");
    expect(restored.name).toBe("ah-roundtrip");
    const after = await rowOf(agent.id);
    expect({ ...after, lastUpdatedAt: null }).toEqual({ ...before, lastUpdatedAt: null });
    // System-default skills come back with the agent.
    const skills = await getDbClient().query("SELECT 1 FROM agent_skills WHERE agentId = ?", [
      agent.id,
    ]);
    expect(skills.length).toBe(1);
    expect(await isAgentDeleted(agent.id)).toBe(false);
    expect(await refusal(restoreAgentFromHistory(agent.id, { reason: "x" }, OP))).toBe(
      "not_deleted",
    );
    expect((await listAgentHistory(agent.id)).map((e) => e.event)).toEqual(["restored", "deleted"]);
  });

  test("restore under a taken name refuses until newName is given", async () => {
    const agent = await offlineWorker("ah-name");
    await deleteAgentToHistory(agent.id, "retired worker", OP);
    await offlineWorker("ah-name");
    expect(await refusal(restoreAgentFromHistory(agent.id, { reason: "back" }, OP))).toBe(
      "name_taken",
    );
    const { agent: restored } = await restoreAgentFromHistory(
      agent.id,
      { reason: "back", newName: "ah-name-2" },
      OP,
    );
    expect(restored.name).toBe("ah-name-2");
  });

  test("agent_history is append-only", async () => {
    const agent = await offlineWorker("ah-append-only");
    await deleteAgentToHistory(agent.id, "retired worker", OP);
    await expect(getDbClient().run("UPDATE agent_history SET reason = 'edited'")).rejects.toThrow(
      "append-only",
    );
    await expect(getDbClient().run("DELETE FROM agent_history")).rejects.toThrow("append-only");
  });
});

describe("registration racing an operator delete", () => {
  test("a delete that commits before the register transaction gets 410, not a recreated row", async () => {
    const worker = await offlineWorker("ah-race");
    // Pause the register request at its transaction, the window where a pre-transaction
    // history check went stale, and run the whole operator delete there.
    const client = getDbClient();
    const transaction = client.transaction;
    let paused!: () => void;
    const atTransaction = new Promise<void>((resolve) => (paused = resolve));
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => (resume = resolve));
    let armed = true;
    client.transaction = (async (...args: Parameters<typeof transaction>) => {
      if (armed) {
        armed = false;
        paused();
        await gate;
      }
      return await transaction.apply(client, args);
    }) as typeof transaction;
    try {
      const registration = fetch(`${baseUrl}/api/agents`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "X-Agent-ID": worker.id,
          "Content-Type": "application/json",
        },
        // Accepted with the multi-runtime flag on or off.
        body: JSON.stringify({ name: "ah-race", runtimeInstanceId: `rt-${crypto.randomUUID()}` }),
      });
      await atTransaction;
      await deleteAgentToHistory(worker.id, "retired worker", OP);
      resume();
      const response = await registration;
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 410,
        body: { error: "agent_deleted" },
      });
    } finally {
      client.transaction = transaction;
    }
    expect(await getAgentById(worker.id)).toBeNull();
    expect(await isAgentDeleted(worker.id)).toBe(true);
    // createAgent is the shared insert (register, join-swarm, token mint, pools, extensions).
    await expect(
      createAgent({ id: worker.id, name: "ah-race", isLead: false, status: "offline" }),
    ).rejects.toBeInstanceOf(AgentDeletedError);
    await restoreAgentFromHistory(worker.id, { reason: "back" }, OP);
  });
});

describe("credentials of a deleted agent", () => {
  const HOUR = 60 * 60 * 1000;

  async function createTaskAs(token: string): Promise<number> {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ task: "token probe" }),
    });
    await res.text();
    return res.status;
  }

  test("every token kind minted before the delete gets 401 after it, restore included", async () => {
    const worker = await offlineWorker("ah-tokens");
    const agentToken = await mintAgentToken(worker.id);
    const tokens = {
      agent: agentToken.plaintext,
      agentChild: (
        await mintSessionToken(worker.id, crypto.randomUUID(), HOUR, {
          tokenId: agentToken.tokenId,
          runtimeId: null,
        })
      ).plaintext,
      runtime: (await mintRuntimeToken(worker.id, `rt-${crypto.randomUUID()}`)).plaintext,
      task: (await mintSessionToken(worker.id, crypto.randomUUID(), HOUR)).plaintext,
      scriptRun: (await mintScriptRunToken(worker.id, HOUR)).plaintext,
    };
    // Controls: the agent and runtime kinds create tasks while the agent lives.
    expect(await createTaskAs(tokens.agent)).toBe(201);
    expect(await createTaskAs(tokens.runtime)).toBe(201);
    // Close the probe tasks so the open_tasks blocker passes.
    await getDbClient().run(
      "UPDATE agent_tasks SET status = 'cancelled' WHERE agentId = ? OR creatorAgentId = ?",
      [worker.id, worker.id],
    );

    await deleteAgentToHistory(worker.id, "retired worker", OP);
    const refused = Object.fromEntries(Object.keys(tokens).map((kind) => [kind, 401]));
    const statuses = async () => {
      const out: Record<string, number> = {};
      for (const [kind, token] of Object.entries(tokens)) out[kind] = await createTaskAs(token);
      return out;
    };
    expect(await statuses()).toEqual(refused);

    await restoreAgentFromHistory(worker.id, { reason: "back" }, OP);
    expect(await statuses()).toEqual(refused);
    expect(await createTaskAs((await mintAgentToken(worker.id)).plaintext)).toBe(201);
  });
});
