import { z } from "zod";

export const argsSchema = z.object({
  repo: z.string().optional().describe("Repository in 'owner/name' form, e.g. 'owner/name'"),
  number: z.number().int().positive().optional().describe("Pull request number"),
  skipIfMissing: z
    .boolean()
    .optional()
    .describe("Return a skipped result when repo/number are absent instead of validating them"),
  token: z
    .string()
    .optional()
    .describe("GitHub token override; falls back to the GITHUB_TOKEN swarm config"),
});

/**
 * One shared deadline for every network call this script makes.
 *
 * The swarm-script subprocess has a 30s wall clock that a script cannot catch:
 * if GitHub accepts the connection and then stalls, the runtime kills the
 * process before the `{ error }` degrade can be returned, and this node is the
 * sole predecessor of the reflect / skills / hygiene lanes — so an optional
 * enrichment would take the whole dream down with it. A single budget shared
 * across all four fetches bounds the total, not just each attempt.
 */
const FETCH_BUDGET_MS = 20_000;

async function resolveSecret(
  ctx: any,
  key: string,
  override: unknown,
  signal: AbortSignal,
): Promise<string | null> {
  if (typeof override === "string" && override.length > 0) return override;
  try {
    const base = ctx.stdlib.Redacted.value(ctx.swarm.config.mcpBaseUrl).replace(/\/+$/, "");
    const apiKey = ctx.stdlib.Redacted.value(ctx.swarm.config.apiKey);
    const res: any = await ctx.stdlib.fetchJson(
      base + "/api/config/resolved?includeSecrets=true",
      { headers: { Authorization: "Bearer " + apiKey }, signal },
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

/** One-call GitHub PR snapshot: state, draft, mergeable, CI checks and review tallies. */
export default async function ghPrSnapshot(args: any, ctx: any) {
  // NEVER throw: this snapshot is optional enrichment inside the Dreaming DAG, and
  // an instant-node failure is not softened by onNodeFailure:"continue" — a
  // transient GitHub/network outage must degrade to an { error } result, not take
  // the reflection/skills/hygiene lanes down with it.
  try {
    return await ghPrSnapshotInner(args, ctx);
  } catch (error) {
    return {
      error: `snapshot fetch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function ghPrSnapshotInner(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };
  const { repo, number } = parsed.data;
  if (parsed.data.skipIfMissing && (repo === undefined || number === undefined)) {
    return { skipped: true, reason: "no pull request rotation target" };
  }
  if (repo === undefined || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    return { error: "repo must be in 'owner/name' form" };
  }
  if (number === undefined) return { error: "number is required" };

  const deadline = AbortSignal.timeout(FETCH_BUDGET_MS);
  const token = await resolveSecret(ctx, "GITHUB_TOKEN", parsed.data.token, deadline);
  const headers: any = {
    Accept: "application/vnd.github+json",
    "User-Agent": "agent-swarm-scripts",
  };
  if (token) headers.Authorization = "Bearer " + token;

  const api = "https://api.github.com/repos/" + repo;
  const pr: any = await ctx.stdlib.fetchJson(api + "/pulls/" + number, {
    headers,
    signal: deadline,
  });
  if (!pr || typeof pr.number !== "number") {
    const why = pr && pr.message ? pr.message : "not found or not accessible";
    return { error: "PR " + repo + "#" + number + ": " + why };
  }

  const checks = { passed: 0, failed: 0, pending: 0 };
  const sha = pr.head && pr.head.sha ? pr.head.sha : null;
  if (sha) {
    const runs: any = await ctx.stdlib.fetchJson(api + "/commits/" + sha + "/check-runs", {
      headers,
      signal: deadline,
    });
    const list: any = runs && Array.isArray(runs.check_runs) ? runs.check_runs : [];
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

  const reviewsRaw: any = await ctx.stdlib.fetchJson(api + "/pulls/" + number + "/reviews", {
    headers,
    signal: deadline,
  });
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

  return {
    title: pr.title,
    state: pr.merged_at ? "merged" : pr.state,
    draft: Boolean(pr.draft),
    mergeable: pr.mergeable,
    checks,
    reviews,
    url: pr.html_url,
  };
}
