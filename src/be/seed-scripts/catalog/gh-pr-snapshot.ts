import { z } from "zod";

export const argsSchema = z.object({
  repo: z.string().optional().describe("Repository in 'owner/name' form, e.g. 'owner/name'"),
  number: z.number().int().positive().optional().describe("Pull request number"),
  prs: z
    .array(z.string())
    .min(1)
    .max(10)
    .optional()
    .describe("Batch mode: up to 10 PRs as 'owner/repo#N' or PR URLs, each optionally suffixed '@<sha prefix>' to set its expected head. Returns { ok, errors, prs: [...] }"),
  includeThreads: z
    .boolean()
    .optional()
    .describe("Also return unresolved, non-outdated review threads as { path, line, author, body, url }"),
  expectHead: z
    .string()
    .regex(/^[0-9a-fA-F]{7,40}$/, "expectHead must be a 7-40 char hex SHA prefix")
    .optional()
    .describe("Expected head SHA prefix (7+ hex chars). Sets headMatchesExpected true/false; null when not given"),
  token: z
    .string()
    .optional()
    .describe("GitHub token override; falls back to the GITHUB_TOKEN swarm config"),
});

const MAX_CONCURRENCY = 3;

async function resolveSecret(ctx: any, key: string, override: unknown): Promise<string | null> {
  if (typeof override === "string" && override.length > 0) return override;
  try {
    const base = ctx.stdlib.Redacted.value(ctx.swarm.config.mcpBaseUrl).replace(/\/+$/, "");
    const apiKey = ctx.stdlib.Redacted.value(ctx.swarm.config.apiKey);
    const res: any = await ctx.stdlib.fetchJson(
      base + "/api/config/resolved?includeSecrets=true",
      { headers: { Authorization: "Bearer " + apiKey } },
    );
    const configs: any = res && Array.isArray(res.configs) ? res.configs : [];
    for (const c of configs) {
      if (c && c.key === key && typeof c.value === "string" && c.value.length > 0) {
        return c.value;
      }
    }
  } catch {
    // Best-effort: a missing config row just means we proceed unauthenticated.
  }
  return null;
}

function parseRef(input: string): { repo: string; number: number; expectHead?: string } {
  let spec = String(input || "").trim();
  const at = spec.match(/^(.*)@([0-9a-fA-F]{7,40})$/);
  if (at) {
    const ref = parseRef(at[1]);
    return { ...ref, expectHead: at[2] };
  }
  let m = spec.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);
  if (m) return { repo: m[1], number: Number(m[2]) };
  m = spec.match(/^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/);
  if (m) return { repo: m[1], number: Number(m[2]) };
  throw new Error("PR must be 'owner/repo#N' or a GitHub pull request URL: " + spec);
}

function madrid(iso: string | null): string | null {
  if (!iso) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(new Date(iso));
  const p: any = {};
  for (const part of parts) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/** true/false against a 7+ char hex prefix; null when no expectation was given. */
function headMatches(sha: string | null, expect: string | undefined): boolean | null {
  if (!expect) return null;
  if (!sha) return false;
  return sha.toLowerCase().startsWith(expect.toLowerCase());
}

const REQUIRED_CHECK = "Merge Gate";

/** Grouped CI counts. SKIPPED and NEUTRAL count as skipped; `Merge Gate` is the required check. */
function summarizeChecks(list: any[]) {
  const out = { pass: 0, skipped: 0, failing: 0, pending: 0, requiredFailing: 0 };
  for (const run of list) {
    const c = String(run?.conclusion ?? "").toLowerCase();
    if (run?.status !== "completed") out.pending++;
    else if (c === "success") out.pass++;
    else if (c === "skipped" || c === "neutral") out.skipped++;
    else {
      out.failing++;
      if (run?.name === REQUIRED_CHECK) out.requiredFailing++;
    }
  }
  return out;
}

/** Latest submitted review (PENDING drafts excluded) and whether it was left on the current head. */
function latestReviewOf(list: any[], headSha: string | null) {
  const submitted = list.filter((r) => r && r.state && r.state !== "PENDING");
  const r = submitted[submitted.length - 1];
  if (!r) return null;
  const commitSha = r.commit_id ?? null;
  return {
    state: r.state,
    author: r.user?.login ?? null,
    commitSha,
    matchesHead: Boolean(commitSha && headSha && commitSha === headSha),
  };
}

/** Synthetic fixtures through the live helpers: no live PR state can void them. */
function selfControls() {
  const sha = "c72be2f61d36ffdbfe0de1b5e55e770e755b4a72";
  const cs = summarizeChecks([
    { status: "completed", conclusion: "success", name: "lint" },
    { status: "completed", conclusion: "skipped", name: "e2e" },
    { status: "completed", conclusion: "neutral", name: "info" },
    { status: "completed", conclusion: "failure", name: REQUIRED_CHECK },
    { status: "completed", conclusion: "cancelled", name: "tsc" },
    { status: "in_progress", conclusion: null, name: "test" },
  ]);
  const lr = latestReviewOf(
    [
      { state: "CHANGES_REQUESTED", user: { login: "a" }, commit_id: "0".repeat(40) },
      { state: "APPROVED", user: { login: "b" }, commit_id: sha },
      { state: "PENDING", user: { login: "c" }, commit_id: sha },
    ],
    sha,
  );
  const cases = {
    headPositive: headMatches(sha, "C72BE2F") === true,
    headNegative: headMatches(sha, "deadbeef") === false,
    headUnset: headMatches(sha, undefined) === null,
    checks:
      cs.pass === 1 && cs.skipped === 2 && cs.failing === 2 && cs.pending === 1 && cs.requiredFailing === 1,
    latestReview: lr?.state === "APPROVED" && lr?.author === "b" && lr?.matchesHead === true,
    noReviews: latestReviewOf([], sha) === null,
  };
  return { ok: Object.values(cases).every(Boolean), cases };
}

/** GET/POST that fails loudly: a 404 or error body is an exception, never a quiet empty result. */
async function gh(ctx: any, headers: any, url: string, body?: unknown): Promise<any> {
  const res: any = await ctx.stdlib.fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON bodies fall through to the status check below.
  }
  if (!res.ok) {
    const why = json && json.message ? json.message : text.slice(0, 200);
    throw new Error(`GitHub ${res.status} ${why}`);
  }
  if (json && Array.isArray(json.errors) && json.errors.length) {
    throw new Error("GraphQL errors: " + JSON.stringify(json.errors).slice(0, 300));
  }
  return json;
}

