import { z } from "zod";

export const argsSchema = z.object({
  draft: z.string().describe("The candidate reply text to evaluate before it is sent"),
  transcript: z
    .array(z.object({ speaker: z.string(), text: z.string() }))
    .optional()
    .describe(
      "Prior conversation turns as {speaker, text} pairs — NOT {role, content}; the latter is a 422 with this vendor",
    ),
  agentName: z
    .string()
    .optional()
    .describe("Name of the agent whose reply this is (default 'agent-swarm')"),
  systemPrompt: z
    .string()
    .optional()
    .describe("Voice/persona contract for the agent, if any"),
  taskId: z
    .string()
    .optional()
    .describe("Swarm task id — used to correlate the KV pilot-log entry for blind review"),
  mode: z
    .enum(["foresee", "usage"])
    .optional()
    .describe(
      "'foresee' (default): pre-send tone/reaction check. 'usage': free 30-day credit burn summary — does not spend credits",
    ),
});

const HUMALIKE_BASE = "https://api.humalike.com";
const REQUEST_TIMEOUT_MS = 5000;
const RETRY_BACKOFF_MS = 300;
const KV_NAMESPACE = "humalike-pilot";
const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

async function safeJson(response: any): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorCode(body: any): string | null {
  return body?.error && typeof body.error.code === "string" ? body.error.code : null;
}

function pickRisk(predictedReaction: any): string {
  if (!Array.isArray(predictedReaction) || predictedReaction.length === 0) return "unknown";
  let top = "low";
  let topRank = -1;
  for (const r of predictedReaction) {
    const risk = typeof r?.risk === "string" ? r.risk.toLowerCase() : "low";
    const rank = RISK_RANK[risk] ?? 0;
    if (rank > topRank) {
      topRank = rank;
      top = risk;
    }
  }
  return top;
}

/**
 * A single foresee HTTP attempt. Never throws — timeout/abort and network
 * failures are captured and returned as data so the caller can branch without
 * a try/catch around every call site.
 */
