import { describe, expect, test } from "bun:test";
import {
  hasSwarmMarker,
  isSentToSwarm,
  SENT_MARKER_RE,
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

  test("splits a body into text and chips", () => {
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

  test("a thread is sent when any reply carries the marker", () => {
    expect(isSentToSwarm({ replies: [{ body: "thanks" }] })).toBe(false);
    expect(
      isSentToSwarm({ replies: [{ body: "thanks" }, { body: `[comb:sent task=${TASK_ID}]` }] }),
    ).toBe(true);
  });
});
