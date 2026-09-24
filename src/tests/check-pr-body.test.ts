import { describe, expect, test } from "bun:test";
import { checkPrBody, isFixTitle, templateSections } from "../../scripts/check-pr-body";

const TEMPLATE = `<!-- top comment -->

## Intent

<!-- guidance -->

## Repro <!-- fix -->

<!-- guidance -->

## Urgency <!-- pick one -->

<!-- guidance -->

- [ ] asap
- [ ] nice to have

## Evidence <!-- optional -->

<!-- guidance -->
`;

const URGENT = "## Urgency\n- [ ] asap\n- [x] nice to have\n";

describe("check-pr-body", () => {
  test("template markers set when a section is required", () => {
    expect(templateSections(TEMPLATE)).toEqual([
      { heading: "Intent", when: "always", choices: [] },
      { heading: "Repro", when: "fix", choices: [] },
      { heading: "Urgency", when: "always", choices: ["asap", "nice to have"] },
      { heading: "Evidence", when: "optional", choices: [] },
    ]);
  });

  test("fix titles are detected by conventional-commit type", () => {
    expect(isFixTitle("fix: x")).toBe(true);
    expect(isFixTitle("fix(slack): x")).toBe(true);
    expect(isFixTitle("feat(ui): fix x")).toBe(false);
    expect(isFixTitle("fixup: x")).toBe(false);
  });

  test("a filled feature body passes without fix sections", () => {
    const body = `## intent\nBecause.\n\n${URGENT}\n## Notes\nextra\n`;
    expect(checkPrBody(TEMPLATE, body, "feat: x")).toEqual([]);
  });

  test("a fix title requires the fix sections", () => {
    const body = `## Intent\nBroken.\n\n${URGENT}`;
    expect(checkPrBody(TEMPLATE, body, "fix(api): x")).toEqual(["missing section: ## Repro"]);
    expect(checkPrBody(TEMPLATE, `${body}\n## Repro\nSee #1\n`, "fix(api): x")).toEqual([]);
  });

  test("urgency needs exactly one checked template choice", () => {
    const withUrgency = (urgency: string) => `## Intent\nx\n\n## Urgency\n${urgency}`;
    const problem = ["## Urgency: check exactly one of: asap, nice to have"];
    expect(checkPrBody(TEMPLATE, withUrgency("- [ ] asap\n- [ ] nice to have\n"))).toEqual(problem);
    expect(checkPrBody(TEMPLATE, withUrgency("- [x] asap\n- [X] nice to have\n"))).toEqual(problem);
    expect(checkPrBody(TEMPLATE, withUrgency("- [x] tomorrow\n"))).toEqual(problem);
    expect(checkPrBody(TEMPLATE, withUrgency("- [X] ASAP\n"))).toEqual([]);
  });

  test("an unedited template and an empty body fail", () => {
    expect(checkPrBody(TEMPLATE, TEMPLATE, "fix: x")).toEqual([
      "empty section: ## Intent",
      "empty section: ## Repro",
      "## Urgency: check exactly one of: asap, nice to have",
    ]);
    expect(checkPrBody(TEMPLATE, "")).toEqual([
      "missing section: ## Intent",
      "missing section: ## Urgency",
    ]);
  });

  test("a heading inside a code fence does not open a section", () => {
    const body = `## Intent\n\`\`\`md\n## Urgency\n- [x] asap\n\`\`\`\n`;
    expect(checkPrBody(TEMPLATE, body)).toEqual(["missing section: ## Urgency"]);
  });

  test("the real template fails unedited and passes once every section is filled", async () => {
    const template = await Bun.file(".github/pull_request_template.md").text();
    const sections = templateSections(template).filter((s) => s.when !== "optional");
    expect(sections.length).toBeGreaterThan(0);
    expect(checkPrBody(template, template, "fix: x")).toHaveLength(sections.length);

    const filled = sections
      .map((s) => `## ${s.heading}\n\n${s.choices.length ? `- [x] ${s.choices[0]}` : "filled"}\n`)
      .join("\n");
    expect(checkPrBody(template, filled, "fix: x")).toEqual([]);
  });
});
