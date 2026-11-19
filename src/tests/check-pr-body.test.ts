import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPrBody,
  isFixTitle,
  leadChoices,
  pendingPrBodyProblems,
  pickedChoices,
  prBodyWarnings,
  proseWordCount,
  riskLevel,
  templateLeadLines,
  templateSections,
} from "../../scripts/check-pr-body";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc";

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
    expect(leads).toEqual(["Why", "Risk", "Urgency"]);
    const sections = templateSections(template).filter((s) => s.when !== "optional");
    expect(sections.length).toBeGreaterThan(0);
    // A date after the template's warn-only window, so that every rule applies.
    const all = { title: "fix: x", author: "desplega-bot", today: "2099-01-01" };
    // Unknown risk keeps the outline required, so every section and lead line is reported.
    expect(checkPrBody(template, template, all)).toHaveLength(sections.length + leads.length);

    const filled = [
      "**Why:** because.",
      "**Risk:** medium",
      "**Urgency:** nice to have",
      ...sections.map(
        (s) =>
          `## ${s.heading}\n\n${s.when === "evidence" ? "```diff\n+ new\n```" : s.when === "bot" ? "- [Task](https://example.com/task)" : s.choices.length ? `- [x] ${s.choices[0]}` : "- On main: it fails. filled"}\n`,
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
      "Before / after": "evidence",
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

  test("Swarm provenance is required for the bot and for a local run without an author", () => {
    const body = `${leads("medium")}${outline}`;
    const missing = ["missing section: ## Swarm provenance"];
    expect(checkPrBody(T, body, { author: "desplega-bot" })).toEqual(missing);
    expect(checkPrBody(T, body, {})).toEqual(missing);
    expect(checkPrBody(T, body, human)).toEqual([]);
    const withProvenance = `${body}\n## Swarm provenance\n- [Task](https://example.com/task)\n`;
    expect(checkPrBody(T, withProvenance, { author: "desplega-bot" })).toEqual([]);
  });
});

describe("check-pr-body: evidence", () => {
  const template = "## Proof <!-- evidence -->";
  test("evidence is always required and prose alone fails", () => {
    expect(templateSections(template)).toEqual([
      { heading: "Proof", when: "evidence", choices: [] },
    ]);
    expect(checkPrBody(template, "")).toEqual(["missing section: ## Proof"]);
    for (const text of [
      "",
      "I tested it.",
      "<!-- ``` -->",
      "No visible change:",
      "No visual change:   ",
      // Shapes with nothing in them are not evidence.
      "```\n```",
      "```diff\n   \n```",
      "| Before | After |\n|---|---|",
      "<img>",
      '<img alt="x">',
      "![alt]()",
      "Before: it failed.",
    ]) {
      expect(checkPrBody(template, `## Proof\n${text}`)).toEqual([
        '## Proof: show a snippet, a table with a data row, an image or a video, write "Before: ... After: ...", or write "No visible change: <reason>"',
      ]);
    }
  });
  test.each([
    "```diff\n+ new\n```",
    "~~~text\nafter\n~~~",
    "| Before | After |\n|---|---|\n| a | b |",
    "![after](https://example.com/image.png)",
    '<img src="https://example.com/a.png">',
    '<video src="https://example.com/clip"></video>',
    "https://example.com/a.mp4",
    "https://example.com/a.mov",
    "https://example.com/a.webm",
    "https://github.com/user-attachments/assets/abc",
    "No visible change: internal refactor.",
    "NO VISUAL CHANGE: internal refactor.",
    "Before: no setup guide. After: the guide covers eight clients.",
    "Before: 201\nAfter: 400",
  ])("accepts evidence: %s", (text) => {
    expect(checkPrBody(template, `## Proof\n${text}`)).toEqual([]);
  });
});

