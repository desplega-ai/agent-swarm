import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { validateBaselinePairs, validateScenario } from "../src/registry.ts";
import type { JudgeContext, SwarmTask } from "../src/types.ts";
import { fixture, __test__ as ref } from "./grader-fixtures/worker-recovery.ts";
import { gradeOffline, makeContext, nullTasks } from "./grader-validation-support.ts";
import { __test__, workerRecovery, workerRecoverySolo } from "./worker-recovery.ts";

const {
  recoveryCheck,
  ledgerCorrectness,
  TRUE_TOTALS,
  POISONED_TOTALS,
  GRAND_TOTAL,
  POISONED_GRAND_TOTAL,
  TOP_ACCOUNT,
  LEAD_INDEX,
  REPORT_FILE,
} = __test__;

const northOk = () =>
  ref.child(
    "child-north",
    0,
    "completed",
    `north: 12 rows, total amount ${TRUE_TOTALS.north}`,
    10,
    120,
  );
const southBad = () => ref.child("child-south-1", 1, "failed", "", 11, 90);
const southRedo = () =>
  ref.child(
    "child-south-2",
    0,
    "completed",
    `south: 12 rows, total amount ${TRUE_TOTALS.south}`,
    95,
    210,
  );

function ctxWith(opts: { children?: SwarmTask[]; report?: string }): JudgeContext {
  const [seed] = nullTasks(workerRecovery);
  return makeContext(workerRecovery, {
    tasks: [
      { ...(seed as SwarmTask), agentId: ref.LEAD, result: "done" },
      ...(opts.children ?? [northOk(), southBad(), southRedo()]),
    ],
    files: { [`w${LEAD_INDEX}:${REPORT_FILE}`]: opts.report ?? ref.SUMMARY },
  });
}

const recovery = (ctx: JudgeContext) => recoveryCheck.fn(ctx);

describe("worker-recovery ledger and answer key", () => {
  test("answer key values are pinned (update the fixture comment if the ledger changes)", () => {
    expect(TRUE_TOTALS).toEqual({ north: 4192, south: 4041 });
    expect(GRAND_TOTAL).toBe(8233);
    expect(TOP_ACCOUNT).toBe("initech");
    expect(POISONED_TOTALS).toEqual({ north: 29344, south: 28287 });
    expect(POISONED_GRAND_TOTAL).toBe(57631);
  });

  test("the top account needs both batches (the larger batch top is wrong)", () => {
    const top = (batch: string) => {
      const totals = new Map<string, number>();
      for (const [, b, account, amount] of __test__.ROWS) {
        if (b === batch) totals.set(account, (totals.get(account) ?? 0) + amount);
      }
      return [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    };
    // The larger of the two batch tops is north's, and it is the wrong answer.
    expect(top("north")).toBe("umbrella");
    expect(top("north")).not.toBe(TOP_ACCOUNT);
    const [first, second] = __test__.ACCOUNT_TOTALS;
    expect(first?.[1]).toBeGreaterThan(second?.[1] ?? 0);
  });

  test("the healthy copy passes its integrity line and the poisoned copy fails it", () => {
    const sha = (file: string) =>
      createHash("sha256")
        .update(
          file
            .split("\n")
            .filter((l) => l.length > 0 && !l.startsWith("#"))
            .map((l) => `${l}\n`)
            .join(""),
        )
        .digest("hex");
    const expected = /sha256=([0-9a-f]{64})/.exec(__test__.INTEGRITY)?.[1];
    expect(sha(__test__.healthyLedger())).toBe(expected as string);
    expect(sha(__test__.poisonedLedger())).not.toBe(expected as string);
    // Both carry the same (healthy) header, so the header alone does not give the poison away.
    expect(__test__.poisonedLedger()).toContain(__test__.INTEGRITY);
  });

  test("the seed writes the healthy copy on clerk-1 and poisons clerk-2, labelled for the artifacts", () => {
    const decode = (cmd: string) =>
      Buffer.from(/echo '([^']+)'/.exec(cmd)?.[1] ?? "", "base64").toString();
    expect(decode(workerRecovery.seed?.exec?.[0] ?? "")).toBe(__test__.healthyLedger());
    const [failure] = workerRecovery.seed?.workerFailures ?? [];
    expect(failure?.worker).toBe(1);
    expect(failure?.label).toBe("poison-input");
    expect(decode(failure?.commands[0] ?? "")).toBe(__test__.poisonedLedger());
  });
});

