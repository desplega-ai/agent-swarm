import { describe, expect, test } from "bun:test";
import { OUTCOME_PARAM } from "./assemble";
import {
  applyRange,
  type BulkBinding,
  dropActedIds,
  headerCheckState,
  hiddenSelectedCount,
  pruneSelection,
  runBulkChain,
  sameSelection,
  selectionFromState,
  setRowSelected,
  toggleAllVisible,
} from "./table-selection";

describe("selectionFromState", () => {
  test("keeps string and number ids as strings, drops junk and duplicates", () => {
    expect(selectionFromState(["a", 7, "a", null, { x: 1 }, true])).toEqual(["a", "7"]);
  });

  test("anything but an array is an empty selection", () => {
    expect(selectionFromState(undefined)).toEqual([]);
    expect(selectionFromState("a")).toEqual([]);
    expect(selectionFromState({ 0: "a" })).toEqual([]);
  });
});

describe("headerCheckState", () => {
  const visible = ["a", "b", "c"];
  test("none, some and all visible rows selected", () => {
    expect(headerCheckState(visible, new Set())).toBe(false);
    expect(headerCheckState(visible, new Set(["b"]))).toBe("indeterminate");
    expect(headerCheckState(visible, new Set(["a", "b", "c"]))).toBe(true);
  });

  test("a selected row hidden by a filter does not count", () => {
    expect(headerCheckState(visible, new Set(["z"]))).toBe(false);
    expect(headerCheckState(visible, new Set(["a", "b", "c", "z"]))).toBe(true);
  });

  test("no visible rows is unchecked", () => {
    expect(headerCheckState([], new Set(["a"]))).toBe(false);
  });
});

describe("setRowSelected", () => {
  test("adds in click order and never duplicates", () => {
    expect(setRowSelected(["b"], "a", true)).toEqual(["b", "a"]);
    expect(setRowSelected(["b"], "b", true)).toEqual(["b"]);
  });

  test("removes only the row", () => {
    expect(setRowSelected(["a", "b"], "a", false)).toEqual(["b"]);
    expect(setRowSelected(["a"], "z", false)).toEqual(["a"]);
  });
});

describe("toggleAllVisible", () => {
  test("selects every visible row, keeping what was already picked", () => {
    expect(toggleAllVisible(["z", "b"], ["a", "b", "c"])).toEqual(["z", "b", "a", "c"]);
  });

  test("deselects the visible rows when all are on, leaving hidden selections", () => {
    expect(toggleAllVisible(["z", "a", "b", "c"], ["a", "b", "c"])).toEqual(["z"]);
  });

  test("an indeterminate header selects the rest", () => {
    expect(toggleAllVisible(["a"], ["a", "b"])).toEqual(["a", "b"]);
  });

  test("nothing visible changes nothing", () => {
    expect(toggleAllVisible(["z"], [])).toEqual(["z"]);
  });
});

describe("applyRange", () => {
  const order = ["a", "b", "c", "d", "e"];

  test("selects the inclusive range in either direction", () => {
    expect(applyRange([], order, "b", "d", true)).toEqual(["b", "c", "d"]);
    expect(applyRange([], order, "d", "b", true)).toEqual(["b", "c", "d"]);
  });

  test("keeps existing picks and does not duplicate", () => {
    expect(applyRange(["c", "z"], order, "b", "d", true)).toEqual(["c", "z", "b", "d"]);
  });

  test("an unchecking shift-click clears the range", () => {
    expect(applyRange(["a", "b", "c", "d"], order, "b", "c", false)).toEqual(["a", "d"]);
  });

  test("uses the displayed (sorted) order, not the data order", () => {
    expect(applyRange([], ["c", "a", "b"], "c", "b", true)).toEqual(["c", "a", "b"]);
  });

  test("without a usable anchor it toggles one row", () => {
    expect(applyRange([], order, null, "c", true)).toEqual(["c"]);
    expect(applyRange([], order, "gone", "c", true)).toEqual(["c"]);
    expect(applyRange(["c"], order, null, "c", false)).toEqual([]);
  });
});

