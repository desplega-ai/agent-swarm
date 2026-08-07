import { z } from "zod";

export const argsSchema = z.object({
  repo: z.string().describe("Repository in 'owner/name' form, e.g. 'owner/name'"),
  state: z
    .enum(["open", "closed", "all"])
    .optional()
    .describe("Which issues to pull (default 'open')"),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("Page size, GitHub's per_page cap is 100 (default 100)"),
  connection: z
    .string()
    .optional()
    .describe(
      "Connection slug the app source names; echoed back for provenance — credentials are resolved at the egress layer, not here",
    ),
});

/** Pull a repository's GitHub issues as sync records: {records, complete} with pull requests filtered out. */
export default async function githubIssuesPull(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  // Failures THROW: a returned {error} object exits 0 and the sync engine
  // reports it as a generic invalid-payload error, burying the real cause.
  if (!parsed.success) throw new Error("invalid args: " + parsed.error.message);
  const { repo, state = "open", limit = 100, connection } = parsed.data;

  const segments = repo.split("/");
  if (
    segments.length !== 2 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("repo must be in 'owner/name' form");
  }
  const path = segments.map((segment) => encodeURIComponent(segment)).join("/");

  const payload: any = await ctx.stdlib.fetchJson(
    "https://api.github.com/repos/" + path + "/issues?state=" + state + "&per_page=" + limit,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "agent-swarm-apps-sync",
        // The placeholder is the point: the sandbox's egress layer swaps it for
        // the real token on the way out, and only toward hosts allowlisted for
        // the run-as identity. Never resolve the secret yourself — no
        // resolved-config read, no token arg.
        Authorization: "Bearer [REDACTED:GITHUB_TOKEN]",
      },
      signal: AbortSignal.timeout(10_000),
    },
  );

  // fetchJson hands back the parsed body, not the status — a GitHub error is an
  // object carrying `message`, a successful issues page is an array.
  if (!Array.isArray(payload)) {
    const why =
      payload && typeof payload.message === "string" ? payload.message : "unexpected response";
    throw new Error("GitHub issues " + repo + ": " + why);
  }

  // Completeness is computed on the RAW page, before the pull-request filter: a
  // full raw page means "there may be more". Filtering first would let a page of
  // mostly PRs look short and wrongly claim a complete window, and the engine
  // would sweep still-live rows stale.
  const complete = payload.length < limit;

  // The issues endpoint interleaves pull requests; only PR entries carry
  // `pull_request`.
  const records = payload
    .filter((issue: any) => issue && !issue.pull_request)
    .map((issue: any) => ({
      key: String(issue.number),
      fields: {
        number: issue.number,
        id: issue.id,
        title: issue.title,
        state: issue.state,
        // The FULL body goes back: the engine scrubs pulled values whole at
        // its trusted boundary, and truncating here first could split a
        // secret across the cut and defeat exact-value redaction. GitHub
        // bounds issue bodies (~65k), so rows stay sane without a cap here.
        body: typeof issue.body === "string" ? issue.body : "",
        userLogin: issue.user ? issue.user.login : null,
        labelsCsv: Array.isArray(issue.labels)
          ? issue.labels
              .map((label: any) => (typeof label === "string" ? label : label && label.name))
              .filter((name: any) => typeof name === "string" && name.length > 0)
              .join(",")
          : "",
        comments: issue.comments,
        htmlUrl: issue.html_url,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
      },
    }));

  return { records, complete, ...(connection ? { connection } : {}) };
}
