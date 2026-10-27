import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
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
  test("polls a live task after seq0, stops once it ends, and keeps one key across both", async () => {
    const server: CompositionManifest[] = [manifest(0)];
    const fetchManifests = async () => [...server];
    const client = new QueryClient();
    const live = requestCompositionQuery(
      "task-1",
      { enabled: true, sessionIds: ["s-1"], live: true },
      fetchManifests,
    );
    await client.fetchQuery(live);
    const query = client.getQueryCache().find({ queryKey: live.queryKey })!;
    expect(live.refetchInterval(query)).toBe(COMPOSITION_LIVE_POLL_MS);

    // The end-of-task read invalidates this key, so the phase stays out of it.
    const done = requestCompositionQuery(
      "task-1",
      { enabled: true, sessionIds: ["s-1"], live: false },
      fetchManifests,
    );
    expect(done.queryKey).toEqual(live.queryKey);
    expect(done.refetchInterval(query)).toBe(false);
    client.clear();
  });
});
