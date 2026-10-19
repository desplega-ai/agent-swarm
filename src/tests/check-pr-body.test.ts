import { describe, expect, test } from "bun:test";
import {
  checkPrBody,
  isFixTitle,
  pickedChoices,
  prBodyWarnings,
  proseWordCount,
  riskLevel,
  templateLeadLines,
  templateSections,
} from "../../scripts/check-pr-body";

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

  test("headings inside HTML comments or still-open fences are not sections", () => {
    const hidden = "<!--\n## Intent\n-->\n````md\n```\n## Intent\n````\n";
    expect(checkPrBody(TEMPLATE, `${hidden}${URGENT}`, "feat: x")).toEqual([
      "missing section: ## Intent",
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

  test("picked choices are keyed by heading slug, and only valid picks count", () => {
    expect(pickedChoices(TEMPLATE, URGENT)).toEqual({ urgency: "nice to have" });
    expect(pickedChoices(TEMPLATE, "## Urgency\n- [x] asap\n- [x] nice to have\n")).toEqual({});
    expect(pickedChoices(TEMPLATE, "## Urgency\n- [x] tomorrow\n")).toEqual({});
    expect(pickedChoices(TEMPLATE, "## Intent\nx\n")).toEqual({});
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

  test("the real template fails unedited and passes once every part is filled", async () => {
    const template = await Bun.file(".github/pull_request_template.md").text();
    const leads = templateLeadLines(template);
    expect(leads).toEqual(["Why", "Risk"]);
    const sections = templateSections(template).filter((s) => s.when !== "optional");
    expect(sections.length).toBeGreaterThan(0);
    const all = { title: "fix: x", author: "desplega-bot", changedFiles: ["apps/ui/a.tsx"] };
    // Unknown risk keeps the outline required, so every section and lead line is reported.
    expect(checkPrBody(template, template, all)).toHaveLength(sections.length + leads.length);

    const filled = [
      "**Why:** because.",
      "**Risk:** medium",
      ...sections.map(
        (s) => `## ${s.heading}\n\n${s.choices.length ? `- [x] ${s.choices[0]}` : "filled"}\n`,
      ),
    ].join("\n");
    expect(checkPrBody(template, filled, all)).toEqual([]);
  });

  test("the real template's markers", async () => {
    const template = await Bun.file(".github/pull_request_template.md").text();
    const when = Object.fromEntries(templateSections(template).map((s) => [s.heading, s.when]));
    expect(when).toMatchObject({
      "Review map": "always",
      "Change outline": "outline",
      "Before / after": "ui",
      Repro: "fix",
      Urgency: "always",
      "Swarm provenance": "bot",
    });
  });
});

describe("check-pr-body: lead lines, risk and conditional sections", () => {
  const T = `<!-- top -->

**Why:** <!-- one sentence -->

**Risk:** <!-- low | medium | high -->

## Outline <!-- outline -->

<!-- g -->

## Before / after <!-- ui -->

<!-- g -->

## Swarm provenance <!-- bot -->

<!-- g -->
`;
  const human = { author: "octocat" };
  const leads = (risk: string) => `**Why:** It broke.\n\n**Risk:** ${risk}\n\n`;
  const outline = "## Outline\n\n```\n+ new\n```\n";

  test("lead lines are read from the template preamble", () => {
    expect(templateLeadLines(T)).toEqual(["Why", "Risk"]);
  });

  test("the Why and Risk lines are required and Risk must be a known level", () => {
    expect(checkPrBody(T, outline, human)).toEqual([
      "missing line: **Why:**",
      "missing line: **Risk:**",
    ]);
    expect(checkPrBody(T, `**Why:**\n**Risk:** <!-- x -->\n${outline}`, human)).toEqual([
      "empty line: **Why:**",
      "empty line: **Risk:**",
    ]);
    expect(checkPrBody(T, `${leads("spicy")}${outline}`, human)).toEqual([
      "**Risk:** must start with one of: low, medium, high",
    ]);
    expect(checkPrBody(T, `${leads("High (secrets)")}${outline}`, human)).toEqual([]);
  });

  test("a lead line after the first heading does not count", () => {
    expect(checkPrBody(T, `${outline}\n**Why:** x\n**Risk:** low\n`, human)).toContain(
      "missing line: **Why:**",
    );
  });

  test("riskLevel parses the first word only", () => {
    expect(riskLevel("**Risk:** high (secrets)")).toBe("high");
    expect(riskLevel("**Risk:** medium")).toBe("medium");
    expect(riskLevel("**Risk:** lowish")).toBeUndefined();
    expect(riskLevel("no risk line")).toBeUndefined();
  });

  test("the outline may be skipped only when Risk is low and the diff is small", () => {
    const missing = ["missing section: ## Outline"];
    expect(checkPrBody(T, leads("medium"), { ...human, changedLines: 3 })).toEqual(missing);
    expect(checkPrBody(T, leads("low"), { ...human, changedLines: 51 })).toEqual(missing);
    expect(checkPrBody(T, leads("low"), { ...human, changedLines: 50 })).toEqual([]);
    expect(checkPrBody(T, leads("low"), human)).toEqual([]);
  });

  test("Before / after is required only when the diff touches a UI app", () => {
    const body = `${leads("medium")}${outline}`;
    const missing = ["missing section: ## Before / after"];
    expect(checkPrBody(T, body, { ...human, changedFiles: ["apps/ui/src/App.tsx"] })).toEqual(
      missing,
    );
    expect(checkPrBody(T, body, { ...human, changedFiles: ["apps/templates-ui/x.ts"] })).toEqual(
      missing,
    );
    expect(checkPrBody(T, body, { ...human, changedFiles: ["src/apps/ui-thing.ts"] })).toEqual([]);
    expect(checkPrBody(T, body, human)).toEqual([]);
  });

  test("Swarm provenance is required for the bot and for a local run without an author", () => {
    const body = `${leads("medium")}${outline}`;
    const missing = ["missing section: ## Swarm provenance"];
    expect(checkPrBody(T, body, { author: "desplega-bot" })).toEqual(missing);
    expect(checkPrBody(T, body, {})).toEqual(missing);
    expect(checkPrBody(T, body, human)).toEqual([]);
    const withProvenance = `${body}\n## Swarm provenance\n- Task: link\n`;
    expect(checkPrBody(T, withProvenance, { author: "desplega-bot" })).toEqual([]);
  });
});

describe("check-pr-body: prose budget", () => {
  test("code fences, tables, details, comments, headings and URLs do not count", () => {
    const body = [
      "**Why:** three words here.",
      "## Review map",
      "| Area | Depth | Why |",
      "|---|---|---|",
      "```",
      "lots of code words here",
      "```",
      "<details>hidden words here</details>",
      "<!-- hidden comment words -->",
      "See https://example.com/a/b and #12.",
    ].join("\n");
    // "**Why:**", "three", "words", "here.", "See", "and". "#12." has no letter.
    expect(proseWordCount(body)).toBe(6);
  });

  test("a long body warns but never fails", () => {
    expect(prBodyWarnings("word ".repeat(300))).toEqual([]);
    expect(prBodyWarnings("word ".repeat(301))).toHaveLength(1);
  });
});
