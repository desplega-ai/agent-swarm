import { describe, expect, test } from "bun:test";
import { DEFAULT_PASS_THRESHOLD } from "../src/scoring.ts";
import { GRADER_FIXTURES } from "./grader-fixtures/index.ts";
import { gradeOffline, nullContext } from "./grader-validation-support.ts";
import { scenarios } from "./index.ts";

/**
 * Grader validation (swarm-evals plan v2, Phase 3 section 2). A grader is only
 * trustworthy if a do-nothing agent cannot pass it and a correct solution
 * cannot fail it; the outside view treats an always-failing scenario as a grader
 * bug until a human solves it. Both properties are checked per registered
 * scenario, offline, through the runner's own scoring primitives
 * (`gradeOffline`). Only LLM-judge dimensions are stubbed.
 *
 *   null agent  - tasks `completed`, empty result, no files, no logs, empty API.
 *                 With an honest judge (0) it must score below the pass line and
 *                 fail at least one scenario gate; even with a judge that gives
 *                 full marks (1) it must not pass, so the gates hold the line.
 *   reference   - the context a correct solution leaves behind, built from the
 *                 scenario's answer key. It must pass with every gate green.
 *
 * Judge quality itself (does an LLM judge score a real transcript sensibly) is
 * not testable offline; that stays a sampled manual check per scenario.
 */

describe("grader validation", () => {
  test("every registered scenario has a grader fixture, and no fixture is orphaned", () => {
    const registered = scenarios.map((s) => s.id).sort();
    expect(Object.keys(GRADER_FIXTURES).sort()).toEqual(registered);
  });

  for (const scenario of scenarios) {
    describe(scenario.id, () => {
      const fixture = GRADER_FIXTURES[scenario.id];

      test("the reference solution passes with every gate green", async () => {
        if (!fixture) throw new Error(`no grader fixture for ${scenario.id}`);
        const grade = await gradeOffline({
          scenario,
          ctx: fixture.reference(),
          upfrontTasks: fixture.referenceUpfrontTasks?.(),
          judgeScore: 1,
        });
        expect({
          failedGates: grade.gates.filter((g) => !g.pass),
          passed: grade.passed,
        }).toEqual({ failedGates: [], passed: true });
        expect(grade.score).toBeGreaterThanOrEqual(DEFAULT_PASS_THRESHOLD);
      });

      test("a null agent scores below the pass line and fails a scenario gate", async () => {
        if (!fixture) throw new Error(`no grader fixture for ${scenario.id}`);
        const grade = await gradeOffline({
          scenario,
          ctx: fixture.nullContext?.() ?? nullContext(scenario),
          judgeScore: 0,
        });
        expect(grade.score).toBeLessThan(DEFAULT_PASS_THRESHOLD);
        expect(grade.passed).toBe(false);
        expect(grade.failedScenarioGates.length).toBeGreaterThanOrEqual(1);
      });

      test("a null agent cannot pass even when the judge gives full marks", async () => {
        if (!fixture) throw new Error(`no grader fixture for ${scenario.id}`);
        const grade = await gradeOffline({
          scenario,
          ctx: fixture.nullContext?.() ?? nullContext(scenario),
          judgeScore: 1,
        });
        expect(grade.passed).toBe(false);
      });
    });
  }
});
