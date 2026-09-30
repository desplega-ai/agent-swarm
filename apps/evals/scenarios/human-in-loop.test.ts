import { describe, expect, test } from "bun:test";
import { validateBaselinePairs, validateScenario } from "../src/registry.ts";
import {
  EXPORT,
  exportJob,
  fixture,
  followUp,
  loopContext,
  requestsApi,
} from "./grader-fixtures/human-in-loop.ts";
import { __test__, humanInLoop, humanInLoopSolo } from "./human-in-loop.ts";

const { clarificationCheck, exportCorrectness } = __test__;

describe("human-in-loop clarification rubric", () => {
  test("ask, resume, then dispatch: 1.0", async () => {
    expect((await clarificationCheck.fn(fixture.reference())).score).toBe(1);
  });

  test("never asking zeroes the dimension", async () => {
    const res = await clarificationCheck.fn(
      loopContext({ api: { "/api/approval-requests?limit=100": { approvalRequests: [] } } }),
    );
    expect(res.score).toBe(0);
  });

  test("dispatching the export before asking costs a third", async () => {
    const res = await clarificationCheck.fn(
      loopContext({ children: [exportJob(5), followUp("lead"), exportJob(30)] }),
    );
    expect(res.score).toBeCloseTo(2 / 3);
  });

  test("an unanswered request (no follow-up, no work after) scores a third", async () => {
    const res = await clarificationCheck.fn(
      loopContext({ children: [], api: requestsApi({ resolvedAt: null }) }),
    );
    expect(res.score).toBeCloseTo(1 / 3);
  });
});

describe("human-in-loop export answer key", () => {
  test("the reference export (EU, id/name/plan) scores 1.0", async () => {
    expect((await exportCorrectness.fn(fixture.reference())).score).toBe(1);
    expect(__test__.EU_IDS).toEqual(["C-01", "C-03", "C-06", "C-08", "C-11"]);
  });

  test("any email in the export zeroes it", async () => {
    const leaky = JSON.stringify([
      { id: "C-01", name: "Alder & Co", plan: "pro", email: "ops@alder.example" },
    ]);
    expect((await exportCorrectness.fn(loopContext({ exportJson: leaky }))).score).toBe(0);
  });

  test("exporting every customer (guessing the scope) scores the id overlap only", async () => {
    const all = JSON.stringify(
      __test__.CUSTOMERS.map(([id, name, , , plan]) => ({ id, name, plan })),
    );
    const res = await exportCorrectness.fn(loopContext({ exportJson: all }));
    expect(res.score).toBeCloseTo(0.7 * (5 / 12) + 0.3);
  });

  test("a CSV where JSON was asked scores 0; a wrapped array is accepted", async () => {
    expect(
      (await exportCorrectness.fn(loopContext({ exportJson: "id,name\nC-01,Alder" }))).score,
    ).toBe(0);
    const wrapped = JSON.stringify({ customers: JSON.parse(EXPORT) });
    expect((await exportCorrectness.fn(loopContext({ exportJson: wrapped }))).score).toBe(1);
  });
});

describe("human-in-loop registration", () => {
  test("both variants validate, pair as a baseline, and carry the canned human", () => {
    expect(validateScenario(humanInLoop)).toEqual([]);
    expect(validateScenario(humanInLoopSolo)).toEqual([]);
    expect(validateBaselinePairs([humanInLoop, humanInLoopSolo])).toEqual([]);
    expect(humanInLoopSolo.humanInput).toEqual(humanInLoop.humanInput);
    expect(humanInLoopSolo.awaitSpawnedTasks).toBe(true);
  });

  test("the brief leaves scope, fields and format open; only the reply settles them", () => {
    const brief = humanInLoop.tasks[0]?.description ?? "";
    for (const word of [/\bEU\b/, /json/i, /email/i]) expect(brief).not.toMatch(word);
    for (const word of [/\bEU\b/, /json/i, /email/i]) expect(__test__.REPLY).toMatch(word);
  });
});
