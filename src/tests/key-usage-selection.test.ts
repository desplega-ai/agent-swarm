/**
 * P5: among admissible keys, the worker picks the lowest-usage key. Usage is
 * the max of the live 5h and 7d windows; a reset window and an unobserved key
 * count as 0; the pick is random among keys within 0.10 of the lowest. No usage level ever excludes a key.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { resolveCredentialPools, selectCredential } from "../utils/credentials";
import {
  credentialSelectionStrategy,
  keyPaceFromWindows,
  keyUsageFromWindows,
  pickLowestUsage,
} from "../utils/key-usage";

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
    expect(pickLowestUsage([0, 1], undefined, undefined, () => 0.99)).toBe(1);
  });

  test("ties break at random", () => {
    const usage = [0.1, 0.5, 0.1, 0.1];
    expect(pickLowestUsage([0, 1, 2, 3], usage, undefined, () => 0)).toBe(0);
    expect(pickLowestUsage([0, 1, 2, 3], usage, undefined, () => 0.5)).toBe(2);
    expect(pickLowestUsage([0, 1, 2, 3], usage, undefined, () => 0.99)).toBe(3);
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(pickLowestUsage([0, 1, 2, 3], usage)!);
    expect([...seen].sort()).toEqual([0, 2, 3]);
  });

  test("picks at random within 0.10 of the lowest, never above the band", () => {
    const usage = [0.11, 0.12, 0.21, 0.22, 0.6];
    expect(pickLowestUsage([0, 1, 2, 3, 4], usage, undefined, () => 0)).toBe(0);
    expect(pickLowestUsage([0, 1, 2, 3, 4], usage, undefined, () => 0.5)).toBe(1);
    expect(pickLowestUsage([0, 1, 2, 3, 4], usage, undefined, () => 0.99)).toBe(2);
    const seen = new Set<number>();
    for (let i = 0; i < 300; i++) seen.add(pickLowestUsage([0, 1, 2, 3, 4], usage)!);
    expect([...seen].sort()).toEqual([0, 1, 2]);
  });

  test("within the band, the fewest running sessions wins, ties at random", () => {
    const usage = [0.11, 0.12, 0.2, 0.6];
    // Index 3 has no sessions but sits above the band.
    const sessions = [2, 1, 1, 0];
    expect(pickLowestUsage([0, 1, 2, 3], usage, sessions, () => 0)).toBe(1);
    expect(pickLowestUsage([0, 1, 2, 3], usage, sessions, () => 0.99)).toBe(2);
    expect(pickLowestUsage([0, 1, 2], usage, [3, 0], () => 0.99)).toBe(2);
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
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      seen.add(
        selectCredential(POOL, [0, 1, 2, 3], "CLAUDE_CODE_OAUTH_TOKEN", [2, 3], [0, 0, 0.5, 0.4])
          .index,
      );
    }
    // 0.5 is within 0.10 of 0.4, so both allowlisted keys share the draw.
    expect([...seen].sort()).toEqual([2, 3]);
  });

  test("a burst spreads over keys within the band", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      seen.add(
        selectCredential(
          POOL,
          [0, 1, 2, 3],
          "CLAUDE_CODE_OAUTH_TOKEN",
          undefined,
          [0.11, 0.12, 0.4, 0.9],
        ).index,
      );
    }
    expect([...seen].sort()).toEqual([0, 1]);
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

const DAY_S = 86_400;
const nowS = Math.floor(NOW_MS / 1000);
// 18% used with 5 days to the weekly reset, and 39% used with 2 days to it.
const EARLY_LOW = { seven_day: { utilization: 0.18, resetsAt: nowS + 5 * DAY_S } };
const LATE_HIGH = { seven_day: { utilization: 0.39, resetsAt: nowS + 2 * DAY_S } };

describe("keyPaceFromWindows", () => {
  test("used minus the elapsed share of the window", () => {
    expect(keyPaceFromWindows(EARLY_LOW, NOW_MS)).toBeCloseTo(0.18 - 2 / 7, 6);
    expect(keyPaceFromWindows(LATE_HIGH, NOW_MS)).toBeCloseTo(0.39 - 5 / 7, 6);
  });

  test("the most over-pace window binds", () => {
    const windows = {
      ...EARLY_LOW,
      // 1 hour into the 5h window, 50% used: +30 points over pace.
      five_hour: { utilization: 0.5, resetsAt: nowS + 4 * 3600 },
    };
    expect(keyPaceFromWindows(windows, NOW_MS)).toBeCloseTo(0.3, 6);
  });

  test("a model window counts only for its family", () => {
    const windows = {
      ...LATE_HIGH,
      seven_day_overage_included: { utilization: 0.9, resetsAt: nowS + 2 * DAY_S },
    };
    expect(keyPaceFromWindows(windows, NOW_MS, "fable")).toBeCloseTo(0.9 - 5 / 7, 6);
    expect(keyPaceFromWindows(windows, NOW_MS, "opus")).toBeCloseTo(0.39 - 5 / 7, 6);
    expect(keyPaceFromWindows(windows, NOW_MS)).toBeCloseTo(0.39 - 5 / 7, 6);
  });

  test("no live window is no reading", () => {
    expect(keyPaceFromWindows(undefined, NOW_MS)).toBeUndefined();
    expect(keyPaceFromWindows({ seven_day: { utilization: 0.5, resetsAt: past } }, NOW_MS)).toBe(
      undefined,
    );
    expect(keyPaceFromWindows({ seven_day: { utilization: 0.5 } }, NOW_MS)).toBeUndefined();
  });
});

describe("credentialSelectionStrategy", () => {
  test("defaults to pace; only an explicit usage switches", () => {
    expect(credentialSelectionStrategy(undefined)).toBe("pace");
    expect(credentialSelectionStrategy("")).toBe("pace");
    expect(credentialSelectionStrategy(" PACE ")).toBe("pace");
    expect(credentialSelectionStrategy(" USAGE ")).toBe("usage");
    expect(credentialSelectionStrategy("nonsense")).toBe("pace");
  });
});

describe("resolveCredentialPools with keyPace", () => {
  const pool = "key-aaaaa,key-bbbbb";
  const read = (selectionStrategy?: "pace" | "usage", withPace = true) => ({
    CLAUDE_CODE_OAUTH_TOKEN: {
      availableIndices: [0, 1],
      keyUsage: [0.18, 0.39],
      ...(withPace
        ? {
            keyPace: [
              keyPaceFromWindows(EARLY_LOW, NOW_MS)!,
              keyPaceFromWindows(LATE_HIGH, NOW_MS)!,
            ],
          }
        : {}),
      ...(selectionStrategy ? { selectionStrategy } : {}),
    },
  });

  test("pace picks the 39% key resetting in 2 days over the 18% key resetting in 5", async () => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    for (let i = 0; i < 50; i++) {
      const env: Record<string, string | undefined> = { CLAUDE_CODE_OAUTH_TOKEN: pool };
      const [selection] = await resolveCredentialPools(env, {
        provider: "claude",
        availableIndicesMap: read("pace"),
      });
      expect(selection?.index).toBe(1);
    }
    const line = String(logSpy.mock.calls.at(-1)?.[0]);
    expect(line).toContain("usage 39% pace -32% strategy pace");
  });

  test("usage, no strategy, or no keyPace keeps the old pick", async () => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    for (const map of [
      read("usage"),
      read(undefined),
      read(undefined, false),
      read("pace", false),
    ]) {
      const env: Record<string, string | undefined> = { CLAUDE_CODE_OAUTH_TOKEN: pool };
      const [selection] = await resolveCredentialPools(env, {
        provider: "claude",
        availableIndicesMap: map,
      });
      expect(selection?.index).toBe(0);
      expect(String(logSpy.mock.calls.at(-1)?.[0])).toContain("strategy usage");
    }
  });
});