describe("pruneSelection / hiddenSelectedCount / sameSelection", () => {
  test("drops ids that left the data and keeps identity when nothing changed", () => {
    const selected = ["a", "b"];
    expect(pruneSelection(selected, new Set(["a"]))).toEqual(["a"]);
    expect(pruneSelection(selected, new Set(["a", "b", "c"]))).toBe(selected);
  });

  test("counts selected rows a filter hides", () => {
    expect(hiddenSelectedCount(["a", "z", "y"], ["a", "b"])).toBe(2);
  });

  test("order-sensitive equality", () => {
    expect(sameSelection(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameSelection(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameSelection(["a"], ["a", "b"])).toBe(false);
  });
});

describe("dropActedIds", () => {
  test("a finished action drops only the rows it acted on", () => {
    expect(dropActedIds(["a", "b", "late"], ["a", "b"])).toEqual(["late"]);
  });
});

describe("runBulkChain", () => {
  const OUT = "/ui/t/bulkOutcome";

  /** A fake runtime: the slots, and a scripted handler per step. */
  function harness(handler: (binding: BulkBinding, slots: Map<string, unknown>) => Promise<void>) {
    const slots = new Map<string, unknown>();
    const executed: string[] = [];
    let cancelled = false;
    let sleeps = 0;
    const deps = (chain: BulkBinding[], onSleep?: () => void) => ({
      chain,
      outcomePath: OUT,
      execute: async (binding: BulkBinding, extra?: Record<string, unknown>) => {
        executed.push(binding.action);
        await handler({ ...binding, params: { ...binding.params, ...extra } }, slots);
      },
      read: (path: string) => slots.get(path),
      write: (path: string, value: unknown) => void slots.set(path, value),
      cancelled: () => cancelled,
      sleep: async () => {
        sleeps++;
        onSleep?.();
      },
    });
    return {
      slots,
      executed,
      deps,
      cancel: () => {
        cancelled = true;
      },
      sleeps: () => sleeps,
    };
  }

  const mutate: BulkBinding = { action: "app.mutate", params: { model: "pr", op: "update" } };
  const action = (name: string): BulkBinding => ({ action: "app.action", params: { name } });

  test("a failed app.mutate (swallowed by its handler) fails the chain and stops it", async () => {
    const h = harness(async (b, slots) => {
      if (b.action === "app.mutate") {
        slots.set(b.params?.[OUTCOME_PARAM] as string, { status: "error", error: "boom" });
      }
    });
    expect(await runBulkChain(h.deps([mutate, action("after")]))).toBe("failed");
    expect(h.executed).toEqual(["app.mutate"]);
  });

  test("a mutate that reports ok lets the chain finish", async () => {
    const h = harness(async (b, slots) => {
      if (b.action === "app.mutate")
        slots.set(b.params?.[OUTCOME_PARAM] as string, { status: "ok" });
    });
    expect(await runBulkChain(h.deps([mutate, mutate]))).toBe("ok");
    expect(h.executed).toEqual(["app.mutate", "app.mutate"]);
  });

  test("a mutate whose renderer reports nothing is a failure, not a success", async () => {
    const h = harness(async () => {});
    expect(await runBulkChain(h.deps([mutate]))).toBe("failed");
  });

  test("a stale ok from an earlier step cannot vouch for the next mutate", async () => {
    let calls = 0;
    const h = harness(async (b, slots) => {
      calls++;
      if (calls === 1) slots.set(b.params?.[OUTCOME_PARAM] as string, { status: "ok" });
    });
    expect(await runBulkChain(h.deps([mutate, mutate]))).toBe("failed");
  });

  /** What the runtime's app.action handler writes: the shared slot AND the chain's own outcome. */
  const startTask = (b: BulkBinding, slots: Map<string, unknown>, taskId: string) => {
    const running = { status: "running", taskId };
    slots.set(`/actions/${b.params?.name}`, running);
    slots.set(b.params?.[OUTCOME_PARAM] as string, running);
  };

  test("a task-backed action waits for its task to finish before the chain continues", async () => {
    const h = harness(async (b, slots) => {
      if (b.params?.name === "enqueue") startTask(b, slots, "t1");
      else slots.set(b.params?.[OUTCOME_PARAM] as string, { status: "ok" });
    });
    // The task completes on the third poll.
    let polls = 0;
    const result = await runBulkChain(
      h.deps([action("enqueue"), action("after")], () => {
        polls++;
        if (polls === 3) h.slots.set(OUT, { status: "ok", taskId: "t1" });
      }),
    );
    expect(result).toBe("ok");
    expect(h.sleeps()).toBe(3);
    expect(h.executed).toEqual(["app.action", "app.action"]);
  });

  test("a task that fails after the handler returned fails the chain", async () => {
    const h = harness(async (b, slots) => {
      if (b.params?.name === "enqueue") startTask(b, slots, "t1");
    });
    const result = await runBulkChain(
      h.deps([action("enqueue"), action("after")], () =>
        h.slots.set(OUT, { status: "error", taskId: "t1", error: "task failed" }),
      ),
    );
    expect(result).toBe("failed");
    expect(h.executed).toEqual(["app.action"]);
  });

  test("another invocation of the same action finishing first does not end the bulk step", async () => {
    const h = harness(async (b, slots) => {
      if (b.params?.name === "enqueue") startTask(b, slots, "t1");
      else slots.set(b.params?.[OUTCOME_PARAM] as string, { status: "ok" });
    });
    let polls = 0;
    const result = await runBulkChain(
      h.deps([action("enqueue"), action("after")], () => {
        polls++;
        // A second click takes the shared slot, and its task succeeds while t1 still runs.
        if (polls === 1) h.slots.set("/actions/enqueue", { status: "running", taskId: "t2" });
        if (polls === 2) h.slots.set("/actions/enqueue", { status: "ok", taskId: "t2" });
        if (polls === 3) h.slots.set(OUT, { status: "error", taskId: "t1", error: "task failed" });
      }),
    );
    expect(result).toBe("failed");
    expect(h.sleeps()).toBe(3);
    expect(h.executed).toEqual(["app.action"]);
  });

  test("an outcome slot that stops naming the bulk task fails the chain", async () => {
    const h = harness(async (b, slots) => startTask(b, slots, "t1"));
    const result = await runBulkChain(
      h.deps([action("enqueue")], () => h.slots.set(OUT, { status: "ok", taskId: "t2" })),
    );
    expect(result).toBe("failed");
  });

  test("a running outcome without a task id is a failure, not a wait", async () => {
    const h = harness(async (b, slots) => {
      slots.set(b.params?.[OUTCOME_PARAM] as string, { status: "running" });
    });
    expect(await runBulkChain(h.deps([action("enqueue")]))).toBe("failed");
    expect(h.sleeps()).toBe(0);
  });

  test("an action that reports no outcome fails, even when its shared slot says ok", async () => {
    const h = harness(async (b, slots) => {
      slots.set(`/actions/${b.params?.name}`, { status: "ok" });
    });
    expect(await runBulkChain(h.deps([action("a")]))).toBe("failed");
  });

  test("an inline script action that ended ok finishes without waiting", async () => {
    const h = harness(async (b, slots) => {
      slots.set(b.params?.[OUTCOME_PARAM] as string, { status: "ok" });
    });
    expect(await runBulkChain(h.deps([action("a")]))).toBe("ok");
    expect(h.sleeps()).toBe(0);
  });

  test("a handler that throws fails the chain", async () => {
    const h = harness(async () => {
      throw new Error("network");
    });
    expect(await runBulkChain(h.deps([mutate]))).toBe("failed");
  });

  test("unmounting while a task runs cancels the wait", async () => {
    const h = harness(async (b, slots) => startTask(b, slots, "t1"));
    expect(await runBulkChain(h.deps([action("slow")], () => h.cancel()))).toBe("cancelled");
  });

  test("steps without a slot (toast, refresh) are not judged", async () => {
    const h = harness(async () => {});
    expect(await runBulkChain(h.deps([{ action: "app.refresh" }, { action: "ui.toast" }]))).toBe(
      "ok",
    );
  });
});
