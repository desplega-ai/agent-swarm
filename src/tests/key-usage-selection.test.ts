/**
 * P5: among admissible keys, the worker picks the lowest-usage key. Usage is
 * the max of the live 5h and 7d windows; a reset window and an unobserved key
 * count as 0; ties break at random. No usage level ever excludes a key.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { resolveCredentialPools, selectCredential } from "../utils/credentials";
import { keyUsageFromWindows, pickLowestUsage } from "../utils/key-usage";

const NOW_MS = Date.parse("2026-11-16T12:00:00Z");
const future = Math.floor(NOW_MS / 1000) + 3600;
const past = Math.floor(NOW_MS / 1000) - 60;
const POOL = "key-aaaaa,key-bbbbb,key-ccccc,key-ddddd";

let logSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  logSpy?.mockRestore();
  logSpy = undefined;
});

describe("keyUsageFromWindows", () => {
  test("takes the max of the live five_hour and seven_day windows", () => {
    expect(
      keyUsageFromWindows(
        {
          five_hour: { utilization: 0.53, resetsAt: future },
          seven_day: { utilization: 0.11, resetsAt: future },
        },
        NOW_MS,
      ),
    ).toBe(0.53);
    expect(
      keyUsageFromWindows(
        {
          five_hour: { utilization: 0.2, resetsAt: future },
          seven_day: { utilization: 0.8, resetsAt: future },
        },
        NOW_MS,
      ),
    ).toBe(0.8);
  });

  test("a window past resetsAt counts as 0", () => {
    expect(
      keyUsageFromWindows(
        {
          five_hour: { utilization: 0.99, resetsAt: past },
          seven_day: { utilization: 0.1, resetsAt: future },
        },
        NOW_MS,
      ),
    ).toBe(0.1);
    expect(keyUsageFromWindows({ five_hour: { utilization: 0.99, resetsAt: past } }, NOW_MS)).toBe(
      0,
    );
  });

  test("no observation counts as 0", () => {
    expect(keyUsageFromWindows(undefined, NOW_MS)).toBe(0);
    expect(keyUsageFromWindows(null, NOW_MS)).toBe(0);
    expect(keyUsageFromWindows({}, NOW_MS)).toBe(0);
    expect(keyUsageFromWindows({ five_hour: { resetsAt: future } }, NOW_MS)).toBe(0);
  });

  test("model-scoped weekly windows do not count", () => {
    expect(
      keyUsageFromWindows({ seven_day_opus: { utilization: 0.97, resetsAt: future } }, NOW_MS),
    ).toBe(0);
  });
});

describe("pickLowestUsage", () => {
  test("the lowest usage wins", () => {
    for (let i = 0; i < 50; i++) {
      expect(pickLowestUsage([0, 1, 2, 3], [0.6, 0.04, 0.53, 0.9])).toBe(1);
    }
  });

  test("an unobserved index ranks as 0", () => {
    expect(pickLowestUsage([0, 1, 2], [0.3, 0.2])).toBe(2);
    expect(pickLowestUsage([0, 1], undefined, () => 0.99)).toBe(1);
  });

  test("ties break at random", () => {
    const usage = [0.1, 0.5, 0.1, 0.1];
    expect(pickLowestUsage([0, 1, 2, 3], usage, () => 0)).toBe(0);
    expect(pickLowestUsage([0, 1, 2, 3], usage, () => 0.5)).toBe(2);
    expect(pickLowestUsage([0, 1, 2, 3], usage, () => 0.99)).toBe(3);
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(pickLowestUsage([0, 1, 2, 3], usage)!);
    expect([...seen].sort()).toEqual([0, 2, 3]);
  });

  test("an empty list picks nothing", () => {
    expect(pickLowestUsage([], [0.1])).toBeUndefined();
  });
});

describe("selectCredential with usage", () => {
  test("picks the lowest-usage available key", () => {
    for (let i = 0; i < 50; i++) {
      const pick = selectCredential(
        POOL,
        [0, 2, 3],
        "CLAUDE_CODE_OAUTH_TOKEN",
        undefined,
        [0.9, 0.01, 0.4, 0.7],
      );
      // Index 1 has the lowest usage but is not admissible: admission is unchanged.
      expect(pick.index).toBe(2);
      expect(pick.isRateLimitFallback).toBe(false);
    }
  });

  test("a 99%-used key is still picked when it is the only admissible key", () => {
    const pick = selectCredential(
      POOL,
      [3],
      "CLAUDE_CODE_OAUTH_TOKEN",
      undefined,
      [0.1, 0.1, 0.1, 0.99],
    );
    expect(pick.index).toBe(3);
    expect(pick.keySuffix).toBe("ddddd");
  });

  test("no usage data keeps a random pick over every available key", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(selectCredential(POOL, [0, 1, 2, 3]).index);
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });

  test("the allowlist still bounds the pick", () => {
    const pick = selectCredential(
      POOL,
      [0, 1, 2, 3],
      "CLAUDE_CODE_OAUTH_TOKEN",
      [2, 3],
      [0, 0, 0.5, 0.4],
    );
    expect(pick.index).toBe(3);
  });
});

describe("resolveCredentialPools with keyUsage from the availability read", () => {
  test("selects the lowest-usage key and logs its usage", async () => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    const env: Record<string, string | undefined> = { CLAUDE_CODE_OAUTH_TOKEN: POOL };
    const [selection] = await resolveCredentialPools(env, {
      provider: "claude",
      availableIndicesMap: {
        CLAUDE_CODE_OAUTH_TOKEN: {
          availableIndices: [0, 1, 2, 3],
          keyUsage: [0.53, 0.99, 0.07, 0.6],
        },
      },
    });
    expect(selection?.index).toBe(2);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("key-ccccc");
    expect(String(logSpy.mock.calls.at(-1)?.[0])).toContain("usage 7%");
  });
});
