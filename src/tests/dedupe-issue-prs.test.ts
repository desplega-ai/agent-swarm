import { describe, expect, test } from "bun:test";
import {
  closeComment,
  decideIssue,
  findClaims,
  type Issue,
  type IssueDecision,
  isClaimComment,
  linkedIssues,
  type PullRequest,
  parseLinkedIssues,
  planClosures,
} from "../../scripts/dedupe-issue-prs";

const REPO = "acme/widgets";

function pr(
  number: number,
  author: string,
  createdAt: string,
  extra: Partial<PullRequest> = {},
): PullRequest {
  return {
    number,
    url: `https://github.com/${REPO}/pull/${number}`,
    title: `PR ${number}`,
    body: "",
    createdAt,
    isDraft: false,
    author,
    authorIsBot: false,
    authorAssociation: "CONTRIBUTOR",
    labels: [],
    closingIssues: [10],
    ...extra,
  };
}

function issue(extra: Partial<Issue> = {}): Issue {
  return {
    number: 10,
    url: `https://github.com/${REPO}/issues/10`,
    assignees: [],
    comments: [],
    assignments: [],
    ...extra,
  };
}

const comment = (author: string, createdAt: string, body: string) => ({
  author,
  authorIsBot: false,
  createdAt,
  body,
  url: `https://github.com/${REPO}/issues/10#issuecomment-${createdAt}`,
});

describe("decideIssue", () => {
  test("no claim: the earliest PR wins and later ones lose", () => {
    const d = decideIssue(issue(), [
      pr(3, "carol", "2026-01-03T00:00:00Z"),
      pr(1, "alice", "2026-01-01T00:00:00Z"),
      pr(2, "bob", "2026-01-02T00:00:00Z"),
    ]);
    expect(d.winner).toBe(1);
    expect(d.reason?.kind).toBe("first");
    expect(d.losers).toEqual([2, 3]);
  });

  test("a claim beats an earlier PR", () => {
    const i = issue({ comments: [comment("bob", "2025-12-31T00:00:00Z", "I’ll take it!")] });
    const d = decideIssue(i, [
      pr(1, "alice", "2026-01-01T00:00:00Z"),
      pr(2, "bob", "2026-01-02T00:00:00Z"),
    ]);
    expect(d.winner).toBe(2);
    expect(d.reason).toMatchObject({ kind: "claim", claim: { login: "bob", kind: "comment" } });
    expect(d.losers).toEqual([1]);
  });

  test("the earliest claim wins between two claimants; a claimant with no PR is skipped", () => {
    const i = issue({
      comments: [
        comment("dave", "2025-12-01T00:00:00Z", "can I take this?"),
        comment("bob", "2025-12-03T00:00:00Z", "I'm working on this"),
      ],
      assignees: ["alice"],
      assignments: [{ kind: "assigned", login: "alice", createdAt: "2025-12-02T00:00:00Z" }],
    });
    const d = decideIssue(i, [
      pr(1, "bob", "2026-01-01T00:00:00Z"),
      pr(2, "alice", "2026-01-02T00:00:00Z"),
    ]);
    expect(d.winner).toBe(2);
    expect(d.reason).toMatchObject({ kind: "claim", claim: { login: "alice", kind: "assigned" } });
  });

  test("unassigning a user voids their earlier claims", () => {
    const i = issue({
      comments: [comment("bob", "2025-12-01T00:00:00Z", "assign me please")],
      assignments: [
        { kind: "assigned", login: "bob", createdAt: "2025-12-01T01:00:00Z" },
        { kind: "unassigned", login: "bob", createdAt: "2025-12-05T00:00:00Z" },
      ],
    });
    const d = decideIssue(i, [
      pr(1, "alice", "2026-01-01T00:00:00Z"),
      pr(2, "bob", "2026-01-02T00:00:00Z"),
    ]);
    expect(d.winner).toBe(1);
    expect(d.reason?.kind).toBe("first");
  });

  test("allow-duplicate PRs are neither closed nor counted", () => {
    const d = decideIssue(issue(), [
      pr(1, "alice", "2026-01-01T00:00:00Z", { labels: ["allow-duplicate"] }),
      pr(2, "bob", "2026-01-02T00:00:00Z"),
      pr(3, "carol", "2026-01-03T00:00:00Z"),
    ]);
    expect(d.pool).toEqual([2, 3]);
    expect(d.winner).toBe(2);
    expect(d.losers).toEqual([3]);
  });

  test("a maintainer PR beats an earlier unclaimed contributor PR and is never a loser", () => {
    const d = decideIssue(issue(), [
      pr(1, "alice", "2026-01-01T00:00:00Z"),
      pr(2, "maint", "2026-01-02T00:00:00Z", { authorAssociation: "MEMBER" }),
    ]);
    expect(d.winner).toBe(2);
    expect(d.reason?.kind).toBe("maintainer");
    expect(d.losers).toEqual([1]);
  });

  test("a contributor who claimed first beats a maintainer, and the maintainer PR stays open", () => {
    const i = issue({ comments: [comment("alice", "2025-12-01T00:00:00Z", "I'll work on this")] });
    const d = decideIssue(i, [
      pr(1, "maint", "2026-01-01T00:00:00Z", { authorAssociation: "OWNER" }),
      pr(2, "alice", "2026-01-02T00:00:00Z"),
      pr(3, "bob", "2026-01-03T00:00:00Z"),
    ]);
    expect(d.winner).toBe(2);
    expect(d.losers).toEqual([3]);
  });

  test("bot PRs are ignored and drafts still count", () => {
    const d = decideIssue(issue(), [
      pr(1, "dependabot[bot]", "2026-01-01T00:00:00Z"),
      pr(2, "renovate", "2026-01-01T00:00:00Z", { authorIsBot: true }),
      pr(3, "alice", "2026-01-02T00:00:00Z", { isDraft: true }),
      pr(4, "bob", "2026-01-03T00:00:00Z"),
    ]);
    expect(d.pool).toEqual([3, 4]);
    expect(d.winner).toBe(3);
    expect(d.losers).toEqual([4]);
  });
});