describe("check-pr-body: lead choices", () => {
  const template =
    "**Schedule:** <!-- one of: asap | this week | nice to have --> <!-- guidance -->";
  test("a choice is an exact value, with an optional reason in parentheses", () => {
    for (const value of ["ASAP", "this week (requested)", "**nice to have**", "`asap`"]) {
      expect(checkPrBody(template, `**Schedule:** ${value}`)).toEqual([]);
    }
    // Free text after the value must not pick a choice: the value routes a review.
    for (const value of [
      "asapish",
      "tomorrow",
      "asap - actually nice to have",
      "nice to have, please",
    ]) {
      expect(checkPrBody(template, `**Schedule:** ${value}`)).toEqual([
        "**Schedule:** must be one of: asap, this week, nice to have (a reason in parentheses may follow)",
      ]);
      expect(leadChoices(template, `**Schedule:** ${value}`)).toEqual({});
    }
    expect(checkPrBody(template, "")).toEqual(["missing line: **Schedule:**"]);
    expect(checkPrBody(template, "**Schedule:** <!-- g -->")).toEqual([
      "empty line: **Schedule:**",
    ]);
  });
  test("old checkbox sections provide a transition only when the lead is missing", () => {
    const body = "## Schedule\n- [ ] asap\n- [x] THIS WEEK";
    expect(checkPrBody(template, body)).toEqual([]);
    expect(leadChoices(template, body)).toEqual({ schedule: "this week" });
    for (const checks of ["- [x] tomorrow", "- [x] asap\n- [x] this week", "- [x] asap (please)"]) {
      expect(checkPrBody(template, `## Schedule\n${checks}`)).toEqual([
        "missing line: **Schedule:**",
      ]);
      expect(leadChoices(template, `## Schedule\n${checks}`)).toEqual({});
    }
    expect(checkPrBody(template, `**Schedule:** invalid\n${body}`)).toHaveLength(1);
  });
  test("leadChoices returns valid canonical values and ignores guidance", () => {
    expect(leadChoices(template, "**Schedule:** ASAP (requested)")).toEqual({ schedule: "asap" });
    expect(leadChoices(template, "**Schedule:** asapish")).toEqual({});
    expect(leadChoices("**Why:** <!-- low | high -->", "**Why:** low")).toEqual({});
    expect(checkPrBody("<!--\n**Hidden:** guidance\n-->\n**Why:**", "**Why:** reason")).toEqual([]);
  });
});

describe("check-pr-body: bot content", () => {
  const template = "## Links <!-- bot --> <!-- link: Task -->";
  const LINKS_ONLY =
    "## Links: links only, each as [label](url). Move other text to another section";
  const TASK = "## Links: link the task as [Task](url)";
  test.each([
    "desplega-bot",
    "someone",
    undefined,
  ])("validates present content for %s", (author) => {
    const ctx = { author };
    const bot = author !== "someone";
    const task = bot ? [TASK] : [];
    // One problem per root cause: a bare URL does not also report prose.
    expect(
      checkPrBody(template, "## Links\n- https://example.com/a\n* https://example.com/b", ctx),
    ).toEqual(["## Links: write each link as [label](url), not as a bare URL"]);
    // The old "Label: url" form is one root cause, so it gives one problem line.
    expect(
      checkPrBody(
        template,
        "## Links\n- Task: https://example.com/a · tree: https://example.com/b\n- Plan / research: https://example.com/c",
        ctx,
      ),
    ).toEqual(["## Links: write each link as [label](url), not as a bare URL"]);
    // Other text is still reported next to a bare URL.
    expect(
      checkPrBody(
        template,
        "## Links\n- Task: https://example.com/a\n\nSkipped/risk: untested.",
        ctx,
      ),
    ).toEqual(["## Links: write each link as [label](url), not as a bare URL", LINKS_ONLY]);
    expect(
      checkPrBody(template, "## Links\n[Task](https://example.com/a)\nMore text", ctx),
    ).toEqual([LINKS_ONLY]);
    // Prose inside a list item, after its link.
    expect(
      checkPrBody(template, "## Links\n- [CI](https://example.com) Task link kept elsewhere.", ctx),
    ).toEqual([LINKS_ONLY, ...task]);
    expect(checkPrBody(template, "## Links\n- Task pending", ctx)).toEqual([LINKS_ONLY, ...task]);
    // Another label is not the task, for the bot.
    expect(checkPrBody(template, "## Links\n- [Workflow run](https://example.com/w)", ctx)).toEqual(
      task,
    );
    for (const ok of [
      "- [Task](https://example.com/a) · [tree](https://example.com/b)",
      "  - [task](https://example.com/a)",
      "1. [Task](https://example.com/a)\n2. [Ask](https://example.com/b)",
      "[Task](https://example.com/a)",
      "<details><summary>Links https://example.com/hidden</summary>\n\n- [Task](https://example.com/a)\n* [Tree](https://example.com/b)\n\n</details><!-- ignored https://example.com/c -->",
    ]) {
      expect(checkPrBody(template, `## Links\n${ok}`, ctx)).toEqual([]);
    }
  });
  test("without a link marker, no label is required", () => {
    expect(
      checkPrBody("## Links <!-- bot -->", "## Links\n- [Run](https://example.com/w)", {
        author: "desplega-bot",
      }),
    ).toEqual([]);
  });
});

