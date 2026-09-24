import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

const NAMESPACE = "ext-self-driving";

// The webhook has no server-side body cap, so bound everything here before any write.
// The workflow triggerSchema cannot express these: its validator ignores maxLength/maxItems.
export const LIMITS = {
  payloadBytes: 16 * 1024,
  project: 200,
  eventId: 128,
  title: 500,
  culprit: 500,
  fingerprintItems: 20,
  fingerprintItem: 200,
} as const;
const DEFAULT_COOLDOWN_SECONDS = 300;

// A Sentry-shaped event: the fields an issue-alert webhook carries that the loop needs.
const SentryPayloadSchema = z.object({
  project: z.string().min(1).max(LIMITS.project),
  event: z.object({
    event_id: z.string().min(1).max(LIMITS.eventId).optional(),
    title: z.string().min(1).max(LIMITS.title),
    level: z.enum(["debug", "info", "warning", "error", "fatal"]),
    culprit: z.string().max(LIMITS.culprit).optional(),
    fingerprint: z
      .array(z.string().min(1).max(LIMITS.fingerprintItem))
      .min(1)
      .max(LIMITS.fingerprintItems)
      .optional(),
  }),
});

export const argsSchema = z.object({
  payload: z.unknown().describe("The Sentry-shaped webhook body"),
});

type Config = { repos: Array<{ project: string; repo: string }>; cooldownSeconds: number };
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
  const cooldown = Number(raw.cooldownSeconds);
  return {
    repos: Array.isArray(raw.repos) ? raw.repos : [],
    cooldownSeconds:
      Number.isFinite(cooldown) && cooldown >= 0 ? Math.floor(cooldown) : DEFAULT_COOLDOWN_SECONDS,
  };
}

function payloadBytes(payload: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(payload) ?? "").length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Normalize a Sentry-shaped payload into a signal. */
export default async function ingest(args: z.input<typeof argsSchema>, ctx: ScriptContext) {
  const size = payloadBytes(args?.payload);
  if (size > LIMITS.payloadBytes) {
    return { ok: false, error: `payload too large: ${size} bytes > ${LIMITS.payloadBytes}` };
  }
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

  // Cooldown: the same event on the same fingerprint inside the window is a replay or a
  // retry, so it stops here and classify/cluster/propose write nothing. Keyed on the event
  // too, not the fingerprint alone, so distinct events still count toward the threshold.
  if (config.cooldownSeconds > 0) {
    const key = `dedupe:${await sha256(`${fingerprint}\n${event.event_id ?? event.title}`)}`;
    const seen = await ctx.swarm.kv_getOrNull<{ at: string }>({ namespace: NAMESPACE, key });
    if (seen?.value) {
      return {
        ok: true,
        skipped: true,
        reason: `duplicate signal inside the ${config.cooldownSeconds}s cooldown (first seen ${seen.value.at})`,
        signal: null,
      };
    }
    await ctx.swarm.kv_set({
      namespace: NAMESPACE,
      key,
      value: { at: new Date().toISOString() },
      ttlSeconds: config.cooldownSeconds,
    });
  }

  return {
    ok: true,
    skipped: false,
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
