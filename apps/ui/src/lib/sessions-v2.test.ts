import { describe, expect, test } from "bun:test";
import type {
  AgentTask,
  SessionDetailResponse,
  SessionSectionCounts,
  SessionTreeResponse,
} from "../api/types";
import {
  ASSET_TAB_PREFIX,
  canSplitTab,
  closePaneTab,
  closeSplitPane,
  detailGroupKey,
  focusedTab,
  GROUP_TAB,
  isAssetTab,
  isSessionTab,
  latestTask,
  moveTab,
  NEW_SESSION_TAB,
  openInPane,
  openTab,
  type Panes,
  paneOf,
  parseTabs,
  parseView,
  replacePaneTab,
  SPLIT_DEFAULT_RATIO,
  SPLIT_KEEPS_GROUP_TAB,
  SPLIT_NEEDS_SECOND_TAB,
  SPLIT_PANE_MIN_WIDTH,
  serializeSplitFocus,
  serializeTabs,
  sessionCostUsd,
  splitLayout,
  tabPath,
  tabsWithFocus,
  treeCount,
  urlPanes,
  withGroupTab,
} from "./sessions-v2";

/** Panes from a short form: `panes("a*,b", "c,d*")`. The star marks the focused tab. */
function panes(main: string, split = ""): Panes {
  const read = (list: string) => {
    const tabs = list ? list.split(",") : [];
    const focused = tabs.find((tab) => tab.endsWith("*"))?.slice(0, -1) ?? null;
    return { tabs: tabs.map((tab) => tab.replace("*", "")), focused };
  };
  const m = read(main);
  const s = read(split);
  return {
    tabs: m.tabs,
    focused: m.focused ?? m.tabs[0],
    split: s.tabs,
    splitFocused: s.focused ?? s.tabs[0] ?? null,
  };
}

describe("sessions v2 URL state", () => {
  test("parseTabs trims, drops blanks and repeats, and keeps the order", () => {
    expect(parseTabs(null)).toEqual([]);
    expect(parseTabs(" a, ,b,a,new ")).toEqual(["a", "b", "new"]);
  });

  test("the focused tab joins the list when the URL lacks it", () => {
    expect(tabsWithFocus([], "a")).toEqual(["a"]);
    expect(tabsWithFocus(["a", "new"], "a")).toEqual(["a", "new"]);
    expect(tabsWithFocus(["a"], "b")).toEqual(["a", "b"]);
  });

  test("serializeTabs drops the param when the path already names the only tab", () => {
    expect(serializeTabs(["a"], "a")).toBe("");
    expect(serializeTabs(["a", NEW_SESSION_TAB], "a")).toBe("a,new");
    expect(serializeTabs(["b"], "a")).toBe("b");
  });

  test("parseView accepts sections and group keys only", () => {
    expect(parseView("inbox")).toBe("inbox");
    expect(parseView("nogroup")).toBe("nogroup");
    expect(parseView("shared/northwind/pricing/")).toBe("shared/northwind/pricing/");
    expect(parseView("shared/northwind")).toBeNull();
    expect(parseView("")).toBeNull();
  });

  test("openTab keeps every open tab, as browser tabs: a new one opens after the focused tab", () => {
    expect(openTab(["a", "b"], "a", "c")).toEqual(["a", "c", "b"]);
    expect(openTab(["a", "b"], "a", "b")).toEqual(["a", "b"]);
    expect(openTab(["a"], "x", "c")).toEqual(["a", "c"]);
  });

  test("clicking one session, then another, leaves both open in their own tabs", () => {
    // Each click focuses the session it opened, so the next one opens after it.
    let tabs = ["a"];
    let focused = "a";
    for (const id of ["b", "c", "b"]) {
      tabs = openTab(tabs, focused, id);
      focused = id;
    }
    expect(tabs).toEqual(["a", "b", "c"]);
    expect(focused).toBe("b");
    expect(serializeTabs(tabs, focused)).toBe("a,b,c");
  });

  test("tabPath maps the New session tab to /sessions", () => {
    expect(tabPath(NEW_SESSION_TAB)).toBe("/sessions");
    expect(tabPath("abc")).toBe("/sessions/abc");
  });

  test("the group tab owns /sessions while ?view= is set", () => {
    expect(tabPath(GROUP_TAB)).toBe("/sessions");
    expect(tabPath(NEW_SESSION_TAB, true)).toBe("/sessions/new");
    expect(focusedTab(undefined, "inbox")).toBe(GROUP_TAB);
    expect(focusedTab(undefined, null)).toBe(NEW_SESSION_TAB);
    expect(focusedTab(NEW_SESSION_TAB, "inbox")).toBe(NEW_SESSION_TAB);
    expect(focusedTab("abc", "inbox")).toBe("abc");
  });

  test("a session opened from the group tab or the New session tab opens next to it", () => {
    expect(openTab(["a", GROUP_TAB], GROUP_TAB, "c")).toEqual(["a", GROUP_TAB, "c"]);
    expect(openTab([NEW_SESSION_TAB, "a"], NEW_SESSION_TAB, "c")).toEqual([
      NEW_SESSION_TAB,
      "c",
      "a",
    ]);
  });

  test("View all adds the group tab after the focused tab, and a second one reuses it", () => {
    expect(withGroupTab(["a", "b"], "a")).toEqual(["a", GROUP_TAB, "b"]);
    expect(withGroupTab(["a", GROUP_TAB, "b"], "b")).toEqual(["a", GROUP_TAB, "b"]);
  });
});

