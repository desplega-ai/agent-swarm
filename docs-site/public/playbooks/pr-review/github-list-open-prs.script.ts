export default async (args: any, ctx: any) => {
  const repo = (args && args.repo) || "";
  if (!repo || repo.indexOf("/") === -1) {
    throw "'repo' is required in the form 'owner/name'";
  }
  const limit = (args && args.limit) || 10;
  const sort = (args && args.sort) || "created";
  const direction = (args && args.direction) || "desc";

  const url = "https://api.github.com/repos/" + repo +
    "/pulls?state=open&sort=" + sort +
    "&direction=" + direction +
    "&per_page=" + limit;

  const headers: any = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agent-swarm-script",
  };

  // config.get returns undefined inside scripts; the placeholder is swapped for the
  // real token at egress by the global api.github.com credential binding.
  const tokenRedacted = ctx.swarm.config.get("GITHUB_TOKEN");
  const tok = tokenRedacted ? ctx.stdlib.Redacted.value(tokenRedacted) : "[REDACTED:GITHUB_TOKEN]";
  headers["Authorization"] = "Bearer " + tok;

  const res: any = await ctx.stdlib.fetch(url, { headers });
  if (!res.ok) {
    throw "GitHub API status " + res.status;
  }
  const authenticated = res.headers && typeof res.headers.get === "function"
    ? Number(res.headers.get("x-ratelimit-limit") || 0) > 60
    : true;
  const raw: any = await res.json();
  const prs = raw.map(function (p: any) {
    return {
      number: p.number,
      title: p.title,
      author: p.user && p.user.login ? p.user.login : null,
      url: p.html_url,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      draft: !!p.draft,
      labels: (p.labels || []).map(function (l: any) { return l.name; }),
    };
  });

  return { repo, count: prs.length, authenticated, prs };
};
