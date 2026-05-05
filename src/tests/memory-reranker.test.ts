import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { accessBoost, computeScore, recencyDecay, rerank, usefulness } from "../be/memory/reranker";
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

describe("usefulness", () => {
  // The default-floor cases assume MEMORY_DEMOTION_FLOOR is unset/empty.
  // The override case sets and restores the env var.
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
    // NB: the clamp `Math.min(2.0, 2 * mean)` is a defensive ceiling — the
    // formula 2 * α/(α+β) is bounded above by 2 for any finite β > 0, so the
    // clamp only fires on degenerate inputs (β = 0). The plan's "===2.0"
    // expectation was a numerical slip; the asymptote is what we ship.
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

describe("backward-compat: MEMORY_RATERS unset → reranker is a no-op", () => {
  // Litmus for step-1: with default Beta(1,1) priors and the default
  // MEMORY_DEMOTION_FLOOR=1.0, computeScore must return EXACTLY the same value
  // as a pre-rater build (similarity * recencyDecay * accessBoost).
  const now = new Date("2026-04-12T12:00:00Z");

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

  test("computeScore equals similarity * recencyDecay * accessBoost (no usefulness drift)", () => {
    const cases: MemoryCandidate[] = [
      makeCandidate({
        similarity: 0.8,
        createdAt: now.toISOString(),
        accessedAt: now.toISOString(),
        accessCount: 0,
      }),
      makeCandidate({
        similarity: 0.5,
        createdAt: new Date(now.getTime() - 14 * 86400000).toISOString(),
        accessedAt: new Date(now.getTime() - 24 * 3600000).toISOString(),
        accessCount: 5,
      }),
      makeCandidate({
        similarity: 0.99,
        createdAt: new Date(now.getTime() - 28 * 86400000).toISOString(),
        accessedAt: new Date(now.getTime() - 72 * 3600000).toISOString(),
        accessCount: 12,
      }),
    ];

    for (const c of cases) {
      const expected =
        c.similarity *
        recencyDecay(c.createdAt, now) *
        accessBoost(c.accessedAt, c.accessCount, now);
      expect(computeScore(c, now)).toBe(expected);
    }
  });

  test("snapshot order + scores match a hard-coded pre-rater baseline", () => {
    // Baseline computed from main (pre-step-1): similarity * recencyDecay * accessBoost.
    // With alpha=beta=1 + default floor, the new code must produce identical numbers.
    const candidates = [
      makeCandidate({
        similarity: 0.9,
        createdAt: now.toISOString(),
        accessedAt: now.toISOString(),
        accessCount: 0,
      }),
      makeCandidate({
        similarity: 0.6,
        createdAt: new Date(now.getTime() - 7 * 86400000).toISOString(),
        accessedAt: now.toISOString(),
        accessCount: 0,
      }),
      makeCandidate({
        similarity: 0.3,
        createdAt: new Date(now.getTime() - 28 * 86400000).toISOString(),
        accessedAt: now.toISOString(),
        accessCount: 0,
      }),
    ];
    const result = rerank(candidates, { limit: 3, now });

    // Expected scores: similarity * 2^(-ageDays/14) (no access boost, alpha=beta=1).
    // 0.9 * 1.0      = 0.9
    // 0.6 * 2^(-0.5) ≈ 0.4242640687
    // 0.3 * 2^(-2)   = 0.075
    expect(result[0]!.similarity).toBeCloseTo(0.9, 10);
    expect(result[1]!.similarity).toBeCloseTo(0.6 * 2 ** -0.5, 10);
    expect(result[2]!.similarity).toBeCloseTo(0.075, 10);
  });

  test("usefulness multiplies into score when posteriors move", () => {
    // Sanity: a memory with α=10, β=1 should score ~1.818× higher than the same
    // memory at α=β=1, holding everything else constant. Other rows unchanged.
    const proven = makeCandidate({
      similarity: 0.5,
      createdAt: now.toISOString(),
      accessedAt: now.toISOString(),
      accessCount: 0,
      alpha: 10,
      beta: 1,
    });
    const baseline = makeCandidate({
      similarity: 0.5,
      createdAt: now.toISOString(),
      accessedAt: now.toISOString(),
      accessCount: 0,
    });
    expect(computeScore(proven, now) / computeScore(baseline, now)).toBeCloseTo(
      usefulness(10, 1),
      10,
    );
  });
});
