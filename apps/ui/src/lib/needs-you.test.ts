import { describe, expect, test } from "bun:test";
import type {
  AgentTask,
  ApprovalRequestSummary,
  CredentialMissingAgent,
  SessionListItem,
} from "../api/types";
import { failuresNotListed, needsYouCount, needsYouItems } from "./needs-you";

function session(id: string, extra: Partial<SessionListItem> = {}): SessionListItem {
  return {
    root: { id, task: `session ${id}` } as AgentTask,
    chainTaskCount: 1,
    lastActivityAt: "2026-11-04T10:00:00Z",
    latestStatus: "in_progress",
    readState: "read",
    needsYou: true,
    ...extra,
  };
}

function approval(id: string, sourceTaskId: string | null = null): ApprovalRequestSummary {
  return { id, title: `approval ${id}`, sourceTaskId } as ApprovalRequestSummary;
}

const blocked = {
  agentId: "a1",
  name: "Coder",
  missing: ["GITHUB_TOKEN"],
} as CredentialMissingAgent;

describe("needsYouItems", () => {
  test("a session whose root raised a listed approval shows once, under approvals", () => {
    const items = needsYouItems({
      approvals: [approval("ap1", "root-1")],
      sessions: [session("root-1", { readState: "unread", latestStatus: "failed" })],
      credentials: [],
    });
    expect(items.approvals.map((a) => a.id)).toEqual(["ap1"]);
    expect(items.sessions).toEqual([]);
    expect(needsYouCount(items)).toBe(1);
  });

  test("a session that needs you only for an approval in its chain drops out", () => {
    // The approval came from a child task, so its source is not the root.
    const items = needsYouItems({
      approvals: [approval("ap1", "child-1")],
      sessions: [session("root-1")],
      credentials: [],
    });
    expect(items.sessions).toEqual([]);
    expect(needsYouCount(items)).toBe(1);
  });

  test("an unread failure stays next to an unrelated approval", () => {
    const items = needsYouItems({
      approvals: [approval("ap1", "other")],
      sessions: [session("root-1", { readState: "unread", latestStatus: "failed" })],
      credentials: [blocked],
    });
    expect(items.sessions.map((s) => s.root.id)).toEqual(["root-1"]);
    expect(needsYouCount(items)).toBe(3);
  });

  test("while approvals are unknown every session that needs you stays", () => {
    const items = needsYouItems({
      approvals: undefined,
      sessions: [session("root-1"), session("root-2", { needsYou: false })],
      credentials: undefined,
    });
    expect(items.sessions.map((s) => s.root.id)).toEqual(["root-1"]);
    expect(needsYouCount(items)).toBe(1);
  });

  test("a standalone approval counts with no session at all", () => {
    const items = needsYouItems({
      approvals: [approval("ap1")],
      sessions: [],
      credentials: [],
    });
    expect(needsYouCount(items)).toBe(1);
  });
});

test("failuresNotListed drops failures already listed as sessions", () => {
  const tasks = [{ id: "root-1" }, { id: "t-2" }] as AgentTask[];
  expect(failuresNotListed(tasks, [session("root-1")]).map((t) => t.id)).toEqual(["t-2"]);
});
