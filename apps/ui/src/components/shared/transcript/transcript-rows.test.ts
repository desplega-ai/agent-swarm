import { describe, expect, mock, test } from "bun:test";
import type { AgentTask, SteeringMessage } from "../../../api/types";
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

const {
  buildTranscriptRows,
  foldedTurnRows,
  pagedRows,
  summarizeWork,
  TRANSCRIPT_PAGE_ROWS,
  workedForLabel,
} = await import("./transcript-rows");
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

describe("steering order", () => {
  function steer(id: string, extra: Partial<SteeringMessage>): SteeringMessage {
    return { id, body: id, status: "delivered", ...extra } as SteeringMessage;
  }
  const kinds = (rows: ReturnType<typeof buildTranscriptRows>) =>
    rows.map((r) => (r.kind === "steer" ? r.message.id : r.kind === "assistant" ? r.text : r.kind));

  test("a queued message sits where the agent got it, after the work in between", () => {
    const rows = buildTranscriptRows({
      messages: [
        msg("assistant", [{ type: "text", text: "a" }], { timestamp: "2026-10-30T10:00:10Z" }),
        msg("assistant", [{ type: "tool_use", id: "q1", name: "Read", input: {} }], {
          timestamp: "2026-10-30T10:00:20Z",
        }),
        msg("assistant", [{ type: "text", text: "b" }], { timestamp: "2026-10-30T10:00:40Z" }),
      ],
      steering: [
        steer("queued", { createdAt: "2026-10-30T10:00:15Z", deliveredAt: "2026-10-30T10:00:30Z" }),
      ],
    });
    expect(kinds(rows)).toEqual(["a", "work", "queued", "b"]);
  });

  test("a pending message stays at the tail, after later work", () => {
    const rows = buildTranscriptRows({
      messages: [
        msg("assistant", [{ type: "text", text: "a" }], { timestamp: "2026-10-30T10:00:10Z" }),
        msg("assistant", [{ type: "tool_use", id: "q2", name: "Read", input: {} }], {
          timestamp: "2026-10-30T10:00:50Z",
        }),
      ],
      steering: [
        steer("waiting", { status: "pending", createdAt: "2026-10-30T10:00:05Z" }),
        steer("also-waiting", { status: "pending", createdAt: "2026-10-30T10:00:06Z" }),
        steer("seen", { createdAt: "2026-10-30T10:00:20Z", deliveredAt: "2026-10-30T10:00:20Z" }),
      ],
    });
    expect(kinds(rows)).toEqual(["a", "seen", "work", "waiting", "also-waiting"]);
  });

  test("zoneless SQLite timestamps read as UTC, as the session log's ISO ones", () => {
    // Off UTC, a local-time read of the zoneless stamp lands 9 h away.
    const tz = process.env.TZ;
    process.env.TZ = "Asia/Tokyo";
    const rows = buildTranscriptRows({
      messages: [
        msg("assistant", [{ type: "text", text: "a" }], { timestamp: "2026-10-30T10:00:10Z" }),
        msg("assistant", [{ type: "text", text: "b" }], { timestamp: "2026-10-30T10:00:30Z" }),
      ],
      steering: [steer("sqlite", { createdAt: "2026-10-30 10:00:20" })],
    });
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
    expect(kinds(rows)).toEqual(["a", "sqlite", "b"]);
  });
});