describe("check-pr-body: fix control", () => {
  const template = "## Checked <!-- fix mentions: main -->";
  const problem = [
    '## Checked: for a fix, show the control on "main" (the failure before the fix)',
  ];
  test("a fix title needs the word in the section", () => {
    expect(checkPrBody(template, "## Checked\n- done", "fix: x")).toEqual(problem);
    expect(
      checkPrBody(template, "## Checked\n- On main@abc: `cmd` → fails", "fix(api): x"),
    ).toEqual([]);
    expect(checkPrBody(template, "## Checked\n- tests pass\n- On MAIN it fails", "fix: x")).toEqual(
      [],
    );
    // "remains" does not contain the word "main".
    expect(checkPrBody(template, "## Checked\n- the bug remains", "fix: x")).toEqual(problem);
  });
  test("other titles are not checked", () => {
    expect(checkPrBody(template, "## Checked\n- done", "feat: x")).toEqual([]);
  });
});

describe("check-pr-body: marker warnings", () => {
  test("lead word limits warn only above the limit", () => {
    const template = "**Reason:** <!-- max words: 2 -->";
    expect(prBodyWarnings("**Reason:** one two <!-- three -->", template)).toEqual([]);
    expect(prBodyWarnings("**Reason:** one two three", template)).toEqual([
      "**Reason:** has 3 words. Target: 2 or fewer",
    ]);
  });
  test("table row limits exclude headers and separators", () => {
    const template = "## Data <!-- max rows: 1 -->";
    const body = "## Data\n| A | B |\n|:---|---:|\n| a | b |";
    expect(prBodyWarnings(body, template)).toEqual([]);
    expect(prBodyWarnings(`${body}\n| c | d |`, template)).toEqual([
      "## Data: 2 table rows. Target: 1 or fewer",
    ]);
  });
  test("bullet limits exclude details, nested items, comments and code", () => {
    const template = "## Notes <!-- max bullets: 1 -->";
    const body =
      "## Notes\n- first\n  - nested\n<details open>\n- hidden\n</details>\n<!-- - guidance -->\n```\n- code\n```";
    expect(prBodyWarnings(body, template)).toEqual([]);
    expect(prBodyWarnings(`${body}\n* second`, template)).toEqual([
      "## Notes: 2 bullets. Target: 1 or fewer",
    ]);
  });
  test("code limits count fenced lines across fence styles", () => {
    const template = "## Code <!-- max code lines: 2 -->";
    const body = "## Code\n````md\n```\n````\n~~~\nsecond\n~~~";
    expect(prBodyWarnings(body, template)).toEqual([]);
    expect(prBodyWarnings(`${body}\n\`\`\`\nthird\n\`\`\``, template)).toEqual([
      "## Code: 3 code lines. Target: 2 or fewer",
    ]);
  });
  test("presigned links warn only with a template", () => {
    const body = "https://example.com/a?X-Amz-Signature=abc";
    expect(prBodyWarnings(body, "")).toEqual([
      "a presigned link expires. Use a GitHub attachment for images and videos",
    ]);
    expect(prBodyWarnings("https://example.com/a", "")).toEqual([]);
    expect(prBodyWarnings(body)).toEqual([]);
    expect(prBodyWarnings(`${body} ${"word ".repeat(201)}`)).toHaveLength(1);
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

  test("a long body warns above the target and fails above the limit", () => {
    expect(prBodyWarnings("word ".repeat(200))).toEqual([]);
    expect(prBodyWarnings("word ".repeat(201))).toHaveLength(1);
    expect(checkPrBody("", "word ".repeat(300))).toEqual([]);
    // Above the limit the failure replaces the warning.
    expect(prBodyWarnings("word ".repeat(301))).toEqual([]);
    expect(checkPrBody("", "word ".repeat(301))).toEqual([
      "about 301 prose words. Limit: 300. Move detail into a code block, a table or <details>",
    ]);
  });
  test("a lead line warns above its target and fails above its hard limit", () => {
    const template = "**Why:** <!-- max words: 3 --> <!-- hard max words: 5 -->";
    const why = (n: number) => `**Why:** ${"word ".repeat(n)}`;
    expect(checkPrBody(template, why(5))).toEqual([]);
    expect(prBodyWarnings(why(5), template)).toEqual(["**Why:** has 5 words. Target: 3 or fewer"]);
    expect(checkPrBody(template, why(6))).toEqual(["**Why:** has 6 words. Limit: 5 (target 3)"]);
    expect(prBodyWarnings(why(6), template)).toEqual([]);
  });
});

describe("check-pr-body: warn-only window", () => {
  const template = [
    "<!-- new rules fail from: 2026-11-26 -->",
    "**Why:** <!-- hard max words: 2 -->",
    "## Proof <!-- evidence -->",
    "## Links <!-- bot --> <!-- link: Task -->",
    "## Checked <!-- fix mentions: main -->",
  ].join("\n");
  const body = "**Why:** one two three\n## Links\n- https://example.com/a\n## Checked\n- done";
  const fresh = [
    "**Why:** has 3 words. Limit: 2",
    "missing section: ## Proof",
    "## Links: write each link as [label](url), not as a bare URL",
    '## Checked: for a fix, show the control on "main" (the failure before the fix)',
  ];
  const ctx = (today: string) => ({ title: "fix: x", author: "desplega-bot", today });
  test("before the date the newer rules only warn", () => {
    expect(checkPrBody(template, body, ctx("2026-11-25"))).toEqual([]);
    expect(pendingPrBodyProblems(template, body, ctx("2026-11-25"))).toEqual({
      from: "2026-11-26",
      problems: fresh,
    });
  });
  test("from the date they fail, and nothing is pending", () => {
    expect(checkPrBody(template, body, ctx("2026-11-26"))).toEqual(fresh);
    expect(pendingPrBodyProblems(template, body, ctx("2026-11-26"))).toBeUndefined();
  });
  test("the older rules fail inside the window too", () => {
    expect(
      checkPrBody(template, "## Proof\n```\nx\n```\n## Checked\n- main", ctx("2026-11-25")),
    ).toEqual(["missing line: **Why:**", "missing section: ## Links"]);
  });
  test("a template without the line has no window", () => {
    const always = template.split("\n").slice(1).join("\n");
    expect(checkPrBody(always, body, ctx("2020-01-01"))).toEqual(fresh);
    expect(pendingPrBodyProblems(always, body, ctx("2020-01-01"))).toBeUndefined();
  });
});

describe("check-pr-body: PR_TEMPLATE_PATH", () => {
  // The org-wide check (desplega-ai/.github) runs this script against another
  // repo's template or the org default, so the CLI must honor the override.
  test(
    "the CLI checks the body against the template the env names",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "pr-body-template-"));
      try {
        const templatePath = join(dir, "template.md");
        const bodyPath = join(dir, "body.md");
        await Bun.write(templatePath, "## Only section\n\n<!-- guidance -->\n");
        await Bun.write(bodyPath, "## Only section\n\nFilled.\n");
        const run = (env: Record<string, string>) =>
          runChild(["bun", "scripts/check-pr-body.ts", "--body-file", bodyPath], {
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              PR_TITLE: "chore: x",
              PR_AUTHOR: "someone",
              ...env,
            },
          });

        const custom = await run({ PR_TEMPLATE_PATH: templatePath });
        expect(custom.stderr).not.toContain("does not match");
        expect(custom.exitCode).toBe(0);

        // Control: without the override, the repo template applies and this body fails it.
        const repoDefault = await run({});
        expect(repoDefault.exitCode).toBe(1);
        expect(repoDefault.stderr).toContain("does not match .github/pull_request_template.md");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});

describe("check-pr-body: PR_BODY_PROBLEMS_FILE", () => {
  // pr-body-comment.yml posts this file as the fork PR comment.
  test(
    "a failing body writes its problems as a Markdown list; a passing body writes nothing",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "pr-body-problems-"));
      try {
        const templatePath = join(dir, "template.md");
        const bodyPath = join(dir, "body.md");
        const problemsPath = join(dir, "problems.md");
        await Bun.write(
          templatePath,
          "**Why:** <!-- one line -->\n\n## Only section\n\n<!-- guidance -->\n",
        );
        const run = (body: string) =>
          Bun.write(bodyPath, body).then(() =>
            runChild(["bun", "scripts/check-pr-body.ts", "--body-file", bodyPath], {
              env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                PR_TITLE: "chore: x",
                PR_AUTHOR: "someone",
                PR_TEMPLATE_PATH: templatePath,
                PR_BODY_PROBLEMS_FILE: problemsPath,
              },
            }),
          );

        const failing = await run("## Summary\n\nWrote my own headings.\n");
        expect(failing.exitCode).toBe(1);
        expect(await Bun.file(problemsPath).text()).toBe(
          "- missing line: **Why:**\n- missing section: ## Only section\n",
        );

        await rm(problemsPath);
        const passing = await run("**Why:** reason.\n\n## Only section\n\nFilled.\n");
        expect(passing.exitCode).toBe(0);
        expect(await Bun.file(problemsPath).exists()).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});

