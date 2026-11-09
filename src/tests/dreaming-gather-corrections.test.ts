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

describe("dreaming-gather correction queue: bodies and chunks", () => {
  async function freshRun(): Promise<any> {
    const runId = crypto.randomUUID();
    await createWorkflowRun({ id: runId, workflowId: wf, triggerType: "manual" });
    const out: any = await gather({ runId }, ctx);
    expect(out.errors.filter((e: string) => e.startsWith("memCorrection"))).toEqual([]);
    return out.swarm.memory.corrections;
  }

  async function reset(): Promise<void> {
    await getDbClient().run(`DELETE FROM memory_rating`);
    await getDbClient().run(`DELETE FROM agent_memory_version`);
    await getDbClient().run(`DELETE FROM agent_memory`);
  }

  test("a single-chunk body is sent whole, never cut to a prefix synthesis could write back", async () => {
    await reset();
    const long = `${"a".repeat(2990)} TAIL-MARKER ${"b".repeat(2000)}`; // 5,003 chars, one chunk
    const id = await memory("long-single", { chunks: [long] });
    await rating(id);
    const c = await freshRun();
    const item = c.items.find((x: any) => x.memoryId === id);
    expect(item.multiChunk).toBe(false);
    expect(item.content).toBe(long);
    expect(item.content).toContain("TAIL-MARKER");
    expect(item.contentTruncated).toBe(false);
    expect(c.oversize).toBe(0);
  });

  test("a single-chunk body over the limit is held out, counted, and does not take a queue slot", async () => {
    await reset();
    const huge = await memory("huge-single", { chunks: ["x".repeat(8001)], createdHoursAgo: 96 });
    await rating(huge, { hoursAgo: 40 }); // oldest note: would take slot 1
    const next = await memory("next-in-line");
    await rating(next, { hoursAgo: 5 });
    const c = await freshRun();
    expect(c.items.map((x: any) => x.name)).toEqual(["next-in-line"]);
    expect(c.oversize).toBe(1);
    expect(c.backlog).toBe(2);
    expect(c.items.some((x: any) => x.content.length > 3000 && x.contentTruncated)).toBe(false);
  });

  test("an oversize-only backlog still reports its counts", async () => {
    await reset();
    await rating(await memory("only-huge", { chunks: ["y".repeat(9000)] }));
    const c = await freshRun();
    expect(c.ok).toBe(true);
    expect(c.items).toEqual([]);
    expect(c.oversize).toBe(1);
    expect(c.backlog).toBe(1);
  });

  test("a long multi-chunk body is cut and flagged; it is multiChunk, so apply only proposes", async () => {
    await reset();
    const id = await memory("long-multi", { chunks: ["p".repeat(2000), "q".repeat(2000)] });
    await rating(id);
    const c = await freshRun();
    const item = c.items.find((x: any) => x.memoryId === id);
    expect(item.multiChunk).toBe(true);
    expect(item.content.length).toBe(3000);
    expect(item.contentTruncated).toBe(true);
  });

  test("a rating on a later chunk reaches synthesis under the document's chunk-0 id", async () => {
    await reset();
    const first = await memory("chunked", {
      chunks: ["head of the doc", "middle part", "stale tail claim"],
    });
    const rows = await getDbClient().query<{ id: string; chunkIndex: number }>(
      `SELECT id, chunkIndex FROM agent_memory WHERE name = 'chunked' ORDER BY chunkIndex`,
    );
    const tail = rows[2]!.id;
    const onTail = await rating(tail, { note: "tail claim is stale", hoursAgo: 3 });
    const onHead = await rating(first, { note: "head is fine but tail is not", hoursAgo: 6 });
    const c = await freshRun();
    expect(c.items.length).toBe(1);
    const item = c.items[0];
    expect(item.memoryId).toBe(first);
    expect(item.multiChunk).toBe(true);
    expect(item.content).toContain("stale tail claim");
    expect(item.notes.map((n: any) => [n.ratingId, n.ratedMemoryId])).toEqual([
      [onTail, tail],
      [onHead, first],
    ]);
    expect(c.backlog).toBe(1);
  });

  test("a later-chunk rating leaves the queue once a synthesis rules on it", async () => {
    await reset();
    await memory("chunked-handled", { chunks: ["one", "two"] });
    const rows = await getDbClient().query<{ id: string }>(
      `SELECT id FROM agent_memory WHERE name = 'chunked-handled' ORDER BY chunkIndex`,
    );
    const r = await rating(rows[1]!.id);
    expect((await freshRun()).items.length).toBe(1);
    await pastSynthesis({
      rejected: [{ from: "swarm.memory.corrections", item: `rating:${r}`, reason: "claim holds" }],
    });
    const c = await freshRun();
    expect(c.items).toEqual([]);
    expect(c.backlog).toBe(0);
  });

  test("a later-chunk rating of another document with the same name is not merged", async () => {
    await reset();
    await memory("twin", { chunks: ["old doc a", "old doc b"], createdHoursAgo: 200 });
    const fresh = await memory("twin", { chunks: ["new doc a", "new doc b"], createdHoursAgo: 48 });
    const rows = await getDbClient().query<{ id: string }>(
      `SELECT id FROM agent_memory WHERE name = 'twin' AND chunkIndex = 1 ORDER BY createdAt DESC`,
    );
    await rating(rows[0]!.id);
    const c = await freshRun();
    expect(c.items.map((x: any) => x.memoryId)).toEqual([fresh]);
    expect(c.items[0].content).toContain("new doc b");
    expect(c.items[0].content).not.toContain("old doc");
  });
});
