import { z } from "zod";

export const argsSchema = z.object({
  repo: z.string().describe("Repository in 'owner/name' form, e.g. 'owner/name'"),
  number: z.number().int().positive().describe("Pull request number"),
  token: z
    .string()
    .optional()
    .describe("GitHub token override; falls back to the GITHUB_TOKEN swarm config"),
});

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

/** One-call GitHub PR snapshot: state, draft, mergeable, CI checks and review tallies. */
export default async function ghPrSnapshot(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };
  const { repo, number } = parsed.data;
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    return { error: "repo must be in 'owner/name' form" };
  }

  const token = await resolveSecret(ctx, "GITHUB_TOKEN", parsed.data.token);
  const headers: any = {
    Accept: "application/vnd.github+json",
    "User-Agent": "agent-swarm-scripts",
  };
  if (token) headers.Authorization = "Bearer " + token;

  const api = "https://api.github.com/repos/" + repo;
  const pr: any = await ctx.stdlib.fetchJson(api + "/pulls/" + number, { headers });
  if (!pr || typeof pr.number !== "number") {
    const why = pr && pr.message ? pr.message : "not found or not accessible";
    return { error: "PR " + repo + "#" + number + ": " + why };
  }

  const checks = { passed: 0, failed: 0, pending: 0 };
  const sha = pr.head && pr.head.sha ? pr.head.sha : null;
  if (sha) {
    const runs: any = await ctx.stdlib.fetchJson(api + "/commits/" + sha + "/check-runs", {
      headers,
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
