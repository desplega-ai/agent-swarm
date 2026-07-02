import { z } from "zod";

export const argsSchema = z.object({
  key: z.string().describe("Linear issue identifier, e.g. 'DES-123'"),
  token: z
    .string()
    .optional()
    .describe("Linear API key override; falls back to the LINEAR_API_KEY swarm config"),
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
    // Best-effort.
  }
  return null;
}

/** Fetch a Linear issue (title, status, assignee, comments) by its DES-123 identifier. */
export default async function linearIssue(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };
  const key = parsed.data.key.trim().toUpperCase();
  const m = key.match(/^([A-Z][A-Z0-9]*)-(\d+)$/);
  if (!m) return { error: "key must look like 'DES-123'" };
  const teamKey = m[1] as string;
  const number = Number.parseInt(m[2] as string, 10);

  const token = await resolveSecret(ctx, "LINEAR_API_KEY", parsed.data.token);
  if (!token) {
    return {
      error: "no Linear API key available",
      hint: "set the LINEAR_API_KEY swarm config or pass a 'token' arg",
    };
  }

  const query = `query {
    issues(filter: { team: { key: { eq: "${teamKey}" } }, number: { eq: ${number} } }, first: 1) {
      nodes {
        identifier
        title
        url
        priorityLabel
        state { name type }
        assignee { name displayName }
        comments(first: 50) {
          nodes { body createdAt user { name displayName } }
        }
      }
    }
  }`;

  const res: any = await ctx.stdlib.fetchJson("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ query }),
  });
  if (res && res.errors && res.errors.length > 0) {
    return { error: "Linear API error: " + (res.errors[0].message || "unknown") };
  }
  const nodes: any =
    res && res.data && res.data.issues && Array.isArray(res.data.issues.nodes)
      ? res.data.issues.nodes
      : [];
  if (nodes.length === 0) return { error: "issue " + key + " not found" };

  const issue: any = nodes[0];
  const assignee = issue.assignee
    ? issue.assignee.displayName || issue.assignee.name || null
    : null;
  const comments: any[] = (
    issue.comments && Array.isArray(issue.comments.nodes) ? issue.comments.nodes : []
  ).map((c: any) => ({
    body: c.body,
    author: c.user ? c.user.displayName || c.user.name : "unknown",
    createdAt: c.createdAt,
  }));

  return {
    key: issue.identifier,
    title: issue.title,
    status: issue.state ? issue.state.name : "unknown",
    statusType: issue.state ? issue.state.type : null,
    priority: issue.priorityLabel || null,
    assignee,
    url: issue.url,
    commentCount: comments.length,
    comments,
  };
}
