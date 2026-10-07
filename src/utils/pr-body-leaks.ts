/**
 * Leak patterns for PR bodies on public repos.
 *
 * A swarm-authored PR body must explain why the change exists without
 * internal identifiers: Slack ids, timestamps and links, dashboard and
 * agent-fs links, swarm task/run/memory refs, or quotes from private chat.
 *
 * Callers:
 *   - `scripts/check-pr-body.ts` (CI backstop via `.github/workflows/pr-body.yml`)
 *   - `src/hooks/pr-body-guard.ts` (PreToolUse guard for `gh pr create|edit`)
 *
 * Results name the category only. Never echo the matched text: the report
 * itself may be published (CI logs on a public repo, hook output in a PR).
 *
 * Calibration policy for swarm refs (`swarm-task-ref`):
 *   - Prose and inline code are checked: `task 1a2b3c4d`, `parentTaskId: <id>`.
 *   - Fenced code blocks are not: a test fixture or example such as
 *     `const taskId = "<uuid>";` is code, not provenance. Cost: a pasted log
 *     inside a fence that carries a real task id passes.
 *   - A bare "run" is not a swarm ref: "CI run 3f2a9c1d" is usually a CI run
 *     label and a commit SHA. Only "swarm run", "workflow run" or "run id"
 *     followed by a hex id counts. Cost: "run <id>" alone passes.
 * Every other category is checked everywhere, fences included.
 *
 * Swarm provenance: a `## Swarm provenance` section may carry the auth-gated
 * links a maintainer uses to backtrack (task and session links, durable
 * agent-fs paths, the Slack permalink of the ask). Inside that section only,
 * `PROVENANCE_ALLOWED` categories pass, and a Slack permalink's embedded
 * channel id and ts do not count. Bare Slack ids, ts values and private-chat
 * quotes stay blocked there too.
 */

export type LeakCategory =
  | "slack-id"
  | "slack-ts"
  | "slack-link"
  | "swarm-dashboard-link"
  | "agent-fs-link"
  | "swarm-task-ref"
  | "private-chat-quote"
  | "agent-fs-path";

/**
 * The agent-fs path rule (`thoughts/<uuid>/...`) stays off until maintainers
 * decide on the QA convention. The repo review guidance asks for "durable
 * copies: thoughts/<agent-id>/..." lines next to QA evidence embeds.
 */
export const AGENT_FS_PATH_RULE_ENABLED = false;

type LeakRule = {
  category: LeakCategory;
  pattern: RegExp;
  enabled: boolean;
  /** Skip fenced code blocks (see the calibration policy above). */
  proseOnly?: boolean;
};

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Words that attribute text to a person in private chat. Not part of a path or file name (`slack-render.ts`). */
const CHAT = String.raw`(?<![\w/.-])(?:Slack|DMs?|direct message|private (?:chat|message))(?![\w-]|\.\w)`;
const SPEECH = String.raw`(?::|\b(?:said|says|wrote|writes|asked|asks|verbatim)\b)`;

