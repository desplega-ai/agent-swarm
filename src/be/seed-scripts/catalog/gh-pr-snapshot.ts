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
  if (at?.[1] && at[2]) {
    const ref = parseRef(at[1]);
    return { ...ref, expectHead: at[2] };
  }
  let m = spec.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);
  if (m?.[1]) return { repo: m[1], number: Number(m[2]) };
  m = spec.match(/^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/);
  if (m?.[1]) return { repo: m[1], number: Number(m[2]) };
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

type Bucket = "pass" | "skipped" | "failing" | "pending";

/** Worst first. A push run and a pull_request run of one check collapse to the worse one. */
const RANK: Record<Bucket, number> = { failing: 3, pending: 2, pass: 1, skipped: 0 };

function runBucket(run: any): Bucket {
  const c = String(run?.conclusion ?? "").toLowerCase();
  if (run?.status !== "completed") return "pending";
  if (c === "success") return "pass";
  if (c === "skipped" || c === "neutral") return "skipped";
  return "failing";
}

function statusBucket(state: unknown): Bucket {
  const s = String(state ?? "").toLowerCase();
  if (s === "success") return "pass";
  if (s === "pending" || s === "expected") return "pending";
  return "failing";
}

/** A required check from the rulesets. `appId` set: only that GitHub App's check run satisfies it. */
type RequiredCheck = { name: string; appId: number | null };

/**
 * Grade CI on the head. Tallies count one bucket per check name (worst wins) over check
 * runs and the commit statuses of required names. Each required entry grades its own
 * sources, worst wins: same-name check runs (only from `appId` when pinned) and same-name
 * commit statuses. A status cannot be tied to an app, so for a pinned entry it can only
 * pull the entry down (pending or failing), never satisfy it. A required entry with no
 * source is pending. `required: null` (rulesets unreadable) or `statuses: null` (status
 * read failed) leaves the gate unknown: it counts as one pending check and CI never reads
 * green. With no required checks, every check gates.
 */
function gradeChecks(runs: any[], statuses: any[] | null, required: RequiredCheck[] | null) {
  type Hit = { bucket: Bucket; url: string | null };
  const worse = (cur: Hit | null, bucket: Bucket, url: string | null): Hit =>
    !cur || RANK[bucket] > RANK[cur.bucket] ? { bucket, url } : cur;
  const requiredNames = new Set((required ?? []).map((r) => r.name));
  const byName = new Map<string, Hit>();
  for (const run of runs) {
    const name = String(run?.name ?? "");
    byName.set(name, worse(byName.get(name) ?? null, runBucket(run), run?.html_url ?? null));
  }
  for (const s of statuses ?? []) {
    const name = String(s?.context ?? "");
    if (!requiredNames.has(name)) continue;
    byName.set(name, worse(byName.get(name) ?? null, statusBucket(s?.state), s?.target_url ?? null));
  }

  const summary = {
    pass: 0,
    skipped: 0,
    failing: 0,
    pending: 0,
    requiredFailing: 0,
    requiredPending: 0,
  };
  for (const { bucket } of byName.values()) summary[bucket]++;
  // A required name with no run or status at all is one more pending check in the tallies.
  for (const name of requiredNames) if (!byName.has(name)) summary.pending++;
  const requiredChecks =
    required === null
      ? null
      : required.map(({ name, appId }) => {
          let hit: Hit | null = null;
          for (const run of runs) {
            if (String(run?.name ?? "") !== name) continue;
            if (appId !== null && run?.app?.id !== appId) continue;
            hit = worse(hit, runBucket(run), run?.html_url ?? null);
          }
          for (const s of statuses ?? []) {
            if (String(s?.context ?? "") !== name) continue;
            const bucket = statusBucket(s?.state);
            if (appId !== null && bucket === "pass") continue;
            hit = worse(hit, bucket, s?.target_url ?? null);
          }
          return { name, appId, state: hit ? hit.bucket : ("pending" as Bucket), url: hit?.url ?? null };
        });
  const unknown = requiredChecks === null || (requiredNames.size > 0 && statuses === null);
  if (unknown) summary.pending++;
  for (const r of requiredChecks ?? []) {
    if (r.state === "failing") summary.requiredFailing++;
    if (r.state === "pending") summary.requiredPending++;
  }

  let ciGreen: boolean;
  if (unknown || requiredChecks === null) ciGreen = false;
  else if (requiredChecks.length > 0)
    ciGreen = requiredChecks.every((r) => r.state === "pass" || r.state === "skipped");
  else ciGreen = summary.failing === 0 && summary.pending === 0;

  return {
    checks: { passed: summary.pass, failed: summary.failing, pending: summary.pending },
    summary,
    requiredChecks,
    ciGreen,
  };
}