describe("sessions v2 panes", () => {
  const asset = `${ASSET_TAB_PREFIX}link:abc`;

  test("an asset tab is no session, and it can go to the split", () => {
    expect(isAssetTab(asset)).toBe(true);
    expect(isSessionTab(asset)).toBe(false);
    expect(isSessionTab("a")).toBe(true);
    expect(canSplitTab(asset)).toBe(true);
    expect(canSplitTab(NEW_SESSION_TAB)).toBe(true);
    expect(canSplitTab(GROUP_TAB)).toBe(false);
  });

  test("the URL keeps a split tab out of the main tabs, and the focused tab in the main pane", () => {
    const at = (tabs: string | null, focused: string, split: string | null, view = null) =>
      urlPanes(tabs, { focused, view, split });
    expect(at("a,b", "a", "b")).toEqual(panes("a*", "b*"));
    expect(at("a,b", "a", "a")).toEqual(panes("a*,b"));
    expect(at("a,b,c", "a", "b,c")).toEqual(panes("a*", "b*,c"));
    expect(at("a,b", "a", "a,b")).toEqual(panes("a*", "b*"));
    expect(at(`a,${GROUP_TAB}`, "a", null)).toEqual(panes("a*"));
    expect(urlPanes("a", { focused: "a", view: "inbox", split: GROUP_TAB })).toEqual(panes("a*"));
    expect(urlPanes(`a,${GROUP_TAB}`, { focused: "a", view: "inbox", split: null })).toEqual(
      panes(`a*,${GROUP_TAB}`),
    );
  });

  test("?splitFocus= names the split's focused tab, and drops out for its first tab", () => {
    const at = (splitFocus: string | null) =>
      urlPanes("a", { focused: "a", view: null, split: "b,c", splitFocus });
    expect(at("c")).toEqual(panes("a*", "b,c*"));
    expect(at(null)).toEqual(panes("a*", "b*,c"));
    expect(at("zz")).toEqual(panes("a*", "b*,c"));
    expect(serializeSplitFocus(panes("a*", "b,c*"))).toBe("c");
    expect(serializeSplitFocus(panes("a*", "b*,c"))).toBe("");
    expect(serializeSplitFocus(panes("a*"))).toBe("");
  });

  test("the split can hold the New session tab, and only one New session shows", () => {
    const at = (tabs: string | null, focused: string, split: string | null) =>
      urlPanes(tabs, { focused, view: null, split });
    expect(at("a", "a", NEW_SESSION_TAB)).toEqual(panes("a*", `${NEW_SESSION_TAB}*`));
    expect(at(`a,${NEW_SESSION_TAB}`, "a", NEW_SESSION_TAB)).toEqual(
      panes("a*", `${NEW_SESSION_TAB}*`),
    );
    expect(at(null, NEW_SESSION_TAB, NEW_SESSION_TAB)).toEqual(panes(`${NEW_SESSION_TAB}*`));
  });

  test("an open adds a tab after the pane's focused tab, and never replaces one", () => {
    expect(openInPane(panes("a*,b"), 0, "c")).toEqual(panes("a,c*,b"));
    expect(openInPane(panes("a*", "b*,c"), 1, "d")).toEqual(panes("a*", "b,d*,c"));
    // Pane 1 with no split starts the split.
    expect(openInPane(panes("a*"), 1, asset)).toEqual(panes("a*", `${asset}*`));
    // The group tab opens in the main pane only.
    expect(openInPane(panes("a*", "b*"), 1, GROUP_TAB)).toEqual(panes(`a,${GROUP_TAB}*`, "b*"));
  });

  test("an open tab takes the focus in the pane that holds it", () => {
    expect(openInPane(panes("a*,b", "c*,d"), 0, "d")).toEqual(panes("a*,b", "c,d*"));
    expect(openInPane(panes("a*,b", "c*"), 1, "b")).toEqual(panes("a,b*", "c*"));
    expect(paneOf(panes("a*", "b*"), "b")).toBe(1);
    expect(paneOf(panes("a*", "b*"), "a")).toBe(0);
    expect(paneOf(panes("a*", "b*"), "zz")).toBeNull();
  });

  test("a tab moved to the split joins its tabs: it replaces none", () => {
    expect(moveTab(panes("a*,b"), "b", 1)).toEqual(panes("a*", "b*"));
    expect(moveTab(panes("a*,b,c", "d*"), "b", 1)).toEqual(panes("a*,c", "d,b*"));
    // The focused tab leaves: its right neighbor takes the focus.
    expect(moveTab(panes("a*,b", "c*"), "a", 1)).toEqual(panes("b*", "c,a*"));
    // A tab that is not open opens there.
    expect(moveTab(panes("a*"), "z", 1)).toEqual(panes("a*", "z*"));
  });

  test("a move names its place: before a tab, last, or after the focused tab", () => {
    expect(moveTab(panes("a*", "b*,c"), "a2", 1, "c")).toEqual(panes("a*", "b,a2*,c"));
    expect(moveTab(panes("a*,x", "b*,c"), "x", 1, null)).toEqual(panes("a*", "b,c,x*"));
    expect(moveTab(panes("a*,x", "b*,c"), "x", 1)).toEqual(panes("a*", "b,x*,c"));
    expect(moveTab(panes("a*,b", "c*,d"), "d", 0, "a")).toEqual(panes("d*,a,b", "c*"));
  });

  test("a move in the same pane changes the order and keeps the focus", () => {
    expect(moveTab(panes("a*,b,c"), "c", 0, "a")).toEqual(panes("c,a*,b"));
    expect(moveTab(panes("a*,b,c"), "a", 0, null)).toEqual(panes("b,c,a*"));
    expect(moveTab(panes("a*", "b*,c,d"), "d", 1, "b")).toEqual(panes("a*", "d,b*,c"));
    // No change: the same object comes back, so the URL stays.
    const same = panes("a*,b,c");
    expect(moveTab(same, "b", 0, "c")).toBe(same);
    expect(moveTab(same, "b", 0, "b")).toBe(same);
  });

  test("a move to the pane that holds the tab, with no place named, focuses it in place", () => {
    // "Open in split" on an unfocused split tab: it shows, and keeps its place.
    expect(moveTab(panes("a*", "b*,c,d"), "c", 1)).toEqual(panes("a*", "b,c*,d"));
    expect(moveTab(panes("a*,b,c", "d*"), "b", 0)).toEqual(panes("a,b*,c", "d*"));
    const same = panes("a*", "b*,c");
    expect(moveTab(same, "b", 1)).toBe(same);
  });

  test("the main pane's only tab cannot start a split, and the group tab stays in the main pane", () => {
    expect(moveTab(panes("a*"), "a", 1)).toEqual({ message: SPLIT_NEEDS_SECOND_TAB });
    expect(moveTab(panes(`a*,${GROUP_TAB}`), GROUP_TAB, 1)).toEqual({
      message: SPLIT_KEEPS_GROUP_TAB,
    });
  });

  test("the panes join when the main pane's last tab goes to the split", () => {
    expect(moveTab(panes("a*", "b*,c"), "a", 1)).toEqual(panes("b,a*,c"));
  });

  test("the split closes when its last tab moves to the main pane", () => {
    expect(moveTab(panes("a*,b", "c*"), "c", 0)).toEqual(panes("a,c*,b"));
  });

  test("closing a tab focuses its right neighbor, then its left one", () => {
    expect(closePaneTab(panes("a,b*,c"), "b")).toEqual(panes("a,c*"));
    expect(closePaneTab(panes("a,b*"), "b")).toEqual(panes("a*"));
    expect(closePaneTab(panes("a*,b"), "b")).toEqual(panes("a*"));
    expect(closePaneTab(panes("a*", "b,c*,d"), "c")).toEqual(panes("a*", "b,d*"));
    expect(closePaneTab(panes("a*"), "zz")).toEqual(panes("a*"));
  });

  test("the split closes with its last tab, and the main pane takes the split's tabs with its own last tab", () => {
    expect(closePaneTab(panes("a*", "b*"), "b")).toEqual(panes("a*"));
    expect(closePaneTab(panes("a*", "b,c*"), "a")).toEqual(panes("b,c*"));
    expect(closePaneTab(panes("a*"), "a")).toEqual(panes(`${NEW_SESSION_TAB}*`));
  });

  test("closing the group tab leaves New session on /sessions", () => {
    const closed = closePaneTab(panes(`${GROUP_TAB},${NEW_SESSION_TAB}*`), GROUP_TAB);
    expect(closed).toEqual(panes(`${NEW_SESSION_TAB}*`));
    expect(tabPath(closed.focused, false)).toBe("/sessions");
  });

  test("Send turns the New session tab into its session, in its pane", () => {
    expect(replacePaneTab(panes(`a,${NEW_SESSION_TAB}*,b`), NEW_SESSION_TAB, "c")).toEqual(
      panes("a,c*,b"),
    );
    expect(replacePaneTab(panes("a*", `b,${NEW_SESSION_TAB}*`), NEW_SESSION_TAB, "c")).toEqual(
      panes("a*", "b,c*"),
    );
    expect(replacePaneTab(panes("a*"), NEW_SESSION_TAB, "c")).toEqual(panes("a,c*"));
  });

  test("the split button joins the panes: the split's tabs go to the end of the main pane", () => {
    expect(closeSplitPane(panes("a*,b", "c,d*"), true)).toEqual(panes("a*,b,c,d"));
    expect(closeSplitPane(panes("a*,b", "c,d*"), false)).toEqual(panes("a*,b"));
  });

  test("the URL of moved panes reads back as the same panes", () => {
    const moved = moveTab(panes("a*,b,c", "d*"), "b", 1) as Panes;
    expect(
      urlPanes(serializeTabs(moved.tabs, moved.focused), {
        focused: moved.focused,
        view: null,
        split: moved.split.join(","),
        splitFocus: serializeSplitFocus(moved) || null,
      }),
    ).toEqual(moved);
  });
});

