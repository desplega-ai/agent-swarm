import { githubApiUrl } from "../utils/github-host";
import { getWorkerInstallationToken } from "./app";

export type PullRequestState = {
  merged: boolean;
  state: "open" | "closed";
  headSha: string;
  baseRef: string;
};

/**
 * GET one GitHub REST path. Sends the App installation token when one is
 * configured, else `GITHUB_TOKEN`, else reads unauthenticated. Unauthenticated
 * reads share GitHub's 60 requests/hour per IP, which one PR's burst of
 * check_run candidates spends before its last required check finishes.
 * Throws on any non-2xx so a failed read never counts as an answer.
 */
async function githubGet<T>(path: string, what: string): Promise<T> {
  const auth = await getWorkerInstallationToken();
  const token = auth.status === "ok" ? auth.token : process.env.GITHUB_TOKEN?.trim();
  const response = await fetch(githubApiUrl(path), {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${what}`);
  return (await response.json()) as T;
}

/** Read one PR from GitHub. A webhook only names a candidate; callers that wake an agent confirm here first. */
export async function fetchPullRequestState(
  repo: string,
  number: number,
): Promise<PullRequestState> {
  const pr = await githubGet<{
    merged?: boolean;
    state?: string;
    head?: { sha?: string };
    base?: { ref?: string };
  }>(`/repos/${repo}/pulls/${number}`, `${repo}#${number}`);
  return {
    merged: pr.merged === true,
    state: pr.state === "open" ? "open" : "closed",
    headSha: pr.head?.sha ?? "",
    baseRef: pr.base?.ref ?? "",
  };
}

export type RequiredCheckState = {
  name: string;
  /** False while the check is queued, running, or has not reported on the SHA yet. */
  complete: boolean;
  conclusion: string | null;
  completedAt: string | null;
};

/**
 * The required status checks the base branch's rulesets name, each read on `sha`.
 * A check counts as complete on any conclusion; a required check that has not
 * reported yet is incomplete. Throws when the branch has no required checks:
 * "all required checks are done" would then be vacuously true.
 */
export async function fetchRequiredCheckStates(
  repo: string,
  baseRef: string,
  sha: string,
): Promise<RequiredCheckState[]> {
  const rules = await githubGet<
    Array<{
      type?: string;
      parameters?: { required_status_checks?: Array<{ context: string; integration_id?: number }> };
    }>
  >(`/repos/${repo}/rules/branches/${encodeURIComponent(baseRef)}`, `${repo} rules on ${baseRef}`);
  const required = new Map<string, number | undefined>();
  for (const rule of rules) {
    if (rule.type !== "required_status_checks") continue;
    for (const check of rule.parameters?.required_status_checks ?? [])
      required.set(check.context, check.integration_id);
  }
  if (!required.size) throw new Error(`${repo} has no required status checks on ${baseRef}`);

  let statuses: Array<{ context: string; state: string; updated_at: string }> | undefined;
  const states: RequiredCheckState[] = [];
  for (const [name, appId] of required) {
    const runs = await githubGet<{
      check_runs?: Array<{
        status?: string;
        conclusion?: string | null;
        completed_at?: string | null;
        app?: { id?: number };
      }>;
    }>(
      `/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest&per_page=100`,
      `${repo} check runs on ${sha}`,
    );
    const run = (runs.check_runs ?? []).find((r) => appId === undefined || r.app?.id === appId);
    if (run) {
      states.push({
        name,
        complete: run.status === "completed",
        conclusion: run.conclusion ?? null,
        completedAt: run.completed_at ?? null,
      });
      continue;
    }
    // A required check can also be a commit status (context), not a check run.
    statuses ??=
      (
        await githubGet<{
          statuses?: Array<{ context: string; state: string; updated_at: string }>;
        }>(`/repos/${repo}/commits/${sha}/status?per_page=100`, `${repo} statuses on ${sha}`)
      ).statuses ?? [];
    const status = statuses.find((s) => s.context === name);
    const complete = status !== undefined && status.state !== "pending";
    states.push({
      name,
      complete,
      conclusion: complete ? status.state : null,
      completedAt: complete ? status.updated_at : null,
    });
  }
  return states;
}