/** Required status checks on `base`, from repository rulesets, with their app pin. Throws when unreadable. */
async function requiredChecksFor(
  ctx: any,
  headers: any,
  api: string,
  base: string,
): Promise<RequiredCheck[]> {
  const rules = await gh(
    ctx,
    headers,
    `${api}/rules/branches/${encodeURIComponent(base)}?per_page=100`,
  );
  if (!Array.isArray(rules)) throw new Error("rules response is not a list");
  const out = new Map<string, RequiredCheck>();
  for (const rule of rules) {
    if (rule?.type !== "required_status_checks") continue;
    for (const c of rule.parameters?.required_status_checks ?? []) {
      if (typeof c?.context !== "string") continue;
      const appId = typeof c.integration_id === "number" ? c.integration_id : null;
      out.set(c.context + "\u0000" + (appId ?? ""), { name: c.context, appId });
    }
  }
  return [...out.values()];
}

/** All check runs on the head, paged: a required run past the first page must not read absent. */
async function checkRunsOn(ctx: any, headers: any, api: string, sha: string) {
  const out: any[] = [];
  for (let page = 1; page <= 5; page++) {
    const res: any = await gh(
      ctx,
      headers,
      `${api}/commits/${sha}/check-runs?per_page=100&page=${page}`,
    );
    const list: any[] = res && Array.isArray(res.check_runs) ? res.check_runs : [];
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}

/**
 * Every commit status on the head, paged. A required status past the first page must not read
 * absent, so a malformed page, a later page whose `total_count` differs from page one's, or a read
 * that stops short of `total_count` throws instead.
 */
async function commitStatusesOn(ctx: any, headers: any, api: string, sha: string) {
  const out: any[] = [];
  let total = 0;
  for (let page = 1; page <= 5; page++) {
    const res: any = await gh(ctx, headers, `${api}/commits/${sha}/status?per_page=100&page=${page}`);
    if (!res || !Array.isArray(res.statuses)) throw new Error(`status page ${page} is malformed`);
    if (typeof res.total_count !== "number" || !Number.isFinite(res.total_count)) {
      throw new Error(`status page ${page} has no numeric total_count`);
    }
    if (page === 1) total = res.total_count;
    else if (res.total_count !== total) {
      throw new Error(`status page ${page} changed total_count from ${total} to ${res.total_count}`);
    }
    out.push(...res.statuses);
    if (out.length >= total || res.statuses.length < 100) break;
  }
  if (out.length < total) {
    throw new Error(`read ${out.length} of ${total} statuses within 5 pages`);
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
  const cs = gradeChecks(
    [
      { status: "completed", conclusion: "success", name: "lint" },
      { status: "completed", conclusion: "skipped", name: "e2e" },
      { status: "completed", conclusion: "neutral", name: "info" },
      { status: "completed", conclusion: "failure", name: "build" },
      { status: "completed", conclusion: "cancelled", name: "tsc" },
      { status: "in_progress", conclusion: null, name: "test" },
      // push and pull_request runs of one check: the failure wins
      { status: "completed", conclusion: "success", name: "unit" },
      { status: "completed", conclusion: "failure", name: "unit" },
    ],
    [{ context: "deploy", state: "success" }],
    ["build", "absent", "deploy"].map((name) => ({ name, appId: null })),
  );
  const pin = [{ name: "gate", appId: 7 }];
  const pinnedForeign = gradeChecks(
    [{ status: "completed", conclusion: "success", name: "gate", app: { id: 8 } }],
    [{ context: "gate", state: "success" }],
    pin,
  );
  const pinnedOwn = gradeChecks(
    [{ status: "completed", conclusion: "success", name: "gate", app: { id: 7 } }],
    [],
    pin,
  );
  const statusWorst = gradeChecks(
    [{ status: "completed", conclusion: "success", name: "gate" }],
    [{ context: "gate", state: "failure" }],
    [{ name: "gate", appId: null }],
  );
  const statusUnread = gradeChecks(
    [{ status: "completed", conclusion: "success", name: "gate" }],
    null,
    [{ name: "gate", appId: null }],
  );
  const unknownGate = gradeChecks(
    [{ status: "completed", conclusion: "success", name: "lint" }],
    [],
    null,
  );
  const noRequired = gradeChecks(
    [{ status: "completed", conclusion: "success", name: "lint" }],
    [],
    [],
  );
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
      cs.summary.pass === 2 &&
      cs.summary.skipped === 2 &&
      cs.summary.failing === 3 &&
      cs.summary.pending === 2 &&
      cs.summary.requiredFailing === 1 &&
      cs.summary.requiredPending === 1 &&
      cs.checks.failed === 3 &&
      cs.ciGreen === false,
    absentRequiredPending: cs.requiredChecks?.find((r) => r.name === "absent")?.state === "pending",
    requiredStatusCounts: cs.requiredChecks?.find((r) => r.name === "deploy")?.state === "pass",
    unknownGateNotGreen:
      unknownGate.ciGreen === false &&
      unknownGate.requiredChecks === null &&
      unknownGate.checks.pending === 1,
    noRequiredAllGate: noRequired.ciGreen === true,
    pinnedForeignAppNotGreen: pinnedForeign.ciGreen === false && pinnedOwn.ciGreen === true,
    statusWorstWins: statusWorst.requiredChecks?.[0]?.state === "failing" && !statusWorst.ciGreen,
    statusUnreadNotGreen: statusUnread.ciGreen === false && statusUnread.checks.pending === 1,
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
  rulesCache: Map<string, Promise<RequiredCheck[]>>,
  expectHead?: string,
) {
  const api = "https://api.github.com/repos/" + repo;
  const pr: any = await gh(ctx, headers, api + "/pulls/" + number);
  if (!pr || typeof pr.number !== "number") {
    throw new Error("PR " + repo + "#" + number + ": not found or not accessible");
  }

  const sha = pr.head && pr.head.sha ? pr.head.sha : null;
  const base = pr.base?.ref ?? null;
  let required: RequiredCheck[] | null = null;
  let requiredChecksError: string | null = null;
  if (base) {
    const key = repo + "@" + base;
    if (!rulesCache.has(key)) rulesCache.set(key, requiredChecksFor(ctx, headers, api, base));
    try {
      required = await rulesCache.get(key)!;
    } catch (error) {
      requiredChecksError =
        "could not read required checks: " + (error instanceof Error ? error.message : String(error));
    }
  } else {
    requiredChecksError = "PR has no base branch";
  }

  let checkList: any[] = [];
  let statusList: any[] | null = [];
  if (sha) {
    checkList = await checkRunsOn(ctx, headers, api, sha);
    // A required name grades its check runs and commit statuses together, so read both.
    if (required && required.length > 0) {
      try {
        statusList = await commitStatusesOn(ctx, headers, api, sha);
      } catch (error) {
        // An unread or partial status read could hide a failing required one: CI stays not green.
        statusList = null;
        requiredChecksError =
          "could not read commit statuses: " + (error instanceof Error ? error.message : String(error));
      }
    }
  }
  const graded = gradeChecks(checkList, statusList, required);
  const checks = graded.checks;

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
    checksSummary: graded.summary,
    requiredChecks: graded.requiredChecks,
    requiredChecksError,
    ciGreen: graded.ciGreen,
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
 * Europe/Madrid), CI checks graded against the base branch's ruleset required checks
 * (`requiredChecks`, `ciGreen`), review tallies, and optionally unresolved review threads.
 * Check tallies count one result per check name, the worst of its runs.
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

  // One rulesets read per repo and base branch, shared across a batch.
  const rulesCache = new Map<string, Promise<RequiredCheck[]>>();
  const results: any[] = new Array(refs.length);
  let next = 0;
  async function worker() {
    while (next < refs.length) {
      const i = next++;
      const { repo, number, expectHead } = refs[i]!;
      try {
        results[i] = await snapshot(
          ctx,
          headers,
          repo,
          number,
          includeThreads,
          rulesCache,
          expectHead,
        );
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
