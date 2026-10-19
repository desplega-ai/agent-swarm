#!/usr/bin/env bun
/**
 * Check that a PR body fills every required part of the PR template.
 *
 * The template is the single source of truth.
 *
 * Lead lines: every `**Label:**` line before the first heading is required and
 * must carry text once HTML comments are removed. `**Risk:**` must start with
 * one of `RISK_LEVELS`.
 *
 * Sections: every `## ` heading is a required section. An HTML comment on the
 * heading line changes the rule:
 *   `<!-- optional -->`  the section may be deleted.
 *   `<!-- fix -->`       required only when the PR title is `fix: ...` or `fix(scope): ...`.
 *   `<!-- ui -->`        required only when a changed file is under a `UI_PATHS` prefix.
 *   `<!-- bot -->`       required only when the author is desplega-bot (or unknown: a local run).
 *   `<!-- outline -->`   required unless Risk is low and the diff is `SMALL_DIFF_LINES` or fewer.
 *   `<!-- pick one -->`  the body must check exactly one of the template's `- [ ]` items.
 * Any other required section counts as filled when its text, with HTML comments
 * removed, is not blank. Keep template guidance inside HTML comments so an
 * unedited template fails.
 *
 * Prose budget: above `PROSE_WORD_WARN` prose words (code fences, tables,
 * `<details>`, comments and headings excluded) the check warns. It never fails on length.
 *
 * Bot-authored bodies also get the leak check (`src/utils/pr-body-leaks.ts`):
 * no Slack ids, private-chat quotes, and no task, dashboard, agent-fs or Slack
 * links outside `## Swarm provenance`. It runs when the author is desplega-bot,
 * or when no author is given (a local run). External contributors are never leak-checked.
 *
 * Usage:
 *   bun scripts/check-pr-body.ts --title "fix(slack): ..." --body-file /tmp/pr-body.md
 *   PR_TITLE="..." PR_BODY="..." PR_AUTHOR="..." bun scripts/check-pr-body.ts
 * Optional: `--changed-files-file <file>` / PR_CHANGED_FILES_FILE (one path per
 * line; a local run without it uses `git diff` against origin/main) and
 * `--changed-lines <n>` / PR_CHANGED_LINES (additions + deletions).
 *
 * CI: `.github/workflows/pr-body.yml` passes the env above. On success, each
 * picked choice and the risk level are written to GITHUB_OUTPUT (for example
 * `urgency=asap`, `risk=high`).
 */

import { appendFileSync } from "node:fs";
import {
  findPrBodyLeaks,
  isSwarmBotLogin,
  markdownHeadings,
  stripFencedCode,
} from "../src/utils/pr-body-leaks";

const TEMPLATE_PATH = ".github/pull_request_template.md";

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type Risk = (typeof RISK_LEVELS)[number];
export const UI_PATHS = ["apps/ui/", "apps/templates-ui/"];
export const SMALL_DIFF_LINES = 50;
export const PROSE_WORD_WARN = 300;

type Section = { heading: string; flags: string[]; content: string };

export type TemplateSection = {
  heading: string;
  when: "always" | "optional" | "fix" | "ui" | "bot" | "outline";
  /** The allowed `- [ ]` items when the section is marked `pick one`, else empty. */
  choices: string[];
};

/** What the check knows about the PR besides its body. Unknown fields relax nothing except as noted. */
export type PrContext = {
  title?: string;
  /** GitHub login. Unknown counts as the swarm bot, as for the leak check. */
  author?: string;
  /** Changed file paths. Unknown: `<!-- ui -->` sections are not required. */
  changedFiles?: string[];
  /** Additions + deletions. Unknown: a low-risk PR may still skip `<!-- outline -->`. */
  changedLines?: number;
};

const COMMENT = /<!--([\s\S]*?)-->/g;
const stripComments = (text: string) => text.replace(COMMENT, "");
const normalize = (text: string) => stripComments(text).trim().replace(/\s+/g, " ").toLowerCase();
const checkboxes = (content: string, checked: boolean) =>
  [...stripComments(content).matchAll(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/gm)]
    .filter((m) => (m[1] !== " ") === checked)
    .map((m) => normalize(m[2] ?? ""));
const LEAD_LINE = /^\s*\*\*([^*:\n]+):\*\*(.*)$/gm;

