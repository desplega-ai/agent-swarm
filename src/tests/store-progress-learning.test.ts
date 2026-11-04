import { afterAll, beforeAll, describe, expect, type Mock, spyOn, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodType } from "zod";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDb,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import { getEmbeddingProvider, getMemoryStore } from "../be/memory";
import { EMBEDDING_DIMENSIONS } from "../be/memory/constants";
import { registerStoreProgressTool } from "../tools/store-progress";

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

const agentId = "dddd0000-0000-4000-8000-000000000b01";

const server = new McpServer({ name: "store-progress-learning", version: "1.0.0" });
registerStoreProgressTool(server);
const tool = (
  server as unknown as {
    _registeredTools: Record<
      string,
      {
        inputSchema: ZodType;
        handler: (args: unknown, meta: unknown) => Promise<ToolResult>;
      }
    >;
  }
)._registeredTools["store-progress"]!;

async function call(args: Record<string, unknown>) {
  return tool.handler(tool.inputSchema.parse(args), {
    sessionId: "store-progress-learning-session",
    requestInfo: { headers: { "x-agent-id": agentId } },
  });
}

async function task(vcsRepo?: string) {
  const row = await createTaskExtended("learning capture", {
    agentId,
    source: "system",
    followUpConfig: { disabled: true },
    ...(vcsRepo ? { vcsRepo } : {}),
  });
  await startTask(row.id);
  return row;
}

interface MemoryRow {
  id: string;
  agentId: string | null;
  key: string;
  name: string;
  scope: string;
  source: string;
  sourceTaskId: string;
  tags: string;
  content: string;
}

function learningRows(taskId: string): MemoryRow[] {
  return getDb()
    .query<MemoryRow, [string]>(
      "SELECT id, agentId, key, name, scope, source, sourceTaskId, tags, content FROM agent_memory WHERE sourceTaskId = ? AND key LIKE '/learnings/%' ORDER BY createdAt",
    )
    .all(taskId);
}

function learningData(result: ToolResult) {
  return result.structuredContent?.learning as
    | {
        status: string;
        key?: string;
        memoryId?: string;
        similarity?: number;
        error?: string;
        noiseFloor?: string;
      }
    | undefined;
}

/** A line-2 rule that lifts a short test title over the noise floor. */
const RULE = "\nWhen this lesson applies, do what it says; the evidence would follow this line.";

function lesson(title: string) {
  return `${title}${RULE}`;
}

function message(result: ToolResult) {
  return String(result.structuredContent?.message);
}

const originalEmbeddingKey = process.env.EMBEDDING_API_KEY;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
beforeAll(async () => {
  process.env.EMBEDDING_API_KEY = "";
  process.env.OPENAI_API_KEY = "";
  initDb(":memory:");
  await createAgent({ id: agentId, name: "Learner", isLead: false, status: "idle" });
});
afterAll(() => {
  closeDb();
  if (originalEmbeddingKey === undefined) delete process.env.EMBEDDING_API_KEY;
  else process.env.EMBEDDING_API_KEY = originalEmbeddingKey;
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
});

