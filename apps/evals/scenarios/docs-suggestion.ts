import { parseToolUses } from "../src/judge/session-log-parse.ts";
import type {
  CheckResult,
  DeterministicCheck,
  JudgeContext,
  Scenario,
  SwarmTask,
} from "../src/types.ts";
import { fetchSessionLogs } from "./orchestration-utils.ts";

/**
 * docs-suggestion (lead + 1 worker)
 * ---------------------------------
 * The lead prompt tells the lead to load the seeded `swarm-docs` skill on
 * demand: only when nothing it already has (skill, workflow, schedule, memory)
 * covers a person's ask. The skill tells it to offer the one matching
 * playbook. Five requests from a person, one task each, routed to the lead:
 *   - three setup asks that match one playbook each (open-oncall, dora-metrics,
 *     pr-review), worded as the person would say them, with no playbook name;
 *   - one small fix that matches nothing;
 *   - one schedule ask the seeded `scheduling` skill already covers.
 * On the two negatives the right lead neither loads `swarm-docs` nor links
 * the docs.
 *
 * Graded deterministically on the lead's reply (the task output it wrote) and,
 * for the negatives, its session log:
 *   - gate: every reply is non-empty.
 *   - `docs-offer` (1): per request, 1 when a positive reply links the expected
 *     playbook and no other docs page, 0.5 when it links the playbook among
 *     others (a list, which the skill forbids), 0 otherwise; for a negative,
 *     1 when the reply carries no docs.agent-swarm.dev link and the session
 *     never loaded `swarm-docs`. Mean over the five.
 * No efficiency dimension: one composite check keeps the score readable as
 * "requests handled right". No solo baseline: the behavior under test is the
 * lead prompt.
 *
 * Anti-gaming: the requests never name a playbook, a docs page or the docs
 * site (leak test in docs-suggestion.test.ts), and the negative request
 * punishes a lead that links the docs on every reply.
 */

const DOCS_HOST = /docs\.agent-swarm\.dev/i;
/** A docs page reference: `/docs/<slug>` on the site, or its `/llms.mdx/docs/<slug>` markdown. */
const DOCS_PAGE = /docs\.agent-swarm\.dev\/(?:llms\.mdx\/)?docs\/([a-z0-9/-]+)/gi;

interface Request {
  id: string;
  title: string;
  text: string;
  /** Expected playbook slug, or null for the negative request. */
  expect: string | null;
}

const REQUESTS: Request[] = [
  {
    id: "oncall",
    title: "Request from Maya: alerts at night",
    text: "Our PagerDuty alerts keep paging us at night. Can the swarm handle the triage and the fixes?",
    expect: "playbooks/open-oncall",
  },
  {
    id: "dora",
    title: "Request from Maya: delivery report",
    text: "I want a weekly report of our deploy frequency and lead time for changes.",
    expect: "playbooks/dora-metrics",
  },
  {
    id: "pr-review",
    title: "Request from Maya: reviews",
    text: "Can you review every PR we open before a human does?",
    expect: "playbooks/pr-review",
  },
  {
    id: "typo",
    title: "Request from Maya: typo",
    text: "Fix the typo in README line 3: 'recieve' should be 'receive'.",
    expect: null,
  },
  {
    id: "reminder",
    title: "Request from Maya: standup reminder",
    text: "Every weekday at 9:00, send me a one-line reminder to post my standup update.",
    expect: null,
  },
];

function brief(request: Request): string {
  return [
    "Maya, a person on the team, sent you this message in a direct chat.",
    "Write your reply to her as this task's output. She reads only that output.",
    "",
    `Maya: ${request.text}`,
  ].join("\n");
}

/** True when a tool call names the `swarm-docs` skill (Skill tool, skill-get, or a read of its file). */
export function loadedSwarmDocs(uses: { toolName: string; input: unknown }[]): boolean {
  return uses.some((use) =>
    /swarm-docs/i.test(`${use.toolName} ${JSON.stringify(use.input ?? {})}`),
  );
}