const THREADS_QUERY = `
query PrThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved isOutdated path line originalLine
          comments(first: 1) { nodes { author { login } body url } }
        }
      }
    }
  }
}`;

/** Unresolved, non-outdated review threads: the same rule `pr-review-status` uses for actionItems. */
async function unresolvedThreads(ctx: any, headers: any, repo: string, number: number) {
  const [owner, name] = repo.split("/");
  const out: any[] = [];
  let after: string | null = null;
  for (;;) {
    const json = await gh(ctx, headers, "https://api.github.com/graphql", {
      query: THREADS_QUERY,
      variables: { owner, repo: name, number, after },
    });
    const conn = json?.data?.repository?.pullRequest?.reviewThreads;
    if (!conn) throw new Error(`review threads unavailable for ${repo}#${number}`);
    for (const t of conn.nodes) {
      if (t.isResolved || t.isOutdated) continue;
      const c = t.comments?.nodes?.[0] ?? {};
      out.push({
        path: t.path ?? null,
        line: t.line ?? t.originalLine ?? null,
        author: c.author?.login ?? null,
        body: c.body ?? "",
        url: c.url ?? null,
      });
    }
    if (!conn.pageInfo.hasNextPage) return out;
    after = conn.pageInfo.endCursor;
  }
}

/**
 * GitHub's API exposes no list of conflicted paths. The closest signal is the set of
 * files changed on both sides since the merge base: a superset of the true conflicts.
 * It compares against the base branch tip; `pr.base.sha` can lag it and hide every overlap.
 * The compare API caps its file list at 300 and one PR files page holds 100, so a capped
 * side sets `complete: false`: the list is then partial, and an empty one proves nothing.
 * For the exact list, run `git merge-tree --write-tree --name-only <base> <head>` locally.
 */
async function conflictCandidates(ctx: any, headers: any, api: string, pr: any, number: number) {
  const compare = await gh(ctx, headers, `${api}/compare/${pr.base.ref}...${pr.head.sha}`);
  const mergeBase = compare?.merge_base_commit?.sha;
  if (!mergeBase) return { files: null, complete: false };
  const baseSide = await gh(ctx, headers, `${api}/compare/${mergeBase}...${pr.base.ref}`);
  const baseList: any[] = Array.isArray(baseSide?.files) ? baseSide.files : [];
  const baseFiles = new Set<string>(baseList.map((f: any) => f.filename));
  const prFiles = await gh(ctx, headers, `${api}/pulls/${number}/files?per_page=100`);
  const prList: any[] = Array.isArray(prFiles) ? prFiles : [];
  return {
    files: prList.map((f: any) => f.filename).filter((f: string) => baseFiles.has(f)),
    complete: baseList.length < 300 && prList.length < 100 && prList.length === pr.changed_files,
  };
}

