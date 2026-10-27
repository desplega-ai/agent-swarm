import { describe, expect, test } from "bun:test";
import { ONBOARDING_STEPS, visibleOnboardingSteps } from "./visible-onboarding-steps";

const todo = { status: "todo", at: null, method: null, errorClass: null };
const allSteps = Object.fromEntries(ONBOARDING_STEPS.map(({ id }) => [id, todo]));
const { files: _files, ...withoutFiles } = allSteps;
const ids = (steps: ReadonlyArray<{ id: string }>) => steps.map(({ id }) => id);

describe("visibleOnboardingSteps", () => {
  test("Comb on and an API that knows the step: files shows before first_task", () => {
    const steps = visibleOnboardingSteps({ steps: allSteps }, { files: { enabled: true } });
    expect(ids(steps)).toEqual([
      "connect",
      "name",
      "ai",
      "agents",
      "memory",
      "integrations",
      "files",
      "first_task",
    ]);
  });

  test("an API without the files step hides it, even with a files signal", () => {
    const steps = visibleOnboardingSteps({ steps: withoutFiles }, { files: { enabled: true } });
    expect(ids(steps)).not.toContain("files");
    expect(steps).toHaveLength(7);
  });

  test("an API without the files signal hides it", () => {
    expect(ids(visibleOnboardingSteps({ steps: allSteps }, {}))).not.toContain("files");
  });

  test("Comb off hides files", () => {
    const steps = visibleOnboardingSteps({ steps: allSteps }, { files: { enabled: false } });
    expect(ids(steps)).not.toContain("files");
    expect(ids(steps).at(-1)).toBe("first_task");
  });

  test("no payload yet: the always-on steps only", () => {
    expect(ids(visibleOnboardingSteps(null, null))).toEqual(ids(withoutFilesList()));
  });

  test("the same list returns the same array", () => {
    const a = visibleOnboardingSteps({ steps: allSteps }, { files: { enabled: true } });
    const b = visibleOnboardingSteps({ steps: { ...allSteps } }, { files: { enabled: true } });
    expect(a).toBe(b);
  });
});

function withoutFilesList() {
  return ONBOARDING_STEPS.filter(({ id }) => id !== "files");
}
