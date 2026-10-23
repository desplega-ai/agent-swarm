import { type ApiCtx, block, type SwarmExtension } from "swarm-extension";
import { z } from "zod";

/**
 * comms-adherence-gate
 *
 * When an agent calls `store-progress` with status "completed" on a task that
 * reaches a human in Slack, or posts to Slack itself (`slack-reply`,
 * `slack-post`, `slack-start-thread`, `slack-update`), judge the text with Jev:
 * against the requesting user's stored comms preferences
 * (users.metadata.$.comms) and what that user actually asked for in their
 * latest message, and against a plain-language rubric that applies to every
 * message whatever preferences exist. An explicit request ("tell me a long
 * joke", "explain in detail") outranks the stored default, so a requested long
 * answer is not a verbosity failure.
 *
 * Threads with several people: a message that @-mentions someone is judged
 * against the first mentioned person with stored preferences, skipping a
 * requester without preferences; otherwise against the requester. `plain` applies to everyone.
 *
 * Transport (config.provider): Jev is served by TypeSafe directly and by
 * OpenRouter's Decisions endpoint. Both take the same {model, state, questions}
 * body and return the same `answers` shape. `auto` uses TYPESAFE_API_KEY when
 * set, else OPENROUTER_API_KEY.
 *
 * modes (config.mode for the preference dimensions, config.plainMode for `plain`):
 *   off     -> never evaluate
 *   shadow  -> evaluate + record, never block (default)
 *   enforce -> record, and block the call up to maxBlocksPerTask times per task
 *              with actionable feedback. The budget is shared by both modes and
 *              by every gated tool.
 *
 * Fails OPEN on every error: a judge outage must never wall the swarm.
 * Every verdict lands in KV namespace `ext:comms-gate`.
 */

