import { describe, expect, test } from "bun:test";
import { validateScenario } from "../src/registry.ts";
import { __test__, capabilityRouting } from "./capability-routing.ts";
import {
  ANSWERS,
  child,
  fixture,
  JOB_TEXT,
  REFERENCE_CHILDREN,
  routingContext,
} from "./grader-fixtures/capability-routing.ts";

const { routingCheck, answerKey } = __test__;

describe("capability-routing answer key", () => {
  test("pinned values", () => {
    expect(__test__.REFUND_COUNT).toBe(4);
    expect(__test__.REFUND_TOTAL).toBe(13205);
    expect(__test__.ON_CALL).toBe("Priya Raman");
  });

  test("the reference answers carry every fact; a translation without the glossary misses its terms", async () => {
    expect((await answerKey.fn(fixture.reference())).score).toBe(1);
    const noGlossary = ANSWERS.replace(
      /^Spanish:.*$/m,
      "Spanish: Las tareas ahora se reintentan. / El grupo comparte un espacio de trabajo.",
    );
    const res = await answerKey.fn(routingContext(REFERENCE_CHILDREN, noGlossary));
    expect(res.score).toBeCloseTo(3 / 6);
  });
});

describe("capability-routing routing rubric", () => {
  test("each job once, to its owner: 1.0", async () => {
    expect((await routingCheck.fn(fixture.reference())).score).toBe(1);
  });

  test("a job first sent to the wrong worker scores 0 for that job, even if reassigned", async () => {
    const res = await routingCheck.fn(
      routingContext([
        child("t", 2, JOB_TEXT.translation as string, 10),
        child("o-wrong", 1, JOB_TEXT["on-call"] as string, 11),
        child("o-right", 0, JOB_TEXT["on-call"] as string, 70),
        child("r", 1, JOB_TEXT.orders as string, 12),
      ]),
    );
    expect(res.score).toBeCloseTo(2 / 3);
    expect(res.detail).toContain("on-call=0 (first sent to w1, needed w0)");
  });

  test("a job sent twice (broadcast or retry) gets half", async () => {
    const res = await routingCheck.fn(
      routingContext([...REFERENCE_CHILDREN, child("dup", 1, JOB_TEXT.orders as string, 30)]),
    );
    expect(res.score).toBeCloseTo((1 + 1 + 0.5) / 3);
  });

  test("one task bundling every job to one worker is right for one job at most", async () => {
    const all = Object.values(JOB_TEXT).join("\n");
    const res = await routingCheck.fn(routingContext([child("all", 1, all, 10)]));
    expect(res.score).toBeCloseTo(1 / 3);
  });

  test("the job order in the brief matches no worker order", () => {
    const brief = capabilityRouting.tasks[0]?.description ?? "";
    const order = __test__.JOBS.map((j) => ({ worker: j.worker, at: brief.search(j.match) })).sort(
      (a, b) => a.at - b.at,
    );
    expect(order.map((o) => o.worker)).not.toEqual([0, 1, 2]);
  });

  test("the scenario validates, with a declared profile on every worker", () => {
    expect(validateScenario(capabilityRouting)).toEqual([]);
    const workers = capabilityRouting.workers as { profile?: unknown }[];
    expect(workers.every((w) => w.profile)).toBe(true);
  });
});
