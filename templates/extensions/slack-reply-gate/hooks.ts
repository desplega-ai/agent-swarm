import { type ApiCtx, block, type SwarmExtension } from "swarm-extension";
import { z } from "zod";

/**
 * slack-reply-gate
 *
 * Every human message in a Slack thread the swarm takes part in is buffered and
 * flushed into a Lead task ("[Thread follow-up — N message(s) buffered]"), even
 * "lol", ":joy:" or two people bantering. This hook asks TypeSafe Jev whether
 * Lead should answer, and drops the wake-up when the answer is no.
 *
 * Hook: `pre.task.create`, origin "slack", description carrying the
 * thread-buffer header. `pre.slack.route` cannot be used: the buffered thread
 * path returns before that hook is dispatched, and its result can only
 * re-target a message, never drop it.
 *
 * Rules:
 *   - A message that @mentions Lead passes without a Jev call.
 *   - Otherwise one Jev `choice` question classifies the message into a reason;
 *     reply=false only for reaction_only | banter_between_others |
 *     not_addressed_to_lead, and only when the summed probability of those
 *     three labels is >= minConfidence (a banter/reaction split is still a skip).
 *   - Fails OPEN on every error, timeout or missing key.
 *
 * modes (config.mode):
 *   off     -> never evaluate
 *   shadow  -> evaluate + record, never block (default)
 *   enforce -> record, block the task when reply=false, and mark the
 *              triggering Slack message with :mute: (config.muteReaction)
 *
 * Muting: no swarm tool or ctx method adds a Slack reaction, so the hook calls
 * the Slack Web API (reactions.remove / reactions.add) with the bot token. It
 * first removes the bot's own acceptance reactions (:eyes:, :heavy_plus_sign:,
 * :zap:, :speech_balloon:, or their SLACK_REACTION_* overrides), the same set
 * the engine clears when it finalizes a task, then adds :mute:. It runs after
 * the block decision returns, so a slow or failing Slack call never delays or
 * changes the drop; its errors go to the same KV namespace.
 *
 * Every decision lands in KV namespace `ext:slack-reply-gate`.
 */

export const config = z.object({
  mode: z.enum(["off", "shadow", "enforce"]).default("shadow"),
  timeoutMs: z.number().int().positive().default(3000),
  model: z.string().default("jev-latest"),
  minConfidence: z.number().min(0).max(1).default(0.55),
  contextMessages: z.number().int().min(0).max(20).default(6),
  leadAliases: z.array(z.string()).default(["lead"]),
  botSlackUserIds: z.array(z.string()).default([]),
  apiKey: z.string().optional(),
  /** Reaction for a dropped message in enforce mode; "" disables muting. */
  muteReaction: z.string().default("mute"),
  slackTimeoutMs: z.number().int().positive().default(5000),
});

type Cfg = z.infer<typeof config>;
type Swarm = ApiCtx["swarm"];

const NS = "ext:slack-reply-gate";
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const HEADER_LINE_RE = /(?:^|\n)\[Thread follow-up — \d+ message\(s\) buffered\]\n/g;
const CTX_OPEN = "<thread_context>";
const CTX_CLOSE = "</thread_context>";
// The dispatcher cancels a handler after 5 s; leave room for the KV writes.
const MAX_TIMEOUT_MS = 4000;

export const REASONS = {
  direct_ask:
    "Asks Lead (or the swarm, the bot, 'you' meaning the AI) a question or for something, explicitly or clearly implied.",
  followup_to_lead:
    "Answers, confirms, corrects or continues something Lead or another swarm agent ([Agent]) just said or asked, so Lead needs it to proceed.",
  instruction_to_lead:
    "Gives a task, instruction, request or decision for the AI to act on, even without naming it (for example 'can you create X', 'ship it', 'do it').",
  reaction_only:
    "Only a reaction: emoji, laughter (lol, haha, jaja), 'boom!', 'nice', 'thanks', '+1', with no request and nothing new for Lead.",
  banter_between_others:
    "Chat between the humans, or between other people and other bots, that is not aimed at Lead.",
  not_addressed_to_lead:
    "Addressed to a specific other person or another assistant, or an FYI that needs no answer from Lead.",
  other: "None of the above, or unclear.",
} as const;

export type Reason = keyof typeof REASONS;
const SKIP_REASONS: ReadonlySet<string> = new Set([
  "reaction_only",
  "banter_between_others",
  "not_addressed_to_lead",
]);

const cfgOf = (raw: unknown): Cfg => {
  const parsed = config.safeParse(raw ?? {});
  return parsed.success ? parsed.data : config.parse({});
};

