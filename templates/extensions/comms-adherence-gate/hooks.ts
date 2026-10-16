import { type ApiCtx, block, type SwarmExtension } from "swarm-extension";
import { z } from "zod";

/**
 * comms-adherence-gate
 *
 * When an agent calls `store-progress` with status "completed" on a task that
 * reaches a human in Slack, judge the `output` against the requesting user's
 * stored comms preferences (users.metadata.$.comms) with Jev, and against what
 * that user actually asked for in their latest message. An explicit request
 * ("tell me a long joke", "explain in detail") outranks the stored default, so
 * a requested long answer is not a verbosity failure.
 *
 * Transport (config.provider): Jev is served by TypeSafe directly and by
 * OpenRouter's Decisions endpoint. Both take the same {model, state, questions}
 * body and return the same `answers` shape. `auto` uses TYPESAFE_API_KEY when
 * set, else OPENROUTER_API_KEY.
 *
 * modes (config.mode):
 *   off     -> never evaluate
 *   shadow  -> evaluate + record, never block (default)
 *   enforce -> record, and block the completion up to maxBlocksPerTask times
 *              per task with actionable feedback
 *
 * Fails OPEN on every error: a judge outage must never wall the swarm.
 * Every verdict lands in KV namespace `ext:comms-gate`.
 */

export const config = z.object({
  mode: z.enum(["off", "shadow", "enforce"]).default("shadow"),
  /** A dimension scoring below this fails. */
  threshold: z.number().min(0).max(1).default(0.5),
  timeoutMs: z.number().int().positive().default(4000),
  maxBlocksPerTask: z.number().int().min(0).default(1),
  provider: z.enum(["auto", "typesafe", "openrouter"]).default("auto"),
  /** Jev model on the TypeSafe transport. */
  model: z.string().default("jev-latest"),
  /** Jev model on the OpenRouter transport. */
  openrouterModel: z.string().default("typesafe/jev-1.13"),
  /** Explicit TypeSafe key; otherwise TYPESAFE_API_KEY from the API process env. */
  apiKey: z.string().optional(),
});

type Cfg = z.infer<typeof config>;
type Swarm = ApiCtx["swarm"];

const NS = "ext:comms-gate";
const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const UUID_RE = /^[0-9a-fA-F-]{36}$/;
// The dispatcher cancels a handler after 5 s; leave room for the DB read and KV writes.
const MAX_TIMEOUT_MS = 4000;

export const cfgOf = (raw: unknown): Cfg => {
  const parsed = config.safeParse(raw ?? {});
  return parsed.success ? parsed.data : config.parse({});
};

// kv keys accept [a-zA-Z0-9._:/%-]
const safeKey = (raw: string | undefined | null): string =>
  (raw && raw.length > 0 ? raw : "unknown").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);

/** SDK envelopes: {success, data:{...}} or the bare payload. */
type Envelope = {
  data?: { rows?: unknown[]; value?: unknown };
  rows?: unknown[];
  value?: unknown;
} | null;

const cell = (row: unknown, i: number, key: string): unknown =>
  Array.isArray(row) ? row[i] : (row as Record<string, unknown>)?.[key];

/**
 * The newest human message sits at the END of a Slack task: the
 * `<thread_context>` blob comes first and can run to thousands of chars, so a
 * leading slice of `agent_tasks.task` shows the judge everything except the
 * actual request. Take the tail, then the part after the last `</thread_context>`.
 */
const CTX_END = "</thread_context>";
export const latestAsk = (tail: string): string => {
  const end = tail.lastIndexOf(CTX_END);
  let out = (end >= 0 ? tail.slice(end + CTX_END.length) : tail)
    .replace(/\[Thread follow-up[^\]]*\]/g, "")
    .trim();
  // Some tasks end with the context block; fall back to the last messages in it.
  if (out.length < 8) out = (end >= 0 ? tail.slice(0, end) : tail).trim().slice(-800);
  return out.slice(0, 900);
};

// Preferences are the DEFAULT. A direct request outranks them.
const JUDGING_RULES = [
  "The requester's explicit instruction in latest_request OUTRANKS requester_preferences. Preferences describe the DEFAULT; they never override a direct request.",
  "If latest_request asks for something long, detailed, creative, a story, a joke, a full explanation or a document, then length and structure serving that request are CORRECT and must NOT be penalized.",
  "Judge whether agent_message serves what latest_request actually asked for, written in the requester's manner. Do not judge it against the default preference when the request overrides it.",
];

type Prefs = { verbosity?: unknown; tone?: unknown; language?: unknown } & Record<string, unknown>;

