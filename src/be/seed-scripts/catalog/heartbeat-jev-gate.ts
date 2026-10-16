import { z } from "zod";

export const argsSchema = z.object({
  leadAgentId: z.string().optional().describe("Lead agent id; the heartbeat passes it"),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "Return the verdict, the compact state and the prompt it would create, without creating a prompt or writing KV",
    ),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Quiet when Jev's p(needs action) is below this (default 0.5)"),
  provider: z
    .enum(["auto", "typesafe", "openrouter"])
    .optional()
    .describe("Jev host; auto prefers TypeSafe (default auto)"),
  timeZone: z
    .string()
    .optional()
    .describe("IANA time zone for the state's current time and dates (default UTC)"),
  jevTimeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(45_000)
    .optional()
    .describe("Abandon the Jev call after this many ms (default 25000); the gate deadline is 60 s"),
});

const KV_NAMESPACE = "heartbeat-jev-gate";
const KV_KEY = "setup";
// Measured per decision in the 2026-10-15 heartbeat replay (229 states).
const COST_PER_DECISION = "$0.00004";

// Jev is called through `ctx.swarm.systemOne_decide`: the API server reads the
// key and sends the request, so no key ever enters this script's realm. The
// server also refuses OpenRouter when the effective OPENROUTER_BASE_URL (stored
// config or deployment env) points at a gateway.
const PROVIDERS = {
  typesafe: { keyName: "TYPESAFE_API_KEY", model: "jev-latest" },
  openrouter: { keyName: "OPENROUTER_API_KEY", model: "~typesafe/jev-latest" },
} as const;
type ProviderId = keyof typeof PROVIDERS;

// Worded exactly as in the replay that set the 0.5 threshold; changing it voids that result.
const QUESTIONS = {
  act: {
    type: "noul",
    instructions:
      "This is a 30-minute heartbeat for the Lead agent of an AI agent swarm. Does this state require the Lead to take an action now: message a human, dispatch, resume or fix a task, or act on a tracked item that is due now? Answer false when nothing changed since the previous heartbeat and every failure is already triaged or owned.",
    criteria: {
      true: "A new untriaged failure, a tracked item or human ask due now and not yet done, or a problem with no owner",
      false:
        "Same state as the previous heartbeat, failures already triaged or owned, nothing due now",
    },
  },
};

type SetupState = {
  status: "asked" | "approved" | "declined" | "expired";
  requestId?: string;
  url?: string;
  askedAt?: string;
  resolvedAt?: string;
};

function rows(res: any): any[] {
  const p = res?.data ?? res;
  if (p?.error) throw new Error(`db_query: ${String(p.error).slice(0, 200)}`);
  if (!Array.isArray(p?.rows)) throw new Error("db_query returned no rows array");
  const cols: string[] = p.columns ?? [];
  return p.rows.map((r: any) =>
    Array.isArray(r) ? Object.fromEntries(cols.map((c, i) => [c, r[i]])) : r,
  );
}

const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ");

/** `YYYY-MM-DD HH:MM` in the zone, falling back to UTC when the runtime has no Intl zone data. */
function localStamp(ms: number, timeZone: string): { stamp: string; zone: string } {
  const utc = { stamp: new Date(ms).toISOString().slice(0, 16).replace("T", " "), zone: "UTC" };
  if (timeZone === "UTC") return utc;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms));
    const v = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return { stamp: `${v("year")}-${v("month")}-${v("day")} ${v("hour")}:${v("minute")}`, zone: timeZone };
  } catch {
    return utc;
  }
}

// The checklist task renders failures as these lines (gatherSystemStatus in
// src/heartbeat/heartbeat.ts). The replay parsed them with this regex, so the
// gate renders and parses the same way to keep its fields identical.
const FAILURE_LINE_RE =
  /- \[([0-9a-f]{8})\] "([\s\S]*?)" — agent: ([0-9a-f]{8}), reason: ([\s\S]*?), at: (\S+)/g;

function parseFailures(status: string): { id: string; what: string; reason: string }[] {
  const out: { id: string; what: string; reason: string }[] = [];
  for (const m of status.matchAll(FAILURE_LINE_RE)) {
    out.push({
      id: m[1] ?? "",
      what: oneLine(m[2]).slice(0, 90),
      reason: oneLine(m[4]).slice(0, 140),
    });
  }
  return out;
}

