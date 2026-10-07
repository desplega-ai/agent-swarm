import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  cancelTask,
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  failTask,
  getDbClient,
  getLogsByTaskId,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import { getEmbeddingProvider } from "../be/memory";
import { runTaskTerminalEffects } from "../tasks/task-terminal-effects";
import type { Agent, AgentTask } from "../types";
import { workflowEventBus } from "../workflows/event-bus";
import { randomToken, type SyntheticSecret, syntheticSecret } from "./synthetic-secret-helpers";

const TEST_DB_PATH = "./test-task-terminal-secret-scrub.sqlite";

let secret: SyntheticSecret;
let worker: Agent;
const embedInputs: string[] = [];

beforeAll(async () => {
  initDb(TEST_DB_PATH);
  // Never hit the network for embeddings; record what would have been sent.
  spyOn(getEmbeddingProvider(), "embed").mockImplementation(async (text: string) => {
    embedInputs.push(text);
    return null;
  });
  await createAgent({ name: "scrub-lead", isLead: true, status: "idle", capabilities: [] });
  worker = await createAgent({
    name: "scrub-worker",
    isLead: false,
    status: "idle",
    capabilities: [],
  });
});

// The test preload clears volatile secrets after every test, so register per test.
beforeEach(() => {
  secret = syntheticSecret("terminal");
});

afterAll(() => {
  secret.cleanup();
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {
      // ignore
    }
  }
});

async function startedTask(text: string, taskType?: string): Promise<AgentTask> {
  const task = await createTaskExtended(text, { agentId: worker.id, taskType });
  await startTask(task.id);
  return task;
}

/** Resolves on the next emit of `event`, then unsubscribes. */
function nextEvent(event: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const handler = (data: unknown) => {
      workflowEventBus.off(event, handler);
      resolve(data as Record<string, unknown>);
    };
    workflowEventBus.on(event, handler);
  });
}

async function waitFor<T>(read: () => Promise<T | null | undefined>, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await Bun.sleep(20);
  }
  throw new Error("timed out waiting for value");
}

type MemoryRow = { id: string; scope: string; name: string; content: string };

async function memoriesFor(taskId: string, count: number): Promise<MemoryRow[]> {
  return waitFor(async () => {
    const rows = await getDbClient().query<MemoryRow>(
      "SELECT id, scope, name, content FROM agent_memory WHERE sourceTaskId = ? ORDER BY scope",
      [taskId],
    );
    return rows.length >= count ? rows : null;
  });
}

async function ftsTextFor(memoryIds: string[]): Promise<string> {
  const parts: string[] = [];
  for (const id of memoryIds) {
    const row = await waitFor(() =>
      getDbClient().get<{ name: string; content: string }>(
        "SELECT name, content FROM memory_fts WHERE memory_id = ?",
        [id],
      ),
    );
    parts.push(row.name, row.content);
  }
  return parts.join("\n");
}

function expectRedacted(text: string, marker = `[REDACTED:${secret.name}]`): void {
  expect(text).not.toContain(secret.value);
  expect(text).toContain(marker);
}

describe("terminal task writes scrub secrets", () => {
  test("completeTask stores and emits the same redacted output", async () => {
    const task = await startedTask("complete with secret");
    const captured = nextEvent("task.completed");

    await completeTask(task.id, `deployed with token ${secret.value} ok`);
    const event = await captured;

    expectRedacted(String(event.output));
    expect(String(event.output)).toContain("deployed with token");
    const stored = await getTaskById(task.id);
    expect(stored!.output).toBe(event.output as string);
  });

  test("failTask emits a redacted failureReason", async () => {
    const task = await startedTask("fail with secret");
    const captured = nextEvent("task.failed");

    await failTask(task.id, `auth failed for ${secret.value}`);
    const event = await captured;

    expectRedacted(String(event.failureReason));
    expect(String(event.failureReason)).toContain("auth failed for");
  });

  test("cancelTask stores and logs a redacted reason", async () => {
    const task = await startedTask("cancel with secret");

    await cancelTask(task.id, `operator pasted ${secret.value}`);

    const stored = await getTaskById(task.id);
    expectRedacted(stored!.failureReason ?? "");
    expect(stored!.failureReason).toContain("operator pasted");
    const logs = JSON.stringify(
      (await getLogsByTaskId(task.id)).filter((l) => l.newValue === "cancelled"),
    );
    expectRedacted(logs);
  });
});