export const config = z.object({
  mode: z.enum(["off", "shadow", "enforce"]).default("shadow"),
  /** A preference dimension scoring below this fails. */
  threshold: z.number().min(0).max(1).default(0.5),
  /** The `plain` dimension, judged on every message. Independent of `mode`. */
  plainMode: z.enum(["off", "shadow", "enforce"]).default("shadow"),
  /**
   * `plain` scoring below this fails. Jev scores dense status text low and
   * plain text high with little in between, so this sits far below `threshold`.
   */
  plainThreshold: z.number().min(0).max(1).default(0.25),
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
/** MCP tools that post agent-authored text to Slack, all with a `message` arg. */
export const SLACK_TOOLS = new Set([
  "slack-reply",
  "slack-post",
  "slack-start-thread",
  "slack-update",
]);
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

/**
 * The `plain` rubric, from the `comms` skill (Simpler and Precise modes). Jev
 * separates dense from plain text reliably only with contrasting examples; a
 * prose-only rubric scored a plain rewrite as low as the dense original.
 */
export const PLAIN_RULES = [
  "Examples of NOT plain: 'p50 Δ +120ms vs baseline (n=37)', 'error rate 2.1% → 0.4% (cohort B, ±0.3 at 95%)', 'cost $-42/day', 'first-call hit ratio 0.61', 'drift unmeasured; 2 flaky'.",
  "Examples of plain: 'Pages load 120 ms slower than last week, across 37 runs', 'Errors dropped from 2 in 100 requests to 4 in 1,000', 'We spend $42 a day less', 'PR #123 keeps the migration reversible', 'Lead saves about $75 a week'.",
  "Code identifiers, task ids, PR numbers, links, file paths and version numbers are fine as they are.",
];

export const PLAIN_QUESTION = {
  type: "noul",
  instructions:
    "Is agent_message written like the plain examples in plain_language_rules rather than like the NOT plain ones? Ignore length and tone.",
  criteria: {
    true: "Written like the plain examples: everyday words and numbers with units and direction.",
    false:
      "Written like the NOT plain examples: statistics shorthand, abbreviations, signed or cryptic numbers.",
  },
};

/** Structured output (an outputSchema answer) is for machines; `plain` skips it. */
export const looksLikeJson = (text: string): boolean => {
  if (!/^[[{]/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

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
// A real dense monitor post a requester had to ask to have rewritten, and that rewrite.
const SELFTEST_PLAIN_BAD =
  "Prompt cache monitor, day 7 verdict for v2.0.0: partial. Lead first-call read median 12.4k (baseline v1.173.0, n 410) → 19.1k tokens (n 2234; expected 25.0k-40.0k). First-call saving about $75/week on Lead vs v1.173.0 (expected $129; sampling noise ±$24 at 95%, one baseline version, day-to-day drift not measured); session $ change $-167/week; fleet first-call saving $-7/week.";
const SELFTEST_PLAIN_GOOD =
  "Cheaper, but half what we hoped: Lead saves about $75 a week, not $129. Whole Lead tasks still cost $167 a week more, probably from other releases and heavier work, not this change.";

const below = (bad: unknown, good: unknown, threshold: number): boolean =>
  typeof bad === "number" && typeof good === "number" && bad < threshold && good >= threshold;

/**
 * Run the judge on known-bad (positive control, must score below threshold) and
 * known-good (negative control, must score at or above it) messages and record
 * them under `selftest:last`: one pair for verbosity, one for `plain`. Proves key,
 * egress and KV from inside the API runtime without touching real traffic.
 */
const selfTest = async (swarm: Swarm, cfg: Cfg, signal?: AbortSignal): Promise<void> => {
  const started = Date.now();
  try {
    const transport = resolveTransport(cfg);
    const judge = (message: string, dim: "verbosity" | "plain") =>
      askJev(
        dim === "plain"
          ? { plain_language_rules: PLAIN_RULES, agent_message: message }
          : { requester_preferences: SELFTEST_PREFS, agent_message: message },
        { [dim]: dim === "plain" ? PLAIN_QUESTION : buildQuestions(SELFTEST_PREFS).verbosity },
        transport,
        cfg,
        signal,
      ).then((r) => r.scores[dim] ?? null);
    const [bad, good, plainBad, plainGood] = await Promise.all([
      judge(SELFTEST_BAD, "verbosity"),
      judge(SELFTEST_GOOD, "verbosity"),
      judge(SELFTEST_PLAIN_BAD, "plain"),
      judge(SELFTEST_PLAIN_GOOD, "plain"),
    ]);
    await swarm.kv_set({
      namespace: NS,
      key: "selftest:last",
      value: {
        at: new Date().toISOString(),
        provider: transport.provider,
        threshold: cfg.threshold,
        positiveControlBadScore: bad,
        negativeControlGoodScore: good,
        controlsOk: below(bad, good, cfg.threshold),
        plainThreshold: cfg.plainThreshold,
        plainPositiveControlBadScore: plainBad,
        plainNegativeControlGoodScore: plainGood,
        plainControlsOk: below(plainBad, plainGood, cfg.plainThreshold),
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
       substr(t.task, -1400) AS askTail,
       t.creatorAgentId
FROM agent_tasks t
LEFT JOIN users u ON u.id = t.requestedByUserId
WHERE t.id = ?`;

const LEAD_SQL = "SELECT isLead FROM agents WHERE id = ?";

/** Slack user mentions in agent text: `<@U123>` or `<@U123|name>`. */
const MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
const MAX_MENTIONS = 5;

/** Mentioned Slack user ids in order of first appearance, capped. */
export const mentionedSlackIds = (text: string): string[] => {
  const ids: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    if (!ids.includes(m[1]!)) ids.push(m[1]!);
    if (ids.length >= MAX_MENTIONS) break;
  }
  return ids;
};

const addresseeSql = (n: number) => `SELECT x.externalId, u.id, u.name,
       json_extract(u.metadata, '$.comms') AS comms
FROM user_external_ids x
JOIN users u ON u.id = x.userId
WHERE x.kind = 'slack' AND x.externalId IN (${Array(n).fill("?").join(", ")})`;

const parsePrefs = (raw: unknown): Prefs | null => {
  if (!raw) return null;
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  return parsed && typeof parsed === "object" && Object.keys(parsed).length > 0
    ? (parsed as Prefs)
    : null;
};

type Audience = { id: string; name: string; prefs: Prefs; via: "mention" | "requester" };

/**
 * Whose preferences a message is judged against. In a thread with several
 * people, the message is for whoever it @-mentions: the first mentioned person
 * with stored preferences wins, including the requester only if they have prefs.
 * Without such a mention, the task requester (the
 * person whose message created this task). One SQL read, only when the text
 * mentions someone; no judge call.
 */
const resolveAudience = async (
  swarm: Swarm,
  text: string,
  requester: Audience,
): Promise<Audience> => {
  const ids = mentionedSlackIds(text);
  if (ids.length === 0) return requester;
  const q = (await swarm.db_query({ sql: addresseeSql(ids.length), params: ids })) as Envelope;
  const rows = q?.data?.rows ?? q?.rows ?? [];
  for (const slackId of ids) {
    const row = rows.find((r) => String(cell(r, 0, "externalId")) === slackId);
    if (!row) continue;
    const userId = String(cell(row, 1, "id") ?? "");
    // A requester with stored preferences keeps their own task context.
    if (userId && userId === requester.id) {
      if (Object.keys(requester.prefs).length > 0) return requester;
      continue;
    }
    const prefs = parsePrefs(cell(row, 3, "comms"));
    if (!prefs) continue;
    return { id: userId, name: String(cell(row, 2, "name") ?? userId), prefs, via: "mention" };
  }
  return requester;
};

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

/** The text a gated call would put in front of a human, and the task it belongs to. */
const gatedText = (
  tool: string,
  args: Record<string, unknown>,
  sourceTaskId: string | undefined,
): { text: string; taskId: string } | null => {
  if (tool === "store-progress") {
    if (args.status !== "completed") return null;
    return {
      text: typeof args.output === "string" ? args.output.trim() : "",
      taskId: String(args.taskId ?? sourceTaskId ?? ""),
    };
  }
  if (SLACK_TOOLS.has(tool)) {
    // slack-reply names its task; the other tools post from the caller's task context.
    const named = tool === "slack-reply" ? args.taskId : undefined;
    return {
      text: typeof args.message === "string" ? args.message.trim() : "",
      taskId: String(named ?? sourceTaskId ?? ""),
    };
  }
  return null;
};

const extension: SwarmExtension = (api) => {
  api.on("pre.tool.call", async (event, ctx) => {
    if (event.tool !== "store-progress" && !SLACK_TOOLS.has(event.tool)) return;
    const origin = event.requestInfo?.callOrigin;
    if (origin === "extension") return;

    const cfg = cfgOf(ctx.config);
    if (cfg.mode === "off" && cfg.plainMode === "off") return;

    const args = (event.args ?? {}) as Record<string, unknown>;

    // Self-test hatch: a progress call whose text starts with the sentinel runs
    // the controls and records them under `selftest:last`.
    if (
      event.tool === "store-progress" &&
      args.status !== "completed" &&
      typeof args.progress === "string" &&
      args.progress.startsWith(SELFTEST)
    ) {
      await selfTest(ctx.swarm, cfg, ctx.signal);
      return;
    }

    const gated = gatedText(event.tool, args, event.requestInfo?.sourceTaskId);
    if (!gated?.text) return;
    const { text, taskId } = gated;
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
      const requesterName = String(cell(row, 5, "name") ?? (requesterId || "the requester"));
      const threadOpening = String(cell(row, 6, "askHead") ?? "");
      const ask = latestAsk(String(cell(row, 7, "askTail") ?? ""));

      // Judge only a call the tool itself will accept, so no agent can ship another
      // task's thread and preferences to the external judge. store-progress follows
      // its write rule; the Slack tools follow slack-reply's: the caller is the
      // task's assignee or its creator.
      const callerId = event.requestInfo?.agentId;
      const creatorAgentId = String(cell(row, 8, "creatorAgentId") ?? "");
      const allowed =
        event.tool === "store-progress"
          ? await mayWriteProgress(ctx.swarm, callerId, agentId)
          : Boolean(callerId) && (callerId === agentId || callerId === creatorAgentId);
      if (!allowed) return;

      // A completion reaches a human only on a Slack task; a Slack tool always does.
      if (event.tool === "store-progress" && source !== "slack" && !slackThreadTs) return;

      const requester: Audience = {
        id: requesterId,
        name: requesterName,
        prefs: parsePrefs(commsRaw) ?? {},
        via: "requester",
      };
      // `plain` alone judges no one's preferences, so it skips the lookup.
      const audience =
        cfg.mode === "off" ? requester : await resolveAudience(ctx.swarm, text, requester);
      const { prefs, name: audienceName } = audience;

      const questions: Record<string, unknown> = cfg.mode === "off" ? {} : buildQuestions(prefs);
      // Only a store-progress outputSchema answer is machine JSON; a Slack post is
      // always read by a human, JSON or not.
      if (cfg.plainMode !== "off" && (event.tool !== "store-progress" || !looksLikeJson(text)))
        questions.plain = PLAIN_QUESTION;
      if (Object.keys(questions).length === 0) return;

      const transport = resolveTransport(cfg);
      const { scores, latencyMs } = await askJev(
        {
          role: "You audit an AI agent's message to the human who requested the work.",
          requester: audienceName,
          requester_preferences: prefs,
          latest_request: ask,
          thread_opening: threadOpening,
          judging_rules: JUDGING_RULES,
          plain_language_rules: PLAIN_RULES,
          agent_message: text,
        },
        questions,
        transport,
        cfg,
        ctx.signal,
      );

      const limitOf = (dim: string) => (dim === "plain" ? cfg.plainThreshold : cfg.threshold);
      const failed = Object.entries(scores)
        .filter(([k, v]) => v < limitOf(k))
        .map(([k]) => k);
      // Script SDK calls never reach pre.tool.call today; if one does, record it only.
      const blocking =
        origin === "script-sdk"
          ? []
          : failed.filter((d) => (d === "plain" ? cfg.plainMode : cfg.mode) === "enforce");

      const verdict = {
        at: new Date().toISOString(),
        tool: event.tool,
        taskId,
        agentId,
        source,
        requester: requesterName,
        requesterId,
        judgedFor: audience.via,
        audienceId: audience.id,
        audience: audienceName,
        provider: transport.provider,
        scores,
        failed,
        threshold: cfg.threshold,
        plainThreshold: cfg.plainThreshold,
        mode: cfg.mode,
        plainMode: cfg.plainMode,
        latencyMs,
        preferences: prefs,
        askPreview: ask.slice(0, 400),
        outputPreview: text.slice(0, 700),
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
      const willBlock = blocking.length > 0 && priorBlocks < cfg.maxBlocksPerTask;

      await ctx.swarm.kv_set({
        namespace: NS,
        key: `fail:${Date.now()}:${safeKey(taskId)}`,
        value: { ...verdict, action: willBlock ? "blocked" : "recorded" },
      });

      if (!willBlock) {
        await ctx.swarm.kv_incr({
          namespace: NS,
          key: blocking.length > 0 ? "escaped" : "shadowed",
        });
        return;
      }

      await ctx.swarm.kv_incr({ namespace: NS, key: "blocked" });
      await ctx.swarm.kv_incr({ namespace: NS, key: blocksKey });

      const lines = [
        blocking.includes("plain")
          ? `Comms gate: this message is not in plain words for ${audienceName}.`
          : `Comms gate: this output does not match ${audienceName}'s stated preferences.`,
      ];
      for (const d of blocking) {
        const score = `${d} (${scores[d]!.toFixed(2)} vs ${limitOf(d)})`;
        lines.push(
          d === "plain"
            ? `${score}: a reader outside the swarm cannot follow it on first read.`
            : `${score}: requested ${String(prefs[d] ?? "").slice(0, 220)}`,
        );
      }
      lines.push(
        blocking.includes("plain")
          ? `Rewrite the message with the \`comms\` skill (Simpler mode): common words, one idea per sentence, every number with a unit and a direction word, shorthand explained or replaced. Keep every number, name, link and hedge verbatim, then call ${event.tool} again.`
          : `Rewrite the message to match and call ${event.tool} again. Do not change the facts, only how they are said.`,
      );
      return block(lines.join("\n"));
    } catch (err) {
      // Fail open, always.
      try {
        await ctx.swarm.kv_incr({ namespace: NS, key: "error" });
        await ctx.swarm.kv_set({
          namespace: NS,
          key: "error:last",
          value: {
            at: new Date().toISOString(),
            tool: event.tool,
            taskId,
            error: String(err).slice(0, 400),
          },
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
