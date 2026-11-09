import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createWorkflow,
  createWorkflowRun,
  getDbClient,
  initDb,
} from "../be/db";
import gather from "../be/seed-scripts/catalog/dreaming-gather";

const TEST_DB_PATH = "./test-dreaming-gather-corrections.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // absent
    }
  }
}

const ctx = {
  swarm: {
    db_query: async ({ sql, params }: { sql: string; params?: unknown[] }) => {
      const out = await getDbClient().query<Record<string, unknown>>(
        sql,
        (params ?? []) as never[],
      );
      const columns = out.length ? Object.keys(out[0]!) : [];
      return { columns, rows: out.map((r) => columns.map((c) => r[c])) };
    },
    kv_getOrNull: async () => null,
  },
} as any;

const ago = (h: number) => new Date(Date.now() - h * 3600000).toISOString();
let agentId = "";
let wf = "";

async function memory(
  name: string,
  opts: { source?: string; chunks?: string[]; createdHoursAgo?: number } = {},
): Promise<string> {
  const chunks = opts.chunks ?? [`body of ${name}`];
  const createdAt = ago(opts.createdHoursAgo ?? 48);
  let first = "";
  for (const [i, content] of chunks.entries()) {
    const id = crypto.randomUUID();
    if (i === 0) first = id;
    await getDbClient().run(
      `INSERT INTO agent_memory (id, agentId, scope, name, content, source, chunkIndex, totalChunks, createdAt, accessedAt)
       VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?)`,
      [id, agentId, name, content, opts.source ?? "manual", i, chunks.length, createdAt, createdAt],
    );
  }
  return first;
}

async function rating(
  memoryId: string,
  opts: { source?: string; signal?: number; note?: string | null; hoursAgo?: number } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await getDbClient().run(
    `INSERT INTO memory_rating (id, memoryId, source, signal, weight, reasoning, createdAt) VALUES (?, ?, ?, ?, 1, ?, ?)`,
    [
      id,
      memoryId,
      opts.source ?? "explicit-self",
      opts.signal ?? -1,
      opts.note === undefined ? "claim is stale" : opts.note,
      ago(opts.hoursAgo ?? 2),
    ],
  );
  return id;
}

/** A finished earlier run whose synthesize step returned `taskOutput`. */
async function pastSynthesis(taskOutput: unknown, triggerData: unknown = {}): Promise<void> {
  const runId = crypto.randomUUID();
  await createWorkflowRun({ id: runId, workflowId: wf, triggerType: "manual", triggerData });
  await getDbClient().run(
    `UPDATE workflow_runs SET startedAt = ?, status = 'completed' WHERE id = ?`,
    [ago(20), runId],
  );
  await getDbClient().run(
    `INSERT INTO workflow_run_steps (id, runId, nodeId, nodeType, status, output, startedAt) VALUES (?, ?, 'synthesize', 'agent-task', 'completed', ?, ?)`,
    [crypto.randomUUID(), runId, JSON.stringify({ taskOutput }), ago(20)],
  );
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  agentId = (await createAgent({ name: "gather-corrections-lead", isLead: true, status: "idle" }))
    .id;
  wf = (await createWorkflow({ name: "dreaming", definition: { nodes: [] } })).id;
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

describe("dreaming-gather correction queue", () => {
  test("queues unhandled negative explicit-self notes and skips every handled or out-of-scope one", async () => {
    const queued = await memory("queued", { createdHoursAgo: 72 });
    const older = await rating(queued, { note: "older note", hoursAgo: 30 });
    const newer = await rating(queued, { note: "newer note", hoursAgo: 3 });

    await rating(await memory("positive"), { signal: 1 });
    await rating(await memory("other-source"), { source: "auto" });
    await rating(await memory("empty-note"), { note: "  " });
    await rating(await memory("task-completion", { source: "task_completion" }));

    const edited = await memory("edited");
    await rating(edited, { hoursAgo: 10 });
    await getDbClient().run(
      `INSERT INTO agent_memory_version (id, memory_id, version, content, intent, operation, createdAt, updatedAt)
       VALUES (?, ?, 2, 'fixed', 'edit', 'edit', ?, ?)`,
      [crypto.randomUUID(), edited, ago(5), ago(5)],
    );

    const rejected = await rating(await memory("rejected"));
    const capped = await memory("capped");
    const cappedRating = await rating(capped, { hoursAgo: 2.5 });
    const proposed = await rating(await memory("proposed"));
    const dryOnly = await memory("dry-only");
    const dryRating = await rating(dryOnly);
    await pastSynthesis({
      rejected: [
        {
          from: "swarm.memory.corrections",
          item: `rating:${rejected}`,
          reason: "gh shows the claim still holds",
        },
        {
          from: "swarm.memory.corrections",
          item: `rating:${cappedRating}`,
          reason: "cap: memoryEdit",
        },
      ],
      actions: [{ id: "A1", tier: "propose", evidence: [`rating:${proposed}`, "task:t1"] }],
    });
    await pastSynthesis(
      {
        rejected: [
          {
            from: "swarm.memory.corrections",
            item: `rating:${dryRating}`,
            reason: "not confirmed",
          },
        ],
      },
      { dryRun: true },
    );

    const multi = await memory("multi", {
      chunks: ["part one of the long memory body", "part two"],
    });
    await rating(multi, { hoursAgo: 1 });

    const runId = crypto.randomUUID();
    await createWorkflowRun({ id: runId, workflowId: wf, triggerType: "manual" });
    const out: any = await gather({ runId }, ctx);
    const c = out.swarm.memory.corrections;

    expect(
      out.errors.filter(
        (e: string) => e.startsWith("memCorrection") || e.startsWith("corrections"),
      ),
    ).toEqual([]);
    expect(c.ok).toBe(true);
    expect(c.cap).toBe(10);
    // Oldest first note decides the order; the cap-rejected and dry-run-rejected notes come back.
    expect(c.items.map((x: any) => x.name)).toEqual(["queued", "capped", "dry-only", "multi"]);
    expect(c.backlog).toBe(4);
    expect(c.items[0].notes.map((n: any) => [n.ratingId, n.note])).toEqual([
      [newer, "newer note"],
      [older, "older note"],
    ]);
    expect(c.items[0].content).toBe("body of queued");
    expect(c.items[0].multiChunk).toBe(false);
    const m = c.items.find((x: any) => x.name === "multi");
    expect(m.multiChunk).toBe(true);
    expect(m.content).toContain("part one");
    expect(m.content).toContain("part two");
  });
});
