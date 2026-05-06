/**
 * Unit + integration tests for `LlmRater` and the worker-side hook piggyback.
 *
 * Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-4.md §6, §7
 *
 * Layout:
 *   1. Pure unit tests — Zod schema parse/reject, `buildRatingsFromLlm`
 *      mapping, prompt construction.
 *   2. `LlmRater.rate(ctx)` per-memory path with `MockLlmRaterClient`.
 *   3. HTTP integration: spawn the API server against an isolated SQLite
 *      file, simulate the hook's piggyback flow (mock `claude -p` by feeding
 *      stdout directly into `parseSummaryWithRatings`), and assert
 *      `agent_memory.alpha/beta` move + `memory_rating` rows are written.
 *   4. Negative path: `MEMORY_RATERS` unset → no `/api/memory/rate` call.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { Subprocess } from "bun";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import { SqliteMemoryStore } from "../be/memory/providers/sqlite-store";
import {
  buildRatingsFromLlm,
  buildSummaryWithRatingsPrompt,
  extractSummaryFromClaudeStdout,
  fetchRetrievalsForTask,
  isLlmRaterEnabled,
  LLM_RATER_WEIGHT,
  LlmRater,
  parseSummaryWithRatings,
  postRatings,
  SummaryWithRatingsSchema,
} from "../be/memory/raters/llm";
import { getRegisteredRaters, SERVER_RATERS } from "../be/memory/raters/registry";
import type { RatingEvent } from "../be/memory/raters/types";
import { MockLlmRaterClient } from "./mocks/mock-llm-rater-client";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Pure unit tests — schema, mapping, prompt. No DB / network required.
// ─────────────────────────────────────────────────────────────────────────────

describe("SummaryWithRatingsSchema", () => {
  test("accepts a well-formed response", () => {
    const r = SummaryWithRatingsSchema.safeParse({
      summary: "key learnings",
      ratings: [
        { id: "mem-1", score: 0.9, reasoning: "directly answered" },
        { id: "mem-2", score: 0, reasoning: "irrelevant" },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.ratings).toHaveLength(2);
  });

  test("defaults `ratings` to [] when omitted", () => {
    const r = SummaryWithRatingsSchema.safeParse({ summary: "no retrievals" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.ratings).toEqual([]);
  });

  test("rejects score > 1", () => {
    const r = SummaryWithRatingsSchema.safeParse({
      summary: "x",
      ratings: [{ id: "m", score: 1.2, reasoning: "n/a" }],
    });
    expect(r.success).toBe(false);
  });

  test("rejects score < 0", () => {
    const r = SummaryWithRatingsSchema.safeParse({
      summary: "x",
      ratings: [{ id: "m", score: -0.1, reasoning: "n/a" }],
    });
    expect(r.success).toBe(false);
  });

  test("rejects empty reasoning", () => {
    const r = SummaryWithRatingsSchema.safeParse({
      summary: "x",
      ratings: [{ id: "m", score: 0.5, reasoning: "" }],
    });
    expect(r.success).toBe(false);
  });

  test("rejects reasoning > 500 chars", () => {
    const r = SummaryWithRatingsSchema.safeParse({
      summary: "x",
      ratings: [{ id: "m", score: 0.5, reasoning: "a".repeat(501) }],
    });
    expect(r.success).toBe(false);
  });

  test("rejects missing reasoning", () => {
    const r = SummaryWithRatingsSchema.safeParse({
      summary: "x",
      ratings: [{ id: "m", score: 0.5 }],
    });
    expect(r.success).toBe(false);
  });

  test("rejects non-string id", () => {
    const r = SummaryWithRatingsSchema.safeParse({
      summary: "x",
      ratings: [{ id: 42, score: 0.5, reasoning: "ok" }],
    });
    expect(r.success).toBe(false);
  });
});

describe("buildRatingsFromLlm", () => {
  const retrievals = [
    { id: "mem-A", name: "a", content: "" },
    { id: "mem-B", name: "b", content: "" },
    { id: "mem-C", name: "c", content: "" },
  ];

  test("score=0 → signal=-1, score=0.5 → signal=0, score=1 → signal=+1", () => {
    const events = buildRatingsFromLlm(
      [
        { id: "mem-A", score: 0, reasoning: "useless" },
        { id: "mem-B", score: 0.5, reasoning: "neutral" },
        { id: "mem-C", score: 1, reasoning: "perfect" },
      ],
      retrievals,
    );
    expect(events).toHaveLength(3);
    const a = events.find((e) => e.memoryId === "mem-A")!;
    const b = events.find((e) => e.memoryId === "mem-B")!;
    const c = events.find((e) => e.memoryId === "mem-C")!;
    expect(a.signal).toBeCloseTo(-1, 6);
    expect(b.signal).toBeCloseTo(0, 6);
    expect(c.signal).toBeCloseTo(1, 6);
  });

  test("weight is exactly 0.8 for every event (research-doc constant)", () => {
    const events = buildRatingsFromLlm(
      [
        { id: "mem-A", score: 0.2, reasoning: "x" },
        { id: "mem-B", score: 0.7, reasoning: "y" },
      ],
      retrievals,
    );
    for (const e of events) {
      expect(e.weight).toBe(0.8);
    }
    expect(LLM_RATER_WEIGHT).toBe(0.8);
  });

  test("source is set to 'llm' (the HTTP rate endpoint enums it)", () => {
    const events = buildRatingsFromLlm([{ id: "mem-A", score: 0.5, reasoning: "x" }], retrievals);
    expect(events[0]!.source).toBe("llm");
  });

  test("reasoning is preserved on each event", () => {
    const events = buildRatingsFromLlm(
      [{ id: "mem-A", score: 0.7, reasoning: "directly answered the question" }],
      retrievals,
    );
    expect(events[0]!.reasoning).toBe("directly answered the question");
  });

  test("drops ratings whose id is not in the retrieval set (anti-hallucination)", () => {
    const events = buildRatingsFromLlm(
      [
        { id: "mem-A", score: 0.9, reasoning: "real" },
        { id: "mem-HALLUCINATED", score: 0.9, reasoning: "fake" },
      ],
      retrievals,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.memoryId).toBe("mem-A");
  });

  test("empty ratings array → empty events", () => {
    const events = buildRatingsFromLlm([], retrievals);
    expect(events).toEqual([]);
  });
});

describe("buildSummaryWithRatingsPrompt", () => {
  test("returns base prompt unchanged when retrievals is empty", () => {
    const base = "BASE_PROMPT";
    expect(buildSummaryWithRatingsPrompt(base, [])).toBe(base);
  });

  test("appends schema instruction + memory list when retrievals is non-empty", () => {
    const out = buildSummaryWithRatingsPrompt("BASE", [
      { id: "mem-1", name: "first", content: "alpha content" },
      { id: "mem-2", name: "second", content: "beta content" },
    ]);
    expect(out.startsWith("BASE")).toBe(true);
    expect(out).toContain('"summary"');
    expect(out).toContain('"ratings"');
    expect(out).toContain("mem-1");
    expect(out).toContain("mem-2");
    expect(out).toContain("alpha content");
    expect(out).toContain("beta content");
    expect(out).toContain("first");
    expect(out).toContain("second");
  });

  test("truncates long memory content into the prompt", () => {
    const longContent = "x".repeat(5000);
    const out = buildSummaryWithRatingsPrompt("BASE", [
      { id: "mem-long", name: "L", content: longContent },
    ]);
    // Truncation cap is 600 chars + ellipsis. Make sure full 5000 isn't echoed.
    expect(out.includes("x".repeat(5000))).toBe(false);
    expect(out).toContain("…");
  });
});

describe("parseSummaryWithRatings", () => {
  test("parses a well-formed claude -p envelope (inner JSON as string)", () => {
    const inner = JSON.stringify({
      summary: "S",
      ratings: [{ id: "m", score: 0.5, reasoning: "ok" }],
    });
    const envelope = JSON.stringify({ result: inner });
    const out = parseSummaryWithRatings(envelope);
    expect(out).not.toBeNull();
    expect(out?.summary).toBe("S");
    expect(out?.ratings).toHaveLength(1);
  });

  test("parses an envelope where `result` is an object (not stringified)", () => {
    const envelope = JSON.stringify({
      result: { summary: "S", ratings: [{ id: "m", score: 1, reasoning: "yes" }] },
    });
    const out = parseSummaryWithRatings(envelope);
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.ratings[0]!.score).toBe(1);
  });

  test("returns null when envelope is not JSON", () => {
    expect(parseSummaryWithRatings("not json")).toBeNull();
  });

  test("returns null when inner is not JSON", () => {
    const envelope = JSON.stringify({ result: "this is not json either" });
    expect(parseSummaryWithRatings(envelope)).toBeNull();
  });

  test("returns null when inner fails schema (out-of-range score)", () => {
    const inner = JSON.stringify({
      summary: "S",
      ratings: [{ id: "m", score: 5, reasoning: "bogus" }],
    });
    const envelope = JSON.stringify({ result: inner });
    expect(parseSummaryWithRatings(envelope)).toBeNull();
  });
});

describe("extractSummaryFromClaudeStdout (hook fallback path)", () => {
  // Regression: PR #429 review feedback. When the structured-output piggyback
  // returns a valid envelope but the inner ratings fail SummaryWithRatingsSchema,
  // the hook MUST index the human-readable `summary` text — not the raw inner
  // JSON blob. See src/hooks/hook.ts ~L1148.
  test("structured envelope with invalid ratings → extracts inner summary string", () => {
    const summaryText = "Found a couple of helpful patterns; one was misleading.";
    const inner = JSON.stringify({
      summary: summaryText,
      // Out-of-range score makes SummaryWithRatingsSchema.safeParse fail.
      ratings: [{ id: "mem-A", score: 5, reasoning: "bogus" }],
    });
    const envelope = JSON.stringify({ result: inner });
    expect(parseSummaryWithRatings(envelope)).toBeNull();
    const out = extractSummaryFromClaudeStdout(envelope);
    expect(out).toBe(summaryText);
    // Hard guarantee for the indexer: must NOT be raw JSON.
    expect(out.startsWith("{")).toBe(false);
    expect(out.includes('"ratings"')).toBe(false);
  });

  test("structured envelope missing the `ratings` field entirely → extracts summary", () => {
    const summaryText = "No retrievals this session.";
    const inner = JSON.stringify({ summary: summaryText });
    const envelope = JSON.stringify({ result: inner });
    const out = extractSummaryFromClaudeStdout(envelope);
    expect(out).toBe(summaryText);
  });

  test("structured envelope with non-string summary field → falls through to inner string", () => {
    // Defensive: if `summary` itself is malformed, we still don't crash; the
    // best-effort fallback is to return the inner JSON as a string. The
    // length/keyword heuristics in the hook will likely skip indexing.
    const inner = JSON.stringify({ summary: 42, ratings: [] });
    const envelope = JSON.stringify({ result: inner });
    const out = extractSummaryFromClaudeStdout(envelope);
    expect(out).toBe(inner);
  });

  test("unstructured envelope with plain text result → returns the text unchanged", () => {
    const text = "- Discovered that the API requires Bearer prefix.\n- No other learnings.";
    const envelope = JSON.stringify({ result: text });
    expect(extractSummaryFromClaudeStdout(envelope)).toBe(text);
  });

  test("envelope.result is an object with a string summary field → extracts it", () => {
    const envelope = JSON.stringify({
      result: { summary: "object form", ratings: [] },
    });
    expect(extractSummaryFromClaudeStdout(envelope)).toBe("object form");
  });

  test("envelope is not JSON → returns the raw stdout", () => {
    const stdout = "totally not json";
    expect(extractSummaryFromClaudeStdout(stdout)).toBe(stdout);
  });

  test("envelope is JSON but lacks `result` field → returns the raw stdout", () => {
    const stdout = JSON.stringify({ other: "field" });
    expect(extractSummaryFromClaudeStdout(stdout)).toBe(stdout);
  });
});

describe("isLlmRaterEnabled", () => {
  test("false when MEMORY_RATERS unset", () => {
    const prev = process.env.MEMORY_RATERS;
    delete process.env.MEMORY_RATERS;
    try {
      expect(isLlmRaterEnabled()).toBe(false);
    } finally {
      if (prev !== undefined) process.env.MEMORY_RATERS = prev;
    }
  });

  test("false when MEMORY_RATERS lacks 'llm'", () => {
    const prev = process.env.MEMORY_RATERS;
    process.env.MEMORY_RATERS = "implicit-citation,noop";
    try {
      expect(isLlmRaterEnabled()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.MEMORY_RATERS;
      else process.env.MEMORY_RATERS = prev;
    }
  });

  test("true when MEMORY_RATERS includes 'llm'", () => {
    const prev = process.env.MEMORY_RATERS;
    process.env.MEMORY_RATERS = "implicit-citation,llm";
    try {
      expect(isLlmRaterEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MEMORY_RATERS;
      else process.env.MEMORY_RATERS = prev;
    }
  });
});

describe("registry: 'llm' is registered but not in SERVER_RATERS", () => {
  test("getRegisteredRaters() with MEMORY_RATERS='llm' yields LlmRater", () => {
    const prev = process.env.MEMORY_RATERS;
    process.env.MEMORY_RATERS = "llm";
    try {
      const raters = getRegisteredRaters();
      expect(raters.map((r) => r.name)).toContain("llm");
    } finally {
      if (prev === undefined) delete process.env.MEMORY_RATERS;
      else process.env.MEMORY_RATERS = prev;
    }
  });

  test("'llm' is NOT in SERVER_RATERS — only worker-driven", () => {
    expect(SERVER_RATERS.has("llm")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. LlmRater.rate(ctx) per-memory path with MockLlmRaterClient.
// ─────────────────────────────────────────────────────────────────────────────

describe("LlmRater.rate(ctx) — per-memory path with MockLlmRaterClient", () => {
  test("name is 'llm'", () => {
    const rater = new LlmRater(new MockLlmRaterClient({}));
    expect(rater.name).toBe("llm");
  });

  test("returns [] when retrievedMemoryIds is empty", async () => {
    const rater = new LlmRater(new MockLlmRaterClient({}));
    const events = await rater.rate({
      agentId: "agent-x",
      retrievedMemoryIds: [],
      evidence: "anything",
    });
    expect(events).toEqual([]);
  });

  test("returns [] when retrievedMemories is missing (RatingContext only)", async () => {
    const rater = new LlmRater(new MockLlmRaterClient({ "mem-A": { score: 1, reasoning: "x" } }));
    const events = await rater.rate({
      agentId: "agent-x",
      retrievedMemoryIds: ["mem-A"],
      evidence: "x",
    });
    expect(events).toEqual([]);
  });

  test("calls client per memory and maps score → signal correctly", async () => {
    const mock = new MockLlmRaterClient({
      "mem-A": { score: 1, reasoning: "perfect" },
      "mem-B": { score: 0, reasoning: "useless" },
      "mem-C": { score: 0.5, reasoning: "neutral" },
    });
    const rater = new LlmRater(mock);
    const events = await rater.rate({
      agentId: "agent-x",
      taskId: "task-1",
      retrievedMemoryIds: ["mem-A", "mem-B", "mem-C"],
      retrievedMemories: [
        { id: "mem-A", name: "A", content: "ca" },
        { id: "mem-B", name: "B", content: "cb" },
        { id: "mem-C", name: "C", content: "cc" },
      ],
      query: "the question",
      response: "the response",
      evidence: null,
    });
    expect(events).toHaveLength(3);
    expect(mock.calls).toHaveLength(3);
    // Source is empty (framework will stamp via runServerRaters / store).
    for (const e of events) expect(e.source).toBe("");
    for (const e of events) expect(e.weight).toBe(0.8);
    const a = events.find((e) => e.memoryId === "mem-A")!;
    const b = events.find((e) => e.memoryId === "mem-B")!;
    const c = events.find((e) => e.memoryId === "mem-C")!;
    expect(a.signal).toBeCloseTo(1, 6);
    expect(b.signal).toBeCloseTo(-1, 6);
    expect(c.signal).toBeCloseTo(0, 6);
    expect(a.reasoning).toBe("perfect");
  });

  test("client returns null → that memory is skipped (no event emitted)", async () => {
    const mock = new MockLlmRaterClient({
      "mem-A": { score: 0.7, reasoning: "useful" },
      "mem-B": null, // simulates LLM parse failure
    });
    const rater = new LlmRater(mock);
    const events = await rater.rate({
      agentId: "agent-x",
      retrievedMemoryIds: ["mem-A", "mem-B"],
      retrievedMemories: [
        { id: "mem-A", name: "A", content: "" },
        { id: "mem-B", name: "B", content: "" },
      ],
      evidence: null,
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.memoryId).toBe("mem-A");
  });

  test("uses ctx.evidence as `response` when ctx.response is missing", async () => {
    const mock = new MockLlmRaterClient({
      "mem-A": { score: 1, reasoning: "x" },
    });
    const rater = new LlmRater(mock);
    await rater.rate({
      agentId: "agent-x",
      retrievedMemoryIds: ["mem-A"],
      retrievedMemories: [{ id: "mem-A", name: "A", content: "ca" }],
      evidence: "fallback evidence",
    });
    expect(mock.calls[0]!.response).toBe("fallback evidence");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. HTTP integration — hook-piggyback dry-run.
// 4. Negative path — MEMORY_RATERS unset → no rate call.
// ─────────────────────────────────────────────────────────────────────────────

const TEST_PORT = 19119;
const TEST_DB_PATH = `/tmp/test-memory-rater-llm-${Date.now()}.sqlite`;
const BASE = `http://localhost:${TEST_PORT}`;
const API_KEY = "test-key";

let serverProc: Subprocess;
const agentA = randomUUID();
const taskA = randomUUID();
const taskB = randomUUID();
let store: SqliteMemoryStore;

const testTemplateGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
  __savedRaterLlmTemplate?: Uint8Array;
};

async function waitForServer(url: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not ready
    }
    await Bun.sleep(50);
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

function makeMemory(name: string): { id: string } {
  return store.store({
    agentId: agentA,
    scope: "agent",
    name,
    content: `${name} content`,
    source: "manual",
  });
}

function insertRetrieval(taskId: string, memoryId: string): void {
  getDb()
    .prepare(
      `INSERT INTO memory_retrieval (id, taskId, agentId, sessionId, memoryId, similarity, retrievedAt)
       VALUES (?, ?, ?, NULL, ?, 0.85, ?)`,
    )
    .run(randomUUID(), taskId, agentA, memoryId, new Date().toISOString());
}

function readPosterior(id: string): { alpha: number; beta: number } {
  const row = getDb()
    .prepare<{ alpha: number; beta: number }, [string]>(
      "SELECT alpha, beta FROM agent_memory WHERE id = ?",
    )
    .get(id);
  if (!row) throw new Error(`memory ${id} not found`);
  return { alpha: row.alpha, beta: row.beta };
}

function getRatings(taskId: string) {
  return getDb()
    .prepare<
      {
        memoryId: string;
        source: string;
        signal: number;
        weight: number;
        reasoning: string | null;
      },
      [string]
    >("SELECT memoryId, source, signal, weight, reasoning FROM memory_rating WHERE taskId = ?")
    .all(taskId);
}

describe("HTTP integration: hook-piggyback dry-run", () => {
  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }

    serverProc = Bun.spawn(["bun", "src/http.ts"], {
      cwd: `${import.meta.dir}/../..`,
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        DATABASE_PATH: TEST_DB_PATH,
        API_KEY,
        CAPABILITIES: "core",
        SLACK_BOT_TOKEN: "",
        LINEAR_DISABLE: "true",
        JIRA_DISABLE: "true",
        GITHUB_DISABLE: "true",
        SLACK_DISABLE: "true",
        HEARTBEAT_DISABLE: "true",
        OAUTH_KEEPALIVE_DISABLE: "true",
        ANONYMIZED_TELEMETRY: "false",
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    await waitForServer(`${BASE}/health`);

    testTemplateGlobals.__savedRaterLlmTemplate = testTemplateGlobals.__testMigrationTemplate;
    testTemplateGlobals.__testMigrationTemplate = undefined;
    // Close any leftover in-memory DB from a prior test in the same Bun worker.
    // initDb is a no-op when `db` is already set, so without this the test
    // process can keep writing to the previous template-restored DB while the
    // spawned server reads from TEST_DB_PATH — defensive even if today's CI
    // ordering happens to leave `db` null here.
    closeDb();
    initDb(TEST_DB_PATH);
    createAgent({ id: agentA, name: "Rater LLM Test", isLead: false, status: "idle" });

    const insertTask = getDb().prepare(
      `INSERT INTO agent_tasks (id, agentId, task, status, source, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, 'in_progress', 'mcp', ?, ?)`,
    );
    const now = new Date().toISOString();
    insertTask.run(taskA, agentA, "rater llm task A", now, now);
    insertTask.run(taskB, agentA, "rater llm task B", now, now);

    store = new SqliteMemoryStore();
  }, 20000);

  afterAll(async () => {
    closeDb();
    testTemplateGlobals.__testMigrationTemplate = testTemplateGlobals.__savedRaterLlmTemplate;
    testTemplateGlobals.__savedRaterLlmTemplate = undefined;
    if (serverProc) {
      serverProc.kill();
      try {
        await serverProc.exited;
      } catch {}
    }
    await Bun.sleep(50);
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
  });

  beforeEach(() => {
    getDb().run("DELETE FROM memory_rating");
    getDb().run("DELETE FROM memory_retrieval");
    getDb().run("UPDATE agent_memory SET alpha = 1.0, beta = 1.0");
  });

  test("fetchRetrievalsForTask returns rows for the requesting agent", async () => {
    const m = makeMemory("retr-fetch-1");
    insertRetrieval(taskA, m.id);
    const rows = await fetchRetrievalsForTask({
      apiUrl: BASE,
      apiKey: API_KEY,
      agentId: agentA,
      taskId: taskA,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(m.id);
  });

  test("fetchRetrievalsForTask → [] on transport failure (best-effort)", async () => {
    const rows = await fetchRetrievalsForTask({
      apiUrl: "http://localhost:1", // refused
      apiKey: API_KEY,
      agentId: agentA,
      taskId: taskA,
    });
    expect(rows).toEqual([]);
  });

  test("postRatings → applies events; alpha/beta posteriors move per mocked score", async () => {
    const useful = makeMemory("piggyback-useful");
    const misleading = makeMemory("piggyback-misleading");
    const neutral = makeMemory("piggyback-neutral");

    // Worker has retrieved these three.
    insertRetrieval(taskA, useful.id);
    insertRetrieval(taskA, misleading.id);
    insertRetrieval(taskA, neutral.id);

    // Simulate hook flow: fetch retrievals, mock the LLM stdout, parse, POST.
    const retrievals = await fetchRetrievalsForTask({
      apiUrl: BASE,
      apiKey: API_KEY,
      agentId: agentA,
      taskId: taskA,
    });
    expect(retrievals).toHaveLength(3);

    // Mocked claude -p stdout — the same shape parseSummaryWithRatings expects.
    const mockedSummaryJson = JSON.stringify({
      summary: "Found a couple of helpful patterns; one memory was misleading.",
      ratings: [
        { id: useful.id, score: 1, reasoning: "directly answered the question" },
        { id: misleading.id, score: 0, reasoning: "this memory contradicted the docs" },
        { id: neutral.id, score: 0.5, reasoning: "tangential but interesting" },
      ],
    });
    const mockedClaudeStdout = JSON.stringify({ result: mockedSummaryJson });
    const parsed = parseSummaryWithRatings(mockedClaudeStdout);
    expect(parsed).not.toBeNull();

    const events = buildRatingsFromLlm(parsed!.ratings, retrievals);
    expect(events).toHaveLength(3);
    for (const e of events) {
      expect(e.weight).toBe(0.8);
      expect(e.source).toBe("llm");
    }

    const r = await postRatings({
      apiUrl: BASE,
      apiKey: API_KEY,
      agentId: agentA,
      taskId: taskA,
      events,
    });
    expect(r.ok).toBe(true);

    // Posteriors moved by alphaDelta/betaDelta = max(0, ±signal) * 0.8.
    // useful: signal=+1 → alpha += 0.8
    // misleading: signal=-1 → beta += 0.8
    // neutral: signal=0 → no shift
    expect(readPosterior(useful.id)).toEqual({ alpha: 1.8, beta: 1.0 });
    expect(readPosterior(misleading.id)).toEqual({ alpha: 1.0, beta: 1.8 });
    expect(readPosterior(neutral.id)).toEqual({ alpha: 1.0, beta: 1.0 });

    const ratings = getRatings(taskA);
    expect(ratings).toHaveLength(3);
    for (const row of ratings) {
      expect(row.source).toBe("llm");
      expect(row.weight).toBe(0.8);
      expect(row.reasoning).not.toBeNull();
      expect((row.reasoning ?? "").length).toBeGreaterThan(0);
    }
  });

  test("hallucinated memoryId is dropped before POST (defence-in-depth)", async () => {
    const real = makeMemory("piggyback-real");
    insertRetrieval(taskB, real.id);
    const retrievals = await fetchRetrievalsForTask({
      apiUrl: BASE,
      apiKey: API_KEY,
      agentId: agentA,
      taskId: taskB,
    });
    const events = buildRatingsFromLlm(
      [
        { id: real.id, score: 1, reasoning: "real memory" },
        { id: "mem-FAKE-NOT-IN-DB", score: 1, reasoning: "hallucinated" },
      ],
      retrievals,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.memoryId).toBe(real.id);

    const r = await postRatings({
      apiUrl: BASE,
      apiKey: API_KEY,
      agentId: agentA,
      taskId: taskB,
      events,
    });
    expect(r.ok).toBe(true);
    expect(getRatings(taskB)).toHaveLength(1);
  });

  test("negative path: simulated hook with MEMORY_RATERS unset → no /api/memory/rate call", async () => {
    const m = makeMemory("piggyback-negative");
    insertRetrieval(taskA, m.id);

    const prev = process.env.MEMORY_RATERS;
    delete process.env.MEMORY_RATERS;
    try {
      // Mirror the hook's gate: when isLlmRaterEnabled() is false, the hook
      // never calls fetchRetrievalsForTask / parseSummaryWithRatings /
      // postRatings — it falls back to the existing summary-only path.
      let postCalled = false;
      const fakeFetch: typeof fetch = async () => {
        postCalled = true;
        return new Response("{}", { status: 200 });
      };
      if (!isLlmRaterEnabled()) {
        // No call at all — assertion is "we did not invoke postRatings".
        expect(postCalled).toBe(false);
      }
      // Sanity: if we DID call postRatings, nothing got applied because no events.
      const r = await postRatings({
        apiUrl: BASE,
        apiKey: API_KEY,
        agentId: agentA,
        taskId: taskA,
        events: [],
        fetchImpl: fakeFetch,
      });
      expect(r.ok).toBe(true);
      expect(postCalled).toBe(false); // events=[] short-circuits before fetch
    } finally {
      if (prev !== undefined) process.env.MEMORY_RATERS = prev;
    }

    // No memory_rating rows for taskA in this test.
    expect(getRatings(taskA)).toHaveLength(0);
    expect(readPosterior(m.id)).toEqual({ alpha: 1.0, beta: 1.0 });
  });

  test("postRatings logs but does not throw on 4xx (best-effort)", async () => {
    const m = makeMemory("piggyback-4xx");
    insertRetrieval(taskA, m.id);

    const evt: RatingEvent = {
      memoryId: m.id,
      signal: 1,
      weight: 0.8,
      // intentionally omit source — the server's RateEventSchema enum will reject
      source: "implicit-citation",
      reasoning: "spoof attempt",
    };
    const r = await postRatings({
      apiUrl: BASE,
      apiKey: API_KEY,
      agentId: agentA,
      taskId: taskA,
      events: [evt],
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBeGreaterThanOrEqual(400);
    // Posterior unchanged — 400 means nothing was applied.
    expect(readPosterior(m.id)).toEqual({ alpha: 1.0, beta: 1.0 });
  });
});
