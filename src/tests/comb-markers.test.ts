import { describe, expect, test } from "bun:test";
import * as ui from "../../apps/ui/src/lib/comb/markers";
import * as server from "../comb/markers";

// The server posts the "sent" reply and the dashboard reads it. Both copies
// of the pattern and of the "is it sent" rule must agree. The `@swarm` marker
// (`SWARM_MARKER_RE`) has no server copy: the server does not require it.

const TASK_ID = "0b8e1f5c-3d2a-4c6b-9e7f-1a2b3c4d5e6f";
const SERVICE = "svc";
const HUMAN = "human";

const BODIES = [
  `${server.sentMarker(TASK_ID)} Sent to the swarm: https://app.example/tasks/${TASK_ID}`,
  server.sentMarker(TASK_ID),
  `ok ${server.sentMarker(TASK_ID)}`,
  "[comb:sent task=not-a-uuid]",
  `[comb:sent task=${TASK_ID.toUpperCase()}]`,
  "",
  "plain reply",
];

const THREADS: Array<{ author: string; replies: Array<{ author: string; body: string }> }> = [
  { author: HUMAN, replies: [] },
  { author: HUMAN, replies: [{ author: SERVICE, body: server.sentMarker(TASK_ID) }] },
  { author: HUMAN, replies: [{ author: HUMAN, body: server.sentMarker(TASK_ID) }] },
  { author: HUMAN, replies: [{ author: "other", body: server.sentMarker(TASK_ID) }] },
  { author: HUMAN, replies: [{ author: SERVICE, body: `ok ${server.sentMarker(TASK_ID)}` }] },
  {
    author: HUMAN,
    replies: [
      { author: "other", body: "thanks" },
      { author: SERVICE, body: server.sentMarker(TASK_ID) },
    ],
  },
];

describe("sent marker: server and dashboard agree", () => {
  test("the patterns are the same, byte for byte", () => {
    expect(String(server.SENT_MARKER_RE)).toBe(String(ui.SENT_MARKER_RE));
  });

  test("the server's reply parses in the dashboard", () => {
    expect(ui.sentTaskIdOf({ body: server.sentMarker(TASK_ID) })).toBe(TASK_ID);
  });

  test("both match the same bodies", () => {
    for (const body of BODIES) {
      expect(server.SENT_MARKER_RE.test(body)).toBe(ui.SENT_MARKER_RE.test(body));
    }
  });

  test("both decide 'sent' the same way, with and without a known service account", () => {
    for (const serviceUserId of [SERVICE, null]) {
      for (const thread of THREADS) {
        expect(server.sentTaskId(thread, thread.replies, serviceUserId) !== null).toBe(
          ui.isSentToSwarm(thread, serviceUserId),
        );
      }
    }
  });

  test("a known service account is the only trusted author", () => {
    const byOther = THREADS[3] as (typeof THREADS)[number];
    expect(server.sentTaskId(byOther, byOther.replies, SERVICE)).toBeNull();
    expect(server.sentTaskId(byOther, byOther.replies, null)).toBe(TASK_ID);
  });
});