/** One `noul` question per stated preference the gate knows how to judge. */
export const buildQuestions = (prefs: Prefs): Record<string, unknown> => {
  const questions: Record<string, unknown> = {};
  if (prefs.verbosity) {
    questions.verbosity = {
      type: "noul",
      instructions:
        "Does agent_message respect the requester's verbosity preference, AS OVERRIDDEN by any explicit instruction in latest_request? Apply judging_rules.",
      criteria: {
        true: "Length and structure fit what latest_request asked for (or the stated preference when the request does not override it), and it leads with the result.",
        false:
          "Too long for what was asked, or it opens with preamble, recaps the request, narrates the process, or ends with an offer to elaborate. Length explicitly requested in latest_request is NOT a failure.",
      },
    };
  }
  if (prefs.tone) {
    questions.tone = {
      type: "noul",
      instructions:
        "Does agent_message match the requester's stated tone preference, as overridden by any explicit instruction in latest_request? Apply judging_rules.",
      criteria: {
        true: "The tone matches what the requester asked for.",
        false:
          "The tone conflicts with it (for example hedging, flattery or filler when the requester asked for direct and plain). A voice appropriate to an explicitly requested creative or narrative form is NOT a failure.",
      },
    };
  }
  if (prefs.language) {
    questions.language = {
      type: "noul",
      instructions: "Is agent_message written in the requester's stated language?",
      criteria: {
        true: "Written in the stated language.",
        false: "Written in a different language.",
      },
    };
  }
  return questions;
};

const secretCache = new Map<string, { value: string; at: number }>();
const KEY_TTL_MS = 5 * 60 * 1000;
const usable = (v: string): boolean => Boolean(v) && !v.startsWith("[REDACTED");
const envOf = (name: string): string => String(process.env[name] ?? "");

/**
 * Resolve a secret: explicit value, then the API process env. The API process loads
 * global swarm_config rows into process.env at boot and on config reload.
 * ctx.swarm.config_get cannot serve it: the SDK scrubs secrets to "[REDACTED:<name>]".
 */
const secret = (name: string, explicit?: string): string => {
  const cached = secretCache.get(name);
  if (cached && Date.now() - cached.at < KEY_TTL_MS) return cached.value;
  const value = [String(explicit ?? ""), envOf(name)].find(usable) ?? "";
  if (usable(value)) secretCache.set(name, { value, at: Date.now() });
  return value;
};

/** Test hook: forget cached secrets. */
export const resetKeyCache = (): void => {
  secretCache.clear();
};

export type JevTransport = {
  provider: "typesafe" | "openrouter";
  endpoint: string;
  key: string;
  model: string;
};

/**
 * Pick the Jev transport. `auto` prefers TypeSafe and falls back to OpenRouter.
 * Throws when the chosen provider has no usable key; the handler fails open.
 */
export const resolveTransport = (cfg: Cfg): JevTransport => {
  const typesafe = (): JevTransport | null => {
    const key = secret("TYPESAFE_API_KEY", cfg.apiKey);
    return usable(key)
      ? { provider: "typesafe", endpoint: TYPESAFE_ENDPOINT, key, model: cfg.model }
      : null;
  };
  const openrouter = (): JevTransport | null => {
    const key = secret("OPENROUTER_API_KEY");
    return usable(key)
      ? { provider: "openrouter", endpoint: OPENROUTER_ENDPOINT, key, model: cfg.openrouterModel }
      : null;
  };
  const transport =
    cfg.provider === "typesafe"
      ? typesafe()
      : cfg.provider === "openrouter"
        ? openrouter()
        : (typesafe() ?? openrouter());
  if (transport) return transport;
  throw new Error(
    cfg.provider === "typesafe"
      ? "no TYPESAFE_API_KEY"
      : cfg.provider === "openrouter"
        ? "no OPENROUTER_API_KEY"
        : "no TYPESAFE_API_KEY or OPENROUTER_API_KEY",
  );
};

