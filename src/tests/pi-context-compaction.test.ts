/**
 * Pi's `context` hook fires before every LLM call. It must report usage as a
 * `progress` snapshot; only `session_compact` reports a compaction. Migration
 * 219 relabels the trigger-less pi compaction rows written before the fix.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type {
  ContextEvent,
  ExtensionFactory,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { CreateContextSnapshotInput } from "../be/db";
import {
  closeDb,
  createAgent,
  createContextSnapshot,
  createTaskExtended,
  getContextSnapshotsByTaskId,
  getContextSummaryByTaskId,
  initDb,
} from "../be/db";
import { createSwarmHooksExtension } from "../providers/pi-mono-extension";

const TEST_DB_PATH = "./test-pi-context-compaction.sqlite";
const agentId = "aaaa0000-0000-4000-8000-0000000000a1";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

let db: Database;
const origFetch = globalThis.fetch;

async function removeDbFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // File doesn't exist
    }
  }
}

beforeAll(async () => {
  await removeDbFiles();
  db = initDb(TEST_DB_PATH);
  await createAgent({ id: agentId, name: "Pi Worker", isLead: false, status: "idle" });
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

async function createTask(provider: string): Promise<string> {
  const task = await createTaskExtended(`context compaction ${provider}`, {
    agentId,
    source: "mcp",
  });
  db.run("UPDATE agent_tasks SET provider = ? WHERE id = ?", [provider, task.id]);
  return task.id;
}

/**
 * Load the extension and route its `/context` POSTs into the real snapshot
 * writer, the same path `POST /api/tasks/:id/context` takes.
 */
function loadExtension(taskId: string) {
  const handlers = new Map<string, Handler>();
  const pending: Promise<unknown>[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.endsWith(`/api/tasks/${taskId}/context`) && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Omit<
        CreateContextSnapshotInput,
        "taskId" | "agentId"
      >;
      const write = createContextSnapshot({ ...body, taskId, agentId });
      pending.push(write);
      await write;
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    sendMessage: () => {},
    registerMcpServer: () => {},
  };
  createSwarmHooksExtension({
    apiUrl: "http://localhost:3013",
    apiKey: "example-test-key",
    agentId,
    taskId,
    isLead: false,
  })(pi as unknown as Parameters<ExtensionFactory>[0]);

  let tokens = 0;
  const ctx = {
    getContextUsage: () => ({ tokens, contextWindow: 1_000_000, percent: tokens / 10_000 }),
  };
  const fire = async (event: ContextEvent | SessionCompactEvent, usedTokens: number) => {
    tokens = usedTokens;
    await handlers.get(event.type)?.(event, ctx);
    await Promise.all(pending);
  };
  return { fire };
}

describe("pi context hook", () => {
  test("per-call context usage is progress; only session_compact counts", async () => {
    const taskId = await createTask("pi");
    const { fire } = loadExtension(taskId);

    for (const used of [82_000, 94_000, 94_400]) {
      await fire({ type: "context", messages: [] }, used);
    }

    let snapshots = await getContextSnapshotsByTaskId(taskId);
    expect(snapshots.length).toBe(3);
    expect(snapshots.filter((s) => s.eventType === "compaction")).toEqual([]);
    let summary = await getContextSummaryByTaskId(taskId);
    expect(summary.compactionCount).toBe(0);
    expect(summary.peakContextTokens).toBe(94_400);

    await fire(
      {
        type: "session_compact",
        reason: "threshold",
        willRetry: false,
        fromExtension: false,
        compactionEntry: {
          type: "compaction",
          id: "c1",
          parentId: null,
          timestamp: new Date().toISOString(),
          summary: "s",
          firstKeptEntryId: "e1",
          tokensBefore: 120_000,
        },
      },
      30_000,
    );

    snapshots = await getContextSnapshotsByTaskId(taskId);
    const compactions = snapshots.filter((s) => s.eventType === "compaction");
    expect(compactions.length).toBe(1);
    expect(compactions[0]?.compactTrigger).toBe("auto");
    expect(compactions[0]?.preCompactTokens).toBe(120_000);
    summary = await getContextSummaryByTaskId(taskId);
    expect(summary.compactionCount).toBe(1);
  });
});

describe("migration 219", () => {
  test("relabels trigger-less pi compactions and leaves other rows alone", async () => {
    const piTask = await createTask("pi");
    const claudeTask = await createTask("claude");
    const snapshot = (taskId: string, sessionId: string, extra = {}) =>
      createContextSnapshot({
        taskId,
        agentId,
        sessionId,
        eventType: "compaction",
        contextPercent: 9,
        ...extra,
      });

    await snapshot(piTask, `pi-${piTask}`);
    await snapshot(piTask, `pi-${piTask}`);
    await snapshot(piTask, `pi-${piTask}`, { compactTrigger: "auto", preCompactTokens: 150_000 });
    await snapshot(claudeTask, "claude-session");
    expect((await getContextSummaryByTaskId(piTask)).compactionCount).toBe(3);

    db.exec(await Bun.file("src/be/migrations/219_relabel_pi_context_compactions.sql").text());

    const piRows = await getContextSnapshotsByTaskId(piTask);
    expect(piRows.map((s) => s.eventType).sort()).toEqual(["compaction", "progress", "progress"]);
    expect(piRows.find((s) => s.eventType === "compaction")?.preCompactTokens).toBe(150_000);
    expect((await getContextSummaryByTaskId(piTask)).compactionCount).toBe(1);

    const claudeRows = await getContextSnapshotsByTaskId(claudeTask);
    expect(claudeRows.map((s) => s.eventType)).toEqual(["compaction"]);
    expect((await getContextSummaryByTaskId(claudeTask)).compactionCount).toBe(1);
  });
});
