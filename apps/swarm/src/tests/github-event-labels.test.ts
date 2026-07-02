import { describe, expect, test } from "bun:test";
import { GITHUB_EVENT_LABELS, isSwarmLabel } from "../github/mentions";

describe("isSwarmLabel", () => {
  test("default label 'swarm-review' matches", () => {
    expect(isSwarmLabel("swarm-review")).toBe(true);
  });

  test("case-insensitive matching", () => {
    expect(isSwarmLabel("Swarm-Review")).toBe(true);
    expect(isSwarmLabel("SWARM-REVIEW")).toBe(true);
  });

  test("non-matching labels return false", () => {
    expect(isSwarmLabel("bug")).toBe(false);
    expect(isSwarmLabel("enhancement")).toBe(false);
    expect(isSwarmLabel("")).toBe(false);
  });

  test("GITHUB_EVENT_LABELS is populated", () => {
    expect(GITHUB_EVENT_LABELS.length).toBeGreaterThan(0);
    expect(GITHUB_EVENT_LABELS).toContain("swarm-review");
  });
});
