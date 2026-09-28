import { describe, expect, test } from "bun:test";
import {
  buildContextFooter,
  contextKeyPrefix,
  followUpTarget,
  latestLeaf,
  newSessionContextKey,
  type SessionPanelDetail,
  type SessionPanelTask,
  sessionLabel,
  sessionPollMs,
  stripContextFooter,
  timelineEntries,
  withContextFooter,
} from "./model";

function task(over: Partial<SessionPanelTask> & { id: string }): SessionPanelTask {
  return {
    task: `task ${over.id}`,
    status: "completed",
    createdAt: "2026-09-28 10:00:00",
    ...over,
  };
}

function detail(root: SessionPanelTask, ...rest: SessionPanelTask[]): SessionPanelDetail {
  return { root, chain: [root, ...rest] };
}

describe("context keys", () => {
  test("new session keys add exactly one part under the page key", () => {
    const key = newSessionContextKey("task:ui:workflow:w1");
    expect(key.startsWith(contextKeyPrefix("task:ui:workflow:w1"))).toBe(true);
    expect(key.split(":")).toHaveLength(5);
    expect(newSessionContextKey("task:ui:workflow:w1")).not.toBe(key);
  });

  test("the prefix keeps a trailing `:` so w1 never matches w12", () => {
    expect(contextKeyPrefix("task:ui:workflow:w1")).toBe("task:ui:workflow:w1:");
    expect(newSessionContextKey("task:ui:workflow:w12").startsWith("task:ui:workflow:w1:")).toBe(
      false,
    );
  });
});

describe("context footer", () => {
  const footer = buildContextFooter(
    [
      ["URL", "https://x/y"],
      ["Entity", undefined],
      ["Title", ""],
    ],
    "swarm UI",
  );

  test("drops empty fields", () => {
    expect(footer).toBe("---\nPage context (swarm UI)\n- URL: https://x/y");
  });

  test("round-trips through with/strip", () => {
    const text = withContextFooter("fix the chart\nsecond line", footer);
    expect(text).toBe(`fix the chart\nsecond line\n\n${footer}`);
    expect(stripContextFooter(text)).toBe("fix the chart\nsecond line");
  });

  test("leaves text without a footer alone, including a user's own `---`", () => {
    expect(stripContextFooter("a\n---\nb")).toBe("a\n---\nb");
    expect(withContextFooter("a", undefined)).toBe("a");
  });

  test("strips a footer with no surface label", () => {
    expect(stripContextFooter(`hi\n\n${buildContextFooter([["URL", "u"]])}`)).toBe("hi");
  });
});

describe("sessionLabel", () => {
  test("prefers the custom title", () => {
    expect(sessionLabel(task({ id: "r", title: " Renamed ", task: "typed" }))).toBe("Renamed");
  });

  test("uses the first typed line without the footer", () => {
    const text = withContextFooter("\nfirst\nsecond", buildContextFooter([["URL", "u"]]));
    expect(sessionLabel(task({ id: "r", task: text }))).toBe("first");
  });

  test("uses the list's slim taskPreview when present, and truncates", () => {
    expect(sessionLabel(task({ id: "r", task: "", taskPreview: "x".repeat(100) }), 10)).toBe(
      `${"x".repeat(9)}…`,
    );
  });
});

describe("follow-up routing", () => {
  const root = task({ id: "r", isLeadTask: true, createdAt: "2026-09-28 10:00:00" });

  test("steers a running lead leaf", () => {
    const leaf = task({
      id: "l",
      isLeadTask: true,
      status: "in_progress",
      createdAt: "2026-09-28 10:05:00",
    });
    const d = detail(root, leaf);
    expect(latestLeaf(d).id).toBe("l");
    expect(followUpTarget(d, true)).toEqual({ kind: "steer", taskId: "l" });
  });

  test("creates a child when steering is unsupported, the leaf is done, or it is a worker", () => {
    const running = task({
      id: "l",
      isLeadTask: true,
      status: "pending",
      createdAt: "2026-09-28 10:05:00",
    });
    expect(followUpTarget(detail(root, running), false)).toEqual({
      kind: "child",
      parentTaskId: "l",
    });
    expect(followUpTarget(detail(root), true)).toEqual({ kind: "child", parentTaskId: "r" });
    const worker = task({ id: "w", status: "in_progress", createdAt: "2026-09-28 10:06:00" });
    expect(followUpTarget(detail(root, worker), true)).toEqual({
      kind: "child",
      parentTaskId: "w",
    });
  });

  test("polls faster while anything is active", () => {
    expect(sessionPollMs(detail(root))).toBe(10_000);
    expect(sessionPollMs(detail(root, task({ id: "a", status: "in_progress" })))).toBe(4000);
    expect(sessionPollMs(null)).toBe(4000);
  });
});

describe("timelineEntries", () => {
  test("typed tasks become user + agent rows, delegated tasks one row, system nudges hidden", () => {
    const root = task({
      id: "r",
      task: withContextFooter("fix it", buildContextFooter([["URL", "u"]])),
      source: "ui",
      createdAt: "2026-09-28 10:00:00",
    });
    const worker = task({ id: "w", source: "mcp", createdAt: "2026-09-28 10:01:00" });
    const nudge = task({
      id: "n",
      source: "system",
      taskType: "follow-up",
      createdAt: "2026-09-28 10:02:00",
    });
    const followUp = task({
      id: "f",
      source: "ui",
      task: "and this",
      createdAt: "2026-09-28 10:03:00",
    });
    const entries = timelineEntries(detail(root, followUp, nudge, worker));
    expect(
      entries.map((e) =>
        e.kind === "user" ? `user:${e.text}` : `agent:${e.task.id}:${e.delegated}`,
      ),
    ).toEqual(["user:fix it", "agent:r:false", "agent:w:true", "user:and this", "agent:f:false"]);
  });
});
