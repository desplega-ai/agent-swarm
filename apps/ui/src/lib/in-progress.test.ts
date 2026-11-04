import { expect, test } from "bun:test";
import type { AgentTask, SessionListItem, SessionTreeResponse } from "../api/types";
import { groupViewHref, inProgressGroups } from "./in-progress";

const counts = (running: number) => ({ total: running + 1, unread: 0, running, needsYou: 0 });

const tree: SessionTreeResponse = {
  groups: [
    { key: "shared/idle/", ...counts(0), lastActivityAt: "2026-11-04T09:00:00Z" },
    { key: "shared/po-qa/", ...counts(1), lastActivityAt: "2026-11-04T10:00:00Z" },
    { key: "shared/release-notes/", ...counts(2), lastActivityAt: "2026-11-04T08:00:00Z" },
  ],
  inbox: counts(0),
  later: counts(0),
  done: counts(0),
  noGroup: counts(1),
};

function running(id: string, groupKey?: string): SessionListItem {
  return {
    root: { id, task: id } as AgentTask,
    chainTaskCount: 1,
    lastActivityAt: "2026-11-04T10:00:00Z",
    latestStatus: "in_progress",
    groupKey,
  };
}

test("groups with a running session, most running first, No group last", () => {
  const groups = inProgressGroups(
    tree,
    [running("a", "shared/po-qa/"), running("b", "shared/"), running("c", "shared/release-notes/")],
    "u1",
  );
  expect(groups.map((g) => [g.key, g.running, g.sessions.map((s) => s.root.id)])).toEqual([
    ["shared/release-notes/", 2, ["c"]],
    ["shared/po-qa/", 1, ["a"]],
    [null, 1, ["b"]],
  ]);
});

test("a group counted in the tree keeps its row with no session on the page", () => {
  const groups = inProgressGroups(tree, [], "u1");
  expect(groups.find((g) => g.key === "shared/po-qa/")?.sessions).toEqual([]);
});

test("no tree, no groups", () => {
  expect(inProgressGroups(undefined, [running("a", "shared/po-qa/")], "u1")).toEqual([]);
});

test("group links open the group view or the No group section", () => {
  expect(groupViewHref("shared/po-qa/")).toBe("/sessions?view=shared%2Fpo-qa%2F");
  expect(groupViewHref(null)).toBe("/sessions?view=nogroup");
});