describe("store-progress learning", () => {
  test("stores a swarm manual memory under the explicit workstream", async () => {
    const t = await task("desplega-ai/agent-swarm");
    const result = await call({
      taskId: t.id,
      progress: "found the cause",
      learning: {
        text: "SQLite BUSY needs BEGIN IMMEDIATE\nA deferred BEGIN that reads first fails with BUSY_SNAPSHOT.",
        workstream: "DB Runtime",
        tags: ["SQLite", "gotcha", "learning"],
      },
    });

    expect(result.isError).toBeFalsy();
    expect(learningData(result)?.status).toBe("stored");
    expect(message(result)).toContain(
      "Learning stored at /learnings/db-runtime/sqlite-busy-needs-begin-immediate.",
    );
    const [row, ...rest] = learningRows(t.id);
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      agentId,
      key: "/learnings/db-runtime/sqlite-busy-needs-begin-immediate",
      name: "SQLite BUSY needs BEGIN IMMEDIATE",
      scope: "swarm",
      source: "manual",
      sourceTaskId: t.id,
    });
    expect(JSON.parse(row!.tags)).toEqual(["learning", "sqlite", "gotcha"]);
    expect((await getTaskById(t.id))?.progress).toBe("found the cause");
  });

  test("string form falls back to the repo name, then to general", async () => {
    const withRepo = await task("desplega-ai/agent-swarm");
    await call({ taskId: withRepo.id, learning: lesson("Run lint before tsc") });
    expect(learningRows(withRepo.id)[0]?.key).toBe("/learnings/agent-swarm/run-lint-before-tsc");

    const withoutRepo = await task();
    const result = await call({
      taskId: withoutRepo.id,
      learning: { text: lesson("Prefer scripts") },
    });
    expect(learningData(result)).toMatchObject({ status: "stored", workstream: "general" });
    expect(learningRows(withoutRepo.id)[0]?.key).toBe("/learnings/general/prefer-scripts");
  });

  test("a taken key gets a short suffix instead of failing", async () => {
    const first = await task();
    const second = await task();
    await call({ taskId: first.id, learning: lesson("Same title") });
    const result = await call({
      taskId: second.id,
      learning: `${lesson("Same title")} Second body.`,
    });

    expect(learningData(result)?.status).toBe("stored");
    expect(learningRows(first.id)[0]?.key).toBe("/learnings/general/same-title");
    expect(learningRows(second.id)[0]?.key).toMatch(
      /^\/learnings\/general\/same-title-[0-9a-f]{6}$/,
    );
  });

  test("an exact replay on the same task is skipped", async () => {
    const t = await task();
    await call({ taskId: t.id, learning: lesson("Replay me") });
    const replay = await call({ taskId: t.id, progress: "again", learning: lesson("Replay me") });

    expect(learningData(replay)).toMatchObject({
      status: "replayed",
      key: "/learnings/general/replay-me",
    });
    expect(learningRows(t.id)).toHaveLength(1);
  });

  test("overlapping calls with the same learning store it once", async () => {
    const t = await task();
    const learning = lesson("Concurrent replay");
    const results = await Promise.all([
      call({ taskId: t.id, learning }),
      call({ taskId: t.id, learning }),
    ]);

    expect(learningRows(t.id)).toHaveLength(1);
    expect(results.map((result) => learningData(result)?.status).sort()).toEqual([
      "replayed",
      "stored",
    ]);
  });

  // Synthetic token, built at runtime so no literal credential sits in the repo.
  const token = `ghp_${"abcd1234".repeat(5)}`;
  const kebabToken = token.replace("_", "-");

  test("a secret in the title, workstream or tags never reaches the key or tags", async () => {
    const t = await task();
    const result = await call({
      taskId: t.id,
      learning: {
        text: `${token}${RULE}`,
        workstream: token,
        tags: [token],
      },
    });

    expect(learningData(result)?.status).toBe("stored");
    const [row] = learningRows(t.id);
    for (const field of [row!.key, row!.name, row!.tags, row!.content, learningData(result)?.key]) {
      expect(field).not.toContain(token);
      expect(field).not.toContain(kebabToken);
    }
    expect(row!.content).toContain("[REDACTED:");
  });

  test("a replay of a secret-bearing learning is still detected", async () => {
    const t = await task();
    const learning = `${lesson("Redact diagnostic tokens")} Example token: ${token}`;
    await call({ taskId: t.id, learning });
    const replay = await call({ taskId: t.id, learning });

    expect(learningData(replay)?.status).toBe("replayed");
    expect(learningRows(t.id)).toHaveLength(1);
  });

  test("a failed learning write leaves the progress write intact", async () => {
    const t = await task();
    getDb().run(
      "CREATE TEMP TRIGGER fail_learning BEFORE INSERT ON agent_memory WHEN NEW.key LIKE '/learnings/%' BEGIN SELECT RAISE(ABORT, 'learning insert refused'); END",
    );
    try {
      const result = await call({
        taskId: t.id,
        progress: "progress survives",
        status: "completed",
        output: "done",
        learning: lesson("This write fails"),
      });
      expect(result.isError).toBeFalsy();
      expect(learningData(result)).toMatchObject({ status: "failed" });
      expect(learningData(result)?.error).toContain("learning insert refused");
      expect(message(result)).toContain("Learning not stored:");
    } finally {
      getDb().run("DROP TRIGGER fail_learning");
    }
    const stored = await getTaskById(t.id);
    expect(stored?.progress).toBe("progress survives");
    expect(stored?.status).toBe("completed");
    expect(learningRows(t.id)).toHaveLength(0);
  });

  test("invalid learnings are reported without blocking progress", async () => {
    const t = await task();
    const tooManyTags = await call({
      taskId: t.id,
      progress: "still stored",
      learning: { text: "Tagged", tags: ["a", "b", "c", "d", "e", "f"] },
    });
    expect(learningData(tooManyTags)).toMatchObject({
      status: "failed",
      error: "learning takes at most 5 tags",
    });
    const tooLong = await call({ taskId: t.id, learning: "x".repeat(2001) });
    expect(learningData(tooLong)?.status).toBe("failed");
    expect((await getTaskById(t.id))?.progress).toBe("still stored");
    expect(learningRows(t.id)).toHaveLength(0);
  });

  test("a learning under the noise floor is rejected with a steer, progress kept", async () => {
    const t = await task();
    const result = await call({
      taskId: t.id,
      progress: "PR opened",
      learning: "PR opened, CI green",
    });

    expect(result.isError).toBeFalsy();
    expect(learningData(result)).toMatchObject({ status: "failed", noiseFloor: "too-short" });
    expect(message(result)).toContain("Learning not stored: learning is under 80 characters");
    expect(String(result.structuredContent?.nudge)).toContain('the rule as "When X, do Y"');
    expect((await getTaskById(t.id))?.progress).toBe("PR opened");
    expect(learningRows(t.id)).toHaveLength(0);
  });

  test("a learning that restates the same call's progress or output is rejected", async () => {
    const t = await task();
    const echoed = lesson("Fixed the flaky push hook");
    const fromProgress = await call({
      taskId: t.id,
      progress: `Done. ${echoed.toUpperCase()}  Next: review.`,
      learning: echoed,
    });
    expect(learningData(fromProgress)).toMatchObject({
      status: "failed",
      noiseFloor: "repeats-progress",
    });
    expect(learningData(fromProgress)?.error).toContain("this call's progress");
    expect(String(fromProgress.structuredContent?.nudge)).toContain("restates this call's");

    const fromOutput = await call({
      taskId: t.id,
      status: "completed",
      output: `Shipped.\n${echoed}`,
      learning: echoed,
    });
    expect(learningData(fromOutput)).toMatchObject({ noiseFloor: "repeats-progress" });
    expect(learningData(fromOutput)?.error).toContain("this call's output");
    expect((await getTaskById(t.id))?.status).toBe("completed");
    expect(learningRows(t.id)).toHaveLength(0);
  });

  test("a learning that contains the progress line and adds a rule is stored", async () => {
    const t = await task();
    const result = await call({
      taskId: t.id,
      progress: "Fixed the flaky push hook",
      learning: lesson("Fixed the flaky push hook"),
    });
    expect(learningData(result)?.status).toBe("stored");
  });

  test("a learning on the completing call is stored", async () => {
    const t = await task();
    const result = await call({
      taskId: t.id,
      status: "completed",
      output: "done",
      learning: lesson("Ship on the completing call"),
    });
    expect(learningData(result)?.status).toBe("stored");
    expect((await getTaskById(t.id))?.status).toBe("completed");
  });

  test("a call on a finished task stores nothing", async () => {
    const t = await task();
    await call({ taskId: t.id, status: "completed", output: "done" });
    const late = await call({
      taskId: t.id,
      status: "completed",
      output: "done",
      learning: "Too late",
    });
    expect(late.structuredContent).toMatchObject({ wasNoOp: true });
    expect(learningData(late)?.status).toBe("failed");

    const progressOnly = await call({ taskId: t.id, learning: "Still too late" });
    expect(learningData(progressOnly)?.status).toBe("failed");
    expect(learningRows(t.id)).toHaveLength(0);
  });
});

