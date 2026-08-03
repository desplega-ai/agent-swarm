import { z } from "zod";

export const argsSchema = z.object({
  repo: z.string().describe("GitHub repository in 'owner/name' form"),
  state: z.enum(["open", "closed", "all"]).optional().default("open"),
  limit: z.number().int().positive().max(100).optional().default(50),
});

function validRepo(repo: string): boolean {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return false;
  const [owner, name] = repo.split("/");
  return owner !== "." && owner !== ".." && name !== "." && name !== "..";
}

/** Pull a bounded window of public GitHub issues as app source records. */
export default async function githubIssuesPull(args: unknown, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) throw new Error("invalid args: " + parsed.error.message);
  if (!validRepo(parsed.data.repo)) throw new Error("repo must be in 'owner/name' form");

  const [owner, name] = parsed.data.repo.split("/");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let payload: unknown;
  try {
    const response: Response = await ctx.stdlib.fetch(
      "https://api.github.com/repos/" +
        encodeURIComponent(owner as string) +
        "/" +
        encodeURIComponent(name as string) +
        "/issues?state=" +
        parsed.data.state +
        "&per_page=" +
        parsed.data.limit,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "agent-swarm-apps-sync",
        },
        retries: 1,
        signal: controller.signal,
        timeoutMs: 10_000,
      },
    );
    if (!response.ok) {
      throw new Error("GitHub issues pull failed with status " + response.status);
    }
    payload = await response.json();
  } finally {
    clearTimeout(timeout);
  }

  if (!Array.isArray(payload)) throw new Error("GitHub issues pull returned a non-array response");
  return payload
    .filter((issue: any) => issue && !Object.hasOwn(issue, "pull_request"))
    .map((issue: any) => {
      if (typeof issue.number !== "number") {
        throw new Error("GitHub issue is missing a numeric number");
      }
      return {
        key: String(issue.number),
        fields: {
          number: issue.number,
          id: issue.id,
          title: issue.title,
          state: issue.state,
          body: typeof issue.body === "string" ? issue.body.slice(0, 1000) : issue.body,
          userLogin: issue.user?.login,
          labelsCsv: Array.isArray(issue.labels)
            ? issue.labels
                .map((label: any) => (typeof label === "string" ? label : label?.name))
                .filter((label: unknown): label is string => typeof label === "string")
                .join(",")
            : "",
          comments: issue.comments,
          htmlUrl: issue.html_url,
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
        },
      };
    });
}
