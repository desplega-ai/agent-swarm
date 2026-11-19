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
 *   `<!-- evidence -->`  always required. Needs a fence with content, a table with a data row,
 *                       an image or video with a source, "Before: ... After: ...", or
 *                       "No visible change: <reason>". An empty shape is not evidence.
 *   `<!-- bot -->`       required for the swarm bot or an unknown author. Present content is
 *                       links only, each as [label](url).
 *   `<!-- link: Task -->` with `bot`: the bot must link that label.
 *   `<!-- fix mentions: main -->` for a fix title, the section must hold that word.
 *   `<!-- outline -->`   required unless Risk is low and the diff is `SMALL_DIFF_LINES` or fewer.
 *   `<!-- pick one -->`  the body must check exactly one of the template's `- [ ]` items.
 * Heading budgets: `max rows: N`, `max bullets: N`, `max code lines: N` warn only.
 * Lead markers: `one of: a | b | c` restricts the value (a reason in parentheses may follow);
 * `max words: N` warns only.
 * Other comments provide guidance.
 * Any other required section counts as filled when its text, with HTML comments
 * removed, is not blank. Keep template guidance inside HTML comments so an
 * unedited template fails.
 *
 * Length: above `PROSE_WORD_WARN` prose words (code fences, tables, `<details>`, comments
 * and headings excluded) the check warns, and above `PROSE_WORD_FAIL` it fails. A lead line
 * warns above `max words: N` and fails above `hard max words: N`. Row, bullet and code-line
 * budgets only warn.
 *
 * Window: a template line `<!-- new rules fail from: YYYY-MM-DD -->` makes the newer rules
 * (evidence, provenance format, the fix control, the hard length limits) warn only until
 * that date. Delete the line after the date.
 *
 * Bot-authored bodies also get the leak check (`src/utils/pr-body-leaks.ts`):
 * no Slack ids, private-chat quotes, and no task, dashboard, agent-fs or Slack
 * links outside `## Swarm provenance`. It runs when the author is desplega-bot,
 * or when no author is given (a local run). External contributors are never leak-checked.
 *
 * Usage:
 *   bun scripts/check-pr-body.ts --title "fix(slack): ..." --body-file /tmp/pr-body.md
 *   PR_TITLE="..." PR_BODY="..." PR_AUTHOR="..." bun scripts/check-pr-body.ts
 * Optional: `--changed-lines <n>` / PR_CHANGED_LINES (additions + deletions), and
 * PR_TEMPLATE_PATH (the template to check against; default below), and
 * PR_BODY_PROBLEMS_FILE (on failure, the problems are written there as a Markdown list).
 *
 * CI: `.github/workflows/pr-body.yml` passes the env above. On success, each
 * picked section choice, lead choice and the risk level are written to GITHUB_OUTPUT (for example
 * `urgency=asap`, `risk=high`).
 */

import { appendFileSync } from "node:fs";
import {
  findPrBodyLeaks,
  isSwarmBotLogin,
  markdownHeadings,
  stripFencedCode,
} from "../src/utils/pr-body-leaks";

// PR_TEMPLATE_PATH lets the org-wide check (desplega-ai/.github) point at the
// caller repo's template or the org default. Unset: this repo's template.
const TEMPLATE_PATH = process.env.PR_TEMPLATE_PATH || ".github/pull_request_template.md";

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type Risk = (typeof RISK_LEVELS)[number];
export const SMALL_DIFF_LINES = 50;
export const PROSE_WORD_WARN = 200;
export const PROSE_WORD_FAIL = 300;

/** `flags`: each HTML comment on the heading line, whitespace collapsed, case kept. */
type Section = { heading: string; flags: string[]; content: string };

export type TemplateSection = {
  heading: string;
  when: "always" | "optional" | "fix" | "evidence" | "bot" | "outline";
  /** The allowed `- [ ]` items when the section is marked `pick one`, else empty. */
  choices: string[];
};

