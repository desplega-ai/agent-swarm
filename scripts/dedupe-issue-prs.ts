#!/usr/bin/env bun
/**
 * Close duplicate contributor PRs that target the same GitHub issue.
 *
 * Run by `.github/workflows/dedupe-issue-prs.yml`. It only reads PR metadata
 * through the API and never checks out or runs PR code.
 *
 * A PR targets an issue when GitHub lists the issue in its
 * closingIssuesReferences, or its body says `fixes|closes|resolves #N` (also
 * `owner/repo#N` and the issue URL, same repo only).
 *
 * For each issue, the contest pool is every open PR that targets it, except
 * bot PRs and PRs labelled `allow-duplicate`. Those are never closed and never
 * cause another PR to be closed. Drafts count. The winner is:
 *   1. the earliest PR of the earliest claimant who has a PR in the pool. A claim
 *      is an issue assignment or an issue comment with a claim phrase ("I'll take
 *      it", "can I take", "assign me", "I'm working on this", ...). Unassigning a
 *      user voids every claim they made before it.
 *   2. else the earliest maintainer PR (author association OWNER, MEMBER or
 *      COLLABORATOR): a maintainer never loses to an unclaimed contributor PR.
 *   3. else the earliest-opened PR.
 * Maintainer PRs are never closed. Every other non-winner is a loser. A PR that
 * targets several issues is closed only when it lost on one and won none.
 *
 * Usage:
 *   bun scripts/dedupe-issue-prs.ts --pr <number> [--dry-run]   one PR event
 *   bun scripts/dedupe-issue-prs.ts --all [--dry-run]           scan all open PRs
 * Env: GITHUB_TOKEN (or GH_TOKEN), GITHUB_REPOSITORY (owner/name),
 * GITHUB_STEP_SUMMARY (optional, gets the markdown report).
 */

export const EXEMPT_LABEL = "allow-duplicate";
export const COMMENT_MARKER = "<!-- dedupe-issue-prs -->";
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export type PullRequest = {
  number: number;
  url: string;
  title: string;
  body: string;
  createdAt: string;
  isDraft: boolean;
  author: string;
  authorIsBot: boolean;
  authorAssociation: string;
  labels: string[];
  closingIssues: number[];
};

export type IssueComment = { author: string; authorIsBot: boolean; createdAt: string; body: string; url: string };
export type AssignmentEvent = { kind: "assigned" | "unassigned"; login: string; createdAt: string };
export type Issue = {
  number: number;
  url: string;
  assignees: string[];
  comments: IssueComment[];
  assignments: AssignmentEvent[];
};

export type Claim = { login: string; at: string; kind: "assigned" | "comment"; url: string };
export type WinReason =
  | { kind: "claim"; claim: Claim }
  | { kind: "maintainer" }
  | { kind: "first" };
export type IssueDecision = {
  issue: number;
  pool: number[];
  winner: number | null;
  reason: WinReason | null;
  losers: number[];
};
export type Closure = { pr: PullRequest; losses: { issue: number; winner: number; reason: WinReason }[] };

const lower = (s: string) => s.toLowerCase();
const ts = (s: string) => Date.parse(s);
const byCreated = (a: PullRequest, b: PullRequest) => ts(a.createdAt) - ts(b.createdAt) || a.number - b.number;

export function isMaintainer(pr: PullRequest): boolean {
  return MAINTAINER_ASSOCIATIONS.has(pr.authorAssociation);
}

export function isBot(pr: PullRequest): boolean {
  return pr.authorIsBot || pr.author.endsWith("[bot]");
}

export function isExempt(pr: PullRequest): boolean {
  return pr.labels.some((l) => lower(l) === EXEMPT_LABEL);
}

/** Drop HTML comments, fenced code and quoted lines: template text and quotes are not the author's words. */
function stripNoise(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
}

