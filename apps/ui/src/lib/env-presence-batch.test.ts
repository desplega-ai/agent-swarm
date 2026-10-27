import { describe, expect, test } from "bun:test";
import {
  ENV_PRESENCE_BATCH_SIZE,
  type EnvPresenceMap,
  fetchEnvPresenceBatched,
} from "./env-presence-batch";

describe("fetchEnvPresenceBatched", () => {
  test("splits key lists above the API cap into batches and merges the answers", async () => {
    const requested: string[][] = [];
    const fetchBatch = async (batch: string[]): Promise<EnvPresenceMap> => {
      // Mirror the API: more than 200 keys is a 400.
      if (batch.length > ENV_PRESENCE_BATCH_SIZE) throw new Error("400 Too many keys");
      requested.push(batch);
      return Object.fromEntries(batch.map((k) => [k, k.endsWith("_SET")]));
    };

    const keys = Array.from({ length: ENV_PRESENCE_BATCH_SIZE + 1 }, (_, i) => `KEY_${i}`);
    keys.push("LAST_SET", "KEY_0");

    const presence = await fetchEnvPresenceBatched(keys, fetchBatch);

    expect(requested.map((batch) => batch.length)).toEqual([ENV_PRESENCE_BATCH_SIZE, 2]);
    expect(Object.keys(presence)).toHaveLength(ENV_PRESENCE_BATCH_SIZE + 2);
    expect(presence.LAST_SET).toBe(true);
    expect(presence.KEY_0).toBe(false);
  });

  test("makes no request for an empty key list", async () => {
    let calls = 0;
    const presence = await fetchEnvPresenceBatched([], async () => {
      calls += 1;
      return {};
    });
    expect(presence).toEqual({});
    expect(calls).toBe(0);
  });
});
