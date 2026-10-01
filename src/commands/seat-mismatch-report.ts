import type { ModelFamily } from "../utils/model-rate-limit-windows";

export interface SeatMismatchCredential {
  keyType: string;
  keySuffix: string;
  keyIndex: number;
}

/**
 * Reports a seat mismatch (`credits_required`) for a key: its subscription
 * seat cannot run `model`. Never marks the key rate-limited: the key stays
 * available for every model its seat can run.
 *
 * The completion loop awaits this before it finishes the task, so the seat
 * block reaches the API before another worker admits the next task. A failed
 * report is logged and never throws.
 */
export async function reportSeatMismatchOutcome(
  apiUrl: string,
  apiKey: string,
  credential: SeatMismatchCredential,
  model: ModelFamily,
): Promise<void> {
  const { keyType, keySuffix, keyIndex } = credential;
  const modelLabel = model.charAt(0).toUpperCase() + model.slice(1);
  console.log(
    `[credential] seat mismatch: key #${keyIndex} (...${keySuffix}) cannot run ${modelLabel}`,
  );
  try {
    const response = await fetch(`${apiUrl}/api/keys/report-seat-mismatch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ keyType, keySuffix, keyIndex, model }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (err) {
    console.warn(
      `[credential] Failed to report seat mismatch for key #${keyIndex}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