async function snapshot(
  ctx: any,
  headers: any,
  repo: string,
  number: number,
  includeThreads: boolean,
  expectHead?: string,
) {
  const api = "https://api.github.com/repos/" + repo;
  const pr: any = await gh(ctx, headers, api + "/pulls/" + number);
  if (!pr || typeof pr.number !== "number") {
    throw new Error("PR " + repo + "#" + number + ": not found or not accessible");
  }

  const checks = { passed: 0, failed: 0, pending: 0 };
  let checkList: any[] = [];
  const sha = pr.head && pr.head.sha ? pr.head.sha : null;
  if (sha) {
    const runs: any = await gh(ctx, headers, api + "/commits/" + sha + "/check-runs?per_page=100");
    const list: any = runs && Array.isArray(runs.check_runs) ? runs.check_runs : [];
    checkList = list;
    for (const run of list) {
      if (run.status !== "completed") checks.pending++;
      else if (run.conclusion === "success") checks.passed++;
      else if (
        run.conclusion === "failure" ||
        run.conclusion === "timed_out" ||
        run.conclusion === "cancelled" ||
        run.conclusion === "action_required"
      ) {
        checks.failed++;
      }
    }
  }

  const reviewsRaw: any = await gh(ctx, headers, api + "/pulls/" + number + "/reviews?per_page=100");
  const reviewList: any = Array.isArray(reviewsRaw) ? reviewsRaw : [];
  const latestByUser: any = {};
  for (const r of reviewList) {
    const user = r && r.user && r.user.login ? r.user.login : "unknown";
    if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") {
      latestByUser[user] = r.state;
    }
  }
  const reviews = { approved: 0, changesRequested: 0, pending: 0 };
  for (const user of Object.keys(latestByUser)) {
    if (latestByUser[user] === "APPROVED") reviews.approved++;
    else reviews.changesRequested++;
  }
  reviews.pending = Array.isArray(pr.requested_reviewers) ? pr.requested_reviewers.length : 0;

  const out: any = {
    pr: repo + "#" + number,
    title: pr.title,
    state: pr.merged_at ? "merged" : pr.state,
    draft: Boolean(pr.draft),
    mergeable: pr.mergeable,
    mergeableState: pr.mergeable_state ?? null,
    headSha: sha,
    mergedAt: pr.merged_at ?? null,
    mergedAtMadrid: madrid(pr.merged_at ?? null),
    checks,
    reviews,
    url: pr.html_url,
    headMatchesExpected: headMatches(sha, expectHead),
    baseRefName: pr.base?.ref ?? null,
    baseIsDefault: pr.base?.ref && pr.base?.repo?.default_branch ? pr.base.ref === pr.base.repo.default_branch : null,
    checksSummary: summarizeChecks(checkList),
    latestReview: latestReviewOf(reviewList, sha),
  };
  if (pr.state === "open" && pr.mergeable === false && pr.mergeable_state === "dirty") {
    const conflict = await conflictCandidates(ctx, headers, api, pr, number);
    out.conflictCandidateFiles = conflict.files;
    out.conflictCandidatesComplete = conflict.complete;
  }
  if (includeThreads) out.unresolvedThreads = await unresolvedThreads(ctx, headers, repo, number);
  return out;
}

/**
 * One-call GitHub PR snapshot: state, draft, mergeable, head SHA, merge time (UTC and
 * Europe/Madrid), CI checks, review tallies, and optionally unresolved review threads.
 * Single mode ({ repo, number }) returns the snapshot or { error }. Batch mode ({ prs })
 * returns { ok, errors, prs }, where a failed PR carries { pr, error } and sets ok=false.
 */
export default async function ghPrSnapshot(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args ?? {});
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };
  const a = parsed.data;
  const includeThreads = Boolean(a.includeThreads);

  const controls = selfControls();
  let refs: { repo: string; number: number; expectHead?: string }[];
  try {
    if (a.prs) refs = a.prs.map(parseRef);
    else if (a.repo !== undefined && a.number !== undefined)
      refs = [{ repo: a.repo, number: a.number, expectHead: a.expectHead }];
    else return { error: "pass either prs: ['owner/repo#N'] or repo + number" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  for (const r of refs) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(r.repo)) return { error: "repo must be in 'owner/name' form" };
  }

  const token = await resolveSecret(ctx, "GITHUB_TOKEN", a.token);
  const headers: any = {
    Accept: "application/vnd.github+json",
    "User-Agent": "agent-swarm-scripts",
  };
  if (token) headers.Authorization = "Bearer " + token;

  const results: any[] = new Array(refs.length);
  let next = 0;
  async function worker() {
    while (next < refs.length) {
      const i = next++;
      const { repo, number, expectHead } = refs[i];
      try {
        results[i] = await snapshot(ctx, headers, repo, number, includeThreads, expectHead);
      } catch (error) {
        results[i] = {
          pr: repo + "#" + number,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, refs.length) }, worker));

  if (!a.prs) {
    const one = results[0];
    return one.error ? { error: "PR " + one.pr + ": " + one.error, controls } : { ...one, controls };
  }
  const errors = results.filter((r) => r.error).length;
  return { ok: errors === 0, errors, prs: results, controls };
}