describe("check-pr-body: CLI outputs", () => {
  test(
    "writes lead choices, section picks and risk while warnings do not fail",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "prb-output-"));
      try {
        const templatePath = join(dir, "template.txt");
        const bodyPath = join(dir, "body.txt");
        const outputPath = join(dir, "output.txt");
        await Bun.write(
          templatePath,
          "**Why:** <!-- max words: 1 -->\n**Risk:**\n**Urgency:** <!-- one of: asap | later -->\n## Mode <!-- pick one -->\n- [ ] quick",
        );
        for (const urgency of ["**Urgency:** ASAP", "## Urgency\n- [x] asap"]) {
          await Bun.write(outputPath, "");
          await Bun.write(
            bodyPath,
            `**Why:** two words\n**Risk:** low\n${urgency}\n## Mode\n- [x] quick`,
          );
          const result = await runChild(
            [
              "bun",
              "scripts/check-pr-body.ts",
              "--title",
              "feat: x",
              "--body-file",
              bodyPath,
              "--author",
              "someone",
            ],
            {
              env: {
                PATH: process.env.PATH,
                PR_TEMPLATE_PATH: templatePath,
                GITHUB_OUTPUT: outputPath,
              },
            },
          );
          expect(result.exitCode).toBe(0);
          expect(result.stderr).toContain("**Why:** has 2 words. Target: 1 or fewer");
          expect(await Bun.file(outputPath).text()).toBe("mode=quick\nurgency=asap\nrisk=low\n");
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