/** One Jev call; returns the `noul` score per question. Throws on any failure. */
export const askJev = async (
  state: Record<string, unknown>,
  questions: Record<string, unknown>,
  transport: JevTransport,
  cfg: Cfg,
  outer?: AbortSignal,
): Promise<{ scores: Record<string, number>; latencyMs: number }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(cfg.timeoutMs, MAX_TIMEOUT_MS));
  const onOuterAbort = () => controller.abort();
  outer?.addEventListener("abort", onOuterAbort);
  const t0 = Date.now();
  try {
    const res = await fetch(transport.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${transport.key}` },
      body: JSON.stringify({ state, model: transport.model, questions }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${transport.provider} ${res.status}`);
    const body = (await res.json()) as { answers?: Record<string, { noul?: unknown }> } | null;
    const answers = body?.answers;
    if (!answers || typeof answers !== "object") throw new Error("no answers in response");
    const scores: Record<string, number> = {};
    for (const [id, a] of Object.entries(answers)) {
      if (typeof a?.noul === "number") scores[id] = a.noul;
    }
    if (Object.keys(scores).length === 0) throw new Error("no scores in response");
    return { scores, latencyMs: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
};

const SELFTEST = "comms-gate-selftest";
const SELFTEST_PREFS = {
  tone: "direct, plain, no hedging",
  language: "English",
  verbosity:
    "very terse - answer in the first sentence, ~400 chars max. No preamble, no recap, no closing offer.",
};
const SELFTEST_BAD =
  "Great question! Let me walk you through what I did here. First I looked at the task, then I reviewed the relevant files, and after careful consideration I decided to go with option B. I hope this helps - let me know if you would like me to elaborate further on any of the above!";
const SELFTEST_GOOD =
  "Went with option B: it is the only one that keeps the migration reversible. PR #123.";

/**
 * Run the judge on a known-bad (positive control, must score below threshold) and a
 * known-good (negative control, must score at or above it) message and record both
 * under `selftest:last`. Proves key, egress and KV from inside the API runtime
 * without touching real traffic.
 */
const selfTest = async (swarm: Swarm, cfg: Cfg, signal?: AbortSignal): Promise<void> => {
  const started = Date.now();
  try {
    const transport = resolveTransport(cfg);
    const questions = { verbosity: buildQuestions(SELFTEST_PREFS).verbosity };
    const judge = (message: string) =>
      askJev(
        { requester_preferences: SELFTEST_PREFS, agent_message: message },
        questions,
        transport,
        cfg,
        signal,
      ).then((r) => r.scores.verbosity ?? null);
    const [bad, good] = await Promise.all([judge(SELFTEST_BAD), judge(SELFTEST_GOOD)]);
    await swarm.kv_set({
      namespace: NS,
      key: "selftest:last",
      value: {
        at: new Date().toISOString(),
        provider: transport.provider,
        threshold: cfg.threshold,
        positiveControlBadScore: bad,
        negativeControlGoodScore: good,
        controlsOk:
          typeof bad === "number" &&
          typeof good === "number" &&
          bad < cfg.threshold &&
          good >= cfg.threshold,
        latencyMs: Date.now() - started,
      },
    });
  } catch (err) {
    await swarm
      .kv_set({
        namespace: NS,
        key: "selftest:last",
        value: {
          at: new Date().toISOString(),
          error: String(err).slice(0, 400),
          latencyMs: Date.now() - started,
        },
      })
      .catch(() => {});
  }
};

const TASK_SQL = `SELECT t.source, t.slackThreadTs, t.agentId, t.requestedByUserId,
       json_extract(u.metadata, '$.comms') AS comms, u.name,
       substr(t.task, 1, 400) AS askHead,
       substr(t.task, -1400) AS askTail
FROM agent_tasks t
LEFT JOIN users u ON u.id = t.requestedByUserId
WHERE t.id = ?`;

const LEAD_SQL = "SELECT isLead FROM agents WHERE id = ?";

/**
 * Mirrors the `task.progress.write` rule store-progress enforces
 * (src/rbac/legacy-policy.ts): the caller owns the task, the task is
 * unassigned, or the caller is a lead. Lead status comes from the caller's
 * agents row, never from tool args. Extension callers return before this.
 */
const mayWriteProgress = async (
  swarm: Swarm,
  callerId: string | undefined,
  taskAgentId: string,
): Promise<boolean> => {
  if (!callerId) return false;
  if (!taskAgentId || taskAgentId === callerId) return true;
  const q = (await swarm.db_query({ sql: LEAD_SQL, params: [callerId] })) as Envelope;
  const row = (q?.data?.rows ?? q?.rows ?? [])[0];
  return Number(cell(row, 0, "isLead") ?? 0) === 1;
};

const extension: SwarmExtension = (api) => {
  api.on("pre.tool.call", async (event, ctx) => {
    if (event.tool !== "store-progress") return;
    if (event.requestInfo?.callOrigin === "extension") return;

    const cfg = cfgOf(ctx.config);
    if (cfg.mode === "off") return;

    const args = (event.args ?? {}) as Record<string, unknown>;

    // Self-test hatch: a progress call whose text starts with the sentinel runs
    // the controls and records them under `selftest:last`.
    if (args.status !== "completed") {
      if (typeof args.progress === "string" && args.progress.startsWith(SELFTEST)) {
        await selfTest(ctx.swarm, cfg, ctx.signal);
      }
      return;
    }

    const output = typeof args.output === "string" ? args.output.trim() : "";
    if (!output) return;

    const taskId = String(args.taskId ?? event.requestInfo?.sourceTaskId ?? "");
    if (!UUID_RE.test(taskId)) return;

    try {
      const q = (await ctx.swarm.db_query({ sql: TASK_SQL, params: [taskId] })) as Envelope;
      const row = (q?.data?.rows ?? q?.rows ?? [])[0];
      if (!row) return;

      const source = String(cell(row, 0, "source") ?? "");
      const slackThreadTs = cell(row, 1, "slackThreadTs");
      const agentId = String(cell(row, 2, "agentId") ?? "");
      const requesterId = String(cell(row, 3, "requestedByUserId") ?? "");
      const commsRaw = cell(row, 4, "comms");
      const requesterName = String(cell(row, 5, "name") ?? requesterId);
      const threadOpening = String(cell(row, 6, "askHead") ?? "");
      const ask = latestAsk(String(cell(row, 7, "askTail") ?? ""));

      // Judge only a completion store-progress will accept, so no agent can ship
      // another task's thread and preferences to the external judge.
      if (!(await mayWriteProgress(ctx.swarm, event.requestInfo?.agentId, agentId))) return;

      // Only where the text actually reaches a human in Slack.
      if (source !== "slack" && !slackThreadTs) return;
      if (!commsRaw) return; // no stated preferences -> nothing to judge against
      const prefs = (typeof commsRaw === "string" ? JSON.parse(commsRaw) : commsRaw) as Prefs;
      if (!prefs || typeof prefs !== "object") return;

      const questions = buildQuestions(prefs);
      if (Object.keys(questions).length === 0) return;

      const transport = resolveTransport(cfg);
      const { scores, latencyMs } = await askJev(
        {
          role: "You audit an AI agent's final message to the human who requested the work.",
          requester: requesterName,
          requester_preferences: prefs,
          latest_request: ask,
          thread_opening: threadOpening,
          judging_rules: JUDGING_RULES,
          agent_message: output,
        },
        questions,
        transport,
        cfg,
        ctx.signal,
      );

      const failed = Object.entries(scores)
        .filter(([, v]) => v < cfg.threshold)
        .map(([k]) => k);

      const verdict = {
        at: new Date().toISOString(),
        taskId,
        agentId,
        source,
        requester: requesterName,
        requesterId,
        provider: transport.provider,
        scores,
        failed,
        threshold: cfg.threshold,
        mode: cfg.mode,
        latencyMs,
        preferences: prefs,
        askPreview: ask.slice(0, 400),
        outputPreview: output.slice(0, 700),
      };

      await ctx.swarm.kv_incr({ namespace: NS, key: "total" });
      await ctx.swarm.kv_set({ namespace: NS, key: "last", value: verdict });

      if (failed.length === 0) {
        await ctx.swarm.kv_incr({ namespace: NS, key: "pass" });
        return;
      }

      await ctx.swarm.kv_incr({ namespace: NS, key: "fail" });
      for (const dim of failed) {
        await ctx.swarm.kv_incr({ namespace: NS, key: `dim:${safeKey(dim)}` });
      }

      const blocksKey = `blocks:${safeKey(taskId)}`;
      // kv_get answers {success, data:{value}}, and {success:false} when absent.
      const prior = (await ctx.swarm.kv_get({ namespace: NS, key: blocksKey })) as Envelope;
      const priorBlocks = Number(prior?.data?.value ?? prior?.value ?? 0) || 0;
      const willBlock = cfg.mode === "enforce" && priorBlocks < cfg.maxBlocksPerTask;

      await ctx.swarm.kv_set({
        namespace: NS,
        key: `fail:${Date.now()}:${safeKey(taskId)}`,
        value: { ...verdict, action: willBlock ? "blocked" : "recorded" },
      });

      if (!willBlock) {
        await ctx.swarm.kv_incr({
          namespace: NS,
          key: cfg.mode === "enforce" ? "escaped" : "shadowed",
        });
        return;
      }

      await ctx.swarm.kv_incr({ namespace: NS, key: "blocked" });
      await ctx.swarm.kv_incr({ namespace: NS, key: blocksKey });

      const detail = failed
        .map(
          (d) =>
            `${d} (${scores[d]!.toFixed(2)} vs ${cfg.threshold}) — requested: ${String(prefs[d] ?? "").slice(0, 220)}`,
        )
        .join("\n");

      return block(
        [
          `Comms gate: this output does not match ${requesterName}'s stated preferences.`,
          detail,
          "Rewrite the output to match and call store-progress again. Do not change the facts, only how they are said.",
        ].join("\n"),
      );
    } catch (err) {
      // Fail open, always.
      try {
        await ctx.swarm.kv_incr({ namespace: NS, key: "error" });
        await ctx.swarm.kv_set({
          namespace: NS,
          key: "error:last",
          value: { at: new Date().toISOString(), taskId, error: String(err).slice(0, 400) },
        });
      } catch {
        /* ignore */
      }
      ctx.log.warn("comms-adherence-gate: failing open", { error: String(err) });
      return;
    }
  });
};

export default extension;
