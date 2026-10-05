import { describe, expect, test } from "bun:test";
import type { SteeringMessage } from "@/api/types";
import type { ProviderMetaBlock, SubagentRun } from "@/logs-parser";
import {
  formatDur,
  matchingRowIndex,
  type StreamRow,
  summarizeActivity,
  summarizeEnd,
  summaryText,
  type ToolEntry,
  toMessageRows,
} from "./session-log-messages";

const ISO = "2026-10-05T11:36:33.000Z";

function at(seconds: number): string {
  return new Date(Date.parse(ISO) + seconds * 1000).toISOString();
}

function agent(id: string, md = `message ${id}`): StreamRow {
  return { type: "agent", id, role: "assistant", time: "11:36:33", iso: ISO, md, isNew: false };
}

function thinking(id: string): StreamRow {
  return { type: "thinking", id, time: "11:36:33", iso: ISO, text: "hmm", isNew: false };
}

function meta(id: string, block: Partial<ProviderMetaBlock>, isNew = false): StreamRow {
  return {
    type: "meta",
    id,
    time: "11:36:33",
    iso: ISO,
    block: { kind: "helper", provider: "claude", data: {}, ...block } as ProviderMetaBlock,
    isNew,
  };
}

function thoughtFor(id: string, seconds: number): StreamRow {
  return meta(id, {
    kind: "helper",
    data: { helperType: "thinking_token_group", firstIso: at(0), lastIso: at(seconds) },
  });
}

function tool(id: string, name = "Read"): ToolEntry {
  return {
    id,
    kind: "file",
    name,
    server: "",
    title: name,
    detail: "",
    input: "",
    preview: "ok",
    body: "",
    ok: true,
    hasResult: true,
    durMs: 0,
  };
}

function toolgroup(id: string, names: string[], durMs: number, isNew = false): StreamRow {
  return {
    type: "toolgroup",
    id,
    time: "11:36:33",
    iso: ISO,
    tools: names.map((name, i) => tool(`${id}-t${i}`, name)),
    names: [...new Set(names)],
    durMs,
    defaultOpen: false,
    isNew,
  };
}

function result(id: string, data: Record<string, unknown>): StreamRow {
  return meta(id, { kind: "result", data });
}

function steering(id: string): StreamRow {
  return {
    type: "steering",
    id,
    time: "11:36:33",
    iso: ISO,
    message: { id } as SteeringMessage,
    isNew: false,
  };
}

function subagent(id: string): StreamRow {
  return {
    type: "subagent",
    id,
    time: "11:36:33",
    iso: ISO,
    run: { id } as SubagentRun,
    isNew: false,
  };
}

function compaction(id: string): StreamRow {
  return {
    type: "compaction",
    id,
    snapshot: { id } as Extract<StreamRow, { type: "compaction" }>["snapshot"],
  };
}

function activityOf(rows: StreamRow[], index: number) {
  const row = rows[index];
  if (row?.type !== "activity") throw new Error(`row ${index} is ${row?.type}, not activity`);
  return row;
}

function endOf(rows: StreamRow[], index: number) {
  const row = rows[index];
  if (row?.type !== "end") throw new Error(`row ${index} is ${row?.type}, not end`);
  return row;
}

describe("toMessageRows", () => {
  test("keeps messages, steering, subagents and compactions, in order", () => {
    const rows = [agent("a1"), steering("s1"), subagent("sub1"), compaction("c1"), agent("a2")];
    expect(toMessageRows(rows)).toEqual(rows);
  });

  test("folds each run of tool, thinking and helper rows into one activity row", () => {
    const run = [thinking("t1"), toolgroup("g1", ["Read", "Grep"], 4200), thoughtFor("h1", 2)];
    const out = toMessageRows([agent("a1"), ...run, agent("a2")]);
    expect(out.map((row) => row.type)).toEqual(["agent", "activity", "agent"]);
    const activity = activityOf(out, 1);
    expect(activity.id).toBe("activity-t1");
    expect(activity.rows).toEqual(run);
  });

  test("a result row becomes one end row and ends the run before it", () => {
    const out = toMessageRows([
      toolgroup("g1", ["Bash"], 1000),
      result("r1", { total_cost_usd: 1.2141, duration_ms: 176_000, num_turns: 26 }),
      toolgroup("g2", ["Read"], 500),
    ]);
    expect(out.map((row) => row.type)).toEqual(["activity", "end", "activity"]);
    expect(out.map((row) => row.id)).toEqual(["activity-g1", "end-r1", "activity-g2"]);
    expect(endOf(out, 1)).toMatchObject({
      isError: false,
      costUsd: 1.2141,
      durationMs: 176_000,
      turns: 26,
    });
  });

  test("reads the result's cost record first, as the RESULT card does", () => {
    const out = toMessageRows([
      result("r1", {
        cost: { totalCostUsd: 0.5, durationMs: 9000, numTurns: 3, isError: true },
        total_cost_usd: 9,
      }),
    ]);
    expect(endOf(out, 0)).toMatchObject({
      isError: true,
      costUsd: 0.5,
      durationMs: 9000,
      turns: 3,
    });
  });

  test("ids stay stable while a live run grows, and isNew follows its first row", () => {
    const before = toMessageRows([agent("a1"), toolgroup("g1", ["Read"], 100)]);
    const after = toMessageRows([
      agent("a1"),
      toolgroup("g1", ["Read"], 100),
      thinking("t2"),
      toolgroup("g2", ["Edit"], 300, true),
    ]);
    expect(activityOf(after, 1).id).toBe(activityOf(before, 1).id);
    expect(activityOf(after, 1).isNew).toBe(false);
    expect(activityOf(after, 1).rows).toHaveLength(3);
    const fresh = toMessageRows([agent("a1"), toolgroup("g3", ["Read"], 100, true)]);
    expect(activityOf(fresh, 1).isNew).toBe(true);
  });

  test("does not change the input rows", () => {
    const rows = [agent("a1"), toolgroup("g1", ["Read"], 100), result("r1", {})];
    const copy = structuredClone(rows);
    toMessageRows(rows);
    expect(rows).toEqual(copy);
  });

  test("no rows give no rows", () => {
    expect(toMessageRows([])).toEqual([]);
  });
});

