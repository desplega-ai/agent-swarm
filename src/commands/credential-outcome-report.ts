import type { RateLimitWindowTelemetry, SpendCap } from "../utils/error-tracker";
import { modelFamilyOf } from "../utils/model-rate-limit-windows";
import type {
  ProviderAccountTelemetry,
  RateLimitReplacement,
} from "../utils/provider-account-telemetry";
import { buildFinalRateLimitWindows, classifyRateLimitOutcome } from "./rate-limit-outcome";
import { reportSeatMismatchOutcome } from "./seat-mismatch-report";

/** Report a rate-limited key to the API. Bounded, never throws. */
async function reportKeyRateLimit(
  apiUrl: string,
  apiKey: string,
  keyType: string,
  keySuffix: string,
  keyIndex: number,
  rateLimitedUntil: string,
  spendCap?: SpendCap,
): Promise<void> {
  try {
    const response = await fetch(`${apiUrl}/api/keys/report-rate-limit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        keyType,
        keySuffix,
        keyIndex,
        rateLimitedUntil,
        ...(spendCap ? { spendCap } : {}),
      }),
      // Awaited on a key-wide outcome: a hung API must not hold the task open.
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.warn(
        `[credentials] Failed to report key ...${keySuffix} as rate-limited: HTTP ${response.status}`,
      );
      return;
    }
    console.log(
      `[credentials] Reported key ...${keySuffix} as ${spendCap ? "spend-capped" : "rate-limited"} until ${rateLimitedUntil}`,
    );
  } catch (err) {
    console.warn(
      `[credentials] Failed to report key ...${keySuffix} as rate-limited: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Reports rate-limit window telemetry for a key. Returns the underlying
 * fetch promise (does not swallow errors) so a caller that needs the post to
 * complete before the task finishes (a model-scoped block) can await it and
 * decide how to handle a failure; a caller that wants the legacy
 * fire-and-forget behavior appends `.catch(() => {})`.
 *
 * Throws on a non-2xx response so a failed persistence surfaces to the
 * caller instead of logging success while only the in-process guard took
 * effect — otherwise other workers redraw the same exhausted key at once.
 *
 * `logKeySuffix` defaults to true for the legacy full-telemetry call site;
 * the model-scoped call site passes false since it already logs the model
 * family and key index itself (see the `[credential] model window ...`
 * log above the call).
 */
export async function reportKeyRateLimitWindows(
  apiUrl: string,
  apiKey: string,
  keyType: string,
  keySuffix: string,
  keyIndex: number,
  windows: RateLimitWindowTelemetry,
  logKeySuffix = true,
  account?: ProviderAccountTelemetry,
  replace?: RateLimitReplacement[],
): Promise<void> {
  if (Object.keys(windows).length === 0 && !account && !replace?.length) return;
  const response = await fetch(`${apiUrl}/api/keys/report-rate-limit-windows`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      keyType,
      keySuffix,
      keyIndex,
      windows,
      account,
      replace,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to report rate-limit windows for key #${keyIndex}: HTTP ${response.status}`,
    );
  }
  if (logKeySuffix) {
    console.log(`[credentials] Reported rate-limit windows for key ...${keySuffix}`);
  }
}

export interface CredentialOutcomeInput {
  apiUrl: string;
  apiKey: string;
  credentialInfo?: { keyType: string; keySuffix: string; keyIndex: number };
  /** The finished session's `ProviderResult`. */
  result: Parameters<typeof classifyRateLimitOutcome>[0];
  failureReason: string | undefined;
  model: string | undefined;
  codexCreditsExhaustedCooldownMs: number;
  /**
   * Runner-local guard, keyed `keyType:keyIndex:window`. A key-wide rejection
   * is recorded under the window `key`, whether or not its report landed.
   */
  modelWindowBlocks: Map<string, number>;
}

/**
 * Reports a finished session's credential outcome, then calls `finish`.
 *
 * If rate-limited and we know which key was used, report it. Codex adapter
 * prefixes failure reasons with `[rate-limit]` / `[usage-limit]` (see
 * codex-adapter.formatTerminalError); Claude surfaces "rate limit" / "hit
 * your limit" via SessionErrorTracker.
 *
 * classifyRateLimitOutcome tests model-scoped windows (Fable/Opus/Sonnet
 * weekly limits) before the legacy key-wide gate, so a model-scoped
 * rejection blocks only that model family on this key — never the whole
 * key — via report-rate-limit-windows instead of report-rate-limit. A
 * key-wide rejection seen in the same session is still reported alongside
 * it (windows are independent). The session's window telemetry and the
 * classified model rejection go out as ONE payload, so an older `allowed`
 * snapshot never overwrites the terminal rejection.
 *
 * Reports that gate admission (a seat mismatch, a model window rejection, a
 * key-wide rejection that ended the session) land before `finish` runs.
 * Plain telemetry, and a key-wide report next to a seat or model outcome,
 * stay fire-and-forget.
 */
export async function reportCredentialOutcomeThenFinish(
  input: CredentialOutcomeInput,
  finish: () => Promise<void>,
): Promise<void> {
  const { apiUrl, apiKey, credentialInfo, result, failureReason, model } = input;
  if (credentialInfo) {
    const outcome = classifyRateLimitOutcome(
      result,
      failureReason,
      Date.now(),
      input.codexCreditsExhaustedCooldownMs,
      modelFamilyOf(model),
    );
    // A seat mismatch is not a rate limit: the key stays available for
    // every model its seat can run. A seat outcome carries
    // `keyRateLimitedUntil` only for an independent key-wide rejection seen
    // earlier in the same session, which is still reported below.
    if (outcome.kind === "seat") {
      await reportSeatMismatchOutcome(apiUrl, apiKey, credentialInfo, outcome.model);
    }
    const keyRateLimitedUntil =
      outcome.kind === "key"
        ? outcome.rateLimitedUntil
        : outcome.kind === "model" || outcome.kind === "seat"
          ? outcome.keyRateLimitedUntil
          : undefined;
    if (keyRateLimitedUntil) {
      console.log(`[credentials] Rate limit reset: ${keyRateLimitedUntil}`);
      // The resume of a key retry draws on this worker next. If the report below is lost,
      // this entry still keeps the failed key out of that draw. shortcut: lives in this
      // worker process only; upgrade to a server-side bench if a restart in between matters.
      input.modelWindowBlocks.set(
        `${credentialInfo.keyType}:${credentialInfo.keyIndex}:key`,
        Date.parse(keyRateLimitedUntil),
      );
      const report = reportKeyRateLimit(
        apiUrl,
        apiKey,
        credentialInfo.keyType,
        credentialInfo.keySuffix,
        credentialInfo.keyIndex,
        keyRateLimitedUntil,
        outcome.kind === "key" ? outcome.spendCap : undefined,
      ).catch(() => {});
      // `finish` may resume the task on another key of the pool: the bench
      // lands first, so the resume's claim cannot draw this key again.
      if (outcome.kind === "key") await report;
    }
    if (outcome.kind === "model") {
      const resetsAtIso = new Date(outcome.resetsAtSec * 1000).toISOString();
      const blockKey = `${credentialInfo.keyType}:${credentialInfo.keyIndex}:${outcome.window}`;
      input.modelWindowBlocks.set(blockKey, outcome.resetsAtSec * 1000);
      console.log(
        `[credential] ${outcome.model} weekly window exhausted (${outcome.window}) on key #${credentialInfo.keyIndex} until ${resetsAtIso}`,
      );
    }

    const finalWindows = buildFinalRateLimitWindows(
      result.rateLimitWindows,
      outcome,
      new Date().toISOString(),
    );
    if (finalWindows || result.providerAccount || result.rateLimitReplacements?.length) {
      const report = reportKeyRateLimitWindows(
        apiUrl,
        apiKey,
        credentialInfo.keyType,
        credentialInfo.keySuffix,
        credentialInfo.keyIndex,
        finalWindows ?? {},
        outcome.kind !== "model",
        result.providerAccount,
        result.rateLimitReplacements,
      ).catch((err) => {
        console.warn(
          `[credential] Failed to report rate-limit windows: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      // A model rejection gates admission on other workers: land it before
      // the task finishes. Plain telemetry stays fire-and-forget.
      if (outcome.kind === "model") await report;
    }
  }
  await finish();
}
