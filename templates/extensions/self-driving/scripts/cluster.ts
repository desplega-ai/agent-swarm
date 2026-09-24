import type { ScriptContext } from "swarm-sdk";
import { z } from "zod";

// Every key lives in this explicit namespace, so the workflow run, the schedule
// and a manual script-run all see the same clusters whatever agent runs them.
const NAMESPACE = "ext-self-driving";

const SignalSchema = z.object({
  signalId: z.string().nullable().optional(),
  project: z.string(),
  repo: z.string().nullable(),
  fingerprint: z.string(),
  title: z.string(),
  level: z.string(),
});

export const argsSchema = z.object({
  mode: z.enum(["ingest", "sweep"]).optional().describe("ingest (default) or sweep"),
  signal: SignalSchema.nullable().optional().describe("The signal from self-driving-ingest"),
  classification: z
    .object({ kind: z.string(), route: z.string(), severity: z.string() })
    .passthrough()
    .nullable()
    .optional()
    .describe("The classification from self-driving-classify"),
});

type Cluster = {
  id: string;
  fingerprint: string;
  project: string;
  repo: string | null;
  title: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  classification: Record<string, unknown> | null;
  proposedAt: string | null;
};
type ExtensionRow = { name?: string; configJson?: string };

async function loadThreshold(ctx: ScriptContext): Promise<number> {
  const res = (await ctx.swarm.extension_list({})) as {
    data?: { extensions?: ExtensionRow[] };
  };
  const row = res?.data?.extensions?.find((e) => e.name === "self-driving");
  try {
    const raw = row?.configJson ? JSON.parse(row.configJson) : {};
    return Number.isInteger(raw.threshold) && raw.threshold >= 1 ? raw.threshold : 3;
  } catch {
    return 3;
  }
}

// Stable, KV-safe id: FNV-1a over the fingerprint.
function clusterId(fingerprint: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < fingerprint.length; i++) {
    hash ^= fingerprint.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `c-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Add a signal to its fingerprint cluster, or sweep for clusters past threshold. */
export default async function cluster(args: z.input<typeof argsSchema>, ctx: ScriptContext) {
  const threshold = await loadThreshold(ctx);

  if (args?.mode === "sweep") {
    const res = await ctx.swarm.kv_list<Cluster>({
      namespace: NAMESPACE,
      prefix: "cluster:",
      limit: 500,
    });
    const data = res?.data as { entries?: Array<{ value: Cluster }>; error?: string } | undefined;
    if (!data?.entries) return { ok: false, error: `kv_list failed: ${data?.error ?? "no data"}` };
    const clusters = data.entries.map((e) => e.value);
    const pending = clusters.filter((c) => c.count >= threshold && !c.proposedAt);
    return { ok: true, mode: "sweep", threshold, clusters: clusters.length, pending };
  }

  const signal = args?.signal;
  const classification = args?.classification;
  if (!signal || !classification) {
    return { ok: false, error: "no signal or classification from the previous steps" };
  }
  if (classification.kind === "noise") {
    // Downstream inputs must resolve, so dropped signals still return every field.
    return {
      ok: true,
      dropped: true,
      reason: "classified as noise",
      isNew: false,
      overThreshold: false,
      threshold,
      cluster: null,
    };
  }

  const id = clusterId(signal.fingerprint);
  const key = `cluster:${id}`;
  const now = new Date().toISOString();
  const existing = await ctx.swarm.kv_getOrNull<Cluster>({ namespace: NAMESPACE, key });
  const prev = existing?.value ?? null;
  const next: Cluster = {
    id,
    fingerprint: signal.fingerprint,
    project: signal.project,
    repo: signal.repo,
    title: signal.title,
    count: (prev?.count ?? 0) + 1,
    firstSeen: prev?.firstSeen ?? now,
    lastSeen: now,
    classification,
    proposedAt: prev?.proposedAt ?? null,
  };
  // Read-modify-write: two concurrent runs on one fingerprint can lose a count. Fine for the MVP.
  await ctx.swarm.kv_set({ namespace: NAMESPACE, key, value: next });

  return {
    ok: true,
    dropped: false,
    isNew: prev === null,
    overThreshold: next.count >= threshold,
    threshold,
    cluster: next,
  };
}