describe("foldedTurnRows", () => {
  test("closed, keeps only the agent's last message in view", () => {
    const rows = buildTranscriptRows({
      messages: [
        msg("assistant", [{ type: "text", text: "first" }]),
        msg("assistant", [{ type: "text", text: "last" }]),
        msg("assistant", [{ type: "tool_use", id: "t3", name: "Read", input: {} }]),
      ],
    });
    expect(
      foldedTurnRows(rows, false).map((r) => (r.kind === "assistant" ? r.text : r.kind)),
    ).toEqual(["last"]);
  });

  test("closed, the last message hides only when the outcome says the same", () => {
    const rows = buildTranscriptRows({
      messages: [
        msg("assistant", [{ type: "text", text: "first" }]),
        msg("assistant", [{ type: "text", text: "Opened  PR #12.\n" }]),
      ],
    });
    const texts = (outcomeText: string) =>
      foldedTurnRows(rows, false, { outcomeText }).map((r) =>
        r.kind === "assistant" ? r.text : r.kind,
      );
    expect(texts("Opened PR #12.")).toEqual([]);
    expect(texts("Completed by runner wrapper (no explicit output)")).toEqual(["Opened  PR #12."]);
    expect(foldedTurnRows(rows, true, { outcomeText: "Opened PR #12." })).toHaveLength(2);
  });

  test("open, keeps run order: a failed tool after the last message stays after it", () => {
    const rows = buildTranscriptRows({
      messages: [
        msg("assistant", [{ type: "text", text: "first" }]),
        msg("assistant", [{ type: "text", text: "last" }]),
        msg("assistant", [{ type: "tool_use", id: "t5", name: "Bash", input: {} }]),
        msg("user", [{ type: "tool_result", tool_use_id: "t5", content: "boom", isError: true }]),
      ],
    });
    const open = foldedTurnRows(rows, true);
    expect(open.map((r) => (r.kind === "assistant" ? r.text : r.kind))).toEqual([
      "first",
      "last",
      "work",
    ]);
    expect(open[2]?.kind === "work" && open[2].entries[0]).toMatchObject({ status: "error" });
  });

  test("closed, a message still waiting for the agent stays in view", () => {
    const rows = buildTranscriptRows({
      messages: [msg("assistant", [{ type: "text", text: "last" }])],
      steering: [
        {
          id: "w",
          body: "w",
          status: "pending",
          createdAt: "2026-10-30T09:00:00Z",
        } as SteeringMessage,
      ],
    });
    expect(foldedTurnRows(rows, false).map((r) => r.kind)).toEqual(["assistant", "steer"]);
  });

  test("closed, a run with no prose shows nothing under the fold line", () => {
    const rows = buildTranscriptRows({
      messages: [msg("assistant", [{ type: "tool_use", id: "t4", name: "Read", input: {} }])],
    });
    expect(foldedTurnRows(rows, false)).toEqual([]);
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

describe("a long session with delegations", () => {
  const start = Date.parse("2026-10-30T09:00:00Z");
  const at = (i: number) => new Date(start + i * 1000).toISOString();
  // 600 turns of prose plus a tool call: 1,200 rows, 600 tool calls.
  const messages: ParsedMessage[] = [];
  for (let i = 0; i < 600; i++) {
    messages.push({
      id: `a${i}`,
      role: "assistant",
      content: [{ type: "text", text: `Step ${i}.` }],
      iteration: 1,
      timestamp: at(2 * i),
    });
    messages.push({
      id: `t${i}`,
      role: "assistant",
      content: [{ type: "tool_use", id: `tu${i}`, name: "Bash", input: { command: `step ${i}` } }],
      iteration: 1,
      timestamp: at(2 * i + 1),
    });
  }
  const child = (id: string, second: number) =>
    ({ id, task: `Child ${id}`, status: "completed", createdAt: at(second) }) as AgentTask;
  const children = [child("c1", 100.5), child("c2", 600.5), child("c3", 1100.5)].map((task) => ({
    task,
    agentName: "Worker",
  }));
  const rows = buildTranscriptRows({ messages, children });

  test("a delegated task is a row at the time it was created", () => {
    expect(rows.length).toBe(1203);
    const delegations = rows.filter((row) => row.kind === "delegation");
    expect(delegations.map((row) => row.id)).toEqual(["child-c1", "child-c2", "child-c3"]);
    const c2 = rows.findIndex((row) => row.id === "child-c2");
    expect(rows[c2 - 1]).toMatchObject({ kind: "assistant", text: "Step 300." });
    expect(rows[c2 + 1]).toMatchObject({ kind: "work" });
  });

  test("shows the newest page, and each page reaches further back", () => {
    const first = pagedRows(rows, TRANSCRIPT_PAGE_ROWS);
    expect(first.shown).toHaveLength(TRANSCRIPT_PAGE_ROWS);
    expect(first.hidden).toBe(1003);
    expect(first.shown.at(-1)).toBe(rows.at(-1));
    const all = pagedRows(rows, TRANSCRIPT_PAGE_ROWS * 7);
    expect(all.hidden).toBe(0);
    expect(all.shown).toBe(rows);
  });

  test("the closed fold keeps the delegations and the last message", () => {
    const folded = foldedTurnRows(rows, false);
    expect(folded.map((row) => row.kind)).toEqual([
      "delegation",
      "delegation",
      "delegation",
      "assistant",
    ]);
  });
});