export const LEAK_RULES: readonly LeakRule[] = [
  {
    // Channel, DM, group and user ids: C0AR967K0KZ, D0A..., U0A...
    category: "slack-id",
    pattern: /\b[CDGUW]0(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{8,10}\b/,
    enabled: true,
  },
  {
    // Message ts: 10-digit epoch seconds (2020-2033), a dot, 6 digits.
    category: "slack-ts",
    pattern: /\b1[6-9]\d{8}\.\d{6}\b/,
    enabled: true,
  },
  {
    category: "slack-link",
    pattern: /\bslack\.com\/(?:archives|client)\//i,
    enabled: true,
  },
  {
    // Dashboard links that carry an id: tasks, workflow runs, schedules, ...
    category: "swarm-dashboard-link",
    pattern: /\bapp\.agent-swarm\.dev\/[^\s)"'<>]*[0-9a-f]{8}/i,
    enabled: true,
  },
  {
    category: "agent-fs-link",
    pattern: /\blive\.agent-fs\.dev\b/i,
    enabled: true,
  },
  {
    // "task 1a2b3c4d", "taskId: `1a2b3c4d-...`", "memory id ...", "schedule 1a2b3c4d"
    category: "swarm-task-ref",
    pattern:
      /\b(?:swarm\s+)?(?:task|memory|schedule)s?(?:[\s_-]*id)?\s*[:#=]?\s*[`'"]?(?=[0-9]*[a-f])[0-9a-f]{8}\b/i,
    enabled: true,
    proseOnly: true,
  },
  {
    // "swarm run 1a2b3c4d", "workflow run ...", "run_id: ...". Not a bare "run <sha>".
    category: "swarm-task-ref",
    pattern:
      /\b(?:(?:swarm|workflow)\s+runs?(?:[\s_-]*id)?|runs?[\s_-]*id)\s*[:#=]?\s*[`'"]?(?=[0-9]*[a-f])[0-9a-f]{8}\b/i,
    enabled: true,
    proseOnly: true,
  },
  {
    // camelCase fields: parentTaskId, sourceRunId, memoryId
    category: "swarm-task-ref",
    pattern: /(?:Task|Run|Memory|Schedule)Ids?\s*[:=]?\s*[`'"]?(?=[0-9]*[a-f])[0-9a-f]{8}\b/,
    enabled: true,
    proseOnly: true,
  },
  {
    // `Taras in DM: "..."`, `From the Slack thread, he wrote "..."`
    category: "private-chat-quote",
    pattern: new RegExp(
      String.raw`${CHAT}[^\n"“]{0,60}?${SPEECH}[^\n"“]{0,20}["“][^"”\n]{12,}`,
      "i",
    ),
    enabled: true,
  },
  {
    // Same attribution, with the quote as a markdown blockquote on the next line.
    category: "private-chat-quote",
    pattern: new RegExp(String.raw`${CHAT}[^\n]{0,60}${SPEECH}[ \t]*\n[ \t]*>`, "i"),
    enabled: true,
  },
  {
    category: "agent-fs-path",
    pattern: new RegExp(String.raw`\bthoughts/${UUID}/`, "i"),
    enabled: AGENT_FS_PATH_RULE_ENABLED,
  },
];

/**
 * Presigned object-storage URLs (QA evidence embeds). Exempt until maintainers
 * decide on the QA convention; the repo review guidance requires them.
 */
const PRESIGNED_URL = /https?:\/\/[^\s)"'<>]*[?&]X-Amz-(?:Signature|Credential)=[^\s)"'<>]*/gi;

/** Well-known placeholder UUIDs used in docs and fixtures. */
const PLACEHOLDER_UUIDS = new RegExp(
  [
    String.raw`\b([0-9a-f])\1{7}-\1{4}-\1{4}-\1{4}-\1{12}\b`,
    String.raw`\b123e4567-e89b-12d3-a456-426614174000\b`,
    String.raw`\b550e8400-e29b-41d4-a716-446655440000\b`,
  ].join("|"),
  "gi",
);

/** Fenced code blocks (``` or ~~~). An unclosed fence runs to the end, as in CommonMark. */
const FENCED_CODE = /^[ \t]*(([`~])\2{2,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1\2*[ \t]*$|$(?![\s\S]))/gm;

/** The section heading under which auth-gated provenance links are allowed. */
export const PROVENANCE_HEADING = "Swarm provenance";

/** Categories allowed inside the provenance section. Everything else stays blocked there too. */
export const PROVENANCE_ALLOWED: ReadonlySet<LeakCategory> = new Set<LeakCategory>([
  "slack-link",
  "swarm-dashboard-link",
  "agent-fs-link",
  "swarm-task-ref",
  "agent-fs-path",
]);

/** A whole Slack permalink, query string included (`?thread_ts=...`). */
const SLACK_URL = /https?:\/\/[^\s)"'<>]*slack\.com\/(?:archives|client)\/[^\s)"'<>]*/gi;

const HEADING = /^#{1,2}\s+(.+?)\s*#*\s*$/;
const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const COMMENT_OPEN = /^[ \t]*<!--/;

/**
 * Each line of `markdown`, with the text of the level-1/level-2 heading it
 * starts as GitHub renders it, else null. Headings inside fenced code blocks
 * and HTML comment blocks do not count. A fence closes only on a line of the
 * same character, at least as long as the opening one, with no info string.
 * Shared with `scripts/check-pr-body.ts` so both read sections the same way.
 */
export function markdownHeadings(markdown: string): { line: string; heading: string | null }[] {
  const out: { line: string; heading: string | null }[] = [];
  let fence: { char: string; length: number } | null = null;
  let inComment = false;
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const fenceLine = FENCE_LINE.exec(line);
    const run = fenceLine?.[1] ?? "";
    const info = fenceLine?.[2] ?? "";
    if (fence) {
      if (run[0] === fence.char && run.length >= fence.length && !info.trim()) fence = null;
    } else if (inComment) {
      if (line.includes("-->")) inComment = false;
    } else if (fenceLine && !(run[0] === "`" && info.includes("`"))) {
      fence = { char: run[0] ?? "`", length: run.length };
    } else if (COMMENT_OPEN.test(line)) {
      inComment = !line.slice(line.indexOf("<!--") + 4).includes("-->");
    } else {
      out.push({ line, heading: HEADING.exec(line)?.[1] ?? null });
      continue;
    }
    out.push({ line, heading: null });
  }
  return out;
}

const isProvenanceHeading = (raw: string) =>
  raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase() === PROVENANCE_HEADING.toLowerCase();

/**
 * Split a body into the `## Swarm provenance` section(s) and everything else.
 * A section runs to the next level-1/level-2 heading, as `markdownHeadings` reads them.
 */
export function splitProvenance(body: string): { outside: string; provenance: string } {
  const outside: string[] = [];
  const provenance: string[] = [];
  let inProvenance = false;
  for (const { line, heading } of markdownHeadings(body)) {
    if (heading !== null) inProvenance = isProvenanceHeading(heading);
    (inProvenance ? provenance : outside).push(line);
  }
  return { outside: outside.join("\n"), provenance: provenance.join("\n") };
}

function scan(text: string, skip: ReadonlySet<LeakCategory>, found: LeakCategory[]) {
  const clean = text
    .replace(PRESIGNED_URL, "<presigned-url>")
    .replace(PLACEHOLDER_UUIDS, "<placeholder-uuid>");
  const prose = clean.replace(FENCED_CODE, "<code-block>");
  for (const rule of LEAK_RULES) {
    if (
      rule.enabled &&
      !skip.has(rule.category) &&
      !found.includes(rule.category) &&
      rule.pattern.test(rule.proseOnly ? prose : clean)
    ) {
      found.push(rule.category);
    }
  }
}

/** Returns the distinct leak categories found in `body`, in rule order. Empty means clean. */
export function findPrBodyLeaks(body: string): LeakCategory[] {
  const { outside, provenance } = splitProvenance(body);
  const found: LeakCategory[] = [];
  scan(outside, new Set(), found);
  // A permalink carries a channel id and a message ts; allowed here, so drop it whole.
  scan(provenance.replace(SLACK_URL, "<slack-permalink>"), PROVENANCE_ALLOWED, found);
  return LEAK_RULES.map((r) => r.category).filter(
    (c, i, all) => found.includes(c) && all.indexOf(c) === i,
  );
}

/** GitHub logins whose PR bodies get the leak check in CI. */
export const isSwarmBotLogin = (login: string | undefined) =>
  /^desplega-bot(\[bot\])?$/i.test(login?.trim() ?? "");
