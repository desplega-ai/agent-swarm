/**
 * Background Claude quota probe (P4).
 *
 * A Claude key reports its 5-hour and 7-day usage only while a session runs on
 * it, so a key that sat idle for a while shows an old value. This sweep sends
 * the same 1-token request that Claude Code sends as `quota_check`
 * (`POST /v1/messages`, `max_tokens: 1`, one user message `"quota"`, no
 * retries) and reads the `anthropic-ratelimit-unified-*` response headers.
 *
 * Rules:
 * - Probe a key only when its five_hour window is still open. A probe on an
 *   idle key would start a new 5-hour window.
 * - Probe only keys whose five_hour value is older than 15 minutes, and skip a
 *   key with a rejected window until that window resets.
 * - At most 10 keys per tick, oldest observation first.
 * - A missing header is no data. It never becomes 0 %.
 *
 * Kill switch: CLAUDE_QUOTA_PROBE_DISABLE=true. Model: CLAUDE_QUOTA_PROBE_MODEL.
 */
import { type ApiKeyStatus, getKeyStatuses, recordKeyRateLimitWindows } from "../be/db";
import { recordKeyValidation } from "../be/db/api-keys";
import { keySuffix as suffixOf } from "../utils/credentials";
import { isEnvFlagEnabled } from "../utils/env-flag";
import type { RateLimitWindowTelemetry } from "../utils/error-tracker";
import { scrubSecrets } from "../utils/secret-scrubber";
import { sanitizeReportedQuotaObservations, sanitizeReportedWindowResets } from "./api-keys";
import { readPool } from "./pool-keys";

export const CLAUDE_QUOTA_KEY_TYPE = "CLAUDE_CODE_OAUTH_TOKEN";
export const CLAUDE_QUOTA_PROBE_DEFAULT_MODEL = "claude-haiku-4-5-20251001";
export const CLAUDE_QUOTA_PROBE_MAX_PER_TICK = 10;
/** A five_hour value older than this is stale and due for a probe. */
export const CLAUDE_QUOTA_STALE_MS = 15 * 60 * 1000;

const PROBE_URL = "https://api.anthropic.com/v1/messages";
const PROBE_TIMEOUT_MS = 15_000;
const TICK_MS = 5 * 60 * 1000;
const TICK_JITTER_MS = 60 * 1000;
const STARTUP_DELAY_MS = 90 * 1000;

const PROBE_WINDOWS = [
  { key: "five_hour", header: "5h", durationMins: 300 },
  { key: "seven_day", header: "7d", durationMins: 10080 },
] as const;

export interface QuotaProbeCandidate {
  keyIndex: number;
  keySuffix: string;
  token: string;
  /** five_hour `lastSeenAt` in ms; NaN when missing. */
  lastSeenMs: number;
}

/**
 * Pick the pool members to probe this tick. A member is due when its
 * five_hour value is stale (or missing), its five_hour window is still open,
 * and no window is rejected with a future reset. Oldest observation first.
 */
export function selectDueQuotaProbeKeys(
  members: readonly string[],
  statuses: ReadonlyArray<Pick<ApiKeyStatus, "keySuffix" | "rateLimitWindows">>,
  nowMs: number,
  limit = CLAUDE_QUOTA_PROBE_MAX_PER_TICK,
): QuotaProbeCandidate[] {
  const bySuffix = new Map(statuses.map((row) => [row.keySuffix, row]));
  const seen = new Set<string>();
  const due: QuotaProbeCandidate[] = [];
  members.forEach((token, keyIndex) => {
    const keySuffix = suffixOf(token);
    if (seen.has(keySuffix)) return;
    seen.add(keySuffix);
    const windows = bySuffix.get(keySuffix)?.rateLimitWindows ?? {};
    const fiveHour = windows.five_hour;
    const lastSeenMs = fiveHour ? Date.parse(fiveHour.lastSeenAt) : Number.NaN;
    const stale = !Number.isFinite(lastSeenMs) || nowMs - lastSeenMs > CLAUDE_QUOTA_STALE_MS;
    const open = fiveHour?.resetsAt !== undefined && fiveHour.resetsAt * 1000 > nowMs;
    const blocked = Object.values(windows).some(
      (w) => w.status === "rejected" && w.resetsAt !== undefined && w.resetsAt * 1000 > nowMs,
    );
    if (stale && open && !blocked) due.push({ keyIndex, keySuffix, token, lastSeenMs });
  });
  const order = (ms: number) => (Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY);
  return due.sort((a, b) => order(a.lastSeenMs) - order(b.lastSeenMs)).slice(0, limit);
}

