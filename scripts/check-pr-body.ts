#!/usr/bin/env bun
/**
 * Check that a PR body fills every required section of the PR template.
 *
 * The template is the single source of truth. Every `## ` heading is a
 * required section. An HTML comment on the heading line changes the rule:
 *   `<!-- optional -->`  the section may be deleted.
 *   `<!-- fix -->`       required only when the PR title is `fix: ...` or `fix(scope): ...`.
 *   `<!-- pick one -->`  the body must check exactly one of the template's `- [ ]` items.
 * Any other required section counts as filled when its text, with HTML comments
 * removed, is not blank. Keep template guidance inside HTML comments so an
 * unedited template fails.
 *
 * Usage:
 *   bun scripts/check-pr-body.ts --title "fix(slack): ..." --body-file /tmp/pr-body.md
 *   PR_TITLE="..." PR_BODY="..." bun scripts/check-pr-body.ts
 *
 * CI: `.github/workflows/pr-body.yml` passes PR_TITLE and PR_BODY. On success,
 * each picked choice is written to GITHUB_OUTPUT (for example `urgency=asap`).
 */

import { appendFileSync } from "node:fs";

const TEMPLATE_PATH = ".github/pull_request_template.md";

type Section = { heading: string; flags: string[]; content: string };

export type TemplateSection = {
  heading: string;
  when: "always" | "optional" | "fix";
  /** The allowed `- [ ]` items when the section is marked `pick one`, else empty. */
  choices: string[];
};

const COMMENT = /<!--([\s\S]*?)-->/g;
const stripComments = (text: string) => text.replace(COMMENT, "");
const normalize = (text: string) => stripComments(text).trim().replace(/\s+/g, " ").toLowerCase();
const checkboxes = (content: string, checked: boolean) =>
  [...stripComments(content).matchAll(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/gm)]
    .filter((m) => (m[1] !== " ") === checked)
    .map((m) => normalize(m[2] ?? ""));

export const isFixTitle = (title: string) => /^fix(\([^)]*\))?!?:/i.test(title.trim());

/** Split markdown into level-1/level-2 sections. Headings inside code fences do not count. */
function parseSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  let inFence = false;
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = inFence ? null : /^#{1,2}\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      const raw = match[1] ?? "";
      const flags = [...raw.matchAll(COMMENT)].map((m) => normalize(m[1] ?? ""));
      current = { heading: stripComments(raw).trim(), flags, content: "" };
      sections.push(current);
    } else if (current) {
      current.content += `${line}\n`;
    }
  }
  return sections;
}

export function templateSections(template: string): TemplateSection[] {
  return parseSections(template).map((s) => ({
    heading: s.heading,
    when: s.flags.includes("optional") ? "optional" : s.flags.includes("fix") ? "fix" : "always",
    choices: s.flags.includes("pick one") ? checkboxes(s.content, false) : [],
  }));
}

/** Returns one problem per missing, empty, or badly filled section. An empty list means the body passes. */
export function checkPrBody(template: string, body: string, title = ""): string[] {
  const bodySections = parseSections(body);
  const problems: string[] = [];
  for (const section of templateSections(template)) {
    if (section.when === "optional" || (section.when === "fix" && !isFixTitle(title))) continue;
    const found = bodySections.find((s) => normalize(s.heading) === normalize(section.heading));
    const name = `## ${section.heading}`;
    if (!found) {
      problems.push(`missing section: ${name}`);
    } else if (section.choices.length > 0) {
      const picked = checkboxes(found.content, true);
      if (picked.length !== 1 || !section.choices.includes(picked[0] ?? "")) {
        problems.push(`${name}: check exactly one of: ${section.choices.join(", ")}`);
      }
    } else if (!stripComments(found.content).trim()) {
      problems.push(`empty section: ${name}`);
    }
  }
  return problems;
}

/**
 * The checked choice of each `pick one` section, keyed by heading slug (`## Urgency` -> `urgency`).
 * Sections without exactly one valid checked choice are left out.
 */
export function pickedChoices(template: string, body: string): Record<string, string> {
  const bodySections = parseSections(body);
  const picked: Record<string, string> = {};
  for (const section of templateSections(template)) {
    if (section.choices.length === 0) continue;
    const found = bodySections.find((s) => normalize(s.heading) === normalize(section.heading));
    const checked = found ? checkboxes(found.content, true) : [];
    if (checked.length === 1 && section.choices.includes(checked[0] ?? "")) {
      const key = normalize(section.heading)
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      picked[key] = checked[0] ?? "";
    }
  }
  return picked;
}

if (import.meta.main) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const bodyFile = arg("--body-file");
  const body = bodyFile ? await Bun.file(bodyFile).text() : (process.env.PR_BODY ?? "");
  const title = arg("--title") ?? process.env.PR_TITLE;
  const template = await Bun.file(TEMPLATE_PATH).text();

  if (title === undefined) {
    console.warn("No PR title given (--title or PR_TITLE). Sections for fix PRs were not checked.");
  }
  const problems = checkPrBody(template, body, title ?? "");
  if (problems.length === 0) {
    console.log("PR body has every required section of the template.");
    // Expose each picked choice (for example urgency=asap) to later workflow jobs.
    const outputFile = process.env.GITHUB_OUTPUT;
    if (outputFile) {
      const lines = Object.entries(pickedChoices(template, body)).map(([k, v]) => `${k}=${v}\n`);
      appendFileSync(outputFile, lines.join(""));
    }
    process.exit(0);
  }

  console.error(`PR body does not match ${TEMPLATE_PATH}:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\nSections, in order:");
  for (const s of templateSections(template)) {
    const rule = { always: "", optional: " (optional)", fix: " (required for fix: titles)" }[
      s.when
    ];
    console.error(`  ## ${s.heading}${rule}`);
  }
  console.error(
    "\nEdit the PR title or description to fix this (no push needed). Guidance for each section is in the template.",
  );
  process.exit(1);
}
