import * as z from "zod";
import { isGitHubEnabled } from "@/github/app";
import { fetchPullRequestState, fetchRequiredCheckStates } from "@/github/pull-request-state";
import type { ConfirmResult, EventMatch, ExternalEvent, ExternalEventAdapter } from "./types";

const PrMatch = z
  .object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().positive() })
  .strict();

/** GitHub names repos case-insensitively; waits and events both carry them lowercase. */
function prMatch(repo: string, number: number): EventMatch {
  return { repo: repo.toLowerCase(), number };
}

/**
 * Have all required checks finished on the PR's current head? Reads the head SHA
 * fresh, so a push after the candidate check_run makes the answer "not yet".
 */
async function confirmChecksDone(repo: string, number: number): Promise<ConfirmResult> {
  const pr = await fetchPullRequestState(repo, number);
  if (!pr.headSha || !pr.baseRef)
    throw new Error(`GitHub returned no head or base for ${repo}#${number}`);
  const checks = await fetchRequiredCheckStates(repo, pr.baseRef, pr.headSha);
  const done = checks.every((check) => check.complete);
  return {
    happened: done,
    detail: done
      ? `head ${pr.headSha.slice(0, 12)}, ${checks
          .map((check) => `${check.name}=${check.conclusion} (completed ${check.completedAt})`)
          .join(", ")}`
      : undefined,
  };
}

export const githubAdapter: ExternalEventAdapter = {
  source: "github",
  events: ["vcs.pr.merged", "vcs.pr.checks_done"],
  matchHint: "repo (owner/name), number",
  busPrefixes: ["github.pull_request.", "github.check_run."],
  readsWithServerCredentials: true,
  isEnabled: isGitHubEnabled,
  parseMatch(_event, match) {
    const parsed = PrMatch.safeParse(match);
    if (!parsed.success) {
      throw new Error("match for a github PR event takes repo (owner/name) and number only.");
    }
    return prMatch(parsed.data.repo, parsed.data.number);
  },
  fromBusEvent(busEvent, payload): ExternalEvent[] {
    if (busEvent === "github.check_run.completed") {
      // A finished check run names a candidate for each PR it ran on. GitHub leaves
      // `pull_requests` empty for a fork's head; those waits fall to the ceiling.
      const run = payload as { repo?: unknown; pullRequests?: unknown } | null;
      if (typeof run?.repo !== "string" || !Array.isArray(run.pullRequests)) return [];
      const repo = run.repo;
      return run.pullRequests
        .filter((n): n is number => typeof n === "number")
        .map((n) => ({ event: "vcs.pr.checks_done", match: prMatch(repo, n) }));
    }
    const pr = payload as { repo?: unknown; number?: unknown; merged?: unknown } | null;
    if (
      busEvent !== "github.pull_request.closed" ||
      pr?.merged !== true ||
      typeof pr.repo !== "string" ||
      typeof pr.number !== "number"
    )
      return [];
    return [{ event: "vcs.pr.merged", match: prMatch(pr.repo, pr.number) }];
  },
  async confirm(event, match) {
    const repo = String(match.repo);
    const number = Number(match.number);
    if (event === "vcs.pr.checks_done") return await confirmChecksDone(repo, number);
    return (await fetchPullRequestState(repo, number)).merged;
  },
};
