import { describe, expect, mock, test } from "bun:test";
import { USE_CASES } from "../../../../lib/company-profile";

// Bun does not read the `@/` alias of tsconfig.app.json: stand in for the session view.
mock.module("@/components/sessions/new-session-view", () => ({ SUGGESTIONS: ["General idea"] }));
const { firstTaskStarters } = await import("./starters");

const AGENTS = [
  "Coder",
  "Content Reviewer",
  "Content Strategist",
  "Content Writer",
  "Discoverability Optimizer",
  "Forward Deployed Engineer",
  "Researcher",
  "Reviewer",
  "Tester",
];

describe("firstTaskStarters", () => {
  test("no use case falls back to the general suggestions", () => {
    expect(firstTaskStarters(null)).toEqual(["General idea"]);
  });

  test("every use case has 3 starters, and the first hands work between agents", () => {
    for (const { value } of USE_CASES) {
      for (const profile of [
        { company: null, website: null },
        { company: "Acme", website: "acme.com" },
      ]) {
        const starters = firstTaskStarters(value, profile);
        expect(starters).toHaveLength(3);
        expect(starters[0]).toStartWith("Have the ");
        expect(starters[0]).toContain(", then the ");
        expect(AGENTS.some((agent) => starters[0].includes(`the ${agent} `))).toBe(true);
        expect(starters.join(" ")).not.toContain("null");
      }
    }
  });

  test("the first starter uses the website and company name when they exist", () => {
    const profile = { company: "Acme", website: "acme.com" };
    expect(firstTaskStarters("research", profile)[0]).toBe(
      "Have the Researcher compare the 3 closest competitors to acme.com, then the Content Writer turn it into a one-page brief",
    );
    expect(firstTaskStarters("content", profile)[0]).toContain("read acme.com");
    expect(firstTaskStarters("content", profile)[0]).toContain("for Acme");
    expect(firstTaskStarters("seo", { company: null, website: null })[0]).not.toContain("audit");
  });
});