describe("sessionCostUsd", () => {
  const task = (totalCostUsd?: number) => ({ totalCostUsd }) as AgentTask;

  test("totals every task in the chain, not only the root", () => {
    // The lead's root, two delegated worker tasks and a follow-up.
    const chain = [task(0.2051), task(0.5), task(0.25), task(0.335)];
    expect(sessionCostUsd(chain)).toBeCloseTo(1.2901, 6);
  });

  test("skips tasks without a cost and is null when none has one", () => {
    expect(sessionCostUsd([task(), task(0.1), task()])).toBeCloseTo(0.1, 6);
    expect(sessionCostUsd([task(), task()])).toBeNull();
    expect(sessionCostUsd([task(0)])).toBe(0);
  });
});

describe("latestTask", () => {
  const task = (id: string, parentTaskId: string | null, lastUpdatedAt: string, status: string) =>
    ({ id, parentTaskId, lastUpdatedAt, status }) as unknown as AgentTask;

  test("takes the latest update", () => {
    const root = task("r", null, "2026-10-21T10:00:00.000Z", "completed");
    const chain = [root, task("c", "r", "2026-10-21T11:00:00.000Z", "failed")];
    expect(latestTask({ root, chain }).id).toBe("c");
  });

  test("on a tie, the parent wins over its child, as the server walks breadth first", () => {
    const root = task("r", null, "2026-10-21T11:39:15.176Z", "failed");
    const chain = [root, task("c", "r", "2026-10-21T11:39:15.176Z", "unassigned")];
    expect(latestTask({ root, chain }).status).toBe("failed");
    const deep = [
      task("r2", null, "2026-10-19T23:28:46.079Z", "pending"),
      task("a", "r2", "2026-10-20T03:02:16.113Z", "pending"),
      task("b", "a", "2026-10-21T11:39:15.142Z", "failed"),
      task("d", "b", "2026-10-21T11:39:15.142Z", "unassigned"),
    ];
    expect(latestTask({ root: deep[0], chain: deep }).status).toBe("failed");
  });

  test("on a tie between levels, the shallower task wins, also when the chain lists it later", () => {
    const root = task("r", null, "2026-10-21T09:00:00.000Z", "completed");
    const chain = [
      root,
      task("a", "r", "2026-10-21T09:10:00.000Z", "completed"),
      task("a1", "a", "2026-10-21T10:00:00.000Z", "failed"),
      task("b", "r", "2026-10-21T10:00:00.000Z", "in_progress"),
    ];
    expect(latestTask({ root, chain }).id).toBe("b");
  });
});

