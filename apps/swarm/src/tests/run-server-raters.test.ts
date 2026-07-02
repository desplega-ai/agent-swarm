import { describe, expect, test } from "bun:test";
import { runServerRaters } from "../be/memory/raters/run-server-raters";
import type { ApplyRatingResult } from "../be/memory/raters/store";
import type { MemoryRater, RatingContext, RatingEvent } from "../be/memory/raters/types";

// ─────────────────────────────────────────────────────────────────────────────
// Pure unit tests for `runServerRaters` — the orchestration extracted from the
// inline IIFE at `src/tools/store-progress.ts` (PR #426 review feedback).
//
// All tests use stub raters and an in-memory `applyRating`, so no DB / no env
// fiddling is required. The DB-backed end-to-end coverage already lives in
// `memory-rater-implicit-citation.test.ts`.
// ─────────────────────────────────────────────────────────────────────────────

class StubRater implements MemoryRater {
  public calls: RatingContext[] = [];
  constructor(
    public readonly name: string,
    private readonly emit: (ctx: RatingContext) => RatingEvent[],
  ) {}
  async rate(ctx: RatingContext): Promise<RatingEvent[]> {
    this.calls.push(ctx);
    return this.emit(ctx);
  }
}

function captureApply(): {
  fn: (events: RatingEvent[], ctx: { taskId?: string }) => ApplyRatingResult;
  calls: { events: RatingEvent[]; ctx: { taskId?: string } }[];
} {
  const calls: { events: RatingEvent[]; ctx: { taskId?: string } }[] = [];
  return {
    calls,
    fn: (events, ctx) => {
      calls.push({ events, ctx });
      return { applied: events.length, rejected: [] };
    },
  };
}

const baseInput = {
  taskId: "task-1",
  agentId: "agent-1",
  retrievedMemoryIds: ["mem-A", "mem-B"],
  evidence: "agent referenced mem-A in its work",
};