function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name)?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Map the unified rate-limit headers to windows, in the shape that
 * `parseRateLimitWindowTelemetry` produces. A window needs its reset header.
 * On a 2xx it also needs its utilization header; a missing one is no data,
 * never 0 %. A window without a status header is `rejected` at utilization
 * >= 1, else `allowed`. On a 429 the sweep must skip the key until the reset:
 * the representative-claim window is marked rejected first; only when no
 * claim names a parsed window and no window is rejected yet is every window
 * marked rejected.
 */
export function parseQuotaProbeHeaders(
  headers: Headers,
  httpStatus: number,
  lastSeenAt: string,
): RateLimitWindowTelemetry {
  const limited = httpStatus === 429;
  const windows: RateLimitWindowTelemetry = {};
  for (const { key, header, durationMins } of PROBE_WINDOWS) {
    const prefix = `anthropic-ratelimit-unified-${header}`;
    const resetsAt = headerNumber(headers, `${prefix}-reset`);
    if (resetsAt === undefined || resetsAt <= 0) continue;
    const utilization = headerNumber(headers, `${prefix}-utilization`);
    if (utilization === undefined && !limited) continue;
    const reported = headers.get(`${prefix}-status`)?.trim().slice(0, 256);
    const status = reported || ((utilization ?? 0) >= 1 ? "rejected" : "allowed");
    windows[key] = {
      status,
      ...(utilization === undefined ? {} : { utilization }),
      resetsAt,
      lastSeenAt,
      durationMins,
      source: "poll",
    };
  }
  if (limited) {
    const claim = headers.get("anthropic-ratelimit-unified-representative-claim")?.trim();
    if (claim && windows[claim]) {
      windows[claim] = { ...windows[claim], status: "rejected" };
    } else if (!Object.values(windows).some((w) => w.status === "rejected")) {
      for (const key of Object.keys(windows))
        windows[key] = { ...windows[key]!, status: "rejected" };
    }
  }
  return windows;
}

export type QuotaProbeOutcome = "written" | "no_data" | "auth_failed" | "rate_limited" | "error";

export interface ClaudeQuotaProbeSweepResult {
  members: number;
  due: number;
  probed: number;
  outcomes: Record<QuotaProbeOutcome, number>;
  failed: string[];
}

export interface ClaudeQuotaProbeDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  model?: string;
}

function probeModel(): string {
  return process.env.CLAUDE_QUOTA_PROBE_MODEL?.trim() || CLAUDE_QUOTA_PROBE_DEFAULT_MODEL;
}

async function probeKey(
  candidate: QuotaProbeCandidate,
  fetchImpl: typeof fetch,
  model: string,
  now: () => number,
): Promise<QuotaProbeOutcome> {
  const res = await fetchImpl(PROBE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${candidate.token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: "user", content: "quota" }],
    }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  // The text is not used; drain it so the connection is released.
  await res.text().catch(() => "");

  if (res.status === 401 || res.status === 403) {
    // Key status only, no windows. recordKeyValidation keeps its rule that
    // only a 401 marks the key bad.
    await recordKeyValidation(
      CLAUDE_QUOTA_KEY_TYPE,
      [
        {
          keyIndex: candidate.keyIndex,
          keySuffix: candidate.keySuffix,
          ok: false,
          httpStatus: res.status,
        },
      ],
      "global",
      null,
      { retireAbsent: false },
    );
    return "auth_failed";
  }
  if (!res.ok && res.status !== 429) return "error";

  const lastSeenAt = new Date(now()).toISOString();
  const parsed = parseQuotaProbeHeaders(res.headers, res.status, lastSeenAt);
  if (Object.keys(parsed).length === 0) return "no_data";
  // The same sanitizers the report route runs before its write.
  const { windows } = sanitizeReportedQuotaObservations({ windows: parsed });
  await recordKeyRateLimitWindows(
    CLAUDE_QUOTA_KEY_TYPE,
    candidate.keySuffix,
    candidate.keyIndex,
    sanitizeReportedWindowResets(windows),
    "global",
    null,
  );
  return res.status === 429 ? "rate_limited" : "written";
}

