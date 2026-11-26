import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  getAgentById,
  getChildTasks,
  getTaskById,
  initDb,
  startTask,
  updateAgentStatus,
  updateTaskProgress,
} from "../be/db";
import { requestMemoStats, withRequestMemo } from "../be/request-memo";
import { getStorage } from "../be/storage";
import { renderThreadTree } from "../slack/render-v2";

const agentId = "dddd0000-0000-4000-8000-000000000d01";

function countReads() {
  const tasks = spyOn(getStorage().repos.tasks, "findTaskById");
  const agents = spyOn(getStorage().repos.agents, "findAgentById");
  return {
    tasks: () => tasks.mock.calls.length,
    agents: () => agents.mock.calls.length,
    restore: () => {
      tasks.mockRestore();
      agents.mockRestore();
    },
  };
}

async function newTask(): Promise<string> {
  const task = await createTaskExtended("request memo", {
    agentId,
    source: "system",
    followUpConfig: { disabled: true },
  });
  await startTask(task.id);
  return task.id;
}

let reads: ReturnType<typeof countReads> | undefined;
beforeAll(async () => {
  initDb(":memory:");
  await createAgent({ id: agentId, name: "Memo worker", isLead: false, status: "idle" });
});
afterEach(() => {
  reads?.restore();
  reads = undefined;
});
afterAll(() => closeDb());

describe("request-scoped task and agent memo", () => {
  test("repeat reads in one scope hit the database once and return independent copies", async () => {
    const id = await newTask();
    reads = countReads();
    await withRequestMemo(async () => {
      const first = await getTaskById(id);
      first!.progress = "mutated by a caller";
      const second = await getTaskById(id);
      await getTaskById(id);
      await getAgentById(agentId);
      await getAgentById(agentId);
      expect(second).not.toBe(first);
      expect(second!.progress).not.toBe("mutated by a caller");
      expect(requestMemoStats()).toEqual({ hits: 3, misses: 2 });
    });
    expect(reads.tasks()).toBe(1);
    expect(reads.agents()).toBe(1);
  });

  test("a write in the scope invalidates the memo: reads after it are fresh", async () => {
    const id = await newTask();
    await withRequestMemo(async () => {
      await getTaskById(id);
      await getAgentById(agentId);
      await updateTaskProgress(id, "after write");
      await updateAgentStatus(agentId, "busy");
      expect((await getTaskById(id))!.progress).toBe("after write");
      expect((await getAgentById(agentId))!.status).toBe("busy");
    });
  });

  test("a write from outside the scope (another request, a loop) also invalidates it", async () => {
    const id = await newTask();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scoped = withRequestMemo(async () => {
      await getTaskById(id);
      await gate;
      return (await getTaskById(id))!.progress;
    });
    await updateTaskProgress(id, "written elsewhere");
    release();
    expect(await scoped).toBe("written elsewhere");
  });

  test("detached work keeps the scope after the handler returns and still sees later writes", async () => {
    // A fire-and-forget workflow walk or a Slack render timer inherits the request scope.
    const id = await newTask();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let detached!: Promise<string | undefined>;
    await withRequestMemo(async () => {
      expect((await getTaskById(id))!.status).toBe("in_progress");
      detached = (async () => {
        await gate;
        const before = (await getTaskById(id))!.status;
        await completeTask(id, "done");
        return `${before}->${(await getTaskById(id))!.status}`;
      })();
    });
    await updateTaskProgress(id, "written after the response");
    release();
    expect(await detached).toBe("in_progress->completed");
    expect((await getTaskById(id))!.progress).toBe("written after the response");
  });

  test("a write inside a transaction is visible after it commits, and reads inside it skip the memo", async () => {
    const id = await newTask();
    reads = countReads();
    await withRequestMemo(async () => {
      await getTaskById(id);
      await getStorage().transaction(async () => {
        await getTaskById(id);
        await updateTaskProgress(id, "in transaction");
        expect((await getTaskById(id))!.progress).toBe("in transaction");
      });
      expect((await getTaskById(id))!.progress).toBe("in transaction");
    });
    // One scoped miss, two in-transaction passthroughs, one miss after the write.
    expect(reads.tasks()).toBe(4);
  });

  test("outside a scope every read goes to the database", async () => {
    const id = await newTask();
    reads = countReads();
    await getTaskById(id);
    await getTaskById(id);
    await getAgentById(agentId);
    await getAgentById(agentId);
    expect(requestMemoStats()).toBeUndefined();
    expect(reads.tasks()).toBe(2);
    expect(reads.agents()).toBe(2);
  });

  test("Slack thread tree render: one agent read per agent instead of one per node", async () => {
    const root = await newTask();
    for (let i = 0; i < 10; i++) {
      await createTaskExtended(`child ${i}`, {
        agentId,
        parentTaskId: root,
        source: "system",
        followUpConfig: { disabled: true },
      });
    }
    const tasks = [(await getTaskById(root))!, ...(await getChildTasks(root))];
    const now = new Date();
    reads = countReads();
    const unscoped = await renderThreadTree(tasks, new Map(), now);
    const before = reads.agents();
    reads.restore();
    reads = countReads();
    const scoped = await withRequestMemo(() => renderThreadTree(tasks, new Map(), now));
    expect(scoped).toBe(unscoped);
    expect(before).toBe(11);
    expect(reads.agents()).toBe(1);
  });
});