describe("detailGroupKey", () => {
  const detail = (key: string | undefined, groupKey?: string) =>
    ({ root: { key }, groupKey }) as unknown as SessionDetailResponse;

  test("the server's group wins, so a shared thread opens its own group", () => {
    const thread = "shared/slack/c1/thread:1.2/";
    expect(detailGroupKey(detail(thread, thread))).toBe(thread);
  });

  test("an older server's detail falls back to the key rule", () => {
    expect(detailGroupKey(detail("shared/slack/c1/thread:1.2/"))).toBe("shared/slack/c1/");
    expect(detailGroupKey(detail(undefined))).toBeUndefined();
  });
});

describe("treeCount", () => {
  const counts = (n: number): SessionSectionCounts => ({
    total: n,
    unread: n,
    running: n,
    needsYou: n,
  });

  test("counts grouped sessions, which the Inbox leaves out", () => {
    const tree = {
      groups: [
        { key: "shared/launch/", ...counts(2), lastActivityAt: "2026-01-01T00:00:00.000Z" },
        { key: "shared/billing/", ...counts(1), lastActivityAt: "2026-01-01T00:00:00.000Z" },
      ],
      inbox: counts(3),
      noGroup: counts(3),
      later: counts(1),
      done: counts(4),
    } as SessionTreeResponse;
    expect(treeCount(tree, "running")).toBe(11);
    expect(treeCount(tree, "needsYou")).toBe(11);
    expect(treeCount(tree, "unread")).toBe(11);
  });

  test("is zero before the tree loads", () => {
    expect(treeCount(undefined, "running")).toBe(0);
  });
});