async function foreseeCall(
  ctx: any,
  path: string,
  body: unknown,
): Promise<{ response: any; timedOut: boolean; networkError: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await ctx.stdlib.fetch(HUMALIKE_BASE + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The placeholder is the point — the sandbox's egress layer swaps it
        // for the real token, and only toward hosts allowlisted for the
        // run-as identity (script_credential_bindings). Never resolve this
        // secret yourself.
        Authorization: "Bearer [REDACTED:HUMANLIKE_API_KEY]",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { response, timedOut: false, networkError: null };
  } catch (error) {
    const isAbort =
      error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));
    return {
      response: null,
      timedOut: isAbort,
      networkError: isAbort ? null : error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function logPilotPair(
  ctx: any,
  entry: {
    agentName: string;
    taskId: string | undefined;
    draft: string;
    result: { refinedReply: string | null; risk: string; rationale: string | null; latencyMs: number };
  },
): Promise<void> {
  try {
    const ts = new Date().toISOString();
    const key = `${ts}-${entry.taskId || randomId()}`;
    await ctx.swarm.kv_set({
      namespace: KV_NAMESPACE,
      key,
      value: {
        ts,
        agentName: entry.agentName,
        taskId: entry.taskId ?? null,
        draft: entry.draft,
        refinedReply: entry.result.refinedReply,
        risk: entry.result.risk,
        rationale: entry.result.rationale,
        latencyMs: entry.result.latencyMs,
      },
    });
  } catch {
    // Logging the pilot corpus is best-effort — it must never affect the
    // pre-send verdict that already returned to the caller.
  }
}

/**
 * THE INVARIANT: this function never throws and never blocks a reply. Every
 * failure path returns `{ok: false, code, reason, draft}` where `draft` is
 * byte-identical to the input — foresee is a measurement, not an autopilot.
 */
async function runForesee(
  data: z.infer<typeof argsSchema>,
  ctx: any,
): Promise<Record<string, unknown>> {
  const { draft, transcript = [], systemPrompt, taskId } = data;
  const agentName = data.agentName || "agent-swarm";
  const requestBody = {
    agent_name: agentName,
    system_prompt: systemPrompt || "",
    transcript,
    candidate_reply: draft,
  };

  const started = Date.now();
  const fallback = (
    code: string,
    reason: string,
    attempts: number,
    extra?: Record<string, unknown>,
  ) => ({
    ok: false,
    code,
    reason,
    draft,
    attempts,
    latencyMs: Date.now() - started,
    ...(extra || {}),
  });

  let attempts = 0;
  let allowRetry = true;

  for (;;) {
    attempts++;
    const call = await foreseeCall(ctx, "/v1/foresee/actions/foresee", requestBody);

    if (call.timedOut) {
      return fallback("TIMEOUT", "foresee request exceeded the 5s client-side budget", attempts);
    }
    if (call.networkError) {
      return fallback("NETWORK_ERROR", call.networkError, attempts);
    }

    const response = call.response;
    if (response.ok) {
      const payload = await safeJson(response);
      if (!payload) {
        return fallback("PARSE_ERROR", "foresee returned a non-JSON success body", attempts);
      }

      const result = {
        ok: true,
        risk: pickRisk(payload.predicted_reaction),
        refinedReply: typeof payload.refined_reply === "string" ? payload.refined_reply : null,
        rationale:
          typeof payload.refinement_rationale === "string" ? payload.refinement_rationale : null,
        mentalState: Array.isArray(payload.mental_state) ? payload.mental_state : [],
        predictedReaction: Array.isArray(payload.predicted_reaction) ? payload.predicted_reaction : [],
        draft,
        attempts,
        latencyMs: Date.now() - started,
      };
      await logPilotPair(ctx, { agentName, taskId, draft, result });
      return result;
    }

    const body = await safeJson(response);
    const code = errorCode(body) || String(response.status);

    // Branch on error.code, never on error.message — the vendor's messages
    // are prose and not a stable contract.
    if (response.status === 402 || code === "PAYMENT_REQUIRED") {
      return fallback(
        "PAYMENT_REQUIRED",
        body?.error?.message || "credits exhausted — terminal, not retried",
        attempts,
      );
    }
    if (response.status === 401 || code === "UNAUTHORIZED") {
      return fallback("UNAUTHORIZED", body?.error?.message || "credential rejected", attempts, {
        alert: true,
      });
    }
    if (response.status === 400 || response.status === 422 || code === "VALIDATION_ERROR") {
      ctx.logger?.error?.(`humalike-foresee validation failure: ${JSON.stringify(body)}`);
      return fallback(
        "VALIDATION_ERROR",
        body?.error?.message || "request rejected by foresee",
        attempts,
        { details: body?.error?.details ?? null },
      );
    }
    if ((response.status === 502 || code === "UPSTREAM_ERROR") && allowRetry) {
      allowRetry = false;
      await sleep(RETRY_BACKOFF_MS);
      continue;
    }

    return fallback(code, body?.error?.message || `unexpected foresee status ${response.status}`, attempts);
  }
}

/** Free — does not spend credits. 30-day totals plus per-product breakdown, for tracking pilot burn. */
async function runUsage(ctx: any): Promise<Record<string, unknown>> {
  const call = await foreseeCall(ctx, "/v1/credits/projections/usage-summary", { window_days: 30 });
  if (call.timedOut) return { ok: false, code: "TIMEOUT", reason: "usage-summary request timed out" };
  if (call.networkError) return { ok: false, code: "NETWORK_ERROR", reason: call.networkError };

  const response = call.response;
  const payload = await safeJson(response);
  if (!response.ok) {
    return {
      ok: false,
      code: errorCode(payload) || String(response.status),
      reason: payload?.error?.message || `usage-summary ${response.status}`,
    };
  }
  if (!payload) return { ok: false, code: "PARSE_ERROR", reason: "usage-summary returned a non-JSON body" };

  return {
    ok: true,
    windowDays: 30,
    totalCalls: payload.total_calls ?? null,
    totalCredits: payload.total_credits ?? null,
    byProduct: payload.by_product ?? null,
    raw: payload,
  };
}

/** Opt-in Humalike pre-send tone/reaction check — measures a draft reply and logs it for blind review; never mutates, sends, or auto-applies anything. */
export default async function humalikeForesee(args: any, ctx: any): Promise<Record<string, unknown>> {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_ARGS",
      reason: "invalid args: " + parsed.error.message,
      draft: typeof args?.draft === "string" ? args.draft : null,
    };
  }

  if (parsed.data.mode === "usage") return runUsage(ctx);
  return runForesee(parsed.data, ctx);
}
