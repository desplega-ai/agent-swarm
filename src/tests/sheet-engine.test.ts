import { describe, expect, test } from "bun:test";
import { MAX_ENGINE_CALLS, SheetEngine } from "../be/primitives/sheets/engine";
import { MAX_CELLS, type SheetDoc } from "../be/primitives/sheets/format";

// The engine's timeout kill and its queue bounds take a per-call timeout and a call count that no
// MCP tool exposes, so a black-box scenario cannot reach them. Everything else is in knowledge-sheets*.
describe("sheet engine", () => {
  test("a call that outruns its timeout is killed and the next call gets a fresh worker", async () => {
    const engine = new SheetEngine();
    try {
      const cells: SheetDoc["tabs"][number]["cells"] = {};
      for (let r = 1; r <= 3000; r++) cells[`A${r}`] = { v: r };
      const tabs = [{ name: "S", cells }];
      await expect(engine.recalc(tabs, [], { maxCells: MAX_CELLS, timeoutMs: 1 })).rejects.toThrow(
        "timed out",
      );
      const out = await engine.recalc(
        tabs,
        [{ tab: "S", row: 1, col: 2, input: "=SUM(A1:A3000)" }],
        { maxCells: MAX_CELLS },
      );
      expect(out.cells[0]?.B1?.v).toBe(4_501_500);
    } finally {
      engine.stop();
    }
  }, 20_000);

  test("the queue is bounded per caller and in total, and oversized input is refused before queueing", async () => {
    const engine = new SheetEngine();
    try {
      const tabs = [{ name: "S", cells: {} }];
      const call = (caller: string) => engine.recalc(tabs, [], { maxCells: MAX_CELLS, caller });
      const first = [call("a"), call("a")];
      await expect(call("a")).rejects.toThrow("busy");
      const others = Array.from({ length: MAX_ENGINE_CALLS - 2 }, (_, i) => call(`b${i}`));
      await expect(call("c")).rejects.toThrow("busy");
      await Promise.all([...first, ...others]);
      // Slots free up once the calls settle.
      await call("a");
      await expect(
        engine.recalc([{ name: "S", cells: { A1: { v: 1 }, A2: { v: 2 } } }], [], { maxCells: 1 }),
      ).rejects.toThrow("would exceed 1 cells");
      // Incoming patches and literal spill sizes count before the worker evaluates anything.
      const empty = [{ name: "S", cells: {} }];
      const patch = (input: string) => [{ tab: "S", row: 1, col: 1, input }];
      await expect(
        engine.recalc(empty, patch("=SEQUENCE(1000000)"), { maxCells: 10 }),
      ).rejects.toThrow("spilled by array formulas");
      await expect(
        engine.recalc(empty, [...patch("1"), { tab: "S", row: 2, col: 1, input: "2" }], {
          maxCells: 1,
        }),
      ).rejects.toThrow("would exceed 1 cells");
    } finally {
      engine.stop();
    }
  }, 20_000);
});
