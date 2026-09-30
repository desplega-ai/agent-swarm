import { describe, expect, test } from "bun:test";
import {
  hasSwarmMarker,
  isSentToSwarm,
  SENT_MARKER_RE,
  sentReplyTaskId,
  sentTaskIdOf,
  splitSwarmMarkers,
} from "./markers";

const TASK_ID = "0b8e1f5c-3d2a-4c6b-9e7f-1a2b3c4d5e6f";

describe("@swarm marker", () => {
  test("matches at the start, in the middle, and in any case", () => {
    expect(hasSwarmMarker("@swarm tighten this")).toBe(true);
    expect(hasSwarmMarker("please ask @swarm to fix it")).toBe(true);
    expect(hasSwarmMarker("line one\n@SWARM line two")).toBe(true);
  });

  test("does not match inside a word or a longer name", () => {
    expect(hasSwarmMarker("mail me@swarm.local")).toBe(false);
    expect(hasSwarmMarker("@swarmbot do it")).toBe(false);
    expect(hasSwarmMarker("no marker here")).toBe(false);
  });

  test("a member whose label starts with swarm is not the marker", () => {
    expect(hasSwarmMarker("@swarm-admin please check")).toBe(false);
    expect(hasSwarmMarker("@swarm_bot and @swarm2")).toBe(false);
    expect(hasSwarmMarker("@swarm.bot please check")).toBe(false);
    expect(hasSwarmMarker("@swarm@example.com please check")).toBe(false);
    expect(hasSwarmMarker("@Swarmé")).toBe(false);
  });

  test("punctuation after the marker still ends it", () => {
    expect(hasSwarmMarker("please fix this @swarm.")).toBe(true);
    expect(hasSwarmMarker("@swarm, then")).toBe(true);
    expect(hasSwarmMarker("now @swarm!")).toBe(true);
    expect(hasSwarmMarker("ask @swarm")).toBe(true);
  });

  test("splits a body into text and chips", () => {
    expect(splitSwarmMarkers("@swarm-admin and @swarm.")).toEqual([
      { kind: "text", text: "@swarm-admin and " },
      { kind: "swarm", text: "@swarm" },
      { kind: "text", text: "." },
    ]);
    expect(splitSwarmMarkers("@swarm fix, then @Swarm check. me@swarm.local stays")).toEqual([
      { kind: "swarm", text: "@swarm" },
      { kind: "text", text: " fix, then " },
      { kind: "swarm", text: "@Swarm" },
      { kind: "text", text: " check. me@swarm.local stays" },
    ]);
    expect(splitSwarmMarkers("plain")).toEqual([{ kind: "text", text: "plain" }]);
  });
});

describe("sent marker", () => {
  test("reads the task id from a sent reply", () => {
    expect(sentTaskIdOf({ body: `[comb:sent task=${TASK_ID}] Sent to the swarm.` })).toBe(TASK_ID);
    expect(SENT_MARKER_RE.exec(`[comb:sent task=${TASK_ID}]`)?.[1]).toBe(TASK_ID);
  });

  test("ignores a marker that is not at the start or has a bad id", () => {
    expect(sentTaskIdOf({ body: `ok [comb:sent task=${TASK_ID}]` })).toBeNull();
    expect(sentTaskIdOf({ body: "[comb:sent task=not-a-uuid]" })).toBeNull();
  });

  test("a thread is sent when a reply by another author opens with the marker", () => {
    const sent = { body: `[comb:sent task=${TASK_ID}] Sent to the swarm.`, author: "swarm" };
    const thanks = { body: "thanks", author: "x" };
    expect(isSentToSwarm({ author: "human", replies: [thanks] })).toBe(false);
    expect(isSentToSwarm({ author: "human", replies: [thanks, sent] })).toBe(true);
    expect(sentReplyTaskId({ author: "human" }, sent)).toBe(TASK_ID);
  });

  test("with a known service account, only its marker reply counts", () => {
    const bySwarm = { body: `[comb:sent task=${TASK_ID}]`, author: "svc" };
    const byOther = { body: `[comb:sent task=${TASK_ID}]`, author: "x" };
    expect(isSentToSwarm({ author: "human", replies: [bySwarm] }, "svc")).toBe(true);
    expect(isSentToSwarm({ author: "human", replies: [byOther] }, "svc")).toBe(false);
    expect(sentReplyTaskId({ author: "human" }, byOther, "svc")).toBeNull();
    expect(sentReplyTaskId({ author: "human" }, bySwarm, "svc")).toBe(TASK_ID);
  });

  test("the thread's own author cannot mark it as sent", () => {
    const own = { body: `[comb:sent task=${TASK_ID}]`, author: "human" };
    expect(isSentToSwarm({ author: "human", replies: [own] })).toBe(false);
    expect(sentReplyTaskId({ author: "human" }, own)).toBeNull();
  });
});
