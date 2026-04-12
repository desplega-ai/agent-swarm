import { describe, expect, test } from "bun:test";
import { accessBoost, computeScore, recencyDecay, rerank } from "../be/memory/reranker";
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
    ...overrides,
  };
}

describe("recencyDecay", () => {
  const now = new Date("2026-04-12T12:00:00Z");

  test("fresh memory → ~1.0", () => {
    const decay = recencyDecay(now.toISOString(), now);
    expect(decay).toBeCloseTo(1.0, 5);
  });

  test("memory at half-life (14d) → ~0.5", () => {
    const created = new Date(now.getTime() - 14 * 86400000).toISOString();
    const decay = recencyDecay(created, now);
    expect(decay).toBeCloseTo(0.5, 2);
  });

  test("memory at 2× half-life (28d) → ~0.25", () => {
    const created = new Date(now.getTime() - 28 * 86400000).toISOString();
    const decay = recencyDecay(created, now);
    expect(decay).toBeCloseTo(0.25, 2);
  });

  test("very old memory (365d) → near 0", () => {
    const created = new Date(now.getTime() - 365 * 86400000).toISOString();
    const decay = recencyDecay(created, now);
    expect(decay).toBeLessThan(0.001);
  });

  test("future memory → 1.0", () => {
    const created = new Date(now.getTime() + 86400000).toISOString();
    const decay = recencyDecay(created, now);
    expect(decay).toBe(1.0);
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

describe("computeScore", () => {
  const now = new Date("2026-04-12T12:00:00Z");

  test("multiplies similarity × decay × boost", () => {
    const candidate = makeCandidate({
      similarity: 0.8,
      createdAt: now.toISOString(),
      accessedAt: now.toISOString(),
      accessCount: 0,
    });
    const score = computeScore(candidate, now);
    // 0.8 * 1.0 * 1.0 = 0.8
    expect(score).toBeCloseTo(0.8, 5);
  });

  test("old memory with no access gets penalized", () => {
    const candidate = makeCandidate({
      similarity: 0.8,
      createdAt: new Date(now.getTime() - 14 * 86400000).toISOString(),
      accessedAt: new Date(now.getTime() - 14 * 86400000).toISOString(),
      accessCount: 0,
    });
    const score = computeScore(candidate, now);
    // 0.8 * 0.5 * 1.0 = 0.4
    expect(score).toBeCloseTo(0.4, 2);
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

  test("recency boosts newer memory over older with same raw similarity", () => {
    const candidates = [
      makeCandidate({
        similarity: 0.8,
        createdAt: new Date(now.getTime() - 14 * 86400000).toISOString(), // 14d old
      }),
      makeCandidate({
        similarity: 0.8,
        createdAt: now.toISOString(), // fresh
      }),
    ];
    const result = rerank(candidates, { limit: 2, now });
    // Fresh memory should rank higher due to recency decay
    expect(result[0]!.createdAt).toBe(now.toISOString());
  });

  test("now parameter enables deterministic testing", () => {
    const candidate = makeCandidate({
      similarity: 0.8,
      createdAt: new Date(now.getTime() - 7 * 86400000).toISOString(),
    });
    const result1 = rerank([candidate], { limit: 1, now });
    const result2 = rerank([candidate], { limit: 1, now });
    expect(result1[0]!.similarity).toBe(result2[0]!.similarity);
  });
});
