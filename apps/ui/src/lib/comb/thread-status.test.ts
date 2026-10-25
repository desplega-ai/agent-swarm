import { describe, expect, test } from "bun:test";
import type { CommentEntry, CommentListEntry } from "../agent-fs/types";
import {
  isTaskUnfinished,
  swarmThreadStatus,
  threadSwarmStates,
  threadsByTask,
  watchedTaskId,
} from "./thread-status";

const TASK = "0b8e1f5c-3d2a-4c6b-9e7f-1a2b3c4d5e6f";
const TASK_2 = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const SERVICE = "u-swarm";
let seq = 0;

function comment(overrides: Partial<CommentEntry> = {}): CommentEntry {
  seq++;
  return {
    id: `c${seq}`,
    path: "docs/a.md",
    body: "@swarm fix this",
    author: "u-ann",
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

const sent = (task = TASK) =>
  comment({ body: `[comb:sent task=${task}] Sent to the swarm`, author: SERVICE });
const reply = (author: string, body = "Done in v5.") => comment({ author, body });

describe("swarmThreadStatus", () => {
  test("an open root that was not sent is unsent, with or without @swarm", () => {
    expect(swarmThreadStatus(thread(), SERVICE)).toEqual({ kind: "unsent" });
    expect(swarmThreadStatus(thread({ body: "looks good" }), SERVICE)).toEqual({ kind: "unsent" });
  });

  test("a resolved thread is neither", () => {
    expect(swarmThreadStatus(thread({ resolved: true }), SERVICE)).toEqual({ kind: "none" });
  });

  test("a sent thread carries its task and waits for an answer", () => {
    expect(swarmThreadStatus(thread({}, [sent()]), SERVICE)).toEqual({
      kind: "sent",
      taskId: TASK,
      answered: false,
    });
  });

  test("a reply by someone other than the author after the sent reply answers it", () => {
    const status = swarmThreadStatus(thread({}, [sent(), reply("u-lead")]), SERVICE);
    expect(status).toEqual({ kind: "sent", taskId: TASK, answered: true });
  });

  test("the author's own follow-up does not answer it", () => {
    const status = swarmThreadStatus(thread({}, [sent(), reply("u-ann", "any news?")]), SERVICE);
    expect(status).toEqual({ kind: "sent", taskId: TASK, answered: false });
  });

  test("replies before the sent reply do not count", () => {
    const status = swarmThreadStatus(thread({}, [reply("u-bob"), sent()]), SERVICE);
    expect(status).toEqual({ kind: "sent", taskId: TASK, answered: false });
  });

  test("the newest sent reply wins", () => {
    const status = swarmThreadStatus(thread({}, [sent(), reply("u-lead"), sent(TASK_2)]), SERVICE);
    expect(status).toEqual({ kind: "sent", taskId: TASK_2, answered: false });
  });

  test("a marker from someone other than the service account is not a sent reply", () => {
    const fake = comment({ body: `[comb:sent task=${TASK}]`, author: "u-bob" });
    expect(swarmThreadStatus(thread({}, [fake]), SERVICE)).toEqual({ kind: "unsent" });
  });
});

describe("watchedTaskId", () => {
  test("watches an open, sent, unanswered thread", () => {
    expect(watchedTaskId(thread({}, [sent()]), SERVICE)).toBe(TASK);
  });

  test("stops once answered, and never for a resolved or unsent thread", () => {
    expect(watchedTaskId(thread({}, [sent(), reply("u-lead")]), SERVICE)).toBeNull();
    expect(watchedTaskId(thread({ resolved: true }, [sent()]), SERVICE)).toBeNull();
    expect(watchedTaskId(thread(), SERVICE)).toBeNull();
  });
});

describe("isTaskUnfinished", () => {
  test("is true for statuses before the end", () => {
    for (const status of ["pending", "in_progress", "offered", "unassigned", "paused"]) {
      expect(isTaskUnfinished(status)).toBe(true);
    }
  });

  test("is false for finished and unknown statuses", () => {
    for (const status of ["completed", "failed", "cancelled", "superseded", undefined, null]) {
      expect(isTaskUnfinished(status)).toBe(false);
    }
  });
});

describe("threadSwarmStates", () => {
  test("marks unsent threads, and sent threads whose task runs as processing", () => {
    const flagged = thread();
    const running = thread({}, [sent()]);
    const done = thread({}, [sent(TASK_2)]);
    const answered = thread({}, [sent(), reply("u-lead")]);
    const plain = thread({ body: "nice" });
    const closed = thread({ body: "nice", resolved: true });
    const status = (taskId: string) => (taskId === TASK ? "in_progress" : "completed");
    const states = threadSwarmStates(
      [flagged, running, done, answered, plain, closed],
      SERVICE,
      status,
    );
    expect([...states]).toEqual([
      [flagged.id, { kind: "unsent" }],
      [running.id, { kind: "processing", taskId: TASK }],
      [plain.id, { kind: "unsent" }],
    ]);
  });

  test("a task whose status is not known yet is not processing", () => {
    const running = thread({}, [sent()]);
    expect(threadSwarmStates([running], SERVICE, () => undefined).size).toBe(0);
  });
});

describe("threadsByTask", () => {
  test("groups the open, sent, unanswered threads by task, in file order", () => {
    const later = thread({ path: "docs/b.md", createdAt: "2026-09-30T09:00:00.000Z" }, [sent()]);
    const first = thread({ path: "docs/a.md", createdAt: "2026-09-30T11:00:00.000Z" }, [sent()]);
    const second = thread({ path: "docs/a.md", createdAt: "2026-09-30T12:00:00.000Z" }, [sent()]);
    const other = thread({}, [sent(TASK_2)]);
    const groups = threadsByTask([later, second, other, first], SERVICE);
    expect([...groups.keys()]).toEqual([TASK, TASK_2]);
    expect(groups.get(TASK)?.map((entry) => entry.id)).toEqual([first.id, second.id, later.id]);
    expect(groups.get(TASK_2)?.map((entry) => entry.id)).toEqual([other.id]);
  });

  test("leaves out unsent, answered, resolved, and resent-elsewhere threads", () => {
    const groups = threadsByTask(
      [
        thread(),
        thread({}, [sent(), reply("u-lead")]),
        thread({ resolved: true }, [sent()]),
        thread({}, [sent(), sent(TASK_2)]),
      ],
      SERVICE,
    );
    expect([...groups.keys()]).toEqual([TASK_2]);
  });
});