// kv keys accept [a-zA-Z0-9._:/%-]
const safeKey = (raw: string | undefined | null): string =>
  (raw && raw.length > 0 ? raw : "unknown").replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 120);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Locate the engine's follow-up header (src/slack/thread-buffer.ts): at the start of the
 * description, or right after the closing `</thread_context>`. Thread context quotes old
 * messages verbatim, so a header (or a `</thread_context>`) quoted inside it is skipped.
 */
const findHeader = (description: string): { index: number; end: number } | null => {
  for (const m of description.matchAll(HEADER_LINE_RE)) {
    const index = m.index! + (m[0].startsWith("\n") ? 1 : 0);
    const before = description.slice(0, index);
    const open = before.indexOf(CTX_OPEN);
    if (open < 0 || before.trimEnd().endsWith(CTX_CLOSE)) {
      return { index, end: m.index! + m[0].length };
    }
  }
  return null;
};

/**
 * Split a buffered follow-up description into thread context and new messages, or null
 * when the description is not a buffered follow-up. Only `messages` is new text.
 */
export const parseFollowUp = (
  description: string,
): { context: string[]; messages: string[] } | null => {
  const header = findHeader(description);
  if (!header) return null;
  const before = description.slice(0, header.index).trimEnd();
  const open = before.indexOf(CTX_OPEN);
  const context =
    open >= 0
      ? before
          .slice(open + CTX_OPEN.length, before.length - CTX_CLOSE.length)
          .split(/\n(?=<@[A-Z0-9]+[|>]|\[Agent\]:)/)
          .map((m) => m.trim())
          .filter(Boolean)
      : [];
  const messages = description
    .slice(header.end)
    .split("\n---\n")
    .map((m) => m.trim())
    .filter(Boolean);
  return { context, messages };
};

