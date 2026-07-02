import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  accessBoost,
  computeScore,
  recencyDecay,
  rerank,
  sourceQuality,
  usefulness,
} from "../be/memory/reranker";
import type { MemoryCandidate } from "../be/memory/types";

function makeCandidate(
  overrides: Partial<MemoryCandidate> & { similarity: number },
): MemoryCandidate {
  return {
    id: crypto.randomUUID(),
    agentId: "00000000-0000-0000-0000-000000000001",
    scope: "agent",
    name: "test",
    content: "test content",
    summary: null,
    source: "manual",
    sourceTaskId: null,
    sourcePath: null,
    chunkIndex: 0,
    totalChunks: 1,
    tags: [],
    createdAt: new Date().toISOString(),
    accessedAt: new Date().toISOString(),
    accessCount: 0,
    expiresAt: null,
    embeddingModel: null,
    alpha: 1.0,
    beta: 1.0,
    ...overrides,
  };
}

describe("recencyDecay", () => {
  const now = new Date("2026-04-12T12:00:00Z");

  test("fresh memory → ~1.0", () => {
    const decay = recencyDecay(now.toISOString(), now);
    expect(decay).toBeCloseTo(1.0, 5);
  });

  test("task_completion at half-life (14d) → ~0.5", () => {
    const created = new Date(now.getTime() - 14 * 86400000).toISOString();
    const decay = recencyDecay(created, now, "task_completion");
    expect(decay).toBeCloseTo(0.5, 2);
  });

  test("session_summary at 7d → ~0.5 (7d half-life)", () => {
    const created = new Date(now.getTime() - 7 * 86400000).toISOString();
    const decay = recencyDecay(created, now, "session_summary");
    expect(decay).toBeCloseTo(0.5, 2);
  });

  test("file_index at 180d → ~0.5 (180d half-life)", () => {
    const created = new Date(now.getTime() - 180 * 86400000).toISOString();
    const decay = recencyDecay(created, now, "file_index");
    expect(decay).toBeCloseTo(0.5, 2);
  });

  test("manual memory at any age → 1.0 (no decay)", () => {
    const created = new Date(now.getTime() - 365 * 86400000).toISOString();
    const decay = recencyDecay(created, now, "manual");
    expect(decay).toBe(1.0);
  });

  test("very old task_completion (365d) → near 0", () => {
    const created = new Date(now.getTime() - 365 * 86400000).toISOString();
    const decay = recencyDecay(created, now, "task_completion");
    expect(decay).toBeLessThan(0.001);
  });

  test("future memory → 1.0", () => {
    const created = new Date(now.getTime() + 86400000).toISOString();
    const decay = recencyDecay(created, now);
    expect(decay).toBe(1.0);
  });

  test("no source provided → falls back to task_completion half-life", () => {
    const created = new Date(now.getTime() - 14 * 86400000).toISOString();
    const decay = recencyDecay(created, now);
    expect(decay).toBeCloseTo(0.5, 2);
  });
});

describe("accessBoost", () => {
  const now = new Date("2026-04-12T12:00:00Z");

  test("accessCount=0 → exactly 1.0", () => {
    expect(accessBoost(now.toISOString(), 0, now)).toBe(1.0);
  });

  test("accessCount=10, accessed within window → max boost", () => {
    const boost = accessBoost(now.toISOString(), 10, now);
    expect(boost).toBeCloseTo(1.5, 2);
  });

  test("accessCount=10, accessed outside window → partial boost", () => {
    const accessed = new Date(now.getTime() - 72 * 3600000).toISOString(); // 72h ago
    const boost = accessBoost(accessed, 10, now);
    // recencyFactor = 0.5, boost = 1 + min(10/10, 0.5) * 0.5 = 1.25
    expect(boost).toBeCloseTo(1.25, 2);
  });

  test("accessCount=100 (capped) → same as 10+", () => {
    const boost = accessBoost(now.toISOString(), 100, now);
    expect(boost).toBeCloseTo(1.5, 2);
  });

  test("accessCount=3 → partial boost", () => {
    const boost = accessBoost(now.toISOString(), 3, now);
    // boost = 1 + min(3/10, 0.5) * 1.0 = 1 + 0.3 = 1.3
    expect(boost).toBeCloseTo(1.3, 2);
  });
});

describe("sourceQuality", () => {
  test("manual → 1.5", () => {
    expect(sourceQuality("manual")).toBe(1.5);
  });

  test("file_index → 1.0", () => {
    expect(sourceQuality("file_index")).toBe(1.0);
  });

  test("task_completion → 0.7", () => {
    expect(sourceQuality("task_completion")).toBe(0.7);
  });

  test("session_summary → 0.5", () => {
    expect(sourceQuality("session_summary")).toBe(0.5);
  });
});

