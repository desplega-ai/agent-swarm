import { describe, expect, test } from "bun:test";
import { scheduleAttempts } from "./index.ts";

const a = (scenarioId: string, configId: string, attemptIndex: number) => ({
  scenarioId,
  configId,
  attemptIndex,
});

describe("scheduleAttempts", () => {
  test("public scenarios before held-out ones, round-robin by attempt index inside each", () => {
    const heldOut = (id: string) => id === "aa-held" || id === "aa-held-solo";
    const order = scheduleAttempts(
      [
        a("aa-held", "c1", 0),
        a("aa-held", "c1", 1),
        a("zz-public", "c2", 1),
        a("aa-held-solo", "c1", 0),
        a("mm-public", "c1", 1),
        a("zz-public", "c1", 0),
        a("mm-public", "c1", 0),
      ],
      heldOut,
    ).map((x) => `${x.scenarioId}/${x.configId}#${x.attemptIndex}`);
    expect(order).toEqual([
      "mm-public/c1#0",
      "zz-public/c1#0",
      "mm-public/c1#1",
      "zz-public/c2#1",
      "aa-held/c1#0",
      "aa-held-solo/c1#0",
      "aa-held/c1#1",
    ]);
  });

  test("the default classifier puts the suite's held-out scenarios last", () => {
    const order = scheduleAttempts([
      a("capability-routing", "c", 0),
      a("delegation-chain", "c", 0),
      a("sql-audit", "c", 4),
    ]).map((x) => x.scenarioId);
    expect(order).toEqual(["sql-audit", "capability-routing", "delegation-chain"]);
  });
});
