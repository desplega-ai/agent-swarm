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

type LeakRule = { category: LeakCategory; pattern: RegExp; enabled: boolean };

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
    // "task d80a8d8b", "taskId: `d80a8d8b-...`", "swarm run 1a2b3c4d", "memory id ..."
    category: "swarm-task-ref",
    pattern:
      /\b(?:swarm\s+)?(?:task|run|memory|schedule)s?(?:[\s_-]*id)?\s*[:#=]?\s*[`'"]?(?=[0-9]*[a-f])[0-9a-f]{8}\b/i,
    enabled: true,
  },
  {
    // camelCase fields: parentTaskId, sourceRunId, memoryId
    category: "swarm-task-ref",
    pattern: /(?:Task|Run|Memory|Schedule)Ids?\s*[:=]?\s*[`'"]?(?=[0-9]*[a-f])[0-9a-f]{8}\b/,
    enabled: true,
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

/** Returns the distinct leak categories found in `body`, in rule order. Empty means clean. */
export function findPrBodyLeaks(body: string): LeakCategory[] {
  const text = body
    .replace(/\r\n/g, "\n")
    .replace(PRESIGNED_URL, "<presigned-url>")
    .replace(PLACEHOLDER_UUIDS, "<placeholder-uuid>");
  const found: LeakCategory[] = [];
  for (const rule of LEAK_RULES) {
    if (rule.enabled && !found.includes(rule.category) && rule.pattern.test(text)) {
      found.push(rule.category);
    }
  }
  return found;
}

/** GitHub logins whose PR bodies get the leak check in CI. */
export const isSwarmBotLogin = (login: string | undefined) =>
  /^desplega-bot(\[bot\])?$/i.test(login?.trim() ?? "");