const CLOSE_KEYWORD = String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+`;

/** Issue numbers a PR body links with a closing keyword, same repo only. */
export function parseLinkedIssues(body: string, repo: string): number[] {
  const text = stripNoise(body ?? "");
  const repoRe = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`${CLOSE_KEYWORD}#(\\d+)\\b`, "gi"),
    new RegExp(`${CLOSE_KEYWORD}${repoRe}#(\\d+)\\b`, "gi"),
    new RegExp(`${CLOSE_KEYWORD}https://github\\.com/${repoRe}/issues/(\\d+)\\b`, "gi"),
  ];
  const found = new Set<number>();
  for (const re of patterns) for (const m of text.matchAll(re)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

/** Every issue a PR targets: GitHub's closing references plus body keywords. */
export function linkedIssues(pr: PullRequest, repo: string): number[] {
  return [...new Set([...pr.closingIssues, ...parseLinkedIssues(pr.body, repo)])].sort((a, b) => a - b);
}

// "working on this" alone also matches "is anyone working on this?", so it
// needs a first-person lead-in or the start of a line.
const CLAIM_PATTERNS: RegExp[] = [
  /\bi'?ll\s+(?:take|grab|pick\s+up|work\s+on|handle|tackle)\b/,
  /\bi\s+will\s+(?:take|grab|pick\s+up|work\s+on|handle|tackle)\b/,
  /\bcan\s+i\s+(?:take|grab|pick\s+up|work\s+on|have)\b/,
  /\bi'?d\s+like\s+to\s+(?:take|work\s+on|pick\s+up)\b/,
  /\bi\s+(?:can|want\s+to)\s+(?:take|work\s+on|pick\s+up)\s+(?:this|it)\b/,
  /\blet\s+me\s+(?:take|work\s+on|pick\s+up)\b/,
  /\bassign\s+(?:(?:it|this)\s+)?(?:to\s+)?me\b/,
  /\b(?:i'?m|i\s+am|am|currently|already|now|started|start)\s+working\s+on\s+(?:this|it)\b/,
  /(?:^|\n)\s*working\s+on\s+(?:this|it)\b/,
];

/** True when a comment claims the issue for its author. Tolerates curly apostrophes. */
export function isClaimComment(body: string): boolean {
  const text = lower(stripNoise(body ?? "")).replace(/[‘’ʼ`´]/g, "'");
  return CLAIM_PATTERNS.some((re) => re.test(text));
}

/** Live claims on an issue, earliest first. One per user, at their earliest live claim. */
export function findClaims(issue: Issue): Claim[] {
  const raw: Claim[] = [];
  const assigned = new Set(issue.assignees.map(lower));
  for (const ev of issue.assignments) {
    if (ev.kind === "assigned" && assigned.has(lower(ev.login))) {
      raw.push({ login: ev.login, at: ev.createdAt, kind: "assigned", url: issue.url });
    }
  }
  for (const c of issue.comments) {
    if (!c.authorIsBot && isClaimComment(c.body)) {
      raw.push({ login: c.author, at: c.createdAt, kind: "comment", url: c.url });
    }
  }
  // Unassigning someone voids every claim they made before it.
  const lastUnassigned = new Map<string, number>();
  for (const ev of issue.assignments) {
    if (ev.kind !== "unassigned") continue;
    const k = lower(ev.login);
    lastUnassigned.set(k, Math.max(lastUnassigned.get(k) ?? 0, ts(ev.createdAt)));
  }
  const earliest = new Map<string, Claim>();
  for (const claim of raw) {
    const k = lower(claim.login);
    if (ts(claim.at) <= (lastUnassigned.get(k) ?? Number.NEGATIVE_INFINITY)) continue;
    const prev = earliest.get(k);
    if (!prev || ts(claim.at) < ts(prev.at)) earliest.set(k, claim);
  }
  return [...earliest.values()].sort((a, b) => ts(a.at) - ts(b.at));
}

/** Pick the PR to keep for one issue, and the PRs that lose to it. */
export function decideIssue(issue: Issue, prs: PullRequest[]): IssueDecision {
  const pool = prs.filter((p) => !isBot(p) && !isExempt(p)).sort(byCreated);
  const base = { issue: issue.number, pool: pool.map((p) => p.number) };
  if (pool.length === 0) return { ...base, winner: null, reason: null, losers: [] };

  let winner: PullRequest | undefined;
  let reason: WinReason | undefined;
  for (const claim of findClaims(issue)) {
    winner = pool.find((p) => lower(p.author) === lower(claim.login));
    if (winner) {
      reason = { kind: "claim", claim };
      break;
    }
  }
  if (!winner) {
    winner = pool.find(isMaintainer);
    if (winner) reason = { kind: "maintainer" };
  }
  if (!winner) {
    winner = pool[0] as PullRequest;
    reason = { kind: "first" };
  }
  const losers = pool.filter((p) => p.number !== winner.number && !isMaintainer(p)).map((p) => p.number);
  return { ...base, winner: winner.number, reason: reason as WinReason, losers };
}

/**
 * Turn per-issue decisions into closures. `closableIssues` limits which
 * issues may close a PR (an event run closes only on the event PR's issues);
 * every decision still counts as a win.
 */
export function planClosures(
  decisions: IssueDecision[],
  prsByNumber: Map<number, PullRequest>,
  closableIssues?: Set<number>,
): Closure[] {
  const winners = new Set(decisions.map((d) => d.winner).filter((n): n is number => n !== null));
  const losses = new Map<number, Closure["losses"]>();
  for (const d of decisions) {
    if (d.winner === null || !d.reason) continue;
    if (closableIssues && !closableIssues.has(d.issue)) continue;
    for (const loser of d.losers) {
      const list = losses.get(loser) ?? [];
      list.push({ issue: d.issue, winner: d.winner, reason: d.reason });
      losses.set(loser, list);
    }
  }
  const closures: Closure[] = [];
  for (const [number, list] of losses) {
    const pr = prsByNumber.get(number);
    if (!pr || winners.has(number)) continue;
    closures.push({ pr, losses: list });
  }
  return closures.sort((a, b) => a.pr.number - b.pr.number);
}

function reasonText(reason: WinReason, winner: PullRequest | undefined): string {
  const who = winner ? `@${winner.author}` : "its author";
  if (reason.kind === "claim") {
    const how = reason.claim.kind === "assigned" ? "was assigned the issue" : `[claimed the issue](${reason.claim.url})`;
    return `${who} ${how} first.`;
  }
  if (reason.kind === "maintainer") return `it comes from a maintainer and no contributor claimed the issue before them.`;
  return "it was opened first.";
}

/** The comment posted on a closed PR. */
export function closeComment(closure: Closure, prsByNumber: Map<number, PullRequest>): string {
  const lines = [
    COMMENT_MARKER,
    `Thanks for working on this, @${closure.pr.author}. We are closing this PR because another open PR already covers the same issue:`,
    "",
  ];
  for (const loss of closure.losses) {
    lines.push(`- #${loss.issue}: kept #${loss.winner}, because ${reasonText(loss.reason, prsByNumber.get(loss.winner))}`);
  }
  lines.push(
    "",
    "To keep one PR per issue, the first person to claim an issue on the issue itself (a comment such as \"I'll take it\", or an assignment) keeps it. With no claim, the earliest PR stays open.",
    "",
    `If this PR should stay open (for example, it takes a different approach), ask a maintainer to add the \`${EXEMPT_LABEL}\` label and reopen it.`,
  );
  return lines.join("\n");
}

/** Markdown report of what a run closed, or would close. */
export function report(decisions: IssueDecision[], closures: Closure[], dryRun: boolean): string {
  const contested = decisions.filter((d) => d.pool.length > 1);
  const out = [`### Duplicate issue PRs${dryRun ? " (dry run)" : ""}`, ""];
  if (contested.length === 0) {
    out.push("No issue has more than one open PR.");
    return out.join("\n");
  }
  out.push("| Issue | Open PRs | Kept | Why | Closed |", "|---|---|---|---|---|");
  const closing = new Set(closures.map((c) => c.pr.number));
  for (const d of contested) {
    const why = d.reason?.kind === "claim" ? `claim by @${d.reason.claim.login}` : (d.reason?.kind ?? "");
    const closed = d.losers.filter((n) => closing.has(n));
    out.push(
      `| #${d.issue} | ${d.pool.map((n) => `#${n}`).join(", ")} | #${d.winner} | ${why} | ${closed.map((n) => `#${n}`).join(", ") || "none"} |`,
    );
  }
  out.push("", `${dryRun ? "Would close" : "Closed"}: ${closures.map((c) => `#${c.pr.number}`).join(", ") || "none"}.`);
  return out.join("\n");
}

// ---------------------------------------------------------------- GitHub I/O

type Gql = <T>(query: string, variables: Record<string, unknown>) => Promise<T>;

function makeClient(token: string) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "dedupe-issue-prs",
  };
  const gql: Gql = async (query, variables) => {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { data?: unknown; errors?: { type?: string; message: string }[] };
    // NOT_FOUND: `#N` pointed at a PR or a deleted issue; the caller sees null.
    const errors = (json.errors ?? []).filter((e) => e.type !== "NOT_FOUND");
    if (errors.length) throw new Error(`GraphQL: ${errors.map((e) => e.message).join("; ")}`);
    return json.data as never;
  };
  const rest = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}: ${await res.text()}`);
  };
  return { gql, rest };
}

type GqlActor = { login: string; __typename: string } | null;

async function fetchOpenPrs(gql: Gql, owner: string, name: string): Promise<PullRequest[]> {
  const query = `query($owner:String!,$name:String!,$cursor:String){
    repository(owner:$owner,name:$name){
      pullRequests(states:OPEN,first:50,after:$cursor,orderBy:{field:CREATED_AT,direction:ASC}){
        pageInfo{hasNextPage endCursor}
        nodes{
          number url title body createdAt isDraft authorAssociation
          author{login __typename}
          labels(first:50){nodes{name}}
          closingIssuesReferences(first:25){nodes{number repository{nameWithOwner}}}
        }
      }
    }
  }`;
  type Node = {
    number: number;
    url: string;
    title: string;
    body: string;
    createdAt: string;
    isDraft: boolean;
    authorAssociation: string;
    author: GqlActor;
    labels: { nodes: { name: string }[] };
    closingIssuesReferences: { nodes: { number: number; repository: { nameWithOwner: string } }[] };
  };
  type Data = {
    repository: { pullRequests: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Node[] } };
  };
  const repo = lower(`${owner}/${name}`);
  const prs: PullRequest[] = [];
  let cursor: string | null = null;
  do {
    const data: Data = await gql<Data>(query, { owner, name, cursor });
    const page = data.repository.pullRequests;
    for (const n of page.nodes) {
      prs.push({
        number: n.number,
        url: n.url,
        title: n.title,
        body: n.body ?? "",
        createdAt: n.createdAt,
        isDraft: n.isDraft,
        author: n.author?.login ?? "ghost",
        authorIsBot: n.author?.__typename === "Bot",
        authorAssociation: n.authorAssociation,
        labels: n.labels.nodes.map((l) => l.name),
        closingIssues: n.closingIssuesReferences.nodes
          .filter((i) => lower(i.repository.nameWithOwner) === repo)
          .map((i) => i.number),
      });
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return prs;
}

async function fetchIssue(gql: Gql, owner: string, name: string, number: number): Promise<Issue | null> {
  // shortcut: first 100 comments and assignment events only; paginate if a hot issue ever outgrows that.
  const query = `query($owner:String!,$name:String!,$number:Int!){
    repository(owner:$owner,name:$name){
      issue(number:$number){
        number url
        assignees(first:20){nodes{login}}
        comments(first:100){nodes{url createdAt body author{login __typename}}}
        timelineItems(first:100,itemTypes:[ASSIGNED_EVENT,UNASSIGNED_EVENT]){nodes{
          __typename
          ... on AssignedEvent{createdAt assignee{... on User{login} ... on Bot{login}}}
          ... on UnassignedEvent{createdAt assignee{... on User{login} ... on Bot{login}}}
        }}
      }
    }
  }`;
  type Data = {
    repository: {
      issue: {
        number: number;
        url: string;
        assignees: { nodes: { login: string }[] };
        comments: { nodes: { url: string; createdAt: string; body: string; author: GqlActor }[] };
        timelineItems: {
          nodes: { __typename: string; createdAt: string; assignee: { login?: string } | null }[];
        };
      } | null;
    } | null;
  };
  const data = await gql<Data>(query, { owner, name, number });
  const issue = data?.repository?.issue;
  if (!issue) return null;
  return {
    number: issue.number,
    url: issue.url,
    assignees: issue.assignees.nodes.map((a) => a.login),
    comments: issue.comments.nodes.map((c) => ({
      author: c.author?.login ?? "ghost",
      authorIsBot: c.author?.__typename === "Bot",
      createdAt: c.createdAt,
      body: c.body ?? "",
      url: c.url,
    })),
    assignments: issue.timelineItems.nodes
      .filter((e) => e.assignee?.login)
      .map((e) => ({
        kind: e.__typename === "AssignedEvent" ? ("assigned" as const) : ("unassigned" as const),
        login: e.assignee?.login as string,
        createdAt: e.createdAt,
      })),
  };
}

function parseArgs(argv: string[]) {
  const args = { pr: null as number | null, all: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") args.all = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--pr") args.pr = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.all && !(args.pr && Number.isInteger(args.pr))) throw new Error("Pass --pr <number> or --all.");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const repoFull = process.env.GITHUB_REPOSITORY;
  if (!token || !repoFull) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required.");
  const [owner, name] = repoFull.split("/") as [string, string];
  const { gql, rest } = makeClient(token);

  const prs = await fetchOpenPrs(gql, owner, name);
  const prsByNumber = new Map(prs.map((p) => [p.number, p]));
  const issuesOf = new Map(prs.map((p) => [p.number, linkedIssues(p, repoFull)]));
  const prsOfIssue = new Map<number, PullRequest[]>();
  for (const p of prs) for (const n of issuesOf.get(p.number) ?? []) prsOfIssue.set(n, [...(prsOfIssue.get(n) ?? []), p]);

  let closable: Set<number> | undefined;
  let scope: Set<number>;
  if (args.all) {
    scope = new Set(prsOfIssue.keys());
  } else {
    const eventPr = prsByNumber.get(args.pr as number);
    if (!eventPr) {
      console.log(`PR #${args.pr} is not open; nothing to do.`);
      return;
    }
    closable = new Set(issuesOf.get(eventPr.number) ?? []);
    // A loser may win another issue it targets; decide those issues too so it is not closed.
    scope = new Set(closable);
    for (const n of closable) for (const p of prsOfIssue.get(n) ?? []) for (const m of issuesOf.get(p.number) ?? []) scope.add(m);
  }

  const decisions: IssueDecision[] = [];
  for (const n of [...scope].sort((a, b) => a - b)) {
    const linked = prsOfIssue.get(n) ?? [];
    if (linked.length < 2) {
      if (linked[0]) decisions.push({ issue: n, pool: [linked[0].number], winner: linked[0].number, reason: { kind: "first" }, losers: [] });
      continue;
    }
    const issue = await fetchIssue(gql, owner, name, n);
    if (!issue) continue; // `#N` is a PR or a missing issue
    decisions.push(decideIssue(issue, linked));
  }
  const closures = planClosures(decisions, prsByNumber, closable);

  for (const c of closures) {
    const comment = closeComment(c, prsByNumber);
    if (args.dryRun) {
      console.log(`[dry run] would close #${c.pr.number} (@${c.pr.author}): ${c.losses.map((l) => `#${l.issue} kept #${l.winner}`).join("; ")}`);
      continue;
    }
    await rest("POST", `/repos/${owner}/${name}/issues/${c.pr.number}/comments`, { body: comment });
    await rest("PATCH", `/repos/${owner}/${name}/pulls/${c.pr.number}`, { state: "closed" });
    console.log(`Closed #${c.pr.number} (@${c.pr.author}).`);
  }
  const md = report(decisions, closures, args.dryRun);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) await Bun.write(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
