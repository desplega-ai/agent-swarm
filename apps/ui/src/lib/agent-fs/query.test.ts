import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { AgentFsError } from "./client";
import { agentFsKey, agentFsRetry, recheckMeOnAuthError } from "./query";

const ENDPOINT = "http://fs.test";

describe("agentFsKey", () => {
  test("carries the endpoint, user, org, and drive before the rest", () => {
    expect(agentFsKey(ENDPOINT, "user-1", "org-1", "drive-1", "ls", "/")).toEqual([
      "agent-fs",
      ENDPOINT,
      "user-1",
      "org-1",
      "drive-1",
      "ls",
      "/",
    ]);
    expect(agentFsKey(ENDPOINT, null, null, null, "health")).toEqual([
      "agent-fs",
      ENDPOINT,
      null,
      null,
      null,
      "health",
    ]);
  });
});

describe("agentFsRetry", () => {
  test("never retries a 401, retries other failures twice", () => {
    const unauthorized = new AgentFsError(401, "UNAUTHORIZED", "bad key");
    const down = new AgentFsError(0, "NETWORK", "down");
    expect(agentFsRetry(0, unauthorized)).toBe(false);
    expect(agentFsRetry(0, down)).toBe(true);
    expect(agentFsRetry(1, down)).toBe(true);
    expect(agentFsRetry(2, down)).toBe(false);
  });
});

describe("recheckMeOnAuthError", () => {
  const meKey = agentFsKey(ENDPOINT, "user-1", null, null, "me");
  const lsKey = agentFsKey(ENDPOINT, "user-1", "org-1", "drive-1", "ls", "/");

  async function fail(client: QueryClient, queryKey: readonly unknown[], error: Error) {
    await client
      .fetchQuery({ queryKey, queryFn: () => Promise.reject(error), retry: false })
      .catch(() => {});
  }

  /** Records every `invalidateQueries` filter. */
  function setup() {
    const client = new QueryClient();
    client.setQueryData(meKey, { userId: "user-1" });
    const invalidations: unknown[] = [];
    const invalidate = client.invalidateQueries.bind(client);
    client.invalidateQueries = ((filters) => {
      invalidations.push(filters);
      return invalidate(filters);
    }) as QueryClient["invalidateQueries"];
    const stop = recheckMeOnAuthError(client, meKey);
    return { client, stop, invalidations };
  }

  test("a 401 from another agent-fs query invalidates me", async () => {
    const { client, stop, invalidations } = setup();
    await fail(client, lsKey, new AgentFsError(401, "UNAUTHORIZED", "bad key"));
    expect(invalidations).toEqual([{ queryKey: meKey, exact: true }]);
    expect(client.getQueryState(meKey)?.isInvalidated).toBe(true);
    stop();
    client.clear();
  });

  test("other failures, non agent-fs keys, and me itself are ignored", async () => {
    const { client, stop, invalidations } = setup();
    await fail(client, lsKey, new AgentFsError(500, "INTERNAL", "boom"));
    await fail(client, ["tasks"], new AgentFsError(401, "UNAUTHORIZED", "bad key"));
    // A 401 on `me` must not re-check `me` (that would loop).
    await fail(client, meKey, new AgentFsError(401, "UNAUTHORIZED", "bad key"));
    expect(invalidations).toEqual([]);
    stop();
    client.clear();
  });

  test("stops after unsubscribe", async () => {
    const { client, stop, invalidations } = setup();
    stop();
    await fail(client, lsKey, new AgentFsError(401, "UNAUTHORIZED", "bad key"));
    expect(invalidations).toEqual([]);
    client.clear();
  });
});