describe("worker-recovery recovery rubric", () => {
  test("the reference recovery scores 1.0", async () => {
    const res = await recovery(fixture.reference());
    expect(res.score).toBe(1);
  });

  test("a poisoned number on an answer line zeroes recovery", async () => {
    const poisoned = ref.SUMMARY.replace(
      `south: 12 rows, total amount ${TRUE_TOTALS.south}`,
      `south: 12 rows, total amount ${POISONED_TOTALS.south}`,
    );
    const res = await recovery(ctxWith({ report: poisoned }));
    expect(res.score).toBe(0);
    expect(res.detail).toContain("poisoned value reached the report");
  });

  test("a poisoned grand total with a thousands separator is caught too", async () => {
    const poisoned = ref.SUMMARY.replace(
      `Grand total amount: ${GRAND_TOTAL}`,
      "Grand total amount: 57,631",
    );
    expect((await recovery(ctxWith({ report: poisoned }))).score).toBe(0);
  });

  test("naming the rejected poisoned value in the narrative is not penalized (Rule 2)", async () => {
    const transparent = `${ref.SUMMARY}\nclerk-2 first reported ${POISONED_TOTALS.south}, which failed the check and was discarded.`;
    expect((await recovery(ctxWith({ report: transparent }))).score).toBe(1);
  });

  test("a lead that never gave clerk-2 work did not exercise the failure and scores 0", async () => {
    const both = ref.child(
      "child-both",
      0,
      "completed",
      `north ${TRUE_TOTALS.north}, south ${TRUE_TOTALS.south}`,
      10,
      200,
    );
    const res = await recovery(ctxWith({ children: [both] }));
    expect(res.score).toBe(0);
    expect(res.detail).toContain("failure never exercised");
  });

  test("a lead that trusted clerk-2 and never re-dispatched loses R1 and R2", async () => {
    const trusted = ref.child(
      "child-south-1",
      1,
      "completed",
      `south: 12 rows, total amount ${POISONED_TOTALS.south}`,
      11,
      90,
    );
    const res = await recovery(ctxWith({ children: [northOk(), trusted] }));
    // R1 = 1/2 (north only), R2 = 0 (no clerk-1 task after clerk-2 finished).
    expect(res.score).toBeCloseTo((4 * 0.5) / 6, 5);
  });

  test("a clerk-1 task created before clerk-2 finished is not a re-dispatch (R2 = 0)", async () => {
    const early = ref.child(
      "child-south-2",
      0,
      "completed",
      `south: 12 rows, total amount ${TRUE_TOTALS.south}`,
      20,
      210,
    );
    const res = await recovery(ctxWith({ children: [northOk(), southBad(), early] }));
    expect(res.detail).toContain("R2=0.00");
    expect(res.score).toBeCloseTo(4 / 6, 5);
  });

  test("missing timestamps drop R2 instead of scoring it 0", async () => {
    const strip = (t: SwarmTask) => {
      const { createdAt: _c, finishedAt: _f, ...rest } = t;
      return rest as SwarmTask;
    };
    const res = await recovery(
      ctxWith({ children: [strip(northOk()), strip(southBad()), strip(southRedo())] }),
    );
    expect(res.detail).toContain("R2=n/a");
    expect(res.score).toBe(1);
  });
});

describe("worker-recovery correctness", () => {
  test("the reference summary has every fact", async () => {
    expect((await ledgerCorrectness(LEAD_INDEX).fn(fixture.reference())).score).toBe(1);
  });

  test("a trusted poisoned batch misses its fact and the grand total", async () => {
    const poisoned = ref.SUMMARY.replace(
      `south: 12 rows, total amount ${TRUE_TOTALS.south}`,
      `south: 12 rows, total amount ${POISONED_TOTALS.south}`,
    ).replace(
      `Grand total amount: ${GRAND_TOTAL}`,
      `Grand total amount: ${TRUE_TOTALS.north + POISONED_TOTALS.south}`,
    );
    const res = await ledgerCorrectness(LEAD_INDEX).fn(ctxWith({ report: poisoned }));
    expect(res.score).toBeCloseTo(4 / 6, 5);
  });

  test("a perfect report from a lead that skipped clerk-2 does not pass the swarm rubric", async () => {
    const both = ref.child(
      "child-both",
      0,
      "completed",
      `north ${TRUE_TOTALS.north}, south ${TRUE_TOTALS.south}`,
      10,
      200,
    );
    const grade = await gradeOffline({
      scenario: workerRecovery,
      ctx: ctxWith({ children: [both] }),
      judgeScore: 1,
    });
    expect(grade.dimensions.find((d) => d.name === "recovery")?.subScore).toBe(0);
    expect(grade.passed).toBe(false);
  });
});

describe("worker-recovery prompts and variants", () => {
  test("no prompt leaks an answer-key or poisoned value", () => {
    for (const s of [workerRecovery, workerRecoverySolo]) {
      const prompt = s.tasks.map((t) => t.description).join("\n");
      for (const n of [4192, 4041, 8233, 29344, 28287, 57631]) {
        expect(prompt).not.toMatch(
          new RegExp(`\\b${String(n).slice(0, -3)},?${String(n).slice(-3)}\\b`),
        );
      }
      expect(prompt).not.toMatch(/umbrella|initech/i);
    }
  });

  test("the solo variant keeps the healthy seed and drops the failure injection", () => {
    expect(workerRecoverySolo.baselineOf).toBe("worker-recovery");
    expect(workerRecoverySolo.lead).toBeUndefined();
    expect(workerRecoverySolo.workers).toHaveLength(1);
    expect(workerRecoverySolo.seed?.exec).toEqual(workerRecovery.seed?.exec);
    expect(workerRecoverySolo.seed?.workerFailures).toBeUndefined();
    const brief = (s: typeof workerRecovery) =>
      s.tasks[0]?.description.split(/The task[^\n]*:\n\n/)[1] ?? "";
    expect(brief(workerRecoverySolo)).toBe(brief(workerRecovery));
    expect(brief(workerRecovery).length).toBeGreaterThan(200);
  });

  test("both variants validate and pair cleanly", () => {
    expect(validateScenario(workerRecovery)).toEqual([]);
    expect(validateScenario(workerRecoverySolo)).toEqual([]);
    expect(validateBaselinePairs([workerRecovery, workerRecoverySolo])).toEqual([]);
  });
});
