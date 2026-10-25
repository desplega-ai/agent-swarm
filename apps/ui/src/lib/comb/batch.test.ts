import { describe, expect, test } from "bun:test";
import type { CommentEntry, CommentListEntry } from "../agent-fs/types";
import { canSendThread, eligibleForBatch, leadNote, sendFailure } from "./batch";

const TASK_ID = "0b8e1f5c-3d2a-4c6b-9e7f-1a2b3c4d5e6f";
let seq = 0;

function comment(overrides: Partial<CommentEntry> = {}): CommentEntry {
  seq++;
  return {
    id: `c${seq}`,
    path: "docs/a.md",
    body: "@swarm fix this",
    author: "human",
    resolved: false,
    replyCount: 0,
    createdAt: "2026-09-30T10:00:00.000Z",
    updatedAt: "2026-09-30T10:00:00.000Z",
    ...overrides,
  };
}

function thread(
  overrides: Partial<CommentEntry> = {},
  replies: CommentEntry[] = [],
): CommentListEntry {
  return { ...comment(overrides), replyCount: replies.length, replies };
}

const sentBy = (author: string) => comment({ body: `[comb:sent task=${TASK_ID}] Sent`, author });

describe("eligibleForBatch", () => {
  test("keeps open, unsent root threads that carry @swarm", () => {
    const marked = thread();
    const again = thread({ body: "please, @Swarm, add tests" });
    expect(eligibleForBatch([marked, again])).toEqual([marked, again]);
  });

  test("drops threads without @swarm, resolved threads, and replies", () => {
    expect(
      eligibleForBatch([
        thread({ body: "no marker" }),
        thread({ body: "mail me@swarm.local" }),
        thread({ resolved: true }),
        thread({ parentId: "c0" }),
      ]),
    ).toEqual([]);
  });

  test("drops threads the swarm already answered with the sent marker", () => {
    const sent = thread({}, [sentBy("svc")]);
    const ownMarker = thread({}, [sentBy("human")]);
    expect(eligibleForBatch([sent, ownMarker])).toEqual([ownMarker]);
    // With a known service account, only its marker counts.
    const byOther = thread({}, [sentBy("someone")]);
    expect(eligibleForBatch([sent, byOther], "svc")).toEqual([byOther]);
    expect(eligibleForBatch([sent, byOther], null)).toEqual([]);
  });
});

describe("canSendThread", () => {
  test("a one-thread send needs @swarm, like the batch", () => {
    expect(canSendThread(thread())).toBe(true);
    expect(canSendThread(thread({ body: "no marker" }))).toBe(false);
    expect(canSendThread(thread({ resolved: true }))).toBe(false);
    expect(canSendThread(thread({}, [sentBy("svc")]), "svc")).toBe(false);
  });
});

describe("send results", () => {
  test("leadNote says when no lead or an offline lead got the task", () => {
    expect(leadNote("online")).toBeNull();
    expect(leadNote(undefined)).toBeNull();
    expect(leadNote("none")).toContain("waits in the pool");
    expect(leadNote("offline")).toContain("The lead is offline");
  });

  test("sendFailure names each failure and keeps the server's detail", () => {
    expect(sendFailure(0, "Cannot reach the swarm API").title).toBe("Cannot reach the swarm API");
    expect(sendFailure(403, "Not authorized to create tasks")).toEqual({
      title: "You cannot send comments to the swarm",
      description: "Sending creates a task. Ask a swarm admin for permission to create tasks.",
    });
    expect(sendFailure(409, "Nothing to send")).toEqual({ title: "Nothing new to send" });
    expect(sendFailure(400, "Comb sends comments from the swarm drive only").description).toBe(
      "Comb sends comments from the swarm drive only",
    );
    const unreadable = sendFailure(502, "agent-fs could not read comment c1: timeout");
    expect(unreadable.title).toBe("agent-fs could not read a comment");
    expect(unreadable.description).toContain("Nothing was sent.");
    expect(unreadable.description).toContain("timeout");
    expect(sendFailure(503, "agent-fs is not set up for this swarm").title).toBe(
      "agent-fs is not set up for this swarm",
    );
    expect(sendFailure(422, "blocked by policy").description).toBe("blocked by policy");
    expect(sendFailure(500, "")).toEqual({
      title: "Could not send to the swarm",
      description: "The swarm answered 500.",
    });
  });
});
