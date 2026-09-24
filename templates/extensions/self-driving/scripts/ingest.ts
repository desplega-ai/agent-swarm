import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

// A Sentry-shaped event: the fields an issue-alert webhook carries that the loop needs.
const SentryPayloadSchema = z.object({
  project: z.string().min(1),
  event: z.object({
    event_id: z.string().min(1).optional(),
    title: z.string().min(1),
    level: z.enum(["debug", "info", "warning", "error", "fatal"]),
    culprit: z.string().optional(),
    fingerprint: z.array(z.string().min(1)).min(1).optional(),
  }),
});

export const argsSchema = z.object({
  payload: z.unknown().describe("The Sentry-shaped webhook body"),
});

type Config = { repos: Array<{ project: string; repo: string }> };
type ExtensionRow = { name?: string; configJson?: string };

// Scripts have no ctx.config; read the stored extension config and apply defaults.
async function loadConfig(ctx: ScriptContext): Promise<Config> {
  const res = (await ctx.swarm.extension_list({})) as {
    data?: { extensions?: ExtensionRow[] };
  };
  const row = res?.data?.extensions?.find((e) => e.name === "self-driving");
  let raw: Partial<Config> = {};
  try {
    raw = row?.configJson ? JSON.parse(row.configJson) : {};
  } catch {
    raw = {};
  }
  return { repos: Array.isArray(raw.repos) ? raw.repos : [] };
}

/** Normalize a Sentry-shaped payload into a signal. */
export default async function ingest(args: z.input<typeof argsSchema>, ctx: ScriptContext) {
  const parsed = SentryPayloadSchema.safeParse(args?.payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: `invalid Sentry payload: ${parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ")}`,
    };
  }
  const { project, event } = parsed.data;
  const config = await loadConfig(ctx);
  const repo = config.repos.find((r) => r.project === project)?.repo ?? null;
  // Sentry's default grouping falls back to the title plus culprit.
  const fingerprint = (event.fingerprint ?? [event.title, event.culprit ?? ""]).join("|");

  return {
    ok: true,
    signal: {
      source: "sentry",
      signalId: event.event_id ?? null,
      project,
      repo,
      fingerprint,
      title: event.title,
      level: event.level,
      culprit: event.culprit ?? null,
    },
  };
}