describe("store-progress learning near-duplicate guard", () => {
  const vectors = new Map<string, Float32Array>();
  let embedSpy: Mock<(text: string) => Promise<Float32Array | null>>;

  /** Unit vector on `axis`, tilted toward `axis + 1` so its cosine to the bare axis is `cos`. */
  function vector(axis: number, cos = 1): Float32Array {
    const v = new Float32Array(EMBEDDING_DIMENSIONS);
    v[axis] = cos;
    v[axis + 1] = Math.sqrt(1 - cos ** 2);
    return v;
  }

  /** Store a learning and give it its embedding now, not in the background. */
  async function seed(text: string, embedding: Float32Array, workstream = "seeded") {
    vectors.set(text, embedding);
    const t = await task();
    const result = await call({ taskId: t.id, learning: { text, workstream } });
    const memoryId = learningData(result)!.memoryId!;
    await getMemoryStore().updateEmbedding(memoryId, embedding, "test-embedding");
    return { task: t, memoryId, key: learningData(result)!.key! };
  }

  beforeAll(() => {
    embedSpy = spyOn(getEmbeddingProvider(), "embed").mockImplementation(
      async (text: string) => vectors.get(text) ?? null,
    );
  });
  afterAll(() => embedSpy.mockRestore());

  test("a near duplicate in another workstream is not stored and rates the existing row", async () => {
    const existing = await seed(lesson("Upsert scripts from file bytes"), vector(10));
    const text = lesson("Byte-exact script upsert from a local file");
    vectors.set(text, vector(10, 0.9));
    const t = await task();
    const result = await call({ taskId: t.id, learning: { text, workstream: "other" } });

    expect(learningData(result)).toMatchObject({
      status: "duplicate",
      memoryId: existing.memoryId,
      key: existing.key,
    });
    expect(learningData(result)?.similarity).toBeCloseTo(0.9, 2);
    expect(message(result)).toContain(`Learning not stored: it matches ${existing.key}`);
    expect(String(result.structuredContent?.nudge)).toContain(`memory-edit that memory instead`);
    expect(String(result.structuredContent?.nudge)).toContain(existing.memoryId);
    expect(learningRows(t.id)).toHaveLength(0);
    const ratings = getDb()
      .query<{ source: string; signal: number; taskId: string }, [string]>(
        "SELECT source, signal, taskId FROM memory_rating WHERE memoryId = ?",
      )
      .all(existing.memoryId);
    expect(ratings).toEqual([{ source: "learning-duplicate", signal: 1, taskId: t.id }]);
  });

  test("a related learning below the threshold is stored", async () => {
    await seed(lesson("Retry flaky pushes once"), vector(20));
    const text = lesson("Pre-push hooks take five minutes");
    vectors.set(text, vector(20, 0.7));
    const t = await task();
    const result = await call({ taskId: t.id, learning: text });

    expect(learningData(result)?.status).toBe("stored");
    expect(learningRows(t.id)).toHaveLength(1);
  });

  test("a failed search falls through to the normal insert", async () => {
    await seed(lesson("Kebab keys only"), vector(30));
    const text = lesson("Keys are kebab case");
    vectors.set(text, vector(30, 0.95));
    const searchSpy = spyOn(getMemoryStore(), "search").mockRejectedValue(new Error("vec down"));
    try {
      const t = await task();
      const result = await call({ taskId: t.id, progress: "kept", learning: text });
      expect(learningData(result)?.status).toBe("stored");
      expect(learningRows(t.id)).toHaveLength(1);
      expect((await getTaskById(t.id))?.progress).toBe("kept");
    } finally {
      searchSpy.mockRestore();
    }
  });

  test("an exact replay on the same task is replayed, not a duplicate", async () => {
    const text = lesson("Replay before similarity");
    const seeded = await seed(text, vector(40));
    const replay = await call({ taskId: seeded.task.id, learning: { text, workstream: "seeded" } });

    expect(learningData(replay)).toMatchObject({ status: "replayed", memoryId: seeded.memoryId });
    expect(learningRows(seeded.task.id)).toHaveLength(1);
  });
});
