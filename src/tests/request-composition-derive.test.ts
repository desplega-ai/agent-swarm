import { describe, expect, test } from "bun:test";
import {
  type CompositionCall,
  type CompositionManifest,
  compositionCallsOf,
  deriveCallCompositions,
  staticTokens,
} from "../../apps/ui/src/lib/request-composition";
import type { CallUsage, NormalizedItem } from "../../apps/ui/src/logs-parser/types";

const T0 = Date.parse("2026-10-26T10:00:00.000Z");

function manifest(overrides: Partial<CompositionManifest> = {}): CompositionManifest {
  return {
    id: "m-0",
    taskId: "task-1",
    agentId: "agent-1",
    sessionId: "s-1",
    seq: 0,
    provider: "claude",
    model: null,
    source: "worker",
    parts: [
      {
        kind: "system_section",
        id: "system.agent.role",
        label: "role",
        chars: 4000,
        estTokens: 1000,
        fidelity: "exact",
      },
      {
        kind: "persona",
        id: "persona",
        label: "persona",
        chars: 8000,
        estTokens: 2000,
        fidelity: "exact",
      },
      {
        kind: "tool_schemas",
        id: "mcp:agent-swarm",
        label: "tools",
        chars: 40000,
        estTokens: 10000,
        fidelity: "estimate",
      },
      {
        kind: "skills_listing",
        id: "skills_listing",
        label: "skills",
        chars: 4000,
        estTokens: 1000,
        fidelity: "estimate",
      },
      {
        kind: "task_prompt",
        id: "task_prompt",
        label: "task",
        chars: 2000,
        estTokens: 500,
        fidelity: "exact",
      },
      {
        kind: "memories",
        id: "memories",
        label: "memories",
        chars: 2000,
        estTokens: 500,
        fidelity: "exact",
      },
    ],
    staticEstTokens: 15000,
    tokenRatio: 1,
    createdAt: new Date(T0 - 1000).toISOString(),
    ...overrides,
  };
}

function call(
  callId: string,
  promptTokens: number,
  offsetMs: number,
  extra: Partial<CallUsage> = {},
  sessionId = "s-1",
): CompositionCall {
  return {
    sessionId,
    t: T0 + offsetMs,
    usage: {
      callId,
      promptTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      uncachedInputTokens: promptTokens,
      outputTokens: 10,
      sidechain: false,
      harness: "claude",
      reportedAt: "start",
      ...extra,
    },
  };
}

function sum(tokens: { tokens: number }[]): number {
  return tokens.reduce((acc, s) => acc + s.tokens, 0);
}

function tokensOf(segments: { group: string; tokens: number }[], group: string): number {
  return segments.find((s) => s.group === group)?.tokens ?? 0;
}