function replyFor(ctx: JudgeContext, request: Request): string {
  const task = ctx.tasks.find((t: SwarmTask) => t.title === request.title);
  return typeof task?.result === "string" ? task.result : "";
}

/** Distinct docs page slugs a reply links, normalized without a trailing slash. */
export function linkedDocsPages(reply: string): string[] {
  const slugs = new Set<string>();
  for (const match of reply.matchAll(DOCS_PAGE)) {
    slugs.add((match[1] as string).replace(/\/+$/, "").toLowerCase());
  }
  return [...slugs];
}

export function scoreReply(reply: string, expect: string | null): { score: number; note: string } {
  if (expect === null) {
    return DOCS_HOST.test(reply)
      ? { score: 0, note: "linked the docs on a request no page matches" }
      : { score: 1, note: "no docs link" };
  }
  const pages = linkedDocsPages(reply);
  if (!pages.includes(expect)) {
    return {
      score: 0,
      note: pages.length ? `linked ${pages.join(", ")}, not ${expect}` : "no playbook offered",
    };
  }
  if (pages.length > 1)
    return { score: 0.5, note: `offered ${expect} among ${pages.length} pages` };
  return { score: 1, note: `offered ${expect}` };
}

const repliesWritten: DeterministicCheck = {
  name: "lead-replied-to-every-request",
  fn: async (ctx): Promise<CheckResult> => {
    const empty = REQUESTS.filter((r) => !/\S/.test(replyFor(ctx, r))).map((r) => r.id);
    return empty.length === 0
      ? { pass: true, detail: `${REQUESTS.length} replies` }
      : { pass: false, detail: `no reply for: ${empty.join(", ")}` };
  },
};

const docsOfferCheck: DeterministicCheck = {
  name: "docs-offer-per-request",
  fn: async (ctx): Promise<CheckResult> => {
    const parts: string[] = [];
    let total = 0;
    for (const request of REQUESTS) {
      let { score, note } = scoreReply(replyFor(ctx, request), request.expect);
      if (request.expect === null && score > 0) {
        const task = ctx.tasks.find((t: SwarmTask) => t.title === request.title);
        const uses = task ? parseToolUses(await fetchSessionLogs(ctx, task.id)) : [];
        if (loadedSwarmDocs(uses)) {
          score = 0;
          note = "loaded swarm-docs for an ask it already covers";
        }
      }
      total += score;
      parts.push(`${request.id}=${score} (${note})`);
    }
    const score = total / REQUESTS.length;
    return {
      pass: score >= 1,
      score,
      detail: `docs-offer ${score.toFixed(2)}: ${parts.join(", ")}`,
    };
  },
};

export const docsSuggestion: Scenario = {
  id: "docs-suggestion",
  version: 1,
  name: "Docs suggestion",
  description: [
    "A person sends the lead five requests: three setup asks that each match one docs playbook",
    "(Open Oncall, DORA metrics, PR review), a typo fix that matches none, and a standup reminder",
    "the scheduling skill already covers. Graded on the lead's replies: each setup reply offers",
    "the matching playbook link and no other docs page, and the two other replies carry no docs",
    "link with no swarm-docs load in the session (docs-offer, 1).",
  ].join(" "),
  workers: 1,
  lead: { name: "Lead", template: "lead" },
  tasks: REQUESTS.map((request) => ({
    title: request.title,
    worker: "lead" as const,
    description: brief(request),
  })),
  outcome: {
    gates: [repliesWritten],
    dimensions: [{ name: "docs-offer", weight: 1, checks: [docsOfferCheck] }],
  },
  timeoutMs: 15 * 60_000,
};

// Exported for the rubric unit tests and grader fixtures.
export const __test__ = { REQUESTS, docsOfferCheck, repliesWritten };
