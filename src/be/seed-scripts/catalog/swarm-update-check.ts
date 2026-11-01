import { z } from "zod";

export const argsSchema = z.object({
  dryRun: z
    .boolean()
    .optional()
    .describe("Compute the verdict but do not notify the lead when an update is available"),
});

const RELEASES_URL = "https://api.github.com/repos/desplega-ai/agent-swarm/releases/latest";

/** Parse `major.minor.patch` (a leading `v` and a pre-release/build suffix are ignored). */
export function parseVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== "string") return null;
  const m = value
    .trim()
    .replace(/^v/i, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Numeric compare of two parsed versions: negative, zero or positive. Never a string compare. */
export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] as number) - (b[i] as number);
    if (diff !== 0) return diff;
  }
  return 0;
}

function errorText(error: unknown): string {
  return String((error as any)?.message ?? error).slice(0, 200);
}

/** The version the API server is running, from its own unauthenticated `/health` route. */
async function runningVersion(ctx: any): Promise<string | null> {
  try {
    const base = ctx.stdlib.Redacted.value(ctx.swarm.config.mcpBaseUrl).replace(/\/+$/, "");
    const res: any = await ctx.stdlib.fetch(base + "/health", { retries: 1, timeoutMs: 10_000 });
    if (!res.ok) return null;
    const body: any = await res.json();
    return typeof body?.version === "string" && body.version.trim() ? body.version.trim() : null;
  } catch {
    return null;
  }
}

async function resolveLeadId(ctx: any): Promise<string | null> {
  const res: any = await ctx.swarm.swarm_get({});
  const data = res?.data ?? res;
  const agents: any[] = Array.isArray(data?.agents) ? data.agents : Array.isArray(data) ? data : [];
  const lead = agents.find((agent) => agent?.isLead === true || agent?.isLead === 1);
  return typeof lead?.id === "string" ? lead.id : null;
}

/**
 * Compare the running agent-swarm version with the latest published GitHub
 * release and, only when a newer release exists, hand the lead one task to
 * tell the operator through its admin delivery channel.
 */
export default async function swarmUpdateCheck(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args ?? {});
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };
  const dryRun = parsed.data.dryRun === true;

  const running = await runningVersion(ctx);
  const runningParsed = parseVersion(running);
  if (!running || !runningParsed) {
    // Unknown is not "up to date": say so and stop, never guess a version.
    return {
      checked: false,
      status: "unknown",
      running,
      message: `Unable to determine running version: ${running ? `unparseable "${running}"` : "not reported by /health"}.`,
    };
  }

  let release: any;
  try {
    // One attempt: a failed GitHub call is reported, never retried in a loop.
    const res: any = await ctx.stdlib.fetch(RELEASES_URL, {
      retries: 1,
      timeoutMs: 15_000,
      headers: { Accept: "application/vnd.github+json", "User-Agent": "agent-swarm-update-check" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    release = await res.json();
  } catch (error) {
    return {
      checked: false,
      status: "github-unreachable",
      running,
      message: `Could not reach GitHub releases API: ${errorText(error)}`,
    };
  }

  const latest = typeof release?.tag_name === "string" ? release.tag_name.replace(/^v/i, "") : null;
  const latestParsed = parseVersion(latest);
  if (!latest || !latestParsed) {
    return {
      checked: false,
      status: "github-unreachable",
      running,
      message: `Could not read a version from the latest release tag: ${JSON.stringify(release?.tag_name ?? null)}.`,
    };
  }
  const releaseUrl =
    typeof release?.html_url === "string"
      ? release.html_url
      : `https://github.com/desplega-ai/agent-swarm/releases/tag/v${latest}`;

  if (compareVersions(latestParsed, runningParsed) <= 0) {
    return {
      checked: true,
      status: "up-to-date",
      running,
      latest,
      message: `Up to date: running ${running}, latest published ${latest}.`,
    };
  }

  const message = `Update available: running ${running}, latest ${latest} (${releaseUrl})`;
  if (dryRun) {
    return { checked: true, status: "update-available", running, latest, releaseUrl, notified: false, message };
  }

  const leadId = await resolveLeadId(ctx);
  // A detected update that reaches nobody is a failed run, not a quiet success.
  if (!leadId) throw new Error(`${message}, but the swarm has no lead to notify.`);
  const sent: any = await ctx.swarm.task_send({
    agentId: leadId,
    routingReason: "skill",
    routingNote: "Lead owns the operator's admin delivery channel for release notices.",
    tags: ["swarm-update-check"],
    task: [
      `A newer agent-swarm release is published: running ${running}, latest ${latest}.`,
      `Release: ${releaseUrl}`,
      "",
      "Post one short message to your configured admin delivery channel (the in-app fallback if none is configured) naming the running version, the new version and the release URL. Then complete with that message as the output.",
      "Do not attempt the upgrade yourself: this notice only detects and reports.",
    ].join("\n"),
  });
  const taskId = sent?.data?.task?.id ?? null;
  if (sent?.success === false || sent?.data?.success === false || !taskId) {
    const reason = sent?.data?.message ?? sent?.data?.error ?? `status ${sent?.status}`;
    throw new Error(`${message}, but notifying the lead failed: ${errorText(reason)}`);
  }
  return { checked: true, status: "update-available", running, latest, releaseUrl, notified: true, leadTaskId: taskId, message };
}