describe("matchingRowIndex", () => {
  const everything = [
    agent("a1"),
    thinking("t1"),
    toolgroup("g1", ["Read"], 100),
    result("r1", {}),
    agent("a2"),
  ];
  const messages = toMessageRows(everything);

  test("Everything to Messages: the same message, the folding line, the end line", () => {
    expect(messages.map((row) => row.id)).toEqual(["a1", "activity-t1", "end-r1", "a2"]);
    expect(matchingRowIndex(messages, "a2")).toBe(3);
    expect(matchingRowIndex(messages, "t1")).toBe(1);
    expect(matchingRowIndex(messages, "g1")).toBe(1);
    expect(matchingRowIndex(messages, "r1")).toBe(2);
  });

  test("Messages to Everything: an activity line goes to its first row, an end line to its result", () => {
    expect(matchingRowIndex(everything, "a1")).toBe(0);
    expect(matchingRowIndex(everything, "activity-t1")).toBe(1);
    expect(matchingRowIndex(everything, "end-r1")).toBe(3);
  });

  test("-1 when the rows do not hold it", () => {
    expect(matchingRowIndex([agent("a1")], "g1")).toBe(-1);
    expect(matchingRowIndex([], "a1")).toBe(-1);
  });
});

describe("summarizeActivity", () => {
  test("counts tools across the run, sums their time, and adds thinking from 1 s", () => {
    const [activity] = toMessageRows([
      toolgroup("g1", ["Read", "Grep", "Read"], 4200),
      thoughtFor("h1", 2),
      toolgroup("g2", ["Edit"], 800),
    ]);
    const summary = summarizeActivity(activity as Extract<StreamRow, { type: "activity" }>);
    expect(summary).toEqual({
      title: "Ran 4 tools",
      stats: ["5.0s", "thought for 2.0s"],
      names: ["Read", "Grep", "Edit"],
    });
    expect(summaryText(summary)).toBe("Ran 4 tools · 5.0s · thought for 2.0s");
  });

  test("leaves out thinking under 1 s and a zero tool time", () => {
    const [activity] = toMessageRows([toolgroup("g1", ["Bash"], 0), thoughtFor("h1", 0)]);
    expect(
      summaryText(summarizeActivity(activity as Extract<StreamRow, { type: "activity" }>)),
    ).toBe("Ran 1 tool");
  });

  test("a run with thinking only", () => {
    const [long] = toMessageRows([thinking("t1"), thoughtFor("h1", 3)]);
    expect(summaryText(summarizeActivity(long as Extract<StreamRow, { type: "activity" }>))).toBe(
      "Thought for 3.0s",
    );
    const [short] = toMessageRows([thinking("t1")]);
    expect(summaryText(summarizeActivity(short as Extract<StreamRow, { type: "activity" }>))).toBe(
      "Thought",
    );
  });

  test("a run with no tool and no thinking counts its events", () => {
    const [one] = toMessageRows([meta("m1", { kind: "internal", data: { internalType: "hook" } })]);
    expect(summaryText(summarizeActivity(one as Extract<StreamRow, { type: "activity" }>))).toBe(
      "1 event",
    );
    const [two] = toMessageRows([
      meta("m1", { kind: "lifecycle", data: {} }),
      meta("m2", { kind: "status", data: {} }),
    ]);
    expect(summaryText(summarizeActivity(two as Extract<StreamRow, { type: "activity" }>))).toBe(
      "2 events",
    );
  });
});

describe("summarizeEnd", () => {
  test("a finished run: cost, run time and turns", () => {
    const [end] = toMessageRows([
      result("r1", { total_cost_usd: 1.2141, duration_ms: 176_000, num_turns: 26 }),
    ]);
    expect(summaryText(summarizeEnd(end as Extract<StreamRow, { type: "end" }>))).toBe(
      "Finished · $1.21 · 2m 56s · 26 turns",
    );
  });

  test("a run that ended with an error, one turn, no cost", () => {
    const [end] = toMessageRows([
      result("r1", { is_error: true, duration_ms: 9800, num_turns: 1 }),
    ]);
    expect(summaryText(summarizeEnd(end as Extract<StreamRow, { type: "end" }>))).toBe(
      "Ended with an error · 9.8s · 1 turn",
    );
  });

  test("a result with no numbers is one word", () => {
    const [end] = toMessageRows([result("r1", {})]);
    expect(summaryText(summarizeEnd(end as Extract<StreamRow, { type: "end" }>))).toBe("Finished");
  });
});

describe("formatDur", () => {
  test("ms, seconds, minutes, and nothing for zero", () => {
    expect(formatDur(0)).toBe("");
    expect(formatDur(450)).toBe("450ms");
    expect(formatDur(9800)).toBe("9.8s");
    expect(formatDur(42_000)).toBe("42s");
    expect(formatDur(176_000)).toBe("2m 56s");
    expect(formatDur(120_000)).toBe("2m");
  });
});