describe("computeScore", () => {
  const now = new Date("2026-04-12T12:00:00Z");

  test("manual: similarity × 1.0 (no decay) × source(1.5) × boost × usefulness", () => {
    const candidate = makeCandidate({
      similarity: 0.8,
      source: "manual",
      createdAt: now.toISOString(),
      accessedAt: now.toISOString(),
      accessCount: 0,
    });
    const score = computeScore(candidate, now);
    // 0.8 * 1.0 (no decay for manual) * 1.0 (no boost) * 1.5 (source) * 1.0 (usefulness) = 1.2
    expect(score).toBeCloseTo(1.2, 5);
  });

  test("task_completion at 14d → penalized by decay AND source multiplier", () => {
    const candidate = makeCandidate({
      similarity: 0.8,
      source: "task_completion",
      createdAt: new Date(now.getTime() - 14 * 86400000).toISOString(),
      accessedAt: new Date(now.getTime() - 14 * 86400000).toISOString(),
      accessCount: 0,
    });
    const score = computeScore(candidate, now);
    // 0.8 * 0.5 (14d decay) * 1.0 (no boost) * 0.7 (source) * 1.0 (usefulness) = 0.28
    expect(score).toBeCloseTo(0.28, 2);
  });

  test("old manual vs fresh task_completion: manual wins on relevance", () => {
    const oldManual = makeCandidate({
      similarity: 0.8,
      source: "manual",
      createdAt: new Date(now.getTime() - 76 * 86400000).toISOString(),
      accessedAt: new Date(now.getTime() - 76 * 86400000).toISOString(),
      accessCount: 0,
    });
    const freshTC = makeCandidate({
      similarity: 0.05,
      source: "task_completion",
      createdAt: new Date(now.getTime() - 1 * 86400000).toISOString(),
      accessedAt: new Date(now.getTime() - 1 * 86400000).toISOString(),
      accessCount: 0,
    });
    // This is THE bug we're fixing: with the old flat 14d decay, the old manual
    // memory scored lower than fresh noise. Now manual has no decay.
    expect(computeScore(oldManual, now)).toBeGreaterThan(computeScore(freshTC, now));
  });
});

describe("rerank", () => {
  const now = new Date("2026-04-12T12:00:00Z");

  test("sorts by final score descending", () => {
    const candidates = [
      makeCandidate({
        similarity: 0.6,
        createdAt: now.toISOString(),
      }),
      makeCandidate({
        similarity: 0.9,
        createdAt: now.toISOString(),
      }),
      makeCandidate({
        similarity: 0.3,
        createdAt: now.toISOString(),
      }),
    ];
    const result = rerank(candidates, { limit: 10, now });
    expect(result[0]!.similarity).toBeGreaterThan(result[1]!.similarity);
    expect(result[1]!.similarity).toBeGreaterThan(result[2]!.similarity);
  });

  test("respects limit parameter", () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({ similarity: i / 10, createdAt: now.toISOString() }),
    );
    const result = rerank(candidates, { limit: 3, now });
    expect(result).toHaveLength(3);
  });

  test("handles empty candidate array", () => {
    const result = rerank([], { limit: 5, now });
    expect(result).toHaveLength(0);
  });

  test("handles candidates with zero accessCount", () => {
    const candidates = [
      makeCandidate({ similarity: 0.8, accessCount: 0, createdAt: now.toISOString() }),
      makeCandidate({ similarity: 0.7, accessCount: 0, createdAt: now.toISOString() }),
    ];
    const result = rerank(candidates, { limit: 2, now });
    expect(result[0]!.similarity).toBeGreaterThan(result[1]!.similarity);
  });

  test("recency boosts newer task_completion over older with same raw similarity", () => {
    const candidates = [
      makeCandidate({
        similarity: 0.8,
        source: "task_completion",
        createdAt: new Date(now.getTime() - 14 * 86400000).toISOString(),
      }),
      makeCandidate({
        similarity: 0.8,
        source: "task_completion",
        createdAt: now.toISOString(),
      }),
    ];
    const result = rerank(candidates, { limit: 2, now });
    expect(result[0]!.createdAt).toBe(now.toISOString());
  });

  test("now parameter enables deterministic testing", () => {
    const candidate = makeCandidate({
      similarity: 0.8,
      source: "task_completion",
      createdAt: new Date(now.getTime() - 7 * 86400000).toISOString(),
    });
    const result1 = rerank([candidate], { limit: 1, now });
    const result2 = rerank([candidate], { limit: 1, now });
    expect(result1[0]!.similarity).toBe(result2[0]!.similarity);
  });

  test("preserves rawSimilarity and compositeScore", () => {
    const candidate = makeCandidate({
      similarity: 0.8,
      source: "manual",
      createdAt: now.toISOString(),
    });
    const result = rerank([candidate], { limit: 1, now });
    expect(result[0]!.rawSimilarity).toBe(0.8);
    expect(result[0]!.compositeScore).toBeDefined();
    // For a fresh manual memory: 0.8 * 1.0 (no decay) * 1.0 (no boost) * 1.5 (source) * 1.0 (usefulness)
    expect(result[0]!.compositeScore).toBeCloseTo(1.2, 5);
    // similarity field = compositeScore
    expect(result[0]!.similarity).toBe(result[0]!.compositeScore);
  });
});