describe("planClosures", () => {
  test("a PR that lost one issue but won another stays open", () => {
    const a = pr(1, "alice", "2026-01-01T00:00:00Z");
    const b = pr(2, "bob", "2026-01-02T00:00:00Z", { closingIssues: [10, 11] });
    const c = pr(3, "carol", "2026-01-03T00:00:00Z");
    const prs = new Map([a, b, c].map((p) => [p.number, p]));
    const decisions: IssueDecision[] = [
      { issue: 10, pool: [1, 2, 3], winner: 1, reason: { kind: "first" }, losers: [2, 3] },
      { issue: 11, pool: [2], winner: 2, reason: { kind: "first" }, losers: [] },
    ];
    const closures = planClosures(decisions, prs);
    expect(closures.map((x) => x.pr.number)).toEqual([3]);
    expect(closeComment(closures[0] as (typeof closures)[0], prs)).toContain(
      "kept #1, because it was opened first",
    );
  });

  test("closable issues limit an event run", () => {
    const a = pr(1, "alice", "2026-01-01T00:00:00Z");
    const b = pr(2, "bob", "2026-01-02T00:00:00Z");
    const prs = new Map([a, b].map((p) => [p.number, p]));
    const decisions: IssueDecision[] = [
      { issue: 10, pool: [1, 2], winner: 1, reason: { kind: "first" }, losers: [2] },
    ];
    expect(planClosures(decisions, prs, new Set([99]))).toEqual([]);
  });
});

describe("claims and links", () => {
  test("claim phrases match, questions and quotes do not", () => {
    for (const body of [
      "Ill take it",
      "I’ll take this one",
      "can i take this?",
      "Assign me",
      "assign this to me",
      "I'm working on this",
      "working on it, PR soon",
    ]) {
      expect(isClaimComment(body)).toBe(true);
    }
    for (const body of [
      "Is anyone working on this?",
      "> I'll take it\n\nnice",
      "This is a duplicate of #3",
      "<!-- I'll take it -->",
    ]) {
      expect(isClaimComment(body)).toBe(false);
    }
  });

  test("bot comments never claim", () => {
    const i = issue({
      comments: [{ ...comment("ci", "2025-12-01T00:00:00Z", "I'll take it"), authorIsBot: true }],
    });
    expect(findClaims(i)).toEqual([]);
  });

  test("body keywords link same-repo issues only, outside comments", () => {
    const body = [
      "Fixes #12, closes acme/widgets#13 and resolves https://github.com/acme/widgets/issues/14.",
      "Fixes other/repo#15. See #16.",
      "<!-- Fixes #17 -->",
    ].join("\n");
    expect(parseLinkedIssues(body, REPO)).toEqual([12, 13, 14]);
    expect(
      linkedIssues(pr(1, "a", "2026-01-01T00:00:00Z", { body, closingIssues: [10, 12] }), REPO),
    ).toEqual([10, 12, 13, 14]);
  });
});
