import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

export const argsSchema = z.object({
  signal: z
    .object({
      signalId: z.string().nullable().optional(),
      project: z.string(),
      repo: z.string().nullable(),
      fingerprint: z.string(),
      title: z.string(),
      level: z.string(),
      culprit: z.string().nullable().optional(),
    })
    .nullable()
    .optional()
    .describe("The signal from self-driving-ingest"),
});

type Classifier = "rules" | "llm" | "jev";
type ExtensionRow = { name?: string; configJson?: string };

async function loadClassifier(ctx: ScriptContext): Promise<Classifier> {
  const res = (await ctx.swarm.extension_list({})) as {
    data?: { extensions?: ExtensionRow[] };
  };
  const row = res?.data?.extensions?.find((e) => e.name === "self-driving");
  try {
    const raw = row?.configJson ? JSON.parse(row.configJson) : {};
    return raw.classifier === "llm" || raw.classifier === "jev" ? raw.classifier : "rules";
  } catch {
    return "rules";
  }
}

// Known browser and client noise. Matched on the title, case-insensitive.
const NOISE_TITLES = [
  /ResizeObserver loop/i,
  /Non-Error promise rejection captured/i,
  /Script error\.?$/i,
  /Load failed/i,
];

/** Classify one signal into the default classification schema (proposal §3.2). */
export default async function classify(args: z.input<typeof argsSchema>, ctx: ScriptContext) {
  const signal = args?.signal;
  if (!signal) return { ok: false, error: "no signal: ingest rejected the payload" };

  const backend = await loadClassifier(ctx);
  if (backend !== "rules") {
    return {
      ok: false,
      backend,
      error: `classifier "${backend}" is not implemented in the MVP; set config.classifier to "rules"`,
    };
  }

  const evidence = [
    { signal_id: signal.signalId ?? signal.fingerprint, note: `level=${signal.level}` },
  ];
  const base = { repo: signal.repo, component: null, suspect_release: null, evidence };

  const noise =
    signal.level === "debug" ||
    signal.level === "info" ||
    NOISE_TITLES.some((pattern) => pattern.test(signal.title));
  if (noise) {
    return {
      ok: true,
      backend,
      classification: {
        ...base,
        kind: "noise",
        route: "ignore",
        severity: "low",
        confidence: 0.9,
        summary: `Noise: ${signal.title}`.slice(0, 280),
      },
    };
  }

  const severity =
    signal.level === "fatal" ? "critical" : signal.level === "error" ? "high" : "medium";
  return {
    ok: true,
    backend,
    classification: {
      ...base,
      kind: "code_bug",
      // Rules cannot tell a bug from config or infra; without a repo, a person decides.
      route: signal.repo ? (severity === "medium" ? "investigate" : "open_pr") : "human_review",
      severity,
      confidence: 0.5,
      summary: `${signal.title} in ${signal.culprit ?? signal.project}`.slice(0, 280),
    },
  };
}