describe("splitLayout", () => {
  test("half the row with no stored size, or a bad one", () => {
    expect(splitLayout(null, 1000)).toEqual({ width: 500, min: 320, max: 680, ratio: 0.5 });
    expect(splitLayout(Number.NaN, 1000).width).toBe(500);
    expect(splitLayout(0, 1000).width).toBe(500);
    expect(splitLayout(1, 1000).width).toBe(500);
    expect(SPLIT_DEFAULT_RATIO).toBe(0.5);
  });

  test("a stored share follows the row width, and each pane keeps its minimum", () => {
    expect(splitLayout(0.3, 2000)).toEqual({ width: 600, min: 320, max: 1680, ratio: 0.3 });
    expect(splitLayout(0.3, 1200).width).toBe(360);
    // Too narrow for 30%: the main pane keeps the minimum, and the share says so.
    const narrow = splitLayout(0.1, 1000);
    expect(narrow.width).toBe(SPLIT_PANE_MIN_WIDTH);
    expect(narrow.ratio).toBeCloseTo(0.32);
    expect(splitLayout(0.95, 1000).width).toBe(1000 - SPLIT_PANE_MIN_WIDTH);
  });

  test("a row too narrow for two minimum panes splits in half, with max >= min", () => {
    expect(splitLayout(0.2, 500)).toEqual({ width: 250, min: 250, max: 250, ratio: 0.5 });
  });

  test("an unmeasured row keeps the stored share", () => {
    expect(splitLayout(0.4, 0)).toEqual({ width: 0, min: 0, max: 0, ratio: 0.4 });
  });
});
