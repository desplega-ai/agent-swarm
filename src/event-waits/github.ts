import * as z from "zod";
import { isGitHubEnabled } from "@/github/app";
import { fetchPullRequestState } from "@/github/pull-request-state";
import type { EventMatch, ExternalEvent, ExternalEventAdapter } from "./types";

const PrMatch = z
  .object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), number: z.number().int().positive() })
  .strict();

/** GitHub names repos case-insensitively; waits and events both carry them lowercase. */
function prMatch(repo: string, number: number): EventMatch {
  return { repo: repo.toLowerCase(), number };
}

export const githubAdapter: ExternalEventAdapter = {
  source: "github",
  events: ["vcs.pr.merged"],
  matchHint: "repo (owner/name), number",
  busPrefix: "github.pull_request.",
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
  async confirm(_event, match) {
    return (await fetchPullRequestState(String(match.repo), Number(match.number))).merged;
  },
};