function renderFailureLine(t: any): string {
  const agent = t.agentId ? String(t.agentId).slice(0, 8) : "unassigned";
  const reason = t.failureReason ? String(t.failureReason).slice(0, 100) : "no reason";
  return `- [${String(t.id).slice(0, 8)}] "${String(t.task ?? "").slice(0, 50)}" — agent: ${agent}, reason: ${reason}, at: ${t.finishedAt}`;
}

/**
 * The compact state Jev scores: the fields of the 2026-10-15 replay, built from
 * live data because the checklist task body does not exist yet at gate time.
 */
async function buildState(ctx: any, leadId: string, nowMs: number, timeZone: string) {
  const q = async (sql: string, params: unknown[] = []) =>
    rows(await ctx.swarm.db_query({ sql, params }));
  const since6h = new Date(nowMs - 6 * 3600e3).toISOString();
  const since24h = new Date(nowMs - 24 * 3600e3).toISOString();
  // Sequential: db_query caps concurrent queries per caller, and parallel reads fail with
  // db_query_concurrency_cap on a busy swarm.
  const lead = await q("SELECT heartbeatMd FROM agents WHERE id = ?", [leadId]);
  const prev = await q(
    `SELECT id, substr(output, 1, 400) AS output,
            substr(task, 1, instr(task, '## Your Standing Orders')) AS status
       FROM agent_tasks
      WHERE agentId = ? AND taskType = 'heartbeat-checklist' AND status = 'completed'
      ORDER BY createdAt DESC LIMIT 1`,
    [leadId],
  );
  const failed = await q(
    `SELECT id, agentId, substr(task, 1, 60) AS task, substr(failureReason, 1, 120) AS failureReason, finishedAt
       FROM agent_tasks WHERE status = 'failed' AND finishedAt > ?
      ORDER BY finishedAt DESC LIMIT 10`,
    [since6h],
  );
  const overview = await q(
    `SELECT SUM(status = 'in_progress') AS inProgress, SUM(status = 'pending') AS pending,
            SUM(status = 'unassigned') AS unassigned,
            SUM(status = 'completed' AND finishedAt > ?) AS completed24,
            SUM(status = 'failed' AND finishedAt > ?) AS failed24
       FROM agent_tasks`,
    [since24h, since24h],
  );
  const agents = await q(
    "SELECT status, COUNT(*) AS n FROM agents WHERE COALESCE(role, '') != 'extension' GROUP BY status",
  );

  const fails = parseFailures(failed.map(renderFailureLine).join("\n"));
  const prevIds = new Set(parseFailures(String(prev[0]?.status ?? "")).map((f) => f.id));
  const newFails = fails.filter((f) => !prevIds.has(f.id));

  const { stamp, zone } = localStamp(nowMs, timeZone);
  const mmdd = new Date(nowMs).toISOString().slice(5, 10);
  const mmddLocal = stamp.slice(5, 10);
  const due: string[] = [];
  for (const line of String(lead[0]?.heartbeatMd ?? "").split("\n")) {
    const l = line.trim();
    if (!l) continue;
    const del = /DELETE <?(\d\d-\d\d)>?/.exec(l);
    if (l.includes(mmdd) || l.includes(mmddLocal) || (del?.[1] && del[1] <= mmddLocal)) {
      due.push(oneLine(l).slice(0, 200));
    }
    if (due.length >= 6) break;
  }

  const o = overview[0] ?? {};
  const n = (v: unknown) => Number(v ?? 0) || 0;
  const count = (s: string) => n(agents.find((a) => a.status === s)?.n);
  const idle = count("idle");
  const busy = count("busy");

  return {
    now: `${stamp} ${zone}`,
    new_failures_since_previous_heartbeat: newFails.length
      ? newFails.map((f) => `${f.id}: ${f.what} | ${f.reason}`)
      : "none",
    tracked_items_mentioning_today_or_past_delete_date: due.length ? due : "none",
    previous_heartbeat_result: prev[0]?.output
      ? oneLine(prev[0].output).slice(0, 350)
      : "unknown",
    failures_last_6h_total: fails.length,
    task_overview: `- In Progress: ${n(o.inProgress)} - Pending: ${n(o.pending)} - Unassigned: ${n(o.unassigned)} - Completed (24h): ${n(o.completed24)} - Failed (24h): ${n(o.failed24)}`,
    agents: `- Online: ${idle + busy} (${idle} idle, ${busy} busy), Offline: ${count("offline")}`,
  };
}

