import { describe, expect, mock, test } from "bun:test";
import type { SteeringMessage } from "../../../api/types";
import type { ParsedMessage } from "../../../logs-parser";

// The root-level test run cannot resolve ui's `@/` alias (same pattern as
// review-ack.test.tsx). Utils map to the real module; the log viewer (a deep
// `@/` graph) is stubbed down to the tool classification the rows need.
mock.module("@/lib/utils", () => require("../../../lib/utils"));
mock.module("@/components/shared/session-log-viewer", () => ({
  classifyTool: (name: string) => ({
    kind: name === "Bash" ? "bash" : "file",
    name: name === "Bash" ? "bash" : name,
    server: "",
    title: name,
    detail: "",
  }),
}));

const { buildTranscriptRows, foldFinishedTurn, summarizeWork, workedForLabel } = await import(
  "./transcript-rows"
);
type WorkEntry = import("./transcript-rows").WorkEntry;

let seq = 0;
function msg(
  role: ParsedMessage["role"],
  content: ParsedMessage["content"],
  extra: Partial<ParsedMessage> = {},
): ParsedMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    role,
    content,
    iteration: 1,
    timestamp: `2026-10-30T10:00:${String(seq).padStart(2, "0")}Z`,
    ...extra,
  };
}

function tool(name: string, detail = "", status: "done" | "error" | "running" = "done"): WorkEntry {
  return {
    kind: "tool",
    id: `${name}-${detail}-${Math.random()}`,
    at: "2026-10-30T10:00:00Z",
    toolKind: name === "bash" ? "bash" : "file",
    name,
    title: name,
    detail,
    status,
  };
}

describe("buildTranscriptRows", () => {
  test("folds a run of tool calls between two messages into one work row", () => {
    const messages = [
      msg("user", [{ type: "text", text: "expanded prompt" }]),
      msg("assistant", [{ type: "text", text: "Looking." }]),
      msg("assistant", [
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
      ]),
      msg("user", [
        { type: "tool_result", tool_use_id: "t1", content: "ok" },
        { type: "tool_result", tool_use_id: "t2", content: "boom", isError: true },
      ]),
      msg("assistant", [{ type: "text", text: "Done." }]),
    ];
    const rows = buildTranscriptRows({ messages });
    expect(rows.map((r) => r.kind)).toEqual(["assistant", "work", "assistant"]);
    const work = rows[1];
    if (work.kind !== "work") throw new Error("expected a work row");
    expect(work.entries.map((e) => (e.kind === "tool" ? e.status : e.kind))).toEqual([
      "done",
      "error",
    ]);
  });

  test("leaves the harness's user turns and sub-agent messages out", () => {
    const rows = buildTranscriptRows({
      messages: [
        msg("user", [{ type: "text", text: "the expanded prompt" }]),
        msg("assistant", [{ type: "text", text: "from a sub-agent" }], { parentToolUseId: "x" }),
      ],
    });
    expect(rows).toEqual([]);
  });

  test("a call with no result yet is running", () => {
    const rows = buildTranscriptRows({
      messages: [msg("assistant", [{ type: "tool_use", id: "t9", name: "Grep", input: {} }])],
    });
    expect(rows[0]?.kind === "work" && rows[0].entries[0]).toMatchObject({ status: "running" });
  });

  test("without messages, only work and steering remain; steering ends a run", () => {
    const steer = {
      id: "s1",
      createdAt: "2026-10-30T10:00:30Z",
      body: "also check b",
    } as SteeringMessage;
    const rows = buildTranscriptRows({
      messages: [
        msg("assistant", [{ type: "text", text: "prose" }]),
        msg("assistant", [{ type: "thinking", thinking: "hmm" }]),
      ],
      steering: [steer],
      withMessages: false,
    });
    expect(rows.map((r) => r.kind)).toEqual(["work", "steer"]);
  });
});

describe("foldFinishedTurn", () => {
  test("keeps only the agent's last message out of the fold", () => {
    const rows = buildTranscriptRows({
      messages: [
        msg("assistant", [{ type: "text", text: "first" }]),
        msg("assistant", [{ type: "text", text: "last" }]),
        msg("assistant", [{ type: "tool_use", id: "t3", name: "Read", input: {} }]),
      ],
    });
    const { folded, kept } = foldFinishedTurn(rows);
    expect(kept.map((r) => (r.kind === "assistant" ? r.text : r.kind))).toEqual(["last"]);
    expect(folded.map((r) => r.kind)).toEqual(["assistant", "work"]);
  });

  test("folds everything when the agent wrote no prose", () => {
    const rows = buildTranscriptRows({
      messages: [msg("assistant", [{ type: "tool_use", id: "t4", name: "Read", input: {} }])],
    });
    expect(foldFinishedTurn(rows)).toEqual({ folded: rows, kept: [] });
  });
});

describe("summarizeWork", () => {
  test("names the two leading kinds of action and counts the rest", () => {
    expect(
      summarizeWork([
        tool("Read", "a"),
        tool("Read", "b"),
        tool("bash", "ls"),
        tool("Edit", "a"),
        tool("Edit", "a"),
        tool("Grep", "x"),
      ]),
    ).toBe("Ran 1 command, changed 1 file, and performed 3 other actions");
  });

  test("joins two parts with and", () => {
    expect(summarizeWork([tool("Read", "a"), tool("Read", "b"), tool("bash", "ls")])).toBe(
      "Ran 1 command and read 2 files",
    );
  });

  test("reasoning only reads as Thought", () => {
    const thinking: WorkEntry = { kind: "thinking", id: "t", at: "", text: "x" };
    expect(summarizeWork([thinking])).toBe("Thought");
    expect(summarizeWork([thinking, { ...thinking, id: "u" }])).toBe("Thought (×2)");
  });
});

describe("workedForLabel", () => {
  test("measures the run, or says Activity with no end", () => {
    expect(workedForLabel("2026-10-30T10:00:00Z", "2026-10-30T10:04:12Z")).toBe(
      "Worked for 4m 12s",
    );
    expect(workedForLabel("2026-10-30T10:00:00Z", undefined)).toBe("Activity");
  });
});