/** Run one sweep. Never throws: per-key failures are counted and logged (scrubbed). */
export async function sweepClaudeQuotaProbe(
  deps: ClaudeQuotaProbeDeps = {},
): Promise<ClaudeQuotaProbeSweepResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const model = deps.model ?? probeModel();
  const outcomes: Record<QuotaProbeOutcome, number> = {
    written: 0,
    no_data: 0,
    auth_failed: 0,
    rate_limited: 0,
    error: 0,
  };
  const failed: string[] = [];

  const { members } = await readPool(CLAUDE_QUOTA_KEY_TYPE);
  if (members.length === 0) return { members: 0, due: 0, probed: 0, outcomes, failed };
  const statuses = await getKeyStatuses(CLAUDE_QUOTA_KEY_TYPE, "global", null);
  const due = selectDueQuotaProbeKeys(members, statuses, now());

  let probed = 0;
  for (const candidate of due) {
    probed++;
    try {
      const outcome = await probeKey(candidate, fetchImpl, model, now);
      outcomes[outcome]++;
      if (outcome === "error") failed.push(`...${candidate.keySuffix}: unexpected HTTP status`);
    } catch (err) {
      outcomes.error++;
      const message = err instanceof Error ? err.message : String(err);
      failed.push(scrubSecrets(`...${candidate.keySuffix}: ${message}`));
    }
  }
  return { members: members.length, due: due.length, probed, outcomes, failed };
}

// ─── Periodic runner ─────────────────────────────────────────────────────────

let tickTimeout: ReturnType<typeof setTimeout> | null = null;
let inflightSweep: Promise<void> | null = null;
let running = false;

async function runSweepTick(trigger: "startup" | "interval"): Promise<void> {
  if (inflightSweep) return inflightSweep;
  inflightSweep = (async () => {
    try {
      const result = await sweepClaudeQuotaProbe();
      if (result.probed > 0) {
        const { written, no_data, auth_failed, rate_limited, error } = result.outcomes;
        console.log(
          scrubSecrets(
            `[claude-quota-probe] ${trigger}: members=${result.members} due=${result.due} probed=${result.probed} written=${written} no_data=${no_data} auth_failed=${auth_failed} rate_limited=${rate_limited} error=${error}${result.failed.length > 0 ? ` (${result.failed.join("; ")})` : ""}`,
          ),
        );
      }
    } catch (err) {
      console.error(
        scrubSecrets(
          `[claude-quota-probe] sweep tick failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    } finally {
      inflightSweep = null;
    }
  })();
  return inflightSweep;
}

function scheduleNext(delayMs: number, trigger: "startup" | "interval"): void {
  tickTimeout = setTimeout(() => {
    tickTimeout = null;
    void runSweepTick(trigger).finally(() => {
      if (running) scheduleNext(TICK_MS + (Math.random() * 2 - 1) * TICK_JITTER_MS, "interval");
    });
  }, delayMs);
  tickTimeout.unref?.();
}

/**
 * Start the periodic quota probe: first run 90 s after boot, then every
 * 5 minutes with ±60 s jitter. No-op when CLAUDE_QUOTA_PROBE_DISABLE=true or
 * when already running.
 */
export function startClaudeQuotaProbe(): void {
  if (isEnvFlagEnabled("CLAUDE_QUOTA_PROBE_DISABLE", false)) {
    console.log("[claude-quota-probe] Disabled via CLAUDE_QUOTA_PROBE_DISABLE");
    return;
  }
  if (running) return;
  running = true;
  console.log(
    `[claude-quota-probe] Starting (interval ${TICK_MS / 60_000}min ±${TICK_JITTER_MS / 1000}s, model ${probeModel()}, first run in ${STARTUP_DELAY_MS / 1000}s)`,
  );
  scheduleNext(STARTUP_DELAY_MS, "startup");
}

/** Stop the periodic probe and wait for any in-flight run to finish. */
export async function stopClaudeQuotaProbe(): Promise<void> {
  running = false;
  if (tickTimeout) {
    clearTimeout(tickTimeout);
    tickTimeout = null;
  }
  if (inflightSweep) await inflightSweep;
}