describe("deriveCallCompositions", () => {
  test("segments sum to each call's prompt tokens", () => {
    const { byCall } = deriveCallCompositions(
      [call("c1", 40_000, 0), call("c2", 52_000, 1000), call("c3", 90_000, 2000)],
      [manifest()],
    );
    for (const [id, prompt] of [
      ["c1", 40_000],
      ["c2", 52_000],
      ["c3", 90_000],
    ] as const) {
      const comp = byCall.get(id);
      expect(comp).toBeDefined();
      expect(sum(comp!.segments)).toBeCloseTo(prompt, 6);
      expect(comp!.scaled).toBe(false);
    }
  });

  test("the first main call anchors the harness base; later calls add history", () => {
    const { byCall, anchors } = deriveCallCompositions(
      [call("c1", 40_000, 0), call("c2", 52_000, 1000)],
      [manifest()],
    );
    const first = byCall.get("c1")!;
    expect(tokensOf(first.segments, "harness")).toBe(25_000);
    expect(tokensOf(first.segments, "history")).toBe(0);
    expect(tokensOf(first.segments, "task")).toBe(1000);
    const second = byCall.get("c2")!;
    expect(tokensOf(second.segments, "harness")).toBe(25_000);
    expect(tokensOf(second.segments, "history")).toBe(12_000);
    expect(anchors.get("m-0")).toEqual({
      callId: "c1",
      promptTokens: 40_000,
      residualTokens: 25_000,
    });
  });

  test("sub-agent calls are never the anchor and get no composition", () => {
    const { byCall, anchors } = deriveCallCompositions(
      [call("sub", 5_000, 0, { sidechain: true }), call("c1", 40_000, 1000)],
      [manifest()],
    );
    expect(byCall.has("sub")).toBe(false);
    expect(anchors.get("m-0")?.callId).toBe("c1");
    expect(tokensOf(byCall.get("c1")!.segments, "harness")).toBe(25_000);
  });

  test("a compaction starts a new anchor whose harness base never grows", () => {
    const compactions = [{ sessionId: "s-1", t: T0 + 1500 }];
    // Post-compaction prompt carries a 6k summary: it is history, not harness.
    const grown = deriveCallCompositions(
      [call("c1", 40_000, 0), call("c2", 120_000, 1000), call("c3", 46_000, 2000)],
      [manifest()],
      compactions,
    );
    const post = grown.byCall.get("c3")!;
    expect(tokensOf(post.segments, "harness")).toBe(25_000);
    expect(tokensOf(post.segments, "history")).toBe(6_000);
    // The rail's "first call" stays the session's first call.
    expect(grown.anchors.get("m-0")?.callId).toBe("c1");

    // The harness dropped part of its base after compacting: the base shrinks.
    const shrunk = deriveCallCompositions(
      [call("c1", 40_000, 0), call("c3", 30_000, 2000), call("c4", 33_000, 3000)],
      [manifest()],
      compactions,
    );
    expect(tokensOf(shrunk.byCall.get("c3")!.segments, "harness")).toBe(15_000);
    expect(tokensOf(shrunk.byCall.get("c4")!.segments, "history")).toBe(3_000);
    // Control: without the compaction, the base stays at the first call's.
    const control = deriveCallCompositions(
      [call("c1", 40_000, 0), call("c3", 30_000, 2000)],
      [manifest()],
    );
    expect(tokensOf(control.byCall.get("c3")!.segments, "harness")).toBe(
      25_000 * (30_000 / 40_000),
    );
  });

  test("nothing goes negative when the estimates overshoot the prompt", () => {
    const { byCall } = deriveCallCompositions(
      [call("c1", 9_000, 0), call("c2", 7_500, 1000)],
      [manifest()],
    );
    for (const id of ["c1", "c2"]) {
      const comp = byCall.get(id)!;
      expect(comp.scaled).toBe(true);
      for (const seg of comp.segments) expect(seg.tokens).toBeGreaterThan(0);
      expect(tokensOf(comp.segments, "harness")).toBe(0);
      expect(tokensOf(comp.segments, "history")).toBe(0);
    }
    expect(sum(byCall.get("c1")!.segments)).toBeCloseTo(9_000, 6);
    expect(sum(byCall.get("c2")!.segments)).toBeCloseTo(7_500, 6);
  });

  test("the token ratio scales the static parts", () => {
    const m = manifest({ tokenRatio: 1.2 });
    expect(staticTokens(m)).toBeCloseTo(18_000, 6);
    const { byCall } = deriveCallCompositions([call("c1", 40_000, 0)], [m]);
    expect(tokensOf(byCall.get("c1")!.segments, "tools")).toBeCloseTo(12_000, 6);
    expect(tokensOf(byCall.get("c1")!.segments, "harness")).toBeCloseTo(22_000, 6);
  });

  test("each session uses its own manifest; a later seq applies from its write time", () => {
    const s2 = manifest({ id: "m-s2", sessionId: "s-2", parts: manifest().parts.slice(0, 1) });
    const seq1 = manifest({
      id: "m-1",
      seq: 1,
      createdAt: new Date(T0 + 1500).toISOString(),
      parts: manifest().parts.slice(0, 2),
    });
    const { byCall } = deriveCallCompositions(
      [
        call("c1", 40_000, 0),
        call("c2", 41_000, 2000),
        call("d1", 20_000, 0, {}, "s-2"),
        call("x1", 20_000, 0, {}, "s-unknown"),
      ],
      [manifest(), seq1, s2],
    );
    expect(byCall.get("c1")!.manifest.id).toBe("m-0");
    expect(byCall.get("c2")!.manifest.id).toBe("m-1");
    expect(byCall.get("d1")!.manifest.id).toBe("m-s2");
    expect(tokensOf(byCall.get("d1")!.segments, "harness")).toBe(19_000);
    expect(byCall.has("x1")).toBe(false);
    for (const comp of byCall.values())
      expect(sum(comp.segments)).toBeCloseTo(comp.promptTokens, 6);
  });

  test("a hook manifest after the first call keeps later growth as history", () => {
    // The worker manifest (15k static) anchors c1. The harness hook then posts
    // exact parts worth 40k, the whole first prompt. c2's extra 12k is history.
    const hook = manifest({
      id: "m-hook",
      seq: 1,
      source: "harness-hook",
      createdAt: new Date(T0 + 500).toISOString(),
      parts: [{ ...manifest().parts[0]!, estTokens: 40_000, fidelity: "exact" }],
    });
    const { byCall, anchors } = deriveCallCompositions(
      [call("c1", 40_000, 0), call("c2", 52_000, 1000)],
      [manifest(), hook],
    );
    const second = byCall.get("c2")!;
    expect(second.manifest.id).toBe("m-hook");
    expect(tokensOf(second.segments, "harness")).toBe(0);
    expect(tokensOf(second.segments, "history")).toBe(12_000);
    expect(sum(second.segments)).toBeCloseTo(52_000, 6);
    expect(anchors.get("m-hook")).toEqual({
      callId: "c1",
      promptTokens: 40_000,
      residualTokens: 0,
    });
    // After a compaction the re-split base still caps the harness base: the
    // 6k summary is history.
    const compacted = deriveCallCompositions(
      [call("c1", 40_000, 0), call("c2", 52_000, 1000), call("c3", 46_000, 2000)],
      [manifest(), hook],
      [{ sessionId: "s-1", t: T0 + 1500 }],
    );
    expect(tokensOf(compacted.byCall.get("c3")!.segments, "harness")).toBe(0);
    expect(tokensOf(compacted.byCall.get("c3")!.segments, "history")).toBe(6_000);
    // A hook manifest smaller than the first prompt leaves the rest as harness.
    const partial = deriveCallCompositions(
      [call("c1", 40_000, 0), call("c2", 52_000, 1000)],
      [manifest(), { ...hook, parts: [{ ...hook.parts[0]!, estTokens: 30_000 }] }],
    );
    expect(tokensOf(partial.byCall.get("c2")!.segments, "harness")).toBe(10_000);
    expect(tokensOf(partial.byCall.get("c2")!.segments, "history")).toBe(12_000);
  });

  test("a later worker manifest keeps the harness base and swaps only the static parts", () => {
    // m-0 has 15k static, so c1 (40k) measures a 25k harness base. A worker
    // manifest then re-estimates the static parts as 16k. c2's history is
    // 55k − 16k − 25k = 14k.
    const part = manifest().parts[0]!;
    const first = manifest({ parts: [{ ...part, estTokens: 15_000 }] });
    const second = manifest({
      id: "m-1",
      seq: 1,
      createdAt: new Date(T0 + 500).toISOString(),
      parts: [{ ...part, estTokens: 16_000 }],
    });
    const { byCall, anchors } = deriveCallCompositions(
      [call("c1", 40_000, 0), call("c2", 55_000, 1000)],
      [first, second],
    );
    const c2 = byCall.get("c2")!;
    expect(c2.manifest.id).toBe("m-1");
    expect(tokensOf(c2.segments, "harness")).toBe(25_000);
    expect(tokensOf(c2.segments, "history")).toBe(14_000);
    expect(sum(c2.segments)).toBeCloseTo(55_000, 6);
    expect(anchors.get("m-1")).toEqual({
      callId: "c1",
      promptTokens: 40_000,
      residualTokens: 25_000,
    });
  });

  test("no manifests means no compositions", () => {
    expect(deriveCallCompositions([call("c1", 40_000, 0)], []).byCall.size).toBe(0);
  });
});

describe("compositionCallsOf", () => {
  test("keeps call_usage items whose record has a session", () => {
    const base = { fileIndex: 0, iteration: 1, lineNumber: 1, createdAt: "", t: T0, cli: "claude" };
    const usage = call("c1", 100, 0).usage;
    const items: NormalizedItem[] = [
      { ...base, recId: "r1", kind: "call_usage", usage },
      { ...base, recId: "r2", kind: "call_usage", usage: { ...usage, callId: "c2" } },
      { ...base, recId: "r1", kind: "text", text: "hi" },
    ];
    const calls = compositionCallsOf(items, (recId) => (recId === "r1" ? "s-1" : undefined));
    expect(calls).toEqual([{ usage, sessionId: "s-1", t: T0 }]);
  });
});
