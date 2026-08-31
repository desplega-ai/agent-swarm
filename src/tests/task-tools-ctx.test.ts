import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  claimTask,
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getTaskById,
  initDb,
  updateAgentProfile,
} from "../be/db";
import { getTasksHandler } from "../tools/get-tasks";
import { sendTaskHandler } from "../tools/send-task";
import { assertOwnsTask, ownerCtx, userCtx } from "../tools/task-tool-ctx";

const TEST_DB_PATH = "./test-task-tools-ctx.sqlite";

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

describe("task tool ctx", () => {
  test("sendTaskHandler with user ctx writes requestedByUserId", async () => {
    const user = await createUser({ name: "MCP User" });

    const result = await sendTaskHandler(userCtx(user), {
      task: "user requested task",
      offerMode: false,
      allowDuplicate: false,
    });

    // NEW CONTRACT: handlers return a SwarmToolResult ({ ok, message, data }),
    // not a wire-level CallToolResult with structuredContent — the registrar
    // composes structuredContent (data spread + success/message) only at the
    // registerTool boundary, not inside the handler itself.
    expect(result.ok).toBe(true);
    const data = result.data as { task: { id: string; requestedByUserId?: string } };
    expect(data.task.requestedByUserId).toBe(user.id);

    const stored = await getTaskById(data.task.id);
    expect(stored?.creatorAgentId).toBeUndefined();
    expect(stored?.requestedByUserId).toBe(user.id);
  });

  test("send-task directly assigns an ordinary task to a Lead", async () => {
    const sender = await createAgent({
      name: "ordinary-task sender",
      isLead: false,
      status: "idle",
    });
    const lead = await createAgent({ name: "ordinary-task lead", isLead: true, status: "idle" });

    const result = await sendTaskHandler(ownerCtx({ agentId: sender.id }), {
      task: "ordinary direct assignment",
      agentId: lead.id,
      offerMode: false,
      allowDuplicate: false,
    });

    expect(result.ok).toBe(true);
    const data = result.data as { task: { id: string; agentId?: string } };
    expect(data.task.agentId).toBe(lead.id);
    expect((await getTaskById(data.task.id))?.agentId).toBe(lead.id);
  });

  test("send-task offers an ordinary task to a Lead", async () => {
    const sender = await createAgent({
      name: "ordinary-offer sender",
      isLead: false,
      status: "idle",
    });
    const lead = await createAgent({ name: "ordinary-offer lead", isLead: true, status: "idle" });

    const result = await sendTaskHandler(ownerCtx({ agentId: sender.id }), {
      task: "ordinary offer",
      agentId: lead.id,
      offerMode: true,
      allowDuplicate: false,
    });

    expect(result.ok).toBe(true);
    const data = result.data as { task: { id: string; offeredTo?: string } };
    expect(data.task.offeredTo).toBe(lead.id);
    expect((await getTaskById(data.task.id))?.offeredTo).toBe(lead.id);
  });

  test("send-task continuations cannot shed lead-only parent capabilities when omitted or empty", async () => {
    const lead = await createAgent({ name: "continuation lead", isLead: true, status: "idle" });
    const underprivilegedLead = await createAgent({
      name: "continuation underprivileged lead",
      isLead: true,
      status: "idle",
    });
    const sender = await createAgent({
      name: "continuation sender",
      isLead: false,
      status: "idle",
    });
    await updateAgentProfile(lead.id, { capabilities: ["merge"] });
    await updateAgentProfile(underprivilegedLead.id, { capabilities: ["typescript"] });
    const parent = await createTaskExtended("privileged parent", {
      agentId: lead.id,
      routingAffinity: { capabilities: ["merge"], leadOnly: true },
    });

    for (const requiredCapabilities of [undefined, []] as const) {
      const result = await sendTaskHandler(ownerCtx({ agentId: sender.id }), {
        task: `attempted ordinary child ${requiredCapabilities ? "empty" : "omitted"}`,
        parentTaskId: parent.id,
        ...(requiredCapabilities !== undefined ? { requiredCapabilities } : {}),
        offerMode: true,
        allowDuplicate: false,
      });

      expect(result.ok).toBe(true);
      const data = result.data as { task: { id: string } };
      const child = await getTaskById(data.task.id);
      expect(child?.routingAffinity).toMatchObject({ leadOnly: true, capabilities: ["merge"] });
      expect(await claimTask(data.task.id, underprivilegedLead.id)).toBeNull();
    }
  });

  test("getTasksHandler with user ctx only returns that user's tasks", async () => {
    const userA = await createUser({ name: "List User A" });
    const userB = await createUser({ name: "List User B" });

    const a1 = await createTaskExtended("owned task one", { requestedByUserId: userA.id });
    const a2 = await createTaskExtended("owned task two", { requestedByUserId: userA.id });
    const b1 = await createTaskExtended("foreign task", { requestedByUserId: userB.id });
    await createTaskExtended("owner-only task");

    const result = await getTasksHandler(userCtx(userA), {
      includeFull: true,
      includeHeartbeat: true,
      limit: 50,
      mineOnly: true,
      offeredToMe: true,
    });

    expect(result.ok).toBe(true);
    const data = result.data as { tasks: Array<{ id: string; task?: string }> };
    const ids = data.tasks.map((task) => task.id);
    expect(ids).toContain(a1.id);
    expect(ids).toContain(a2.id);
    expect(ids).not.toContain(b1.id);
    expect(data.tasks.every((task) => task.task?.startsWith("owned task"))).toBe(true);
  });

  test("getTasksHandler renders compact escaped markdown without changing structured tasks", async () => {
    const user = await createUser({ name: "Markdown List User" });
    const taskText = "triage | path\\one\nsecond line";
    const task = await createTaskExtended(taskText, { requestedByUserId: user.id });

    const result = await getTasksHandler(userCtx(user), {
      includeFull: true,
      includeHeartbeat: true,
      limit: 50,
    });

    expect(result.details).toContain("| ID | Status | Priority | Agent | Task |");
    expect(result.details).toContain("triage \\| path\\\\one<br>second line");
    expect(result.details).not.toContain('"tasks":');
    const data = result.data as { tasks: Array<{ id: string; task?: string }> };
    expect(data.tasks.find((row) => row.id === task.id)?.task).toBe(taskText);
  });

  test("getTasksHandler uses a human empty-state instead of a raw data fallback", async () => {
    const user = await createUser({ name: "Empty List User" });
    const result = await getTasksHandler(userCtx(user), {
      includeHeartbeat: true,
      limit: 50,
    });

    expect(result.details).toBe("No tasks matched the current filters.");
    expect((result.data as { tasks: unknown[] }).tasks).toEqual([]);
  });

  test("assertOwnsTask gates user tasks and allows owned or owner ctx", async () => {
    const owner = await createUser({ name: "Task Owner" });
    const foreignUser = await createUser({ name: "Foreign User" });
    const ownedTask = await createTaskExtended("owned", { requestedByUserId: owner.id });

    expect(assertOwnsTask(userCtx(owner), ownedTask)).toBeNull();
    expect(
      assertOwnsTask(
        ownerCtx({
          agentId: "00000000-0000-4000-8000-000000000001",
          sourceTaskId: undefined,
          sessionId: "session-1",
        }),
        ownedTask,
      ),
    ).toBeNull();

    // NEW CONTRACT: assertOwnsTask returns a SwarmToolResult | null, not a wire
    // CallToolResult — isError/content/structuredContent are only synthesized
    // by finalizeSwarmToolResult at the registrar boundary. Assert ok:false +
    // the real error text in `message` + the payload under `data`.
    const forbidden = assertOwnsTask(userCtx(foreignUser), ownedTask);
    expect(forbidden?.ok).toBe(false);
    expect(forbidden?.message).toContain("this task is not yours");
    expect((forbidden?.data as { code?: string })?.code).toBe("forbidden");
  });
});