describe("usefulness", () => {
  let originalFloor: string | undefined;
  beforeEach(() => {
    originalFloor = process.env.MEMORY_DEMOTION_FLOOR;
    delete process.env.MEMORY_DEMOTION_FLOOR;
  });
  afterEach(() => {
    if (originalFloor === undefined) {
      delete process.env.MEMORY_DEMOTION_FLOOR;
    } else {
      process.env.MEMORY_DEMOTION_FLOOR = originalFloor;
    }
  });

  test("Beta(1,1) → exactly 1.0 (default prior is a no-op)", () => {
    expect(usefulness(1, 1)).toBe(1.0);
  });

  test("Beta(10,1) → clamp(2 * 10/11, 1, 2) ≈ 1.818", () => {
    const expected = Math.max(1.0, Math.min(2.0, (2 * 10) / 11));
    expect(usefulness(10, 1)).toBeCloseTo(expected, 5);
    expect(usefulness(10, 1)).toBeCloseTo(1.8181818, 5);
  });

  test("Beta(1,10) → 1.0 (floored at default MEMORY_DEMOTION_FLOOR=1.0)", () => {
    expect(usefulness(1, 10)).toBe(1.0);
  });

  test("Beta(50,1) → 2 * 50/51 ≈ 1.961 (approaches ceiling, never above 2.0)", () => {
    expect(usefulness(50, 1)).toBeCloseTo((2 * 50) / 51, 10);
    expect(usefulness(50, 1)).toBeLessThan(2.0);
  });

  test("ceiling clamp fires on degenerate β=0 (defensive)", () => {
    expect(usefulness(10, 0)).toBe(2.0);
  });

  test("MEMORY_DEMOTION_FLOOR=0.5 lowers the floor and enables demotion", () => {
    process.env.MEMORY_DEMOTION_FLOOR = "0.5";
    expect(usefulness(1, 10)).toBe(0.5);
  });
});

describe("source-aware scoring: manual memories survive age penalty", () => {
  const now = new Date("2026-06-08T12:00:00Z");

  test("76-day-old manual memory scores higher than 1-day-old noise task_completion", () => {
    // The root-cause scenario from Taras's report: a 76-day-old manual memory
    // with raw similarity 0.8 was being outscored by a 1-day-old noise result
    // with raw similarity 0.05. The old reranker gave the noise result a HIGHER
    // composite score because the flat 14d half-life crushed the old manual
    // memory by 2^(-76/14) = 0.023. Now manual has no decay.
    const oldManual = makeCandidate({
      similarity: 0.8,
      source: "manual",
      createdAt: new Date(now.getTime() - 76 * 86400000).toISOString(),
      accessedAt: new Date(now.getTime() - 76 * 86400000).toISOString(),
      accessCount: 0,
    });
    const freshNoise = makeCandidate({
      similarity: 0.05,
      source: "task_completion",
      createdAt: new Date(now.getTime() - 1 * 86400000).toISOString(),
      accessedAt: new Date(now.getTime() - 1 * 86400000).toISOString(),
      accessCount: 0,
    });

    const ranked = rerank([freshNoise, oldManual], { limit: 2, now });
    expect(ranked[0]!.source).toBe("manual");
    expect(ranked[0]!.rawSimilarity).toBe(0.8);
  });

  test("session_summary decays fast (7d half-life)", () => {
    const oldSummary = makeCandidate({
      similarity: 0.8,
      source: "session_summary",
      createdAt: new Date(now.getTime() - 14 * 86400000).toISOString(),
      accessedAt: new Date(now.getTime() - 14 * 86400000).toISOString(),
      accessCount: 0,
    });
    // At 14d with 7d half-life: decay = 2^(-14/7) = 0.25
    // Score: 0.8 * 0.25 * 0.5 (source) = 0.1
    expect(computeScore(oldSummary, now)).toBeCloseTo(0.1, 2);
  });
});