/** What the check knows about the PR besides its body. Unknown fields relax nothing except as noted. */
export type PrContext = {
  title?: string;
  /** GitHub login. Unknown counts as the swarm bot, as for the leak check. */
  author?: string;
  /** Today as YYYY-MM-DD, for the warn-only window. Default: the current UTC date. */
  today?: string;
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
/** Split markdown into the preamble and level-1/level-2 sections. Headings inside code fences or HTML comments do not count. */
function parseSections(markdown: string): { preamble: string; sections: Section[] } {
  const sections: Section[] = [];
  let preamble = "";
  let current: Section | null = null;
  for (const { line, heading: raw } of markdownHeadings(markdown)) {
    if (raw !== null) {
      const flags = [...raw.matchAll(COMMENT)].map((m) => (m[1] ?? "").trim().replace(/\s+/g, " "));
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

const WHEN_FLAGS = ["optional", "fix", "evidence", "bot", "outline"] as const;

export function templateSections(template: string): TemplateSection[] {
  return parseSections(template).sections.map((s) => {
    const flags = s.flags.map((f) => f.toLowerCase());
    const when = WHEN_FLAGS.find((f) => flags.includes(f)) ?? "always";
    return {
      heading: s.heading,
      when,
      choices: flags.includes("pick one") ? checkboxes(s.content, false) : [],
    };
  });
}

/** The `**Label:**` lines before the template's first heading, in order. */
export function templateLeadLines(template: string): string[] {
  const { preamble } = parseSections(template);
  return [...stripComments(preamble).matchAll(LEAD_LINE)].map((m) => (m[1] ?? "").trim());
}

/** Read constraints only from inline lead markers. */
function leadRules(template: string) {
  const preamble = parseSections(template).preamble.replace(COMMENT, (comment) =>
    comment.includes("\n") ? "" : comment,
  );
  return [...preamble.matchAll(LEAD_LINE)].map((m) => {
    const flags = [...(m[2] ?? "").matchAll(COMMENT)].map((c) => (c[1] ?? "").trim());
    const choice = flags.find((f) => /^one of:/i.test(f));
    return {
      label: (m[1] ?? "").trim(),
      choices: choice
        ? choice
            .replace(/^one of:\s*/i, "")
            .split("|")
            .map(normalize)
        : [],
      maxWords: markerLimit(flags, "words"),
      hardMaxWords: markerLimit(flags, "words", "hard max"),
    };
  });
}

function markerLimit(flags: string[], unit: string, kind = "max"): number | undefined {
  const match = flags
    .map((f) => new RegExp(`^${kind} ${unit}:\\s*(\\d+)$`, "i").exec(f))
    .find(Boolean);
  return match ? Number(match[1]) : undefined;
}

function chosenLead(rule: ReturnType<typeof leadRules>[number], body: string): string | undefined {
  const value = bodyLeadLines(body).get(rule.label.toLowerCase());
  if (value !== undefined) {
    // `**asap**` counts. `asap, but it can wait` does not: free text must not route a review.
    const normalized = normalize(value.replace(/[*_`]/g, ""));
    return rule.choices.find(
      (choice) =>
        normalized === choice || (normalized.startsWith(`${choice} (`) && normalized.endsWith(")")),
    );
  }
  // Transition aid for PRs opened with the old checkbox section.
  const section = parseSections(body).sections.find(
    (s) => normalize(s.heading) === normalize(rule.label),
  );
  const checked = section ? checkboxes(section.content, true) : [];
  return checked.length === 1 && rule.choices.includes(checked[0] ?? "") ? checked[0] : undefined;
}

/** Valid lead choices, keyed by lowercase label, including the checkbox transition form. */
export function leadChoices(template: string, body: string): Record<string, string> {
  const choices: Record<string, string> = {};
  for (const rule of leadRules(template)) {
    const choice = chosenLead(rule, body);
    if (choice !== undefined) choices[rule.label.toLowerCase()] = choice;
  }
  return choices;
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
export function prBodyWarnings(body: string, template?: string): string[] {
  const words = proseWordCount(body);
  const warnings =
    words > PROSE_WORD_WARN && words <= PROSE_WORD_FAIL
      ? [
          `about ${words} prose words (target ~150, the check fails above ${PROSE_WORD_FAIL}). Show the change: outline, tables, <details>.`,
        ]
      : [];
  if (template === undefined) return warnings;
  const leads = bodyLeadLines(body);
  for (const rule of leadRules(template)) {
    const count = (leads.get(rule.label.toLowerCase()) ?? "").split(/\s+/).filter(Boolean).length;
    const underLimit = rule.hardMaxWords === undefined || count <= rule.hardMaxWords;
    if (rule.maxWords !== undefined && count > rule.maxWords && underLimit) {
      warnings.push(`**${rule.label}:** has ${count} words. Target: ${rule.maxWords} or fewer`);
    }
  }
  for (const section of parseSections(template).sections) {
    const found = parseSections(body).sections.find(
      (s) => normalize(s.heading) === normalize(section.heading),
    );
    if (!found) continue;
    const text = stripComments(found.content);
    const lines = text.split("\n");
    let fence: string | undefined;
    let codeLines = 0;
    for (const line of lines) {
      if (fence) {
        if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = undefined;
        else codeLines++;
      } else {
        fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      }
    }
    const counts = {
      rows: tableDataRows(stripFencedCode(text, "")),
      bullets: (
        stripFencedCode(text, "")
          .replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, "")
          .match(/^[-*] +/gm) ?? []
      ).length,
      "code lines": codeLines,
    };
    for (const [unit, count] of Object.entries(counts)) {
      const limit = markerLimit(section.flags, unit);
      if (limit !== undefined && count > limit) {
        warnings.push(
          `## ${section.heading}: ${count} ${unit === "rows" ? "table rows" : unit}. Target: ${limit} or fewer`,
        );
      }
    }
  }
  if (body.includes("X-Amz-"))
    warnings.push("a presigned link expires. Use a GitHub attachment for images and videos");
  return warnings;
}

const TABLE_SEPARATOR = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;
function tableDataRows(text: string): number {
  const lines = text.split("\n");
  let rows = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i - 1] ?? "") || !TABLE_SEPARATOR.test(lines[i] ?? "")) continue;
    while (/^\s*\|/.test(lines[i + 1] ?? "") && !TABLE_SEPARATOR.test(lines[i + 1] ?? "")) {
      rows++;
      i++;
    }
  }
  return rows;
}

/**
 * True when the section shows something. An empty fence, a header-only table and an `<img>`
 * with no source are not evidence. Whether the evidence is true is the reviewer's call.
 */
function hasEvidence(text: string): boolean {
  const fences = [
    ...text.matchAll(/^ {0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^ {0,3}\1[`~]*[ \t]*$/gm),
  ];
  return (
    fences.some((m) => (m[2] ?? "").trim() !== "") ||
    tableDataRows(text) > 0 ||
    /!\[[^\]\n]*\]\(\s*<?[^)\s>]+/.test(text) ||
    /<(?:img|video|source)\b[^>]*\bsrc\s*=\s*["']?[^"'\s>]+/i.test(text) ||
    /https?:\/\/[^\s<>]+\.(?:mp4|mov|webm)(?=$|[\s)<>])/im.test(text) ||
    /https:\/\/github\.com\/user-attachments\/assets\/[^\s<>]+/i.test(text) ||
    /^\s*No vis(?:ible|ual) change:[ \t]*\S.*$/im.test(text) ||
    // A one-line change may be plain text: "Before: ... After: ...".
    (/\bbefore\s*:\s*\S/i.test(text) && /\bafter\s*:\s*\S/i.test(text))
  );
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
    case "evidence":
      return true;
    case "optional":
      return false;
    case "fix":
      return isFixTitle(ctx.title ?? "");
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
  const { hard, fresh } = collectProblems(template, body, ctx);
  return warnOnlyUntil(template, ctx) ? hard : [...hard, ...fresh];
}

/**
 * The problems that do not fail yet. A template line `<!-- new rules fail from: YYYY-MM-DD -->`
 * opens a window: until that date the rules marked "fresh" below only warn, so that PRs
 * opened under the old template are not broken by an unrelated push. Empty after the date,
 * and when the template has no such line.
 */
export function pendingPrBodyProblems(
  template: string,
  body: string,
  context: string | PrContext = {},
): { from: string; problems: string[] } | undefined {
  const ctx: PrContext = typeof context === "string" ? { title: context } : context;
  const from = warnOnlyUntil(template, ctx);
  return from ? { from, problems: collectProblems(template, body, ctx).fresh } : undefined;
}

/** The window's end date while the window is open, else undefined. */
function warnOnlyUntil(template: string, ctx: PrContext): string | undefined {
  const from = /<!--\s*new rules fail from:\s*(\d{4}-\d{2}-\d{2})\s*-->/i.exec(template)?.[1];
  const today = ctx.today ?? new Date().toISOString().slice(0, 10);
  return from !== undefined && today < from ? from : undefined;
}

/** `hard`: rules that always fail. `fresh`: rules that only warn while the window is open. */
function collectProblems(template: string, body: string, ctx: PrContext) {
  const { sections: bodySections } = parseSections(body);
  const problems: string[] = [];
  const fresh: string[] = [];

  const leads = bodyLeadLines(body);
  for (const rule of leadRules(template)) {
    const { label } = rule;
    const value = leads.get(label.toLowerCase());
    const name = `**${label}:**`;
    const chosen = chosenLead(rule, body);
    if (value === undefined && chosen !== undefined) continue;
    if (value === undefined) problems.push(`missing line: ${name}`);
    else if (!value) problems.push(`empty line: ${name}`);
    else if (rule.choices.length > 0 && chosen === undefined) {
      problems.push(
        `${name} must be one of: ${rule.choices.join(", ")} (a reason in parentheses may follow)`,
      );
    } else if (label.toLowerCase() === "risk" && !riskLevel(body)) {
      problems.push(`${name} must start with one of: ${RISK_LEVELS.join(", ")}`);
    }
    const count = (value ?? "").split(/\s+/).filter(Boolean).length;
    if (rule.hardMaxWords !== undefined && count > rule.hardMaxWords) {
      const target = rule.maxWords === undefined ? "" : ` (target ${rule.maxWords})`;
      fresh.push(`${name} has ${count} words. Limit: ${rule.hardMaxWords}${target}`);
    }
  }
  const proseWords = proseWordCount(body);
  if (proseWords > PROSE_WORD_FAIL) {
    fresh.push(
      `about ${proseWords} prose words. Limit: ${PROSE_WORD_FAIL}. Move detail into a code block, a table or <details>`,
    );
  }

  // `key: value` markers on each template heading, by normalized heading.
  const markers = new Map(
    parseSections(template).sections.map((t) => [
      normalize(t.heading),
      Object.fromEntries(
        t.flags.flatMap((f) => {
          const m = /^([a-z ]+):\s*(.+)$/i.exec(f);
          return m ? [[(m[1] ?? "").trim().toLowerCase(), (m[2] ?? "").trim()]] : [];
        }),
      ) as Record<string, string>,
    ]),
  );
  for (const section of templateSections(template)) {
    const required = sectionRequired(section, body, ctx);
    const found = bodySections.find((s) => normalize(s.heading) === normalize(section.heading));
    const name = `## ${section.heading}`;
    const present = found ? stripComments(found.content).trim() : "";
    if (section.when === "bot" && found && present) {
      const text = present
        .replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/gi, "")
        .replace(/<\/?details\b[^>]*>/gi, "");
      const link = /(?<!!)\[([^\]\n]+)\]\(<?https?:\/\/[^\s]+?>?\)/;
      const noLinks = text.replace(new RegExp(link.source, "gi"), "");
      const bareUrl = /https?:\/\//i.test(noLinks);
      if (bareUrl) {
        fresh.push(`${name}: write each link as [label](url), not as a bare URL`);
      }
      // What is left of a line after its links and its list marker: separators only.
      // A bare URL and its `Label:` already have their own problem line.
      const prose = noLinks
        .split("\n")
        .map((l) =>
          l
            .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
            .replace(/(?:[\p{L}][\p{L} /]{0,24}:\s*)?https?:\/\/\S+/giu, ""),
        );
      if (prose.some((l) => /[\p{L}\p{N}]/u.test(l))) {
        fresh.push(`${name}: links only, each as [label](url). Move other text to another section`);
      }
      // `<!-- link: Task -->` on the heading: the bot must link that label.
      const label = markers.get(normalize(section.heading))?.link;
      const labels = [...text.matchAll(new RegExp(link.source, "gi"))].map((m) =>
        normalize(m[1] ?? ""),
      );
      // With a bare URL, the fix for that problem line adds the label too.
      if (label && !bareUrl && shouldCheckLeaks(ctx.author) && !labels.includes(normalize(label))) {
        fresh.push(`${name}: link the ${label.toLowerCase()} as [${label}](url)`);
      }
    }
    // `<!-- fix mentions: main -->`: a fix shows its control (the failure before the fix).
    const mention = markers.get(normalize(section.heading))?.["fix mentions"];
    if (mention && found && isFixTitle(ctx.title ?? "")) {
      const text = stripComments(found.content).trim();
      if (text && !new RegExp(`\\b${mention}\\b`, "i").test(text)) {
        fresh.push(
          `${name}: for a fix, show the control on "${mention}" (the failure before the fix)`,
        );
      }
    }
    if (!required) continue;
    if (!found) {
      (section.when === "evidence" ? fresh : problems).push(`missing section: ${name}`);
    } else if (section.choices.length > 0) {
      const picked = checkboxes(found.content, true);
      if (picked.length !== 1 || !section.choices.includes(picked[0] ?? "")) {
        problems.push(`${name}: check exactly one of: ${section.choices.join(", ")}`);
      }
    } else if (section.when === "evidence" && !hasEvidence(stripComments(found.content))) {
      fresh.push(
        `${name}: show a snippet, a table with a data row, an image or a video, write "Before: ... After: ...", or write "No visible change: <reason>"`,
      );
    } else if (!stripComments(found.content).trim()) {
      problems.push(`empty section: ${name}`);
    }
  }
  return { hard: problems, fresh };
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

const ruleText = (s: TemplateSection): string => {
  switch (s.when) {
    case "always":
      return "";
    case "optional":
      return " (optional)";
    case "fix":
      return " (required for fix: titles)";
    case "evidence":
      return " (required: a snippet, a table, an image, a video, or No visible change: <reason>)";
    case "bot":
      return " (required when desplega-bot is the author)";
    case "outline":
      return ` (may be skipped when Risk is low and the diff is ${SMALL_DIFF_LINES} lines or fewer)`;
  }
};

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
  const linesArg = arg("--changed-lines") ?? process.env.PR_CHANGED_LINES;
  const changedLines = linesArg && /^\d+$/.test(linesArg) ? Number(linesArg) : undefined;

  if (title === undefined) {
    console.warn("No PR title given (--title or PR_TITLE). Sections for fix PRs were not checked.");
  }
  const ctx: PrContext = { title, author, changedLines };
  for (const warning of prBodyWarnings(body, template)) {
    console.warn(process.env.GITHUB_ACTIONS ? `::warning title=PR body::${warning}` : warning);
  }
  const pending = pendingPrBodyProblems(template, body, ctx);
  for (const problem of pending?.problems ?? []) {
    const text = `from ${pending?.from} this fails: ${problem}`;
    console.warn(process.env.GITHUB_ACTIONS ? `::warning title=PR body::${text}` : text);
  }
  const leaks = shouldCheckLeaks(author) ? checkPrBodyLeaks(body) : [];
  const problems = [...checkPrBody(template, body, ctx), ...leaks];
  if (problems.length === 0) {
    console.log("PR body has every required part of the template.");
    // Expose each picked choice (urgency=asap) and the risk level to later workflow jobs.
    const outputFile = process.env.GITHUB_OUTPUT;
    if (outputFile) {
      const outputs = {
        ...pickedChoices(template, body),
        ...leadChoices(template, body),
        risk: riskLevel(body) ?? "",
      };
      appendFileSync(
        outputFile,
        Object.entries(outputs)
          .map(([k, v]) => `${k}=${v}\n`)
          .join(""),
      );
    }
    process.exit(0);
  }

  // pr-body-comment.yml posts this list on fork PRs, whose authors cannot read the job log easily.
  const problemsFile = process.env.PR_BODY_PROBLEMS_FILE;
  if (problemsFile) await Bun.write(problemsFile, problems.map((p) => `- ${p}\n`).join(""));
  console.error(`PR body does not match ${TEMPLATE_PATH}:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\nLead lines:");
  for (const rule of leadRules(template)) {
    console.error(
      `  **${rule.label}:**${rule.choices.length ? ` (one of: ${rule.choices.join(", ")})` : ""}`,
    );
  }
  console.error("Sections, in order:");
  for (const s of templateSections(template)) console.error(`  ## ${s.heading}${ruleText(s)}`);
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