describe("runTaskTerminalEffects scrubs completion memory and the Lead follow-up", () => {
  test("completed research task: agent and swarm memory, FTS, embedding, follow-up", async () => {
    const dbTask = await startedTask("research placeholder", "research");
    // Raw task text as a caller might hold it; the chokepoint must scrub it.
    const task: AgentTask = { ...dbTask, task: `Look up ${secret.value} in the vault` };
    embedInputs.length = 0;

    await runTaskTerminalEffects({
      task,
      status: "completed",
      output: `Found it: ${secret.value}`,
      agentId: worker.id,
      persistMemory: true,
    });

    const rows = await memoriesFor(task.id, 2);
    expect(rows.map((r) => r.scope)).toEqual(["agent", "swarm"]);
    for (const row of rows) {
      expectRedacted(row.name);
      expectRedacted(row.content);
      expect(row.content).toContain("Found it:");
    }
    expectRedacted(await ftsTextFor(rows.map((r) => r.id)));
    const versions = await getDbClient().query<{ content: string }>(
      "SELECT content FROM agent_memory_version WHERE memory_id IN (?, ?)",
      [rows[0]!.id, rows[1]!.id],
    );
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) expectRedacted(v.content);
    expect(embedInputs.length).toBeGreaterThan(0);
    for (const input of embedInputs) expectRedacted(input);

    const followUp = await getDbClient().get<{ task: string }>(
      "SELECT task FROM agent_tasks WHERE parentTaskId = ? AND taskType = 'follow-up'",
      [task.id],
    );
    expect(followUp).toBeTruthy();
    expectRedacted(followUp!.task);
    expect(followUp!.task).toContain("Found it:");
  });

  test("failed task: memory and follow-up carry a redacted failure reason", async () => {
    const dbTask = await startedTask("failure placeholder");
    const task: AgentTask = { ...dbTask, task: `Rotate ${secret.value}` };

    await runTaskTerminalEffects({
      task,
      status: "failed",
      failureReason: `rejected key ${secret.value}`,
      agentId: worker.id,
      persistMemory: true,
    });

    const [row] = await memoriesFor(task.id, 1);
    expectRedacted(row!.name);
    expectRedacted(row!.content);
    expect(row!.content).toContain("rejected key");

    const followUp = await getDbClient().get<{ task: string }>(
      "SELECT task FROM agent_tasks WHERE parentTaskId = ? AND taskType = 'follow-up'",
      [task.id],
    );
    expect(followUp).toBeTruthy();
    expectRedacted(followUp!.task);
    expect(followUp!.task).toContain("rejected key");
  });

  test("short env secret in a KEY=value assignment is redacted in memory", async () => {
    const short = randomToken(8);
    const prev = process.env.DEMO_ACCOUNT_PASSWORD;
    process.env.DEMO_ACCOUNT_PASSWORD = short;
    try {
      const task = await startedTask("short secret control");
      await runTaskTerminalEffects({
        task,
        status: "completed",
        output: `env dump\nDEMO_ACCOUNT_PASSWORD=${short}\nPATH=/usr/bin`,
        agentId: worker.id,
        persistMemory: true,
      });

      const [row] = await memoriesFor(task.id, 1);
      expect(row!.content).not.toContain(short);
      expect(row!.content).toContain("DEMO_ACCOUNT_PASSWORD=[REDACTED:");
      expect(row!.content).toContain("PATH=/usr/bin");
    } finally {
      if (prev === undefined) delete process.env.DEMO_ACCOUNT_PASSWORD;
      else process.env.DEMO_ACCOUNT_PASSWORD = prev;
    }
  });
});

describe("workflow event bus backstop", () => {
  test("scrubs top-level strings and leaves other fields alone", async () => {
    const captured = nextEvent("x.test");
    const nested = { inner: secret.value };

    workflowEventBus.emit("x.test", { note: `leaked ${secret.value}`, n: 1, nested });
    const event = await captured;

    expectRedacted(String(event.note));
    expect(event.note).toContain("leaked");
    expect(event.n).toBe(1);
    // Shallow by design: nested objects pass through by reference.
    expect(event.nested).toBe(nested);
  });

  test("passes payloads without secrets through by reference", async () => {
    const captured = nextEvent("x.clean");
    const payload = { note: "nothing to hide", n: 2 };

    workflowEventBus.emit("x.clean", payload);

    expect(await captured).toBe(payload);
  });
});