function setupPrompt(keys: string[]) {
  return {
    title: "Heartbeat Jev gate: add a Jev credential or decline",
    detached: true,
    questions: [
      {
        id: "enable",
        type: "approval",
        label: "Enable the Jev heartbeat gate?",
        description: [
          "Before each recurring heartbeat checklist, the `heartbeat-jev-gate` script sends a short summary of swarm state (about 1,500 characters: new failures, due tracked items, task and agent counts) to Jev, a small decision model by TypeSafe, and asks whether the Lead needs to act. With `HEARTBEAT_CHECKLIST_GATE_MODE=enforce`, quiet ticks skip the Lead's checklist task.",
          "",
          `Cost: about ${COST_PER_DECISION} per decision, one decision per checklist tick.`,
          "",
          `No Jev credential is configured. To enable, approve and add one of ${keys.map((k) => `\`${k}\``).join(" or ")} as a global secret on the Secrets page (Settings > Secrets). Do not paste the key here. The next tick picks it up.`,
          "",
          "Reject to decline. The gate then stays inactive, with no further prompts, until a key is added.",
        ].join("\n"),
      },
    ],
  };
}

/**
 * Heartbeat checklist gate backed by Jev: asks Jev whether a recurring checklist
 * tick needs the Lead and returns { quiet, reason, summary }. With no Jev
 * credential it asks a human once, then stays a no-op until a key is added.
 */
export default async function heartbeatJevGate(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args ?? {});
  if (!parsed.success) throw new Error(`invalid args: ${parsed.error.message.slice(0, 200)}`);
  const a = parsed.data;
  const dryRun = a.dryRun === true;

  const agentInfo: any = a.leadAgentId ? null : await ctx.swarm.agent_info();
  const leadId = String(a.leadAgentId ?? agentInfo?.data?.id ?? agentInfo?.id ?? "");
  if (!leadId) throw new Error("no leadAgentId");

  // Values of secret rows come back masked: presence is all this script reads.
  const cfgRes: any = await ctx.swarm.config_get({ agentId: leadId });
  const configs: any[] = cfgRes?.data?.configs ?? cfgRes?.configs ?? [];
  const cfg = (key: string): string => {
    const value = configs.find((c) => c?.key === key)?.value;
    return typeof value === "string" ? value.trim() : "";
  };

  const cfgThreshold = Number.parseFloat(cfg("HEARTBEAT_JEV_GATE_THRESHOLD"));
  const threshold =
    a.threshold ?? (cfgThreshold >= 0 && cfgThreshold <= 1 ? cfgThreshold : 0.5);
  const providerPref = a.provider ?? (cfg("HEARTBEAT_JEV_GATE_PROVIDER").toLowerCase() || "auto");
  const timeZone = a.timeZone ?? (cfg("HEARTBEAT_JEV_GATE_TIMEZONE") || "UTC");

  const usable: Record<ProviderId, boolean> = {
    typesafe: cfg(PROVIDERS.typesafe.keyName) !== "",
    openrouter: cfg(PROVIDERS.openrouter.keyName) !== "",
  };
  const candidates: ProviderId[] =
    providerPref === "typesafe"
      ? ["typesafe"]
      : providerPref === "openrouter"
        ? ["openrouter"]
        : ["typesafe", "openrouter"];
  const provider = candidates.find((id) => usable[id]);

  if (!provider) {
    const keys = candidates.map((id) => PROVIDERS[id].keyName);
    const inactive = (state: string, extra: Record<string, unknown> = {}) => ({
      quiet: false,
      reason: `jev-gate inactive: ${state}`.slice(0, 300),
      ...(dryRun ? { dryRun: true, ...extra } : {}),
    });
    const entry: any = await ctx.swarm.kv_getOrNull({ namespace: KV_NAMESPACE, key: KV_KEY });
    const stored = entry?.value;
    let setup: SetupState | null = typeof stored === "string" ? JSON.parse(stored) : (stored ?? null);

    if (!setup) {
      const prompt = setupPrompt(keys);
      if (dryRun) {
        const state = await buildState(ctx, leadId, Date.now(), timeZone);
        return inactive("no credential, would ask a human", { prompt, state });
      }
      const res: any = await ctx.swarm.request_humanInput(prompt);
      const requestId = res?.data?.requestId ?? res?.requestId;
      if (!requestId) throw new Error("request_humanInput returned no requestId");
      setup = {
        status: "asked",
        requestId,
        url: res?.data?.url ?? res?.url,
        askedAt: new Date().toISOString(),
      };
      await ctx.swarm.kv_set({ namespace: KV_NAMESPACE, key: KV_KEY, value: setup });
      return inactive(`no credential, asked a human (approval request ${requestId})`);
    }

    if (setup.status === "asked" && setup.requestId) {
      const [req] = rows(
        await ctx.swarm.db_query({
          sql: "SELECT status FROM approval_requests WHERE id = ?",
          params: [setup.requestId],
        }),
      );
      const status = String(req?.status ?? "missing");
      if (status === "pending") {
        return inactive(`no credential, awaiting answer on approval request ${setup.requestId}`);
      }
      const next: SetupState["status"] =
        status === "approved" ? "approved" : status === "rejected" ? "declined" : "expired";
      setup = { ...setup, status: next, resolvedAt: new Date().toISOString() };
      if (!dryRun) await ctx.swarm.kv_set({ namespace: KV_NAMESPACE, key: KV_KEY, value: setup });
    }

    const why =
      setup.status === "approved"
        ? `approved, waiting for ${keys.join(" or ")} on the Secrets page`
        : setup.status === "declined"
          ? `declined; add ${keys.join(" or ")} to enable`
          : `setup request expired unanswered; add ${keys.join(" or ")} to enable`;
    return inactive(why, { setup });
  }

  const target = PROVIDERS[provider];
  const state = await buildState(ctx, leadId, Date.now(), timeZone);

  // The server enforces the time budget. No retries, as in the replay.
  const res: any = await ctx.swarm.systemOne_decide({
    provider,
    model: target.model,
    state,
    questions: QUESTIONS,
    timeoutMs: a.jevTimeoutMs ?? 25_000,
    maxRetries: 0,
  });
  const body: any = res?.data ?? res;
  if (res?.success === false || body?.success === false) {
    throw new Error(`jev ${provider}: ${String(body?.message ?? body?.error ?? `HTTP ${res?.status}`).slice(0, 250)}`);
  }
  const p = body?.answers?.act?.noul;
  if (typeof p !== "number" || !Number.isFinite(p)) {
    throw new Error(`jev ${provider}: response has no numeric answers.act.noul`);
  }

  const pText = p.toFixed(3);
  const quiet = p < threshold;
  const verdict: Record<string, unknown> = {
    quiet,
    reason: `jev p(needs action)=${pText} ${quiet ? "<" : ">="} ${threshold} via ${provider}`,
  };
  if (!quiet) {
    const lines = [`Jev p(needs action) = ${pText} (threshold ${threshold}, ${provider}).`];
    const failures = state.new_failures_since_previous_heartbeat;
    const tracked = state.tracked_items_mentioning_today_or_past_delete_date;
    if (Array.isArray(failures)) {
      lines.push("", "New failures since the previous checklist:", ...failures.map((f) => `- ${f}`));
    }
    if (Array.isArray(tracked)) {
      lines.push("", "Tracked items due today or past their DELETE date:", ...tracked.map((t) => `- ${t.replace(/^[-*] /, "")}`));
    }
    if (!Array.isArray(failures) && !Array.isArray(tracked)) {
      lines.push("", "No new failures or due tracked items; Jev flagged the overall state.");
    }
    verdict.summary = lines.join("\n").slice(0, 4000);
  }
  return dryRun ? { ...verdict, dryRun: true, provider, p, threshold, state } : verdict;
}
