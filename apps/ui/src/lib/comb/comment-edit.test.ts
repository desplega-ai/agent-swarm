import { describe, expect, test } from "bun:test";
import type { CommentEntry, CommentListEntry } from "../agent-fs/types";
import { commentEditBlock } from "./comment-edit";

const TASK = "0b8e1f5c-3d2a-4c6b-9e7f-1a2b3c4d5e6f";
const SERVICE = "u-swarm";
const ME = "u-ann";
let seq = 0;

function comment(overrides: Partial<CommentEntry> = {}): CommentEntry {
  seq++;
  return {
    id: `c${seq}`,
    path: "docs/a.md",
    body: "@swarm fix this",
    author: ME,
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

const sentReply = () =>
  comment({ body: `[comb:sent task=${TASK}] Sent to the swarm`, author: SERVICE });

describe("commentEditBlock", () => {
  test("the author can edit and delete an unsent root and their own replies", () => {
    const mine = comment({ body: "a follow-up" });
    const t = thread({}, [mine]);
    expect(commentEditBlock(t, t, ME, SERVICE)).toBeNull();
    expect(commentEditBlock(mine, t, ME, SERVICE)).toBeNull();
  });

  test("nobody else can (agent-fs allows only the author)", () => {
    const bobs = comment({ author: "u-bob", body: "+1" });
    const t = thread({ author: "u-bob" }, [bobs]);
    expect(commentEditBlock(t, t, ME, SERVICE)).toBe("not-author");
    expect(commentEditBlock(bobs, t, ME, SERVICE)).toBe("not-author");
  });

  test("without a connected user, nothing is editable", () => {
    const t = thread();
    expect(commentEditBlock(t, t, null, SERVICE)).toBe("not-author");
  });

  test("a root that went to the swarm is final, even while it is processing", () => {
    const t = thread({}, [sentReply()]);
    expect(commentEditBlock(t, t, ME, SERVICE)).toBe("sent");
  });

  test("the person's own replies in a sent thread stay editable", () => {
    const later = comment({ body: "Also check the table." });
    const t = thread({}, [sentReply(), later]);
    expect(commentEditBlock(later, t, ME, SERVICE)).toBeNull();
  });

  test("the swarm's replies are never editable, even by the service account itself", () => {
    const marker = sentReply();
    const t = thread({}, [marker]);
    expect(commentEditBlock(marker, t, ME, SERVICE)).toBe("swarm");
    expect(commentEditBlock(marker, t, SERVICE, SERVICE)).toBe("swarm");
  });

  test("without a known service account, a sent marker by another author still counts", () => {
    const marker = comment({ body: `[comb:sent task=${TASK}]`, author: "u-operator" });
    const t = thread({}, [marker]);
    expect(commentEditBlock(marker, t, "u-operator", null)).toBe("swarm");
    expect(commentEditBlock(t, t, ME, null)).toBe("sent");
  });
});
