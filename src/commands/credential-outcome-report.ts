import type { RateLimitWindowTelemetry } from "../utils/error-tracker";
import { modelFamilyOf } from "../utils/model-rate-limit-windows";
import { buildFinalRateLimitWindows, classifyRateLimitOutcome } from "./rate-limit-outcome";
import { reportSeatMismatchOutcome } from "./seat-mismatch-report";

/** Report a rate-limited key to the API (fire-and-forget) */
async function reportKeyRateLimit(
  apiUrl: string,
  apiKey: string,
  keyType: string,
  keySuffix: string,
  keyIndex: number,
  rateLimitedUntil: string,
): Promise<void> {
  try {
    await fetch(`${apiUrl}/api/keys/report-rate-limit`, {
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
      }),
    });
    console.log(
      `[credentials] Reported key ...${keySuffix} as rate-limited until ${rateLimitedUntil}`,
    );
  } catch {
    // Non-blocking
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
): Promise<void> {
  if (Object.keys(windows).length === 0) return;
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
  /** Runner-local model window guard, keyed `keyType:keyIndex:window`. */
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
 * Reports that gate admission on other workers (a seat mismatch, a model
 * window rejection) land before `finish` runs. Plain telemetry and the
 * key-wide report stay fire-and-forget.
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
      reportKeyRateLimit(
        apiUrl,
        apiKey,
        credentialInfo.keyType,
        credentialInfo.keySuffix,
        credentialInfo.keyIndex,
        keyRateLimitedUntil,
      ).catch(() => {});
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
    if (finalWindows) {
      const report = reportKeyRateLimitWindows(
        apiUrl,
        apiKey,
        credentialInfo.keyType,
        credentialInfo.keySuffix,
        credentialInfo.keyIndex,
        finalWindows,
        outcome.kind !== "model",
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
