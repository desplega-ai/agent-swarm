import { describe, expect, test } from "bun:test";
import type { AgentTask, SessionListItem } from "../api/types";
import { showsUnread } from "./session-status";

function session(extra: Partial<SessionListItem>): SessionListItem {
  return {
    root: { id: "s1", task: "session" } as AgentTask,
    chainTaskCount: 1,
    lastActivityAt: "2026-11-18T10:00:00Z",
    latestStatus: "completed",
    readState: "unread",
    needsYou: false,
    ...extra,
  };
}

describe("showsUnread", () => {
  test("a running session hides the dot: the spinner already shows it", () => {
    expect(showsUnread(session({ latestStatus: "in_progress" }))).toBe(false);
    expect(showsUnread(session({ latestStatus: "pending" }))).toBe(false);
  });

  test("a finished, failed or Needs you session keeps it", () => {
    expect(showsUnread(session({ latestStatus: "completed" }))).toBe(true);
    expect(showsUnread(session({ latestStatus: "failed" }))).toBe(true);
    expect(showsUnread(session({ latestStatus: "in_progress", needsYou: true }))).toBe(true);
  });

  test("a read session never shows it", () => {
    expect(showsUnread(session({ readState: "read" }))).toBe(false);
  });
});