/** True when the new text addresses Lead with an @mention. */
export const mentionsLead = (text: string, aliases: readonly string[]): boolean => {
  // The buffer rewrites a mention of the swarm's own bot to `<@U…> (that's you)`.
  if (/<@[A-Z0-9]+>\s*\(that's you\)/.test(text)) return true;
  const names = aliases
    .map((a) => a.trim())
    .filter(Boolean)
    .map(escapeRe);
  if (names.length === 0) return false;
  const alt = names.join("|");
  return (
    new RegExp(`(^|[^\\w@])@(${alt})\\b`, "i").test(text) ||
    new RegExp(`<@[A-Z0-9]+\\|(${alt})>`, "i").test(text)
  );
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

const SLACK_API = "https://slack.com/api";
// The engine's acceptance reactions (src/slack/reaction-shortcode.ts), by config key.
const ACCEPTANCE_REACTIONS: ReadonlyArray<[string, string]> = [
  ["SLACK_REACTION_ACCEPTED", "eyes"],
  ["SLACK_REACTION_BUFFERED", "heavy_plus_sign"],
  ["SLACK_REACTION_NOW", "zap"],
  ["SLACK_REACTION_STEERED", "speech_balloon"],
];
const SHORTCODE_RE = /^[a-z0-9_+'-]+(::skin-tone-[2-6])?$/;
const shortcode = (raw: string): string | null => {
  const s = raw.trim().replace(/^:/, "").replace(/:$/, "").toLowerCase();
  return s && SHORTCODE_RE.test(s) ? s : null;
};

/** The acceptance reactions the engine may have put on the message, deduplicated. */
export const acceptanceReactions = (): string[] => [
  ...new Set(ACCEPTANCE_REACTIONS.map(([key, fallback]) => shortcode(envOf(key)) ?? fallback)),
];

const slackCall = async (
  method: string,
  token: string,
  body: Record<string, string>,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const data = (await res.json()) as { ok?: boolean; error?: string };
    return { ok: data?.ok === true, error: data?.error };
  } finally {
    clearTimeout(timer);
  }
};

export type MuteResult = { removed: string[]; added: boolean; errors: string[] };

/**
 * Replace the bot's acceptance reaction(s) on one message with `name`.
 * `reactions.remove` only removes the calling bot's own reaction, so a human's
 * :eyes: stays. Never throws: every failure lands in `errors`.
 */
export const muteMessage = async (
  token: string,
  channel: string,
  timestamp: string,
  name: string,
  timeoutMs: number,
): Promise<MuteResult> => {
  const result: MuteResult = { removed: [], added: false, errors: [] };
  const call = (method: string, reaction: string) =>
    slackCall(method, token, { channel, timestamp, name: reaction }, timeoutMs).catch(
      (err): { ok: boolean; error?: string } => ({ ok: false, error: String(err).slice(0, 120) }),
    );
  const removals = acceptanceReactions().filter((r) => r !== name);
  const removed = await Promise.all(removals.map((r) => call("reactions.remove", r)));
  removed.forEach((res, i) => {
    const reaction = removals[i]!;
    if (res.ok) result.removed.push(reaction);
    else if (res.error !== "no_reaction" && res.error !== "invalid_name")
      result.errors.push(`remove ${reaction}: ${res.error ?? "unknown"}`);
  });
  const added = await call("reactions.add", name);
  if (added.ok || added.error === "already_reacted") result.added = true;
  else result.errors.push(`add ${name}: ${added.error ?? "unknown"}`);
  return result;
};

// In-flight mutes, so tests can await the work the handler does not wait for.
const pendingMutes = new Set<Promise<void>>();
/** Test hook: wait for every in-flight mute. */
export const settleMutes = async (): Promise<void> => {
  await Promise.allSettled([...pendingMutes]);
};

export type JevVerdict = {
  reason: string;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  latencyMs: number;
};

/** One Jev call: classify the newest message into a reason. Throws on any failure. */
export const askJev = async (
  input: {
    messages: string[];
    context: string[];
    sender: string;
    leadNames: readonly string[];
  },
  key: string,
  cfg: Cfg,
  outer?: AbortSignal,
): Promise<JevVerdict> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(cfg.timeoutMs, MAX_TIMEOUT_MS));
  const onOuterAbort = () => controller.abort();
  outer?.addEventListener("abort", onOuterAbort);
  const t0 = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        state: {
          role: "Decide whether Lead, the coordinating AI agent of a team's agent swarm, should answer a new Slack message in a thread it takes part in. Lead is woken by every message in the thread, including ones not meant for it. Answering noise wastes everyone's time; missing a real ask is worse.",
          lead_names: input.leadNames,
          recent_thread_messages: input.context,
          new_message: input.messages.join("\n---\n"),
          new_message_sender: input.sender,
        },
        model: cfg.model,
        questions: {
          reason: {
            type: "choice",
            instructions:
              "Which label best describes new_message from Lead's point of view? Use recent_thread_messages to tell who it is talking to. Lines starting with [Agent] are swarm bots.",
            criteria: REASONS,
          },
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`typesafe ${res.status}`);
    const body = (await res.json()) as {
      answers?: { reason?: { choice?: unknown; confidence?: unknown; probabilities?: unknown } };
    } | null;
    const answer = body?.answers?.reason;
    const reason = typeof answer?.choice === "string" ? answer.choice : "";
    if (!(reason in REASONS)) throw new Error(`unexpected choice: ${String(reason).slice(0, 60)}`);
    const confidence = typeof answer?.confidence === "number" ? answer.confidence : null;
    const probabilities =
      answer?.probabilities && typeof answer.probabilities === "object"
        ? (answer.probabilities as Record<string, number>)
        : null;
    return { reason, confidence, probabilities, latencyMs: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
};

/** Probability that the message needs no reply: the summed mass of the skip labels. */
export const skipProbability = (verdict: JevVerdict): number | null => {
  if (verdict.probabilities) {
    let sum = 0;
    for (const [label, p] of Object.entries(verdict.probabilities)) {
      if (SKIP_REASONS.has(label) && typeof p === "number") sum += p;
    }
    return sum;
  }
  return verdict.confidence;
};

/** Map a Jev verdict to the typed decision. An unsure skip verdict replies. */
export const decide = (
  verdict: JevVerdict,
  minConfidence: number,
): { reply: boolean; reason: Reason; skipP: number | null; lowConfidence: boolean } => {
  const reason = verdict.reason as Reason;
  const skipP = skipProbability(verdict);
  if (!SKIP_REASONS.has(reason)) return { reply: true, reason, skipP, lowConfidence: false };
  const lowConfidence = skipP !== null && skipP < minConfidence;
  return { reply: lowConfidence, reason, skipP, lowConfidence };
};

const record = async (
  swarm: Swarm,
  entry: Record<string, unknown>,
  counters: string[],
  prefix: "d" | "m" = "d",
) => {
  const at = new Date().toISOString();
  const thread = safeKey(`${entry.channelId ?? ""}_${entry.threadTs ?? ""}`);
  const value = { at, ...entry };
  await Promise.allSettled([
    swarm.kv_set({ namespace: NS, key: `${prefix}:${Date.now()}:${thread}`, value }),
    // `last` stays the latest decision; mute outcomes only get their own row.
    ...(prefix === "d" ? [swarm.kv_set({ namespace: NS, key: "last", value })] : []),
    ...counters.map((c) => swarm.kv_incr({ namespace: NS, key: safeKey(c) })),
  ]);
};

/** Mute the triggering message and log the outcome. Never throws. */
const muteTrigger = async (
  swarm: Swarm,
  cfg: Cfg,
  base: Record<string, unknown>,
): Promise<void> => {
  try {
    const channel = String(base.channelId ?? "");
    const ts = String(base.triggerTs ?? "");
    if (!channel || !ts) throw new Error("no slackChannelId or slackTriggerMessageTs");
    const token = secret("SLACK_BOT_TOKEN");
    if (!usable(token)) throw new Error("no SLACK_BOT_TOKEN");
    const result = await muteMessage(token, channel, ts, cfg.muteReaction, cfg.slackTimeoutMs);
    const ok = result.added && result.errors.length === 0;
    await record(
      swarm,
      { ...base, action: ok ? "muted" : "mute-error", ...result },
      [ok ? "muted" : "mute-error"],
      "m",
    );
  } catch (err) {
    await record(
      swarm,
      { ...base, action: "mute-error", errors: [String(err).slice(0, 300)] },
      ["mute-error"],
      "m",
    ).catch(() => {});
  }
};

const extension: SwarmExtension = (api) => {
  api.on("pre.task.create", async (event, ctx) => {
    if (event.origin !== "slack") return;
    // Only buffered follow-ups. A direct @mention task never carries the header outside
    // its thread context.
    const followUp = parseFollowUp(event.description);
    if (!followUp) return;

    const cfg = cfgOf(ctx.config);
    if (cfg.mode === "off") return;

    const opts = event.options;
    const base = {
      mode: cfg.mode,
      channelId: opts.slackChannelId,
      threadTs: opts.slackThreadTs,
      triggerTs: opts.slackTriggerMessageTs,
      senderSlackId: opts.slackUserId,
    };

    try {
      // A draft follow-up carries downloaded files: always let Lead see them.
      if (opts.status === "draft") {
        await record(ctx.swarm, { ...base, action: "pass", reason: "has_files" }, [
          "total",
          "files",
        ]);
        return;
      }

      // The mention check reads only the new messages, never the thread context.
      const { context, messages } = followUp;
      const preview = messages.join(" | ").slice(0, 300);

      if (messages.some((m) => mentionsLead(m, cfg.leadAliases))) {
        await record(ctx.swarm, { ...base, action: "pass", reason: "mention", preview }, [
          "total",
          "mention",
        ]);
        return;
      }

      const key = secret("TYPESAFE_API_KEY", cfg.apiKey);
      if (!usable(key)) throw new Error("no TYPESAFE_API_KEY");

      const sender =
        opts.slackUserId && cfg.botSlackUserIds.includes(opts.slackUserId)
          ? "bot"
          : opts.requestedByUserId
            ? "human (known teammate)"
            : "unknown (not a known teammate; may be a bot or an external person)";

      const verdict = await askJev(
        {
          messages,
          context: context.slice(-cfg.contextMessages).map((m) => m.slice(0, 500)),
          sender,
          leadNames: cfg.leadAliases,
        },
        key,
        cfg,
        ctx.signal,
      );
      const decision = decide(verdict, cfg.minConfidence);

      const skip = !decision.reply;
      const action = skip ? (cfg.mode === "enforce" ? "skipped" : "shadow-skip") : "pass";
      await record(
        ctx.swarm,
        {
          ...base,
          action,
          reply: decision.reply,
          reason: decision.reason,
          confidence: verdict.confidence,
          skipP: decision.skipP,
          lowConfidence: decision.lowConfidence,
          latencyMs: verdict.latencyMs,
          sender,
          preview,
        },
        ["total", skip ? action : "reply", `reason:${decision.reason}`],
      );

      if (skip && cfg.mode === "enforce") {
        // Not awaited: the block must return inside the dispatcher's 5 s budget
        // whatever Slack does, and a failed reaction never changes the drop.
        const muteReaction = shortcode(cfg.muteReaction);
        if (muteReaction) {
          const pending = muteTrigger(ctx.swarm, { ...cfg, muteReaction }, base);
          pendingMutes.add(pending);
          void pending.finally(() => pendingMutes.delete(pending));
        }
        return block(
          `slack-reply-gate: no reply needed (${decision.reason}${decision.skipP !== null ? `, p(skip) ${decision.skipP.toFixed(2)}` : ""})`,
        );
      }
      return;
    } catch (err) {
      // Fail open, always.
      try {
        await record(
          ctx.swarm,
          { ...base, action: "fail-open", error: String(err).slice(0, 300) },
          ["total", "error"],
        );
      } catch {
        /* ignore */
      }
      ctx.log.warn("slack-reply-gate: failing open", { error: String(err) });
      return;
    }
  });
};

export default extension;
