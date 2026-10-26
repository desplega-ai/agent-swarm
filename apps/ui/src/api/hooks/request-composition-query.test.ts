import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { CompositionManifest } from "../../lib/request-composition";
import {
  COMPOSITION_LIVE_POLL_MS,
  COMPOSITION_MISSING_POLL_MS,
  compositionPollMs,
  requestCompositionQuery,
} from "./request-composition-query";

function manifest(seq: number, sessionId = "s-1"): CompositionManifest {
  return {
    id: `m-${seq}`,
    taskId: "task-1",
    agentId: "agent-1",
    sessionId,
    seq,
    provider: "pi",
    model: null,
    source: seq === 0 ? "worker" : "harness-hook",
    parts: [],
    staticEstTokens: 0,
    tokenRatio: 1,
    createdAt: "2026-10-26T10:00:00.000Z",
  };
}

describe("compositionPollMs", () => {
  test("a live task keeps polling after every session has its seq0", () => {
    expect(compositionPollMs(undefined, ["s-1"], true)).toBe(COMPOSITION_MISSING_POLL_MS);
    expect(compositionPollMs([manifest(0)], ["s-1", "s-2"], true)).toBe(
      COMPOSITION_MISSING_POLL_MS,
    );
    expect(compositionPollMs([manifest(0)], ["s-1"], true)).toBe(COMPOSITION_LIVE_POLL_MS);
    expect(compositionPollMs([manifest(0)], ["s-1"], false)).toBe(false);
  });
});

describe("requestCompositionQuery", () => {
  test("finds a seq1 posted after the seq0 read: by poll while live, by one read at the end", async () => {
    const server: CompositionManifest[] = [manifest(0)];
    let reads = 0;
    const fetchManifests = async () => {
      reads++;
      return [...server];
    };
    const client = new QueryClient();
    const live = requestCompositionQuery(
      "task-1",
      { enabled: true, sessionIds: ["s-1"], live: true },
      fetchManifests,
    );
    const observer = new QueryObserver(client, live);
    const unsubscribe = observer.subscribe(() => {});
    await client.fetchQuery(live);
    expect(observer.getCurrentResult().data?.map((m) => m.seq)).toEqual([0]);
    const query = client.getQueryCache().find({ queryKey: live.queryKey })!;
    expect(live.refetchInterval(query)).toBe(COMPOSITION_LIVE_POLL_MS);

    // The hook posts seq1; the task then ends before the next poll.
    server.push(manifest(1));
    const done = requestCompositionQuery(
      "task-1",
      { enabled: true, sessionIds: ["s-1"], live: false },
      fetchManifests,
    );
    const readsBefore = reads;
    observer.setOptions(done);
    await client.getQueryCache().find({ queryKey: done.queryKey })?.promise;
    expect(reads).toBe(readsBefore + 1);
    expect(observer.getCurrentResult().data?.map((m) => m.seq)).toEqual([0, 1]);
    expect(done.refetchInterval(client.getQueryCache().find({ queryKey: done.queryKey })!)).toBe(
      false,
    );
    unsubscribe();
    client.clear();
  });
});