export const isFixTitle = (title: string) => /^fix(\([^)]*\))?!?:/i.test(title.trim());
export const touchesUi = (files: string[]) =>
  files.some((f) => UI_PATHS.some((p) => f.replace(/^\.?\//, "").startsWith(p)));

/** Split markdown into the preamble and level-1/level-2 sections. Headings inside code fences or HTML comments do not count. */
function parseSections(markdown: string): { preamble: string; sections: Section[] } {
  const sections: Section[] = [];
  let preamble = "";
  let current: Section | null = null;
  for (const { line, heading: raw } of markdownHeadings(markdown)) {
    if (raw !== null) {
      const flags = [...raw.matchAll(COMMENT)].map((m) => normalize(m[1] ?? ""));
      current = { heading: stripComments(raw).trim(), flags, content: "" };
      sections.push(current);
    } else if (current) {
      current.content += `${line}\n`;
    } else {
      preamble += `${line}\n`;
    }
  }
  return { preamble, sections };
}

const WHEN_FLAGS = ["optional", "fix", "ui", "bot", "outline"] as const;

export function templateSections(template: string): TemplateSection[] {
  return parseSections(template).sections.map((s) => ({
    heading: s.heading,
    when: WHEN_FLAGS.find((f) => s.flags.includes(f)) ?? "always",
    choices: s.flags.includes("pick one") ? checkboxes(s.content, false) : [],
  }));
}

/** The `**Label:**` lines before the template's first heading, in order. */
export function templateLeadLines(template: string): string[] {
  const { preamble } = parseSections(template);
  return [...stripComments(preamble).matchAll(LEAD_LINE)].map((m) => (m[1] ?? "").trim());
}

/** The filled lead lines of a body, keyed by lowercase label. Comments removed. */
function bodyLeadLines(body: string): Map<string, string> {
  const { preamble } = parseSections(body);
  const found = new Map<string, string>();
  for (const m of stripComments(preamble).matchAll(LEAD_LINE)) {
    const label = (m[1] ?? "").trim().toLowerCase();
    if (!found.has(label)) found.set(label, (m[2] ?? "").trim());
  }
  return found;
}

/** The risk level from the body's `**Risk:**` line, or undefined when missing or invalid. */
export function riskLevel(body: string): Risk | undefined {
  const value = bodyLeadLines(body).get("risk")?.toLowerCase() ?? "";
  return RISK_LEVELS.find((r) => new RegExp(`^${r}\\b`).test(value));
}

/** Words a reviewer reads as prose: code fences, tables, `<details>`, comments, headings and URLs excluded. */
export function proseWordCount(body: string): number {
  const prose = stripComments(stripFencedCode(body, ""))
    .replace(/<details>[\s\S]*?<\/details>/gi, "")
    .split("\n")
    .filter((line) => !/^\s*(\||#)/.test(line))
    .join("\n")
    .replace(/https?:\/\/\S+/g, "");
  return (prose.match(/\S*[A-Za-z]\S*/g) ?? []).length;
}

/** Non-blocking advice. An empty list means no warning. */
export function prBodyWarnings(body: string): string[] {
  const words = proseWordCount(body);
  return words > PROSE_WORD_WARN
    ? [
        `about ${words} prose words (budget ~250, warn above ${PROSE_WORD_WARN}). Show the change: outline, tables, <details>.`,
      ]
    : [];
}

/** One problem per leak category. Names the category, never the matched text (CI logs are public). */
export function checkPrBodyLeaks(body: string): string[] {
  return findPrBodyLeaks(body).map((category) => `internal identifier in body: ${category}`);
}

/** Leak-check unless the author is known and is not the swarm bot. */
export const shouldCheckLeaks = (author: string | undefined) =>
  author === undefined || author.trim() === "" || isSwarmBotLogin(author);

function sectionRequired(section: TemplateSection, body: string, ctx: PrContext): boolean {
  switch (section.when) {
    case "always":
      return true;
    case "optional":
      return false;
    case "fix":
      return isFixTitle(ctx.title ?? "");
    case "ui":
      return touchesUi(ctx.changedFiles ?? []);
    case "bot":
      return shouldCheckLeaks(ctx.author);
    case "outline": {
      const small = ctx.changedLines === undefined || ctx.changedLines <= SMALL_DIFF_LINES;
      return !(riskLevel(body) === "low" && small);
    }
  }
}

/**
 * Returns one problem per missing, empty, or badly filled part. An empty list means the body passes.
 * The third argument may be the PR title alone (the older call shape).
 */
export function checkPrBody(template: string, body: string, context: string | PrContext = {}) {
  const ctx: PrContext = typeof context === "string" ? { title: context } : context;
  const { sections: bodySections } = parseSections(body);
  const problems: string[] = [];

  const leads = bodyLeadLines(body);
  for (const label of templateLeadLines(template)) {
    const value = leads.get(label.toLowerCase());
    const name = `**${label}:**`;
    if (value === undefined) problems.push(`missing line: ${name}`);
    else if (!value) problems.push(`empty line: ${name}`);
    else if (label.toLowerCase() === "risk" && !riskLevel(body)) {
      problems.push(`${name} must start with one of: ${RISK_LEVELS.join(", ")}`);
    }
  }

  for (const section of templateSections(template)) {
    if (!sectionRequired(section, body, ctx)) continue;
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
  const { sections: bodySections } = parseSections(body);
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

const RULE_TEXT: Record<TemplateSection["when"], string> = {
  always: "",
  optional: " (optional)",
  fix: " (required for fix: titles)",
  ui: ` (required when the diff touches ${UI_PATHS.join(" or ")})`,
  bot: " (required when desplega-bot is the author)",
  outline: ` (may be skipped when Risk is low and the diff is ${SMALL_DIFF_LINES} lines or fewer)`,
};

async function localChangedFiles(): Promise<string[] | undefined> {
  try {
    const base = (await Bun.$`git merge-base origin/main HEAD`.quiet().text()).trim();
    const out = await Bun.$`git diff --name-only ${base}`.quiet().text();
    return out.split("\n").filter(Boolean);
  } catch {
    return undefined;
  }
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
  const author = arg("--author") ?? process.env.PR_AUTHOR;
  const filesFile = arg("--changed-files-file") ?? process.env.PR_CHANGED_FILES_FILE;
  const changedFiles = filesFile
    ? (await Bun.file(filesFile).text()).split("\n").filter(Boolean)
    : await localChangedFiles();
  const linesArg = arg("--changed-lines") ?? process.env.PR_CHANGED_LINES;
  const changedLines = linesArg && /^\d+$/.test(linesArg) ? Number(linesArg) : undefined;

  if (title === undefined) {
    console.warn("No PR title given (--title or PR_TITLE). Sections for fix PRs were not checked.");
  }
  if (changedFiles === undefined) {
    console.warn("Changed files unknown. Sections for UI PRs were not checked.");
  }
  const ctx: PrContext = { title, author, changedFiles, changedLines };
  for (const warning of prBodyWarnings(body)) {
    console.warn(process.env.GITHUB_ACTIONS ? `::warning title=PR body::${warning}` : warning);
  }
  const leaks = shouldCheckLeaks(author) ? checkPrBodyLeaks(body) : [];
  const problems = [...checkPrBody(template, body, ctx), ...leaks];
  if (problems.length === 0) {
    console.log("PR body has every required part of the template.");
    // Expose each picked choice (urgency=asap) and the risk level to later workflow jobs.
    const outputFile = process.env.GITHUB_OUTPUT;
    if (outputFile) {
      const outputs = { ...pickedChoices(template, body), risk: riskLevel(body) ?? "" };
      appendFileSync(
        outputFile,
        Object.entries(outputs)
          .map(([k, v]) => `${k}=${v}\n`)
          .join(""),
      );
    }
    process.exit(0);
  }

  console.error(`PR body does not match ${TEMPLATE_PATH}:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\nLead lines:");
  for (const label of templateLeadLines(template)) console.error(`  **${label}:**`);
  console.error("Sections, in order:");
  for (const s of templateSections(template))
    console.error(`  ## ${s.heading}${RULE_TEXT[s.when]}`);
  if (leaks.length > 0) {
    console.error(
      "\nThis repo is public. Paraphrase the motivation and link only public sources (Fixes #N, a public PR or issue). Task, session, agent-fs and Slack permalinks go only under ## Swarm provenance.",
    );
  }
  console.error(
    "\nEdit the PR title or description to fix this (no push needed). Guidance for each part is in the template.",
  );
  process.exit(1);
}