describe("runServerRaters", () => {
  test("no-ops when retrievedMemoryIds is empty", async () => {
    const apply = captureApply();
    const stub = new StubRater("implicit-citation", () => [
      { memoryId: "mem-A", signal: 1, weight: 0.5, source: "" },
    ]);

    const out = await runServerRaters(
      { ...baseInput, retrievedMemoryIds: [] },
      {
        raters: [stub],
        serverRaterNames: new Set(["implicit-citation"]),
        weightMultiplierFor: () => 1,
        applyRating: apply.fn,
      },
    );

    expect(out).toEqual({ ratersFired: 0, outcomes: [] });
    expect(stub.calls).toHaveLength(0);
    expect(apply.calls).toHaveLength(0);
  });

  test("filters out raters whose name is not in the server allow-list", async () => {
    const apply = captureApply();
    const allowed = new StubRater("implicit-citation", () => [
      { memoryId: "mem-A", signal: 1, weight: 0.5, source: "" },
    ]);
    const blocked = new StubRater("llm", () => [
      { memoryId: "mem-A", signal: 1, weight: 0.9, source: "" },
    ]);

    const out = await runServerRaters(baseInput, {
      raters: [allowed, blocked],
      serverRaterNames: new Set(["implicit-citation"]),
      weightMultiplierFor: () => 1,
      applyRating: apply.fn,
    });

    expect(out.ratersFired).toBe(1);
    expect(allowed.calls).toHaveLength(1);
    expect(blocked.calls).toHaveLength(0);
    expect(apply.calls).toHaveLength(1);
    expect(apply.calls[0]!.events.map((e) => e.source)).toEqual(["implicit-citation"]);
  });

  test("stamps source from rater.name regardless of any source the rater set", async () => {
    const apply = captureApply();
    const spoofy = new StubRater("implicit-citation", () => [
      // A misbehaving rater tries to spoof its source.
      { memoryId: "mem-A", signal: 1, weight: 0.5, source: "evil-rater" },
      { memoryId: "mem-B", signal: -1, weight: 0.25, source: "evil-rater" },
    ]);

    await runServerRaters(baseInput, {
      raters: [spoofy],
      serverRaterNames: new Set(["implicit-citation"]),
      weightMultiplierFor: () => 1,
      applyRating: apply.fn,
    });

    expect(apply.calls).toHaveLength(1);
    for (const e of apply.calls[0]!.events) {
      expect(e.source).toBe("implicit-citation");
    }
  });

  test("applies the configured weight multiplier and clamps the result to [0, 1]", async () => {
    const apply = captureApply();
    const stub = new StubRater("implicit-citation", () => [
      { memoryId: "mem-A", signal: 1, weight: 0.5, source: "" },
      { memoryId: "mem-B", signal: -1, weight: 0.25, source: "" },
    ]);

    // Multiplier of 4 would push mem-A to 2.0, which must clamp to 1.0.
    await runServerRaters(baseInput, {
      raters: [stub],
      serverRaterNames: new Set(["implicit-citation"]),
      weightMultiplierFor: () => 4,
      applyRating: apply.fn,
    });

    const stamped = apply.calls[0]!.events;
    const a = stamped.find((e) => e.memoryId === "mem-A")!;
    const b = stamped.find((e) => e.memoryId === "mem-B")!;
    expect(a.weight).toBe(1);
    expect(b.weight).toBe(1); // 0.25 * 4 = 1.0 (boundary)
    // Signal must not change.
    expect(a.signal).toBe(1);
    expect(b.signal).toBe(-1);
  });

  test("clamps a negative multiplier weight to 0 (defensive — config is meant to be ≥ 0)", async () => {
    const apply = captureApply();
    const stub = new StubRater("implicit-citation", () => [
      { memoryId: "mem-A", signal: 1, weight: 0.5, source: "" },
    ]);

    await runServerRaters(baseInput, {
      raters: [stub],
      serverRaterNames: new Set(["implicit-citation"]),
      weightMultiplierFor: () => -10,
      applyRating: apply.fn,
    });

    expect(apply.calls[0]!.events[0]!.weight).toBe(0);
  });

  test("multiplier of 0 zeroes the weight without dropping the event", async () => {
    const apply = captureApply();
    const stub = new StubRater("implicit-citation", () => [
      { memoryId: "mem-A", signal: 1, weight: 0.5, source: "" },
    ]);

    await runServerRaters(baseInput, {
      raters: [stub],
      serverRaterNames: new Set(["implicit-citation"]),
      weightMultiplierFor: () => 0,
      applyRating: apply.fn,
    });

    expect(apply.calls).toHaveLength(1);
    expect(apply.calls[0]!.events[0]!.weight).toBe(0);
  });

  test("skips applyRating entirely when a rater returns no events", async () => {
    const apply = captureApply();
    const empty = new StubRater("implicit-citation", () => []);

    const out = await runServerRaters(baseInput, {
      raters: [empty],
      serverRaterNames: new Set(["implicit-citation"]),
      weightMultiplierFor: () => 1,
      applyRating: apply.fn,
    });

    expect(out.ratersFired).toBe(0);
    expect(apply.calls).toHaveLength(0);
  });

  test("forwards taskId, agentId, retrievedMemoryIds, and evidence to each rater", async () => {
    const apply = captureApply();
    const stub = new StubRater("implicit-citation", () => [
      { memoryId: "mem-A", signal: 1, weight: 0.5, source: "" },
    ]);

    await runServerRaters(baseInput, {
      raters: [stub],
      serverRaterNames: new Set(["implicit-citation"]),
      weightMultiplierFor: () => 1,
      applyRating: apply.fn,
    });

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toEqual({
      taskId: "task-1",
      agentId: "agent-1",
      retrievedMemoryIds: ["mem-A", "mem-B"],
      evidence: "agent referenced mem-A in its work",
    });
  });

  test("forwards taskId to applyRating context", async () => {
    const apply = captureApply();
    const stub = new StubRater("implicit-citation", () => [
      { memoryId: "mem-A", signal: 1, weight: 0.5, source: "" },
    ]);

    await runServerRaters(baseInput, {
      raters: [stub],
      serverRaterNames: new Set(["implicit-citation"]),
      weightMultiplierFor: () => 1,
      applyRating: apply.fn,
    });

    expect(apply.calls[0]!.ctx).toEqual({ taskId: "task-1" });
  });

  test("fires every allow-listed rater independently and returns one outcome per fire", async () => {
    const apply = captureApply();
    const r1 = new StubRater("rater-1", () => [
      { memoryId: "mem-A", signal: 1, weight: 0.5, source: "" },
    ]);
    const r2 = new StubRater("rater-2", () => [
      { memoryId: "mem-B", signal: -1, weight: 0.25, source: "" },
    ]);
    const weights = new Map<string, number>([
      ["rater-1", 0.5],
      ["rater-2", 1],
    ]);

    const out = await runServerRaters(baseInput, {
      raters: [r1, r2],
      serverRaterNames: new Set(["rater-1", "rater-2"]),
      weightMultiplierFor: (n) => weights.get(n) ?? 1,
      applyRating: apply.fn,
    });

    expect(out.ratersFired).toBe(2);
    expect(out.outcomes.map((o) => o.rater)).toEqual(["rater-1", "rater-2"]);
    expect(apply.calls).toHaveLength(2);
    // rater-1: 0.5 * 0.5 = 0.25
    expect(apply.calls[0]!.events[0]!.weight).toBe(0.25);
    expect(apply.calls[0]!.events[0]!.source).toBe("rater-1");
    // rater-2: 0.25 * 1 = 0.25
    expect(apply.calls[1]!.events[0]!.weight).toBe(0.25);
    expect(apply.calls[1]!.events[0]!.source).toBe("rater-2");
  });

  test("propagates rater errors so callers can wrap with try/catch", async () => {
    const apply = captureApply();
    const broken: MemoryRater = {
      name: "implicit-citation",
      rate: async () => {
        throw new Error("rater blew up");
      },
    };

    await expect(
      runServerRaters(baseInput, {
        raters: [broken],
        serverRaterNames: new Set(["implicit-citation"]),
        weightMultiplierFor: () => 1,
        applyRating: apply.fn,
      }),
    ).rejects.toThrow("rater blew up");
    expect(apply.calls).toHaveLength(0);
  });

  test("preserves rater-supplied reasoning on stamped events", async () => {
    const apply = captureApply();
    const stub = new StubRater("implicit-citation", () => [
      { memoryId: "mem-A", signal: 1, weight: 0.5, source: "", reasoning: "cited explicitly" },
    ]);

    await runServerRaters(baseInput, {
      raters: [stub],
      serverRaterNames: new Set(["implicit-citation"]),
      weightMultiplierFor: () => 1,
      applyRating: apply.fn,
    });

    expect(apply.calls[0]!.events[0]!.reasoning).toBe("cited explicitly");
  });
});
