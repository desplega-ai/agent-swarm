import { describe, expect, test } from "bun:test";
import { type ActiveToolSpanEntry, implicitCloseActiveToolSpans } from "../commands/runner";
import type { Attributes, AttributeValue, SwarmSpan } from "../otel";

/**
 * Minimal recording SwarmSpan stub for asserting attributes/status/end calls.
 * Keeps the runner-tool-spans unit test isolated from the real OTel SDK.
 */
type RecordingSpan = SwarmSpan & {
  attrs: Record<string, AttributeValue>;
  status?: { code: number; message?: string };
  ended: boolean;
};

function makeSpan(): RecordingSpan {
  const span: RecordingSpan = {
    attrs: {},
    ended: false,
    setAttribute(key: string, value: AttributeValue) {
      this.attrs[key] = value;
      return this;
    },
    setAttributes(attributes: Attributes) {
      for (const [k, v] of Object.entries(attributes)) {
        if (v !== undefined) this.attrs[k] = v;
      }
      return this;
    },
    addEvent() {
      return this;
    },
    recordException() {},
    setStatus(s) {
      this.status = s;
      return this;
    },
    end() {
      this.ended = true;
    },
  };
  return span;
}

function entry(span: SwarmSpan, opts: { startedAt: number }): ActiveToolSpanEntry {
  return { span, startedAt: opts.startedAt };
}

describe("implicitCloseActiveToolSpans", () => {
  test("closes worker.tool spans with implicit_close=true and accurate duration_ms", () => {
    const span = makeSpan();
    const map = new Map<string, ActiveToolSpanEntry>();
    map.set("call-1", entry(span, { startedAt: 1_000 }));

    const closed = implicitCloseActiveToolSpans(map, 1_750);

    expect(closed).toBe(1);
    expect(span.ended).toBe(true);
    expect(span.attrs["agentswarm.tool.implicit_close"]).toBe(true);
    expect(span.attrs["agentswarm.tool.duration_ms"]).toBe(750);
    expect(span.attrs["agentswarm.tool.call_id"]).toBe("call-1");
    expect(span.status?.code).toBe(1);
    expect(map.has("call-1")).toBe(false);
  });

  test("closes MCP spans at the assistant-message boundary too", () => {
    const mcpSpan = makeSpan();
    const harnessSpan = makeSpan();
    const map = new Map<string, ActiveToolSpanEntry>();
    map.set("mcp-1", entry(mcpSpan, { startedAt: 1_000 }));
    map.set("call-1", entry(harnessSpan, { startedAt: 1_000 }));

    const closed = implicitCloseActiveToolSpans(map, 2_000);

    expect(closed).toBe(2);
    expect(harnessSpan.ended).toBe(true);
    expect(harnessSpan.attrs["agentswarm.tool.implicit_close"]).toBe(true);
    expect(mcpSpan.ended).toBe(true);
    expect(mcpSpan.attrs["agentswarm.tool.implicit_close"]).toBe(true);
    expect(mcpSpan.attrs["agentswarm.tool.duration_ms"]).toBe(1_000);
    expect(mcpSpan.attrs["agentswarm.tool.call_id"]).toBe("mcp-1");
    expect(mcpSpan.status?.code).toBe(1);
    expect(map.size).toBe(0);
  });

  test("no-op on an empty map (and returns 0)", () => {
    const map = new Map<string, ActiveToolSpanEntry>();
    const closed = implicitCloseActiveToolSpans(map, Date.now());
    expect(closed).toBe(0);
    expect(map.size).toBe(0);
  });

  test("closes multiple parallel spans (mix of harness and MCP) from the same turn", () => {
    const a = makeSpan();
    const b = makeSpan();
    const c = makeSpan();
    const map = new Map<string, ActiveToolSpanEntry>();
    map.set("a", entry(a, { startedAt: 100 }));
    map.set("b", entry(b, { startedAt: 200 }));
    map.set("c", entry(c, { startedAt: 300 }));

    const closed = implicitCloseActiveToolSpans(map, 1_000);

    expect(closed).toBe(3);
    expect(a.attrs["agentswarm.tool.duration_ms"]).toBe(900);
    expect(b.attrs["agentswarm.tool.duration_ms"]).toBe(800);
    expect(c.attrs["agentswarm.tool.duration_ms"]).toBe(700);
    for (const span of [a, b, c]) {
      expect(span.ended).toBe(true);
      expect(span.attrs["agentswarm.tool.implicit_close"]).toBe(true);
    }
    expect(map.size).toBe(0);
  });

  test("called twice after a single turn → second call is a no-op", () => {
    const span = makeSpan();
    const map = new Map<string, ActiveToolSpanEntry>();
    map.set("call-1", entry(span, { startedAt: 1_000 }));

    expect(implicitCloseActiveToolSpans(map, 1_500)).toBe(1);
    expect(implicitCloseActiveToolSpans(map, 2_000)).toBe(0);
    // The span should not be ended twice or get a second duration overwrite.
    expect(span.attrs["agentswarm.tool.duration_ms"]).toBe(500);
  });
});

