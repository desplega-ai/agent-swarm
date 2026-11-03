import { describe, expect, test } from "bun:test";
import { nextRevealLength, REVEAL_MAX_LAG_MS, REVEAL_STEP_MS, revealStart } from "./reveal-text";

/** Every cut of `text` from `shown`, one step every 30 ms, until it shows in full. */
function cuts(text: string, shown = 0, msLeft = REVEAL_MAX_LAG_MS): number[] {
  const out: number[] = [];
  let length = shown;
  while (length < text.length) {
    length = nextRevealLength(text, length, msLeft);
    out.push(length);
    msLeft -= REVEAL_STEP_MS;
  }
  return out;
}

describe("nextRevealLength", () => {
  test("adds one word per step while there is time", () => {
    const text = "alpha beta gamma";
    expect(cuts(text).map((end) => text.slice(0, end))).toEqual([
      "alpha",
      "alpha beta",
      "alpha beta gamma",
    ]);
  });

  test("continues from the text already shown", () => {
    const text = "alpha beta gamma delta";
    expect(text.slice(0, nextRevealLength(text, "alpha beta".length, REVEAL_MAX_LAG_MS))).toBe(
      "alpha beta gamma",
    );
  });

  test("cuts only at the end of a word", () => {
    const text = "The build ran   twice.\n\nBoth runs passed, so the release can go out today.";
    for (const end of cuts(text).slice(0, -1)) {
      expect(text.charAt(end - 1)).toMatch(/\S/);
      expect(text.charAt(end)).toMatch(/\s/);
    }
  });

  test("takes more words per step when behind, so it ends before the lag limit", () => {
    const text = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(" ");
    const steps = cuts(text);
    expect(steps.at(-1)).toBe(text.length);
    expect(steps.length).toBeLessThanOrEqual(REVEAL_MAX_LAG_MS / REVEAL_STEP_MS);
    expect(text.slice(0, steps[0]).split(" ").length).toBe(8);
  });

  test("shows the whole text when no time is left", () => {
    const text = "alpha beta gamma";
    expect(nextRevealLength(text, 0, REVEAL_STEP_MS)).toBe(text.length);
    expect(nextRevealLength(text, 0, -500)).toBe(text.length);
  });

  test("keeps a markdown mark with the word after it", () => {
    const text = "Plan:\n- check the logs\n1. open the PR\n## Next\n> quoted";
    const shown = cuts(text).map((end) => text.slice(0, end));
    expect(shown).toContain("Plan:\n- check");
    expect(shown).toContain("Plan:\n- check the logs\n1. open");
    expect(shown).toContain("Plan:\n- check the logs\n1. open the PR\n## Next");
    for (const prefix of shown) expect(prefix).not.toMatch(/(^|\n)([-*+>#|]+|\d+[.)])$/);
  });

  test("a text with only spaces left shows in full", () => {
    expect(nextRevealLength("done  ", 4, REVEAL_MAX_LAG_MS)).toBe(6);
  });
});

describe("revealStart", () => {
  test("text that grew keeps all of the shown part", () => {
    expect(revealStart("Checking the", "Checking the logs now")).toBe("Checking the".length);
  });

  test("replaced text keeps only the whole words the two share", () => {
    expect(revealStart("Read the docs", "Read the files")).toBe("Read the".length);
    expect(revealStart("Running tests now", "Running tasks")).toBe("Running".length);
    expect(revealStart("Running tests", "Reading files")).toBe(0);
  });

  test("a shorter text that the shown part starts with shows in full", () => {
    expect(revealStart("Checking the logs", "Checking the")).toBe("Checking the".length);
  });
});