describe("end-to-end boundary semantics (helper integration)", () => {
  // Simulates the runner's event-handler contract:
  //   - tool_start adds an entry to the active-tool-spans map
  //   - assistant-message boundary calls `implicitCloseActiveToolSpans`
  //   - explicit tool_end closes the entry directly (no implicit_close attr)
  //   - session shutdown calls a `closeActiveToolSpans` analog as a safety net
  // We don't pull in the runner module directly (it imports the entire
  // provider/HTTP surface); instead the test mirrors its small fragment of
  // logic on the same exported helper.

  function startToolSpan(
    map: Map<string, ActiveToolSpanEntry>,
    toolCallId: string,
    opts: { startedAt: number },
  ): RecordingSpan {
    const span = makeSpan();
    map.set(toolCallId, { span, startedAt: opts.startedAt });
    return span;
  }

  function endToolSpan(
    map: Map<string, ActiveToolSpanEntry>,
    toolCallId: string,
    now: number,
  ): void {
    // Mirrors the explicit `tool_end` branch in runner.ts: sets duration + OK
    // status and ends the span. Crucially does NOT set `implicit_close`.
    const active = map.get(toolCallId);
    if (!active) return;
    active.span.setAttributes({
      "agentswarm.tool.duration_ms": now - active.startedAt,
    });
    active.span.setStatus({ code: 1 });
    active.span.end();
    map.delete(toolCallId);
  }

  function shutdownSafetyNet(
    map: Map<string, ActiveToolSpanEntry>,
    now: number,
  ): { closed: number } {
    // Mirrors `closeActiveToolSpans` (the safety net). After the boundary fix,
    // we expect this to be a no-op in the typical case.
    let closed = 0;
    for (const [toolCallId, active] of map) {
      active.span.setAttributes({
        "agentswarm.tool.duration_ms": now - active.startedAt,
        "agentswarm.tool.unclosed": true,
        "agentswarm.tool.call_id": toolCallId,
      });
      active.span.end();
      map.delete(toolCallId);
      closed++;
    }
    return { closed };
  }

  test("tool_start → assistant boundary → span closes with implicit_close=true", () => {
    const map = new Map<string, ActiveToolSpanEntry>();
    const span = startToolSpan(map, "call-1", { startedAt: 1_000 });

    implicitCloseActiveToolSpans(map, 1_500);

    expect(span.ended).toBe(true);
    expect(span.attrs["agentswarm.tool.implicit_close"]).toBe(true);
    expect(span.attrs["agentswarm.tool.duration_ms"]).toBe(500);
    expect(span.attrs["agentswarm.tool.unclosed"]).toBeUndefined();
    expect(map.size).toBe(0);
  });

  test("tool_start → tool_end → span closes WITHOUT implicit_close", () => {
    const map = new Map<string, ActiveToolSpanEntry>();
    const span = startToolSpan(map, "call-1", { startedAt: 1_000 });

    endToolSpan(map, "call-1", 1_200);

    expect(span.ended).toBe(true);
    expect(span.attrs["agentswarm.tool.duration_ms"]).toBe(200);
    expect(span.attrs["agentswarm.tool.implicit_close"]).toBeUndefined();
    expect(map.size).toBe(0);
  });

  test("MCP tool spans are also closed by the assistant-message boundary", () => {
    const map = new Map<string, ActiveToolSpanEntry>();
    const mcp = startToolSpan(map, "mcp-1", { startedAt: 1_000 });

    implicitCloseActiveToolSpans(map, 2_000);

    expect(mcp.ended).toBe(true);
    expect(mcp.attrs["agentswarm.tool.implicit_close"]).toBe(true);
    expect(mcp.attrs["agentswarm.tool.duration_ms"]).toBe(1_000);
    expect(map.size).toBe(0);
  });

  test("mixed harness + MCP tool_starts → both kinds closed with implicit_close=true at boundary", () => {
    // Simulates a turn where the model invokes both a harness tool (Bash) and
    // an MCP tool (e.g. mcp__agent-swarm__store-progress), and the next
    // assistant message arrives without any `tool_end` events from the
    // adapter (Claude SDK behavior).
    const map = new Map<string, ActiveToolSpanEntry>();
    const harness = startToolSpan(map, "bash-1", { startedAt: 1_000 });
    const mcp = startToolSpan(map, "mcp-1", { startedAt: 1_050 });

    const closed = implicitCloseActiveToolSpans(map, 2_500);

    expect(closed).toBe(2);
    expect(harness.ended).toBe(true);
    expect(mcp.ended).toBe(true);
    expect(harness.attrs["agentswarm.tool.implicit_close"]).toBe(true);
    expect(mcp.attrs["agentswarm.tool.implicit_close"]).toBe(true);
    expect(harness.attrs["agentswarm.tool.duration_ms"]).toBe(1_500);
    expect(mcp.attrs["agentswarm.tool.duration_ms"]).toBe(1_450);
    expect(harness.attrs["agentswarm.tool.unclosed"]).toBeUndefined();
    expect(mcp.attrs["agentswarm.tool.unclosed"]).toBeUndefined();
    expect(map.size).toBe(0);
  });

  test("after boundary closes all spans, shutdown safety net closes 0", () => {
    const map = new Map<string, ActiveToolSpanEntry>();
    startToolSpan(map, "call-1", { startedAt: 1_000 });
    startToolSpan(map, "call-2", { startedAt: 1_100 });

    implicitCloseActiveToolSpans(map, 1_800);
    expect(map.size).toBe(0);

    const { closed } = shutdownSafetyNet(map, 2_000);
    expect(closed).toBe(0);
  });

  test("if session ends before any boundary fires, safety net flags `unclosed`", () => {
    const map = new Map<string, ActiveToolSpanEntry>();
    const span = startToolSpan(map, "call-1", { startedAt: 1_000 });

    // No boundary, straight to shutdown.
    const { closed } = shutdownSafetyNet(map, 5_000);

    expect(closed).toBe(1);
    expect(span.ended).toBe(true);
    expect(span.attrs["agentswarm.tool.unclosed"]).toBe(true);
    expect(span.attrs["agentswarm.tool.implicit_close"]).toBeUndefined();
    expect(span.attrs["agentswarm.tool.duration_ms"]).toBe(4_000);
  });
});
